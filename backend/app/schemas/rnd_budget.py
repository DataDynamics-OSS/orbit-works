"""Pydantic 스키마 — 정부 R&D 예산."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

PlanStatus = Literal["DRAFT", "SUBMITTED", "APPROVED"]
CompanySize = Literal["SMALL", "MID", "LARGE"]
PersonnelSegment = Literal["EXISTING", "NEW"]


class RndBudgetLineBase(BaseModel):
    category_id: str = Field(..., min_length=1, max_length=40)
    category_label: str = Field(..., min_length=1, max_length=60)
    subcategory_id: str = Field(..., min_length=1, max_length=60)
    subcategory_label: str = Field(..., min_length=1, max_length=80)
    item_id: str | None = Field(None, max_length=80)
    item_label: str | None = Field(None, max_length=200)
    unit_price: Decimal = Decimal("0")
    quantity: Decimal = Decimal("0")
    amount: Decimal = Decimal("0")
    note: str | None = None
    sort_order: int = 0


class RndBudgetLineCreate(RndBudgetLineBase):
    pass


class RndBudgetLineOut(RndBudgetLineBase):
    id: UUID

    class Config:
        from_attributes = True


class RndBudgetPlanBase(BaseModel):
    year: int = Field(..., ge=1900, le=2100)
    title: str = Field(..., min_length=1, max_length=200)
    project_id: UUID | None = None
    customer_id: UUID | None = None
    funding_agency: str | None = Field(None, max_length=80)
    memo: str | None = None
    status: PlanStatus = "DRAFT"
    # 예산 요약 (선택)
    company_size: CompanySize | None = None
    total_rnd_budget: Decimal | None = None
    gov_funding_amount: Decimal | None = None
    own_cash_amount: Decimal | None = None
    own_inkind_amount: Decimal | None = None
    # 비율 사용자 정의 (null = 기업규모 default). 0.0 ≤ rate ≤ 1.0.
    gov_funding_rate: Decimal | None = Field(None, ge=0, le=1)
    own_burden_rate: Decimal | None = Field(None, ge=0, le=1)
    cash_min_rate: Decimal | None = Field(None, ge=0, le=1)
    inkind_min_rate: Decimal | None = Field(None, ge=0, le=1)


class RndBudgetPlanCreate(RndBudgetPlanBase):
    pass


class RndBudgetPlanUpdate(BaseModel):
    year: int | None = Field(None, ge=1900, le=2100)
    title: str | None = Field(None, min_length=1, max_length=200)
    project_id: UUID | None = None
    customer_id: UUID | None = None
    funding_agency: str | None = Field(None, max_length=80)
    memo: str | None = None
    status: PlanStatus | None = None
    company_size: CompanySize | None = None
    total_rnd_budget: Decimal | None = None
    gov_funding_amount: Decimal | None = None
    own_cash_amount: Decimal | None = None
    own_inkind_amount: Decimal | None = None
    gov_funding_rate: Decimal | None = Field(None, ge=0, le=1)
    own_burden_rate: Decimal | None = Field(None, ge=0, le=1)
    cash_min_rate: Decimal | None = Field(None, ge=0, le=1)
    inkind_min_rate: Decimal | None = Field(None, ge=0, le=1)


class RndBudgetPlanRowOut(RndBudgetPlanBase):
    """목록 응답 — 라인 미포함, 합계만."""
    id: UUID
    total_amount: Decimal
    project_name: str | None = None
    customer_name: str | None = None
    line_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class RndBudgetPersonnelBase(BaseModel):
    segment: PersonnelSegment
    name: str = Field(..., min_length=1, max_length=80)
    role: str | None = Field(None, max_length=80)
    monthly_salary: Decimal = Decimal("0")
    monthly_insurance: Decimal = Decimal("0")
    severance_annual: Decimal = Decimal("0")
    months: Decimal = Field(Decimal("0"), ge=0, le=99.99)
    ratio_pct: Decimal = Field(Decimal("0"), ge=0, le=100)
    sort_order: int = 0


class RndBudgetPersonnelCreate(RndBudgetPersonnelBase):
    pass


class RndBudgetPersonnelOut(RndBudgetPersonnelBase):
    id: UUID

    class Config:
        from_attributes = True


class RndBudgetPersonnelReplace(BaseModel):
    """인력 일괄 치환."""
    personnel: list[RndBudgetPersonnelCreate]


class RndBudgetPlanOut(RndBudgetPlanRowOut):
    """상세 응답 — 라인 + 인력 포함."""
    lines: list[RndBudgetLineOut] = Field(default_factory=list)
    personnel: list[RndBudgetPersonnelOut] = Field(default_factory=list)


class RndBudgetLinesReplace(BaseModel):
    """라인 일괄 치환 — Grid 저장."""
    lines: list[RndBudgetLineCreate]
