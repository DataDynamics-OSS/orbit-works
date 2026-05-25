"""Pydantic 스키마 — 운영 예산 계획."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field


class BudgetCalcLineBase(BaseModel):
    account_code_id: UUID | None = None
    item_label: str | None = Field(None, max_length=200)
    m1: Decimal = Decimal("0")
    m2: Decimal = Decimal("0")
    m3: Decimal = Decimal("0")
    m4: Decimal = Decimal("0")
    m5: Decimal = Decimal("0")
    m6: Decimal = Decimal("0")
    m7: Decimal = Decimal("0")
    m8: Decimal = Decimal("0")
    m9: Decimal = Decimal("0")
    m10: Decimal = Decimal("0")
    m11: Decimal = Decimal("0")
    m12: Decimal = Decimal("0")
    note: str | None = None
    sort_order: int = 0


class BudgetCalcLineCreate(BudgetCalcLineBase):
    pass


class BudgetCalcLineOut(BudgetCalcLineBase):
    id: UUID

    class Config:
        from_attributes = True


class BudgetCalcPlanBase(BaseModel):
    year: int = Field(..., ge=1900, le=2100)
    title: str = Field(..., min_length=1, max_length=200)
    memo: str | None = None


class BudgetCalcPlanCreate(BudgetCalcPlanBase):
    pass


class BudgetCalcPlanUpdate(BaseModel):
    year: int | None = Field(None, ge=1900, le=2100)
    title: str | None = Field(None, min_length=1, max_length=200)
    memo: str | None = None


class BudgetCalcPlanRowOut(BudgetCalcPlanBase):
    """목록 응답 — 라인 미포함."""
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BudgetCalcPlanOut(BudgetCalcPlanRowOut):
    """상세 응답 — 라인 포함."""
    lines: list[BudgetCalcLineOut] = Field(default_factory=list)


class BudgetCalcLinesReplace(BaseModel):
    """라인 일괄 치환 — Grid 저장."""
    lines: list[BudgetCalcLineCreate]
