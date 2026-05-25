"""고객사 현황 (Customer Status) — Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

# 시스템 유형 — DB 에는 영문 코드, UI 라벨은 운영/스테이징/개발.
Environment = Literal["PROD", "STAGING", "DEV"]
# 런타임 유형 — 시스템이 돌아가는 인프라 형태.
RuntimeType = Literal["VM", "BAREMETAL", "KUBERNETES", "DOCKER"]


class CustomerStatusAttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    uploaded_by: UUID | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class CustomerStatusRowOut(BaseModel):
    """목록용 — body/plain_text 비포함."""
    id: UUID
    customer_id: UUID
    customer_name: str | None = None
    project_id: UUID | None = None
    project_name: str | None = None
    system_name: str
    environment: Environment = "PROD"
    runtime_type: RuntimeType = "BAREMETAL"

    vendor_id: UUID | None = None
    vendor_name: str | None = None
    product_id: UUID | None = None
    product_name: str | None = None
    version_id: UUID | None = None
    version_name: str | None = None
    version_detail: str | None = None  # 자유 패치/빌드 표기 — 예: 7.1.9.1080-4

    license_id: UUID | None = None
    license_label: str | None = None  # license.product_name + " " + key 등 표시용
    license_quantity: int | None = None
    license_start_date: date | None = None
    license_end_date: date | None = None

    customer_contact_id: UUID | None = None
    customer_contact_name: str | None = None
    tech_support_user_id: UUID | None = None
    tech_support_user_name: str | None = None

    created_by_user_id: UUID | None = None
    created_by_name: str | None = None
    attachment_count: int = 0
    created_at: datetime
    updated_at: datetime


class CustomerStatusOut(CustomerStatusRowOut):
    """상세 — 본문 + 첨부 포함."""
    body: str | None = None
    plain_text: str | None = None
    attachments: list[CustomerStatusAttachmentOut] = Field(default_factory=list)


class CustomerStatusCreate(BaseModel):
    customer_id: UUID
    project_id: UUID | None = None
    system_name: str = Field(min_length=1, max_length=120)
    environment: Environment = "PROD"
    runtime_type: RuntimeType = "BAREMETAL"
    vendor_id: UUID | None = None
    product_id: UUID | None = None
    version_id: UUID | None = None
    version_detail: str | None = Field(default=None, max_length=60)
    license_id: UUID | None = None
    license_quantity: int | None = Field(default=None, ge=0)
    license_start_date: date | None = None
    license_end_date: date | None = None
    customer_contact_id: UUID | None = None
    tech_support_user_id: UUID | None = None
    body: str | None = None
    plain_text: str | None = None


class CustomerStatusUpdate(BaseModel):
    customer_id: UUID | None = None
    project_id: UUID | None = None
    system_name: str | None = Field(default=None, min_length=1, max_length=120)
    environment: Environment | None = None
    runtime_type: RuntimeType | None = None
    vendor_id: UUID | None = None
    product_id: UUID | None = None
    version_id: UUID | None = None
    version_detail: str | None = Field(default=None, max_length=60)
    license_id: UUID | None = None
    license_quantity: int | None = Field(default=None, ge=0)
    license_start_date: date | None = None
    license_end_date: date | None = None
    customer_contact_id: UUID | None = None
    tech_support_user_id: UUID | None = None
    body: str | None = None
    plain_text: str | None = None


class CustomerStatusAttachmentRename(BaseModel):
    file_name: str = Field(min_length=1, max_length=300)
