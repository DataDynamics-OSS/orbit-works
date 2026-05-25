"""목표 완료 알림 — Slack/Mattermost provider 추상.

PERSONAL goal 의 status 가 → DONE 으로 트랜지션할 때 owner 의 직속 매니저
(developers.manager_id) 에게 DM 발송. notify_service.send_for_tenant 로
provider-중립 처리.

COMPANY scope 는 매니저가 없어 별도 처리 필요 (현재는 skip — phase2 에서
HR/ADMIN 통보 정책 정의).
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Developer, Goal
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


_DIFFICULTY_KO = {
    "ROUTINE": "일상",
    "NORMAL": "표준",
    "CHALLENGING": "도전",
    "STRETCH": "도약",
}
_PRIORITY_KO = {"HIGH": "상", "MEDIUM": "중", "LOW": "하"}
_CATEGORY_KO = {
    "BUSINESS": "사업",
    "TECH": "기술",
    "OPERATIONS": "운영",
    "CAREER": "커리어",
    "PERSONAL_GROWTH": "성장",
    "OTHER": "기타",
}


async def notify_goal_completed(db: AsyncSession, goal_id: UUID) -> None:
    """PERSONAL goal 완료 → 직속 매니저에게 알림."""
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id))
    ).scalar_one_or_none()
    if not goal:
        logger.warning("goal_notify: goal=%s 없음 — skip", goal_id)
        return
    if goal.scope != "PERSONAL":
        return  # COMPANY scope 는 매니저 없음 — skip.
    if not goal.owner_id:
        return
    owner = (
        await db.execute(select(Developer).where(Developer.id == goal.owner_id))
    ).scalar_one_or_none()
    if not owner:
        return
    if not owner.manager_id:
        logger.info(
            "goal_notify completed: goal=%s owner=%s 에게 매니저 없음 — skip",
            goal_id, owner.name,
        )
        return
    manager = (
        await db.execute(
            select(Developer).where(Developer.id == owner.manager_id)
        )
    ).scalar_one_or_none()
    if not manager:
        return
    email = manager.company_email or manager.personal_email
    if not email or "@" not in email:
        logger.warning(
            "goal_notify completed: goal=%s 매니저(%s) 이메일 없음 — skip",
            goal_id, manager.name,
        )
        return

    fields = [
        {"type": "mrkdwn", "text": f"*담당자*\n{owner.name}"},
        {"type": "mrkdwn", "text": f"*목표*\n{goal.title}"},
        {"type": "mrkdwn", "text": f"*분류*\n{_CATEGORY_KO.get(goal.category, goal.category)}"},
        {"type": "mrkdwn",
         "text": f"*우선순위·난이도*\n"
                 f"{_PRIORITY_KO.get(goal.priority, goal.priority)} · "
                 f"{_DIFFICULTY_KO.get(goal.difficulty, goal.difficulty)}"},
        {"type": "mrkdwn", "text": f"*진행률*\n{float(goal.progress_pct):.0f}%"},
        {"type": "mrkdwn", "text": f"*연도*\n{goal.year}"},
    ]
    blocks = [
        {"type": "header",
         "text": {"type": "plain_text", "text": "🎯 목표 완료"}},
        {"type": "section", "fields": fields},
    ]
    await notify_service.send_for_tenant(
        goal.tenant_id, text="목표 완료", user_emails=[email], blocks=blocks,
        feature="goal",
    )
    logger.info(
        "goal_notify completed: goal=%s owner=%s → manager=%s (%s)",
        goal_id, owner.name, manager.name, email,
    )


# ---------------------------------------------------------------------------
# 마감일 알림 — D-30 / OVERDUE (D-Day 후 첫 영업일).
# 수신자: PERSONAL → owner + 직속 매니저 / COMPANY → ADMIN role 사용자.
# ---------------------------------------------------------------------------


async def _resolve_recipients(
    db: AsyncSession, goal: Goal
) -> tuple[list[str], list[str]]:
    """(emails, names) 반환. 발송 대상 이메일·이름 (로그용).

    PERSONAL : owner + 직속 매니저.
    COMPANY  : 같은 tenant 의 ADMIN role users.
    """
    from app.models import User

    emails: list[str] = []
    names: list[str] = []

    if goal.scope == "PERSONAL":
        if not goal.owner_id:
            return [], []
        owner = (
            await db.execute(select(Developer).where(Developer.id == goal.owner_id))
        ).scalar_one_or_none()
        if owner:
            e = owner.company_email or owner.personal_email
            if e and "@" in e:
                emails.append(e)
                names.append(owner.name)
            if owner.manager_id:
                manager = (
                    await db.execute(
                        select(Developer).where(Developer.id == owner.manager_id)
                    )
                ).scalar_one_or_none()
                if manager:
                    me = manager.company_email or manager.personal_email
                    if me and "@" in me:
                        emails.append(me)
                        names.append(f"{manager.name}(매니저)")
        return list(dict.fromkeys(emails)), names

    # COMPANY — 같은 tenant 의 ADMIN role users.
    rows = (
        await db.execute(
            select(User.email).where(
                User.role == "ADMIN",
                User.is_active.is_(True),
                User.tenant_id == goal.tenant_id,
            )
        )
    ).all()
    for (e,) in rows:
        if e and "@" in e:
            emails.append(e)
            names.append("ADMIN")
    return emails, names


def _format_due(goal: Goal) -> str:
    return goal.due_date.isoformat() if goal.due_date else "—"


async def _build_due_blocks(
    db: AsyncSession, goal: Goal, *, kind: str, days: int,
) -> list[dict]:
    owner_name = "—"
    if goal.owner_id:
        d = (
            await db.execute(select(Developer).where(Developer.id == goal.owner_id))
        ).scalar_one_or_none()
        if d:
            owner_name = d.name
    header = (
        "📅 목표 마감 1개월 전" if kind == "D_30"
        else f"⚠️ 목표 마감일 경과 (D+{days})"
    )
    fields = [
        {"type": "mrkdwn", "text": f"*담당자*\n{owner_name}"},
        {"type": "mrkdwn", "text": f"*목표*\n{goal.title}"},
        {"type": "mrkdwn",
         "text": f"*분류*\n{_CATEGORY_KO.get(goal.category, goal.category)}"},
        {"type": "mrkdwn",
         "text": f"*우선순위·난이도*\n"
                 f"{_PRIORITY_KO.get(goal.priority, goal.priority)} · "
                 f"{_DIFFICULTY_KO.get(goal.difficulty, goal.difficulty)}"},
        {"type": "mrkdwn", "text": f"*마감*\n{_format_due(goal)}"
                                   + (f" (D+{days})" if kind == "OVERDUE" else " (D-30)")},
        {"type": "mrkdwn", "text": f"*진행률*\n{float(goal.progress_pct):.0f}%"},
    ]
    if kind == "OVERDUE":
        fields.append({
            "type": "mrkdwn",
            "text": "*권장 액션*\n마감일 갱신 또는 상태를 위기·중단으로 변경",
        })
    return [
        {"type": "header", "text": {"type": "plain_text", "text": header}},
        {"type": "section", "fields": fields},
    ]


async def notify_goal_due(
    db: AsyncSession, goal_id: UUID, *, kind: str, days_after: int = 0,
) -> bool:
    """D-30 또는 OVERDUE 알림 발송. 수신자 0 명이면 silently skip.

    반환: 발송 시도 성공 여부 (provider 결과). 호출 측이 dedup row INSERT 후
    실제 발송 실패는 log 만 남김 (재시도는 다음 cron 에서 dedup 통과 못 하므로
    한 번 시도하면 끝 — 운영자 수동 재실행 필요한 경우만).
    """
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id))
    ).scalar_one_or_none()
    if not goal:
        return False
    emails, names = await _resolve_recipients(db, goal)
    if not emails:
        logger.info(
            "goal_notify_due: goal=%s kind=%s 수신자 0명 — skip",
            goal_id, kind,
        )
        return False
    blocks = await _build_due_blocks(db, goal, kind=kind, days=days_after)
    text = "목표 마감 알림" if kind == "D_30" else "목표 마감 경과"
    await notify_service.send_for_tenant(
        goal.tenant_id, text=text, user_emails=emails, blocks=blocks,
        feature="goal",
    )
    logger.info(
        "goal_notify_due: goal=%s kind=%s → %d명 (%s)",
        goal_id, kind, len(emails), ", ".join(names),
    )
    return True
