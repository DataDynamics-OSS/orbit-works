"""출퇴근 (Attendance) API — 모바일 체크인 + 본인 조회.

Endpoints:
- `GET  /attendance/me/context`  — 체크인 화면 진입 시 컨텍스트 (매핑 worksite + 오늘 체크인 여부)
- `POST /attendance/check-in`     — 체크인 (lat/lng + 선택 사유)
- `GET  /attendance/me/today`     — 오늘 본인 체크인 row (없으면 null)

검증 규칙:
- worksite 매핑이 있고 좌표가 등록돼 있으면 → 거리 계산 + 반경 비교.
- 반경 밖이면 `reason` 필수 (없으면 422).
- 같은 work_date 에 두 번 체크인 시도 → 409 (UNIQUE 제약 위반).

work_date 는 Asia/Seoul 기준 — 자정 직후 체크인이 어느 일자에 속하는지 명확히
하기 위해 클라이언트 시각이 아닌 서버 측에서 결정.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Attendance, Developer, User, Worksite, WorksiteAssignment
from app.schemas.attendance import (
    AttendanceCheckInRequest,
    AttendanceCheckOutRequest,
    AttendanceContext,
    AttendanceOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/attendance", tags=["attendance"])

KST = ZoneInfo("Asia/Seoul")


def _haversine_m(
    lat1: Decimal | float,
    lon1: Decimal | float,
    lat2: Decimal | float,
    lon2: Decimal | float,
) -> int:
    """두 좌표 사이 직선거리(m). 지구를 구로 가정해 평균 반경 6,371,000m 사용.

    출퇴근 반경(보통 50~500m) 비교에 충분한 정확도. PostGIS 도입 전까지 in-Python.
    """
    lat1, lon1, lat2, lon2 = float(lat1), float(lon1), float(lat2), float(lon2)
    rad = math.pi / 180.0
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.asin(math.sqrt(a))
    return int(6_371_000 * c)


async def _resolve_assigned_worksite(
    db: AsyncSession, user: User
) -> tuple[Worksite | None, Developer | None]:
    """user → developer → 진행중 worksite 매핑.

    여러 매핑이 있으면 `is_primary=true` 우선, 없으면 가장 최근 시작일.
    end_date 가 NULL 이거나 오늘 이후인 매핑만 후보.
    """
    if user.mapped_developer_id is None:
        return None, None
    developer = (
        await db.execute(
            select(Developer).where(Developer.id == user.mapped_developer_id)
        )
    ).scalar_one_or_none()
    if developer is None:
        return None, None

    today = datetime.now(KST).date()
    rows = list(
        (
            await db.execute(
                select(WorksiteAssignment, Worksite)
                .join(Worksite, Worksite.id == WorksiteAssignment.worksite_id)
                .where(
                    WorksiteAssignment.developer_id == developer.id,
                    Worksite.status == "ACTIVE",
                    WorksiteAssignment.start_date <= today,
                    (
                        (WorksiteAssignment.end_date.is_(None))
                        | (WorksiteAssignment.end_date >= today)
                    ),
                )
                .order_by(
                    WorksiteAssignment.is_primary.desc(),
                    WorksiteAssignment.start_date.desc(),
                )
            )
        ).all()
    )
    if not rows:
        return None, developer
    return rows[0][1], developer


def _to_out(row: Attendance, ws: Worksite | None, dev: Developer | None) -> AttendanceOut:
    out = AttendanceOut.model_validate(row, from_attributes=True)
    if ws is not None:
        out.worksite_name = ws.name
        out.worksite_radius_meters = ws.radius_meters
    if dev is not None:
        out.developer_name = dev.name
    return out


@router.get("/me/context", response_model=AttendanceContext)
async def get_check_in_context(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AttendanceContext:
    """모바일이 출근/퇴근 화면 진입 직전에 호출. 매핑 worksite + 오늘의 세션 N개."""
    worksite, developer = await _resolve_assigned_worksite(db, user)
    today = datetime.now(KST).date()
    rows = list(
        (
            await db.execute(
                select(Attendance)
                .where(
                    Attendance.user_id == user.id, Attendance.work_date == today
                )
                .order_by(Attendance.check_in_at.asc())
            )
        ).scalars()
    )

    return AttendanceContext(
        worksite_id=worksite.id if worksite else None,
        worksite_name=worksite.name if worksite else None,
        worksite_latitude=worksite.latitude if worksite else None,
        worksite_longitude=worksite.longitude if worksite else None,
        worksite_radius_meters=worksite.radius_meters if worksite else None,
        worksite_work_start_time=worksite.work_start_time if worksite else None,
        today_sessions=[_to_out(r, worksite, developer) for r in rows],
    )


@router.get("/me/today", response_model=list[AttendanceOut])
async def get_today(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AttendanceOut]:
    """오늘(KST) 의 출근 세션 배열 — ASC by check_in_at. 비어있을 수 있음."""
    today = datetime.now(KST).date()
    rows = list(
        (
            await db.execute(
                select(Attendance)
                .where(
                    Attendance.user_id == user.id, Attendance.work_date == today
                )
                .order_by(Attendance.check_in_at.asc())
            )
        ).scalars()
    )
    if not rows:
        return []
    worksite, developer = await _resolve_assigned_worksite(db, user)
    return [_to_out(r, worksite, developer) for r in rows]


@router.get("/me/history", response_model=list[AttendanceOut])
async def get_history(
    year: int | None = None,
    month: int | None = None,
    days: int = 30,
    limit: int = 500,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AttendanceOut]:
    """본인 출퇴근 이력 — 최신순(check_in_at DESC).

    필터:
    - `year` + `month` 둘 다 주면 그 달(KST) 의 work_date 만 반환.
    - 그 외엔 최근 `days` 일 (기본 30, 최대 365).
    """
    from calendar import monthrange
    from datetime import date as date_cls, timedelta

    if year is not None and month is not None:
        if not (1 <= month <= 12):
            raise HTTPException(400, "month 는 1~12 범위여야 합니다.")
        if year < 2000 or year > 2100:
            raise HTTPException(400, "year 가 유효하지 않습니다.")
        start = date_cls(year, month, 1)
        end = date_cls(year, month, monthrange(year, month)[1])
    else:
        if days < 1:
            days = 1
        if days > 365:
            days = 365
        today = datetime.now(KST).date()
        end = today
        start = today - timedelta(days=days)

    if limit < 1:
        limit = 1
    if limit > 1000:
        limit = 1000

    rows = list(
        (
            await db.execute(
                select(Attendance)
                .where(
                    Attendance.user_id == user.id,
                    Attendance.work_date >= start,
                    Attendance.work_date <= end,
                )
                .order_by(Attendance.check_in_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    if not rows:
        return []
    worksite, developer = await _resolve_assigned_worksite(db, user)
    return [_to_out(r, worksite, developer) for r in rows]


@router.get("/me/week", response_model=dict)
async def get_week_summary(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """이번 주(월~일) 일자별 출근 요약.

    응답:
      {
        "week_start": "YYYY-MM-DD" (KST 기준 이번 주 월요일),
        "days": [
          { "date": "...", "weekday": 0, "sessions": 1, "minutes": 480 },
          ...
        ]
      }

    minutes = 닫힌 세션 (check_out_at-check_in_at 합) 만 카운트.
    open session 의 진행중 시간은 client 가 별도로 더해 표시.
    """
    from datetime import timedelta

    today = datetime.now(KST).date()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)

    rows = list(
        (
            await db.execute(
                select(Attendance)
                .where(
                    Attendance.user_id == user.id,
                    Attendance.work_date >= monday,
                    Attendance.work_date <= sunday,
                )
                .order_by(Attendance.check_in_at.asc())
            )
        ).scalars()
    )

    by_date: dict[str, dict] = {}
    for r in rows:
        key = r.work_date.isoformat()
        d = by_date.setdefault(
            key, {"sessions": 0, "minutes": 0, "has_open": False}
        )
        d["sessions"] += 1
        if r.check_out_at is None:
            d["has_open"] = True
        else:
            delta = (r.check_out_at - r.check_in_at).total_seconds()
            d["minutes"] += int(delta // 60)

    days = []
    for i in range(7):
        d = monday + timedelta(days=i)
        key = d.isoformat()
        agg = by_date.get(key, {"sessions": 0, "minutes": 0, "has_open": False})
        days.append(
            {
                "date": key,
                "weekday": i,  # 0=월 ... 6=일
                "sessions": agg["sessions"],
                "minutes": agg["minutes"],
                "has_open": agg["has_open"],
            }
        )
    return {
        "week_start": monday.isoformat(),
        "days": days,
    }


async def _find_open_session(db: AsyncSession, user_id) -> Attendance | None:
    """사용자의 열린(check_out_at IS NULL) 세션. 있으면 1개 (partial unique index)."""
    return (
        await db.execute(
            select(Attendance)
            .where(
                Attendance.user_id == user_id,
                Attendance.check_out_at.is_(None),
            )
            .order_by(Attendance.check_in_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


@router.post(
    "/check-in", response_model=AttendanceOut, status_code=status.HTTP_201_CREATED
)
async def check_in(
    payload: AttendanceCheckInRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """출근. 열린 세션이 있으면 409 — 먼저 퇴근 후 재출근하는 흐름."""
    now_kst = datetime.now(KST)
    work_date = now_kst.date()

    # 열린 세션 가드 — partial unique index 가 DB 차원에서도 막아주지만 응답
    # 메시지를 사용자 친화적으로 주기 위해 사전 체크.
    existing_open = await _find_open_session(db, user.id)
    if existing_open is not None:
        raise HTTPException(
            status_code=409,
            detail="현재 출근 중인 세션이 있습니다. 먼저 퇴근해 주세요.",
        )

    worksite, developer = await _resolve_assigned_worksite(db, user)

    distance_m: int | None = None
    within_radius: bool | None = None
    if worksite and worksite.latitude is not None and worksite.longitude is not None:
        distance_m = _haversine_m(
            payload.latitude,
            payload.longitude,
            worksite.latitude,
            worksite.longitude,
        )
        within_radius = distance_m <= worksite.radius_meters

    reason = (payload.reason or "").strip() or None
    if within_radius is False and not reason:
        raise HTTPException(
            status_code=422,
            detail=(
                f"근무지 반경({worksite.radius_meters}m) 밖에서 체크인 중입니다 "
                f"(거리 {distance_m}m). 사유를 입력해 주세요."
            ),
        )

    row = Attendance(
        user_id=user.id,
        developer_id=developer.id if developer else None,
        worksite_id=worksite.id if worksite else None,
        work_date=work_date,
        check_in_at=now_kst,
        check_in_lat=payload.latitude,
        check_in_lng=payload.longitude,
        check_in_distance_m=distance_m,
        check_in_within_radius=within_radius,
        check_in_reason=reason,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        # partial unique index 위반 — 사전 체크 직후 다른 기기에서 race.
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="현재 출근 중인 세션이 있습니다. 먼저 퇴근해 주세요.",
        )
    await db.refresh(row)
    logger.info(
        "출근: user=%s date=%s within_radius=%s distance=%sm worksite=%s",
        user.id, work_date, within_radius, distance_m,
        worksite.id if worksite else None,
    )
    return _to_out(row, worksite, developer)


@router.post("/check-out", response_model=AttendanceOut)
async def check_out(
    payload: AttendanceCheckOutRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """퇴근 — 사용자의 가장 최근 열린 세션에 check_out_* 컬럼을 채운다.

    제약:
    - 열린 세션 없음 → 404 (먼저 출근해 주세요).
    - 반경 밖이면 reason 필수 (체크인과 동일 정책).

    work_date 는 출근 시점에 이미 결정돼 있어 야근으로 자정을 넘겨도 그대로 유지.
    """
    now_kst = datetime.now(KST)

    row = await _find_open_session(db, user.id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="열린 출근 기록이 없습니다. 먼저 출근해 주세요.",
        )

    worksite, developer = await _resolve_assigned_worksite(db, user)

    distance_m: int | None = None
    within_radius: bool | None = None
    if worksite and worksite.latitude is not None and worksite.longitude is not None:
        distance_m = _haversine_m(
            payload.latitude,
            payload.longitude,
            worksite.latitude,
            worksite.longitude,
        )
        within_radius = distance_m <= worksite.radius_meters

    reason = (payload.reason or "").strip() or None
    if within_radius is False and not reason:
        raise HTTPException(
            status_code=422,
            detail=(
                f"근무지 반경({worksite.radius_meters}m) 밖에서 퇴근 중입니다 "
                f"(거리 {distance_m}m). 사유를 입력해 주세요."
            ),
        )

    row.check_out_at = now_kst
    row.check_out_lat = payload.latitude
    row.check_out_lng = payload.longitude
    row.check_out_distance_m = distance_m
    row.check_out_within_radius = within_radius
    row.check_out_reason = reason
    await db.commit()
    await db.refresh(row)
    logger.info(
        "퇴근: user=%s session=%s within_radius=%s distance=%sm",
        user.id, row.id, within_radius, distance_m,
    )
    return _to_out(row, worksite, developer)
