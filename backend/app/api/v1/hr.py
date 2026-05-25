import logging
from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin, require_feature
from app.core.database import get_db
from app.models import (
    Developer,
    DeveloperResearchGrant,
    DeveloperSalary,
    HrInsuranceRate,
    User,
)
from app.schemas.hr import (
    CostContext,
    DeveloperSalaryCreate,
    DeveloperSalaryOut,
    DeveloperSalaryUpdate,
    HrInsuranceRateCreate,
    HrInsuranceRateOut,
    HrInsuranceRateUpdate,
)
from app.schemas.research_grant import (
    ResearchGrantCreate,
    ResearchGrantOut,
    ResearchGrantUpdate,
)
from app.services.hr import (
    calculate_employee_insurance,
    calculate_employer_insurance,
    get_rate_at,
    get_salary_at,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["hr"])


# ---------------------------------------------------------------------------
# Salary history (nested under /developers/{id})
# ---------------------------------------------------------------------------


@router.get(
    "/developers/{developer_id}/salaries",
    response_model=list[DeveloperSalaryOut],
)
async def list_salaries(
    developer_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_feature("employees.salary.view")),
):
    stmt = (
        select(DeveloperSalary)
        .where(DeveloperSalary.developer_id == developer_id)
        .order_by(DeveloperSalary.effective_from.desc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def _compute_estimated_totals(
    db: AsyncSession, annual_salary: Decimal, when: date
) -> tuple[Decimal | None, Decimal | None]:
    rate = await get_rate_at(db, when)
    if not rate:
        return None, None
    employer = calculate_employer_insurance(annual_salary, rate)["insurance_total"]
    employee = calculate_employee_insurance(annual_salary, rate)["insurance_total"]
    return employee, employer


@router.post(
    "/developers/{developer_id}/salaries",
    response_model=DeveloperSalaryOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_salary(
    developer_id: UUID,
    payload: DeveloperSalaryCreate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_feature("employees.salary.edit")),
):
    dev = (
        await db.execute(select(Developer).where(Developer.id == developer_id))
    ).scalar_one_or_none()
    if dev and dev.employment_type == "FREELANCER":
        # Freelancer: 입력값 그대로 저장하고 4대보험 추정은 생략한다.
        employee_est, employer_est = None, None
    else:
        employee_est, employer_est = await _compute_estimated_totals(
            db, payload.annual_salary, payload.effective_from
        )
    row = DeveloperSalary(
        developer_id=developer_id,
        annual_salary=payload.annual_salary,
        effective_from=payload.effective_from,
        effective_to=payload.effective_to,
        note=payload.note,
        estimated_employee_insurance_monthly=employee_est,
        estimated_employer_insurance_monthly=employer_est,
        actual_employee_insurance_monthly=payload.actual_employee_insurance_monthly,
        actual_employer_insurance_monthly=payload.actual_employer_insurance_monthly,
        created_by=current.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "연봉 이력 등록: developer_id=%s annual=%s effective=%s~%s (등록자=%s)",
        developer_id,
        row.annual_salary,
        row.effective_from,
        row.effective_to,
        current.id,
    )
    return row


@router.patch("/developers/salaries/{salary_id}", response_model=DeveloperSalaryOut)
async def update_salary(
    salary_id: UUID,
    payload: DeveloperSalaryUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_feature("employees.salary.edit")),
):
    row = (
        await db.execute(select(DeveloperSalary).where(DeveloperSalary.id == salary_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Salary not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    # Recompute estimates when salary or effective_from changes, unless the
    # developer is a freelancer — freelancers skip 4대보험 estimation.
    if "annual_salary" in data or "effective_from" in data:
        dev = (
            await db.execute(
                select(Developer).where(Developer.id == row.developer_id)
            )
        ).scalar_one_or_none()
        if dev and dev.employment_type == "FREELANCER":
            row.estimated_employee_insurance_monthly = None
            row.estimated_employer_insurance_monthly = None
        else:
            employee_est, employer_est = await _compute_estimated_totals(
                db, row.annual_salary, row.effective_from
            )
            row.estimated_employee_insurance_monthly = employee_est
            row.estimated_employer_insurance_monthly = employer_est
    await db.commit()
    await db.refresh(row)
    logger.info(
        "연봉 이력 수정: id=%s dev=%s 변경필드=%s (수정자=%s)",
        row.id,
        row.developer_id,
        list(data.keys()),
        current.id,
    )
    return row


@router.delete(
    "/developers/salaries/{salary_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_salary(
    salary_id: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_feature("employees.salary.edit")),
):
    row = (
        await db.execute(select(DeveloperSalary).where(DeveloperSalary.id == salary_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Salary not found")
    logger.warning(
        "연봉 이력 삭제: id=%s dev=%s annual=%s (삭제자=%s)",
        row.id,
        row.developer_id,
        row.annual_salary,
        current.id,
    )
    await db.delete(row)
    await db.commit()


# ---------------------------------------------------------------------------
# Insurance rates
# ---------------------------------------------------------------------------


@router.get("/hr/insurance-rates", response_model=list[HrInsuranceRateOut])
async def list_rates(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(HrInsuranceRate).order_by(HrInsuranceRate.effective_from.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/hr/insurance-rates/current", response_model=HrInsuranceRateOut)
async def current_rate(
    at: date | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    when = at or date.today()
    rate = await get_rate_at(db, when)
    if not rate:
        raise HTTPException(status_code=404, detail="No rate configured")
    return rate


@router.post(
    "/hr/insurance-rates",
    response_model=HrInsuranceRateOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_rate(
    payload: HrInsuranceRateCreate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    row = HrInsuranceRate(**payload.model_dump(), updated_by=current.id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.patch("/hr/insurance-rates/{rate_id}", response_model=HrInsuranceRateOut)
async def update_rate(
    rate_id: UUID,
    payload: HrInsuranceRateUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    row = (
        await db.execute(select(HrInsuranceRate).where(HrInsuranceRate.id == rate_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Rate not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    row.updated_by = current.id
    await db.commit()
    await db.refresh(row)
    return row


@router.delete(
    "/hr/insurance-rates/{rate_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_rate(
    rate_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = (
        await db.execute(select(HrInsuranceRate).where(HrInsuranceRate.id == rate_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Rate not found")
    await db.delete(row)
    await db.commit()


# ---------------------------------------------------------------------------
# Cost context
# ---------------------------------------------------------------------------


@router.get("/developers/{developer_id}/cost-context", response_model=CostContext)
async def cost_context(
    developer_id: UUID,
    at: date | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    when = at or date.today()
    salary = await get_salary_at(db, developer_id, when)
    rate = await get_rate_at(db, when)

    annual = salary.annual_salary if salary else Decimal("0")
    if not rate:
        # No rate configured — return zero breakdown
        return CostContext(
            at=when,
            annual_salary=salary.annual_salary if salary else None,
            monthly_compensation=annual / Decimal(12),
            national_pension=Decimal("0"),
            health=Decimal("0"),
            long_term_care=Decimal("0"),
            employment=Decimal("0"),
            industrial_accident=Decimal("0"),
            insurance_total=Decimal("0"),
            salary_effective_from=salary.effective_from if salary else None,
            rate_effective_from=None,
        )

    breakdown = calculate_employer_insurance(annual, rate)
    return CostContext(
        at=when,
        annual_salary=salary.annual_salary if salary else None,
        monthly_compensation=breakdown["monthly_compensation"],
        national_pension=breakdown["national_pension"],
        health=breakdown["health"],
        long_term_care=breakdown["long_term_care"],
        employment=breakdown["employment"],
        industrial_accident=breakdown["industrial_accident"],
        insurance_total=breakdown["insurance_total"],
        salary_effective_from=salary.effective_from if salary else None,
        rate_effective_from=rate.effective_from,
    )


# ---------------------------------------------------------------------------
# 정부 연구과제 지원 (Research grants)
# ---------------------------------------------------------------------------


@router.get(
    "/developers/{developer_id}/research-grants",
    response_model=list[ResearchGrantOut],
)
async def list_research_grants(
    developer_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(DeveloperResearchGrant)
        .where(DeveloperResearchGrant.developer_id == developer_id)
        .order_by(DeveloperResearchGrant.start_date.desc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.post(
    "/developers/{developer_id}/research-grants",
    response_model=ResearchGrantOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_research_grant(
    developer_id: UUID,
    payload: ResearchGrantCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = DeveloperResearchGrant(developer_id=developer_id, **payload.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.patch(
    "/developers/research-grants/{grant_id}", response_model=ResearchGrantOut
)
async def update_research_grant(
    grant_id: UUID,
    payload: ResearchGrantUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = (
        await db.execute(
            select(DeveloperResearchGrant).where(DeveloperResearchGrant.id == grant_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Grant not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete(
    "/developers/research-grants/{grant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_research_grant(
    grant_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = (
        await db.execute(
            select(DeveloperResearchGrant).where(DeveloperResearchGrant.id == grant_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Grant not found")
    await db.delete(row)
    await db.commit()
