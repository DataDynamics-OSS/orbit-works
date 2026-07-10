"""Domain — Pydantic schemas (list / create / update / out)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DomainBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    purchase_date: date | None = None
    expiry_date: date | None = None
    purchase_amount: Decimal | None = None
    currency: str = Field("KRW", min_length=1, max_length=3)
    vendor: str | None = Field(default=None, max_length=200)
    purpose: str | None = None
    auto_renew: bool = False
    expiry_alarm: bool = True
    memo: str | None = None


class DomainCreate(DomainBase):
    pass


class DomainUpdate(BaseModel):
    """모든 필드 nullable — 미지정 키는 변경 없음."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    purchase_date: date | None = None
    expiry_date: date | None = None
    purchase_amount: Decimal | None = None
    currency: str | None = Field(default=None, min_length=1, max_length=3)
    vendor: str | None = Field(default=None, max_length=200)
    purpose: str | None = None
    auto_renew: bool | None = None
    expiry_alarm: bool | None = None
    memo: str | None = None


class DomainOut(DomainBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
