"""목표 마감일 알림 cron 진입점.

매일 09:10 KST — 모든 tenant 의 활성 (status NOT IN DONE/DROPPED) 목표
중 due_date 가 설정된 row 를 순회해 다음 시점에 발송:

- **D-30**         : `due_date - today == 30` 일 (정확)
- **OVERDUE**      : `today == next_working_day(due_date)`
                     (D-Day 직후 첫 영업일 — 토/일/공휴일 경우 다음 평일로 시프트)

dedup: `goal_due_alerts (goal_id, alert_kind)` UNIQUE — INSERT … ON CONFLICT
DO NOTHING. 한 번 발송된 alert 는 같은 goal 에 다시 안 보냄.

수신자:
- PERSONAL : owner.company_email + owner.manager.company_email
- COMPANY  : 같은 tenant 의 ADMIN role users

영업일 정의 (services/alarm.py 와 동일 정책):
- 평일(월~금) AND `holidays.type IN STATUTORY/TEMPORARY/COMPANY` 미등재
- EVENT_PUBLIC / EVENT_PRIVATE 는 캘린더 일정이라 영업일로 인정.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import system_session
from app.core.tenant_context import set_current_tenant_id
from app.models import Goal, GoalDueAlert, Holiday, Tenant
from app.services.goal_notify import notify_goal_due

logger = logging.getLogger(__name__)


async def _is_working_day(db: AsyncSession, d: date) -> bool:
    """평일 + 휴일 미등재 = 영업일."""
    if d.weekday() >= 5:
        return False
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
    return exists is None


async def _next_working_day_after(db: AsyncSession, d: date) -> date:
    """d 이후 (>d) 첫 영업일. 최대 14일 검색 (안전망)."""
    cursor = d + timedelta(days=1)
    for _ in range(14):
        if await _is_working_day(db, cursor):
            return cursor
        cursor += timedelta(days=1)
    logger.warning("next_working_day_after: %s 이후 14일 모두 휴일 — 원본+1 반환", d)
    return d + timedelta(days=1)


async def run_goal_due_alerts() -> dict:
    """매일 09:10 KST 진입점.

    반환: {"sent": 합계, "tenants": [...]} — job_runs 로그에 직렬화.
    """
    today = date.today()
    sent_total = 0
    skipped_total = 0
    per_tenant: list[dict] = []

    # tenants 목록 — system_session 로 cross-tenant.
    async with system_session() as db:
        tenants = list(
            (
                await db.execute(
                    select(Tenant.id, Tenant.slug).where(Tenant.is_active.is_(True))
                )
            ).all()
        )

    for tid, slug in tenants:
        set_current_tenant_id(tid)
        sent = 0
        skipped = 0
        try:
            async with system_session(tenant_id=str(tid)) as db:
                # 활성 + due_date 있는 goal 만.
                goals = list(
                    (
                        await db.execute(
                            select(Goal).where(
                                Goal.status.notin_(("DONE", "DROPPED")),
                                Goal.due_date.isnot(None),
                            )
                        )
                    ).scalars()
                )
                for g in goals:
                    # D-30 — 정확 매칭. 누락 케이스 (cron 단일 실행 실패) 는
                    # 다음날 발송 못함. 운영자 수동 재실행 필요.
                    d30 = g.due_date - timedelta(days=30)
                    if today == d30:
                        if await _try_send(db, g.id, "D_30", days_after=0):
                            sent += 1
                        else:
                            skipped += 1

                    # OVERDUE — D-Day 직후 첫 영업일.
                    overdue_day = await _next_working_day_after(db, g.due_date)
                    if today == overdue_day:
                        days_after = (today - g.due_date).days
                        if await _try_send(db, g.id, "OVERDUE", days_after=days_after):
                            sent += 1
                        else:
                            skipped += 1
        except Exception as exc:  # pragma: no cover
            logger.exception(
                "run_goal_due_alerts: tenant=%s 처리 중 오류 — 다른 tenant 계속: %s",
                slug, exc,
            )

        per_tenant.append({"tenant": slug, "sent": sent, "skipped": skipped})
        sent_total += sent
        skipped_total += skipped

    logger.info(
        "run_goal_due_alerts: sent=%d skipped=%d (%d tenants)",
        sent_total, skipped_total, len(tenants),
    )
    return {"sent": sent_total, "skipped": skipped_total, "tenants": per_tenant}


async def _try_send(
    db: AsyncSession, goal_id: UUID, kind: str, *, days_after: int,
) -> bool:
    """dedup row INSERT … ON CONFLICT DO NOTHING + 성공 시 알림 발송.

    True 반환 = 새로 INSERT + 발송. False = 이미 발송된 (CONFLICT) 또는 수신자 0명.
    """
    stmt = (
        pg_insert(GoalDueAlert)
        .values(goal_id=goal_id, alert_kind=kind)
        .on_conflict_do_nothing(index_elements=["goal_id", "alert_kind"])
        .returning(GoalDueAlert.id)
    )
    result = (await db.execute(stmt)).scalar_one_or_none()
    if result is None:
        return False  # 이미 발송됨 (dedup hit).
    await db.commit()
    try:
        ok = await notify_goal_due(db, goal_id, kind=kind, days_after=days_after)
        if not ok:
            logger.info(
                "goal_due skipped (no recipients): goal=%s kind=%s",
                goal_id, kind,
            )
        return ok
    except Exception as exc:
        logger.warning(
            "goal_due 발송 실패 — dedup row 는 이미 INSERT 됨, 재시도 X "
            "(goal=%s kind=%s): %s",
            goal_id, kind, exc,
        )
        return False
