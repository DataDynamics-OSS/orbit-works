"""Pydantic schemas for payroll."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

PayrollStatus = Literal["DRAFT", "FINAL", "PAID"]
PayrollMode = Literal["PAYROLL", "WITHHOLDING"]


# ---------------------------------------------------------------------------
# PayrollRun
# ---------------------------------------------------------------------------


class PayrollRunCreate(BaseModel):
    year: int
    month: int = Field(ge=1, le=12)
    pay_date: date | None = None
    is_year_end_adjustment: bool = False
    memo: str | None = None


class PayrollRunUpdate(BaseModel):
    pay_date: date | None = None
    is_year_end_adjustment: bool | None = None
    memo: str | None = None


class PayrollRunOut(BaseModel):
    id: UUID
    year: int
    month: int
    status: PayrollStatus
    pay_date: date | None = None
    is_year_end_adjustment: bool = False
    memo: str | None = None
    created_by: UUID | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # 집계 (리스트 응답에서 계산하여 채움)
    item_count: int = 0
    total_gross_taxable: Decimal = Decimal("0")
    total_gross_nontax: Decimal = Decimal("0")
    total_deduction: Decimal = Decimal("0")
    total_net_pay: Decimal = Decimal("0")

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# PayrollItem
# ---------------------------------------------------------------------------


class PayrollItemBase(BaseModel):
    mode: PayrollMode = "PAYROLL"
    # 과세 지급
    base_salary: Decimal = Decimal("0")
    position_allowance: Decimal = Decimal("0")
    overtime_pay: Decimal = Decimal("0")
    holiday_pay: Decimal = Decimal("0")
    annual_leave_pay: Decimal = Decimal("0")
    family_allowance: Decimal = Decimal("0")
    bonus: Decimal = Decimal("0")
    holiday_bonus: Decimal = Decimal("0")
    other_taxable: Decimal = Decimal("0")
    # 비과세 지급
    meal_allowance: Decimal = Decimal("0")
    car_allowance: Decimal = Decimal("0")
    childcare_allowance: Decimal = Decimal("0")
    research_allowance: Decimal = Decimal("0")
    expense_reimbursement: Decimal = Decimal("0")
    tuition: Decimal = Decimal("0")
    other_nontax: Decimal = Decimal("0")
    # 공제
    pension: Decimal = Decimal("0")
    health: Decimal = Decimal("0")
    long_term_care: Decimal = Decimal("0")
    employment_insurance: Decimal = Decimal("0")
    income_tax: Decimal = Decimal("0")
    local_tax: Decimal = Decimal("0")
    year_end_income_tax: Decimal = Decimal("0")
    year_end_local_tax: Decimal = Decimal("0")
    other_deduction: Decimal = Decimal("0")
    # 프리랜서
    freelancer_gross: Decimal = Decimal("0")
    memo: str | None = None


class PayrollItemUpdate(PayrollItemBase):
    pass


class PayrollItemOut(PayrollItemBase):
    id: UUID
    run_id: UUID
    developer_id: UUID
    # 스냅샷 합계 (서버 계산)
    gross_taxable: Decimal = Decimal("0")
    gross_nontax: Decimal = Decimal("0")
    total_deduction: Decimal = Decimal("0")
    net_pay: Decimal = Decimal("0")
    # 화면 표시용 파생값
    developer_name: str | None = None
    developer_employment_type: str | None = None
    developer_email: str | None = None
    # 급여명세서 PDF 비밀번호 — 주민등록번호 앞 6자리 (생년월일).
    # 등록된 주민등록번호가 없거나 형식이 잘못된 경우 None.
    pdf_password: str | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# DeveloperTaxProfile
# ---------------------------------------------------------------------------


class DeveloperTaxProfileUpdate(BaseModel):
    dependents_count: int | None = None
    elderly_dependents_count: int | None = None
    child_dependents_count: int | None = None
    tax_reduction_rate: int | None = None


class DeveloperTaxProfileOut(BaseModel):
    developer_id: UUID
    dependents_count: int = 1
    elderly_dependents_count: int = 0
    child_dependents_count: int = 0
    tax_reduction_rate: int = 100

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# WithholdingTaxTable / Row
# ---------------------------------------------------------------------------


class WithholdingTaxRowOut(BaseModel):
    id: UUID
    bracket_min: Decimal
    bracket_max: Decimal
    dependents: int
    tax_80: Decimal
    tax_100: Decimal
    tax_120: Decimal

    class Config:
        from_attributes = True


class WithholdingTaxTableOut(BaseModel):
    id: UUID
    effective_from: date
    source_filename: str | None = None
    note: str | None = None
    row_count: int = 0

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# PayrollDistribution
# ---------------------------------------------------------------------------


class PayrollDistributionOut(BaseModel):
    id: UUID
    run_id: UUID
    developer_id: UUID
    method: str
    to_email: str | None = None
    pdf_size_bytes: int | None = None
    status: str
    error_msg: str | None = None
    delivered_at: date | None = None
    delivered_by: UUID | None = None
    # 파생
    developer_name: str | None = None

    class Config:
        from_attributes = True
