from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ItemKind = Literal[
    "PRODUCT",
    "CONSULTING",
    "TECH_SUPPORT",
    "DEVELOPMENT",
    "MAINTENANCE",
    "OTHER",
]
TaxMode = Literal["EXCLUSIVE", "INCLUSIVE"]
Currency = Literal["KRW", "USD"]
QuoteLocale = Literal["ko", "en"]
QuoteStatus = Literal["DRAFT", "FINAL"]
InvoiceStatus = Literal["DRAFT", "FINAL"]


class LineItemBase(BaseModel):
    kind: ItemKind = "PRODUCT"
    name: str
    description: str | None = None
    unit: str | None = None
    quantity: Decimal = Decimal("1")
    unit_price: Decimal = Decimal("0")
    discount_rate: Decimal = Decimal("0")
    role: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    months: Decimal | None = None
    # 계약 년수 (양수, 최소 1). 공급가액 = qty × price × years × (1 - disc%).
    years: Decimal = Decimal("1")
    # 공급가액 수동 입력 여부 (true 면 line_total 을 사용자 입력값 그대로 사용).
    manual_total: bool = False
    # 수동일 때만 유효 — 서버에서 line_total 로 저장.
    line_total: Decimal | None = None


class LineItemIn(LineItemBase):
    position: int | None = None


class LineItemOut(LineItemBase):
    id: UUID
    position: int
    line_subtotal: Decimal
    line_discount: Decimal
    line_total: Decimal

    class Config:
        from_attributes = True


class DocumentBase(BaseModel):
    customer_id: UUID | None = None
    title: str = ""
    business_name: str | None = None
    attention: str | None = None
    issue_date: date | None = None
    currency: Currency = "KRW"
    tax_mode: TaxMode = "EXCLUSIVE"
    tax_rate: Decimal = Decimal("10")
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None
    # 견적서 언어 (Quote 만 사용 — Invoice 는 항상 영문). 'ko' / 'en'.
    locale: QuoteLocale = "ko"


# --- Quote ---


class QuoteCreate(DocumentBase):
    valid_until: date | None = None
    items: list[LineItemIn] = Field(default_factory=list)
    # 복사(copy) 로 생성 시 원본 id.
    source_quote_id: UUID | None = None


class QuoteUpdate(BaseModel):
    customer_id: UUID | None = None
    title: str | None = None
    business_name: str | None = None
    attention: str | None = None
    issue_date: date | None = None
    valid_until: date | None = None
    currency: Currency | None = None
    locale: QuoteLocale | None = None
    tax_mode: TaxMode | None = None
    tax_rate: Decimal | None = None
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None


class QuoteItemsSave(BaseModel):
    items: list[LineItemIn]


class QuoteSave(BaseModel):
    """통합 저장 payload. new_version=False 면 현재 버전 덮어쓰기 (이력 기록 없음).
    new_version=True 면 현재 상태를 이력에 스냅샷 + 버전 +1.
    """

    customer_id: UUID | None = None
    title: str | None = None
    business_name: str | None = None
    attention: str | None = None
    issue_date: date | None = None
    valid_until: date | None = None
    currency: Currency | None = None
    locale: QuoteLocale | None = None
    tax_mode: TaxMode | None = None
    tax_rate: Decimal | None = None
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None
    items: list[LineItemIn] = Field(default_factory=list)
    new_version: bool = False


class QuoteOut(BaseModel):
    id: UUID
    number: str
    year: int
    seq: int | None = None
    version: int = 1
    display_number: str | None = None
    customer_id: UUID | None = None
    customer_snapshot: dict | None = None
    issuer_snapshot: dict | None = None
    title: str
    business_name: str | None = None
    attention: str | None = None
    issue_date: date
    valid_until: date | None = None
    currency: Currency
    locale: QuoteLocale = "ko"
    tax_mode: TaxMode
    tax_rate: Decimal
    subtotal: Decimal
    discount_total: Decimal
    tax_amount: Decimal
    total_amount: Decimal
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    status: QuoteStatus = "DRAFT"
    converted_invoice_id: UUID | None = None
    source_quote_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None
    items: list[LineItemOut] = []
    customer_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Config:
        from_attributes = True


# --- Invoice ---


class InvoiceCreate(DocumentBase):
    # Invoice 기본값 override — DocumentBase 는 견적서 기준 (KRW/EXCLUSIVE/10%).
    currency: Currency = "USD"
    tax_mode: TaxMode = "INCLUSIVE"
    tax_rate: Decimal = Decimal("0")
    due_date: date | None = None
    po_no: str | None = None
    items: list[LineItemIn] = Field(default_factory=list)
    source_quote_id: UUID | None = None
    source_invoice_id: UUID | None = None


class InvoiceUpdate(BaseModel):
    customer_id: UUID | None = None
    title: str | None = None
    business_name: str | None = None
    attention: str | None = None
    po_no: str | None = None
    issue_date: date | None = None
    due_date: date | None = None
    currency: Currency | None = None
    tax_mode: TaxMode | None = None
    tax_rate: Decimal | None = None
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    payment_status: Literal["UNPAID", "PARTIAL", "PAID"] | None = None
    paid_at: date | None = None
    linked_bank_transaction_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None


class InvoiceItemsSave(BaseModel):
    items: list[LineItemIn]


class InvoiceSave(BaseModel):
    customer_id: UUID | None = None
    title: str | None = None
    business_name: str | None = None
    attention: str | None = None
    po_no: str | None = None
    issue_date: date | None = None
    due_date: date | None = None
    currency: Currency | None = None
    tax_mode: TaxMode | None = None
    tax_rate: Decimal | None = None
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    payment_status: Literal["UNPAID", "PARTIAL", "PAID"] | None = None
    paid_at: date | None = None
    linked_bank_transaction_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None
    items: list[LineItemIn] = Field(default_factory=list)
    new_version: bool = False


class InvoicePayment(BaseModel):
    amount: Decimal


class InvoiceOut(BaseModel):
    id: UUID
    number: str
    year: int
    seq: int | None = None
    version: int = 1
    status: InvoiceStatus = "DRAFT"
    display_number: str | None = None
    customer_id: UUID | None = None
    customer_snapshot: dict | None = None
    issuer_snapshot: dict | None = None
    title: str
    business_name: str | None = None
    attention: str | None = None
    po_no: str | None = None
    issue_date: date
    due_date: date | None = None
    currency: Currency
    tax_mode: TaxMode
    tax_rate: Decimal
    subtotal: Decimal
    discount_total: Decimal
    tax_amount: Decimal
    total_amount: Decimal
    paid_amount: Decimal
    payment_status: Literal["UNPAID", "PARTIAL", "PAID"] = "UNPAID"
    paid_at: date | None = None
    linked_bank_transaction_id: UUID | None = None
    project_id: UUID | None = None
    opportunity_id: UUID | None = None
    source_quote_id: UUID | None = None
    source_invoice_id: UUID | None = None
    memo: str | None = None
    terms: str | None = None
    items: list[LineItemOut] = []
    customer_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Config:
        from_attributes = True


# --- Version history ---


class VersionOut(BaseModel):
    id: UUID
    version: int
    header: dict
    items: list[dict]
    created_by: UUID | None = None
    created_at: datetime | None = None

    class Config:
        from_attributes = True


# --- Company profile ---


class CompanyProfileOut(BaseModel):
    id: UUID | None = None
    # 한글
    name: str | None = None
    business_no: str | None = None
    representative: str | None = None
    address: str | None = None
    phone: str | None = None
    fax: str | None = None
    email: str | None = None
    bank_name: str | None = None
    bank_account: str | None = None
    bank_holder: str | None = None
    # 영문
    name_en: str | None = None
    representative_en: str | None = None
    address_en: str | None = None
    bank_name_en: str | None = None
    bank_holder_en: str | None = None
    # 공통
    logo_name: str | None = None
    logo_path: str | None = None
    stamp_name: str | None = None
    stamp_path: str | None = None
    seal_name: str | None = None
    seal_path: str | None = None
    number_prefix: str = "DD"

    class Config:
        from_attributes = True


class CompanyProfileUpdate(BaseModel):
    name: str | None = None
    business_no: str | None = None
    representative: str | None = None
    address: str | None = None
    phone: str | None = None
    fax: str | None = None
    email: str | None = None
    bank_name: str | None = None
    bank_account: str | None = None
    bank_holder: str | None = None
    name_en: str | None = None
    representative_en: str | None = None
    address_en: str | None = None
    bank_name_en: str | None = None
    bank_holder_en: str | None = None
    number_prefix: str | None = None
