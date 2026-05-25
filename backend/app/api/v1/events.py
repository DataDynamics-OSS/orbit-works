"""워크샵·컨퍼런스 (events) API.

Endpoints:
- `GET    /events?year=&kind=`                  목록 (연도·종류 필터, sub 포함)
- `GET    /events/{id}`                          단건
- `POST   /events`                               생성 (flights/lodgings/participants 한 번에)
- `PATCH  /events/{id}`                          수정 (sub 는 전체 교체)
- `DELETE /events/{id}`                          삭제 (cascade + 첨부 디스크 정리)
- `POST   /events/{id}/attachments`              다중 파일 업로드
- `PATCH  /events/{id}/attachments/{aid}`        파일명 변경
- `DELETE /events/{id}/attachments/{aid}`        개별 첨부 삭제

권한:
- 조회 (list / detail / calendar / 첨부 다운로드) — 인증된 모든 사용자 (회사
  일정은 전사 공개). Tenant RLS 로 본인 tenant 의 row 만 격리.
- 관리 (생성·수정·삭제·첨부 추가/수정/삭제) — `events.manage`
  (ADMIN / HR / SUPER_ADMIN).

연도 필터는 overlap 방식 — `start_date <= 12/31 AND end_date >= 1/1`. 해당
연도와 하루라도 겹치면 노출 (연말~연초 이벤트는 양쪽 탭에서 보임).
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.models import (
    Developer,
    Event,
    EventAttachment,
    EventFlight,
    EventLodging,
    EventParticipant,
    User,
)
from app.schemas.event import (
    AttachmentRename,
    EventAttachmentOut,
    EventCreate,
    EventKind,
    EventOut,
    EventUpdate,
    FlightOut,
    LodgingOut,
    ParticipantOut,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/events", tags=["events"])


_ATTACH_ALLOWED_MIME = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic",
    "text/plain", "text/csv",
}


async def _to_out(db: AsyncSession, e: Event) -> EventOut:
    """Event ORM → EventOut. 참석자의 display_name 을 developer 이름으로 채움 + 합계 계산."""
    from app.api.v1.developers import _gender_from_resident

    # developer 이름 + 성별 lookup (raw 주민번호는 노출 X — 'M'/'F' 만 derive).
    dev_ids = {p.developer_id for p in (e.participants or []) if p.developer_id}
    name_by_dev: dict[UUID, str] = {}
    gender_by_dev: dict[UUID, str | None] = {}
    if dev_ids:
        rows = (await db.execute(
            select(Developer.id, Developer.name, Developer.resident_number)
            .where(Developer.id.in_(dev_ids))
        )).all()
        for r in rows:
            name_by_dev[r.id] = r.name
            gender_by_dev[r.id] = _gender_from_resident(r.resident_number)

    flights_total = sum((f.cost for f in (e.flights or [])), Decimal(0))
    lodgings_total = sum((l.cost for l in (e.lodgings or [])), Decimal(0))

    parts: list[ParticipantOut] = []
    for p in (e.participants or []):
        display = name_by_dev.get(p.developer_id) if p.developer_id else (p.guest_name or "")
        parts.append(ParticipantOut(
            id=p.id,
            position=p.position,
            developer_id=p.developer_id,
            guest_name=p.guest_name,
            display_name=display,
            gender=gender_by_dev.get(p.developer_id) if p.developer_id else None,
        ))

    return EventOut(
        id=e.id,
        kind=e.kind,  # type: ignore[arg-type]
        title=e.title,
        address=e.address,
        start_date=e.start_date,
        end_date=e.end_date,
        budget=e.budget,
        actual_cost=e.actual_cost,
        entry_fee=e.entry_fee,
        expenses=e.expenses,
        memo=e.memo,
        plan=e.plan,
        flights=[FlightOut.model_validate(f) for f in (e.flights or [])],
        lodgings=[LodgingOut.model_validate(l) for l in (e.lodgings or [])],
        participants=parts,
        attachments=[EventAttachmentOut.model_validate(a) for a in (e.attachments or [])],
        flights_total=flights_total,
        lodgings_total=lodgings_total,
        grand_total=flights_total + lodgings_total,
        created_at=e.created_at,
        updated_at=e.updated_at,
        created_by=e.created_by,
    )


def _validate_participants(participants) -> None:
    """developer_id 또는 guest_name 둘 중 하나는 반드시. 둘 다 비면 400."""
    for p in participants:
        if not p.developer_id and not (p.guest_name or "").strip():
            raise HTTPException(
                status_code=400,
                detail="참석자는 developer_id 또는 guest_name 중 하나를 지정해야 합니다.",
            )


async def _get_or_404(db: AsyncSession, event_id: UUID) -> Event:
    row = (await db.execute(
        select(Event)
        .options(
            selectinload(Event.flights),
            selectinload(Event.lodgings),
            selectinload(Event.participants),
            selectinload(Event.attachments),
        )
        .where(Event.id == event_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Event 를 찾을 수 없습니다.")
    return row


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


class EventCalendarRow(BaseModel):
    """캘린더 표시 전용 라이트 응답.

    모든 인증 사용자가 조회 가능 (사이드바 > 일정 표시용).
    민감 필드 (예산·항공권·숙박·참석자·첨부) 는 포함되지 않으며,
    상세 페이지(`GET /{event_id}`) 와 등록·편집은 events.manage 그대로.
    """

    id: UUID
    title: str
    kind: EventKind
    start_date: date
    end_date: date

    class Config:
        from_attributes = True


@router.get("/calendar", response_model=list[EventCalendarRow])
async def list_events_for_calendar(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),  # 모든 인증 사용자
    year: int | None = None,
    kind: EventKind | None = None,
):
    """`/calendar` 페이지용 — 워크샵·컨퍼런스·출장을 모든 임직원에게 노출.

    민감 정보 없이 id/title/kind/start_date/end_date 만. 상세 페이지(`GET
    /{event_id}`) 도 read-only 로 모든 인증 사용자에게 열려 있음 (이벤트
    sidebar 의 read-only 다이얼로그용).
    """
    q = select(Event).order_by(Event.start_date.desc())
    if year is not None:
        # overlap — 해당 연도와 하루라도 겹치면 표시 (연말 ~ 연초 이벤트
        # 양쪽 탭에서 보이도록). start_date <= 12/31 AND end_date >= 1/1.
        q = q.where(
            Event.start_date <= date(year, 12, 31),
            Event.end_date   >= date(year,  1,  1),
        )
    if kind:
        q = q.where(Event.kind == kind)
    rows = list((await db.execute(q)).scalars())
    return [
        EventCalendarRow(
            id=e.id,
            title=e.title,
            kind=e.kind,
            start_date=e.start_date,
            end_date=e.end_date,
        )
        for e in rows
    ]


@router.get("", response_model=list[EventOut])
async def list_events(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),  # 조회 — 모든 인증 사용자
    year: int | None = None,
    kind: EventKind | None = None,
):
    q = (
        select(Event)
        .options(
            selectinload(Event.flights),
            selectinload(Event.lodgings),
            selectinload(Event.participants),
            selectinload(Event.attachments),
        )
        .order_by(Event.start_date.desc(), Event.created_at.desc())
    )
    if year is not None:
        # overlap — start_date <= 12/31 AND end_date >= 1/1.
        # 시작일만 비교하던 이전 방식은 12/30 시작·1/3 종료 이벤트를
        # 다음 연도 탭에서 누락. 종료일 검사 추가로 양쪽 모두 노출.
        q = q.where(
            Event.start_date <= date(year, 12, 31),
            Event.end_date   >= date(year,  1,  1),
        )
    if kind:
        q = q.where(Event.kind == kind)
    rows = list((await db.execute(q)).scalars())
    return [await _to_out(db, e) for e in rows]


@router.get("/{event_id}", response_model=EventOut)
async def get_event(
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),  # 조회 — 모든 인증 사용자
):
    e = await _get_or_404(db, event_id)
    return await _to_out(db, e)


@router.post("", response_model=EventOut, status_code=status.HTTP_201_CREATED)
async def create_event(
    payload: EventCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("events.manage")),
):
    _validate_participants(payload.participants)

    e = Event(
        kind=payload.kind,
        title=payload.title,
        address=payload.address,
        start_date=payload.start_date,
        end_date=payload.end_date,
        budget=payload.budget,
        actual_cost=payload.actual_cost,
        entry_fee=payload.entry_fee,
        expenses=payload.expenses,
        memo=payload.memo,
        plan=payload.plan,
        created_by=user.id,
    )
    for idx, f in enumerate(payload.flights):
        e.flights.append(EventFlight(**{**f.model_dump(), "position": f.position or idx}))
    for idx, l in enumerate(payload.lodgings):
        e.lodgings.append(EventLodging(**{**l.model_dump(), "position": l.position or idx}))
    for idx, p in enumerate(payload.participants):
        e.participants.append(EventParticipant(**{**p.model_dump(), "position": p.position or idx}))
    db.add(e)
    await db.commit()
    e = await _get_or_404(db, e.id)
    logger.info(
        "이벤트 생성: id=%s kind=%s title=%s flights=%d lodgings=%d participants=%d (생성자=%s)",
        e.id, e.kind, e.title,
        len(payload.flights), len(payload.lodgings), len(payload.participants), user.id,
    )
    return await _to_out(db, e)


@router.patch("/{event_id}", response_model=EventOut)
async def update_event(
    event_id: UUID,
    payload: EventUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("events.manage")),
):
    e = await _get_or_404(db, event_id)
    data = payload.model_dump(exclude_unset=True, exclude={"flights", "lodgings", "participants"})
    for k, v in data.items():
        setattr(e, k, v)

    # sub 는 전체 교체 (다이얼로그가 통째로 보내므로). 기존 row 제거 + 신규 add.
    if payload.flights is not None:
        for old in list(e.flights):
            await db.delete(old)
        await db.flush()
        for idx, f in enumerate(payload.flights):
            e.flights.append(EventFlight(**{**f.model_dump(), "position": f.position or idx}))
    if payload.lodgings is not None:
        for old in list(e.lodgings):
            await db.delete(old)
        await db.flush()
        for idx, l in enumerate(payload.lodgings):
            e.lodgings.append(EventLodging(**{**l.model_dump(), "position": l.position or idx}))
    if payload.participants is not None:
        _validate_participants(payload.participants)
        for old in list(e.participants):
            await db.delete(old)
        await db.flush()
        for idx, p in enumerate(payload.participants):
            e.participants.append(EventParticipant(**{**p.model_dump(), "position": p.position or idx}))

    await db.commit()
    e = await _get_or_404(db, event_id)
    logger.info(
        "이벤트 수정: id=%s 변경필드=%s (수정자=%s)",
        event_id, list(data.keys()) + (
            ["flights"] if payload.flights is not None else []
        ) + (
            ["lodgings"] if payload.lodgings is not None else []
        ) + (
            ["participants"] if payload.participants is not None else []
        ), user.id,
    )
    return await _to_out(db, e)


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_event(
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("events.manage")),
):
    e = await _get_or_404(db, event_id)
    title = e.title
    att_count = len(e.attachments or [])
    for a in e.attachments or []:
        delete_file(a.file_path)
    await db.delete(e)
    await db.commit()
    logger.info(
        "이벤트 삭제: id=%s title=%s 첨부=%d (삭제자=%s)",
        event_id, title, att_count, user.id,
    )


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post("/{event_id}/attachments", response_model=EventOut)
async def upload_attachments(
    event_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("events.manage")),
):
    e = await _get_or_404(db, event_id)
    if not files:
        raise HTTPException(status_code=400, detail="업로드할 파일이 없습니다.")
    total_size = 0
    for f in files:
        mime = (f.content_type or "").lower()
        if mime not in _ATTACH_ALLOWED_MIME:
            raise HTTPException(
                status_code=400,
                detail=f"지원하지 않는 형식: {f.filename} ({mime})",
            )
        path, size = await save_upload(f, f"events/{e.id}")
        total_size += size
        db.add(EventAttachment(
            event_id=e.id,
            file_name=f.filename or "attachment",
            file_path=path,
            mime_type=mime,
            size=size,
        ))
    await db.commit()
    e = await _get_or_404(db, event_id)
    logger.info(
        "이벤트 첨부 업로드: id=%s files=%d total=%dKB (업로드자=%s)",
        event_id, len(files), total_size // 1024, user.id,
    )
    return await _to_out(db, e)


@router.get("/{event_id}/attachments/{att_id}")
async def download_attachment(
    event_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),  # 첨부 다운로드 — 모든 인증 사용자
):
    att = (await db.execute(
        select(EventAttachment).where(
            EventAttachment.id == att_id, EventAttachment.event_id == event_id,
        )
    )).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        media_type=att.mime_type or "application/octet-stream",
        filename=att.file_name,
    )


@router.patch("/{event_id}/attachments/{att_id}", response_model=EventAttachmentOut)
async def rename_attachment(
    event_id: UUID,
    att_id: UUID,
    payload: AttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("events.manage")),
):
    """파일명만 변경 — 디스크 파일은 그대로, DB 의 file_name 만 update."""
    att = (await db.execute(
        select(EventAttachment).where(
            EventAttachment.id == att_id, EventAttachment.event_id == event_id,
        )
    )).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    new_name = (payload.file_name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="파일명이 비어 있습니다.")
    att.file_name = new_name
    await db.commit()
    await db.refresh(att)
    logger.info(
        "이벤트 첨부 이름 변경: id=%s att=%s name=%s (수정자=%s)",
        event_id, att_id, new_name, user.id,
    )
    return EventAttachmentOut.model_validate(att)


@router.delete("/{event_id}/attachments/{att_id}", response_model=EventOut)
async def delete_attachment(
    event_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("events.manage")),
):
    att = (await db.execute(
        select(EventAttachment).where(
            EventAttachment.id == att_id, EventAttachment.event_id == event_id,
        )
    )).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    file_name = att.file_name
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    logger.info(
        "이벤트 첨부 삭제: id=%s att=%s name=%s (삭제자=%s)",
        event_id, att_id, file_name, user.id,
    )
    e = await _get_or_404(db, event_id)
    return await _to_out(db, e)
