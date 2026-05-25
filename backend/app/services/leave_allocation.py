"""연차 신청 allocation 엔진.

연도 경계를 걸치는 신청을 법정(연도별) → 포상(FIFO) 순서로 쪼개서
차감 계획을 만든다. 이 모듈은 **순수 계산** 만 담당 — DB 트랜잭션은 호출자 몫.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Iterable
from uuid import UUID


# ---------------------------------------------------------------------------
# 영업일 / 연도 분할
# ---------------------------------------------------------------------------


def split_days_by_year(
    start: date,
    end: date,
    holidays: set[date],
    half_kind: str | None,
    days_total: Decimal,
) -> dict[int, Decimal]:
    """start ~ end (양끝 포함) 범위의 영업일을 연도별로 분할.

    - 주말(토·일) · holidays 제외.
    - half_kind = 'AM' 이면 start 를 0.5 로 카운트, 'PM' 이면 end 를 0.5 로.
    - 반환 합계가 days_total 과 일치해야 한다 (불일치 시 ValueError).

    기간이 하루라면 `half_kind` 은 그 하루를 0.5 로 만든다.
    """
    if end < start:
        raise ValueError("end 는 start 보다 크거나 같아야 합니다.")

    per_year: dict[int, Decimal] = {}
    cursor = start
    first_working_day = True
    last_working_day: date | None = None

    working_days: list[date] = []
    while cursor <= end:
        if cursor.weekday() < 5 and cursor not in holidays:
            working_days.append(cursor)
        cursor += timedelta(days=1)

    if not working_days:
        raise ValueError("신청 기간에 영업일이 없습니다.")

    for d in working_days:
        first_working_day = d == working_days[0]
        last_working_day = d == working_days[-1]
        if half_kind == "AM" and first_working_day:
            add = Decimal("0.5")
        elif half_kind == "PM" and last_working_day:
            add = Decimal("0.5")
        else:
            add = Decimal("1.0")
        per_year[d.year] = per_year.get(d.year, Decimal("0")) + add

    calculated = sum(per_year.values())
    if calculated != days_total:
        raise ValueError(
            f"days_total={days_total} 이 계산된 영업일({calculated}) 과 일치하지 않습니다."
        )
    return per_year


# ---------------------------------------------------------------------------
# Allocation 계획
# ---------------------------------------------------------------------------


@dataclass
class StatutoryBalanceSnapshot:
    year: int
    granted: Decimal
    used: Decimal
    pending: Decimal

    @property
    def remaining(self) -> Decimal:
        return self.granted - self.used - self.pending


@dataclass
class RewardGrantSnapshot:
    id: UUID
    remaining: Decimal  # 현재 남은 일수
    granted_at_key: object  # 정렬 키 (datetime 또는 tuple)


@dataclass
class Allocation:
    source_type: str  # STATUTORY | REWARD
    days: Decimal
    year: int | None = None
    grant_id: UUID | None = None


@dataclass
class AllocationPlan:
    allocations: list[Allocation]
    insufficient_days: Decimal = Decimal("0")  # > 0 이면 잔여 부족

    @property
    def ok(self) -> bool:
        return self.insufficient_days == Decimal("0")


def build_allocation_plan(
    days_by_year: dict[int, Decimal],
    statutory_by_year: dict[int, StatutoryBalanceSnapshot],
    reward_grants: Iterable[RewardGrantSnapshot],
) -> AllocationPlan:
    """연도별 필요일수를 받아 법정→포상 순서로 allocation 을 만든다.

    - 각 연도는 해당 연도의 법정 잔여부터 소진.
    - 연도별 법정 잔여가 부족하면 "총 leftover" 에 누적되어 포상에서 차감.
    - 포상은 granted_at 순서 (FIFO).
    - 포상도 부족하면 `insufficient_days > 0` 으로 반환.
    """
    allocations: list[Allocation] = []
    leftover = Decimal("0")

    for year in sorted(days_by_year.keys()):
        need = days_by_year[year]
        snap = statutory_by_year.get(year)
        stat_remain = snap.remaining if snap is not None else Decimal("0")
        take = min(stat_remain, need)
        if take > 0:
            allocations.append(Allocation("STATUTORY", take, year=year))
        leftover += need - take

    if leftover > 0:
        sorted_grants = sorted(reward_grants, key=lambda g: g.granted_at_key)
        for g in sorted_grants:
            if leftover == 0:
                break
            if g.remaining <= 0:
                continue
            take = min(g.remaining, leftover)
            allocations.append(Allocation("REWARD", take, grant_id=g.id))
            leftover -= take

    return AllocationPlan(allocations=allocations, insufficient_days=leftover)
