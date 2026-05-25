"""자사 통장 계좌 (BankAccount) — CRUD + 통장사본 첨부 + primary 토글.

권한: `bank_accounts.manage` (HR + ADMIN). 계좌번호는 평문 저장·노출 — 마스킹 X.

통장사본 저장 경로: `data/bank_accounts/{id}/통장사본.<ext>` (저장 함수는
`save_upload_as` — 디스크 파일명은 UUID, 표시명은 file_name 컬럼).

통화별 primary 1개만 — DB 부분 unique 인덱스가 race 안전망. 토글 엔드포인트는
같은 currency 의 다른 active row 의 is_primary 를 false 로 깎아준다.
"""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import BankAccount, User
from app.schemas.bank_account import (
    BankAccountCreate,
    BankAccountOut,
    BankAccountUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload_as

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bank-accounts", tags=["bank-accounts"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _load(db: AsyncSession, account_id: UUID) -> BankAccount:
    row = (
        await db.execute(
            select(BankAccount).where(BankAccount.id == account_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="통장 계좌를 찾을 수 없습니다.")
    return row


async def _clear_other_primaries(
    db: AsyncSession, currency: str, except_id: UUID | None
) -> None:
    """같은 currency 의 다른 active row 의 is_primary 를 일괄 false 로."""
    stmt = (
        update(BankAccount)
        .where(BankAccount.currency == currency)
        .where(BankAccount.is_primary.is_(True))
        .where(BankAccount.status == "ACTIVE")
    )
    if except_id is not None:
        stmt = stmt.where(BankAccount.id != except_id)
    await db.execute(stmt.values(is_primary=False))


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[BankAccountOut])
async def list_bank_accounts(
    currency: str | None = None,
    status_filter: str | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("bank_accounts.manage")),
):
    stmt = select(BankAccount).order_by(
        BankAccount.currency,
        BankAccount.is_primary.desc(),
        BankAccount.bank_name,
    )
    if currency:
        stmt = stmt.where(BankAccount.currency == currency.upper())
    if status_filter:
        stmt = stmt.where(BankAccount.status == status_filter)
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            (BankAccount.bank_name.ilike(pattern))
            | (BankAccount.account_number.ilike(pattern))
            | (BankAccount.holder_name.ilike(pattern))
            | (BankAccount.purpose.ilike(pattern))
        )
    return list((await db.execute(stmt)).scalars().all())


@router.post(
    "", response_model=BankAccountOut, status_code=status.HTTP_201_CREATED
)
async def create_bank_account(
    payload: BankAccountCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    data = payload.model_dump()
    data["currency"] = data["currency"].upper()
    row = BankAccount(**data)
    db.add(row)
    await db.flush()
    if row.is_primary and row.status == "ACTIVE":
        await _clear_other_primaries(db, row.currency, except_id=row.id)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "통장 계좌 등록: id=%s bank=%s currency=%s primary=%s (등록자=%s)",
        row.id,
        row.bank_name,
        row.currency,
        row.is_primary,
        user.id,
    )
    return row


@router.get("/{account_id}", response_model=BankAccountOut)
async def get_bank_account(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("bank_accounts.manage")),
):
    return await _load(db, account_id)


@router.patch("/{account_id}", response_model=BankAccountOut)
async def update_bank_account(
    account_id: UUID,
    payload: BankAccountUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    row = await _load(db, account_id)
    data = payload.model_dump(exclude_unset=True)
    if "currency" in data and data["currency"]:
        data["currency"] = data["currency"].upper()
    for k, v in data.items():
        setattr(row, k, v)
    # primary 상승 또는 currency 변경 시 동일 currency 의 다른 row 정리.
    if row.is_primary and row.status == "ACTIVE":
        await _clear_other_primaries(db, row.currency, except_id=row.id)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "통장 계좌 수정: id=%s 변경필드=%s (수정자=%s)",
        row.id,
        list(data.keys()),
        user.id,
    )
    return row


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bank_account(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    """soft delete — status=INACTIVE. 통장사본 파일은 유지 (이력 보존)."""
    row = await _load(db, account_id)
    row.status = "INACTIVE"
    row.is_primary = False  # 비활성 row 는 primary 자격 박탈
    await db.commit()
    logger.warning(
        "통장 계좌 비활성화: id=%s bank=%s (실행자=%s)",
        row.id,
        row.bank_name,
        user.id,
    )


# ---------------------------------------------------------------------------
# Primary 토글
# ---------------------------------------------------------------------------


@router.patch("/{account_id}/primary", response_model=BankAccountOut)
async def toggle_primary(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    row = await _load(db, account_id)
    if row.status != "ACTIVE":
        raise HTTPException(
            status_code=400, detail="비활성 계좌는 주계좌로 지정할 수 없습니다."
        )
    next_primary = not row.is_primary
    if next_primary:
        await _clear_other_primaries(db, row.currency, except_id=row.id)
    row.is_primary = next_primary
    await db.commit()
    await db.refresh(row)
    logger.info(
        "통장 주계좌 토글: id=%s currency=%s primary=%s (실행자=%s)",
        row.id,
        row.currency,
        row.is_primary,
        user.id,
    )
    return row


# ---------------------------------------------------------------------------
# 통장사본 첨부
# ---------------------------------------------------------------------------


@router.post("/{account_id}/passbook", response_model=BankAccountOut)
async def upload_passbook(
    account_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    row = await _load(db, account_id)
    # 기존 파일 제거.
    if row.passbook_path:
        delete_file(row.passbook_path)
    stored, size = await save_upload_as(
        file, f"bank_accounts/{account_id}", "통장사본"
    )
    row.passbook_name = file.filename or Path(stored).name
    row.passbook_path = stored
    row.passbook_mime = file.content_type
    row.passbook_size = size
    await db.commit()
    await db.refresh(row)
    logger.info(
        "통장사본 업로드: id=%s file=%s size=%s (업로드자=%s)",
        row.id,
        row.passbook_name,
        size,
        user.id,
    )
    return row


@router.get("/{account_id}/passbook")
async def download_passbook(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("bank_accounts.manage")),
):
    row = await _load(db, account_id)
    if not row.passbook_path:
        raise HTTPException(status_code=404, detail="첨부 파일이 없습니다.")
    abs_path = resolve_upload_path(row.passbook_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404, detail="파일이 디스크에 존재하지 않습니다."
        )
    return FileResponse(
        str(abs_path),
        filename=row.passbook_name or "통장사본",
        media_type=row.passbook_mime or "application/octet-stream",
    )


@router.delete(
    "/{account_id}/passbook", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_passbook(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    row = await _load(db, account_id)
    if row.passbook_path:
        delete_file(row.passbook_path)
    row.passbook_name = None
    row.passbook_path = None
    row.passbook_mime = None
    row.passbook_size = None
    await db.commit()
    logger.info("통장사본 삭제: id=%s (실행자=%s)", row.id, user.id)
