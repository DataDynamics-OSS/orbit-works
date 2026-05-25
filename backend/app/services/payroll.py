"""Payroll 계산 헬퍼."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DeveloperTaxProfile,
    HrInsuranceRate,
    PayrollItem,
    WithholdingTaxRow,
    WithholdingTaxTable,
)

_Q2 = Decimal("0.01")
_ZERO = Decimal("0")
_HUN = Decimal("100")


def _q(v: Decimal) -> Decimal:
    return v.quantize(_Q2)


def taxable_sum(it: PayrollItem | dict) -> Decimal:
    """과세 지급 합 (근로자 4대보험 산정 기준)."""
    g = (
        lambda k: Decimal(it.get(k) or 0)
        if isinstance(it, dict)
        else Decimal(getattr(it, k) or 0)
    )
    return (
        g("base_salary")
        + g("position_allowance")
        + g("overtime_pay")
        + g("holiday_pay")
        + g("annual_leave_pay")
        + g("family_allowance")
        + g("bonus")
        + g("holiday_bonus")
        + g("other_taxable")
    )


def nontax_sum(it: PayrollItem | dict) -> Decimal:
    g = (
        lambda k: Decimal(it.get(k) or 0)
        if isinstance(it, dict)
        else Decimal(getattr(it, k) or 0)
    )
    return (
        g("meal_allowance")
        + g("car_allowance")
        + g("childcare_allowance")
        + g("research_allowance")
        + g("expense_reimbursement")
        + g("tuition")
        + g("other_nontax")
    )


def deduction_sum(it: PayrollItem | dict) -> Decimal:
    g = (
        lambda k: Decimal(it.get(k) or 0)
        if isinstance(it, dict)
        else Decimal(getattr(it, k) or 0)
    )
    return (
        g("pension")
        + g("health")
        + g("long_term_care")
        + g("employment_insurance")
        + g("income_tax")
        + g("local_tax")
        + g("year_end_income_tax")
        + g("year_end_local_tax")
        + g("other_deduction")
    )


async def apply_insurance(
    db: AsyncSession, taxable: Decimal
) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """과세소득 → (국민연금, 건강보험, 장기요양, 고용보험) 근로자 부담분.

    최신 `hr_insurance_rates` 1건을 조회해 사용. 국민연금은 상한 적용.
    """
    rate = (
        await db.execute(
            select(HrInsuranceRate).order_by(HrInsuranceRate.effective_from.desc())
        )
    ).scalars().first()
    if not rate:
        return _ZERO, _ZERO, _ZERO, _ZERO
    # 국민연금: 상한액까지만 부과.
    pension_base = min(taxable, Decimal(rate.national_pension_ceiling))
    if rate.national_pension_floor is not None:
        pension_base = max(pension_base, Decimal(rate.national_pension_floor))
    pension = _q(pension_base * Decimal(rate.national_pension_rate))
    health = _q(taxable * Decimal(rate.health_rate))
    ltc = _q(health * Decimal(rate.long_term_care_rate_on_health))
    emp = _q(taxable * Decimal(rate.employment_unemployment_rate))
    return pension, health, ltc, emp


async def apply_income_tax(
    db: AsyncSession,
    *,
    taxable: Decimal,
    profile: DeveloperTaxProfile | None,
    pay_date: date | None,
) -> tuple[Decimal, Decimal]:
    """과세소득 → (근로소득세, 지방소득세).

    pay_date 기준으로 적용 가능한 최신 간이세액표를 찾아 dependents + rate 로 룩업.
    세액표가 없으면 (0, 0) 반환.
    """
    target = pay_date or date.today()
    table = (
        await db.execute(
            select(WithholdingTaxTable)
            .where(WithholdingTaxTable.effective_from <= target)
            .order_by(WithholdingTaxTable.effective_from.desc())
            .limit(1)
        )
    ).scalars().first()
    if not table:
        return _ZERO, _ZERO

    deps = (profile.dependents_count if profile else 1) or 1
    rate_choice = (profile.tax_reduction_rate if profile else 100) or 100
    # 부양가족 수가 세액표의 최대값을 넘어가면 최대값으로 clamp.
    rows = list(
        (
            await db.execute(
                select(WithholdingTaxRow).where(
                    WithholdingTaxRow.table_id == table.id
                )
            )
        ).scalars()
    )
    if not rows:
        return _ZERO, _ZERO
    max_deps = max(r.dependents for r in rows)
    deps = min(deps, max_deps)

    # 구간 매칭 — [bracket_min, bracket_max) 중 taxable 포함.
    row = next(
        (
            r
            for r in rows
            if r.dependents == deps
            and r.bracket_min <= taxable < r.bracket_max
        ),
        None,
    )
    if row is None:
        # 최상위 구간에 걸린 경우 마지막 row 사용.
        row = max(
            (r for r in rows if r.dependents == deps),
            key=lambda r: r.bracket_min,
            default=None,
        )
    if row is None:
        return _ZERO, _ZERO

    income_tax: Decimal
    if rate_choice == 80:
        income_tax = row.tax_80
    elif rate_choice == 120:
        income_tax = row.tax_120
    else:
        income_tax = row.tax_100
    income_tax = _q(Decimal(income_tax))
    local_tax = _q(income_tax / Decimal(10))  # 지방소득세 10%
    return income_tax, local_tax


def withholding_simple(gross: Decimal) -> tuple[Decimal, Decimal]:
    """프리랜서 3.3% 원천징수. (income_tax 3%, local_tax 0.3%)."""
    g = Decimal(gross or 0)
    income = _q(g * Decimal("0.03"))
    local = _q(g * Decimal("0.003"))
    return income, local


def recompute_totals(item: PayrollItem) -> None:
    """item 의 gross_*, total_deduction, net_pay 를 필드로부터 재계산해 저장."""
    if item.mode == "WITHHOLDING":
        # 프리랜서: freelancer_gross - (income_tax + local_tax + other)
        gross_tax = Decimal(item.freelancer_gross or 0)
        nontax = _ZERO
        ded = (
            Decimal(item.income_tax or 0)
            + Decimal(item.local_tax or 0)
            + Decimal(item.other_deduction or 0)
        )
        net = gross_tax - ded
    else:
        gross_tax = taxable_sum(item)
        nontax = nontax_sum(item)
        ded = deduction_sum(item)
        net = gross_tax + nontax - ded
    item.gross_taxable = _q(gross_tax)
    item.gross_nontax = _q(nontax)
    item.total_deduction = _q(ded)
    item.net_pay = _q(net)
