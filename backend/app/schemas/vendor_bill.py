"""매입 인보이스 — 프런트 ↔ 백엔드 직렬화."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

# 카테고리 — frontend 와 동기화 필수.
VendorBillCategory = Literal[
    "CLOUD",                    # 클라우드 (AWS/Azure/GCP) — cloud_cost 와 별개로 정기 인보이스가 있을 때
    "SAAS",                     # SaaS 구독 (Slack, GitHub, Notion 등)
    "SOFTWARE_SUBSCRIPTION",    # 소프트웨어 구독 (라이센스 갱신 등)
    "HOSTING",                  # 호스팅·도메인
    "MARKETING",                # 마케팅·광고
    "OUTSOURCING",              # 외주 (개발·디자인 등)
    "OFFICE",                   # 사무용품·소모품
    "TRAVEL",                   # 출장·교통
    "UTILITIES",                # 공과금 (전기·인터넷)
    "LEGAL",                    # 법무·세무
    "OTHER",
]

PaymentStatus = Literal["UNPAID", "PARTIAL", "PAID"]


TaxMode = Literal["INCLUSIVE", "EXCLUSIVE"]


class VendorBillBase(BaseModel):
    vendor_name: str
    vendor_biz_no: str | None = None
    customer_id: UUID | None = None
    delivery_customer_id: UUID | None = None
    quote_id: UUID | None = None
    project_id: UUID | None = None
    title: str | None = None
    invoice_no: str | None = None
    po_no: str | None = None
    sales_order_no: str | None = None
    bill_date: date
    due_date: date | None = None
    category: VendorBillCategory = "OTHER"
    currency: str = "USD"
    tax_mode: TaxMode = "EXCLUSIVE"
    amount: Decimal = Field(default=Decimal(0))
    tax_amount: Decimal = Field(default=Decimal(0))
    payment_status: PaymentStatus = "UNPAID"
    paid_amount: Decimal = Field(default=Decimal(0))
    paid_at: date | None = None
    memo: str | None = None
    linked_tax_invoice_id: UUID | None = None
    linked_bank_transaction_id: UUID | None = None


class VendorBillCreate(VendorBillBase):
    pass


class VendorBillUpdate(BaseModel):
    vendor_name: str | None = None
    vendor_biz_no: str | None = None
    customer_id: UUID | None = None
    delivery_customer_id: UUID | None = None
    quote_id: UUID | None = None
    project_id: UUID | None = None
    title: str | None = None
    invoice_no: str | None = None
    po_no: str | None = None
    sales_order_no: str | None = None
    bill_date: date | None = None
    due_date: date | None = None
    category: VendorBillCategory | None = None
    currency: str | None = None
    tax_mode: TaxMode | None = None
    amount: Decimal | None = None
    tax_amount: Decimal | None = None
    payment_status: PaymentStatus | None = None
    paid_amount: Decimal | None = None
    paid_at: date | None = None
    memo: str | None = None
    linked_tax_invoice_id: UUID | None = None
    linked_bank_transaction_id: UUID | None = None


class VendorBillAttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None
    size: int | None
    created_at: datetime

    class Config:
        from_attributes = True


class VendorBillOut(VendorBillBase):
    id: UUID
    # 합계 = amount + tax_amount, DB generated column. read-only.
    total_amount: Decimal = Field(default=Decimal(0))
    attachments: list[VendorBillAttachmentOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    created_by: UUID | None = None

    class Config:
        from_attributes = True
