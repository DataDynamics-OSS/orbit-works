"""임직원 가동율 — 계산 코어.

매트릭스의 한 (developer × year × month) 셀을 만든다. 일/월/연 recompute,
on-demand cache miss 보정, seed_demo 마지막 단계까지 모두 이 모듈의
`compute_cell` 한 함수만 호출한다.

설계 원칙:
  - 입력 데이터(holidays / assignments / leaves / salary)는 호출자가 prefetch
    해서 넘긴다 (월별 루프 안에서 N+1 쿼리 안 나게).
  - 계산 결과는 dict (DB upsert 직전 형태) — 모델 인스턴스 빌드는 호출자 책임.
  - 영업일·휴가·overlap 같은 1차 helper 는 모두 `_` 로 시작 (외부 비공개).

용어:
  - 영업일 (workday)   : 평일 ∧ ¬holiday(STATUTORY/TEMPORARY/COMPANY)
  - 가용일 (workdays)  : 영업일 − 입사전/퇴사후 − APPROVED leave days
  - 분자 (allocated)   : Σ_assignments(overlap_workdays × allocation_percent/100)
  - 분모 (workdays)    : 위 가용일
  - 수익기여도         : Σ(monthly_rate × overlap_workdays/month_workdays × alloc%)
                       / monthly_cost  (cost=0 이면 None)
"""

from __future__ import annotations

import calendar
import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Assignment,
    Developer,
    DeveloperSalary,
    Holiday,
    LeaveRequest,
    Project,
)

logger = logging.getLogger(__name__)

ZERO = Decimal("0")
HUNDRED = Decimal("100")


# ---------------------------------------------------------------------------
# 영업일 / 월 경계
# ---------------------------------------------------------------------------


def month_bounds(year: int, month: int) -> tuple[date, date]:
    """(YYYY-MM-01, YYYY-MM-말일) 둘 다 inclusive."""
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


async def load_holidays(
    db: AsyncSession, year_from: int, year_to: int
) -> set[date]:
    """가동율 차감용 — 진짜 휴일(STATUTORY/TEMPORARY/COMPANY) 만.

    EVENT_PUBLIC / EVENT_PRIVATE 는 정상 근무일 (그저 캘린더 일정) 이라 제외.
    leaves.py 의 `_load_holidays` 와 동일 정책 — 일부러 한곳에 흩어둠
    (cross-module import 부담 줄이려).
    """
    if year_to < year_from:
        return set()
    rows = list(
        (
            await db.execute(
                select(Holiday.date).where(
                    Holiday.date.between(
                        date(year_from, 1, 1), date(year_to, 12, 31)
                    ),
                    Holiday.type.in_(("STATUTORY", "TEMPORARY", "COMPANY")),
                )
            )
        ).scalars()
    )
    return set(rows)


def workdays_in_range(
    start: date, end: date, holidays: set[date]
) -> list[date]:
    """[start, end] 안의 평일 ∩ ¬holiday 목록. 작을 일자 순."""
    out: list[date] = []
    cur = start
    while cur <= end:
        # weekday(): 월=0..금=4, 토=5/일=6.
        if cur.weekday() < 5 and cur not in holidays:
            out.append(cur)
        cur = cur + timedelta(days=1)
    return out


# ---------------------------------------------------------------------------
# 입출력 데이터 컨테이너
# ---------------------------------------------------------------------------


@dataclass
class CellPayload:
    """upsert 직전 row 표현. JSONB 필드(breakdown) 포함."""

    developer_id: UUID
    year: int
    month: int
    workdays: Decimal
    allocated_days: Decimal
    time_ratio: Decimal | None
    revenue_contrib: Decimal
    monthly_cost: Decimal
    cost_ratio: Decimal | None
    breakdown: list[dict]


# ---------------------------------------------------------------------------
# leave / salary lookup
# ---------------------------------------------------------------------------


async def load_approved_leaves(
    db: AsyncSession, developer_ids: list[UUID], year_from: int, year_to: int
) -> dict[UUID, list[LeaveRequest]]:
    """개발자별 APPROVED leave 리스트.

    leave_requests.days_total 은 이미 0.5 단위라 반차 자동 반영. 한 신청이
    여러 달 걸치면 월별 비례 분할은 호출 시점에 처리.
    """
    if not developer_ids:
        return {}
    win_start = date(year_from, 1, 1)
    win_end = date(year_to, 12, 31)
    rows = list(
        (
            await db.execute(
                select(LeaveRequest).where(
                    LeaveRequest.developer_id.in_(developer_ids),
                    LeaveRequest.status == "APPROVED",
                    LeaveRequest.start_date <= win_end,
                    LeaveRequest.end_date >= win_start,
                )
            )
        ).scalars()
    )
    out: dict[UUID, list[LeaveRequest]] = {}
    for lr in rows:
        out.setdefault(lr.developer_id, []).append(lr)
    return out


def leave_days_in_month(
    leaves: list[LeaveRequest],
    month_start: date,
    month_end: date,
    holidays: set[date],
) -> Decimal:
    """이 달과 겹치는 APPROVED 휴가 일수 합 (반차=0.5 반영).

    여러 달 걸친 신청은 month overlap 영업일 비율로 분할 (days_total *
    overlap_workdays / total_workdays). 한 달 안에 들어오는 신청이라면 분기
    없이 days_total 그대로.
    """
    total = ZERO
    for lr in leaves:
        # 신청 전체 기간에서 month 와 교집합.
        seg_start = max(lr.start_date, month_start)
        seg_end = min(lr.end_date, month_end)
        if seg_end < seg_start:
            continue
        if lr.start_date >= month_start and lr.end_date <= month_end:
            # 신청 전체가 이 달 안에 있음 — days_total 그대로.
            total += Decimal(lr.days_total)
            continue
        # 다달 걸친 신청 — 신청 기간 영업일 대비 비율 분할. 반차는 0.5 라
        # days_total < 신청 전체 영업일 수 일 수 있어 (반차 1일 = 0.5),
        # 단순 영업일 비율로 곱함.
        total_wds = len(workdays_in_range(lr.start_date, lr.end_date, holidays))
        if total_wds == 0:
            continue
        seg_wds = len(workdays_in_range(seg_start, seg_end, holidays))
        total += Decimal(lr.days_total) * Decimal(seg_wds) / Decimal(total_wds)
    return total


async def load_active_salary(
    db: AsyncSession, developer_id: UUID, on_date: date
) -> DeveloperSalary | None:
    """on_date 기준 active 인 salary row — effective_from 가 가장 큰 row 중
    on_date 이전이고 (effective_to is NULL or effective_to >= on_date).
    """
    row = (
        await db.execute(
            select(DeveloperSalary)
            .where(
                DeveloperSalary.developer_id == developer_id,
                DeveloperSalary.effective_from <= on_date,
            )
            .order_by(DeveloperSalary.effective_from.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    if row.effective_to is not None and row.effective_to < on_date:
        return None
    return row


def monthly_cost_from_salary(salary: DeveloperSalary | None) -> Decimal:
    """월 비용 = (annual / 12) + employer 4대보험 부담분.

    actual_employer_insurance_monthly 우선, 없으면 estimated. 둘 다 없으면 0
    (cost_ratio NULL 처리됨).
    """
    if salary is None:
        return ZERO
    base = Decimal(salary.annual_salary) / Decimal(12)
    ins = (
        salary.actual_employer_insurance_monthly
        or salary.estimated_employer_insurance_monthly
        or ZERO
    )
    return base + Decimal(ins)


# ---------------------------------------------------------------------------
# assignment overlap → 분자 + breakdown
# ---------------------------------------------------------------------------


async def load_assignments_overlapping(
    db: AsyncSession,
    developer_ids: list[UUID],
    year_from: int,
    year_to: int,
) -> dict[UUID, list[Assignment]]:
    """기간과 교집합 있는 assignment 들 — 개발자별 dict."""
    if not developer_ids:
        return {}
    win_start = date(year_from, 1, 1)
    win_end = date(year_to, 12, 31)
    rows = list(
        (
            await db.execute(
                select(Assignment).where(
                    Assignment.developer_id.in_(developer_ids),
                    Assignment.start_date <= win_end,
                    Assignment.end_date >= win_start,
                )
            )
        ).scalars()
    )
    out: dict[UUID, list[Assignment]] = {}
    for a in rows:
        out.setdefault(a.developer_id, []).append(a)
    return out


async def load_project_names(
    db: AsyncSession, project_ids: list[UUID]
) -> dict[UUID, str]:
    if not project_ids:
        return {}
    rows = (
        await db.execute(
            select(Project.id, Project.name).where(Project.id.in_(project_ids))
        )
    ).all()
    return {pid: name for pid, name in rows}


def _overlap_workdays(
    a_start: date, a_end: date, m_start: date, m_end: date, holidays: set[date]
) -> int:
    """assignment 기간 [a_start, a_end] ∩ 월 가용구간 [m_start, m_end] 의 영업일 수."""
    seg_start = max(a_start, m_start)
    seg_end = min(a_end, m_end)
    if seg_end < seg_start:
        return 0
    return len(workdays_in_range(seg_start, seg_end, holidays))


# ---------------------------------------------------------------------------
# 한 셀 계산
# ---------------------------------------------------------------------------


def compute_cell(
    *,
    developer: Developer,
    year: int,
    month: int,
    holidays: set[date],
    assignments: list[Assignment],
    project_names: dict[UUID, str],
    leaves: list[LeaveRequest],
    salary: DeveloperSalary | None,
) -> CellPayload:
    """한 (developer, year, month) 의 가동율 / 수익기여도 / breakdown 산출.

    호출 계약:
      - `holidays` / `assignments` / `leaves` / `salary` 는 모두 호출자가 prefetch.
        월 루프 안에서 ORM N+1 방지 — utilization_recompute.py 에서 dev_id 별
        dict 로 묶어 넘긴다.
      - `assignments` 는 그 달과 교집합이 있을 가능성 있는 것들이면 충분 (없는
        것이 섞여도 _overlap_workdays 에서 0 으로 걸러짐).
      - `project_names` 는 모든 assignment.project_id 를 커버해야 함. miss 시
        breakdown 라인에 "(unknown)" 으로 표시 (조용히 보존).
      - Decimal 단위로 계산. cell.* 컬럼 타입 quantize 는 호출자가 안 해도 됨
        — DB numeric scale 이 알아서 절단.
    예외:
      - 음수 workdays (휴가가 가용일 초과) 는 WARNING + 0 으로 clamp.
    """
    m_start, m_end = month_bounds(year, month)
    # 1) 그 달 영업일.
    month_wds = workdays_in_range(m_start, m_end, holidays)
    month_wd_count = Decimal(len(month_wds))

    # 2) 임직원 가용 영역 — 입사 전/퇴사 후 제외.
    avail_start = m_start
    avail_end = m_end
    if developer.hire_date and developer.hire_date > m_end:
        avail_start = m_end + timedelta(days=1)  # 빈 구간
    elif developer.hire_date and developer.hire_date > m_start:
        avail_start = developer.hire_date
    if developer.resigned_date and developer.resigned_date < m_start:
        avail_end = m_start - timedelta(days=1)  # 빈 구간
    elif developer.resigned_date and developer.resigned_date < m_end:
        avail_end = developer.resigned_date

    if avail_end < avail_start:
        # 그 달 내내 휴직·미입사·퇴사 후 — 분모=0, time_ratio=None.
        return CellPayload(
            developer_id=developer.id,
            year=year, month=month,
            workdays=ZERO, allocated_days=ZERO,
            time_ratio=None,
            revenue_contrib=ZERO, monthly_cost=ZERO, cost_ratio=None,
            breakdown=[],
        )

    avail_wds = workdays_in_range(avail_start, avail_end, holidays)
    avail_wd_count = Decimal(len(avail_wds))

    # 3) 휴가 차감 — APPROVED, 그 달과 교집합.
    leave_days = leave_days_in_month(leaves, m_start, m_end, holidays)
    raw_denom = avail_wd_count - leave_days
    if raw_denom < ZERO:
        # 비정상: 휴가 입력 일수가 가용 영업일을 초과. leave_requests.days_total
        # 산정 오류(공휴일과 겹친 휴가, 입사 전 휴가 등) 가능성 — 운영자가 봐야 함.
        logger.warning(
            "utilization: workdays denom 음수 — dev=%s %d-%02d "
            "avail_wd=%s leave=%s. 0 으로 clamp.",
            developer.id, year, month, avail_wd_count, leave_days,
        )
    workdays_denom = max(ZERO, raw_denom)

    # 4) 분자 / breakdown — 가용 구간 안에서 overlap.
    allocated = ZERO
    revenue = ZERO
    breakdown: list[dict] = []
    for a in assignments:
        ow = _overlap_workdays(
            a.start_date, a.end_date, avail_start, avail_end, holidays
        )
        if ow == 0:
            continue
        alloc_pct = Decimal(a.allocation_percent) / HUNDRED
        # 시간 기반 분자: 영업일 × allocation%.
        line_days = Decimal(ow) * alloc_pct
        allocated += line_days
        # 수익기여도 분자: monthly_rate × (overlap_wd / 월영업일) × alloc%.
        line_contrib = ZERO
        if month_wd_count > 0:
            line_contrib = (
                Decimal(a.monthly_rate)
                * Decimal(ow) / month_wd_count
                * alloc_pct
            )
            revenue += line_contrib
        breakdown.append(
            {
                "project_id": str(a.project_id),
                "project_name": project_names.get(a.project_id, "(unknown)"),
                "days": float(line_days),
                "allocation_percent": float(a.allocation_percent),
                "monthly_rate": float(a.monthly_rate),
                "contrib": float(line_contrib),
            }
        )

    # 5) ratio 계산. 분모 0 → None.
    time_ratio = (allocated / workdays_denom) if workdays_denom > 0 else None
    monthly_cost = monthly_cost_from_salary(salary)
    cost_ratio = (revenue / monthly_cost) if monthly_cost > 0 else None
    if monthly_cost <= 0 and any(a for a in assignments):
        # salary 누락은 운영 알람 거리 — recompute orchestrator 가 dev_id 와
        # 함께 WARNING 으로 한 번만 남기게 호출자에서 처리.
        pass

    return CellPayload(
        developer_id=developer.id,
        year=year, month=month,
        workdays=workdays_denom,
        allocated_days=allocated,
        time_ratio=time_ratio,
        revenue_contrib=revenue,
        monthly_cost=monthly_cost,
        cost_ratio=cost_ratio,
        breakdown=breakdown,
    )
