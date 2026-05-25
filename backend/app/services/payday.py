"""급여일 계산 서비스.

`app_settings.payroll` 의 설정 (payday_of_month, rollback_strategy,
include_holidays) 과 `holidays` 테이블의 휴일 row 를 종합해 다음 급여일을
계산한다. 대시보드 KPI 타일 + 향후 급여 모듈에서 공유.

휴일 정의:
- 토/일 — 항상 영업일 외.
- holidays.type IN (STATUTORY, TEMPORARY, COMPANY) — `include_holidays=true`
  일 때 영업일 외. EVENT_PUBLIC / EVENT_PRIVATE 는 일정이라 휴일 아님.
"""

from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import PayrollConfig
from app.models import Holiday


# 휴일 row 의 type 중 영업일 외로 간주.
NON_WORK_HOLIDAY_TYPES = ("STATUTORY", "TEMPORARY", "COMPANY")


@dataclass(frozen=True)
class NextPayday:
    scheduled_date: date   # 설정한 N일 그대로 (예: 5/22 토요일).
    actual_date: date      # 휴일 보정 후 (예: 5/21 금요일).
    days_until: int        # 오늘 기준 D-카운트. 오늘이면 0.
    is_today: bool
    rolled_back: bool      # 보정 발생 여부 (UI 안내용).


async def _holiday_set(
    db: AsyncSession, year: int, month: int,
) -> set[date]:
    """해당 월의 공휴일/임시휴일/회사휴일 date set. 인접월(±1) 도 함께 가져와
    rollback 으로 월 경계를 넘어갈 때 안전. tenant 격리는 RLS 가 처리.
    """
    # 검색 범위 — 대상 월 ±1 충분 (rollback 이 월을 넘나드는 케이스 드뭄).
    start = date(year, month, 1) - timedelta(days=10)
    end_y = year + (1 if month == 12 else 0)
    end_m = 1 if month == 12 else month + 1
    end = date(end_y, end_m, monthrange(end_y, end_m)[1]) + timedelta(days=10)
    rows = list(
        (
            await db.execute(
                select(Holiday.date).where(
                    Holiday.type.in_(NON_WORK_HOLIDAY_TYPES),
                    Holiday.date >= start,
                    Holiday.date <= end,
                )
            )
        ).scalars()
    )
    return set(rows)


def _is_workday(d: date, holidays: set[date], include_holidays: bool) -> bool:
    if d.weekday() >= 5:  # 5=Sat, 6=Sun
        return False
    if include_holidays and d in holidays:
        return False
    return True


def _adjust_to_workday(
    target: date, *, holidays: set[date], include_holidays: bool, strategy: str,
) -> date:
    step = -1 if strategy == "previous" else 1
    cur = target
    # 무한 루프 방지 — 14일 이내에 반드시 영업일이 나와야 함.
    for _ in range(14):
        if _is_workday(cur, holidays, include_holidays):
            return cur
        cur = cur + timedelta(days=step)
    return target  # fallback (이론상 unreachable)


def _safe_date(year: int, month: int, day: int) -> date:
    """월말일 보정 — 31일 설정인데 그 달이 30일까지면 그 달 마지막 날 사용."""
    last = monthrange(year, month)[1]
    return date(year, month, min(day, last))


async def compute_paydays_for_year(
    db: AsyncSession, *, year: int, settings: PayrollConfig,
) -> list[NextPayday]:
    """해당 연도의 1~12월 급여일을 보정 후 일괄 반환.

    캘린더에 매년 12개 급여일을 합성 row 로 표시할 때 사용. days_until 은
    오늘 기준이라 음수 가능 (이미 지난 달).
    """
    today = date.today()
    # 한 번에 그 해의 ±1개월 휴일을 가져와 12개 보정에 재사용 (월별 fetch
    # 12회 회피).
    from sqlalchemy import select as _select  # local — avoid name clash

    start = date(year, 1, 1) - timedelta(days=10)
    end = date(year, 12, 31) + timedelta(days=10)
    rows = list(
        (
            await db.execute(
                _select(Holiday.date).where(
                    Holiday.type.in_(NON_WORK_HOLIDAY_TYPES),
                    Holiday.date >= start,
                    Holiday.date <= end,
                )
            )
        ).scalars()
    )
    holidays_set = set(rows)

    out: list[NextPayday] = []
    for month in range(1, 13):
        scheduled = _safe_date(year, month, settings.payday_of_month)
        actual = _adjust_to_workday(
            scheduled,
            holidays=holidays_set,
            include_holidays=settings.include_holidays,
            strategy=settings.rollback_strategy,
        )
        days_until = (actual - today).days
        out.append(NextPayday(
            scheduled_date=scheduled,
            actual_date=actual,
            days_until=days_until,
            is_today=(days_until == 0),
            rolled_back=(scheduled != actual),
        ))
    return out


async def compute_next_payday(
    db: AsyncSession, *, today: date, settings: PayrollConfig,
) -> NextPayday:
    """오늘 기준 다음 급여일 계산.

    - 이번 달 (보정 후) 의 급여일이 오늘 이후 → 그 날.
    - 이번 달 (보정 후) 가 이미 지났으면 → 다음 달.
    - 휴일 보정은 strategy 에 따라 직전/다음 영업일.
    """
    payday = settings.payday_of_month
    include_h = settings.include_holidays
    strategy = settings.rollback_strategy

    # 우선 이번 달의 보정 후 날짜를 계산.
    months_holidays = await _holiday_set(db, today.year, today.month)
    scheduled_this = _safe_date(today.year, today.month, payday)
    actual_this = _adjust_to_workday(
        scheduled_this,
        holidays=months_holidays,
        include_holidays=include_h,
        strategy=strategy,
    )
    if actual_this >= today:
        scheduled = scheduled_this
        actual = actual_this
    else:
        # 다음 달.
        ny = today.year + (1 if today.month == 12 else 0)
        nm = 1 if today.month == 12 else today.month + 1
        next_holidays = await _holiday_set(db, ny, nm)
        scheduled = _safe_date(ny, nm, payday)
        actual = _adjust_to_workday(
            scheduled,
            holidays=next_holidays,
            include_holidays=include_h,
            strategy=strategy,
        )

    days_until = (actual - today).days
    return NextPayday(
        scheduled_date=scheduled,
        actual_date=actual,
        days_until=max(0, days_until),
        is_today=(days_until == 0),
        rolled_back=(scheduled != actual),
    )
