"""회사 자산(CompanyAsset) API.

Endpoints:
- `GET    /assets`                      — 페이지 + 필터 목록
- `POST   /assets`                      — 신규 등록 (asset_no 자동 발번)
- `GET    /assets/{id}`                 — 단건
- `PATCH  /assets/{id}`                 — 부분 수정
- `DELETE /assets/{id}`                 — 소프트 삭제 (status=DISPOSED)
- `GET    /assets/by-number/{no}`       — QR 스캔 라우트에서 사용
- `POST   /assets/{id}/photo`           — 사진 업로드(교체)
- `GET    /assets/{id}/photo`           — 사진 blob
- `DELETE /assets/{id}/photo`           — 사진 삭제

권한 모델:
- 조회 (GET): 모든 인증 사용자. QR 스캔·소유자 확인 용도라 포괄 허용.
- 변경 (POST/PATCH/DELETE/photo): `assets.manage` 보유자 (HR + ADMIN).

자산번호 발번(`DDA-YYYY-XXXX`) 은 invoice 와 동일한 Crockford base32 랜덤 4자
방식 (I, L, O, U 제외로 혼동 방지). UNIQUE 제약으로 충돌 감지 + 최대 5회 재시도.
중앙 시퀀스가 아니라 advisory lock 불필요.
"""

from __future__ import annotations

import logging
import secrets
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import delete as sql_delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.models import CompanyAsset, Developer, User
from app.schemas.asset import (
    AssetCreate,
    AssetOut,
    AssetPageOut,
    AssetUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/assets", tags=["assets"])

# 사진 업로드 허용 MIME.
_PHOTO_ALLOWED_MIME = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
}

# asset_no 발번 포맷 — DDA-YYYY-XXXX. XXXX 는 Crockford base32 4자 랜덤.
# I, L, O, U 를 제외해 1/l, 0/O 혼동을 방지 (invoice 번호와 동일 알파벳).
_CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _rand_suffix(length: int = 4) -> str:
    return "".join(_CROCKFORD_BASE32[secrets.randbelow(32)] for _ in range(length))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _next_asset_no(db: AsyncSession, year: int) -> str:
    """`DDA-YYYY-XXXX` 포맷의 고유 자산번호를 반환.

    - XXXX = Crockford base32 4자 랜덤 (I/L/O/U 제외). 32^4 = 약 100만 조합.
    - UNIQUE 제약과 중복되는 값이 나오면 최대 5회 재시도.
    - 5회 모두 충돌 시 5자로 늘려 다시 5회 재시도 후 실패 예외.
    """
    base = f"DDA-{year}-"
    for _ in range(5):
        candidate = f"{base}{_rand_suffix(4)}"
        exists = (
            await db.execute(
                select(CompanyAsset.id).where(CompanyAsset.asset_no == candidate)
            )
        ).scalar_one_or_none()
        if exists is None:
            return candidate
    # 확률상 거의 불가능하지만 안전장치 — 5자리로 확장.
    for _ in range(5):
        candidate = f"{base}{_rand_suffix(5)}"
        exists = (
            await db.execute(
                select(CompanyAsset.id).where(CompanyAsset.asset_no == candidate)
            )
        ).scalar_one_or_none()
        if exists is None:
            return candidate
    raise HTTPException(
        status_code=500,
        detail="자산번호 발번에 실패했습니다 (충돌 반복).",
    )


async def _owner_map(
    db: AsyncSession, owner_ids: set[UUID]
) -> dict[UUID, tuple[str, str | None]]:
    """소유자 id → (name, tag) 매핑. 표시 전용."""
    if not owner_ids:
        return {}
    rows = list(
        (
            await db.execute(
                select(Developer.id, Developer.name, Developer.tag).where(
                    Developer.id.in_(owner_ids)
                )
            )
        )
    )
    return {r[0]: (r[1], r[2]) for r in rows}


def _to_out(asset: CompanyAsset, owners: dict[UUID, tuple[str, str | None]]) -> AssetOut:
    """ORM → Pydantic. 소유자 이름/뱃지를 주입하고 사진 경로는 감춘다."""
    owner_name = owner_tag = None
    if asset.owner_id and asset.owner_id in owners:
        owner_name, owner_tag = owners[asset.owner_id]
    return AssetOut(
        id=asset.id,
        asset_no=asset.asset_no,
        category=asset.category,  # type: ignore[arg-type]
        manufacturer=asset.manufacturer,
        model_name=asset.model_name,
        serial_no=asset.serial_no,
        spec=asset.spec,
        purchase_date=asset.purchase_date,
        purchase_vendor=asset.purchase_vendor,
        purchase_price=asset.purchase_price,
        warranty_expires=asset.warranty_expires,
        owner_id=asset.owner_id,
        owner_name=owner_name,
        owner_tag=owner_tag,
        status=asset.status,  # type: ignore[arg-type]
        location=asset.location,
        memo=asset.memo,
        photo_name=asset.photo_name,
        has_photo=bool(asset.photo_path),
        created_at=asset.created_at,
        updated_at=asset.updated_at,
    )


async def _get_asset_or_404(db: AsyncSession, asset_id: UUID) -> CompanyAsset:
    asset = (
        await db.execute(select(CompanyAsset).where(CompanyAsset.id == asset_id))
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="자산을 찾을 수 없습니다.")
    return asset


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@router.get("", response_model=AssetPageOut)
async def list_assets(
    q: str | None = None,
    category: str | None = None,
    status_: str | None = None,
    owner_id: UUID | None = None,
    include_disposed: bool = False,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> AssetPageOut:
    """자산 페이지 조회.

    - `q`: 자산번호/제조사/제품명/일련번호 부분 일치 (대소문자 무시).
    - `status_`: IN_USE / IN_STORAGE / DISPOSED (명시 시 해당만).
    - `include_disposed=false` (기본): DISPOSED 제외. status_ 가 지정되면 무시.
    """
    page = max(1, page)
    # 프론트가 클라이언트 페이징을 쓰므로 상한을 넉넉히 (2000) — 그 이상 자산은 드물다.
    page_size = max(1, min(2000, page_size))
    stmt = select(CompanyAsset)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            or_(
                CompanyAsset.asset_no.ilike(like),
                CompanyAsset.manufacturer.ilike(like),
                CompanyAsset.model_name.ilike(like),
                CompanyAsset.serial_no.ilike(like),
                CompanyAsset.location.ilike(like),
            )
        )
    if category:
        stmt = stmt.where(CompanyAsset.category == category)
    if status_:
        stmt = stmt.where(CompanyAsset.status == status_)
    elif not include_disposed:
        stmt = stmt.where(CompanyAsset.status != "DISPOSED")
    if owner_id:
        stmt = stmt.where(CompanyAsset.owner_id == owner_id)

    total = (
        await db.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar_one()
    stmt = (
        stmt.order_by(CompanyAsset.asset_no.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = list((await db.execute(stmt)).scalars())
    owners = await _owner_map(db, {a.owner_id for a in items if a.owner_id})
    return AssetPageOut(
        items=[_to_out(a, owners) for a in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/by-number/{asset_no}", response_model=AssetOut)
async def get_asset_by_number(
    asset_no: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> AssetOut:
    """QR 스캔 후 자산번호로 단건 조회."""
    asset = (
        await db.execute(select(CompanyAsset).where(CompanyAsset.asset_no == asset_no))
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail=f"자산번호를 찾을 수 없습니다: {asset_no}")
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)


@router.get("/{asset_id}", response_model=AssetOut)
async def get_asset(
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> AssetOut:
    asset = await _get_asset_or_404(db, asset_id)
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


@router.post("", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def create_asset(
    payload: AssetCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("assets.manage")),
) -> AssetOut:
    year = (payload.purchase_date or date.today()).year
    asset_no = await _next_asset_no(db, year)
    asset = CompanyAsset(asset_no=asset_no, **payload.model_dump())
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    logger.info(
        "자산 등록: id=%s no=%s category=%s owner=%s (등록자=%s)",
        asset.id,
        asset.asset_no,
        asset.category,
        asset.owner_id,
        user.id,
    )
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)


@router.patch("/{asset_id}", response_model=AssetOut)
async def update_asset(
    asset_id: UUID,
    payload: AssetUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("assets.manage")),
) -> AssetOut:
    asset = await _get_asset_or_404(db, asset_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(asset, k, v)
    await db.commit()
    await db.refresh(asset)
    logger.info(
        "자산 수정: id=%s no=%s 변경=%s (수정자=%s)",
        asset.id,
        asset.asset_no,
        list(data.keys()),
        user.id,
    )
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)


@router.delete("/{asset_id}", response_model=AssetOut)
async def delete_asset(
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("assets.manage")),
) -> AssetOut:
    """소프트 삭제. status 를 DISPOSED 로 전환하고 row 는 유지."""
    asset = await _get_asset_or_404(db, asset_id)
    if asset.status != "DISPOSED":
        asset.status = "DISPOSED"
        await db.commit()
        await db.refresh(asset)
        logger.warning(
            "자산 폐기(소프트 삭제): id=%s no=%s (요청자=%s)",
            asset.id,
            asset.asset_no,
            user.id,
        )
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)


# ---------------------------------------------------------------------------
# Photo
# ---------------------------------------------------------------------------


@router.post("/{asset_id}/photo", response_model=AssetOut)
async def upload_asset_photo(
    asset_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("assets.manage")),
) -> AssetOut:
    mime = (file.content_type or "").lower()
    if mime not in _PHOTO_ALLOWED_MIME:
        raise HTTPException(
            status_code=400,
            detail="지원하지 않는 이미지 형식입니다 (JPEG/PNG/WebP/GIF/HEIC).",
        )
    asset = await _get_asset_or_404(db, asset_id)
    # 기존 파일 제거 후 신규 저장. 같은 자산에 대해 사진은 1장만 유지.
    if asset.photo_path:
        delete_file(asset.photo_path)
    path, size = await save_upload(file, f"assets/{asset.id}")
    asset.photo_name = file.filename or "photo"
    asset.photo_path = path
    asset.photo_mime = mime
    asset.photo_size = size
    await db.commit()
    await db.refresh(asset)
    logger.info(
        "자산 사진 업로드: id=%s no=%s size=%d mime=%s (요청자=%s)",
        asset.id,
        asset.asset_no,
        size,
        mime,
        user.id,
    )
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)


@router.get("/{asset_id}/photo")
async def get_asset_photo(
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> FileResponse:
    asset = await _get_asset_or_404(db, asset_id)
    if not asset.photo_path:
        raise HTTPException(status_code=404, detail="사진이 없습니다.")
    abs_path = resolve_upload_path(asset.photo_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        media_type=asset.photo_mime or "application/octet-stream",
        filename=asset.photo_name or "photo",
    )


@router.delete("/{asset_id}/photo", response_model=AssetOut)
async def delete_asset_photo(
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("assets.manage")),
) -> AssetOut:
    asset = await _get_asset_or_404(db, asset_id)
    if asset.photo_path:
        delete_file(asset.photo_path)
    asset.photo_name = None
    asset.photo_path = None
    asset.photo_mime = None
    asset.photo_size = None
    await db.commit()
    await db.refresh(asset)
    logger.info("자산 사진 삭제: id=%s no=%s (요청자=%s)", asset.id, asset.asset_no, user.id)
    owners = await _owner_map(db, {asset.owner_id} if asset.owner_id else set())
    return _to_out(asset, owners)
