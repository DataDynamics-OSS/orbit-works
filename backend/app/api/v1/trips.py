"""출장 일정 API.

Endpoints:
  GET    /trips                          내 출장 목록
  POST   /trips                          새 출장 생성
  GET    /trips/{id}                     단건 (events 포함)
  PATCH  /trips/{id}                     출장 메타 수정
  DELETE /trips/{id}                     출장 삭제 (events cascade)
  POST   /trips/{id}/events              일정 추가
  PATCH  /trips/{id}/events/{eid}        일정 수정
  DELETE /trips/{id}/events/{eid}        일정 삭제

권한: 본인 출장만 조회·수정. ADMIN/HR 도 타인 출장에는 손대지 않는다 — 개인
일정 성격이 강해 의도적 폐쇄.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Trip, TripEvent, User
from app.schemas.trip import (
    TRIP_EVENT_KINDS,
    TripCreate,
    TripEventCreate,
    TripEventOut,
    TripEventUpdate,
    TripOut,
    TripUpdate,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/trips", tags=["trips"])


def _to_out(trip: Trip, owner_name: str | None) -> TripOut:
    return TripOut(
        id=trip.id,
        name=trip.name,
        start_date=trip.start_date,
        end_date=trip.end_date,
        origin_tz=trip.origin_tz,
        destination_tz=trip.destination_tz,
        origin_iata=trip.origin_iata,
        destination_iata=trip.destination_iata,
        owner_user_id=trip.owner_user_id,
        owner_name=owner_name,
        notes=trip.notes,
        prep_notes=trip.prep_notes,
        created_at=trip.created_at,
        updated_at=trip.updated_at,
        events=[TripEventOut.model_validate(e) for e in trip.events],
    )


async def _load_trip(
    db: AsyncSession, trip_id: UUID, user: User, *, with_events: bool = True
) -> Trip:
    stmt = select(Trip).where(Trip.id == trip_id, Trip.owner_user_id == user.id)
    if with_events:
        stmt = stmt.options(selectinload(Trip.events))
    trip = (await db.execute(stmt)).scalar_one_or_none()
    if trip is None:
        raise HTTPException(status_code=404, detail="출장을 찾을 수 없습니다.")
    return trip


@router.get("", response_model=list[TripOut])
async def list_trips(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 출장 목록 — 시작일 내림차순."""
    rows = list(
        (
            await db.execute(
                select(Trip)
                .where(Trip.owner_user_id == user.id)
                .options(selectinload(Trip.events))
                .order_by(Trip.start_date.desc(), Trip.created_at.desc())
            )
        )
        .scalars()
    )
    return [_to_out(t, user.name) for t in rows]


@router.post("", response_model=TripOut, status_code=status.HTTP_201_CREATED)
async def create_trip(
    payload: TripCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="종료일이 시작일보다 빠릅니다.")
    trip = Trip(
        name=payload.name.strip(),
        start_date=payload.start_date,
        end_date=payload.end_date,
        origin_tz=payload.origin_tz,
        destination_tz=payload.destination_tz,
        origin_iata=payload.origin_iata,
        destination_iata=payload.destination_iata,
        owner_user_id=user.id,
        notes=payload.notes,
    )
    db.add(trip)
    await db.commit()
    await db.refresh(trip, ["events"])
    logger.info("출장 생성: id=%s name=%s owner=%s", trip.id, trip.name, user.id)
    return _to_out(trip, user.name)


@router.get("/{trip_id}", response_model=TripOut)
async def get_trip(
    trip_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    trip = await _load_trip(db, trip_id, user)
    return _to_out(trip, user.name)


@router.patch("/{trip_id}", response_model=TripOut)
async def update_trip(
    trip_id: UUID,
    payload: TripUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    trip = await _load_trip(db, trip_id, user)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        data["name"] = data["name"].strip()
    for k, v in data.items():
        setattr(trip, k, v)
    if trip.end_date < trip.start_date:
        raise HTTPException(status_code=400, detail="종료일이 시작일보다 빠릅니다.")
    await db.commit()
    await db.refresh(trip, ["events"])
    return _to_out(trip, user.name)


@router.delete("/{trip_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_trip(
    trip_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    trip = await _load_trip(db, trip_id, user, with_events=False)
    await db.delete(trip)
    await db.commit()
    logger.info("출장 삭제: id=%s owner=%s", trip_id, user.id)


def _validate_kind(kind: str) -> str:
    k = (kind or "").strip().upper()
    if k not in TRIP_EVENT_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind 는 {sorted(TRIP_EVENT_KINDS)} 중 하나여야 합니다.",
        )
    return k


def _validate_event_times(start_at, end_at) -> None:
    if end_at < start_at:
        raise HTTPException(status_code=400, detail="종료시각이 시작시각보다 빠릅니다.")


@router.post(
    "/{trip_id}/events",
    response_model=TripEventOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_event(
    trip_id: UUID,
    payload: TripEventCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    trip = await _load_trip(db, trip_id, user, with_events=False)
    kind = _validate_kind(payload.kind)
    _validate_event_times(payload.start_at, payload.end_at)
    ev = TripEvent(
        trip_id=trip.id,
        kind=kind,
        title=payload.title.strip(),
        start_at=payload.start_at,
        end_at=payload.end_at,
        event_tz=payload.event_tz,
        from_iata=payload.from_iata,
        to_iata=payload.to_iata,
        flight_no=payload.flight_no,
        location=payload.location,
        notes=payload.notes,
    )
    db.add(ev)
    await db.commit()
    await db.refresh(ev)
    return TripEventOut.model_validate(ev)


@router.patch("/{trip_id}/events/{event_id}", response_model=TripEventOut)
async def update_event(
    trip_id: UUID,
    event_id: UUID,
    payload: TripEventUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _load_trip(db, trip_id, user, with_events=False)
    ev = (
        await db.execute(
            select(TripEvent).where(
                TripEvent.id == event_id, TripEvent.trip_id == trip_id
            )
        )
    ).scalar_one_or_none()
    if ev is None:
        raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    if "kind" in data and data["kind"] is not None:
        data["kind"] = _validate_kind(data["kind"])
    if "title" in data and data["title"]:
        data["title"] = data["title"].strip()
    for k, v in data.items():
        setattr(ev, k, v)
    _validate_event_times(ev.start_at, ev.end_at)
    await db.commit()
    await db.refresh(ev)
    return TripEventOut.model_validate(ev)


@router.delete(
    "/{trip_id}/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_event(
    trip_id: UUID,
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _load_trip(db, trip_id, user, with_events=False)
    ev = (
        await db.execute(
            select(TripEvent).where(
                TripEvent.id == event_id, TripEvent.trip_id == trip_id
            )
        )
    ).scalar_one_or_none()
    if ev is None:
        raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")
    await db.delete(ev)
    await db.commit()
