"""임직원 여권정보 API.

- `GET    /developers/{dev_id}/passport`  여권 1건 조회 (없으면 404)
- `PUT    /developers/{dev_id}/passport`  upsert
- `DELETE /developers/{dev_id}/passport`  삭제

권한: 본인(`mapped_developer_id == dev_id`) 또는 ADMIN/HR/SUPER_ADMIN.
다른 임직원의 여권은 GET 도 403 — 클라이언트에서 탭을 숨기는 것과 별도로 서버에서도 차단.

여권번호 처리:
- 입력 (`PUT.passport_number`): 평문 → `encrypt_secret` 으로 Fernet 토큰화 후 저장.
- 출력 (`GET.passport_number`): DB token → `decrypt_secret` 으로 복원해 반환.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, has_feature
from app.core.database import get_db
from app.core.secrets_crypto import decrypt_secret, encrypt_secret
from app.models import Developer, DeveloperPassport, User
from app.schemas.developer_passport import PassportIn, PassportOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/developers/{dev_id}/passport", tags=["developer-passport"])


async def _ensure_can_access(db: AsyncSession, user: User, dev_id: UUID) -> None:
    """`employees.tab.passport` 기능 권한 또는 본인 매핑이면 통과. 그 외 403."""
    if user.mapped_developer_id is not None and user.mapped_developer_id == dev_id:
        return
    if await has_feature(db, user, "employees.tab.passport"):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="여권 정보 권한 없음")


async def _ensure_developer_exists(db: AsyncSession, dev_id: UUID) -> None:
    exists = (
        await db.execute(select(Developer.id).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="Developer not found")


def _to_out(row: DeveloperPassport) -> PassportOut:
    return PassportOut(
        passport_number=decrypt_secret(row.passport_number_enc) if row.passport_number_enc else None,
        gender=row.gender,  # type: ignore[arg-type]
        surname_en=row.surname_en,
        given_name_en=row.given_name_en,
        nationality=row.nationality,
        issue_date=row.issue_date,
        expiry_date=row.expiry_date,
        issue_country=row.issue_country,
        passport_type=row.passport_type,  # type: ignore[arg-type]
    )


@router.get("", response_model=PassportOut)
async def get_passport(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_access(db, user, dev_id)
    row = (
        await db.execute(
            select(DeveloperPassport).where(DeveloperPassport.developer_id == dev_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="여권 정보 없음")
    # 여권번호 평문 노출 → PII 접근 추적용 audit INFO. 본인 조회 vs 관리자 조회 구분.
    is_self = user.mapped_developer_id == dev_id
    logger.info(
        "여권정보 조회: dev=%s 조회자=%s (%s)",
        dev_id, user.id, "본인" if is_self else f"관리자/{user.role}",
    )
    return _to_out(row)


@router.put("", response_model=PassportOut)
async def upsert_passport(
    dev_id: UUID,
    payload: PassportIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_access(db, user, dev_id)
    await _ensure_developer_exists(db, dev_id)

    row = (
        await db.execute(
            select(DeveloperPassport).where(DeveloperPassport.developer_id == dev_id)
        )
    ).scalar_one_or_none()
    is_new = row is None
    if is_new:
        row = DeveloperPassport(developer_id=dev_id)
        db.add(row)

    # 평문 입력은 Fernet 으로 암호화. 빈 문자열·None 은 NULL 로 정규화.
    # encrypt_secret() 은 idempotent — 이미 'enc:' prefix 가 있으면 재암호화 안함.
    if payload.passport_number is not None:
        plain = payload.passport_number.strip()
        row.passport_number_enc = encrypt_secret(plain) if plain else None
    row.gender = payload.gender or None
    row.surname_en = payload.surname_en or None
    row.given_name_en = payload.given_name_en or None
    row.nationality = payload.nationality or None
    row.issue_date = payload.issue_date
    row.expiry_date = payload.expiry_date
    row.issue_country = payload.issue_country or None
    row.passport_type = payload.passport_type or None

    await db.commit()
    await db.refresh(row)
    logger.info(
        "여권정보 %s: dev=%s (편집자=%s)",
        "생성" if is_new else "수정", dev_id, user.id,
    )
    return _to_out(row)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_passport(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_access(db, user, dev_id)
    row = (
        await db.execute(
            select(DeveloperPassport).where(DeveloperPassport.developer_id == dev_id)
        )
    ).scalar_one_or_none()
    if row is None:
        return
    await db.delete(row)
    await db.commit()
    logger.info("여권정보 삭제: dev=%s (삭제자=%s)", dev_id, user.id)
