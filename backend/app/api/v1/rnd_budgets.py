"""정부 R&D 예산 — 예산서 CRUD + 라인 일괄 치환 + 기준 read-only.

권한: ADMIN/HR. 시드 JSON(read-only) 은 같은 권한.
"""

from __future__ import annotations

import json
import logging
from datetime import date
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Customer,
    Developer,
    DeveloperSalary,
    Project,
    RndBudgetLine,
    RndBudgetPersonnel,
    RndBudgetPlan,
    User,
)
from app.schemas.rnd_budget import (
    RndBudgetLinesReplace,
    RndBudgetPersonnelReplace,
    RndBudgetPlanCreate,
    RndBudgetPlanOut,
    RndBudgetPlanRowOut,
    RndBudgetPlanUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rnd-budgets", tags=["rnd-budgets"])

_DATA = Path(__file__).resolve().parents[2] / "data"
_PATH_STANDARD = _DATA / "rnd_cost_standard_criteria_seed.json"
_PATH_DISALLOWED = _DATA / "rnd_disallowed_expenses_criteria_seed.json"
_PATH_SETTLEMENT = _DATA / "rnd_settlement_docs_list_seed.json"

# 세목별 scaffold 기본 행 개수. 등록 안 된 세목은 1행, 0 이면 생성 스킵.
_SCAFFOLD_ROW_COUNTS: dict[str, int] = {
    # 인건비 — 보수만 기본 생성. 상용임금/일용임금/연구수당은 거의 입력 X.
    "personnel-salary": 1,
    "personnel-regular-wage": 0,
    "personnel-daily-wage": 0,
    "personnel-research-allowance": 0,
    # 운영비
    "operation-general": 10,           # 일반수용비
    "operation-utilities-tax": 2,      # 공공요금 및 제세
    "operation-overtime-meal": 1,      # 특근매식비
    "operation-rental": 3,             # 임차료
    # 여비
    "travel-domestic": 2,              # 국내여비
    "travel-overseas": 1,              # 국외여비
    # 업무추진비
    "business-promotion-project": 2,   # 사업추진비
    # 민간이전 — 일반 R&D 에서 거의 사용 X. 카테고리 전체 스킵.
    "private-transfer-grant": 0,
    "private-transfer-entrustment": 0,
    "private-transfer-capital": 0,
}


def _require_admin_or_hr(user: User) -> None:
    if user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="권한 없음 (ADMIN/HR)")


def _load_json(path: Path) -> dict:
    if not path.exists():
        raise HTTPException(status_code=500, detail=f"시드 파일 없음: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 기준 (read-only)
# ---------------------------------------------------------------------------


@router.get("/criteria/standard")
async def get_standard_criteria(user: User = Depends(get_current_user)):
    _require_admin_or_hr(user)
    return _load_json(_PATH_STANDARD)


@router.get("/criteria/disallowed")
async def get_disallowed_criteria(user: User = Depends(get_current_user)):
    _require_admin_or_hr(user)
    return _load_json(_PATH_DISALLOWED)


@router.get("/criteria/settlement-docs")
async def get_settlement_docs(user: User = Depends(get_current_user)):
    _require_admin_or_hr(user)
    return _load_json(_PATH_SETTLEMENT)


@router.get("/staff-picker")
async def get_staff_picker(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """인건비 인력 picker 전용 — 정규직 + ACTIVE 명단 + 현재 연봉 + 추정 4대보험.

    rnd-budget 컨텍스트(ADMIN/HR) 에서만 노출. 일반 directory 와 분리해 급여 정보
    의 우발적 노출 방지.
    """
    _require_admin_or_hr(user)
    today = date.today()
    devs = list(
        (
            await db.execute(
                select(Developer)
                .where(
                    Developer.employment_type == "FULL_TIME",
                    Developer.status == "ACTIVE",
                )
                .order_by(Developer.name.asc())
            )
        ).scalars()
    )
    if not devs:
        return []
    ids = [d.id for d in devs]
    rows = (
        await db.execute(
            select(
                DeveloperSalary.developer_id,
                DeveloperSalary.annual_salary,
                DeveloperSalary.estimated_employer_insurance_monthly,
                DeveloperSalary.effective_from,
            ).where(
                DeveloperSalary.developer_id.in_(ids),
                DeveloperSalary.effective_from <= today,
                or_(
                    DeveloperSalary.effective_to.is_(None),
                    DeveloperSalary.effective_to >= today,
                ),
            )
        )
    ).all()
    latest: dict[UUID, tuple] = {}
    for dev_id, salary, insurance, eff in rows:
        prev = latest.get(dev_id)
        if prev is None or eff > prev[2]:
            latest[dev_id] = (salary, insurance, eff)
    return [
        {
            "id": str(d.id),
            "name": d.name,
            "tag": d.tag,
            "title": d.title,
            "hire_date": d.hire_date.isoformat() if d.hire_date else None,
            "annual_salary": float(latest[d.id][0])
            if d.id in latest and latest[d.id][0] is not None
            else None,
            "employer_insurance_monthly": float(latest[d.id][1])
            if d.id in latest and latest[d.id][1] is not None
            else None,
        }
        for d in devs
    ]


# ---------------------------------------------------------------------------
# 예산서 CRUD
# ---------------------------------------------------------------------------


def _to_row_out(
    plan: RndBudgetPlan,
    project_name: str | None,
    customer_name: str | None,
    line_count: int,
) -> RndBudgetPlanRowOut:
    return RndBudgetPlanRowOut(
        id=plan.id,
        year=plan.year,
        title=plan.title,
        project_id=plan.project_id,
        customer_id=plan.customer_id,
        funding_agency=plan.funding_agency,
        memo=plan.memo,
        status=plan.status,  # type: ignore[arg-type]
        total_amount=Decimal(plan.total_amount or 0),
        company_size=plan.company_size,  # type: ignore[arg-type]
        total_rnd_budget=(
            Decimal(plan.total_rnd_budget) if plan.total_rnd_budget is not None else None
        ),
        gov_funding_amount=(
            Decimal(plan.gov_funding_amount) if plan.gov_funding_amount is not None else None
        ),
        own_cash_amount=(
            Decimal(plan.own_cash_amount) if plan.own_cash_amount is not None else None
        ),
        own_inkind_amount=(
            Decimal(plan.own_inkind_amount) if plan.own_inkind_amount is not None else None
        ),
        project_name=project_name,
        customer_name=customer_name,
        line_count=line_count,
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )


async def _name_lookups(
    db: AsyncSession, plans: list[RndBudgetPlan]
) -> tuple[dict[UUID, str], dict[UUID, str]]:
    proj_ids = {p.project_id for p in plans if p.project_id}
    cust_ids = {p.customer_id for p in plans if p.customer_id}
    proj: dict[UUID, str] = {}
    cust: dict[UUID, str] = {}
    if proj_ids:
        rows = (
            await db.execute(
                select(Project.id, Project.name).where(Project.id.in_(proj_ids))
            )
        ).all()
        proj = {r[0]: r[1] for r in rows}
    if cust_ids:
        rows = (
            await db.execute(
                select(Customer.id, Customer.name).where(Customer.id.in_(cust_ids))
            )
        ).all()
        cust = {r[0]: r[1] for r in rows}
    return proj, cust


@router.get("", response_model=list[RndBudgetPlanRowOut])
async def list_plans(
    year: int | None = None,
    status_filter: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    stmt = select(RndBudgetPlan).options(selectinload(RndBudgetPlan.lines))
    if year is not None:
        stmt = stmt.where(RndBudgetPlan.year == year)
    if status_filter:
        stmt = stmt.where(RndBudgetPlan.status == status_filter)
    stmt = stmt.order_by(
        RndBudgetPlan.year.desc(), RndBudgetPlan.updated_at.desc()
    )
    plans = (await db.execute(stmt)).scalars().unique().all()
    proj, cust = await _name_lookups(db, list(plans))
    return [
        _to_row_out(
            p,
            proj.get(p.project_id) if p.project_id else None,
            cust.get(p.customer_id) if p.customer_id else None,
            len(p.lines or []),
        )
        for p in plans
    ]


@router.post("", response_model=RndBudgetPlanOut, status_code=201)
async def create_plan(
    payload: RndBudgetPlanCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """새 예산서 생성 + 시드 기반 scaffold (모든 비목·세목 빈 라인 자동 생성).

    사용자가 행을 하나씩 추가할 필요 없이 처음부터 모든 비목·세목이
    펼쳐진 상태로 시작. 사용 안 할 행은 [×] 로 삭제, 같은 세목에 여러
    인력·거래는 [+ 같은 세목] 으로 추가.
    """
    _require_admin_or_hr(user)
    plan = RndBudgetPlan(
        year=payload.year,
        title=payload.title.strip(),
        project_id=payload.project_id,
        customer_id=payload.customer_id,
        funding_agency=payload.funding_agency,
        memo=payload.memo,
        status=payload.status,
        company_size=payload.company_size,
        total_rnd_budget=payload.total_rnd_budget,
        gov_funding_amount=payload.gov_funding_amount,
        own_cash_amount=payload.own_cash_amount,
        own_inkind_amount=payload.own_inkind_amount,
        gov_funding_rate=payload.gov_funding_rate,
        own_burden_rate=payload.own_burden_rate,
        cash_min_rate=payload.cash_min_rate,
        inkind_min_rate=payload.inkind_min_rate,
        created_by=user.id,
    )
    db.add(plan)
    await db.flush()  # plan.id 확보

    # 시드 scaffold — 세목별로 기본 N개 빈 라인 생성.
    # 빈번히 여러 건이 들어가는 세목은 미리 여러 행을 깔아둬서 사용자가
    # "+ 행 추가" 를 반복하지 않고 바로 채워 넣을 수 있게.
    standard = _load_json(_PATH_STANDARD)
    sort = 0
    for cat in standard.get("categories", []):
        for sub in cat.get("subcategories", []):
            count = _SCAFFOLD_ROW_COUNTS.get(sub["id"], 1)
            for _ in range(count):
                sort += 10
                db.add(
                    RndBudgetLine(
                        plan_id=plan.id,
                        category_id=cat["id"],
                        category_label=cat["label"],
                        subcategory_id=sub["id"],
                        subcategory_label=sub["label"],
                        item_id=None,
                        item_label=None,
                        unit_price=Decimal("0"),
                        quantity=Decimal("0"),
                        amount=Decimal("0"),
                        sort_order=sort,
                    )
                )

    await db.commit()
    await db.refresh(plan, attribute_names=["lines"])
    logger.info(
        "R&D 예산서 생성: id=%s year=%s title=%s lines_scaffold=%s (등록자=%s)",
        plan.id, plan.year, plan.title, len(plan.lines or []), user.id,
    )
    return await _detail(db, plan)


@router.get("/{plan_id}", response_model=RndBudgetPlanOut)
async def get_plan(
    plan_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(RndBudgetPlan)
            .options(
                selectinload(RndBudgetPlan.lines),
                selectinload(RndBudgetPlan.personnel),
            )
            .where(RndBudgetPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    return await _detail(db, plan)


@router.patch("/{plan_id}", response_model=RndBudgetPlanOut)
async def update_plan(
    plan_id: UUID,
    payload: RndBudgetPlanUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(RndBudgetPlan)
            .options(
                selectinload(RndBudgetPlan.lines),
                selectinload(RndBudgetPlan.personnel),
            )
            .where(RndBudgetPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        logger.warning(
            "R&D 예산서 PATCH 실패 (없음): id=%s (요청자=%s)", plan_id, user.id
        )
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(plan, k, v)
    await db.commit()
    await db.refresh(plan, attribute_names=["lines"])
    logger.info(
        "R&D 예산서 수정: id=%s fields=%s (요청자=%s)",
        plan.id, list(data.keys()), user.id,
    )
    return await _detail(db, plan)


@router.post(
    "/{plan_id}/duplicate", response_model=RndBudgetPlanOut, status_code=201
)
async def duplicate_plan(
    plan_id: UUID,
    payload: RndBudgetPlanCreate | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """예산서 복제 — 라인 + 인력 모두 사본 생성. 새 예산서는 항상 DRAFT.

    payload 가 있으면 메타(연도/제목/프로젝트/고객사/발주처/메모)를 override.
    없으면 원본 그대로 + 제목에 "(복사본)" suffix.
    """
    _require_admin_or_hr(user)
    src = (
        await db.execute(
            select(RndBudgetPlan)
            .options(
                selectinload(RndBudgetPlan.lines),
                selectinload(RndBudgetPlan.personnel),
            )
            .where(RndBudgetPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not src:
        logger.warning(
            "R&D 예산서 복제 실패 (원본 없음): id=%s (요청자=%s)",
            plan_id, user.id,
        )
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")

    if payload:
        new_year = payload.year
        new_title = payload.title.strip()
        new_project = payload.project_id
        new_customer = payload.customer_id
        new_agency = payload.funding_agency
        new_memo = payload.memo
    else:
        new_year = src.year
        new_title = f"{src.title} (복사본)"[:200]
        new_project = src.project_id
        new_customer = src.customer_id
        new_agency = src.funding_agency
        new_memo = src.memo

    new_plan = RndBudgetPlan(
        year=new_year,
        title=new_title,
        project_id=new_project,
        customer_id=new_customer,
        funding_agency=new_agency,
        memo=new_memo,
        status="DRAFT",
        company_size=src.company_size,
        total_rnd_budget=src.total_rnd_budget,
        gov_funding_amount=src.gov_funding_amount,
        own_cash_amount=src.own_cash_amount,
        own_inkind_amount=src.own_inkind_amount,
        gov_funding_rate=src.gov_funding_rate,
        own_burden_rate=src.own_burden_rate,
        cash_min_rate=src.cash_min_rate,
        inkind_min_rate=src.inkind_min_rate,
        total_amount=src.total_amount,
        created_by=user.id,
    )
    db.add(new_plan)
    await db.flush()  # new_plan.id

    for l in src.lines:
        db.add(
            RndBudgetLine(
                plan_id=new_plan.id,
                category_id=l.category_id,
                category_label=l.category_label,
                subcategory_id=l.subcategory_id,
                subcategory_label=l.subcategory_label,
                item_id=l.item_id,
                item_label=l.item_label,
                unit_price=l.unit_price,
                quantity=l.quantity,
                amount=l.amount,
                note=l.note,
                sort_order=l.sort_order,
            )
        )
    for p in src.personnel:
        db.add(
            RndBudgetPersonnel(
                plan_id=new_plan.id,
                segment=p.segment,
                name=p.name,
                role=p.role,
                monthly_salary=p.monthly_salary,
                monthly_insurance=p.monthly_insurance,
                severance_annual=p.severance_annual,
                months=p.months,
                ratio_pct=p.ratio_pct,
                sort_order=p.sort_order,
            )
        )

    await db.commit()
    await db.refresh(new_plan, attribute_names=["lines", "personnel"])
    logger.info(
        "R&D 예산서 복제: src=%s → new=%s lines=%s personnel=%s (요청자=%s)",
        src.id, new_plan.id, len(src.lines or []), len(src.personnel or []),
        user.id,
    )
    return await _detail(db, new_plan)


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan(
    plan_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    plan = (
        await db.execute(select(RndBudgetPlan).where(RndBudgetPlan.id == plan_id))
    ).scalar_one_or_none()
    if not plan:
        logger.warning(
            "R&D 예산서 삭제 실패 (없음): id=%s (요청자=%s)", plan_id, user.id
        )
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    await db.delete(plan)
    await db.commit()
    logger.warning(
        "R&D 예산서 삭제: id=%s title=%s (요청자=%s)",
        plan.id, plan.title, user.id,
    )


@router.put("/{plan_id}/lines", response_model=RndBudgetPlanOut)
async def replace_lines(
    plan_id: UUID,
    payload: RndBudgetLinesReplace,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """라인 일괄 치환 (Grid 저장). 기존 라인 모두 삭제 후 새로 INSERT."""
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(RndBudgetPlan)
            .options(
                selectinload(RndBudgetPlan.lines),
                selectinload(RndBudgetPlan.personnel),
            )
            .where(RndBudgetPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")

    # 기존 라인 삭제 — cascade='all, delete-orphan' 이라 plan.lines 비우면 자동 처리.
    for old in list(plan.lines):
        await db.delete(old)
    await db.flush()

    total = Decimal("0")
    for idx, l in enumerate(payload.lines):
        # amount = unit_price * quantity (서버에서 재계산 — 클라이언트 신뢰 X)
        unit = Decimal(l.unit_price or 0)
        qty = Decimal(l.quantity or 0)
        amt = (unit * qty).quantize(Decimal("0.01"))
        total += amt
        db.add(
            RndBudgetLine(
                plan_id=plan.id,
                category_id=l.category_id,
                category_label=l.category_label,
                subcategory_id=l.subcategory_id,
                subcategory_label=l.subcategory_label,
                item_id=l.item_id,
                item_label=l.item_label,
                unit_price=unit,
                quantity=qty,
                amount=amt,
                note=l.note,
                sort_order=l.sort_order if l.sort_order else idx,
            )
        )

    plan.total_amount = total
    # SQLAlchemy 가 plan.lines 캐시를 갖고 있을 수 있어 refresh 필요.
    await db.flush()
    await db.refresh(plan, attribute_names=["lines"])
    await db.commit()
    logger.info(
        "R&D 예산서 라인 저장: id=%s lines=%s total=%s (요청자=%s)",
        plan.id, len(payload.lines), total, user.id,
    )
    return await _detail(db, plan)


@router.put("/{plan_id}/personnel", response_model=RndBudgetPlanOut)
async def replace_personnel(
    plan_id: UUID,
    payload: RndBudgetPersonnelReplace,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """인건비 인력 일괄 치환. 기존 인력 row 삭제 후 새로 INSERT."""
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(RndBudgetPlan)
            .options(
                selectinload(RndBudgetPlan.lines),
                selectinload(RndBudgetPlan.personnel),
            )
            .where(RndBudgetPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")

    for old in list(plan.personnel):
        await db.delete(old)
    await db.flush()

    for idx, p in enumerate(payload.personnel):
        db.add(
            RndBudgetPersonnel(
                plan_id=plan.id,
                segment=p.segment,
                name=p.name.strip(),
                role=(p.role or "").strip() or None,
                monthly_salary=Decimal(p.monthly_salary or 0),
                monthly_insurance=Decimal(p.monthly_insurance or 0),
                severance_annual=Decimal(p.severance_annual or 0),
                months=Decimal(p.months or 0),
                ratio_pct=Decimal(p.ratio_pct or 0),
                sort_order=p.sort_order if p.sort_order else idx,
            )
        )

    await db.flush()
    await db.refresh(plan, attribute_names=["personnel"])
    await db.commit()
    logger.info(
        "R&D 예산서 인력 저장: id=%s personnel=%s (요청자=%s)",
        plan.id, len(payload.personnel), user.id,
    )
    return await _detail(db, plan)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


async def _detail(db: AsyncSession, plan: RndBudgetPlan) -> RndBudgetPlanOut:
    proj, cust = await _name_lookups(db, [plan])
    base = _to_row_out(
        plan,
        proj.get(plan.project_id) if plan.project_id else None,
        cust.get(plan.customer_id) if plan.customer_id else None,
        len(plan.lines or []),
    )
    return RndBudgetPlanOut(
        **base.model_dump(),
        lines=[
            {
                "id": l.id,
                "category_id": l.category_id,
                "category_label": l.category_label,
                "subcategory_id": l.subcategory_id,
                "subcategory_label": l.subcategory_label,
                "item_id": l.item_id,
                "item_label": l.item_label,
                "unit_price": Decimal(l.unit_price or 0),
                "quantity": Decimal(l.quantity or 0),
                "amount": Decimal(l.amount or 0),
                "note": l.note,
                "sort_order": l.sort_order,
            }
            for l in (plan.lines or [])
        ],  # type: ignore[arg-type]
        personnel=[
            {
                "id": p.id,
                "segment": p.segment,
                "name": p.name,
                "role": p.role,
                "monthly_salary": Decimal(p.monthly_salary or 0),
                "monthly_insurance": Decimal(p.monthly_insurance or 0),
                "severance_annual": Decimal(p.severance_annual or 0),
                "months": Decimal(p.months or 0),
                "ratio_pct": Decimal(p.ratio_pct or 0),
                "sort_order": p.sort_order,
            }
            for p in (plan.personnel or [])
        ],  # type: ignore[arg-type]
    )
