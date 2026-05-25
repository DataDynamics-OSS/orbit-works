"""고객사 현황 (Customer Status) — CRUD + 첨부 (upload/rename/preview/download/delete).

식별 단위는 (customer_id, project_id?, system_name) — 같은 프로젝트 안에서도
시스템별로 라이센스·담당자 조합이 다르므로 별도 카드로 관리. project 는
선택 (상시 보수처럼 특정 프로젝트에 묶이지 않는 운영 환경도 허용).

Endpoints:
  GET    /customer-status[?customer_id=&project_id=&q=]
  GET    /customer-status/{id}
  POST   /customer-status                                생성 (customer-status.write)
  PATCH  /customer-status/{id}                           편집 (작성자 또는 권한)
  DELETE /customer-status/{id}                           삭제 (작성자 또는 권한)

첨부 5종:
  POST   /customer-status/{id}/attachments               multipart, multi
  PATCH  /customer-status/{id}/attachments/{aid}         파일명 변경
  DELETE /customer-status/{id}/attachments/{aid}         삭제 (멱등 — 없는 ID 도 204)
  GET    /customer-status/{id}/attachments/{aid}/download  Content-Disposition: attachment
  GET    /customer-status/{id}/attachments/{aid}/preview   Content-Disposition: inline
                                                            (이미지/PDF 만 브라우저 직접 렌더)

권한:
- 조회는 인증 사용자 전원 (router-wide menu_permissions: customer-status).
- 작성·편집·삭제는 `customer-status.write` feature 권한 (SUPPORT/HR/ADMIN 기본).
- 작성자 본인은 자기 글 편집·삭제 항상 가능.
- ADMIN/SUPER_ADMIN 은 code invariant 로 항상 통과.

Logging 정책:
- INFO    : 사용자가 실제로 만든 변화 (생성/수정/삭제/첨부 add·rename·delete).
- WARNING : best-effort 실패(디스크 파일 삭제 실패), 데이터 정합성 이상 (orphan
            license_id), 입력 누락(첨부 filename 누락) 등 운영자가 알아야 하는
            비정상 상황.
"""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, has_feature
from app.core.database import get_db
from app.models import (
    Customer,
    CustomerContact,
    CustomerStatusAttachment,
    CustomerStatusEntry,
    License,
    Product,
    ProductVersion,
    Project,
    User,
    Vendor,
)
from app.schemas.customer_status import (
    CustomerStatusAttachmentOut,
    CustomerStatusAttachmentRename,
    CustomerStatusCreate,
    CustomerStatusOut,
    CustomerStatusRowOut,
    CustomerStatusUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/customer-status", tags=["customer-status"])


def _is_admin(user: User) -> bool:
    return user.role in ("ADMIN", "SUPER_ADMIN")


async def _require_write(
    db: AsyncSession, user: User, entry: CustomerStatusEntry | None = None,
) -> None:
    if _is_admin(user):
        return
    if entry is not None and entry.created_by_user_id == user.id:
        return
    if await has_feature(db, user, "customer-status.write"):
        return
    raise HTTPException(status_code=403, detail="고객사 현황 작성 권한 없음")


async def _require_delete(
    db: AsyncSession, user: User, entry: CustomerStatusEntry,
) -> None:
    """삭제 권한 — customer-status.delete 또는 작성자 본인 또는 ADMIN. write 와 분리."""
    if _is_admin(user):
        return
    if entry.created_by_user_id == user.id:
        return
    if await has_feature(db, user, "customer-status.delete"):
        return
    raise HTTPException(status_code=403, detail="고객사 현황 삭제 권한 없음")


def _license_label(lic: License | None) -> str | None:
    """license 식별용 표시 라벨 — product_name + 기간 요약."""
    if lic is None:
        return None
    parts = [lic.product_name or ""]
    if lic.start_date and lic.end_date:
        parts.append(f"({lic.start_date.isoformat()}~{lic.end_date.isoformat()})")
    return " ".join(p for p in parts if p).strip() or None


async def _resolve_names(
    db: AsyncSession, entries: list[CustomerStatusEntry],
) -> dict[str, dict[UUID, str]]:
    """N+1 회피 — batch lookup. 반환 dict 의 key 들: customer, project, vendor,
    product, version, contact, user (이름 매핑). license 는 별도 dict (lic obj 보존)."""
    cids = {e.customer_id for e in entries}
    pids = {e.project_id for e in entries if e.project_id}
    vids = {e.vendor_id for e in entries if e.vendor_id}
    pdids = {e.product_id for e in entries if e.product_id}
    verids = {e.version_id for e in entries if e.version_id}
    contact_ids = {e.customer_contact_id for e in entries if e.customer_contact_id}
    user_ids = (
        {e.tech_support_user_id for e in entries if e.tech_support_user_id}
        | {e.created_by_user_id for e in entries if e.created_by_user_id}
    )

    async def _kv(stmt) -> dict[UUID, str]:
        return {i: (n or "") for (i, n) in (await db.execute(stmt)).all()}

    out = {
        "customer": await _kv(select(Customer.id, Customer.name).where(Customer.id.in_(cids))) if cids else {},
        "project": await _kv(select(Project.id, Project.name).where(Project.id.in_(pids))) if pids else {},
        "vendor": await _kv(select(Vendor.id, Vendor.name).where(Vendor.id.in_(vids))) if vids else {},
        "product": await _kv(select(Product.id, Product.name).where(Product.id.in_(pdids))) if pdids else {},
        "version": await _kv(select(ProductVersion.id, ProductVersion.name).where(ProductVersion.id.in_(verids))) if verids else {},
        "contact": await _kv(select(CustomerContact.id, CustomerContact.name).where(CustomerContact.id.in_(contact_ids))) if contact_ids else {},
        "user": {},
    }
    if user_ids:
        for (uid, name, email) in (
            await db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(user_ids))
            )
        ).all():
            out["user"][uid] = name or email or ""
    return out


async def _row_out(
    entry: CustomerStatusEntry, names: dict[str, dict[UUID, str]], licenses: dict[UUID, License],
    *, attachment_count: int,
) -> CustomerStatusRowOut:
    lic = licenses.get(entry.license_id) if entry.license_id else None
    return CustomerStatusRowOut(
        id=entry.id,
        customer_id=entry.customer_id,
        customer_name=names["customer"].get(entry.customer_id),
        project_id=entry.project_id,
        project_name=names["project"].get(entry.project_id) if entry.project_id else None,
        system_name=entry.system_name,
        environment=entry.environment,  # type: ignore[arg-type]
        runtime_type=entry.runtime_type,  # type: ignore[arg-type]
        vendor_id=entry.vendor_id,
        vendor_name=names["vendor"].get(entry.vendor_id) if entry.vendor_id else None,
        product_id=entry.product_id,
        product_name=names["product"].get(entry.product_id) if entry.product_id else None,
        version_id=entry.version_id,
        version_name=names["version"].get(entry.version_id) if entry.version_id else None,
        version_detail=entry.version_detail,
        license_id=entry.license_id,
        license_label=_license_label(lic),
        license_quantity=entry.license_quantity,
        license_start_date=entry.license_start_date,
        license_end_date=entry.license_end_date,
        customer_contact_id=entry.customer_contact_id,
        customer_contact_name=names["contact"].get(entry.customer_contact_id) if entry.customer_contact_id else None,
        tech_support_user_id=entry.tech_support_user_id,
        tech_support_user_name=names["user"].get(entry.tech_support_user_id) if entry.tech_support_user_id else None,
        created_by_user_id=entry.created_by_user_id,
        created_by_name=names["user"].get(entry.created_by_user_id) if entry.created_by_user_id else None,
        attachment_count=attachment_count,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


async def _detail_out(db: AsyncSession, entry: CustomerStatusEntry) -> CustomerStatusOut:
    names = await _resolve_names(db, [entry])
    licenses: dict[UUID, License] = {}
    if entry.license_id:
        lic = (await db.execute(select(License).where(License.id == entry.license_id))).scalar_one_or_none()
        if lic:
            licenses[entry.license_id] = lic
    base = await _row_out(
        entry, names, licenses,
        attachment_count=len(entry.attachments or []),
    )
    return CustomerStatusOut(
        **base.model_dump(),
        body=entry.body,
        plain_text=entry.plain_text,
        attachments=[
            CustomerStatusAttachmentOut.model_validate(a, from_attributes=True)
            for a in (entry.attachments or [])
        ],
    )


async def _get_or_404(db: AsyncSession, entry_id: UUID) -> CustomerStatusEntry:
    e = (
        await db.execute(
            select(CustomerStatusEntry)
            .options(selectinload(CustomerStatusEntry.attachments))
            .where(CustomerStatusEntry.id == entry_id)
        )
    ).scalar_one_or_none()
    if e is None:
        raise HTTPException(status_code=404, detail="고객사 현황 항목을 찾을 수 없습니다.")
    return e


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[CustomerStatusRowOut])
async def list_entries(
    customer_id: UUID | None = None,
    project_id: UUID | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(CustomerStatusEntry)
        .options(selectinload(CustomerStatusEntry.attachments))
        .order_by(CustomerStatusEntry.updated_at.desc())
    )
    if customer_id:
        stmt = stmt.where(CustomerStatusEntry.customer_id == customer_id)
    if project_id:
        stmt = stmt.where(CustomerStatusEntry.project_id == project_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            or_(
                CustomerStatusEntry.system_name.ilike(like),
                CustomerStatusEntry.plain_text.ilike(like),
            )
        )

    rows = list((await db.execute(stmt)).scalars())
    names = await _resolve_names(db, rows)
    lic_ids = {r.license_id for r in rows if r.license_id}
    licenses: dict[UUID, License] = {}
    if lic_ids:
        for lic in (
            await db.execute(select(License).where(License.id.in_(lic_ids)))
        ).scalars():
            licenses[lic.id] = lic
        # 카드에 license_id 가 박혀 있는데 master 가 사라진 경우(예: 라이센스
        # 삭제) — ON DELETE SET NULL 이라 정상 흐름이지만 stale row 가 있으면
        # license_label 이 빈 값으로 나가 운영자가 의아할 수 있어 WARNING.
        missing = lic_ids - set(licenses.keys())
        if missing:
            logger.warning(
                "고객사 현황 list: license_id 가 master 에 없음 — count=%d (orphan? 캐시 stale?)",
                len(missing),
            )

    return [
        await _row_out(r, names, licenses, attachment_count=len(r.attachments or []))
        for r in rows
    ]


@router.get("/{entry_id}", response_model=CustomerStatusOut)
async def get_entry(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    return await _detail_out(db, e)


@router.post("", response_model=CustomerStatusOut, status_code=status.HTTP_201_CREATED)
async def create_entry(
    payload: CustomerStatusCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _require_write(db, user)
    e = CustomerStatusEntry(
        customer_id=payload.customer_id,
        project_id=payload.project_id,
        system_name=payload.system_name.strip(),
        environment=payload.environment,
        runtime_type=payload.runtime_type,
        vendor_id=payload.vendor_id,
        product_id=payload.product_id,
        version_id=payload.version_id,
        version_detail=payload.version_detail,
        license_id=payload.license_id,
        license_quantity=payload.license_quantity,
        license_start_date=payload.license_start_date,
        license_end_date=payload.license_end_date,
        customer_contact_id=payload.customer_contact_id,
        tech_support_user_id=payload.tech_support_user_id,
        body=payload.body,
        plain_text=payload.plain_text,
        created_by_user_id=user.id,
    )
    db.add(e)
    await db.commit()
    e = await _get_or_404(db, e.id)
    logger.info(
        "고객사 현황 생성: id=%s cust=%s proj=%s system=%s author=%s",
        e.id, e.customer_id, e.project_id, e.system_name, user.id,
    )
    return await _detail_out(db, e)


@router.patch("/{entry_id}", response_model=CustomerStatusOut)
async def update_entry(
    entry_id: UUID,
    payload: CustomerStatusUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    data = payload.model_dump(exclude_unset=True)
    if "system_name" in data and data["system_name"] is not None:
        data["system_name"] = data["system_name"].strip()
    for k, v in data.items():
        setattr(e, k, v)
    await db.commit()
    e = await _get_or_404(db, entry_id)
    logger.info("고객사 현황 수정: id=%s 변경필드=%s by=%s", entry_id, list(data.keys()), user.id)
    return await _detail_out(db, e)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    # write 와 분리된 delete 게이트 — customer-status.delete 또는 작성자 본인.
    await _require_delete(db, user, e)
    # CASCADE 가 DB row 정리, 디스크 파일은 우리가 best-effort 청소.
    att_count = len(e.attachments or [])
    for a in (e.attachments or []):
        try:
            delete_file(a.file_path)
        except Exception as exc:  # pragma: no cover
            logger.warning("고객사 현황 첨부 삭제 실패: path=%s err=%s", a.file_path, exc)
    await db.delete(e)
    await db.commit()
    logger.info(
        "고객사 현황 삭제: id=%s system='%s' attachments=%d by=%s",
        entry_id, e.system_name, att_count, user.id,
    )


# ---------------------------------------------------------------------------
# 첨부
# ---------------------------------------------------------------------------


@router.post(
    "/{entry_id}/attachments",
    response_model=list[CustomerStatusAttachmentOut],
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachments(
    entry_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    saved: list[CustomerStatusAttachment] = []
    skipped_no_name = 0
    for f in files:
        if not f.filename:
            # 정상적인 multipart 요청은 filename 을 가지지만 일부 클라이언트(또는
            # drop event 의 빈 항목) 가 비어 보낼 수 있다. uuid 로 대체하지만
            # 운영자가 추적할 수 있게 카운트.
            skipped_no_name += 1
        path, size = await save_upload(f, f"customer-status/{e.id}")
        att = CustomerStatusAttachment(
            tenant_id=e.tenant_id,
            entry_id=e.id,
            file_name=f.filename or uuid4().hex,
            file_path=path,
            mime_type=f.content_type,
            size=size,
            uploaded_by=user.id,
        )
        db.add(att)
        saved.append(att)
    await db.commit()
    for s in saved:
        await db.refresh(s)
    if skipped_no_name:
        logger.warning(
            "고객사 현황 첨부 업로드: filename 누락 %d 건 — uuid 로 대체 (entry=%s by=%s)",
            skipped_no_name, e.id, user.id,
        )
    logger.info(
        "고객사 현황 첨부 업로드: entry=%s count=%d by=%s",
        e.id, len(saved), user.id,
    )
    return [CustomerStatusAttachmentOut.model_validate(s, from_attributes=True) for s in saved]


@router.patch(
    "/{entry_id}/attachments/{att_id}", response_model=CustomerStatusAttachmentOut,
)
async def rename_attachment(
    entry_id: UUID,
    att_id: UUID,
    payload: CustomerStatusAttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    att = (
        await db.execute(
            select(CustomerStatusAttachment).where(
                CustomerStatusAttachment.id == att_id,
                CustomerStatusAttachment.entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    old_name = att.file_name
    att.file_name = payload.file_name.strip()
    await db.commit()
    await db.refresh(att)
    logger.info(
        "고객사 현황 첨부 이름변경: entry=%s att=%s '%s' → '%s' by=%s",
        entry_id, att_id, old_name, att.file_name, user.id,
    )
    return CustomerStatusAttachmentOut.model_validate(att, from_attributes=True)


@router.delete(
    "/{entry_id}/attachments/{att_id}", status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_attachment(
    entry_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    att = (
        await db.execute(
            select(CustomerStatusAttachment).where(
                CustomerStatusAttachment.id == att_id,
                CustomerStatusAttachment.entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        # 멱등 — 이미 삭제된 ID 에 대한 재요청은 조용히 204 로 반환.
        return
    try:
        delete_file(att.file_path)
    except Exception as exc:  # pragma: no cover
        # 디스크 파일 정리 실패는 운영자가 별도로 청소할 수 있도록 WARNING.
        # DB row 는 그래도 지운다 (사용자가 의도한 삭제이므로 진실의 원천 일관 유지).
        logger.warning("고객사 현황 첨부 삭제 실패: path=%s err=%s", att.file_path, exc)
    await db.delete(att)
    await db.commit()
    logger.info(
        "고객사 현황 첨부 삭제: entry=%s att=%s name='%s' by=%s",
        entry_id, att_id, att.file_name, user.id,
    )


async def _fetch_att(
    db: AsyncSession, entry_id: UUID, att_id: UUID,
) -> tuple[CustomerStatusAttachment, Path]:
    att = (
        await db.execute(
            select(CustomerStatusAttachment).where(
                CustomerStatusAttachment.id == att_id,
                CustomerStatusAttachment.entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    p: Path = resolve_upload_path(att.file_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 없습니다.")
    return att, p


@router.get("/{entry_id}/attachments/{att_id}/download")
async def download_attachment(
    entry_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _get_or_404(db, entry_id)
    att, p = await _fetch_att(db, entry_id, att_id)
    return FileResponse(
        path=str(p), filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )


@router.get("/{entry_id}/attachments/{att_id}/preview")
async def preview_attachment(
    entry_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """미리보기 — Content-Disposition: inline. 브라우저가 직접 렌더할 수 있는
    type(이미지/PDF) 만 의미 있고 그 외는 클라이언트가 다운로드로 fallback."""
    await _get_or_404(db, entry_id)
    att, p = await _fetch_att(db, entry_id, att_id)
    return FileResponse(
        path=str(p),
        media_type=att.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{att.file_name}"'},
    )
