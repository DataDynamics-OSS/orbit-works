"""은행 거래내역 (BankTransaction) — bank_accounts 의 송금 이력.

CSV 업로드로 적재. PK 전략: (bank_account_id, tx_at, balance_after) 복합 UNIQUE.
- 같은 계좌·시각·잔액이면 동일 거래로 간주 → 재업로드 idempotent (ON CONFLICT DO NOTHING).
- 동시각 다른 잔액 거래도 두 건으로 구분 가능.

지원 은행: 현재 기업은행 CSV 만 (다른 은행 어댑터는 향후 추가).
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class BankTransaction(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "bank_transactions"
    __table_args__ = (
        UniqueConstraint(
            "bank_account_id",
            "tx_at",
            "balance_after",
            name="uq_bank_tx_account_dt_bal",
        ),
    )

    bank_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("bank_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 거래일시 — KST 그대로 저장 (timestamptz, 클라이언트 표시는 다시 KST).
    tx_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    # 출금·입금 — 한 거래는 둘 중 하나만 양수, 나머지는 0.
    withdrawal: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    deposit: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    # 거래후잔액 — UNIQUE 키 일부.
    balance_after: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    # 거래내용 (예: "지방세납부", "본사관리비2월").
    description: Mapped[str | None] = mapped_column(Text)
    # 상대계좌 정보.
    counterparty_account: Mapped[str | None] = mapped_column(String(50))
    counterparty_bank: Mapped[str | None] = mapped_column(String(50))
    counterparty_holder: Mapped[str | None] = mapped_column(String(100))
    # 메모.
    memo: Mapped[str | None] = mapped_column(Text)
    # 거래구분 (인터넷·ATM·자동이체 등).
    tx_type: Mapped[str | None] = mapped_column(String(30))
    # 수표어음금액 — 보통 0.
    check_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    cms_code: Mapped[str | None] = mapped_column(String(30))
