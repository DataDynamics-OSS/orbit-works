"""견적서(Quote) / 청구서(Invoice) 모델.

Quote 와 Invoice 는 라인 아이템 스키마가 동일하지만 법적 의미가 달라 별도 테이블.
각 문서는 발행 시점에 거래처/발행자 정보 스냅샷(jsonb)을 동결 보관한다.
"""

import uuid
from datetime import date
from decimal import Decimal

from datetime import datetime as _dt

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


# ---------------------------------------------------------------------------
# Quote
# ---------------------------------------------------------------------------


class Quote(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "quotes"
    __table_args__ = (UniqueConstraint("number", name="uq_quotes_number"),)

    number: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    # 구 포맷 (PREFIXQ-YYYY-NNNN) 잔존용. 신규 포맷(날짜+랜덤)에선 NULL.
    seq: Mapped[int | None] = mapped_column(Integer)
    # 저장(Save) 마다 +1. 표시 번호 = f"{number}-{version}".
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="RESTRICT")
    )
    customer_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    issuer_snapshot: Mapped[dict | None] = mapped_column(JSONB)

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    issue_date: Mapped[date] = mapped_column(Date, nullable=False)
    valid_until: Mapped[date | None] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")
    # 견적서 언어 — 'ko' (한국어, default) / 'en' (영문). PDF/Excel/화면 라벨
    # 모두 이 값에 따라 LABELS_KO / LABELS_EN 전환. 통화와는 무관 (KRW 영문
    # 견적도 가능). 자유 텍스트 필드는 사용자 입력 그대로.
    locale: Mapped[str] = mapped_column(String(2), nullable=False, default="ko")
    # EXCLUSIVE = 별도(기본), INCLUSIVE = 포함. 영세율은 tax_rate=0 으로 처리.
    tax_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="EXCLUSIVE")
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=10)

    subtotal: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    discount_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)

    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("opportunities.id", ondelete="SET NULL")
    )

    # DRAFT(진행중) | FINAL(최종 제출). 최종 제출되면 편집 잠금.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="DRAFT")

    # Quote → Invoice 로 전환되면 그 invoice id 를 기록 (상태값 아님, 링크).
    converted_invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invoices.id", ondelete="SET NULL")
    )
    source_quote_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("quotes.id", ondelete="SET NULL")
    )

    # 사업명 — PDF 머리에 함께 표시되는 사업/프로젝트 컨텍스트 (선택).
    business_name: Mapped[str | None] = mapped_column(String(200))
    # 수신 — "OOO 주식회사 OOO님 귀하" 등 수신자 문자열 (선택).
    attention: Mapped[str | None] = mapped_column(String(200))

    memo: Mapped[str | None] = mapped_column(Text)
    terms: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    items: Mapped[list["QuoteItem"]] = relationship(
        back_populates="quote",
        cascade="all, delete-orphan",
        order_by="QuoteItem.position",
    )


class QuoteItem(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "quote_items"

    quote_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # PRODUCT | STAFFING | SERVICE | EXPENSE | OTHER
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="PRODUCT")

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str | None] = mapped_column(String(32))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=1)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    discount_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=0)

    # STAFFING (인력공급) 전용
    role: Mapped[str | None] = mapped_column(String(60))
    period_start: Mapped[date | None] = mapped_column(Date)
    period_end: Mapped[date | None] = mapped_column(Date)
    months: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    # 계약 년수 (다년 배수). 최소 1, 기본 1. 공급가액 = qty × price × years × (1 - disc%).
    years: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=1)

    # 발행 시점의 금액 스냅샷.
    line_subtotal: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    line_discount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    line_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    # 공급가액 수동 입력 — true 면 qty/price/discount 로 재계산하지 않고
    # 사용자가 직접 입력한 line_total 을 그대로 사용. line_discount 는 0.
    manual_total: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    quote: Mapped["Quote"] = relationship(back_populates="items")


# ---------------------------------------------------------------------------
# Invoice
# ---------------------------------------------------------------------------


class Invoice(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "invoices"
    __table_args__ = (UniqueConstraint("number", name="uq_invoices_number"),)

    number: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    # 구 포맷 (PREFIXQ-YYYY-NNNN) 잔존용. 신규 포맷(날짜+랜덤)에선 NULL.
    seq: Mapped[int | None] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # DRAFT (편집 가능) | FINAL (잠김) — Quote 와 동일한 워크플로우.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="DRAFT")

    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="RESTRICT")
    )
    customer_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    issuer_snapshot: Mapped[dict | None] = mapped_column(JSONB)

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    issue_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    # 청구서 기본값: USD / INCLUSIVE (해외 B2B 청구 중심 가정).
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    tax_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="INCLUSIVE")
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=0)

    subtotal: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    discount_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)

    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("opportunities.id", ondelete="SET NULL")
    )

    # 수금 — paid_amount 는 부분수금 누적, payment_status 는 명시 enum (UI 필터 용이).
    paid_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    payment_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="UNPAID", index=True
    )
    paid_at: Mapped[date | None] = mapped_column(Date)
    # 통장 거래와 매칭 — 수금 reconciliation 자동화.
    linked_bank_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("bank_transactions.id", ondelete="SET NULL"),
        index=True,
    )

    source_quote_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("quotes.id", ondelete="SET NULL")
    )
    source_invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invoices.id", ondelete="SET NULL")
    )

    business_name: Mapped[str | None] = mapped_column(String(200))
    attention: Mapped[str | None] = mapped_column(String(200))
    # 고객이 발행한 PO 번호 — vendor_bills.po_no 와 명명 통일 (해외 B2B 청구 시 상단 표기).
    po_no: Mapped[str | None] = mapped_column(String(100))

    memo: Mapped[str | None] = mapped_column(Text)
    terms: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    items: Mapped[list["InvoiceItem"]] = relationship(
        back_populates="invoice",
        cascade="all, delete-orphan",
        order_by="InvoiceItem.position",
    )


class InvoiceItem(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "invoice_items"

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="PRODUCT")

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str | None] = mapped_column(String(32))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=1)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    discount_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=0)

    role: Mapped[str | None] = mapped_column(String(60))
    period_start: Mapped[date | None] = mapped_column(Date)
    period_end: Mapped[date | None] = mapped_column(Date)
    months: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    # 계약 년수 (다년 배수). QuoteItem 과 동일한 의미.
    years: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=1)

    line_subtotal: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    line_discount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    line_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    manual_total: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    invoice: Mapped["Invoice"] = relationship(back_populates="items")


# ---------------------------------------------------------------------------
# 버전 이력 (Save 마다 스냅샷 1건)
# ---------------------------------------------------------------------------


class QuoteVersion(Base, UUIDMixin, TenantMixin):
    """견적서 저장 시점의 헤더+라인 전체 스냅샷."""

    __tablename__ = "quote_versions"
    __table_args__ = (
        UniqueConstraint("quote_id", "version", name="uq_quote_versions_qv"),
    )

    quote_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("quotes.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    header: Mapped[dict] = mapped_column(JSONB, nullable=False)
    items: Mapped[list] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[_dt] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class InvoiceVersion(Base, UUIDMixin, TenantMixin):
    __tablename__ = "invoice_versions"
    __table_args__ = (
        UniqueConstraint("invoice_id", "version", name="uq_invoice_versions_iv"),
    )

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    header: Mapped[dict] = mapped_column(JSONB, nullable=False)
    items: Mapped[list] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[_dt] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
