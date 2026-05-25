"""Payroll (급여) API.

Endpoints:
- GET  /payroll/runs                         목록
- POST /payroll/runs                         회차 생성 (+자동 prefill)
- GET  /payroll/runs/{rid}                   회차 상세 (items 포함)
- PATCH /payroll/runs/{rid}                  회차 헤더 수정
- DELETE /payroll/runs/{rid}                 회차 삭제 (DRAFT 만)
- POST /payroll/runs/{rid}/finalize          FINAL 전환
- POST /payroll/runs/{rid}/unfinalize        DRAFT 복귀
- POST /payroll/runs/{rid}/mark-paid         PAID 마킹
- POST /payroll/runs/{rid}/recompute         4대보험 + 소득세 자동 재계산

- PATCH /payroll/items/{iid}                 item 수정
- PATCH /payroll/items/{iid}/recompute       해당 item 만 자동 재계산

- GET   /payroll/tax-profile/{dev_id}        직원 세액 프로파일 조회
- PATCH /payroll/tax-profile/{dev_id}        직원 세액 프로파일 저장

- GET   /payroll/tax-tables                  세액표 업로드 목록
- POST  /payroll/tax-tables                  세액표 엑셀 업로드
- GET   /payroll/tax-tables/{tid}/rows       세액표 row 덤프 (미리보기)
- DELETE /payroll/tax-tables/{tid}

- GET   /payroll/runs/{rid}/distributions    회차의 배포 이력
- POST  /payroll/runs/{rid}/distribute/{dev_id}   개별 명세서 메일 발송
- POST  /payroll/runs/{rid}/distribute-all        전체 메일 발송
"""

from __future__ import annotations

import io
import logging
from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Developer,
    DeveloperSalary,
    DeveloperTaxProfile,
    PayrollDistribution,
    PayrollItem,
    PayrollRun,
    User,
    WithholdingTaxRow,
    WithholdingTaxTable,
)
from app.schemas.payroll import (
    DeveloperTaxProfileOut,
    DeveloperTaxProfileUpdate,
    PayrollDistributionOut,
    PayrollItemOut,
    PayrollItemUpdate,
    PayrollRunCreate,
    PayrollRunOut,
    PayrollRunUpdate,
    WithholdingTaxRowOut,
    WithholdingTaxTableOut,
)
from app.services.payroll import (
    apply_income_tax,
    apply_insurance,
    recompute_totals,
    withholding_simple,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payroll", tags=["payroll"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _item_out(db: AsyncSession, item: PayrollItem) -> PayrollItemOut:
    out = PayrollItemOut.model_validate(item, from_attributes=True)
    # 화면 표시용 직원 정보.
    dev = (
        await db.execute(select(Developer).where(Developer.id == item.developer_id))
    ).scalar_one_or_none()
    if dev:
        out.developer_name = dev.name
        out.developer_employment_type = dev.employment_type
        out.developer_email = dev.personal_email or dev.company_email
        front = (dev.resident_number or "")[:6]
        out.pdf_password = front if len(front) == 6 and front.isdigit() else None
    return out


def _run_with_totals(run: PayrollRun) -> PayrollRunOut:
    out = PayrollRunOut.model_validate(run, from_attributes=True)
    items = list(run.items) if run.items else []
    out.item_count = len(items)
    out.total_gross_taxable = sum((Decimal(i.gross_taxable or 0) for i in items), Decimal(0))
    out.total_gross_nontax = sum((Decimal(i.gross_nontax or 0) for i in items), Decimal(0))
    out.total_deduction = sum((Decimal(i.total_deduction or 0) for i in items), Decimal(0))
    out.total_net_pay = sum((Decimal(i.net_pay or 0) for i in items), Decimal(0))
    return out


async def _latest_monthly_salary(db: AsyncSession, dev_id: UUID) -> Decimal:
    """최신 연봉 이력에서 월급 = annual / 12 계산."""
    sal = (
        await db.execute(
            select(DeveloperSalary)
            .where(DeveloperSalary.developer_id == dev_id)
            .order_by(DeveloperSalary.effective_from.desc())
            .limit(1)
        )
    ).scalars().first()
    if not sal:
        return Decimal("0")
    return (Decimal(sal.annual_salary) / Decimal(12)).quantize(Decimal("1"))


async def _build_prefilled_item(
    db: AsyncSession, dev: Developer, run_id: UUID
) -> PayrollItem:
    """활성 직원 한 명에 대해 prefill 된 PayrollItem 생성.

    - 정규직/자사화 → mode=PAYROLL, base_salary=최신 월급, 식대 20만
    - 프리랜서      → mode=WITHHOLDING, freelancer_gross=최신 월급
    회차 생성(create_run) 및 개별 추가(add_items) 두 경로에서 공통 사용.
    """
    monthly = await _latest_monthly_salary(db, dev.id)
    is_freelance = (dev.employment_type or "").upper() == "FREELANCER"
    item = PayrollItem(
        run_id=run_id,
        developer_id=dev.id,
        mode="WITHHOLDING" if is_freelance else "PAYROLL",
    )
    if is_freelance:
        item.freelancer_gross = monthly
    else:
        item.base_salary = monthly
        item.meal_allowance = Decimal("200000")
    recompute_totals(item)
    return item


# ---------------------------------------------------------------------------
# 본인 급여 조회 (모바일 "내 급여명세서" 전용)
# ---------------------------------------------------------------------------


async def _find_my_developer(
    db: AsyncSession, user: User
) -> Developer | None:
    """로그인한 User 의 이메일로 Developer 를 매칭. 링크 테이블이 없으므로
    personal_email / company_email 중 하나라도 일치하면 본인으로 본다.
    """
    if not user.email:
        return None
    stmt = select(Developer).where(
        (Developer.personal_email == user.email)
        | (Developer.company_email == user.email)
    )
    return (await db.execute(stmt)).scalars().first()


@router.get("/me/items", response_model=list[PayrollItemOut])
async def list_my_items(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """현재 로그인 사용자 본인의 급여명세서 목록 (최신 월 먼저).

    DRAFT 회차는 제외 — 확정(FINAL) 또는 지급완료(PAID) 만 조회 가능.
    """
    dev = await _find_my_developer(db, user)
    if dev is None:
        return []
    stmt = (
        select(PayrollItem, PayrollRun)
        .join(PayrollRun, PayrollItem.run_id == PayrollRun.id)
        .where(PayrollItem.developer_id == dev.id)
        .where(PayrollRun.status.in_(["FINAL", "PAID"]))
        .order_by(PayrollRun.year.desc(), PayrollRun.month.desc())
    )
    if year is not None:
        stmt = stmt.where(PayrollRun.year == year)
    rows = (await db.execute(stmt)).all()
    out: list[PayrollItemOut] = []
    for item, _run in rows:
        out.append(await _item_out(db, item))
    return out


# ---------------------------------------------------------------------------
# PayrollRun CRUD
# ---------------------------------------------------------------------------


@router.get("/runs", response_model=list[PayrollRunOut])
async def list_runs(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(PayrollRun)
        .options(selectinload(PayrollRun.items))
        .order_by(PayrollRun.year.desc(), PayrollRun.month.desc())
    )
    if year is not None:
        stmt = stmt.where(PayrollRun.year == year)
    rows = list((await db.execute(stmt)).scalars())
    return [_run_with_totals(r) for r in rows]


@router.post(
    "/runs",
    response_model=PayrollRunOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_run(
    payload: PayrollRunCreate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """새 회차 생성. 활성 직원 자동 prefill.

    - 정규직/자사화 → mode=PAYROLL, base_salary = 최신 월급, 식대 20만 기본
    - 프리랜서 → mode=WITHHOLDING, freelancer_gross = 최신 월급
    """
    run = PayrollRun(
        year=payload.year,
        month=payload.month,
        pay_date=payload.pay_date,
        is_year_end_adjustment=payload.is_year_end_adjustment,
        memo=payload.memo,
        created_by=current.id,
    )
    db.add(run)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"{payload.year}년 {payload.month}월 회차가 이미 존재합니다.",
        )

    # 활성 직원 prefill.
    devs = list(
        (
            await db.execute(
                select(Developer).where(Developer.status == "ACTIVE")
            )
        ).scalars()
    )
    for d in devs:
        if d.resigned_date and d.resigned_date <= date(run.year, run.month, 1):
            continue
        db.add(await _build_prefilled_item(db, d, run.id))
    await db.commit()
    await db.refresh(run, attribute_names=["items"])
    logger.info(
        "급여 회차 생성: %s-%s (직원=%s, 생성자=%s)",
        run.year,
        run.month,
        len(devs),
        current.id,
    )
    return _run_with_totals(run)


@router.get("/runs/{rid}", response_model=PayrollRunOut)
async def get_run(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_with_totals(run)


@router.get("/runs/{rid}/items", response_model=list[PayrollItemOut])
async def list_items(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    items = list(
        (
            await db.execute(
                select(PayrollItem)
                .where(PayrollItem.run_id == rid)
                .order_by(PayrollItem.created_at)
            )
        ).scalars()
    )
    return [await _item_out(db, i) for i in items]


# ---------------------------------------------------------------------------
# 회차 내 직원 추가/삭제
# ---------------------------------------------------------------------------


class AvailableDeveloperOut(BaseModel):
    id: UUID
    name: str
    employment_type: str
    email: str | None = None
    monthly_salary: Decimal = Decimal("0")


class AddItemsPayload(BaseModel):
    developer_ids: list[UUID]


class DeleteItemsPayload(BaseModel):
    item_ids: list[UUID]


@router.get(
    "/runs/{rid}/available-developers",
    response_model=list[AvailableDeveloperOut],
)
async def list_available_developers(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """활성 직원 중 현재 회차에 아직 포함되지 않은 인원."""
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    existing = {i.developer_id for i in (run.items or [])}
    devs = list(
        (
            await db.execute(
                select(Developer)
                .where(Developer.status == "ACTIVE")
                .order_by(Developer.name)
            )
        ).scalars()
    )
    month_cutoff = date(run.year, run.month, 1)
    out: list[AvailableDeveloperOut] = []
    for d in devs:
        if d.id in existing:
            continue
        if d.resigned_date and d.resigned_date <= month_cutoff:
            continue
        out.append(
            AvailableDeveloperOut(
                id=d.id,
                name=d.name,
                employment_type=d.employment_type,
                email=d.personal_email or d.company_email,
                monthly_salary=await _latest_monthly_salary(db, d.id),
            )
        )
    return out


@router.post(
    "/runs/{rid}/items",
    response_model=list[PayrollItemOut],
    status_code=status.HTTP_201_CREATED,
)
async def add_items(
    rid: UUID,
    payload: AddItemsPayload,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """선택한 직원들을 회차에 추가. DRAFT 상태에서만 허용."""
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "DRAFT":
        raise HTTPException(
            status_code=400, detail="DRAFT 상태의 회차에만 추가할 수 있습니다."
        )

    existing = {i.developer_id for i in (run.items or [])}
    added: list[PayrollItem] = []
    for dev_id in payload.developer_ids:
        if dev_id in existing:
            continue
        dev = (
            await db.execute(select(Developer).where(Developer.id == dev_id))
        ).scalar_one_or_none()
        if not dev:
            continue
        item = await _build_prefilled_item(db, dev, run.id)
        db.add(item)
        added.append(item)
    await db.commit()
    for item in added:
        await db.refresh(item)
    logger.info(
        "급여 회차 직원 추가: run=%s count=%s (요청자=%s)",
        rid,
        len(added),
        current.id,
    )
    return [await _item_out(db, i) for i in added]


@router.delete(
    "/runs/{rid}/items",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_items(
    rid: UUID,
    payload: DeleteItemsPayload,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """회차에서 선택된 items 를 일괄 삭제. DRAFT 에서만."""
    run = (
        await db.execute(select(PayrollRun).where(PayrollRun.id == rid))
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "DRAFT":
        raise HTTPException(
            status_code=400, detail="DRAFT 상태의 회차에서만 삭제할 수 있습니다."
        )
    if not payload.item_ids:
        return

    items = list(
        (
            await db.execute(
                select(PayrollItem).where(
                    PayrollItem.run_id == rid,
                    PayrollItem.id.in_(payload.item_ids),
                )
            )
        ).scalars()
    )
    for it in items:
        await db.delete(it)
    await db.commit()
    logger.info(
        "급여 회차 직원 삭제: run=%s count=%s (요청자=%s)",
        rid,
        len(items),
        current.id,
    )


# 이전 달 회차의 지급/공제 값을 이번 회차로 복사.
_COPY_FIELDS = (
    "mode",
    "base_salary",
    "position_allowance",
    "overtime_pay",
    "holiday_pay",
    "annual_leave_pay",
    "family_allowance",
    "bonus",
    "holiday_bonus",
    "other_taxable",
    "meal_allowance",
    "car_allowance",
    "childcare_allowance",
    "research_allowance",
    "expense_reimbursement",
    "tuition",
    "other_nontax",
    "pension",
    "health",
    "long_term_care",
    "employment_insurance",
    "income_tax",
    "local_tax",
    "year_end_income_tax",
    "year_end_local_tax",
    "other_deduction",
    "freelancer_gross",
    "memo",
)


@router.post(
    "/runs/{rid}/copy-from-previous",
    response_model=list[PayrollItemOut],
)
async def copy_from_previous_month(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """이전 달 회차의 지급/공제 값을 현재 회차 items 에 복사.

    - 현재 회차가 DRAFT 인 경우에만 허용.
    - 이전 달(1월이면 전년 12월) 회차가 없으면 404.
    - 이전 회차에 있던 직원만 복사되고, 없는 직원은 그대로 둠 (사용자는 수동 편집 또는 + 추가 로 처리).
    """
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "DRAFT":
        raise HTTPException(
            status_code=400,
            detail="DRAFT 상태의 회차에만 가져올 수 있습니다.",
        )

    if run.month == 1:
        prev_year, prev_month = run.year - 1, 12
    else:
        prev_year, prev_month = run.year, run.month - 1

    prev_run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(
                PayrollRun.year == prev_year,
                PayrollRun.month == prev_month,
            )
        )
    ).scalar_one_or_none()
    if not prev_run:
        raise HTTPException(
            status_code=404,
            detail=f"{prev_year}년 {prev_month}월 회차가 존재하지 않습니다.",
        )

    prev_map = {i.developer_id: i for i in (prev_run.items or [])}
    current_items = list(
        (
            await db.execute(
                select(PayrollItem).where(PayrollItem.run_id == rid)
            )
        ).scalars()
    )

    copied = 0
    for it in current_items:
        src = prev_map.get(it.developer_id)
        if not src:
            continue
        for f in _COPY_FIELDS:
            setattr(it, f, getattr(src, f))
        recompute_totals(it)
        copied += 1

    await db.commit()
    logger.info(
        "급여 회차 이전달 복사: run=%s <- %s-%s copied=%s (요청자=%s)",
        rid,
        prev_year,
        prev_month,
        copied,
        current.id,
    )
    return [await _item_out(db, i) for i in current_items]


@router.patch("/runs/{rid}", response_model=PayrollRunOut)
async def update_run(
    rid: UUID,
    payload: PayrollRunUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(run, k, v)
    await db.commit()
    logger.info(
        "급여 회차 수정: id=%s fields=%s (수정자=%s)",
        rid,
        list(data.keys()),
        current.id,
    )
    return _run_with_totals(run)


@router.delete("/runs/{rid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    run = (
        await db.execute(select(PayrollRun).where(PayrollRun.id == rid))
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "DRAFT":
        raise HTTPException(
            status_code=400, detail="DRAFT 상태의 회차만 삭제할 수 있습니다."
        )
    await db.delete(run)
    await db.commit()
    logger.warning("급여 회차 삭제: id=%s (삭제자=%s)", rid, current.id)


@router.post("/runs/{rid}/finalize", response_model=PayrollRunOut)
async def finalize_run(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    run.status = "FINAL"
    await db.commit()
    logger.info("급여 회차 FINAL 전환: id=%s (요청자=%s)", rid, current.id)
    return _run_with_totals(run)


@router.post("/runs/{rid}/unfinalize", response_model=PayrollRunOut)
async def unfinalize_run(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    run.status = "DRAFT"
    await db.commit()
    logger.info("급여 회차 DRAFT 복귀: id=%s (요청자=%s)", rid, current.id)
    return _run_with_totals(run)


@router.post("/runs/{rid}/mark-paid", response_model=PayrollRunOut)
async def mark_paid(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "FINAL":
        raise HTTPException(
            status_code=400, detail="FINAL 상태에서만 지급 완료 마킹이 가능합니다."
        )
    run.status = "PAID"
    await db.commit()
    logger.info("급여 회차 PAID: id=%s (요청자=%s)", rid, current.id)
    return _run_with_totals(run)


@router.post("/runs/{rid}/recompute", response_model=list[PayrollItemOut])
async def recompute_run(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """회차 전체 items 에 4대보험 + 소득세 자동 재계산 적용.

    - PAYROLL mode: apply_insurance + apply_income_tax 로 덮어씀.
    - WITHHOLDING mode: withholding_simple (3%/0.3%) 로 덮어씀.
    """
    run = (
        await db.execute(
            select(PayrollRun)
            .options(selectinload(PayrollRun.items))
            .where(PayrollRun.id == rid)
        )
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != "DRAFT":
        raise HTTPException(
            status_code=400,
            detail="DRAFT 상태에서만 자동 재계산이 가능합니다.",
        )

    for item in run.items:
        await _recompute_one(db, item, pay_date=run.pay_date)
    await db.commit()
    logger.info("급여 회차 재계산: id=%s items=%s (요청자=%s)", rid, len(run.items), current.id)
    # Refresh relationship after commit.
    await db.refresh(run, attribute_names=["items"])
    return [await _item_out(db, i) for i in run.items]


async def _recompute_one(
    db: AsyncSession, item: PayrollItem, *, pay_date: date | None
) -> None:
    if item.mode == "WITHHOLDING":
        item.income_tax, item.local_tax = withholding_simple(item.freelancer_gross)
        # 4대보험/기타 자동 계산 항목은 WITHHOLDING 에서 사용하지 않음 → 0.
        item.pension = Decimal(0)
        item.health = Decimal(0)
        item.long_term_care = Decimal(0)
        item.employment_insurance = Decimal(0)
    else:
        from app.services.payroll import taxable_sum

        taxable = taxable_sum(item)
        (
            item.pension,
            item.health,
            item.long_term_care,
            item.employment_insurance,
        ) = await apply_insurance(db, taxable)
        profile = (
            await db.execute(
                select(DeveloperTaxProfile).where(
                    DeveloperTaxProfile.developer_id == item.developer_id
                )
            )
        ).scalar_one_or_none()
        item.income_tax, item.local_tax = await apply_income_tax(
            db, taxable=taxable, profile=profile, pay_date=pay_date
        )
    recompute_totals(item)


# ---------------------------------------------------------------------------
# PayrollItem
# ---------------------------------------------------------------------------


@router.patch("/items/{iid}", response_model=PayrollItemOut)
async def update_item(
    iid: UUID,
    payload: PayrollItemUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    item = (
        await db.execute(select(PayrollItem).where(PayrollItem.id == iid))
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # FINAL/PAID 회차는 편집 금지.
    run = (
        await db.execute(select(PayrollRun).where(PayrollRun.id == item.run_id))
    ).scalar_one()
    if run.status != "DRAFT":
        raise HTTPException(
            status_code=400,
            detail="DRAFT 상태의 회차만 편집할 수 있습니다.",
        )

    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(item, k, v)
    recompute_totals(item)
    await db.commit()
    return await _item_out(db, item)


@router.post("/items/{iid}/recompute", response_model=PayrollItemOut)
async def recompute_item(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    item = (
        await db.execute(select(PayrollItem).where(PayrollItem.id == iid))
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    run = (
        await db.execute(select(PayrollRun).where(PayrollRun.id == item.run_id))
    ).scalar_one()
    if run.status != "DRAFT":
        raise HTTPException(status_code=400, detail="DRAFT 에서만 재계산 가능")
    await _recompute_one(db, item, pay_date=run.pay_date)
    await db.commit()
    return await _item_out(db, item)


# ---------------------------------------------------------------------------
# DeveloperTaxProfile
# ---------------------------------------------------------------------------


@router.get(
    "/tax-profile/{dev_id}",
    response_model=DeveloperTaxProfileOut,
)
async def get_tax_profile(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    prof = (
        await db.execute(
            select(DeveloperTaxProfile).where(
                DeveloperTaxProfile.developer_id == dev_id
            )
        )
    ).scalar_one_or_none()
    if not prof:
        return DeveloperTaxProfileOut(
            developer_id=dev_id,
            dependents_count=1,
            elderly_dependents_count=0,
            child_dependents_count=0,
            tax_reduction_rate=100,
        )
    return DeveloperTaxProfileOut.model_validate(prof, from_attributes=True)


@router.patch(
    "/tax-profile/{dev_id}",
    response_model=DeveloperTaxProfileOut,
)
async def update_tax_profile(
    dev_id: UUID,
    payload: DeveloperTaxProfileUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    prof = (
        await db.execute(
            select(DeveloperTaxProfile).where(
                DeveloperTaxProfile.developer_id == dev_id
            )
        )
    ).scalar_one_or_none()
    data = payload.model_dump(exclude_unset=True)
    if not prof:
        prof = DeveloperTaxProfile(developer_id=dev_id, **data)
        db.add(prof)
    else:
        for k, v in data.items():
            setattr(prof, k, v)
    await db.commit()
    await db.refresh(prof)
    logger.info(
        "직원 세액 프로파일 저장: dev=%s (수정자=%s)", dev_id, current.id
    )
    return DeveloperTaxProfileOut.model_validate(prof, from_attributes=True)


# ---------------------------------------------------------------------------
# WithholdingTaxTable (간이세액표)
# ---------------------------------------------------------------------------


@router.get("/tax-tables", response_model=list[WithholdingTaxTableOut])
async def list_tax_tables(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    tables = list(
        (
            await db.execute(
                select(WithholdingTaxTable)
                .options(selectinload(WithholdingTaxTable.rows))
                .order_by(WithholdingTaxTable.effective_from.desc())
            )
        ).scalars()
    )
    out = []
    for t in tables:
        item = WithholdingTaxTableOut.model_validate(t, from_attributes=True)
        item.row_count = len(t.rows) if t.rows else 0
        out.append(item)
    return out


def _to_num(v) -> float | None:
    """셀 값을 숫자로. "-", "", None 은 None."""
    if v in (None, "", "-"):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").strip()
    if not s or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _pick_sheet(wb) -> object:
    """국세청 공식 파일의 "근로소득간이세액표" 시트를 선택.

    1) 시트 이름에 "간이" 또는 "세액" 포함 우선.
    2) 없으면 두 번째 시트 (표준 국세청 배포본 레이아웃).
    3) 그것도 없으면 첫 시트.
    """
    for sh in wb.worksheets:
        name = (sh.title or "").replace(" ", "")
        if "간이" in name or "세액" in name:
            return sh
    if len(wb.worksheets) >= 2:
        return wb.worksheets[1]
    return wb.worksheets[0]


@router.post("/tax-tables", response_model=WithholdingTaxTableOut)
async def upload_tax_table(
    effective_from: date = Form(...),
    note: str | None = Form(None),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """국세청 `근로소득간이세액표` Excel 파일을 업로드.

    표준 포맷 가정 (hometax.go.kr 공식 배포본):
      - 2 번째 시트 이름이 `근로소득간이세액표` (또는 "간이"/"세액" 포함)
      - 헤더 3 줄: 상단 제목 → "월급여액(천원)" + "공제대상가족의 수" → "이상"/"미만" + 1..11
      - 데이터 행: A 열 = 월급여 이상 (**천원 단위**), B 열 = 미만 (**천원 단위**),
        C~M 열 = 공제대상가족 1..11명 세액 (원). `-` 또는 공백 = 0원
      - 마지막 몇 행은 "45,000천원 초과…" 같은 수식 텍스트 행 → 스킵
      - 국세청 표는 100% 기준만 제공. 80%/120% 는 ×0.8 / ×1.2 로 자동 생성.
    """
    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(
            status_code=500,
            detail="openpyxl 이 설치되어 있지 않습니다. requirements 를 확인하세요.",
        ) from exc

    content = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Excel 파싱 실패: {exc}"
        )

    sheet = _pick_sheet(wb)
    # 데이터 행 수집: A, B 둘 다 숫자여야 함. C~M 세액 (11 컬럼).
    rows: list[tuple[float, float, list[float | None]]] = []
    for r in sheet.iter_rows(values_only=True):
        if not r or len(r) < 3:
            continue
        bmin = _to_num(r[0])
        bmax = _to_num(r[1])
        if bmin is None or bmax is None:
            continue
        deps_vals: list[float | None] = []
        # 최대 11 deps (col C~M = index 2..12).
        for i in range(2, min(13, len(r))):
            deps_vals.append(_to_num(r[i]))
        # 11 명까지 채움.
        while len(deps_vals) < 11:
            deps_vals.append(None)
        rows.append((bmin, bmax, deps_vals))

    if not rows:
        raise HTTPException(
            status_code=400,
            detail=(
                "세액표 데이터 행을 찾지 못했습니다. 시트 이름이 `근로소득간이세액표` 인 "
                "국세청 공식 파일을 업로드해주세요."
            ),
        )

    # DB 저장 — 월급여 단위를 **천원 → 원** 으로 환산 (× 1000).
    table = WithholdingTaxTable(
        effective_from=effective_from,
        source_filename=file.filename,
        note=note,
        created_by=current.id,
    )
    db.add(table)
    await db.flush()

    total_rows = 0
    for bmin, bmax, deps_vals in rows:
        bmin_won = Decimal(str(bmin)) * Decimal(1000)
        bmax_won = Decimal(str(bmax)) * Decimal(1000)
        for idx, raw in enumerate(deps_vals):
            # deps 1..11. None → 세액 0.
            tax100_val = Decimal(str(raw or 0)).quantize(Decimal("0.01"))
            row_obj = WithholdingTaxRow(
                table_id=table.id,
                bracket_min=bmin_won,
                bracket_max=bmax_won,
                dependents=idx + 1,
                tax_80=(tax100_val * Decimal("0.8")).quantize(Decimal("0.01")),
                tax_100=tax100_val,
                tax_120=(tax100_val * Decimal("1.2")).quantize(Decimal("0.01")),
            )
            db.add(row_obj)
            total_rows += 1
    await db.commit()
    await db.refresh(table, attribute_names=["rows"])
    logger.info(
        "간이세액표 업로드: id=%s eff=%s 원본행=%s 저장=%s (업로더=%s)",
        table.id,
        effective_from,
        len(rows),
        total_rows,
        current.id,
    )
    out = WithholdingTaxTableOut.model_validate(table, from_attributes=True)
    out.row_count = total_rows
    return out


@router.get(
    "/tax-tables/{tid}/rows",
    response_model=list[WithholdingTaxRowOut],
)
async def list_tax_table_rows(
    tid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(WithholdingTaxRow)
                .where(WithholdingTaxRow.table_id == tid)
                .order_by(
                    WithholdingTaxRow.dependents, WithholdingTaxRow.bracket_min
                )
            )
        ).scalars()
    )
    return [WithholdingTaxRowOut.model_validate(r, from_attributes=True) for r in rows]


@router.delete("/tax-tables/{tid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tax_table(
    tid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    table = (
        await db.execute(select(WithholdingTaxTable).where(WithholdingTaxTable.id == tid))
    ).scalar_one_or_none()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    await db.delete(table)
    await db.commit()
    logger.warning("간이세액표 삭제: id=%s (삭제자=%s)", tid, current.id)


# ---------------------------------------------------------------------------
# PayrollDistribution (P4/P5 에서 구현 상세 확장)
# ---------------------------------------------------------------------------


@router.post(
    "/runs/{rid}/distribute/{dev_id}",
    response_model=PayrollDistributionOut,
)
async def distribute_payroll_item(
    rid: UUID,
    dev_id: UUID,
    file: UploadFile = File(...),
    to_email: str = Form(...),
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """프론트엔드에서 생성한 급여명세서 PDF 를 업로드 받아 해당 직원 메일로 발송.

    - FINAL 또는 PAID 상태의 회차에서만 허용.
    - 실패 시에도 payroll_distributions 에 FAILED 로 기록해 재시도 가능.
    """
    from app.services.mail import mail_service

    run = (
        await db.execute(select(PayrollRun).where(PayrollRun.id == rid))
    ).scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status not in ("FINAL", "PAID"):
        raise HTTPException(
            status_code=400,
            detail="FINAL 또는 PAID 상태의 회차만 배포할 수 있습니다.",
        )
    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="Developer not found")

    content = await file.read()
    subject = f"[급여명세서] {run.year}년 {run.month}월분 · {dev.name}"
    body = (
        f"{dev.name} 귀하,\n\n"
        f"{run.year}년 {run.month}월 급여명세서를 첨부와 같이 보내드립니다.\n"
        f"지급일: {run.pay_date or '-'}\n\n"
        f"문의사항은 인사 담당자에게 연락 부탁드립니다."
    )
    ok = await mail_service.send_for_tenant(
        current.tenant_id,
        subject=subject,
        body=body,
        to=[to_email],
        html=False,
        attachments=[(file.filename or "payroll.pdf", content, "application/pdf")],
    )
    dist = PayrollDistribution(
        run_id=rid,
        developer_id=dev_id,
        method="EMAIL",
        to_email=to_email,
        pdf_size_bytes=len(content),
        status="SENT" if ok else "FAILED",
        error_msg=None if ok else "메일 발송 실패 (로그 확인)",
        delivered_at=date.today() if ok else None,
        delivered_by=current.id,
    )
    db.add(dist)
    await db.commit()
    await db.refresh(dist)
    logger.info(
        "급여명세서 배포: run=%s dev=%s email=%s status=%s",
        rid,
        dev_id,
        to_email,
        dist.status,
    )
    out = PayrollDistributionOut.model_validate(dist, from_attributes=True)
    out.developer_name = dev.name
    return out


@router.get(
    "/runs/{rid}/distributions",
    response_model=list[PayrollDistributionOut],
)
async def list_distributions(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(PayrollDistribution)
                .where(PayrollDistribution.run_id == rid)
                .order_by(PayrollDistribution.delivered_at.desc())
            )
        ).scalars()
    )
    dev_ids = {r.developer_id for r in rows}
    names: dict[UUID, str] = {}
    if dev_ids:
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
        ).scalars():
            names[d.id] = d.name
    out = []
    for r in rows:
        item = PayrollDistributionOut.model_validate(r, from_attributes=True)
        item.developer_name = names.get(r.developer_id)
        out.append(item)
    return out
