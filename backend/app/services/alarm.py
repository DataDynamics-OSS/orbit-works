"""Alarm runner — APScheduler 와 Slack 전송 사이의 접착층.

책임:
1. APScheduler 에 DB 의 모든 `enabled=true` alarm 을 job 으로 등록/갱신/제거
   (`sync_alarm_job`, `sync_all_alarm_jobs`).
2. 트리거 콜백(`_run_alarm`) — 해당 시각에:
   - 활성 기간(`active_from`/`active_to`) 검사 → 벗어나면 SKIPPED_INACTIVE.
   - 공휴일/주말이면 **직전 영업일**로 이동 (`_shift_to_previous_working_day`).
   - Slack 전송 (채널 + 담당자 DM). 결과를 `alarms.last_*`, `alarm_sends` 에 기록.
   - ONE_TIME 이면 성공·실패 관계없이 `enabled=false` 로 전환 후 job 제거.
3. 수동 테스트 발송(`run_alarm_now`) — 같은 발송 경로를 `manual=True` 로 재사용.
4. 이력 정리(`purge_old_alarm_sends`) — 7일 이전 행 삭제 (1일 1회 스케줄 job).

SHIFT_BEFORE 규칙:
- 원래 트리거 시각의 날짜를 day0 으로 놓고, day0 이 주말 또는 holidays 테이블
  에 등재된 날이면 day0-1, day0-2, ... 순으로 거슬러 올라가 첫 영업일을 찾는다.
- 하루 중 시각(시/분)은 그대로 유지 — 09:00 알람이라면 직전 영업일 09:00 으로 발송.
- ONE_TIME 의 경우 트리거 자체가 이미 지난 시각이라 스케줄러가 fire 하므로,
  실행 시점에 시각을 앞으로 이동할 순 없다 → 그 경우엔 shift 하지 않고 즉시 발송.
- DAILY 도 shift 하면 연속된 두 평일에 발송될 수 있어 의미 없음 → shift 스킵.
- WEEKLY 는 사용자가 요일을 명시했으므로 shift 시 다른 요일로 가게 되어 혼란
  → shift 스킵 (대신 해당 회차만 SKIPPED_HOLIDAY 처리할 수도 있으나 MVP 는
  그대로 발송).
- **shift 의 주 타겟은 MONTHLY · YEARLY** — "매월 20일 급여 준비" 같은 날짜 기반
  일정이 주말/공휴일에 걸리면 전 영업일로 이동.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone as _tz
from typing import Any
from uuid import UUID

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import system_session
from app.models import Alarm, AlarmSend, Developer, Holiday
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 영업일 계산
# ---------------------------------------------------------------------------


async def _is_non_working_day(db: AsyncSession, d: date) -> bool:
    """주말(토/일) 또는 `holidays` 등재일이면 True.

    `holidays.type` 5종 중 STATUTORY/TEMPORARY/COMPANY 만 휴일로 간주.
    EVENT_PUBLIC / EVENT_PRIVATE 는 단순 캘린더 일정이라 영업일 판정 X.
    """
    # date.weekday(): 0=월 ~ 6=일. 5=토, 6=일.
    if d.weekday() >= 5:
        return True
    exists = (
        await db.execute(
            select(Holiday.id)
            .where(
                Holiday.date == d,
                Holiday.type.in_(("STATUTORY", "TEMPORARY", "COMPANY")),
            )
            .limit(1)
        )
    ).first()
    return exists is not None


async def _shift_to_previous_working_day(db: AsyncSession, d: date) -> date:
    """d 가 공휴일/주말이면 직전 영업일을 반환. 이미 영업일이면 그대로.

    최대 14일을 거슬러 검사 — 연휴가 2주를 넘어가는 일은 현실적으로 없음.
    """
    cursor = d
    for _ in range(14):
        if not await _is_non_working_day(db, cursor):
            return cursor
        cursor -= timedelta(days=1)
    # 안전망 — 14일 연속 휴일이면 그대로 반환.
    logger.warning("영업일 탐색 실패: %s 시작 14일 모두 휴일로 판정. 원본 반환.", d)
    return d


# ---------------------------------------------------------------------------
# Slack 전송 + 실행 이력 기록
# ---------------------------------------------------------------------------


async def _collect_recipient_emails(
    db: AsyncSession, developer_ids: list[UUID] | None
) -> tuple[list[str], list[str]]:
    """developers.id[] → (company_email 리스트, 이름 리스트).

    company_email 이 비어 있는 임직원(프리랜서 등) 은 제외. 이름 리스트는
    recipients_summary 기록용.
    """
    if not developer_ids:
        return [], []
    rows = (
        await db.execute(
            select(Developer.name, Developer.company_email).where(
                Developer.id.in_(developer_ids)
            )
        )
    ).all()
    emails: list[str] = []
    names: list[str] = []
    for name, email in rows:
        if email:
            emails.append(email)
            names.append(name)
    return emails, names


def _recipients_summary(channel: str | None, names: list[str]) -> str:
    parts: list[str] = []
    if channel:
        parts.append(channel)
    if names:
        parts.append(", ".join(names))
    return " + ".join(parts) if parts else "(수신처 없음)"


async def _deliver(
    db: AsyncSession,
    alarm: Alarm,
    *,
    scheduled_at: datetime,
    manual: bool,
) -> tuple[bool, str | None, str]:
    """Slack 전송 실행. 결과는 (success, error_msg, recipients_summary).

    Slack 비활성이거나 수신처 resolution 이 모두 실패해도 예외를 던지지 않고
    False + 사유 문자열을 반환 — 실행 이력(alarm_sends)이 예외로 유실되지 않도록.
    """
    emails, names = await _collect_recipient_emails(db, alarm.recipient_developer_ids)
    channels = [alarm.slack_channel] if alarm.slack_channel else []
    summary = _recipients_summary(alarm.slack_channel, names)

    if not channels and not emails:
        return False, "수신처가 비어 있습니다 (채널·담당자 모두 미지정)", summary

    try:
        # alarm.tenant_id 의 notify 설정으로 발송 (provider/토큰/채널) — multi-tenant
        # 격리. 글로벌 fallback 은 send_for_tenant 안에서 tenant=None 시에만.
        ok = await notify_service.send_for_tenant(
            alarm.tenant_id,
            alarm.message,
            channels=channels or None,
            user_emails=emails or None,
            feature="alarm",
        )
    except Exception as exc:  # pragma: no cover — 방어적
        logger.warning("알람 발송 예외: alarm=%s", alarm.id, exc_info=True)
        return False, f"알람 발송 예외: {exc}", summary

    if not ok:
        return False, "알람 발송 실패 (notify.enabled=false 또는 API 에러)", summary
    return True, None, summary


async def _record_send(
    db: AsyncSession,
    alarm: Alarm,
    *,
    scheduled_at: datetime,
    sent_at: datetime | None,
    status: str,
    error: str | None,
    summary: str,
    manual: bool,
) -> None:
    """alarm_sends 한 행 추가 + alarms.last_* / sent_count 갱신."""
    db.add(
        AlarmSend(
            alarm_id=alarm.id,
            scheduled_at=scheduled_at,
            sent_at=sent_at,
            status=status,
            error_message=error,
            recipients_summary=summary,
            manual=manual,
        )
    )
    alarm.last_sent_at = sent_at or scheduled_at
    alarm.last_status = status
    alarm.last_error = error
    if status == "SUCCESS":
        alarm.sent_count = (alarm.sent_count or 0) + 1


# ---------------------------------------------------------------------------
# APScheduler 콜백
# ---------------------------------------------------------------------------


async def _run_alarm(alarm_id: UUID) -> None:
    """APScheduler 가 트리거하는 진입점. 오직 id 만 참조해 DB 에서 매번 재로드
    (UI 에서 수정 직후 job 이 아직 재등록되지 않았어도 최신 값 반영).

    job_runs 통합 트래킹: 모든 cron fire 가 1 row 를 남긴다. SKIPPED_* 도 SUCCESS
    상태로 기록되며 result_summary 에 사유가 들어간다 (실제 실패만 FAILED).
    """
    from app.core.tenant_context import set_current_tenant_id
    from app.services.job_tracking import track_job_run

    try:
        async with track_job_run(
            job_name="알람 발송", job_kind="ALARM_DISPATCH"
        ) as ctx:
            ctx.update_extra(alarm_id=str(alarm_id))
            await _run_alarm_inner(alarm_id, ctx)
    finally:
        # 다음 fire 가 이 task 의 ContextVar 잔재를 받지 않도록 reset.
        set_current_tenant_id(None)


async def _run_alarm_inner(alarm_id: UUID, ctx) -> None:  # type: ignore[no-untyped-def]
    from app.core.tenant_context import set_current_tenant_id

    scheduled_at = datetime.now(_tz.utc)
    async with system_session() as db:
        alarm = (
            await db.execute(select(Alarm).where(Alarm.id == alarm_id))
        ).scalar_one_or_none()
        if alarm is None:
            ctx.set_summary(f"이미 삭제된 알람: {alarm_id}")
            logger.info("알람 실행 스킵 — 이미 삭제됨: %s", alarm_id)
            return
        # 이 시점부터의 모든 로그가 [<tenant_slug>] 로 prefix 되도록.
        # APScheduler 가 호출한 진입점이라 ContextVar 가 비어있는 상태로 들어옴.
        set_current_tenant_id(alarm.tenant_id)
        ctx.set_summary(f"{alarm.title}")
        ctx.update_extra(title=alarm.title, schedule_kind=alarm.schedule_kind)
        if not alarm.enabled:
            await _record_send(
                db, alarm,
                scheduled_at=scheduled_at, sent_at=None,
                status="SKIPPED_DISABLED",
                error=None, summary="(disabled)", manual=False,
            )
            await db.commit()
            ctx.set_summary(f"{alarm.title} — 비활성 (disabled)")
            return

        today = date.today()
        if alarm.active_from and today < alarm.active_from:
            await _record_send(
                db, alarm,
                scheduled_at=scheduled_at, sent_at=None,
                status="SKIPPED_INACTIVE",
                error=f"active_from={alarm.active_from} 이전",
                summary="(비활성 기간)", manual=False,
            )
            await db.commit()
            ctx.set_summary(f"{alarm.title} — 비활성 기간 (active_from)")
            return
        if alarm.active_to and today > alarm.active_to:
            alarm.enabled = False
            await _record_send(
                db, alarm,
                scheduled_at=scheduled_at, sent_at=None,
                status="SKIPPED_INACTIVE",
                error=f"active_to={alarm.active_to} 경과 — 자동 disable",
                summary="(유효기간 만료)", manual=False,
            )
            await db.commit()
            # APScheduler job 도 제거.
            _remove_job(alarm_id)
            ctx.set_summary(f"{alarm.title} — 유효기간 만료, 자동 disable")
            return

        # SHIFT_BEFORE — MONTHLY/YEARLY 만 적용. DAILY/WEEKLY/ONE_TIME 은 스킵.
        if alarm.schedule_kind in ("MONTHLY", "YEARLY"):
            shifted = await _shift_to_previous_working_day(db, today)
            if shifted != today:
                logger.info(
                    "알람 %s: %s 은 휴일 → 직전 영업일 %s 로 이동",
                    alarm.id, today, shifted,
                )
                # 이동 타겟이 오늘이 아니면 오늘은 발송하지 않는다 — 이동일에 별도로
                # 발송되어야 하지만 APScheduler 의 cron 이 그 날 fire 하지 않으므로,
                # 이동 타겟 시각에 DateTrigger 로 one-shot job 을 등록.
                fire_at = datetime.combine(
                    shifted,
                    datetime.min.time().replace(
                        hour=alarm.hour or 9, minute=alarm.minute or 0
                    ),
                )
                # 이미 지난 시각이면 지금 즉시 발송. 아니면 예약.
                tz_name = get_settings().scheduler.timezone
                from zoneinfo import ZoneInfo

                fire_at_tz = fire_at.replace(tzinfo=ZoneInfo(tz_name))
                if fire_at_tz <= datetime.now(ZoneInfo(tz_name)):
                    # 지난 시각 — 그대로 발송 진행.
                    pass
                else:
                    # 미래 시각 — one-shot job 등록 후 오늘은 스킵.
                    await _record_send(
                        db, alarm,
                        scheduled_at=scheduled_at, sent_at=None,
                        status="SKIPPED_INACTIVE",
                        error=f"휴일 → {shifted} {alarm.hour:02d}:{alarm.minute:02d} 로 이동 예약",
                        summary="(영업일 이동)", manual=False,
                    )
                    await db.commit()
                    _schedule_one_shot(alarm.id, fire_at_tz)
                    ctx.set_summary(
                        f"{alarm.title} — 휴일 → {shifted} 로 이동 예약"
                    )
                    return

        # 실제 발송.
        ok, err, summary = await _deliver(
            db, alarm, scheduled_at=scheduled_at, manual=False
        )
        await _record_send(
            db, alarm,
            scheduled_at=scheduled_at,
            sent_at=datetime.now(_tz.utc) if ok else None,
            status="SUCCESS" if ok else "FAILED",
            error=err,
            summary=summary,
            manual=False,
        )

        # ONE_TIME 은 1회 발송 후 자동 disable + job 제거.
        if alarm.schedule_kind == "ONE_TIME":
            alarm.enabled = False

        await db.commit()
        if alarm.schedule_kind == "ONE_TIME":
            _remove_job(alarm_id)
        ctx.set_summary(f"{alarm.title} — {summary}")
        ctx.update_extra(delivery_ok=ok, delivery_error=err)
        # 발송 자체가 Slack 단에서 실패해도 job 본문은 정상 종료 — alarm_sends.status
        # 가 도메인 차원의 정답이고, job_runs 는 "실행이 끝까지 진행됐는가" 만 본다.
        logger.info(
            "알람 발송: id=%s title=%s status=%s recipients=%s",
            alarm.id, alarm.title, alarm.last_status, summary,
        )


async def run_alarm_now(
    db: AsyncSession,
    alarm: Alarm,
    *,
    triggered_by_user_id: UUID | None = None,
) -> AlarmSend:
    """수동 테스트 발송 — 다이얼로그의 "지금 테스트 발송" 버튼.

    SHIFT_BEFORE·active 기간 검사 없이 즉시 Slack 으로 보낸다 (검증 목적).
    결과를 반환해 API 가 HTTP 응답에 포함시킬 수 있도록.

    `triggered_by_user_id` 가 주어지면 job_runs 에 MANUAL 트리거로 기록.
    """
    from app.services.job_tracking import track_job_run

    async with track_job_run(
        job_name=f"알람 테스트 발송 — {alarm.title}",
        job_kind="ALARM_DISPATCH",
        triggered_by="MANUAL",
        triggered_by_user_id=triggered_by_user_id,
    ) as ctx:
        ctx.update_extra(alarm_id=str(alarm.id), title=alarm.title)
        scheduled_at = datetime.now(_tz.utc)
        ok, err, summary = await _deliver(
            db, alarm, scheduled_at=scheduled_at, manual=True
        )
        send = AlarmSend(
            alarm_id=alarm.id,
            scheduled_at=scheduled_at,
            sent_at=datetime.now(_tz.utc) if ok else None,
            status="SUCCESS" if ok else "FAILED",
            error_message=err,
            recipients_summary=summary,
            manual=True,
        )
        db.add(send)
        alarm.last_sent_at = send.sent_at or scheduled_at
        alarm.last_status = send.status
        alarm.last_error = err
        if ok:
            alarm.sent_count = (alarm.sent_count or 0) + 1
        await db.commit()
        await db.refresh(send)
        ctx.set_summary(summary)
        ctx.update_extra(delivery_ok=ok, delivery_error=err)
        logger.info(
            "알람 테스트 발송: id=%s status=%s", alarm.id, send.status,
        )
        return send


# ---------------------------------------------------------------------------
# APScheduler job 관리
# ---------------------------------------------------------------------------


def _get_scheduler() -> AsyncIOScheduler | None:
    from app.services.scheduler import _scheduler as sch  # noqa: WPS437 — 재사용

    return sch


def _job_id(alarm_id: UUID) -> str:
    return f"alarm_{alarm_id}"


# thundering herd 회피 — 같은 cron 시각의 알람들이 동시에 fire 하지 않도록
# 0~30 초 사이 무작위 offset 으로 분산. ONE_TIME 은 정확한 시각이 필요하므로 X.
_ALARM_JITTER_SEC = 30


def _trigger_for(alarm: Alarm) -> Any | None:
    """Alarm → APScheduler trigger. 잘못된 설정이면 None 반환 (호출자가 log)."""
    tz = get_settings().scheduler.timezone
    kind = alarm.schedule_kind
    if kind == "ONE_TIME":
        if alarm.one_time_at is None:
            return None
        return DateTrigger(run_date=alarm.one_time_at, timezone=tz)
    if alarm.hour is None or alarm.minute is None:
        return None
    if kind == "DAILY":
        return CronTrigger(
            hour=alarm.hour, minute=alarm.minute, timezone=tz, jitter=_ALARM_JITTER_SEC,
        )
    if kind == "WEEKLY":
        if not alarm.weekdays:
            return None
        # APScheduler day_of_week 는 0=월 ~ 6=일 (파이썬 표준) 을 지원.
        days = ",".join(str(d) for d in sorted(set(alarm.weekdays)))
        return CronTrigger(
            day_of_week=days, hour=alarm.hour, minute=alarm.minute, timezone=tz,
            jitter=_ALARM_JITTER_SEC,
        )
    if kind == "MONTHLY":
        if alarm.day_of_month is None:
            return None
        return CronTrigger(
            day=alarm.day_of_month,
            hour=alarm.hour,
            minute=alarm.minute,
            timezone=tz,
            jitter=_ALARM_JITTER_SEC,
        )
    if kind == "YEARLY":
        if alarm.day_of_month is None or alarm.month_of_year is None:
            return None
        return CronTrigger(
            month=alarm.month_of_year,
            day=alarm.day_of_month,
            hour=alarm.hour,
            minute=alarm.minute,
            timezone=tz,
            jitter=_ALARM_JITTER_SEC,
        )
    return None


def sync_alarm_job(alarm: Alarm) -> None:
    """enabled 상태에 따라 job 을 추가/갱신/제거. CRUD 직후 호출."""
    scheduler = _get_scheduler()
    if scheduler is None:
        logger.info("스케줄러 미활성 — 알람 %s 의 job 등록 스킵", alarm.id)
        return
    job_id = _job_id(alarm.id)
    if not alarm.enabled:
        if scheduler.get_job(job_id) is not None:
            scheduler.remove_job(job_id)
            logger.info("알람 job 제거 (disabled): %s", alarm.id)
        return
    trigger = _trigger_for(alarm)
    if trigger is None:
        logger.warning(
            "알람 %s: schedule_kind=%s 에 필요한 필드 누락 — job 등록 실패",
            alarm.id, alarm.schedule_kind,
        )
        if scheduler.get_job(job_id) is not None:
            scheduler.remove_job(job_id)
        return
    scheduler.add_job(
        _run_alarm,
        args=[alarm.id],
        trigger=trigger,
        id=job_id,
        name=f"alarm: {alarm.title}",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )
    logger.info(
        "알람 job 등록/갱신: id=%s title=%s kind=%s",
        alarm.id, alarm.title, alarm.schedule_kind,
    )


def _schedule_one_shot(alarm_id: UUID, fire_at: datetime) -> None:
    """SHIFT_BEFORE 이동 발송 — 일회성 DateTrigger job 등록."""
    scheduler = _get_scheduler()
    if scheduler is None:
        return
    scheduler.add_job(
        _run_alarm,
        args=[alarm_id],
        trigger=DateTrigger(run_date=fire_at),
        id=f"alarm_{alarm_id}_shifted_{int(fire_at.timestamp())}",
        name=f"alarm shifted: {alarm_id}",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )


def _remove_job(alarm_id: UUID) -> None:
    scheduler = _get_scheduler()
    if scheduler is None:
        return
    job_id = _job_id(alarm_id)
    if scheduler.get_job(job_id) is not None:
        scheduler.remove_job(job_id)


def remove_alarm_job(alarm_id: UUID) -> None:
    _remove_job(alarm_id)


async def sync_all_alarm_jobs() -> int:
    """앱 기동 / 스케줄러 재시작 시 호출. DB 의 모든 enabled alarm 을 job 으로 등록."""
    async with system_session() as db:
        rows = list(
            (await db.execute(select(Alarm).where(Alarm.enabled.is_(True)))).scalars()
        )
    for alarm in rows:
        sync_alarm_job(alarm)
    logger.info("알람 job 일괄 동기화: %d 건", len(rows))
    return len(rows)


async def next_run_at(alarm_id: UUID) -> datetime | None:
    scheduler = _get_scheduler()
    if scheduler is None:
        return None
    job = scheduler.get_job(_job_id(alarm_id))
    if job is None:
        return None
    return job.next_run_time


# ---------------------------------------------------------------------------
# 이력 정리
# ---------------------------------------------------------------------------


async def purge_old_alarm_sends(days: int = 7) -> int:
    """7일 이전 AlarmSend 행 삭제. 스케줄러에서 1일 1회 호출."""
    cutoff = datetime.now(_tz.utc) - timedelta(days=days)
    async with system_session() as db:
        rows = list(
            (
                await db.execute(
                    select(AlarmSend).where(AlarmSend.created_at < cutoff)
                )
            ).scalars()
        )
        for r in rows:
            await db.delete(r)
        await db.commit()
    if rows:
        logger.info("알람 이력 정리: %d 건 삭제 (< %s)", len(rows), cutoff.date())
    return len(rows)
