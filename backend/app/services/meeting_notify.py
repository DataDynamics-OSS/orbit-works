"""회의 예약 Slack 알림 서비스.

예약 생성/수정/취소 이벤트를 Slack 으로 발송.
`notify_service` 가 활성 provider (Slack/Mattermost) 로 dispatch.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Developer, MeetingReservation, MeetingRoom, User
from app.services.notify import notify_service

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")
WEEKDAYS_KO = ["월", "화", "수", "목", "금", "토", "일"]


def _fmt(dt: datetime) -> str:
    local = dt.astimezone(KST)
    wd = WEEKDAYS_KO[local.weekday()]
    return local.strftime(f"%Y-%m-%d ({wd}) %H:%M")


def _fmt_range(start: datetime, end: datetime) -> str:
    s = start.astimezone(KST)
    e = end.astimezone(KST)
    if s.date() == e.date():
        wd = WEEKDAYS_KO[s.weekday()]
        return (
            f"{s.strftime('%Y-%m-%d')} ({wd}) "
            f"{s.strftime('%H:%M')} ~ {e.strftime('%H:%M')}"
        )
    return f"{_fmt(start)} ~ {_fmt(end)}"


async def _load_full(
    db: AsyncSession, reservation_id
) -> tuple[MeetingReservation, MeetingRoom, User | None, list[Developer]]:
    row = (
        await db.execute(
            select(MeetingReservation)
            .where(MeetingReservation.id == reservation_id)
            .options(
                selectinload(MeetingReservation.room),
                selectinload(MeetingReservation.participants),
            )
        )
    ).scalar_one()
    organizer = None
    if row.organizer_id:
        organizer = (
            await db.execute(select(User).where(User.id == row.organizer_id))
        ).scalar_one_or_none()
    dev_ids = [p.developer_id for p in row.participants]
    participants: list[Developer] = []
    if dev_ids:
        participants = list(
            (
                await db.execute(
                    select(Developer).where(Developer.id.in_(dev_ids))
                )
            ).scalars()
        )
    return row, row.room, organizer, participants


def _developer_email(dev: Developer) -> str | None:
    return dev.company_email or dev.personal_email


def _build_blocks(
    *,
    header: str,
    title: str,
    room: MeetingRoom,
    start: datetime,
    end: datetime,
    organizer: User | None,
    participants: list[Developer],
    description: str | None,
) -> list[dict]:
    participant_names = (
        ", ".join(p.name or _developer_email(p) or "-" for p in participants) or "-"
    )
    room_line = room.name + (f" ({room.location})" if room.location else "")
    fields = [
        {"type": "mrkdwn", "text": f"*회의실*\n{room_line}"},
        {"type": "mrkdwn", "text": f"*시간*\n{_fmt_range(start, end)}"},
        {
            "type": "mrkdwn",
            "text": f"*주최자*\n{organizer.name or organizer.email if organizer else '-'}",
        },
        {"type": "mrkdwn", "text": f"*참석자*\n{participant_names}"},
    ]
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": f"{header}: {title}"}},
        {"type": "section", "fields": fields},
    ]
    if description:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*내용*\n{description}"},
            }
        )
    return blocks


async def _send(
    *,
    db: AsyncSession,
    reservation_id,
    header: str,
    mark_notified: bool = False,
) -> bool:
    reservation, room, organizer, participants = await _load_full(db, reservation_id)

    # 주최자 + 참가자 이메일 합집합 (중복 제거, 빈 이메일 제외)
    emails: list[str] = []
    seen: set[str] = set()
    if organizer and organizer.email and organizer.email not in seen:
        seen.add(organizer.email)
        emails.append(organizer.email)
    for dev in participants:
        email = _developer_email(dev)
        if email and email not in seen:
            seen.add(email)
            emails.append(email)

    if not emails:
        logger.info(
            "meeting_notify: no recipients resolved for reservation=%s", reservation_id
        )
        return False

    text = f"{header}: {reservation.title}"
    blocks = _build_blocks(
        header=header,
        title=reservation.title,
        room=room,
        start=reservation.start_at,
        end=reservation.end_at,
        organizer=organizer,
        participants=participants,
        description=reservation.description,
    )

    # 예약의 tenant 의 notify 설정으로 발송 — multi-tenant 격리.
    delivered = await notify_service.send_for_tenant(
        reservation.tenant_id,
        text=text,
        user_emails=emails,
        blocks=blocks,
        feature="meeting",
    )

    if delivered and mark_notified:
        reservation.notified_at = datetime.now(timezone.utc)
        await db.commit()

    return delivered


async def notify_created(db: AsyncSession, reservation_id) -> bool:
    return await _send(
        db=db,
        reservation_id=reservation_id,
        header="📅 회의 예약 확정",
        mark_notified=True,
    )


async def notify_updated(db: AsyncSession, reservation_id) -> bool:
    return await _send(
        db=db,
        reservation_id=reservation_id,
        header="✏️ 회의 예약 변경",
    )


async def notify_cancelled(db: AsyncSession, reservation_id) -> bool:
    return await _send(
        db=db,
        reservation_id=reservation_id,
        header="🚫 회의 예약 취소",
    )
