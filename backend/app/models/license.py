import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import BigInteger, Date, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class License(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "licenses"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("license_contacts.id", ondelete="SET NULL")
    )

    product_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 제조사 — vendors 카탈로그 FK (라이센스는 vendor 만 사용, product/version 은
    # product_name 자유 텍스트 그대로). nullable.
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vendors.id", ondelete="RESTRICT"),
        index=True,
    )

    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    applied_fx_rate: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    amount_krw: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    purchase_supplier: Mapped[str | None] = mapped_column(String(200))
    purchase_currency: Mapped[str | None] = mapped_column(String(3))
    purchase_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    purchase_fx_rate: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    sales_currency: Mapped[str | None] = mapped_column(String(3))
    sales_customer: Mapped[str | None] = mapped_column(String(200))

    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    renewal_prep_date: Mapped[date | None] = mapped_column(Date)

    status: Mapped[str] = mapped_column(String(30), nullable=False, default="ACTIVE")
    description: Mapped[str | None] = mapped_column(Text)
    memo: Mapped[str | None] = mapped_column(Text)

    quotes: Mapped[list["LicenseQuote"]] = relationship(
        back_populates="license", cascade="all, delete-orphan"
    )
    quote_items: Mapped[list["LicenseQuoteItem"]] = relationship(
        back_populates="license",
        cascade="all, delete-orphan",
        order_by="LicenseQuoteItem.position",
    )


class LicenseQuote(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "license_quotes"

    license_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("licenses.id", ondelete="CASCADE"), nullable=False
    )
    quote_type: Mapped[str] = mapped_column(String(20), nullable=False, default="SALES")
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(100))
    size: Mapped[int | None] = mapped_column(BigInteger)
    description: Mapped[str | None] = mapped_column(Text)

    license: Mapped["License"] = relationship(back_populates="quotes")


class LicenseQuoteItem(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """라이센스 견적서 라인아이템. Net Total은 표시 시 계산."""

    __tablename__ = "license_quote_items"

    license_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("licenses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # "PURCHASE" (매입) | "SALES" (매출)
    kind: Mapped[str] = mapped_column(
        String(10), nullable=False, default="PURCHASE"
    )
    product_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    product_code: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    description: Mapped[str | None] = mapped_column(Text)
    sales_price: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    qty: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=1)
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    discount_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    # Optional manual override for Net Total. When NULL the UI auto-computes
    # from sales_price, qty, discount_rate. When set, the stored value is
    # treated as authoritative.
    net_total: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    license: Mapped["License"] = relationship(back_populates="quote_items")
