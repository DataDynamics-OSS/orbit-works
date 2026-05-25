"""Alarm API — ADMIN 전용 Slack 리마인더 CRUD.

Endpoints:
- `GET    /alarms`                    — 목록 (최신 수정순) + 각 항목에 다음 실행 시각 부착
- `GET    /alarms/{id}`               — 단건
- `POST   /alarms`                    — 생성 (스케줄 검증 + APScheduler job 등록)
- `PATCH  /alarms/{id}`               — 수정 (job 재등록 — 필드 변경 즉시 반영)
- `DELETE /alarms/{id}`               — 삭제 (job 제거, AlarmSend cascade)
- `POST   /alarms/{id}/test`          — 수동 테스트 발송 (스케줄·영업일 검사 무시)
- `GET    /alarms/{id}/sends`         — 발송 이력 (최근 7일)

크로스 필드 정합성(`schedule_kind` 별 필수 필드, 수신처 최소 1개) 은 `_validate_*`
헬퍼에서 검사해 400 응답에 명확한 한글 에러 메시지를 반환.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.core.database import get_db
from app.models import Alarm, AlarmSend, User
from app.schemas.alarm import (
    AlarmCreate,
    AlarmOut,
    AlarmSendOut,
    AlarmUpdate,
)
from app.services.alarm import (
    next_run_at,
    remove_alarm_job,
    run_alarm_now,
    sync_alarm_job,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/alarms", tags=["alarms"])


# ---------------------------------------------------------------------------
# 검증 헬퍼
# ---------------------------------------------------------------------------


def _validate_schedule(payload: dict) -> None:
    """schedule_kind 별 필수 필드 체크. 위반 시 HTTPException(400).

    Pydantic 의 필드 범위 검증(0-23 등) 통과 후에 호출.
    """
    kind = payload.get("schedule_kind")
    if kind is None:
        raise HTTPException(400, "schedule_kind 는 필수입니다.")
    if kind == "ONE_TIME":
        if not payload.get("one_time_at"):
            raise HTTPException(400, "ONE_TIME 은 one_time_at 이 필요합니다.")
        return
    # 이하 공통: hour/minute.
    if payload.get("hour") is None or payload.get("minute") is None:
        raise HTTPException(400, f"{kind} 은 hour/minute 이 필요합니다.")
    if kind == "WEEKLY":
        wds = payload.get("weekdays")
        if not wds:
            raise HTTPException(400, "WEEKLY 는 요일(weekdays) 1개 이상이 필요합니다.")
        for w in wds:
            if not (0 <= int(w) <= 6):
                raise HTTPException(400, "weekdays 는 0(월)~6(일) 범위여야 합니다.")
        return
    if kind == "MONTHLY":
        if not payload.get("day_of_month"):
            raise HTTPException(400, "MONTHLY 는 day_of_month 가 필요합니다.")
        return
    if kind == "YEARLY":
        if not payload.get("day_of_month") or not payload.get("month_of_year"):
            raise HTTPException(
                400, "YEARLY 는 month_of_year 와 day_of_month 가 모두 필요합니다."
            )
        return
    if kind != "DAILY":
        raise HTTPException(400, f"알 수 없는 schedule_kind: {kind}")


def _validate_recipients(payload: dict) -> None:
    """수신처 최소 1개 — Slack 채널 또는 담당자."""
    channel = (payload.get("slack_channel") or "").strip()
    devs = payload.get("recipient_developer_ids") or []
    if not channel and not devs:
        raise HTTPException(
            400, "Slack 채널 또는 담당자 중 최소 1개의 수신처가 필요합니다."
        )


async def _serialize(alarm: Alarm) -> AlarmOut:
    """AlarmOut + next_run_at (APScheduler 조회)."""
    data = AlarmOut.model_validate(alarm)
    data.next_run_at = await next_run_at(alarm.id)
    return data


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[AlarmOut])
async def list_alarms(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    rows = list(
        (
            await db.execute(select(Alarm).order_by(desc(Alarm.updated_at)))
        ).scalars()
    )
    return [await _serialize(a) for a in rows]


@router.get("/{alarm_id}", response_model=AlarmOut)
async def get_alarm(
    alarm_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    alarm = (
        await db.execute(select(Alarm).where(Alarm.id == alarm_id))
    ).scalar_one_or_none()
    if alarm is None:
        raise HTTPException(404, "알람을 찾을 수 없습니다.")
    return await _serialize(alarm)


@router.post("", response_model=AlarmOut, status_code=status.HTTP_201_CREATED)
async def create_alarm(
    payload: AlarmCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    data = payload.model_dump()
    _validate_schedule(data)
    _validate_recipients(data)
    alarm = Alarm(**data, created_by=user.id)
    db.add(alarm)
    await db.commit()
    await db.refresh(alarm)
    sync_alarm_job(alarm)
    logger.info(
        "알람 등록: id=%s title=%s kind=%s (등록자=%s)",
        alarm.id, alarm.title, alarm.schedule_kind, user.id,
    )
    return await _serialize(alarm)


@router.patch("/{alarm_id}", response_model=AlarmOut)
async def update_alarm(
    alarm_id: UUID,
    payload: AlarmUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    alarm = (
        await db.execute(select(Alarm).where(Alarm.id == alarm_id))
    ).scalar_one_or_none()
    if alarm is None:
        raise HTTPException(404, "알람을 찾을 수 없습니다.")

    update_data = payload.model_dump(exclude_unset=True)
    # 크로스-필드 검증을 위해 merged 상태로 검사.
    merged = {
        "schedule_kind": update_data.get("schedule_kind", alarm.schedule_kind),
        "one_time_at": update_data.get("one_time_at", alarm.one_time_at),
        "hour": update_data.get("hour", alarm.hour),
        "minute": update_data.get("minute", alarm.minute),
        "weekdays": update_data.get("weekdays", alarm.weekdays),
        "day_of_month": update_data.get("day_of_month", alarm.day_of_month),
        "month_of_year": update_data.get("month_of_year", alarm.month_of_year),
        "slack_channel": update_data.get("slack_channel", alarm.slack_channel),
        "recipient_developer_ids": update_data.get(
            "recipient_developer_ids", alarm.recipient_developer_ids
        ),
    }
    _validate_schedule(merged)
    _validate_recipients(merged)

    for k, v in update_data.items():
        setattr(alarm, k, v)
    await db.commit()
    await db.refresh(alarm)
    # 필드가 하나라도 바뀌면 job 재등록 — enabled 변경 포함.
    sync_alarm_job(alarm)
    logger.info(
        "알람 수정: id=%s 변경필드=%s (수정자=%s)",
        alarm.id, list(update_data.keys()), user.id,
    )
    return await _serialize(alarm)


@router.delete("/{alarm_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_alarm(
    alarm_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    alarm = (
        await db.execute(select(Alarm).where(Alarm.id == alarm_id))
    ).scalar_one_or_none()
    if alarm is None:
        raise HTTPException(404, "알람을 찾을 수 없습니다.")
    logger.warning(
        "알람 삭제: id=%s title=%s (삭제자=%s)", alarm.id, alarm.title, user.id
    )
    await db.delete(alarm)
    await db.commit()
    remove_alarm_job(alarm_id)


@router.post("/{alarm_id}/test", response_model=AlarmSendOut)
async def test_alarm(
    alarm_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """"지금 테스트 발송" — 저장된 메시지·수신처 그대로 1회 발송. 이력 기록됨."""
    alarm = (
        await db.execute(select(Alarm).where(Alarm.id == alarm_id))
    ).scalar_one_or_none()
    if alarm is None:
        raise HTTPException(404, "알람을 찾을 수 없습니다.")
    send = await run_alarm_now(db, alarm, triggered_by_user_id=user.id)
    return AlarmSendOut.model_validate(send)


@router.get("/{alarm_id}/sends", response_model=list[AlarmSendOut])
async def list_alarm_sends(
    alarm_id: UUID,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    rows = list(
        (
            await db.execute(
                select(AlarmSend)
                .where(AlarmSend.alarm_id == alarm_id)
                .order_by(desc(AlarmSend.created_at))
                .limit(limit)
            )
        ).scalars()
    )
    return [AlarmSendOut.model_validate(r) for r in rows]
