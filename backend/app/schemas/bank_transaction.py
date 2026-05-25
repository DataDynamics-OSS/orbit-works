"""BankTransaction Pydantic 스키마."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class BankTransactionOut(BaseModel):
    id: UUID
    tx_at: datetime
    withdrawal: Decimal
    deposit: Decimal
    balance_after: Decimal
    description: str | None = None
    counterparty_account: str | None = None
    counterparty_bank: str | None = None
    counterparty_holder: str | None = None
    memo: str | None = None
    tx_type: str | None = None
    check_amount: Decimal
    cms_code: str | None = None

    model_config = ConfigDict(from_attributes=True)


class BankTransactionListOut(BaseModel):
    """거래내역 페이지 응답 — 계좌 메타 + 거래 배열 + 잔액(최신)."""

    account_id: UUID
    bank_name: str
    account_no: str | None = None
    account_holder: str | None = None
    latest_balance: Decimal | None = None
    last_tx_at: datetime | None = None
    transactions: list[BankTransactionOut] = []


class CsvUploadResult(BaseModel):
    parsed: int = 0
    inserted: int = 0
    skipped_duplicate: int = 0
    error: str | None = None


class BankTransactionMemoUpdate(BaseModel):
    """거래내역 row 의 메모만 수정. 다른 필드는 immutable."""

    memo: str | None = None


class CsvPreviewRow(BankTransactionOut):
    # 미리보기용 — id 가 아직 없는 row 도 표시 위해 id optional 화 필요.
    # 하지만 현재 BankTransactionOut.id 가 required. preview 에서는 별도 모양 사용.
    pass


class CsvPreviewResult(BaseModel):
    parsed: int = 0
    sample: list[dict] = []  # 첫 N row 의 dict 표현 (모델 제약 회피)
    error: str | None = None
