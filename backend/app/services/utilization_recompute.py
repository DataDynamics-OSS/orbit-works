"""임직원 가동율 — recompute 오케스트레이션.

세 가지 진입점이 같은 로직을 호출:
  - 일일 cron (03:00) — 이번 달만 재계산
  - 백엔드 startup 백필 — 빈 테이블이면 올해 1월~현재월
  - 수동 API (`POST /utilization/recompute`) / CLI — 임의 기간

내부 흐름 (tenant 별):
  1. FULL_TIME 임직원 + 그 기간에 가용 가능성 있는 사람만 후보.
  2. holidays · assignments · leaves · salary 를 한 번에 prefetch.
  3. (dev × month) 루프 → `services.utilization.compute_cell` 호출.
  4. UPSERT `(tenant_id, developer_id, year, month)` 단위.

성능 메모:
  - asyncpg + JSONB 단건 upsert 가 통상 1~3ms — 24명 × 12개월 ≈ 300 upsert
    당 1초 미만. 매트릭스가 100명 × 12개월 까지 가도 cron 한 번에 1~2초.
  - 입력 데이터를 dev_id 별로 dict 화해 N+1 차단.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Assignment,
    Developer,
    EmployeeUtilizationCell,
    LeaveRequest,
)
from app.services.utilization import (
    CellPayload,
    compute_cell,
    load_active_salary,
    load_approved_leaves,
    load_assignments_overlapping,
    load_holidays,
    load_project_names,
    month_bounds,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 진입점 1: 임의 기간 recompute (CLI / API)
# ---------------------------------------------------------------------------


def _month_pairs(
    year_from: int, month_from: int, year_to: int, month_to: int
) -> list[tuple[int, int]]:
    """(년, 월) inclusive 페어 리스트 — 시간 순."""
    pairs: list[tuple[int, int]] = []
    y, m = year_from, month_from
    while (y, m) <= (year_to, month_to):
        pairs.append((y, m))
        if m == 12:
            y, m = y + 1, 1
        else:
            m = m + 1
    return pairs


async def recompute_range(
    db: AsyncSession,
    *,
    tenant_id: UUID,
    year_from: int,
    month_from: int,
    year_to: int,
    month_to: int,
) -> dict:
    """주어진 tenant 의 (year_from, month_from)~(year_to, month_to) cell 들을
    재계산 + UPSERT.

    호출자는 미리 RLS 가 설정된 session 을 넘긴다 (system_session(tenant_id=...)).
    반환: {"cells_upserted": int, "duration_ms": int, "months": [...]}.
    """
    pairs = _month_pairs(year_from, month_from, year_to, month_to)
    if not pairs:
        return {"cells_upserted": 0, "duration_ms": 0, "months": []}

    t0 = time.monotonic()
    # 시작 INFO — 긴 작업(연 단위 백필) 추적용. 끝 INFO 만 있으면 진행 중일 때
    # "도는 중인지 hang 인지" 분간 안 됨.
    logger.info(
        "utilization recompute 시작: tenant=%s 기간=%04d-%02d~%04d-%02d (%d개월)",
        tenant_id, year_from, month_from, year_to, month_to, len(pairs),
    )

    # 1) FULL_TIME 임직원 — ACTIVE 또는 기간 안에 퇴사한 사람도 포함.
    win_start = date(year_from, 1, 1)
    win_end = date(year_to, 12, 31)
    devs = list(
        (
            await db.execute(
                select(Developer).where(
                    Developer.employment_type == "FULL_TIME",
                    # 입사 전 사람은 제외 (그 기간에 영향 없음).
                    (Developer.hire_date.is_(None))
                    | (Developer.hire_date <= win_end),
                    # 퇴사일이 기간 시작 전인 사람은 제외.
                    (Developer.resigned_date.is_(None))
                    | (Developer.resigned_date >= win_start),
                )
            )
        ).scalars()
    )
    if not devs:
        # 시드 직후가 아니라면 비정상 — FULL_TIME 정규직 0명은 회사 운영 가정과
        # 어긋남. employee_data 또는 employment_type seed 사고 의심. 운영자가 봐야.
        logger.warning(
            "utilization recompute: tenant=%s FULL_TIME 정규직 0명 → 0 cell. "
            "seed_demo 누락 또는 employment_type 데이터 사고 가능.",
            tenant_id,
        )
        return {
            "cells_upserted": 0,
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "months": [f"{y:04d}-{m:02d}" for y, m in pairs],
        }

    dev_ids = [d.id for d in devs]

    # 2) prefetch — 한 트랜잭션에서 batch.
    holidays = await load_holidays(db, year_from, year_to)
    assignments_by_dev = await load_assignments_overlapping(
        db, dev_ids, year_from, year_to
    )
    leaves_by_dev = await load_approved_leaves(
        db, dev_ids, year_from, year_to
    )
    # 모든 assignment 의 project_id 모아서 한 번에 name 조회.
    all_project_ids = list({
        a.project_id
        for arr in assignments_by_dev.values()
        for a in arr
    })
    project_names = await load_project_names(db, all_project_ids)

    # 3) cell 루프 + UPSERT.
    cells_upserted = 0
    salary_missing_warned: set[UUID] = set()
    for dev in devs:
        for year, month in pairs:
            # salary 는 cell 별로 lookup — effective_from 이 그 달 안에서 바뀔
            # 수 있어 (연봉 인상이 5월 1일 발효되면 5월 row 와 6월 row 가 다른
            # salary 를 봐야 함). month 말일 기준으로 active 한 row.
            _, m_end = month_bounds(year, month)
            salary = await load_active_salary(db, dev.id, m_end)
            if salary is None and dev.id not in salary_missing_warned:
                logger.warning(
                    "utilization: salary 누락 — dev=%s name=%s (%s 기준). cost_ratio 가 NULL 로 저장됩니다.",
                    dev.id, dev.name, m_end,
                )
                salary_missing_warned.add(dev.id)

            payload: CellPayload = compute_cell(
                developer=dev,
                year=year,
                month=month,
                holidays=holidays,
                assignments=assignments_by_dev.get(dev.id, []),
                project_names=project_names,
                leaves=leaves_by_dev.get(dev.id, []),
                salary=salary,
            )
            await _upsert_cell(db, tenant_id=tenant_id, payload=payload)
            cells_upserted += 1

    await db.commit()
    dur_ms = int((time.monotonic() - t0) * 1000)
    logger.info(
        "utilization recompute tenant=%s devs=%d months=%d cells=%d duration=%dms",
        tenant_id, len(devs), len(pairs), cells_upserted, dur_ms,
    )
    return {
        "cells_upserted": cells_upserted,
        "duration_ms": dur_ms,
        "months": [f"{y:04d}-{m:02d}" for y, m in pairs],
    }


async def _upsert_cell(
    db: AsyncSession, *, tenant_id: UUID, payload: CellPayload
) -> None:
    """단건 UPSERT — (tenant_id, developer_id, year, month) 충돌 시 update.

    `on_conflict_do_update(constraint=...)` 는 named constraint 를 직접 가리켜
    안정적 (index_elements 방식은 컬럼 set 만 일치하면 다른 UNIQUE 와도 매칭돼
    의도와 다른 constraint 에 걸릴 가능성). uq_eu_cells 가 db.sql 의 단일 진실.
    """
    values = {
        "tenant_id": tenant_id,
        "developer_id": payload.developer_id,
        "year": payload.year,
        "month": payload.month,
        "workdays": payload.workdays,
        "allocated_days": payload.allocated_days,
        "time_ratio": payload.time_ratio,
        "revenue_contrib": payload.revenue_contrib,
        "monthly_cost": payload.monthly_cost,
        "cost_ratio": payload.cost_ratio,
        "breakdown_json": payload.breakdown,
        "computed_at": datetime.utcnow(),
    }
    stmt = pg_insert(EmployeeUtilizationCell).values(**values)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_eu_cells",
        set_={
            "workdays": stmt.excluded.workdays,
            "allocated_days": stmt.excluded.allocated_days,
            "time_ratio": stmt.excluded.time_ratio,
            "revenue_contrib": stmt.excluded.revenue_contrib,
            "monthly_cost": stmt.excluded.monthly_cost,
            "cost_ratio": stmt.excluded.cost_ratio,
            "breakdown_json": stmt.excluded.breakdown_json,
            "computed_at": stmt.excluded.computed_at,
        },
    )
    await db.execute(stmt)


# ---------------------------------------------------------------------------
# 진입점 2: 일일 cron — 이번 달만
# ---------------------------------------------------------------------------


async def recompute_current_month_all_tenants() -> dict:
    """매일 03:00 cron 진입점 — 활성 tenant 전부 × 이번 달.

    안전 윈도우 1개월 (이번 달만). 지난달 retroactive 수정은 수동 recompute 로
    커버 (운영 약속).
    """
    from sqlalchemy import select as sa_select
    from app.core.database import system_session
    from app.core.tenant_context import set_current_tenant_id
    from app.models import Tenant

    today = date.today()
    year, month = today.year, today.month

    async with system_session() as db:
        tenants = list(
            (await db.execute(
                sa_select(Tenant.id, Tenant.slug).where(Tenant.is_active.is_(True))
            )).all()
        )

    per_tenant: list[dict] = []
    total_cells = 0
    for tid, slug in tenants:
        set_current_tenant_id(tid)
        try:
            async with system_session(tenant_id=str(tid)) as db:
                result = await recompute_range(
                    db,
                    tenant_id=tid,
                    year_from=year, month_from=month,
                    year_to=year, month_to=month,
                )
                per_tenant.append({"tenant": slug, **result})
                total_cells += result["cells_upserted"]
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "utilization recompute 실패 tenant=%s: %s",
                slug, exc, exc_info=True,
            )
            per_tenant.append({"tenant": slug, "error": str(exc)})
        finally:
            set_current_tenant_id(None)
    if total_cells == 0 and tenants:
        # tenant 가 있는데 한 셀도 안 찍힌 경우 — 모든 tenant 가 비정상.
        # cron 이 매일 0 으로 끝나면 운영자가 봐야 (recompute_range 안에서도
        # tenant별 WARNING 이 한 번 씩 났을 것 — 여기는 종합 신호).
        logger.warning(
            "utilization cron: 활성 tenant=%d 인데 total_cells=0. "
            "전체 시스템 점검 필요 (FULL_TIME 정규직 누락 / DB 부패 의심).",
            len(tenants),
        )
    return {
        "month": f"{year:04d}-{month:02d}",
        "total_cells": total_cells,
        "tenants": per_tenant,
    }


# ---------------------------------------------------------------------------
# 진입점 3: 백엔드 startup 백필 — 빈 테이블이면 올해분
# ---------------------------------------------------------------------------


async def backfill_current_year_if_empty() -> dict | None:
    """startup 시 호출. employee_utilization_cells 가 비어 있는 tenant 에 대해
    올해 1월~현재월 백필. 멱등.

    빈 dict 응답 시 = 모든 tenant 가 이미 채워져 있어 skip.
    """
    from sqlalchemy import func, select as sa_select
    from app.core.database import system_session
    from app.core.tenant_context import set_current_tenant_id
    from app.models import Tenant

    today = date.today()
    year = today.year

    async with system_session() as db:
        tenants = list(
            (await db.execute(
                sa_select(Tenant.id, Tenant.slug).where(Tenant.is_active.is_(True))
            )).all()
        )

    per_tenant: list[dict] = []
    backfilled = False
    for tid, slug in tenants:
        set_current_tenant_id(tid)
        try:
            async with system_session(tenant_id=str(tid)) as db:
                count = await db.scalar(
                    sa_select(func.count(EmployeeUtilizationCell.id))
                    .where(EmployeeUtilizationCell.year == year)
                )
                if count and count > 0:
                    # 올해 분이 1건이라도 있으면 백필 skip — 운영자가 진행 중인
                    # 데이터 덮어쓰지 않도록 보수적 정책. 강제 재계산은 수동 API.
                    per_tenant.append({"tenant": slug, "skipped": True, "existing_rows": count})
                    continue
                result = await recompute_range(
                    db,
                    tenant_id=tid,
                    year_from=year, month_from=1,
                    year_to=year, month_to=today.month,
                )
                per_tenant.append({"tenant": slug, **result})
                backfilled = True
                logger.info(
                    "utilization 백필 완료: tenant=%s months=%d cells=%d",
                    slug, today.month, result["cells_upserted"],
                )
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "utilization 백필 실패 tenant=%s: %s",
                slug, exc, exc_info=True,
            )
            per_tenant.append({"tenant": slug, "error": str(exc)})
        finally:
            set_current_tenant_id(None)
    return {"backfilled": backfilled, "tenants": per_tenant} if backfilled else None
