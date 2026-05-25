from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel


class LicenseQuoteOut(BaseModel):
    id: UUID
    license_id: UUID
    quote_type: str
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    description: str | None = None

    class Config:
        from_attributes = True


class LicenseQuoteUpdate(BaseModel):
    file_name: str | None = None
    description: str | None = None
    quote_type: str | None = None


class LicenseBase(BaseModel):
    customer_id: UUID
    contact_id: UUID | None = None
    product_name: str
    vendor: str | None = None
    currency: str = "KRW"
    amount: Decimal = Decimal("0")
    applied_fx_rate: Decimal | None = None
    purchase_supplier: str | None = None
    purchase_currency: str | None = None
    purchase_amount: Decimal | None = None
    purchase_fx_rate: Decimal | None = None
    sales_currency: str | None = None
    sales_customer: str | None = None
    start_date: date
    end_date: date
    renewal_prep_date: date | None = None
    status: str = "ACTIVE"
    description: str | None = None
    memo: str | None = None


class LicenseCreate(LicenseBase):
    pass


class LicenseUpdate(BaseModel):
    customer_id: UUID | None = None
    contact_id: UUID | None = None
    product_name: str | None = None
    vendor: str | None = None
    currency: str | None = None
    amount: Decimal | None = None
    applied_fx_rate: Decimal | None = None
    purchase_supplier: str | None = None
    purchase_currency: str | None = None
    purchase_amount: Decimal | None = None
    purchase_fx_rate: Decimal | None = None
    sales_currency: str | None = None
    sales_customer: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    renewal_prep_date: date | None = None
    status: str | None = None
    description: str | None = None
    memo: str | None = None


class LicenseQuoteItemIn(BaseModel):
    id: UUID | None = None
    product_name: str = ""
    product_code: str = ""
    description: str | None = None
    sales_price: Decimal = Decimal("0")
    qty: Decimal = Decimal("1")
    start_date: date | None = None
    end_date: date | None = None
    discount_rate: Decimal = Decimal("0")
    # Optional manual override; null means auto-compute.
    net_total: Decimal | None = None


class LicenseQuoteItemOut(LicenseQuoteItemIn):
    id: UUID
    license_id: UUID
    position: int

    class Config:
        from_attributes = True


class LicenseQuoteItemsSave(BaseModel):
    items: list[LicenseQuoteItemIn]


class LicenseOut(LicenseBase):
    id: UUID
    vendor_id: UUID | None = None
    amount_krw: Decimal | None = None
    quotes: list[LicenseQuoteOut] = []

    class Config:
        from_attributes = True
