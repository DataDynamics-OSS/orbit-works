"""전자세금계산서 (매입·매출) — 바로빌 API 로부터 수집한 기록.

바로빌 `GetDailyTaxInvoice{Sales,Purchase}List` 를 매일 새벽 03:00 호출해
최근 3일치를 재조회하며 upsert. 공급자의 지연 등록(작성일 기준 뒤늦은 발행)을
따라잡기 위한 catch-up 기간.

`approval_no` (국세청 승인번호) 가 UNIQUE 키라서 같은 건을 여러 번 조회해도
중복 생성되지 않음. 수정발행 시 새 approval_no 로 별도 row 가 들어오며 원본은
status='CANCELED' 로 표시할 수 있게 한다 (여기서는 auto-detect 안 함).

품목 라인은 별도 `tax_invoice_items` 테이블. 수집 이력은 `tax_invoice_fetches`
로 감사용 보존 (언제 어떤 API 로 몇 건 가져왔는지).
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class TaxInvoice(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """전자세금계산서 한 건. UNIQUE(approval_no) 로 중복 방지."""

    __tablename__ = "tax_invoices"

    # PURCHASE(매입) | SALES(매출)
    kind: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    # ISSUED | CANCELED | MODIFIED (발행완료/취소/수정발행)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ISSUED")

    # 국세청 승인번호 — UNIQUE. 24자 정도.
    approval_no: Mapped[str] = mapped_column(
        String(30), nullable=False, unique=True, index=True
    )
    # 바로빌 내부 문서번호 (PDF 조회 시 필요).
    mgt_key: Mapped[str | None] = mapped_column(String(40))

    issue_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    written_date: Mapped[date | None] = mapped_column(Date)

    # 공급자 (Invoicer) / 공급받는자 (Invoicee)
    supplier_biz_no: Mapped[str | None] = mapped_column(String(20), index=True)
    supplier_name: Mapped[str | None] = mapped_column(String(200))
    supplier_ceo: Mapped[str | None] = mapped_column(String(100))
    buyer_biz_no: Mapped[str | None] = mapped_column(String(20), index=True)
    buyer_name: Mapped[str | None] = mapped_column(String(200))
    buyer_ceo: Mapped[str | None] = mapped_column(String(100))

    supply_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=0
    )
    tax_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=0
    )
    total_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=0
    )

    # TAX(과세) | NONTAX(면세) | ZERO(영세) | ...
    tax_type: Mapped[str | None] = mapped_column(String(20))
    # NORMAL(정발행) | MODIFIED(수정발행) 등
    issue_type: Mapped[str | None] = mapped_column(String(20))

    # 'barobill' | 'manual' | ...
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="barobill")
    # 공급자 API 내부 식별자 (디버깅).
    external_id: Mapped[str | None] = mapped_column(String(100))
    # 원본 응답 전체 — 재파싱·감사용.
    raw_payload: Mapped[dict | None] = mapped_column(JSONB)

    # 자사 데이터 매칭
    linked_customer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    linked_invoice_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="SET NULL"),
        index=True,
    )
    linked_project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        index=True,
    )

    # PDF 저장 경로 (upload.dir 기준 상대경로). 없으면 미수집.
    pdf_path: Mapped[str | None] = mapped_column(String(1024))
    memo: Mapped[str | None] = mapped_column(Text)

    items: Mapped[list["TaxInvoiceItem"]] = relationship(
        back_populates="tax_invoice", cascade="all, delete-orphan",
        order_by="TaxInvoiceItem.position",
    )


class TaxInvoiceItem(Base, UUIDMixin, TenantMixin):
    """세금계산서 품목 라인."""

    __tablename__ = "tax_invoice_items"

    tax_invoice_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tax_invoices.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    item_name: Mapped[str | None] = mapped_column(String(200))
    spec: Mapped[str | None] = mapped_column(String(200))
    quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 3))
    unit_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    supply_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    tax_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    memo: Mapped[str | None] = mapped_column(Text)

    tax_invoice: Mapped[TaxInvoice] = relationship(back_populates="items")


class TaxInvoiceFetch(Base, UUIDMixin, TenantMixin):
    """수집 이력 — daily job · 수동 호출 모두 기록."""

    __tablename__ = "tax_invoice_fetches"

    # SALES | PURCHASE
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    # DAILY | PERIOD
    method: Mapped[str] = mapped_column(String(20), nullable=False)
    period_start: Mapped[date | None] = mapped_column(Date)
    period_end: Mapped[date | None] = mapped_column(Date)
    # SCHEDULED_DAILY | MANUAL
    trigger_kind: Mapped[str] = mapped_column(String(30), nullable=False, default="MANUAL")

    source: Mapped[str] = mapped_column(String(40), nullable=False, default="barobill")
    triggered_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    # SUCCESS | FAILED | PARTIAL | SKIPPED (creds 없을 때)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="SUCCESS")
    fetched_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
