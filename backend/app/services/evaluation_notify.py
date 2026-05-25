"""임직원 평가 — 알림 (Slack / Mattermost DM).

호출 시점:
  - cycle open: 모든 대상자 + 매니저 → "1H 평가 시작, self 마감 D-?".
  - self submitted: 직속 매니저 → "<이름> 자기평가 제출됨".
  - manager submitted: HR/ADMIN 전원 → calibration 큐 알림.
  - finalized: 본인 → "평가 공개됨".

D-3 마감 임박 (self_due / manager_due / finalize_due) 은 daily_alerts
job 에서 매일 한 번 호출 (`run_evaluation_due_reminders`). 발송 실패는 코드
플로우(transition·calibration) 에 영향 주지 않음 — 호출 측 try/except.
"""

from __future__ import annotations

import logging
import re
from datetime import date as date_cls, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Developer,
    Evaluation,
    EvaluationCycle,
    User,
)
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str | None) -> str:
    if not html:
        return ""
    text = _HTML_TAG_RE.sub(" ", html).strip()
    text = re.sub(r"\s+", " ", text)
    if len(text) > 250:
        text = text[:250] + "…"
    return text


def _developer_email(d: Developer) -> str | None:
    e = d.company_email or d.personal_email
    return e if e and "@" in e else None


# ---------------------------------------------------------------------------
# Cycle open — 모든 대상자 + 매니저에게 시작 안내.
# ---------------------------------------------------------------------------


async def notify_cycle_opened(db: AsyncSession, cycle_id: UUID) -> None:
    """OPEN 직후 전체 대상자 + 매니저 모음에 한 번에 발송 (broadcast)."""
    cycle = (
        await db.execute(
            select(EvaluationCycle).where(EvaluationCycle.id == cycle_id)
        )
    ).scalar_one_or_none()
    if not cycle:
        return

    # 평가 row → 대상자 + 매니저 dev_id 모음.
    rows = list(
        (
            await db.execute(
                select(Evaluation.developer_id, Evaluation.manager_id).where(
                    Evaluation.cycle_id == cycle_id
                )
            )
        ).all()
    )
    dev_ids: set[UUID] = set()
    for d_id, m_id in rows:
        dev_ids.add(d_id)
        if m_id:
            dev_ids.add(m_id)
    if not dev_ids:
        return
    devs = list(
        (
            await db.execute(
                select(Developer).where(Developer.id.in_(dev_ids))
            )
        ).scalars()
    )
    emails = [_developer_email(d) for d in devs]
    emails = [e for e in emails if e]
    if not emails:
        logger.info(
            "evaluation_notify cycle_opened: cycle=%s 수신자 0명 — skip", cycle_id,
        )
        return

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "📝 평가가 시작되었습니다"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*주기*\n{cycle.year} {cycle.period} · {cycle.name}"},
                {"type": "mrkdwn", "text": f"*자기평가 마감*\n{cycle.self_due.isoformat()}"},
                {"type": "mrkdwn", "text": f"*매니저 마감*\n{cycle.manager_due.isoformat()}"},
                {"type": "mrkdwn", "text": f"*공개 마감*\n{cycle.finalize_due.isoformat()}"},
            ],
        },
    ]
    await notify_service.send_for_tenant(
        cycle.tenant_id,
        text=f"[평가] {cycle.year} {cycle.period} 평가가 시작되었습니다.",
        user_emails=emails,
        blocks=blocks,
        feature="evaluation",
    )
    logger.info(
        "evaluation_notify cycle_opened: cycle=%s 수신자=%d명",
        cycle_id, len(emails),
    )


# ---------------------------------------------------------------------------
# Self submitted → 직속 매니저.
# ---------------------------------------------------------------------------


async def notify_self_submitted(db: AsyncSession, evaluation_id: UUID) -> None:
    e = (
        await db.execute(
            select(Evaluation).where(Evaluation.id == evaluation_id)
        )
    ).scalar_one_or_none()
    if not e or not e.manager_id:
        return
    dev = (
        await db.execute(select(Developer).where(Developer.id == e.developer_id))
    ).scalar_one_or_none()
    mgr = (
        await db.execute(select(Developer).where(Developer.id == e.manager_id))
    ).scalar_one_or_none()
    if not dev or not mgr:
        return
    email = _developer_email(mgr)
    if not email:
        return
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "✏️ 자기평가가 제출되었습니다"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*직원*\n{dev.name}"},
                {"type": "mrkdwn", "text": f"*매니저 평가 작성 시작 가능*"},
            ],
        },
    ]
    await notify_service.send_for_tenant(
        e.tenant_id,
        text=f"[평가] {dev.name} 자기평가 제출됨 — 매니저 평가 작성 부탁드립니다.",
        user_emails=[email],
        blocks=blocks,
        feature="evaluation",
    )
    logger.info(
        "evaluation_notify self_submitted: eid=%s manager=%s",
        evaluation_id, mgr.name,
    )


# ---------------------------------------------------------------------------
# Manager submitted → HR/ADMIN 전원 (calibration 큐 알림).
# ---------------------------------------------------------------------------


async def notify_manager_submitted(db: AsyncSession, evaluation_id: UUID) -> None:
    e = (
        await db.execute(
            select(Evaluation).where(Evaluation.id == evaluation_id)
        )
    ).scalar_one_or_none()
    if not e:
        return
    dev = (
        await db.execute(select(Developer).where(Developer.id == e.developer_id))
    ).scalar_one_or_none()
    mgr = (
        await db.execute(select(Developer).where(Developer.id == e.manager_id))
        if e.manager_id
        else None
    )
    mgr_obj = mgr.scalar_one_or_none() if mgr else None
    # 같은 tenant 의 활성 ADMIN/HR users → 이메일.
    user_rows = list(
        (
            await db.execute(
                select(User.email).where(
                    User.tenant_id == e.tenant_id,
                    User.is_active.is_(True),
                    User.role.in_(["ADMIN", "HR"]),
                )
            )
        ).all()
    )
    emails = [r[0] for r in user_rows if r[0] and "@" in r[0]]
    if not emails or not dev:
        return
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "⚖️ 평가 조정(calibration) 대기"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*직원*\n{dev.name}"},
                {"type": "mrkdwn", "text": f"*매니저*\n{mgr_obj.name if mgr_obj else '—'}"},
            ],
        },
    ]
    await notify_service.send_for_tenant(
        e.tenant_id,
        text=f"[평가] {dev.name} 매니저평가 제출 — calibration 대기.",
        user_emails=emails,
        blocks=blocks,
        feature="evaluation",
    )
    logger.info(
        "evaluation_notify manager_submitted: eid=%s → HR %d명",
        evaluation_id, len(emails),
    )


# ---------------------------------------------------------------------------
# Finalized → 본인 (등급 공개).
# ---------------------------------------------------------------------------


async def notify_finalized(db: AsyncSession, evaluation_id: UUID) -> None:
    e = (
        await db.execute(
            select(Evaluation).where(Evaluation.id == evaluation_id)
        )
    ).scalar_one_or_none()
    if not e:
        return
    dev = (
        await db.execute(select(Developer).where(Developer.id == e.developer_id))
    ).scalar_one_or_none()
    if not dev:
        return
    email = _developer_email(dev)
    if not email:
        return
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🎯 평가가 공개되었습니다"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*등급*\n{e.final_grade or '—'}"},
            ],
        },
    ]
    await notify_service.send_for_tenant(
        e.tenant_id,
        text=f"[평가] 평가가 공개되었습니다. 등급 {e.final_grade or '—'}.",
        user_emails=[email],
        blocks=blocks,
        feature="evaluation",
    )
    logger.info(
        "evaluation_notify finalized: eid=%s grade=%s owner=%s",
        evaluation_id, e.final_grade, dev.name,
    )


# ---------------------------------------------------------------------------
# 마감 임박 (D-3) reminder — daily cron 에서 호출.
# ---------------------------------------------------------------------------


async def run_evaluation_due_reminders(
    db: AsyncSession, today: date_cls,
) -> dict:
    """OPEN cycle 의 self/manager/finalize 마감 D-3 에 미작성자 reminder.

    같은 날 한 번만 호출되도록 caller(daily_alerts) 가 가드.
    self_due  - 3일: status=NOT_STARTED|SELF_DRAFT 인 본인.
    manager_due - 3일: status=SELF_SUBMITTED|MGR_DRAFT 인 매니저.
    finalize_due - 3일: status=MGR_SUBMITTED|CALIBRATED 인 HR/ADMIN.
    """
    cycles = list(
        (
            await db.execute(
                select(EvaluationCycle).where(EvaluationCycle.status == "OPEN")
            )
        ).scalars()
    )
    summary = {"self": 0, "manager": 0, "calibrate": 0}
    for c in cycles:
        if c.self_due == today + timedelta(days=3):
            summary["self"] += await _remind_self(db, c)
        if c.manager_due == today + timedelta(days=3):
            summary["manager"] += await _remind_manager(db, c)
        if c.finalize_due == today + timedelta(days=3):
            summary["calibrate"] += await _remind_calibrate(db, c)
    return summary


async def _remind_self(db: AsyncSession, cycle: EvaluationCycle) -> int:
    """본인 미제출자 reminder."""
    rows = list(
        (
            await db.execute(
                select(Evaluation, Developer)
                .join(Developer, Developer.id == Evaluation.developer_id)
                .where(
                    Evaluation.cycle_id == cycle.id,
                    Evaluation.status.in_(["NOT_STARTED", "SELF_DRAFT"]),
                )
            )
        ).all()
    )
    sent = 0
    for _ev, dev in rows:
        email = _developer_email(dev)
        if not email:
            continue
        await notify_service.send_for_tenant(
            cycle.tenant_id,
            text=(
                f"[평가] 자기평가 마감 D-3 ({cycle.self_due.isoformat()}). "
                f"{cycle.year} {cycle.period} — 작성 부탁드립니다."
            ),
            user_emails=[email],
            feature="evaluation",
        )
        sent += 1
    if sent:
        logger.info(
            "evaluation_notify reminder self D-3: cycle=%s 발송=%d",
            cycle.id, sent,
        )
    return sent


async def _remind_manager(db: AsyncSession, cycle: EvaluationCycle) -> int:
    """매니저 미제출 — 직속 매니저에 reminder."""
    rows = list(
        (
            await db.execute(
                select(Evaluation).where(
                    Evaluation.cycle_id == cycle.id,
                    Evaluation.status.in_(["SELF_SUBMITTED", "MGR_DRAFT"]),
                    Evaluation.manager_id.is_not(None),
                )
            )
        ).scalars()
    )
    # 매니저 별로 카운트 묶기 — 부하 여러 명 reminder 합쳐서 1 메시지.
    by_mgr: dict[UUID, int] = {}
    for ev in rows:
        if ev.manager_id is None:
            continue
        by_mgr[ev.manager_id] = by_mgr.get(ev.manager_id, 0) + 1
    if not by_mgr:
        return 0
    mgrs = list(
        (
            await db.execute(
                select(Developer).where(Developer.id.in_(by_mgr.keys()))
            )
        ).scalars()
    )
    sent = 0
    for mgr in mgrs:
        email = _developer_email(mgr)
        if not email:
            continue
        n = by_mgr[mgr.id]
        await notify_service.send_for_tenant(
            cycle.tenant_id,
            text=(
                f"[평가] 매니저 평가 마감 D-3 ({cycle.manager_due.isoformat()}). "
                f"{cycle.year} {cycle.period} — 미제출 부하 {n}명."
            ),
            user_emails=[email],
            feature="evaluation",
        )
        sent += 1
    if sent:
        logger.info(
            "evaluation_notify reminder manager D-3: cycle=%s 발송=%d",
            cycle.id, sent,
        )
    return sent


async def _remind_calibrate(db: AsyncSession, cycle: EvaluationCycle) -> int:
    """calibration 미완료 — HR/ADMIN 에 reminder."""
    pending = await db.scalar(
        select(__import__("sqlalchemy").func.count(Evaluation.id)).where(
            Evaluation.cycle_id == cycle.id,
            Evaluation.status.in_(["MGR_SUBMITTED", "CALIBRATED"]),
        )
    ) or 0
    if pending == 0:
        return 0
    user_rows = list(
        (
            await db.execute(
                select(User.email).where(
                    User.tenant_id == cycle.tenant_id,
                    User.is_active.is_(True),
                    User.role.in_(["ADMIN", "HR"]),
                )
            )
        ).all()
    )
    emails = [r[0] for r in user_rows if r[0] and "@" in r[0]]
    if not emails:
        return 0
    await notify_service.send_for_tenant(
        cycle.tenant_id,
        text=(
            f"[평가] 공개 마감 D-3 ({cycle.finalize_due.isoformat()}). "
            f"{cycle.year} {cycle.period} — 미공개 {pending}건."
        ),
        user_emails=emails,
        feature="evaluation",
    )
    logger.info(
        "evaluation_notify reminder calibrate D-3: cycle=%s 미공개=%d HR=%d명",
        cycle.id, pending, len(emails),
    )
    return len(emails)
