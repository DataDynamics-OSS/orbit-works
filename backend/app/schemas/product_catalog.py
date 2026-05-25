"""제품 카탈로그 — 제조사·제품·버전 Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field


class VendorIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    is_active: bool = True
    sort_order: int = 0


class VendorOut(VendorIn):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ProductIn(BaseModel):
    vendor_id: UUID
    name: str = Field(min_length=1, max_length=120)
    long_name: str | None = Field(default=None, max_length=200)
    description: str | None = None
    product_code: str | None = Field(default=None, max_length=50)
    link: str | None = Field(default=None, max_length=500)
    is_active: bool = True
    sort_order: int = 0


class ProductOut(ProductIn):
    id: UUID
    vendor_name: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ProductVersionIn(BaseModel):
    product_id: UUID
    name: str = Field(min_length=1, max_length=60)
    release_date: date | None = None
    description: str | None = None
    link: str | None = Field(default=None, max_length=500)
    is_active: bool = True
    sort_order: int = 0


class ProductVersionOut(ProductVersionIn):
    id: UUID
    product_name: str | None = None
    vendor_id: UUID | None = None
    vendor_name: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class VendorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    is_active: bool | None = None
    sort_order: int | None = None


class ProductUpdate(BaseModel):
    vendor_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    long_name: str | None = Field(default=None, max_length=200)
    description: str | None = None
    product_code: str | None = Field(default=None, max_length=50)
    link: str | None = Field(default=None, max_length=500)
    is_active: bool | None = None
    sort_order: int | None = None


class ProductVersionUpdate(BaseModel):
    product_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=60)
    release_date: date | None = None
    description: str | None = None
    link: str | None = Field(default=None, max_length=500)
    is_active: bool | None = None
    sort_order: int | None = None
