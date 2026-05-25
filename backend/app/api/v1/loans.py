"""대출 (Loan) — CRUD + 다중 첨부 (대출약정서 등).

권한: `loans.manage` (HR + ADMIN). 통화 KRW 고정.

은행은 `bank_accounts` 의 row 와 FK 로 연결되며, 등록 시점의 bank_name 은
`loans.bank_name` 컬럼에 snapshot 으로 보존 — 통장이 삭제(SET NULL)되어도
그리드 표시가 깨지지 않는다.

첨부는 1:N. 파일명 변경은 PATCH 로 가능 (디스크 파일은 UUID 고정 — 사용자가
보는 file_name 만 갱신).
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import BankAccount, Loan, LoanAttachment, User
from app.schemas.loan import (
    LoanAttachmentOut,
    LoanAttachmentUpdate,
    LoanCreate,
    LoanOut,
    LoanUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/loans", tags=["loans"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _resolve_bank_name(
    db: AsyncSession, bank_account_id: UUID | None, fallback: str | None
) -> str:
    """bank_account_id 가 있으면 거기서 bank_name 가져오고, 없으면 fallback 사용.

    둘 다 없으면 ValueError. snapshot 컬럼은 NOT NULL 이라 항상 값 필요.
    """
    if bank_account_id:
        ba = (
            await db.execute(
                select(BankAccount).where(BankAccount.id == bank_account_id)
            )
        ).scalar_one_or_none()
        if not ba:
            raise HTTPException(
                status_code=404, detail="지정한 통장 계좌를 찾을 수 없습니다."
            )
        return ba.bank_name
    if fallback and fallback.strip():
        return fallback.strip()
    raise HTTPException(
        status_code=400,
        detail="은행을 선택하거나 bank_name 을 직접 입력해야 합니다.",
    )


def _attach_bank_account_number(rows) -> None:
    """`bank_account_number` transient 속성 채움 — bank_account.account_number 에서 derive.

    FK 가 NULL (통장 삭제) 이면 None. selectinload(Loan.bank_account) 가 미리
    호출돼 있어야 한다.
    """
    for r in rows:
        ba = r.bank_account
        r.bank_account_number = ba.account_number if ba else None  # type: ignore[attr-defined]


async def _load(db: AsyncSession, loan_id: UUID) -> Loan:
    row = (
        await db.execute(
            select(Loan)
            .options(
                selectinload(Loan.attachments),
                selectinload(Loan.bank_account),
            )
            .where(Loan.id == loan_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="대출을 찾을 수 없습니다.")
    _attach_bank_account_number([row])
    return row


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[LoanOut])
async def list_loans(
    status_filter: str | None = None,
    bank_name: str | None = None,
    loan_type: str | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("loans.manage")),
):
    stmt = (
        select(Loan)
        .options(
            selectinload(Loan.attachments),
            selectinload(Loan.bank_account),
        )
        .order_by(Loan.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(Loan.status == status_filter)
    if bank_name:
        stmt = stmt.where(Loan.bank_name == bank_name)
    if loan_type:
        stmt = stmt.where(Loan.loan_type == loan_type)
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            (Loan.bank_name.ilike(pattern))
            | (Loan.category.ilike(pattern))
            | (Loan.memo.ilike(pattern))
        )
    rows = list((await db.execute(stmt)).scalars().all())
    _attach_bank_account_number(rows)
    return rows


@router.post("", response_model=LoanOut, status_code=status.HTTP_201_CREATED)
async def create_loan(
    payload: LoanCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loans.manage")),
):
    bank_name = await _resolve_bank_name(
        db, payload.bank_account_id, payload.bank_name
    )
    data = payload.model_dump()
    data["bank_name"] = bank_name
    row = Loan(**data)
    db.add(row)
    await db.commit()
    await db.refresh(row, attribute_names=["attachments", "bank_account"])
    _attach_bank_account_number([row])
    logger.info(
        "대출 등록: id=%s bank=%s type=%s 약정=%s 잔액=%s (등록자=%s)",
        row.id,
        row.bank_name,
        row.loan_type,
        row.contract_amount,
        row.balance_amount,
        user.id,
    )
    return row


@router.get("/{loan_id}", response_model=LoanOut)
async def get_loan(
    loan_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("loans.manage")),
):
    return await _load(db, loan_id)


@router.patch("/{loan_id}", response_model=LoanOut)
async def update_loan(
    loan_id: UUID,
    payload: LoanUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loans.manage")),
):
    row = await _load(db, loan_id)
    data = payload.model_dump(exclude_unset=True)
    # bank_account_id 가 명시 변경되면 bank_name snapshot 갱신.
    if "bank_account_id" in data:
        new_bank_name = await _resolve_bank_name(
            db, data.get("bank_account_id"), data.get("bank_name") or row.bank_name
        )
        data["bank_name"] = new_bank_name
    # is_overdraft = false 로 바뀌면 한도 NULL 강제.
    if data.get("is_overdraft") is False:
        data["overdraft_limit"] = None
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row, attribute_names=["attachments", "bank_account"])
    _attach_bank_account_number([row])
    logger.info(
        "대출 수정: id=%s 변경필드=%s (수정자=%s)",
        row.id,
        list(data.keys()),
        user.id,
    )
    return row


@router.delete("/{loan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_loan(
    loan_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loans.manage")),
):
    """soft delete — status=CLOSED. 첨부 파일은 보존."""
    row = await _load(db, loan_id)
    row.status = "CLOSED"
    await db.commit()
    logger.warning(
        "대출 종료: id=%s bank=%s (실행자=%s)", row.id, row.bank_name, user.id
    )


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post(
    "/{loan_id}/attachments",
    response_model=LoanAttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    loan_id: UUID,
    file: UploadFile = File(...),
    description: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loans.manage")),
):
    exists = (
        await db.execute(select(Loan.id).where(Loan.id == loan_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="대출을 찾을 수 없습니다.")
    stored, size = await save_upload(file, f"loans/{loan_id}")
    att = LoanAttachment(
        loan_id=loan_id,
        file_name=file.filename or "upload.bin",
        file_path=stored,
        mime_type=file.content_type,
        size=size,
        description=description,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    logger.info(
        "대출 첨부 업로드: loan_id=%s file=%s size=%s (업로드자=%s)",
        loan_id,
        att.file_name,
        size,
        user.id,
    )
    return att


@router.patch(
    "/attachments/{attachment_id}", response_model=LoanAttachmentOut
)
async def update_attachment(
    attachment_id: UUID,
    payload: LoanAttachmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loans.manage")),
):
    """첨부 표시 파일명·설명 수정. 디스크 실제 파일명은 그대로 (UUID)."""
    att = (
        await db.execute(
            select(LoanAttachment).where(LoanAttachment.id == attachment_id)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(att, k, v)
    await db.commit()
    await db.refresh(att)
    logger.info(
        "대출 첨부 수정: id=%s 변경필드=%s (수정자=%s)",
        att.id,
        list(data.keys()),
        user.id,
    )
    return att


@router.delete(
    "/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("loans.manage")),
):
    att = (
        await db.execute(
            select(LoanAttachment).where(LoanAttachment.id == attachment_id)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    logger.info("대출 첨부 삭제: id=%s (실행자=%s)", attachment_id, user.id)


@router.get("/attachments/{attachment_id}/download")
async def download_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("loans.manage")),
):
    att = (
        await db.execute(
            select(LoanAttachment).where(LoanAttachment.id == attachment_id)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404, detail="파일이 디스크에 존재하지 않습니다."
        )
    return FileResponse(
        str(abs_path),
        filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )
