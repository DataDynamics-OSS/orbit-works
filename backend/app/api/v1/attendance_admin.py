"""출퇴근 모니터링 (admin) API — 일/주/월 단위 통합 집계.

ADMIN + HR 만 접근 가능. 권한은 `attendance.admin`.

세 엔드포인트가 같은 데이터 모양을 다른 그래뉼래리티로 반환:
- daily   : 한 날짜에 대해 직원별 sessions[] + leave + worksite + projects 풀데이터
- weekly  : 월~일 7일에 대해 직원별 days[] (state + summary)
- monthly : 1~말일 N일에 대해 직원별 days[] (state)

상태 결정 우선순위 (per developer per date):
1. holidays 매칭 → HOLIDAY
2. 토/일 → WEEKEND
3. 그 날 covering 하는 APPROVED leave → LEAVE_ANNUAL / LEAVE_HALF_AM / LEAVE_HALF_PM / LEAVE_PUBLIC
4. attendance sessions 존재
   - any open AND date == today (KST) → IN_PROGRESS
   - any out_of_radius → NORMAL_OUT_OF_RANGE
   - 그 외 → NORMAL
5. 위 모두 아님 → ABSENT (휴일/연차 아닌 평일에 기록 없음)

퇴사자(developers.status != 'ACTIVE') 도 포함 — 과거 이력 조회 목적.
"""

from __future__ import annotations

from calendar import monthrange
from collections import defaultdict
from datetime import date as date_cls, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.models import (
    Attendance,
    Developer,
    Holiday,
    LeaveRequest,
    User,
    Worksite,
    WorksiteAssignment,
)

KST = ZoneInfo("Asia/Seoul")

router = APIRouter(prefix="/attendance/admin", tags=["attendance-admin"])


# ---------------------------------------------------------------------------
# 공통 헬퍼
# ---------------------------------------------------------------------------


def _state_for_day(
    *,
    today: date_cls,
    target: date_cls,
    holiday_name: str | None,
    leave: dict | None,
    sessions: list[Attendance],
    hire_date: date_cls | None = None,
    resigned_date: date_cls | None = None,
) -> str:
    """그 날 그 직원의 종합 상태.

    우선순위:
      1. 재직 기간 밖(입사 전 / 퇴사 후) → NOT_EMPLOYED
      2. 공휴일 → HOLIDAY (미래도 표시)
      3. 주말 → WEEKEND (미래도 표시)
      4. 승인된 연차/반차/공가 → LEAVE_* (미래도 표시 — 휴가 계획 가시화)
      5. 미래 평일 + 위 모두 아님 → FUTURE (결근 표시 X)
      6. 출근 세션 존재 → NORMAL / IN_PROGRESS / NORMAL_OUT_OF_RANGE
      7. 그 외 → ABSENT
    """
    # 재직 기간 밖 — 출퇴근 자체가 의미 없음.
    if hire_date is not None and target < hire_date:
        return "NOT_EMPLOYED"
    if resigned_date is not None and target > resigned_date:
        return "NOT_EMPLOYED"
    # 휴일/주말/연차 는 미래 일자라도 그대로 표시 (캘린더 표시).
    if holiday_name is not None:
        return "HOLIDAY"
    if target.weekday() >= 5:
        return "WEEKEND"
    if leave is not None:
        kind = leave["leave_type"]
        if kind == "HALF":
            return "LEAVE_HALF_AM" if leave["half_kind"] == "AM" else "LEAVE_HALF_PM"
        if kind == "UNPAID_PUBLIC":
            return "LEAVE_PUBLIC"
        return "LEAVE_ANNUAL"
    # 미래 평일에 연차/휴일도 없음 → 결근으로 마킹하지 않고 빈 셀.
    if target > today:
        return "FUTURE"
    if not sessions:
        return "ABSENT"
    has_open = any(s.check_out_at is None for s in sessions)
    has_out = any(
        (s.check_in_within_radius is False)
        or (s.check_out_within_radius is False)
        for s in sessions
    )
    if has_open and target == today:
        return "IN_PROGRESS"
    return "NORMAL_OUT_OF_RANGE" if has_out else "NORMAL"


async def _fetch_developers(
    db: AsyncSession,
    query: str | None,
    *,
    exclude_freelancer: bool = True,
    exclude_resigned: bool = True,
    exclude_directory: bool = True,
) -> list[Developer]:
    """가나다 순 — PostgreSQL 의 자연 정렬로 한글 충분.

    필터:
    - exclude_freelancer: employment_type='FREELANCER' 제외 (기본 True — 정규직만)
    - exclude_resigned  : status != 'ACTIVE' 제외 (기본 True — 재직자만)
    - exclude_directory : Settings > 고급 > 제외 리스트 의 UUID 제외 (기본 True)
    """
    from uuid import UUID

    from app.core.config import get_settings

    stmt = select(Developer).order_by(Developer.name.asc())
    if query:
        from sqlalchemy import or_

        like = f"%{query}%"
        stmt = stmt.where(
            or_(
                Developer.name.ilike(like),
                Developer.company_email.ilike(like),
            )
        )
    if exclude_freelancer:
        stmt = stmt.where(Developer.employment_type != "FREELANCER")
    if exclude_resigned:
        stmt = stmt.where(Developer.status == "ACTIVE")
    if exclude_directory:
        hidden = get_settings().directory.excluded_developer_ids or []
        if hidden:
            try:
                hidden_uuids = [UUID(h) for h in hidden]
            except (TypeError, ValueError):
                hidden_uuids = []
            if hidden_uuids:
                stmt = stmt.where(Developer.id.notin_(hidden_uuids))
    return list((await db.execute(stmt)).scalars())


async def _fetch_attendance_in_range(
    db: AsyncSession, start: date_cls, end: date_cls
) -> dict[tuple, list[Attendance]]:
    """(developer_id, work_date) → sessions[]"""
    rows = list(
        (
            await db.execute(
                select(Attendance)
                .where(
                    Attendance.work_date >= start,
                    Attendance.work_date <= end,
                    Attendance.developer_id.is_not(None),
                )
                .order_by(Attendance.check_in_at.asc())
            )
        ).scalars()
    )
    out: dict[tuple, list[Attendance]] = defaultdict(list)
    for r in rows:
        out[(r.developer_id, r.work_date)].append(r)
    return out


async def _fetch_leaves_in_range(
    db: AsyncSession, start: date_cls, end: date_cls
) -> dict[tuple, dict]:
    """(developer_id, date) → leave info dict (APPROVED 만, 날짜 펼침)."""
    rows = list(
        (
            await db.execute(
                select(LeaveRequest).where(
                    LeaveRequest.status == "APPROVED",
                    LeaveRequest.start_date <= end,
                    LeaveRequest.end_date >= start,
                )
            )
        ).scalars()
    )
    out: dict[tuple, dict] = {}
    for r in rows:
        d = max(r.start_date, start)
        last = min(r.end_date, end)
        while d <= last:
            out[(r.developer_id, d)] = {
                "leave_type": r.leave_type,
                "half_kind": r.half_kind,
                "category": r.category,
                "reason": r.reason,
            }
            d += timedelta(days=1)
    return out


async def _fetch_holidays_in_range(
    db: AsyncSession, start: date_cls, end: date_cls
) -> dict[date_cls, str]:
    """출퇴근 9-색 표시용 — 진짜 휴일만.

    EVENT_PUBLIC / EVENT_PRIVATE 는 단순 캘린더 일정 → 정상 근무일.
    """
    rows = list(
        (
            await db.execute(
                select(Holiday).where(
                    Holiday.date >= start,
                    Holiday.date <= end,
                    Holiday.type.in_(("STATUTORY", "TEMPORARY", "COMPANY")),
                )
            )
        ).scalars()
    )
    return {r.date: r.name for r in rows}


async def _fetch_worksite_map(db: AsyncSession) -> dict:
    """developer_id → 가장 최근 active worksite + projects 미리 로드.

    퇴사자도 포함하지만 worksite 가 더는 없으면 None. UI 는 None 도 허용.
    """
    rows = list(
        (
            await db.execute(
                select(WorksiteAssignment, Worksite)
                .join(Worksite, Worksite.id == WorksiteAssignment.worksite_id)
                .options(selectinload(Worksite.projects))
                .order_by(
                    WorksiteAssignment.is_primary.desc(),
                    WorksiteAssignment.start_date.desc(),
                )
            )
        ).all()
    )
    out: dict = {}
    for wa, w in rows:
        if wa.developer_id in out:
            continue  # 가장 우선 1개만
        out[wa.developer_id] = {
            "id": str(w.id),
            "name": w.name,
            "address": w.address,
            "latitude": w.latitude,
            "longitude": w.longitude,
            "radius_meters": w.radius_meters,
            "work_start_time": w.work_start_time,
            "work_end_time": w.work_end_time,
            "projects": [{"id": str(p.id), "name": p.name} for p in w.projects],
        }
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/daily")
async def daily(
    date: date_cls = Query(..., description="YYYY-MM-DD (KST)"),
    query: str | None = Query(None, description="이름/이메일 검색"),
    exclude_freelancer: bool = True,
    exclude_resigned: bool = True,
    exclude_directory: bool = True,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("attendance.admin")),
):
    today = datetime.now(KST).date()
    holiday_name = (await _fetch_holidays_in_range(db, date, date)).get(date)
    devs = await _fetch_developers(
        db, query,
        exclude_freelancer=exclude_freelancer,
        exclude_resigned=exclude_resigned,
        exclude_directory=exclude_directory,
    )
    att_map = await _fetch_attendance_in_range(db, date, date)
    leave_map = await _fetch_leaves_in_range(db, date, date)
    ws_map = await _fetch_worksite_map(db)

    out_devs = []
    for d in devs:
        sessions = att_map.get((d.id, date), [])
        leave = leave_map.get((d.id, date))
        state = _state_for_day(
            today=today,
            target=date,
            holiday_name=holiday_name,
            leave=leave,
            sessions=sessions,
            hire_date=d.hire_date,
            resigned_date=d.resigned_date,
        )
        out_devs.append(
            {
                "developer_id": str(d.id),
                "name": d.name,
                "employment_type": d.employment_type,
                "status": d.status,  # 퇴사자 표시용
                "worksite": ws_map.get(d.id),
                "leave": leave,
                "state": state,
                "sessions": [
                    {
                        "id": str(s.id),
                        "check_in_at": s.check_in_at.isoformat(),
                        "check_out_at": s.check_out_at.isoformat()
                        if s.check_out_at
                        else None,
                        "check_in_within_radius": s.check_in_within_radius,
                        "check_out_within_radius": s.check_out_within_radius,
                        "check_in_distance_m": s.check_in_distance_m,
                        "check_out_distance_m": s.check_out_distance_m,
                        "check_in_reason": s.check_in_reason,
                        "check_out_reason": s.check_out_reason,
                    }
                    for s in sessions
                ],
            }
        )
    return {
        "date": date.isoformat(),
        "is_holiday": holiday_name is not None,
        "holiday_name": holiday_name,
        "is_weekend": date.weekday() >= 5,
        "developers": out_devs,
    }


def _day_summary(sessions: list[Attendance]) -> dict:
    """하루 합계 분, 출근시각, 퇴근시각."""
    minutes = 0
    has_open = False
    first_in = None
    last_out = None
    for s in sessions:
        if first_in is None or s.check_in_at < first_in:
            first_in = s.check_in_at
        if s.check_out_at is None:
            has_open = True
            continue
        if last_out is None or s.check_out_at > last_out:
            last_out = s.check_out_at
        delta = (s.check_out_at - s.check_in_at).total_seconds()
        minutes += int(delta // 60)
    return {
        "minutes": minutes,
        "first_in": first_in.isoformat() if first_in else None,
        "last_out": last_out.isoformat() if last_out else None,
        "has_open": has_open,
    }


@router.get("/weekly")
async def weekly(
    week_start: date_cls = Query(..., description="월요일 (YYYY-MM-DD KST)"),
    query: str | None = None,
    exclude_freelancer: bool = True,
    exclude_resigned: bool = True,
    exclude_directory: bool = True,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("attendance.admin")),
):
    today = datetime.now(KST).date()
    week_end = week_start + timedelta(days=6)
    holidays = await _fetch_holidays_in_range(db, week_start, week_end)
    devs = await _fetch_developers(
        db, query,
        exclude_freelancer=exclude_freelancer,
        exclude_resigned=exclude_resigned,
        exclude_directory=exclude_directory,
    )
    att_map = await _fetch_attendance_in_range(db, week_start, week_end)
    leave_map = await _fetch_leaves_in_range(db, week_start, week_end)

    out_devs = []
    for d in devs:
        days = []
        for i in range(7):
            target = week_start + timedelta(days=i)
            sessions = att_map.get((d.id, target), [])
            leave = leave_map.get((d.id, target))
            holiday_name = holidays.get(target)
            state = _state_for_day(
                today=today,
                target=target,
                holiday_name=holiday_name,
                leave=leave,
                sessions=sessions,
                hire_date=d.hire_date,
                resigned_date=d.resigned_date,
            )
            days.append(
                {
                    "date": target.isoformat(),
                    "weekday": i,  # 0=월
                    "state": state,
                    "holiday_name": holiday_name,
                    "leave": leave,
                    "summary": _day_summary(sessions) if sessions else None,
                }
            )
        out_devs.append(
            {
                "developer_id": str(d.id),
                "name": d.name,
                "employment_type": d.employment_type,
                "status": d.status,
                "days": days,
            }
        )
    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "developers": out_devs,
    }


@router.get("/monthly")
async def monthly(
    year: int = Query(...),
    month: int = Query(..., ge=1, le=12),
    query: str | None = None,
    exclude_freelancer: bool = True,
    exclude_resigned: bool = True,
    exclude_directory: bool = True,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("attendance.admin")),
):
    today = datetime.now(KST).date()
    start = date_cls(year, month, 1)
    end = date_cls(year, month, monthrange(year, month)[1])
    holidays = await _fetch_holidays_in_range(db, start, end)
    devs = await _fetch_developers(
        db, query,
        exclude_freelancer=exclude_freelancer,
        exclude_resigned=exclude_resigned,
        exclude_directory=exclude_directory,
    )
    att_map = await _fetch_attendance_in_range(db, start, end)
    leave_map = await _fetch_leaves_in_range(db, start, end)

    days_in_month = (end - start).days + 1
    out_devs = []
    for d in devs:
        days = []
        for offset in range(days_in_month):
            target = start + timedelta(days=offset)
            sessions = att_map.get((d.id, target), [])
            leave = leave_map.get((d.id, target))
            holiday_name = holidays.get(target)
            state = _state_for_day(
                today=today,
                target=target,
                holiday_name=holiday_name,
                leave=leave,
                sessions=sessions,
                hire_date=d.hire_date,
                resigned_date=d.resigned_date,
            )
            days.append(
                {
                    "date": target.isoformat(),
                    "day": target.day,
                    "weekday": target.weekday(),
                    "state": state,
                    "holiday_name": holiday_name,
                    "leave": leave,
                    "summary": _day_summary(sessions) if sessions else None,
                }
            )
        out_devs.append(
            {
                "developer_id": str(d.id),
                "name": d.name,
                "employment_type": d.employment_type,
                "status": d.status,
                "days": days,
            }
        )
    return {
        "year": year,
        "month": month,
        "days_in_month": days_in_month,
        "developers": out_devs,
    }
