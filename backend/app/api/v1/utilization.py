"""임직원 가동율 API — 인사 > 임직원 가동율 메뉴.

`employee_utilization_cells` 캐시 테이블을 읽는 것이 기본. 매일 03:00 cron 이
이번 달을 갱신하고, 백엔드 startup 시 빈 테이블이면 올해분 자동 백필.

엔드포인트:
  - GET `/utilization`              매트릭스 응답
  - POST `/utilization/recompute`   수동 재계산 (ADMIN/HR — retroactive 수정용)

권한 (`scope` 파라미터):
  - me   : 본인 한 행. mapped_developer_id 없으면 빈 결과.
  - team : 직속 부하(`manager_id == 본인`) 행들 — 매니저 자동 인지.
  - all  : 정규직 전원 — ADMIN/HR/SUPER_ADMIN 만.

캐시 미스 (그 셀이 아직 계산 안 됨):
  - GET 응답에서 빈 셀로 표시 (workdays=0 / time_ratio=None) + WARNING 로깅.
  - 사용자가 수동 recompute 호출하거나, 다음 cron tick 에 채워짐.

로깅 정책:
  - INFO  : scope=all 매트릭스 조회 (감사 트레일 — 전사 데이터 조회 누가/언제),
            수동 recompute 정상 완료.
  - WARNING: 권한 거부 (scope=all 가 admin/hr 아님 / recompute 가 admin/hr 아님),
             scope=team 결과 0행 (매니저 자동 인지와 어긋남),
             기간 24개월 초과 자동 절단 (의도와 다른 응답),
             cache miss (cron 누락 가능성).
  - me/team 정상 조회는 access log 가 잡으므로 별도 INFO 안 남김 (너무 잦음).
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Developer,
    EmployeeUtilizationCell,
    JobPosition,
    JobRank,
    User,
)
from app.schemas.employee_utilization import (
    BreakdownEntry,
    CellOut,
    DeveloperHeader,
    MatrixOut,
    Mode,
    RecomputeRequest,
    RecomputeResult,
    RowOut,
    Scope,
    SummaryOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/utilization", tags=["utilization"])


def _is_admin_hr(user: User) -> bool:
    return user.role in ("ADMIN", "HR", "SUPER_ADMIN")


def _parse_month(s: str) -> tuple[int, int]:
    """'YYYY-MM' → (year, month). 잘못된 입력은 400."""
    try:
        y, m = s.split("-")
        year = int(y); month = int(m)
        if not (1 <= month <= 12):
            raise ValueError("month out of range")
        if not (2000 <= year <= 2100):
            raise ValueError("year out of range")
        return year, month
    except Exception:
        raise HTTPException(
            status_code=400,
            detail=f"잘못된 month 표기: {s} (예: 2026-05)",
        )


def _month_pairs(
    year_from: int, month_from: int, year_to: int, month_to: int
) -> list[tuple[int, int]]:
    pairs: list[tuple[int, int]] = []
    y, m = year_from, month_from
    while (y, m) <= (year_to, month_to):
        pairs.append((y, m))
        if m == 12:
            y, m = y + 1, 1
        else:
            m = m + 1
    return pairs


async def _resolve_developer_ids(
    db: AsyncSession, user: User, scope: Scope
) -> list[UUID] | None:
    """scope 에 따라 매트릭스에 보일 developer_id 집합.

    반환 의미:
      - 비어있는 list `[]`  : 권한 있음. 그러나 표시할 사람 없음 (본인 매핑
        없음 / 부하 0명). 빈 매트릭스로 응답.
      - `None`             : 권한 없음 (scope=all 인데 ADMIN/HR 아님). 호출자
        가 빈 응답 + WARNING 처리.
      - non-empty list     : 정상.
    """
    if scope == "me":
        if not user.mapped_developer_id:
            return []
        return [user.mapped_developer_id]
    if scope == "team":
        if not user.mapped_developer_id:
            return []
        # 직속 부하 — manager_id == 본인. ACTIVE 가 아니어도 그 달까지는
        # 포함하면 좋지만, 1차는 단순하게 FULL_TIME 만 (status 무관 — 퇴사
        # 직원의 과거 가동율도 매트릭스에 남기는 게 정합성 측면에서 더 유용).
        rows = (
            await db.execute(
                select(Developer.id).where(
                    Developer.manager_id == user.mapped_developer_id,
                    Developer.employment_type == "FULL_TIME",
                )
            )
        ).all()
        ids = [r[0] for r in rows]
        if not ids:
            # 매니저 자동 인지(/auth/me) 가 menu_grants 에 utilization 을 넣어주는
            # 트리거(직속 부하 FULL_TIME ACTIVE ≥1) 와 어긋난 케이스 — 부하가
            # FREELANCER/INSOURCED 라거나, 매니저 인지 후 부하가 모두 퇴사 등.
            # 운영자가 인지해야 할 정보 — WARNING.
            logger.warning(
                "utilization scope=team 결과 0행: user=%s dev=%s — 매니저 자동 인지와 어긋남",
                user.id, user.mapped_developer_id,
            )
        return ids
    # scope=all — ADMIN/HR/SUPER_ADMIN 만.
    if not _is_admin_hr(user):
        logger.warning(
            "utilization scope=all 거부: role=%s user=%s",
            user.role, user.id,
        )
        return None
    rows = (
        await db.execute(
            select(Developer.id).where(Developer.employment_type == "FULL_TIME")
        )
    ).all()
    return [r[0] for r in rows]


@router.get("", response_model=MatrixOut)
async def get_utilization_matrix(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    month_from: str = Query(..., alias="from", description="시작 월 (YYYY-MM)"),
    month_to: str = Query(..., alias="to", description="끝 월 (YYYY-MM, inclusive)"),
    mode: Mode = Query("time", description="time | cost — 프런트가 토글 가능"),
    scope: Scope = Query("me", description="me | team | all"),
):
    """가동율 매트릭스 — 캐시 테이블 read.

    행 = 임직원, 열 = 월. 모드(time/cost) 와 무관하게 응답엔 둘 다 포함되어
    프런트가 즉시 토글 가능. `mode` 자체는 정렬·하이라이트 기준으로만 사용.
    """
    y_f, m_f = _parse_month(month_from)
    y_t, m_t = _parse_month(month_to)
    if (y_f, m_f) > (y_t, m_t):
        raise HTTPException(status_code=400, detail="from > to")

    # 24개월 자동 절단 — 24개월 초과 요청은 month_to 에서 거꾸로 24개월로 자른다.
    # silent 절단 (400 거부 대신) — 사용자가 "왜 안되지" 멈추지 않도록. WARNING
    # 한 줄로 흔적은 남긴다 (운영자가 누가 큰 매트릭스를 요청했는지 보고 권한·
    # UI 옵션 조정 근거).
    span_months = (y_t - y_f) * 12 + (m_t - m_f) + 1
    if span_months > 24:
        original_from = f"{y_f:04d}-{m_f:02d}"
        # to 기준 거꾸로 24개월 — m_t - 23 까지.
        new_total = (y_t * 12 + m_t) - 23
        y_f = (new_total - 1) // 12
        m_f = ((new_total - 1) % 12) + 1
        logger.warning(
            "utilization 기간 절단: 요청=%d개월 → 24개월 (from %s → %04d-%02d) "
            "by user=%s scope=%s",
            span_months, original_from, y_f, m_f, user.id, scope,
        )

    if scope == "all":
        # 전사 매트릭스 조회 감사 — 권한 거부는 _resolve_developer_ids 안에서.
        # 권한 통과 시 정상 흐름 INFO 1줄 ("누가 / 언제 / 어느 기간을 봤나").
        logger.info(
            "utilization scope=all 조회: user=%s from=%04d-%02d to=%04d-%02d mode=%s",
            user.id, y_f, m_f, y_t, m_t, mode,
        )

    dev_ids = await _resolve_developer_ids(db, user, scope)
    if dev_ids is None:
        # scope=all 거부.
        return MatrixOut(
            months=[f"{y:04d}-{m:02d}" for y, m in _month_pairs(y_f, m_f, y_t, m_t)],
            scope=scope, mode=mode, rows=[],
            summary=SummaryOut(
                company_avg_time_by_month=[],
                company_avg_cost_by_month=[],
                headcount_by_month=[],
                bench_count_by_month=[],
            ),
        )
    if not dev_ids:
        # me/team 인데 본인 매핑 없음 또는 부하 0.
        pairs = _month_pairs(y_f, m_f, y_t, m_t)
        months = [f"{y:04d}-{m:02d}" for y, m in pairs]
        return MatrixOut(
            months=months, scope=scope, mode=mode, rows=[],
            summary=SummaryOut(
                company_avg_time_by_month=[None] * len(months),
                company_avg_cost_by_month=[None] * len(months),
                headcount_by_month=[0] * len(months),
                bench_count_by_month=[0] * len(months),
            ),
        )

    # 임직원 헤더 정보 (rank/position 이름) — selectinload 대신 한 번에.
    devs = list(
        (
            await db.execute(
                select(Developer).where(Developer.id.in_(dev_ids)).order_by(Developer.name)
            )
        ).scalars()
    )
    rank_ids = {d.rank_id for d in devs if d.rank_id}
    pos_ids = {d.position_id for d in devs if d.position_id}
    rank_map: dict[UUID, str] = {}
    pos_map: dict[UUID, str] = {}
    if rank_ids:
        rank_map = dict(
            (await db.execute(
                select(JobRank.id, JobRank.name).where(JobRank.id.in_(rank_ids))
            )).all()
        )
    if pos_ids:
        pos_map = dict(
            (await db.execute(
                select(JobPosition.id, JobPosition.name).where(JobPosition.id.in_(pos_ids))
            )).all()
        )

    # cell prefetch — (dev_id, year, month) 인덱스로 dict 화.
    pairs = _month_pairs(y_f, m_f, y_t, m_t)
    months_str = [f"{y:04d}-{m:02d}" for y, m in pairs]
    cell_rows = list(
        (
            await db.execute(
                select(EmployeeUtilizationCell).where(
                    EmployeeUtilizationCell.developer_id.in_(dev_ids),
                    # 기간 필터는 (year, month) 튜플 비교가 안 돼 단순히 양쪽 연도
                    # 모두 fetch 한 뒤 코드에서 필터링.
                    EmployeeUtilizationCell.year.between(y_f, y_t),
                )
            )
        ).scalars()
    )
    cell_map: dict[tuple[UUID, int, int], EmployeeUtilizationCell] = {
        (c.developer_id, c.year, c.month): c for c in cell_rows
    }

    # 1) rows 빌드.
    out_rows: list[RowOut] = []
    cache_miss = 0
    # 회사 평균 계산용 누적자 — 월별 [(sum_time, n_time), (sum_cost, n_cost)].
    sum_time = [0.0] * len(pairs)
    cnt_time = [0] * len(pairs)
    sum_cost = [0.0] * len(pairs)
    cnt_cost = [0] * len(pairs)
    headcount = [0] * len(pairs)
    bench = [0] * len(pairs)

    for dev in devs:
        cells_out: list[CellOut] = []
        per_t: list[float] = []
        per_c: list[float] = []
        for idx, (year, month) in enumerate(pairs):
            c = cell_map.get((dev.id, year, month))
            if c is None:
                cache_miss += 1
                cells_out.append(
                    CellOut(
                        month=months_str[idx],
                        workdays=0.0, allocated_days=0.0, time_ratio=None,
                        revenue_contrib=0.0, monthly_cost=0.0, cost_ratio=None,
                        breakdown=[],
                    )
                )
                continue
            cells_out.append(
                CellOut(
                    month=months_str[idx],
                    workdays=float(c.workdays),
                    allocated_days=float(c.allocated_days),
                    time_ratio=(float(c.time_ratio) if c.time_ratio is not None else None),
                    revenue_contrib=float(c.revenue_contrib),
                    monthly_cost=float(c.monthly_cost),
                    cost_ratio=(float(c.cost_ratio) if c.cost_ratio is not None else None),
                    breakdown=[BreakdownEntry(**e) for e in (c.breakdown_json or [])],
                )
            )
            if c.time_ratio is not None:
                per_t.append(float(c.time_ratio))
                sum_time[idx] += float(c.time_ratio)
                cnt_time[idx] += 1
                headcount[idx] += 1
                if float(c.time_ratio) == 0:
                    bench[idx] += 1
            if c.cost_ratio is not None:
                per_c.append(float(c.cost_ratio))
                sum_cost[idx] += float(c.cost_ratio)
                cnt_cost[idx] += 1

        out_rows.append(
            RowOut(
                developer=DeveloperHeader(
                    id=dev.id, name=dev.name,
                    rank_name=rank_map.get(dev.rank_id) if dev.rank_id else None,
                    position_name=pos_map.get(dev.position_id) if dev.position_id else None,
                    hire_date=dev.hire_date,
                    resigned_date=dev.resigned_date,
                ),
                cells=cells_out,
                avg_time_ratio=(sum(per_t) / len(per_t)) if per_t else None,
                avg_cost_ratio=(sum(per_c) / len(per_c)) if per_c else None,
            )
        )

    if cache_miss > 0:
        logger.warning(
            "utilization cache miss: %d 셀 — cron 누락 또는 신규 임직원 가능. "
            "POST /utilization/recompute 로 재계산 권장.",
            cache_miss,
        )

    summary = SummaryOut(
        company_avg_time_by_month=[
            (sum_time[i] / cnt_time[i]) if cnt_time[i] else None
            for i in range(len(pairs))
        ],
        company_avg_cost_by_month=[
            (sum_cost[i] / cnt_cost[i]) if cnt_cost[i] else None
            for i in range(len(pairs))
        ],
        headcount_by_month=headcount,
        bench_count_by_month=bench,
    )
    return MatrixOut(
        months=months_str, scope=scope, mode=mode,
        rows=out_rows, summary=summary,
    )


@router.post("/recompute", response_model=RecomputeResult)
async def recompute_utilization(
    payload: RecomputeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """수동 재계산 — retroactive assignment 수정·신년 전환·데모 새로고침용.

    ADMIN/HR 만. 권한 없는 호출은 403 + WARNING.
    """
    if not _is_admin_hr(user):
        logger.warning(
            "utilization recompute 거부: role=%s user=%s",
            user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="ADMIN/HR only")
    if user.tenant_id is None:
        raise HTTPException(status_code=400, detail="No tenant for current user")
    from app.services.utilization_recompute import recompute_range
    result = await recompute_range(
        db,
        tenant_id=user.tenant_id,
        year_from=payload.year_from, month_from=payload.month_from,
        year_to=payload.year_to, month_to=payload.month_to,
    )
    logger.info(
        "utilization 수동 recompute by user=%s tenant=%s cells=%d duration=%dms",
        user.id, user.tenant_id, result["cells_upserted"], result["duration_ms"],
    )
    return RecomputeResult(
        tenant_id=user.tenant_id,
        cells_upserted=result["cells_upserted"],
        duration_ms=result["duration_ms"],
        months_covered=result["months"],
    )
