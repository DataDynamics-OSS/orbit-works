"""은행 거래내역 API.

Endpoints:
- GET  /bank-accounts/{id}/transactions          — 계좌 메타 + 거래 배열
- POST /bank-accounts/{id}/transactions/preview  — CSV 파싱만, DB 저장 X (미리보기)
- POST /bank-accounts/{id}/transactions/upload   — CSV 파싱 + idempotent upsert

권한: bank_accounts.manage (HR + ADMIN).
삭제 X — 데이터 무결성. 잘못 들어간 row 는 DBA 가 직접 정리.
파일 크기 제한: 10MB.
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import BankAccount, BankTransaction, User
from app.schemas.bank_transaction import (
    BankTransactionListOut,
    BankTransactionMemoUpdate,
    BankTransactionOut,
    CsvPreviewResult,
    CsvUploadResult,
)
from app.services.bank_csv import (
    CsvParseError,
    list_supported_banks,
    parse_bank_csv,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bank-accounts", tags=["bank-transactions"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10MB


async def _load_account(db: AsyncSession, account_id: UUID) -> BankAccount:
    acc = (
        await db.execute(select(BankAccount).where(BankAccount.id == account_id))
    ).scalar_one_or_none()
    if acc is None:
        raise HTTPException(404, "통장을 찾을 수 없습니다.")
    return acc


@router.get(
    "/{account_id}/transactions",
    response_model=BankTransactionListOut,
)
async def list_transactions(
    account_id: UUID,
    year: int | None = None,
    month: int | None = None,
    limit: int = 5000,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("bank_accounts.manage")),
):
    """월(year+month) 둘 다 주면 그 달의 거래만 반환. 아니면 전체 (limit 까지).

    `latest_balance` / `last_tx_at` 은 항상 계좌의 모든 거래 중 최신 row 기준
    (월 필터와 무관) — 헤더 카드의 잔액은 "현재 잔액" 의미.
    """
    from calendar import monthrange
    from datetime import date as date_cls, datetime as dt
    from zoneinfo import ZoneInfo

    KST = ZoneInfo("Asia/Seoul")

    acc = await _load_account(db, account_id)
    if limit < 1:
        limit = 1
    if limit > 10000:
        limit = 10000

    stmt = (
        select(BankTransaction)
        .where(BankTransaction.bank_account_id == account_id)
        .order_by(BankTransaction.tx_at.desc())
    )

    if year is not None and month is not None:
        if not (1 <= month <= 12):
            raise HTTPException(400, "month 는 1~12 범위여야 합니다.")
        if not (2000 <= year <= 2100):
            raise HTTPException(400, "year 가 유효하지 않습니다.")
        last_day = monthrange(year, month)[1]
        start = dt(year, month, 1, 0, 0, 0, tzinfo=KST)
        end = dt(year, month, last_day, 23, 59, 59, tzinfo=KST)
        stmt = stmt.where(BankTransaction.tx_at >= start, BankTransaction.tx_at <= end)

    stmt = stmt.limit(limit)
    rows = list((await db.execute(stmt)).scalars())

    # 최신 잔액은 월 필터 무관 — 별도 쿼리.
    latest = (
        await db.execute(
            select(BankTransaction)
            .where(BankTransaction.bank_account_id == account_id)
            .order_by(BankTransaction.tx_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    return BankTransactionListOut(
        account_id=acc.id,
        bank_name=acc.bank_name,
        account_no=acc.account_number,
        account_holder=acc.holder_name,
        latest_balance=latest.balance_after if latest else None,
        last_tx_at=latest.tx_at if latest else None,
        transactions=[BankTransactionOut.model_validate(r) for r in rows],
    )


async def _read_upload(file: UploadFile) -> bytes:
    blob = await file.read()
    if len(blob) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"파일이 너무 큽니다 (최대 {MAX_UPLOAD_BYTES // 1024 // 1024}MB)."
        )
    if not blob:
        raise HTTPException(400, "빈 파일입니다.")
    return blob


def _row_to_jsonable(row: dict) -> dict:
    """parsed row dict → JSON 직렬화 가능 (Decimal/datetime 처리)."""
    out = {}
    for k, v in row.items():
        if isinstance(v, Decimal):
            out[k] = str(v)
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


@router.post(
    "/{account_id}/transactions/preview",
    response_model=CsvPreviewResult,
)
async def preview_csv(
    account_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("bank_accounts.manage")),
):
    acc = await _load_account(db, account_id)
    blob = await _read_upload(file)
    try:
        parsed = parse_bank_csv(acc.bank_name, blob)
    except CsvParseError as exc:
        return CsvPreviewResult(parsed=0, sample=[], error=str(exc))
    sample = [_row_to_jsonable(r.to_db_dict()) for r in parsed[:10]]
    return CsvPreviewResult(parsed=len(parsed), sample=sample, error=None)


@router.post(
    "/{account_id}/transactions/upload",
    response_model=CsvUploadResult,
    status_code=status.HTTP_201_CREATED,
)
async def upload_csv(
    account_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    acc = await _load_account(db, account_id)
    blob = await _read_upload(file)
    try:
        parsed = parse_bank_csv(acc.bank_name, blob)
    except CsvParseError as exc:
        return CsvUploadResult(parsed=0, inserted=0, skipped_duplicate=0, error=str(exc))

    if not parsed:
        return CsvUploadResult(parsed=0, inserted=0, skipped_duplicate=0)

    # ParsedTransaction → dict, account_id 부착. ON CONFLICT DO NOTHING 으로 중복 스킵.
    # 10MB 한도라 단일 statement 로 충분 (수만 row 미만).
    values = [
        {"bank_account_id": acc.id, **row.to_db_dict()}
        for row in parsed
    ]
    stmt = (
        pg_insert(BankTransaction)
        .values(values)
        .on_conflict_do_nothing(constraint="uq_bank_tx_account_dt_bal")
    )
    result = await db.execute(stmt)
    inserted = result.rowcount or 0
    await db.commit()

    duplicates = len(parsed) - inserted
    logger.info(
        "은행 거래 CSV 업로드: account=%s bank=%s parsed=%d inserted=%d dup=%d by=%s",
        acc.id, acc.bank_name, len(parsed), inserted, duplicates, user.id,
    )
    return CsvUploadResult(
        parsed=len(parsed),
        inserted=inserted,
        skipped_duplicate=duplicates,
    )


@router.patch(
    "/{account_id}/transactions/{tx_id}/memo",
    response_model=BankTransactionOut,
)
async def update_memo(
    account_id: UUID,
    tx_id: UUID,
    payload: BankTransactionMemoUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("bank_accounts.manage")),
):
    """거래내역 메모만 수정. 다른 필드는 변경 불가 (CSV 원본 무결성 유지)."""
    row = (
        await db.execute(
            select(BankTransaction).where(
                BankTransaction.id == tx_id,
                BankTransaction.bank_account_id == account_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "거래내역을 찾을 수 없습니다.")
    memo = (payload.memo or "").strip() or None
    row.memo = memo
    await db.commit()
    await db.refresh(row)
    logger.info("거래 메모 수정: tx=%s by=%s", tx_id, user.id)
    return BankTransactionOut.model_validate(row)
