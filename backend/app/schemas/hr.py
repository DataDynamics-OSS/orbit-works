from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, model_validator


CompanySizeTier = Literal["UNDER_150", "150_TO_1000", "OVER_1000"]


# ---------------------------------------------------------------------------
# Developer salary history
# ---------------------------------------------------------------------------


class DeveloperSalaryBase(BaseModel):
    annual_salary: Decimal
    effective_from: date
    effective_to: date | None = None
    note: str | None = None

    @model_validator(mode="after")
    def _check_range(self) -> "DeveloperSalaryBase":
        if self.effective_to is not None and self.effective_to <= self.effective_from:
            raise ValueError("종료일은 시작일보다 뒤여야 합니다.")
        return self


class DeveloperSalaryCreate(DeveloperSalaryBase):
    # Admin may optionally supply actual amounts up-front; estimates are
    # computed server-side.
    actual_employee_insurance_monthly: Decimal | None = None
    actual_employer_insurance_monthly: Decimal | None = None


class DeveloperSalaryUpdate(BaseModel):
    annual_salary: Decimal | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    note: str | None = None
    # Estimated values are regenerated when annual_salary or effective_from
    # changes, so admins normally edit only the actual fields.
    actual_employee_insurance_monthly: Decimal | None = None
    actual_employer_insurance_monthly: Decimal | None = None


class DeveloperSalaryOut(DeveloperSalaryBase):
    id: UUID
    developer_id: UUID
    created_at: datetime
    estimated_employee_insurance_monthly: Decimal | None = None
    estimated_employer_insurance_monthly: Decimal | None = None
    actual_employee_insurance_monthly: Decimal | None = None
    actual_employer_insurance_monthly: Decimal | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# HR insurance rates
# ---------------------------------------------------------------------------


class HrInsuranceRateBase(BaseModel):
    effective_from: date
    year: int
    national_pension_rate: Decimal
    national_pension_ceiling: int
    national_pension_floor: int | None = None
    health_rate: Decimal
    long_term_care_rate_on_health: Decimal
    employment_unemployment_rate: Decimal
    employment_stability_rate: Decimal
    industrial_accident_rate: Decimal
    company_size_tier: CompanySizeTier | None = None
    industry_note: str | None = None


class HrInsuranceRateCreate(HrInsuranceRateBase):
    pass


class HrInsuranceRateUpdate(BaseModel):
    effective_from: date | None = None
    year: int | None = None
    national_pension_rate: Decimal | None = None
    national_pension_ceiling: int | None = None
    national_pension_floor: int | None = None
    health_rate: Decimal | None = None
    long_term_care_rate_on_health: Decimal | None = None
    employment_unemployment_rate: Decimal | None = None
    employment_stability_rate: Decimal | None = None
    industrial_accident_rate: Decimal | None = None
    company_size_tier: CompanySizeTier | None = None
    industry_note: str | None = None


class HrInsuranceRateOut(HrInsuranceRateBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Cost context (composed calculation)
# ---------------------------------------------------------------------------


class CostContext(BaseModel):
    at: date
    annual_salary: Decimal | None
    monthly_compensation: Decimal
    national_pension: Decimal
    health: Decimal
    long_term_care: Decimal
    employment: Decimal
    industrial_accident: Decimal
    insurance_total: Decimal
    salary_effective_from: date | None
    rate_effective_from: date | None
