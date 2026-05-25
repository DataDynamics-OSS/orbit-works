"""회의록 액션 아이템 마감일 알림 (Slack/Mattermost DM).

매일 09:00 KST cron — 미완료 액션 아이템 중 다음 케이스를 담당자에게 DM:

- 마감 D-3 (아직 여유 있는 알림)
- 마감 D-1 (마감 임박)
- 마감 D-Day (오늘)

같은 항목이 D-3 / D-1 / D-Day 에 각각 한 번씩 발송 (총 3회 가능).
담당자(assignee_id) 가 매핑된 정규직만 대상 — 외부 게스트(assignee_name) 는
이메일 미보유로 발송 X.

본문은 provider 무관 plain text + raw URL 로 작성 — Mattermost 어댑터는
Slack `blocks` 를 무시(`message=text`)하므로 본문 정보는 반드시 text 안에
들어가야 한다. Slack 사용자에겐 `blocks` 가 보강 시각화로 추가 노출.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import system_session
from app.models import (
    Developer,
    MeetingNote,
    MeetingNoteActionItem,
    Tenant,
)
from app.core.config import get_settings
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


# (D-N tag, emoji, header_label, intro_line) — D-Day / D-1 / D-3 각각.
_DUE_VARIANTS: list[tuple[str, str, str]] = [
    ("D-Day", "📌", "오늘 안에 처리해야 할 항목입니다. 처리 후 ‘내 액션’ 에서 완료로 바꿔 주세요."),
    ("D-1",   "⏰", "내일까지 마감입니다. 늦어지면 D-Day 알림이 한 번 더 갑니다."),
    ("D-3",   "🗓️", "3일 후 마감입니다. 여유 있을 때 미리 처리해 두세요."),
]


async def run_action_item_due_alerts(db: AsyncSession) -> None:
    """오늘·내일·3일 후 마감인 미완료 액션 아이템을 담당자에게 DM."""
    today = date.today()
    schedule = [
        (today,                       _DUE_VARIANTS[0]),
        (today + timedelta(days=1),   _DUE_VARIANTS[1]),
        (today + timedelta(days=3),   _DUE_VARIANTS[2]),
    ]
    total_sent = 0
    for due, variant in schedule:
        sent = await _send_for_due(db, due, variant)
        total_sent += sent
    logger.info("액션 아이템 마감 DM 발송 — 총 %s 통", total_sent)


async def _send_for_due(
    db: AsyncSession, due: date, variant: tuple[str, str, str]
) -> int:
    """주어진 마감일의 미완료 항목을 그루핑해서 담당자별 1통씩 DM."""
    rows = (
        await db.execute(
            select(MeetingNoteActionItem, MeetingNote, Developer)
            .join(MeetingNote, MeetingNote.id == MeetingNoteActionItem.meeting_note_id)
            .join(Developer, Developer.id == MeetingNoteActionItem.assignee_id)
            # 회의록 작성자(developer) 를 본문에 표기 — lazy="select" 라 명시 prefetch.
            .options(selectinload(MeetingNote.author))
            .where(
                MeetingNoteActionItem.due_date == due,
                MeetingNoteActionItem.status.in_(["TODO", "IN_PROGRESS"]),
                Developer.status == "ACTIVE",
            )
        )
    ).all()
    if not rows:
        return 0

    # tenant 별 → 담당자(assignee_id)별 그룹핑.
    by_tenant: dict[UUID, dict[UUID, list[tuple[MeetingNoteActionItem, MeetingNote, Developer]]]] = (
        defaultdict(lambda: defaultdict(list))
    )
    for item, note, dev in rows:
        by_tenant[item.tenant_id][dev.id].append((item, note, dev))

    total = 0
    for tenant_id, by_dev in by_tenant.items():
        for dev_id, group in by_dev.items():
            dev = group[0][2]
            email = dev.company_email or dev.personal_email
            if not email:
                logger.debug(
                    "액션 DM 스킵 (이메일 없음): developer=%s", dev_id
                )
                continue
            text, blocks = _build_message(due, variant, group)
            ok = await notify_service.send_for_tenant(
                tenant_id,
                text=text,
                user_emails=[email],
                blocks=blocks,
                feature="action_item",
            )
            if ok:
                total += 1
                logger.info(
                    "액션 DM 발송: tenant=%s assignee=%s items=%s tag=%s",
                    tenant_id, dev_id, len(group), variant[0],
                )
    return total


def _author_name(note: MeetingNote) -> str:
    """회의록 작성자 표기 — Developer 매핑 있으면 그 이름, 없으면 '관리자'."""
    a = getattr(note, "author", None)
    if a is not None and getattr(a, "name", None):
        return a.name
    return "관리자"


def _build_message(
    due: date,
    variant: tuple[str, str, str],
    group: list[tuple[MeetingNoteActionItem, MeetingNote, Developer]],
) -> tuple[str, list[dict]]:
    """provider 무관 본문(text) + Slack 보강 blocks.

    text: plain + raw URL (별표 마크다운은 Slack/Mattermost 가 다르게 해석해
          한쪽이 못 생겨지므로 사용 X). 모든 정보가 여기 들어 있어야 Mattermost
          사용자도 풍부하게 본다.
    blocks: Slack 전용 — Slack 은 blocks 우선 렌더라 시각적으로 더 깔끔.
            Mattermost 어댑터는 무시.
    """
    d_tag, emoji, intro = variant
    n = len(group)
    header = f"{emoji} {_due_label(d_tag)} — 미완료 액션 아이템 {n}건"
    base = get_settings().server.public_url.rstrip("/")
    my_actions_url = f"{base}/my-actions"

    # ── plain text 본문 ──
    text_lines: list[str] = [header, "", intro, ""]
    for idx, (item, note, _dev) in enumerate(group, start=1):
        note_link = f"{base}/meeting-notes/{note.id}"
        note_date = note.created_at.date().isoformat() if note.created_at else "-"
        author = _author_name(note)
        text_lines.extend([
            f"{idx}. {item.title}",
            f"   · 마감 {due.isoformat()} ({d_tag})",
            f"   · 회의록: {note.title} ({note_date})",
            f"   · 회의록 작성자: {author}",
            f"   · 회의록 열기 → {note_link}",
            "",
        ])
    text_lines.append(f"내 액션 모아보기 → {my_actions_url}")
    text = "\n".join(text_lines)

    # ── Slack blocks (보강) ──
    blocks: list[dict] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": header, "emoji": True},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": intro},
        },
        {"type": "divider"},
    ]
    for idx, (item, note, _dev) in enumerate(group, start=1):
        note_link = f"{base}/meeting-notes/{note.id}"
        note_date = note.created_at.date().isoformat() if note.created_at else "-"
        author = _author_name(note)
        body_md = (
            f"*{idx}. {item.title}*\n"
            f"• 마감: `{due.isoformat()}` ({d_tag})\n"
            f"• 회의록: <{note_link}|{note.title}> ({note_date})\n"
            f"• 회의록 작성자: {author}"
        )
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": body_md},
        })
    blocks.append({
        "type": "context",
        "elements": [{
            "type": "mrkdwn",
            "text": f"내 액션 모아보기 → <{my_actions_url}|/my-actions>",
        }],
    })
    return text, blocks


def _due_label(d_tag: str) -> str:
    """본문 헤더에 들어갈 한국어 마감 라벨."""
    return {
        "D-Day": "오늘 마감 (D-Day)",
        "D-1":   "내일 마감 (D-1)",
        "D-3":   "3일 후 마감 (D-3)",
    }.get(d_tag, d_tag)


# ---------------------------------------------------------------------------
# Cron entrypoint — system_session 으로 RLS 우회해 모든 tenant 조회.
# ---------------------------------------------------------------------------


async def cron_run_action_item_alerts() -> None:
    async with system_session() as db:
        # tenant 한 곳씩 돌지 않고 system_session(bypass_rls)로 한 번에 조회.
        # 위 함수들이 _build_message 에서 tenant_id 별 그룹핑하므로 안전.
        # tenant 활성 여부는 별도 필터 X (비활성 tenant 도 내부적으로 알림 발송 안 함).
        try:
            await run_action_item_due_alerts(db)
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "회의록 액션 마감 DM cron 실패: %s", exc, exc_info=True
            )
            raise
