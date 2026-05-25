"""대출 (Loan) + 첨부 모델.

자사가 받은 대출의 원장. 통화는 KRW 고정 (외환 대출 필요 시 별도 PR 로 확장).
은행은 `bank_accounts` 의 row 와 FK 로 연결 — 자동이체 deposit 계좌 등을 의미.
은행명은 등록 시점에 `bank_name` 컬럼에 snapshot 으로 보존해 FK 가 SET NULL
되어도 표시가 깨지지 않도록 한다.

종류 (loan_type) 코드:
- SME_FACILITY  중소기업시설자금
- SME_GENERAL   중소기업자금
- CORP_OPERATING 기업운전일반자금
"""

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Loan(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "loans"

    # 연결된 자사 통장 (자동이체 등). NULL 허용 — 통장이 삭제되면 SET NULL.
    bank_account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("bank_accounts.id", ondelete="SET NULL"),
        index=True,
    )
    # FK SET NULL 후에도 표시 유지를 위해 등록 시점 은행명 snapshot 저장.
    bank_name: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str | None] = mapped_column(String(100))  # 구분 (자유 입력)
    # SME_FACILITY | SME_GENERAL | CORP_OPERATING — DB CHECK 로 화이트리스트 강제.
    loan_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # 계좌번호는 별도 컬럼 X — bank_account.account_number JOIN 으로 표시.
    # KRW 정수 금액. numeric(18,0) — 9백조까지.
    contract_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 0), nullable=False, default=0
    )
    balance_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 0), nullable=False, default=0
    )
    # 1~31일. CHECK 로 강제. 미지정 가능 (NULL).
    interest_pay_day: Mapped[int | None] = mapped_column(SmallInteger)
    maturity_date: Mapped[date | None] = mapped_column(Date)
    is_overdraft: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # is_overdraft = true 일 때만 채워지는 한도. 그 외 NULL.
    overdraft_limit: Mapped[Decimal | None] = mapped_column(Numeric(18, 0))
    memo: Mapped[str | None] = mapped_column(Text)
    # ACTIVE | CLOSED — soft delete (만기·상환 완료).
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ACTIVE", index=True
    )

    bank_account = relationship(
        "BankAccount", foreign_keys=[bank_account_id], lazy="select"
    )
    attachments: Mapped[list["LoanAttachment"]] = relationship(
        back_populates="loan",
        cascade="all, delete-orphan",
        order_by="LoanAttachment.created_at",
    )


class LoanAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """대출 첨부 (대출약정서·담보서류·계산서 등). 다중 파일.

    저장 경로: ``data/loans/{loan_id}/<uuid>.<ext>``.
    `file_name` 은 사용자가 자유 변경 가능 (디스크 파일명은 UUID 로 고정).
    """

    __tablename__ = "loan_attachments"

    loan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("loans.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)
    description: Mapped[str | None] = mapped_column(Text)

    loan: Mapped["Loan"] = relationship(back_populates="attachments")
