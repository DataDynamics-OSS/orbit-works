"""Pydantic 스키마 — 계정과목 (AccountCode)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

Kind = Literal["INCOME", "EXPENSE"]


class AccountCodeBase(BaseModel):
    kind: Kind
    category: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    usage_guide: str | None = None
    account_code: str | None = Field(None, max_length=10)
    account_name: str | None = Field(None, max_length=50)
    is_pl: bool = True
    sort_order: int = 0
    is_active: bool = True


class AccountCodeCreate(AccountCodeBase):
    pass


class AccountCodeUpdate(BaseModel):
    kind: Kind | None = None
    category: str | None = Field(None, min_length=1, max_length=40)
    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    usage_guide: str | None = None
    account_code: str | None = Field(None, max_length=10)
    account_name: str | None = Field(None, max_length=50)
    is_pl: bool | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class AccountCodeOut(AccountCodeBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AccountCodeReorderItem(BaseModel):
    id: UUID
    sort_order: int


class SeedSummary(BaseModel):
    inserted: int
    skipped: int
    total: int
