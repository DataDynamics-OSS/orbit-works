from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DeveloperSalary, HrInsuranceRate


async def get_salary_at(
    db: AsyncSession, developer_id: UUID, at: date
) -> DeveloperSalary | None:
    from sqlalchemy import or_

    stmt = (
        select(DeveloperSalary)
        .where(
            DeveloperSalary.developer_id == developer_id,
            DeveloperSalary.effective_from <= at,
            or_(
                DeveloperSalary.effective_to.is_(None),
                DeveloperSalary.effective_to >= at,
            ),
        )
        .order_by(DeveloperSalary.effective_from.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_rate_at(db: AsyncSession, at: date) -> HrInsuranceRate | None:
    stmt = (
        select(HrInsuranceRate)
        .where(HrInsuranceRate.effective_from <= at)
        .order_by(HrInsuranceRate.effective_from.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


def _breakdown(
    annual_salary: Decimal, rate: HrInsuranceRate
) -> tuple[Decimal, Decimal, Decimal, Decimal, Decimal, Decimal]:
    """Return (monthly, pension, health, long_term_care, unemployment, stability, industrial).

    These are the common components; the split between employee and employer
    decides which get summed.
    """
    zero = Decimal("0")
    monthly = (annual_salary or zero) / Decimal(12)
    np_base = min(monthly, Decimal(rate.national_pension_ceiling))
    pension = (np_base * rate.national_pension_rate).quantize(Decimal("0.01"))
    health = (monthly * rate.health_rate).quantize(Decimal("0.01"))
    care = (health * rate.long_term_care_rate_on_health).quantize(Decimal("0.01"))
    unemployment = (monthly * rate.employment_unemployment_rate).quantize(Decimal("0.01"))
    stability = (monthly * rate.employment_stability_rate).quantize(Decimal("0.01"))
    industrial = (monthly * rate.industrial_accident_rate).quantize(Decimal("0.01"))
    return monthly.quantize(Decimal("0.01")), pension, health, care, unemployment, stability, industrial


def calculate_employer_insurance(
    annual_salary: Decimal, rate: HrInsuranceRate
) -> dict[str, Decimal]:
    monthly, pension, health, care, unemployment, stability, industrial = _breakdown(
        annual_salary, rate
    )
    total = pension + health + care + unemployment + stability + industrial
    return {
        "monthly_compensation": monthly,
        "national_pension": pension,
        "health": health,
        "long_term_care": care,
        "employment": unemployment + stability,
        "industrial_accident": industrial,
        "insurance_total": total,
    }


def calculate_employee_insurance(
    annual_salary: Decimal, rate: HrInsuranceRate
) -> dict[str, Decimal]:
    """Employee side: 연금 + 건강 + 장기요양 + 실업급여. 산재/고용안정은 없음."""
    monthly, pension, health, care, unemployment, _stability, _industrial = _breakdown(
        annual_salary, rate
    )
    total = pension + health + care + unemployment
    return {
        "monthly_compensation": monthly,
        "national_pension": pension,
        "health": health,
        "long_term_care": care,
        "employment": unemployment,
        "industrial_accident": Decimal("0"),
        "insurance_total": total,
    }
