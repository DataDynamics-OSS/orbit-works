"""회의실 예약 API.

## Rooms (관리자 전용 write, 조회는 전체)
- GET    /meeting-rooms                            목록
- POST   /meeting-rooms                            생성 (ADMIN)
- PATCH  /meeting-rooms/{rid}                      수정 (ADMIN)
- DELETE /meeting-rooms/{rid}                      삭제 (ADMIN, 미래 예약 있으면 400)

## Reservations
- GET    /meeting-reservations?from=&to=&room_id=&mine=  기간 조회
- GET    /meeting-reservations/{rid}                상세
- POST   /meeting-reservations                      생성 (주최자=나)
- PATCH  /meeting-reservations/{rid}                주최자 또는 ADMIN
- DELETE /meeting-reservations/{rid}                soft cancel (status=CANCELLED)

시간 충돌은 DB 의 EXCLUDE USING gist 제약에서 IntegrityError → 409 로 변환.
Slack 알림은 BackgroundTasks 로 비동기 발송하여 요청 응답을 지연시키지 않는다.
"""

from __future__ import annotations

import logging
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db, system_session
from app.models import (
    Developer,
    MeetingReservation,
    MeetingReservationParticipant,
    MeetingRoom,
    User,
)
from app.schemas.meeting import (
    MeetingReservationCreate,
    MeetingReservationOut,
    MeetingReservationUpdate,
    MeetingRoomCreate,
    MeetingRoomOut,
    MeetingRoomUpdate,
    ReservationParticipantOut,
)
from app.services import meeting_notify

logger = logging.getLogger(__name__)

rooms_router = APIRouter(prefix="/meeting-rooms", tags=["meetings"])
reservations_router = APIRouter(prefix="/meeting-reservations", tags=["meetings"])


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------


@rooms_router.get("", response_model=list[MeetingRoomOut])
async def list_rooms(
    active_only: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(MeetingRoom).order_by(MeetingRoom.name.asc())
    if active_only:
        stmt = stmt.where(MeetingRoom.is_active.is_(True))
    rows = list((await db.execute(stmt)).scalars())
    return [MeetingRoomOut.model_validate(r, from_attributes=True) for r in rows]


@rooms_router.post(
    "", response_model=MeetingRoomOut, status_code=status.HTTP_201_CREATED
)
async def create_room(
    payload: MeetingRoomCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = MeetingRoom(
        name=payload.name,
        location=payload.location,
        capacity=payload.capacity,
        description=payload.description,
        is_active=payload.is_active,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=400, detail=f"'{payload.name}' 회의실이 이미 존재합니다."
        )
    await db.refresh(row)
    logger.info("회의실 등록: %s 작성자=%s", row.name, user.id)
    return MeetingRoomOut.model_validate(row, from_attributes=True)


@rooms_router.patch("/{rid}", response_model=MeetingRoomOut)
async def update_room(
    rid: UUID,
    payload: MeetingRoomUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(MeetingRoom).where(MeetingRoom.id == rid))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Room not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="회의실 이름이 중복됩니다.")
    await db.refresh(row)
    logger.info("회의실 수정: id=%s 수정자=%s", rid, user.id)
    return MeetingRoomOut.model_validate(row, from_attributes=True)


@rooms_router.delete("/{rid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_room(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(MeetingRoom).where(MeetingRoom.id == rid))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Room not found")
    future = (
        await db.execute(
            select(MeetingReservation.id)
            .where(MeetingReservation.room_id == rid)
            .where(MeetingReservation.status == "CONFIRMED")
            .limit(1)
        )
    ).first()
    if future:
        raise HTTPException(
            status_code=400,
            detail="이 회의실에 활성 예약이 남아 있어 삭제할 수 없습니다. 먼저 예약을 취소하세요.",
        )
    await db.delete(row)
    await db.commit()
    logger.warning("회의실 삭제: id=%s name=%s 삭제자=%s", rid, row.name, user.id)


# ---------------------------------------------------------------------------
# Reservations — helpers
# ---------------------------------------------------------------------------


# 회의실 운영 시간 (KST). UI 가 허용하는 범위와 반드시 동일하게 유지.
_KST = ZoneInfo("Asia/Seoul")
_HOUR_START = 8
_HOUR_END = 19  # 종료시각은 19:00 정각까지 허용 (포함).


def _assert_within_business_hours(start_at: datetime, end_at: datetime) -> None:
    s = start_at.astimezone(_KST)
    e = end_at.astimezone(_KST)
    # 같은 날짜여야 한다 (일자를 넘어가는 예약은 운영 시간 안에 들어올 수 없음).
    if s.date() != e.date():
        raise HTTPException(
            status_code=400,
            detail=f"예약은 하루 안에서 오전 {_HOUR_START:02d}:00 ~ 저녁 {_HOUR_END:02d}:00 (KST) 사이여야 합니다.",
        )
    start_minutes = s.hour * 60 + s.minute
    end_minutes = e.hour * 60 + e.minute
    if start_minutes < _HOUR_START * 60 or end_minutes > _HOUR_END * 60:
        raise HTTPException(
            status_code=400,
            detail=f"회의실 예약 시간은 오전 {_HOUR_START:02d}:00 ~ 저녁 {_HOUR_END:02d}:00 (KST) 로 제한됩니다.",
        )


def _assert_can_edit(res: MeetingReservation, user: User) -> None:
    if user.role == "ADMIN":
        return
    if res.organizer_id == user.id:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="주최자 또는 관리자만 수정/취소할 수 있습니다.",
    )


async def _serialize(
    db: AsyncSession, res: MeetingReservation
) -> MeetingReservationOut:
    room = (
        await db.execute(select(MeetingRoom).where(MeetingRoom.id == res.room_id))
    ).scalar_one()
    organizer = None
    if res.organizer_id:
        organizer = (
            await db.execute(select(User).where(User.id == res.organizer_id))
        ).scalar_one_or_none()
    dev_ids = [p.developer_id for p in res.participants]
    participants: list[ReservationParticipantOut] = []
    if dev_ids:
        devs = list(
            (
                await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
            ).scalars()
        )
        participants = [
            ReservationParticipantOut(
                developer_id=d.id,
                name=d.name,
                email=d.company_email or d.personal_email,
            )
            for d in devs
        ]
    return MeetingReservationOut(
        id=res.id,
        room_id=res.room_id,
        room_name=room.name,
        organizer_id=res.organizer_id,
        organizer_name=organizer.name if organizer else None,
        title=res.title,
        description=res.description,
        start_at=res.start_at,
        end_at=res.end_at,
        status=res.status,  # type: ignore[arg-type]
        participants=participants,
        created_at=res.created_at,
        updated_at=res.updated_at,
    )


async def _validate_participants(
    db: AsyncSession, developer_ids: list[UUID]
) -> None:
    if not developer_ids:
        return
    found = set(
        (
            await db.execute(
                select(Developer.id).where(
                    Developer.id.in_(developer_ids),
                    Developer.status == "ACTIVE",
                )
            )
        ).scalars()
    )
    missing = [str(u) for u in developer_ids if u not in found]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"존재하지 않거나 비활성인 임직원: {', '.join(missing)}",
        )


# ---------------------------------------------------------------------------
# Reservations — endpoints
# ---------------------------------------------------------------------------


@reservations_router.get("", response_model=list[MeetingReservationOut])
async def list_reservations(
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = None,
    room_id: UUID | None = None,
    mine: bool = False,
    include_cancelled: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(MeetingReservation).options(
        selectinload(MeetingReservation.participants)
    )
    if not include_cancelled:
        stmt = stmt.where(MeetingReservation.status == "CONFIRMED")
    if room_id:
        stmt = stmt.where(MeetingReservation.room_id == room_id)
    if from_ and to:
        stmt = stmt.where(
            and_(
                MeetingReservation.start_at < to,
                MeetingReservation.end_at > from_,
            )
        )
    elif from_:
        stmt = stmt.where(MeetingReservation.end_at > from_)
    elif to:
        stmt = stmt.where(MeetingReservation.start_at < to)
    if mine:
        mine_developer_ids = select(Developer.id).where(
            or_(
                Developer.personal_email == user.email,
                Developer.company_email == user.email,
            )
        )
        mine_cond = or_(
            MeetingReservation.organizer_id == user.id,
            MeetingReservation.id.in_(
                select(MeetingReservationParticipant.reservation_id).where(
                    MeetingReservationParticipant.developer_id.in_(
                        mine_developer_ids
                    )
                )
            ),
        )
        stmt = stmt.where(mine_cond)
    stmt = stmt.order_by(MeetingReservation.start_at.asc())
    rows = list((await db.execute(stmt)).scalars().unique())
    return [await _serialize(db, r) for r in rows]


@reservations_router.get("/{rid}", response_model=MeetingReservationOut)
async def get_reservation(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(MeetingReservation)
            .where(MeetingReservation.id == rid)
            .options(selectinload(MeetingReservation.participants))
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Reservation not found")
    return await _serialize(db, row)


async def _run_notify_bg(reservation_id: UUID, kind: str) -> None:
    """BackgroundTasks 는 별도 DB 세션을 새로 열어야 한다 (요청 세션은 이미 닫힘)."""
    async with system_session() as db:
        try:
            if kind == "created":
                await meeting_notify.notify_created(db, reservation_id)
            elif kind == "updated":
                await meeting_notify.notify_updated(db, reservation_id)
            elif kind == "cancelled":
                await meeting_notify.notify_cancelled(db, reservation_id)
        except Exception as exc:
            logger.warning(
                "meeting_notify(%s) failed for %s: %s", kind, reservation_id, exc,
                exc_info=True,
            )


@reservations_router.post(
    "", response_model=MeetingReservationOut, status_code=status.HTTP_201_CREATED
)
async def create_reservation(
    payload: MeetingReservationCreate,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    room = (
        await db.execute(
            select(MeetingRoom).where(MeetingRoom.id == payload.room_id)
        )
    ).scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if not room.is_active:
        raise HTTPException(status_code=400, detail="비활성 회의실에는 예약할 수 없습니다.")

    _assert_within_business_hours(payload.start_at, payload.end_at)
    await _validate_participants(db, payload.participant_developer_ids)

    row = MeetingReservation(
        room_id=payload.room_id,
        organizer_id=user.id,
        title=payload.title,
        description=payload.description,
        start_at=payload.start_at,
        end_at=payload.end_at,
        status="CONFIRMED",
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="해당 시간대에 이미 예약이 있습니다."
        )

    for did in payload.participant_developer_ids:
        db.add(
            MeetingReservationParticipant(reservation_id=row.id, developer_id=did)
        )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="해당 시간대에 이미 예약이 있습니다."
        )
    await db.refresh(row, ["participants"])
    logger.info(
        "회의 예약 생성: id=%s room=%s %s~%s 주최자=%s 참가자=%d",
        row.id,
        room.name,
        row.start_at,
        row.end_at,
        user.id,
        len(payload.participant_developer_ids),
    )

    bg.add_task(_run_notify_bg, row.id, "created")
    return await _serialize(db, row)


@reservations_router.patch("/{rid}", response_model=MeetingReservationOut)
async def update_reservation(
    rid: UUID,
    payload: MeetingReservationUpdate,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(MeetingReservation)
            .where(MeetingReservation.id == rid)
            .options(selectinload(MeetingReservation.participants))
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Reservation not found")
    _assert_can_edit(row, user)

    data = payload.model_dump(exclude_unset=True)
    participant_ids = data.pop("participant_developer_ids", None)

    # start/end 범위 교차검증 (둘 중 하나만 바꾸는 경우)
    new_start = data.get("start_at", row.start_at)
    new_end = data.get("end_at", row.end_at)
    if new_end <= new_start:
        raise HTTPException(status_code=400, detail="end_at 은 start_at 보다 커야 합니다.")
    if "start_at" in data or "end_at" in data:
        _assert_within_business_hours(new_start, new_end)

    status_changed_to_cancelled = (
        data.get("status") == "CANCELLED" and row.status != "CANCELLED"
    )

    for k, v in data.items():
        setattr(row, k, v)

    if participant_ids is not None:
        await _validate_participants(db, participant_ids)
        # 기존 참가자 전체 제거 후 재삽입 (간단/안전).
        for p in list(row.participants):
            await db.delete(p)
        await db.flush()
        for did in participant_ids:
            db.add(
                MeetingReservationParticipant(
                    reservation_id=row.id, developer_id=did
                )
            )

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="해당 시간대에 이미 예약이 있습니다."
        )
    await db.refresh(row, ["participants"])
    logger.info("회의 예약 수정: id=%s 수정자=%s 변경=%s", rid, user.id, list(data.keys()))

    kind = "cancelled" if status_changed_to_cancelled else "updated"
    bg.add_task(_run_notify_bg, row.id, kind)
    return await _serialize(db, row)


@reservations_router.delete("/{rid}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_reservation(
    rid: UUID,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(MeetingReservation).where(MeetingReservation.id == rid)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Reservation not found")
    _assert_can_edit(row, user)
    if row.status == "CANCELLED":
        return
    row.status = "CANCELLED"
    await db.commit()
    logger.warning("회의 예약 취소: id=%s 취소자=%s", rid, user.id)
    bg.add_task(_run_notify_bg, row.id, "cancelled")
