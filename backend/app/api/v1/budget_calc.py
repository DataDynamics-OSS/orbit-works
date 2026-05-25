"""운영 예산 계획 — 연도별 12개월 지출 예산.

권한: ADMIN/HR.
- GET    /budget-calc                   — 연도 필터 list
- POST   /budget-calc                   — 신규 (메타만, 라인 0 개로 시작)
- GET    /budget-calc/{id}              — 상세 (lines 포함)
- PATCH  /budget-calc/{id}              — 메타 수정
- DELETE /budget-calc/{id}              — 삭제
- PUT    /budget-calc/{id}/lines        — 라인 일괄 치환 (Grid 저장)
- POST   /budget-calc/{id}/duplicate    — 라인 사본까지 복제
"""

from __future__ import annotations

import logging
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import BudgetCalcLine, BudgetCalcPlan, User
from app.schemas.budget_calc import (
    BudgetCalcLinesReplace,
    BudgetCalcPlanCreate,
    BudgetCalcPlanOut,
    BudgetCalcPlanRowOut,
    BudgetCalcPlanUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/budget-calc", tags=["budget-calc"])


def _require_admin_or_hr(user: User) -> None:
    if user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="권한 없음 (ADMIN/HR)")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _line_to_dict(l: BudgetCalcLine) -> dict:
    return {
        "id": l.id,
        "account_code_id": l.account_code_id,
        "item_label": l.item_label,
        "m1": Decimal(l.m1 or 0),
        "m2": Decimal(l.m2 or 0),
        "m3": Decimal(l.m3 or 0),
        "m4": Decimal(l.m4 or 0),
        "m5": Decimal(l.m5 or 0),
        "m6": Decimal(l.m6 or 0),
        "m7": Decimal(l.m7 or 0),
        "m8": Decimal(l.m8 or 0),
        "m9": Decimal(l.m9 or 0),
        "m10": Decimal(l.m10 or 0),
        "m11": Decimal(l.m11 or 0),
        "m12": Decimal(l.m12 or 0),
        "note": l.note,
        "sort_order": l.sort_order,
    }


async def _detail(plan: BudgetCalcPlan) -> BudgetCalcPlanOut:
    return BudgetCalcPlanOut(
        id=plan.id,
        year=plan.year,
        title=plan.title,
        memo=plan.memo,
        created_at=plan.created_at,
        updated_at=plan.updated_at,
        lines=[_line_to_dict(l) for l in (plan.lines or [])],  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[BudgetCalcPlanRowOut])
async def list_plans(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    stmt = select(BudgetCalcPlan)
    if year is not None:
        stmt = stmt.where(BudgetCalcPlan.year == year)
    stmt = stmt.order_by(BudgetCalcPlan.year.desc(), BudgetCalcPlan.title.asc())
    rows = list((await db.execute(stmt)).scalars())
    return [
        BudgetCalcPlanRowOut(
            id=p.id,
            year=p.year,
            title=p.title,
            memo=p.memo,
            created_at=p.created_at,
            updated_at=p.updated_at,
        )
        for p in rows
    ]


@router.post("", response_model=BudgetCalcPlanOut, status_code=201)
async def create_plan(
    payload: BudgetCalcPlanCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """신규 예산 계획 — 라인 0 개로 시작. 사용자가 화면에서 행 추가."""
    _require_admin_or_hr(user)
    plan = BudgetCalcPlan(
        year=payload.year,
        title=payload.title.strip(),
        memo=payload.memo,
        created_by=user.id,
    )
    db.add(plan)
    await db.flush()
    await db.commit()
    await db.refresh(plan, attribute_names=["lines"])
    logger.info(
        "운영 예산 생성: id=%s year=%s title=%s (등록자=%s)",
        plan.id, plan.year, plan.title, user.id,
    )
    return await _detail(plan)


@router.get("/{plan_id}", response_model=BudgetCalcPlanOut)
async def get_plan(
    plan_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(BudgetCalcPlan)
            .options(selectinload(BudgetCalcPlan.lines))
            .where(BudgetCalcPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    return await _detail(plan)


@router.patch("/{plan_id}", response_model=BudgetCalcPlanOut)
async def update_plan(
    plan_id: UUID,
    payload: BudgetCalcPlanUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(BudgetCalcPlan)
            .options(selectinload(BudgetCalcPlan.lines))
            .where(BudgetCalcPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        logger.warning("운영 예산 PATCH 실패 (없음): id=%s (요청자=%s)", plan_id, user.id)
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(plan, k, v)
    await db.commit()
    await db.refresh(plan, attribute_names=["lines"])
    logger.info(
        "운영 예산 수정: id=%s fields=%s (요청자=%s)",
        plan.id, list(data.keys()), user.id,
    )
    return await _detail(plan)


@router.post("/{plan_id}/duplicate", response_model=BudgetCalcPlanOut, status_code=201)
async def duplicate_plan(
    plan_id: UUID,
    payload: BudgetCalcPlanCreate | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """라인까지 모두 복제. payload 있으면 메타 override."""
    _require_admin_or_hr(user)
    src = (
        await db.execute(
            select(BudgetCalcPlan)
            .options(selectinload(BudgetCalcPlan.lines))
            .where(BudgetCalcPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not src:
        logger.warning("운영 예산 복제 실패 (원본 없음): id=%s", plan_id)
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    if payload:
        new_year = payload.year
        new_title = payload.title.strip()
        new_memo = payload.memo
    else:
        new_year = src.year
        new_title = f"{src.title} (복사본)"[:200]
        new_memo = src.memo
    new_plan = BudgetCalcPlan(
        year=new_year,
        title=new_title,
        memo=new_memo,
        created_by=user.id,
    )
    db.add(new_plan)
    await db.flush()
    for l in src.lines:
        db.add(
            BudgetCalcLine(
                plan_id=new_plan.id,
                account_code_id=l.account_code_id,
                item_label=l.item_label,
                m1=l.m1, m2=l.m2, m3=l.m3, m4=l.m4, m5=l.m5, m6=l.m6,
                m7=l.m7, m8=l.m8, m9=l.m9, m10=l.m10, m11=l.m11, m12=l.m12,
                note=l.note,
                sort_order=l.sort_order,
            )
        )
    await db.commit()
    await db.refresh(new_plan, attribute_names=["lines"])
    logger.info(
        "운영 예산 복제: src=%s → new=%s lines=%s (요청자=%s)",
        src.id, new_plan.id, len(src.lines or []), user.id,
    )
    return await _detail(new_plan)


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan(
    plan_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    plan = (
        await db.execute(select(BudgetCalcPlan).where(BudgetCalcPlan.id == plan_id))
    ).scalar_one_or_none()
    if not plan:
        logger.warning("운영 예산 삭제 실패 (없음): id=%s", plan_id)
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    await db.delete(plan)
    await db.commit()
    logger.warning(
        "운영 예산 삭제: id=%s title=%s (요청자=%s)", plan.id, plan.title, user.id,
    )


@router.put("/{plan_id}/lines", response_model=BudgetCalcPlanOut)
async def replace_lines(
    plan_id: UUID,
    payload: BudgetCalcLinesReplace,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """라인 일괄 치환 (Grid 저장)."""
    _require_admin_or_hr(user)
    plan = (
        await db.execute(
            select(BudgetCalcPlan)
            .options(selectinload(BudgetCalcPlan.lines))
            .where(BudgetCalcPlan.id == plan_id)
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="예산서를 찾을 수 없습니다.")
    for old in list(plan.lines):
        await db.delete(old)
    await db.flush()
    for idx, l in enumerate(payload.lines):
        db.add(
            BudgetCalcLine(
                plan_id=plan.id,
                account_code_id=l.account_code_id,
                item_label=l.item_label,
                m1=Decimal(l.m1 or 0), m2=Decimal(l.m2 or 0),
                m3=Decimal(l.m3 or 0), m4=Decimal(l.m4 or 0),
                m5=Decimal(l.m5 or 0), m6=Decimal(l.m6 or 0),
                m7=Decimal(l.m7 or 0), m8=Decimal(l.m8 or 0),
                m9=Decimal(l.m9 or 0), m10=Decimal(l.m10 or 0),
                m11=Decimal(l.m11 or 0), m12=Decimal(l.m12 or 0),
                note=l.note,
                sort_order=l.sort_order if l.sort_order else idx,
            )
        )
    await db.flush()
    await db.refresh(plan, attribute_names=["lines"])
    await db.commit()
    logger.info(
        "운영 예산 라인 저장: id=%s lines=%s (요청자=%s)",
        plan.id, len(payload.lines), user.id,
    )
    return await _detail(plan)
