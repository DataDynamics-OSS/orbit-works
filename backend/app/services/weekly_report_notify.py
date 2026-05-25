"""주간보고 코멘트 알림 — owner 에게 Slack/Mattermost DM.

코멘트 작성 시 보고서 owner(developer) 에게 작성자 이름·코멘트 본문을
포함한 DM 발송. 본인이 본인 보고서에 작성한 경우는 self-notify 회피.

수신자 이메일 미설정 / provider 미구성 시 silently skip — 알림 실패가
코멘트 작성을 막지 않도록 호출 측에서 try/except 로 감싸서 호출.
"""

from __future__ import annotations

import logging
import re
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Developer, User, WeeklyReport, WeeklyReportComment
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    """TipTap HTML → DM 본문 (간이). 태그 제거 + 공백 정리.

    공식 mrkdwn 변환은 비용이 크므로 평문화. DM 미리보기 길이도 250 자로 잘라
    너무 긴 코멘트가 채널 timeline 을 가리지 않도록.
    """
    text = _HTML_TAG_RE.sub(" ", html or "").strip()
    text = re.sub(r"\s+", " ", text)
    if len(text) > 250:
        text = text[:250] + "…"
    return text


async def notify_weekly_report_comment(
    db: AsyncSession,
    *,
    comment_id: UUID,
) -> None:
    """코멘트 → owner DM 발송.

    조회 → 자가 작성 skip → owner 이메일 확보 → blocks 빌드 → 발송 → 로그.
    """
    comment = (
        await db.execute(
            select(WeeklyReportComment).where(WeeklyReportComment.id == comment_id)
        )
    ).scalar_one_or_none()
    if not comment:
        logger.warning("weekly_report_notify: comment=%s 없음 — skip", comment_id)
        return

    report = (
        await db.execute(
            select(WeeklyReport).where(WeeklyReport.id == comment.weekly_report_id)
        )
    ).scalar_one_or_none()
    if not report:
        return

    owner = (
        await db.execute(select(Developer).where(Developer.id == report.developer_id))
    ).scalar_one_or_none()
    if not owner:
        return

    # 자가 작성 — owner 가 본인 보고서에 코멘트한 경우 알림 skip.
    if comment.author_id and comment.author_id == owner.id:
        logger.info(
            "weekly_report_notify: comment=%s 자가 작성 — skip (owner=%s)",
            comment_id, owner.name,
        )
        return

    email = owner.company_email or owner.personal_email
    if not email or "@" not in email:
        logger.warning(
            "weekly_report_notify: comment=%s owner(%s) 이메일 없음 — skip",
            comment_id, owner.name,
        )
        return

    # 작성자 이름 — Developer 우선, fallback User.name.
    author_name = "(작성자 미상)"
    if comment.author_id:
        d = (
            await db.execute(
                select(Developer.name).where(Developer.id == comment.author_id)
            )
        ).first()
        if d and d[0]:
            author_name = d[0]
    elif comment.author_user_id:
        u = (
            await db.execute(
                select(User.name).where(User.id == comment.author_user_id)
            )
        ).first()
        if u and u[0]:
            author_name = u[0]

    body_text = _strip_html(comment.body)
    week_label = f"{report.iso_year}년 {report.iso_week}주차"

    fields = [
        {"type": "mrkdwn", "text": f"*보고서*\n{week_label}"},
        {"type": "mrkdwn", "text": f"*작성자*\n{author_name}"},
    ]
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "💬 주간보고 코멘트"},
        },
        {"type": "section", "fields": fields},
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"```{body_text}```"},
        },
    ]

    await notify_service.send_for_tenant(
        report.tenant_id,
        text=f"[주간보고 코멘트] {author_name}: {body_text}",
        user_emails=[email],
        blocks=blocks,
        feature="weekly_report",
    )
    logger.info(
        "weekly_report_notify: comment=%s report=%s author=%s → owner=%s (%s)",
        comment_id, report.id, author_name, owner.name, email,
    )
