"""자사 통장 계좌 모델 (BankAccount).

- **자사 계좌 전용** — developer/customer 등 다른 owner FK 는 두지 않는다.
  고객 통장사본은 `customers.bank_account_*` 컬럼으로 별도 관리되고, 회사 자체
  계좌 명세는 `tenants.bank_*` 컬럼이 견적/청구서 PDF 의 issuer_snapshot
  에 들어간다. 이 테이블은 그 둘과 별개로 **자사 통장의 단일진실원천(SSoT)**.
- 원화·외환 모두 지원. 외환 계좌는 `swift_code`/`iban`/`bank_address` 추가.
- 통화별 primary 1개만 (DB 부분 unique 인덱스 강제).
- 통장사본 첨부는 Customers 패턴 그대로 (1 row / 1 file slot).
"""

import uuid

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class BankAccount(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "bank_accounts"

    bank_name: Mapped[str] = mapped_column(String(100), nullable=False)
    account_number: Mapped[str] = mapped_column(String(50), nullable=False)
    holder_name: Mapped[str] = mapped_column(String(100), nullable=False)
    # ISO 4217 3-letter uppercase. CHECK 제약은 db.sql 의 정규식으로 강제.
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    purpose: Mapped[str | None] = mapped_column(String(200))

    # 외환 계좌 (currency != 'KRW' 일 때 주로 입력. NULL 허용).
    swift_code: Mapped[str | None] = mapped_column(String(20))
    iban: Mapped[str | None] = mapped_column(String(50))
    bank_address: Mapped[str | None] = mapped_column(Text)

    # 통장사본 첨부 — Customers 의 bank_account_* 패턴 그대로.
    passbook_name: Mapped[str | None] = mapped_column(String(255))
    passbook_path: Mapped[str | None] = mapped_column(String(1024))
    passbook_mime: Mapped[str | None] = mapped_column(String(120))
    passbook_size: Mapped[int | None] = mapped_column(Integer)

    # 통화별 1개만 primary — 부분 unique 인덱스로 강제.
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # ACTIVE | INACTIVE — soft delete.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ACTIVE"
    )
    memo: Mapped[str | None] = mapped_column(Text)
