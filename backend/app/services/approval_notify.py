"""결재 이벤트 알림 (Mattermost / Slack — provider 추상).

이벤트별 수신자 정책:
- 제출(SUBMITTED) → 1차 결재자.
- 단계 승인(APPROVED) → 다음 단계 결재자 (있으면). 최종 단계면 신청자.
- 단계 반려(REJECTED) → 신청자.
- 위임(DELEGATED) → 위임받은 결재자.
- 취소(CANCELLED) → 결재자 (PENDING 이었던 사람).

이메일은 company_email 우선, 없으면 personal_email.
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    ApprovalRequest,
    ApprovalStep,
    ApprovalTemplate,
    Developer,
)
from app.core.config import get_settings
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


def _detail_url(request_id: UUID) -> str:
    base = get_settings().server.public_url.rstrip("/")
    return f"{base}/approvals/{request_id}"


async def _load_request(
    db: AsyncSession, request_id: UUID
) -> ApprovalRequest | None:
    return (
        await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.id == request_id)
            .options(selectinload(ApprovalRequest.steps))
        )
    ).scalar_one_or_none()


async def _email_for(db: AsyncSession, developer_id: UUID | None) -> str | None:
    if not developer_id:
        return None
    dev = (
        await db.execute(select(Developer).where(Developer.id == developer_id))
    ).scalar_one_or_none()
    if not dev:
        return None
    e = dev.company_email or dev.personal_email
    if e and "@" in e:
        return e
    return None


async def _template_name(db: AsyncSession, template_id: UUID) -> str:
    t = (
        await db.execute(select(ApprovalTemplate).where(ApprovalTemplate.id == template_id))
    ).scalar_one_or_none()
    return (t.name if t else "결재")


async def _requester_name(db: AsyncSession, requester_id: UUID) -> str:
    d = (
        await db.execute(select(Developer).where(Developer.id == requester_id))
    ).scalar_one_or_none()
    return d.name if d else "-"


def _header(event: str) -> str:
    return {
        "SUBMITTED": "📝 결재 신청",
        "APPROVED": "✅ 결재 승인",
        "REJECTED": "❌ 결재 반려",
        "FINAL_APPROVED": "🎉 결재 최종 승인",
        "CANCELLED": "🚫 결재 취소",
        "DELEGATED": "↪️ 결재 위임",
    }.get(event, "📋 결재")


async def _build_blocks(
    db: AsyncSession, req: ApprovalRequest, event: str, extra: dict | None = None
) -> list[dict]:
    template_name = await _template_name(db, req.template_id)
    requester_name = await _requester_name(db, req.requester_id)
    fields = [
        {"type": "mrkdwn", "text": f"*양식*\n{template_name}"},
        {"type": "mrkdwn", "text": f"*제목*\n{req.title}"},
        {"type": "mrkdwn", "text": f"*신청자*\n{requester_name}"},
    ]
    if extra:
        for k, v in extra.items():
            fields.append({"type": "mrkdwn", "text": f"*{k}*\n{v}"})
    # 상세 페이지 링크 — Slack mrkdwn `<url|text>` 포맷. Mattermost provider 가
    # `[text](url)` 으로 변환.
    link = f"<{_detail_url(req.id)}|결재 보기 →>"
    return [
        {"type": "header", "text": {"type": "plain_text", "text": _header(event)}},
        {"type": "section", "fields": fields},
        {"type": "section", "text": {"type": "mrkdwn", "text": link}},
    ]


def _next_pending_step(steps: list[ApprovalStep]) -> ApprovalStep | None:
    for s in sorted(steps, key=lambda x: x.step_no):
        if s.status == "PENDING":
            return s
    return None


async def notify_submitted(db: AsyncSession, request_id: UUID) -> None:
    """제출 직후 — 1차 결재자에게 DM."""
    req = await _load_request(db, request_id)
    if not req:
        logger.warning("approval notify_submitted: request=%s 없음 — skip", request_id)
        return
    nxt = _next_pending_step(req.steps)
    if not nxt:
        logger.info(
            "approval notify_submitted: request=%s 에 PENDING 단계 없음 — skip",
            request_id,
        )
        return
    email = await _email_for(db, nxt.approver_id)
    if not email:
        logger.warning(
            "approval notify_submitted: request=%s 1차 결재자(developer=%s) 이메일 없음 — skip",
            request_id, nxt.approver_id,
        )
        return
    blocks = await _build_blocks(db, req, "SUBMITTED",
                                 extra={"단계": f"{nxt.step_no}차 · {nxt.step_name}"})
    await notify_service.send_for_tenant(
        req.tenant_id, text="결재 신청", user_emails=[email], blocks=blocks,
        feature="approval",
    )
    logger.info(
        "approval notify_submitted: request=%s → %s (1차 결재자)",
        request_id, email,
    )


async def notify_step_approved(
    db: AsyncSession, request_id: UUID, *, finalized: bool
) -> None:
    """1단계 승인 후 다음 결재자 / 최종 승인이면 신청자."""
    req = await _load_request(db, request_id)
    if not req:
        logger.warning("approval notify_step_approved: request=%s 없음 — skip", request_id)
        return
    if finalized:
        email = await _email_for(db, req.requester_id)
        if not email:
            logger.warning(
                "approval notify_step_approved(final): request=%s 신청자 이메일 없음",
                request_id,
            )
            return
        blocks = await _build_blocks(db, req, "FINAL_APPROVED")
        await notify_service.send_for_tenant(
            req.tenant_id, text="결재 최종 승인", user_emails=[email], blocks=blocks,
            feature="approval",
        )
        logger.info(
            "approval notify_step_approved(final): request=%s → %s (신청자)",
            request_id, email,
        )
        return
    nxt = _next_pending_step(req.steps)
    if not nxt:
        logger.info(
            "approval notify_step_approved: request=%s 다음 PENDING 없음 — skip",
            request_id,
        )
        return
    email = await _email_for(db, nxt.approver_id)
    if not email:
        logger.warning(
            "approval notify_step_approved: request=%s 다음 결재자(developer=%s) 이메일 없음",
            request_id, nxt.approver_id,
        )
        return
    blocks = await _build_blocks(
        db, req, "SUBMITTED",
        extra={"단계": f"{nxt.step_no}차 · {nxt.step_name}"},
    )
    await notify_service.send_for_tenant(
        req.tenant_id, text="결재 차례", user_emails=[email], blocks=blocks,
        feature="approval",
    )
    logger.info(
        "approval notify_step_approved: request=%s → %s (다음 결재자, %d차)",
        request_id, email, nxt.step_no,
    )


async def notify_step_rejected(
    db: AsyncSession, request_id: UUID, *, comment: str | None
) -> None:
    """반려 — 신청자에게 사유와 함께."""
    req = await _load_request(db, request_id)
    if not req:
        logger.warning("approval notify_step_rejected: request=%s 없음 — skip", request_id)
        return
    email = await _email_for(db, req.requester_id)
    if not email:
        logger.warning(
            "approval notify_step_rejected: request=%s 신청자 이메일 없음 — skip",
            request_id,
        )
        return
    extra = {"사유": comment} if comment else None
    blocks = await _build_blocks(db, req, "REJECTED", extra=extra)
    await notify_service.send_for_tenant(
        req.tenant_id, text="결재 반려", user_emails=[email], blocks=blocks,
        feature="approval",
    )
    logger.info("approval notify_step_rejected: request=%s → %s", request_id, email)


async def notify_cancelled(
    db: AsyncSession, request_id: UUID, *, comment: str | None
) -> None:
    """취소 — PENDING 이었던 결재자들에게."""
    req = await _load_request(db, request_id)
    if not req:
        logger.warning("approval notify_cancelled: request=%s 없음 — skip", request_id)
        return
    pending_emails: list[str] = []
    for s in req.steps:
        if s.status in ("SKIPPED", "PENDING") and s.approver_id:
            e = await _email_for(db, s.approver_id)
            if e:
                pending_emails.append(e)
    pending_emails = list(set(pending_emails))
    if not pending_emails:
        logger.info(
            "approval notify_cancelled: request=%s 통지할 결재자 없음 — skip",
            request_id,
        )
        return
    extra = {"사유": comment} if comment else None
    blocks = await _build_blocks(db, req, "CANCELLED", extra=extra)
    await notify_service.send_for_tenant(
        req.tenant_id, text="결재 취소", user_emails=pending_emails, blocks=blocks,
        feature="approval",
    )
    logger.info(
        "approval notify_cancelled: request=%s → %d명",
        request_id, len(pending_emails),
    )


async def notify_delegated(
    db: AsyncSession, request_id: UUID, *, to_developer_id: UUID, comment: str | None
) -> None:
    """위임받은 사람에게 결재 차례 안내."""
    req = await _load_request(db, request_id)
    if not req:
        logger.warning("approval notify_delegated: request=%s 없음 — skip", request_id)
        return
    email = await _email_for(db, to_developer_id)
    if not email:
        logger.warning(
            "approval notify_delegated: request=%s 수임자(developer=%s) 이메일 없음 — skip",
            request_id, to_developer_id,
        )
        return
    extra = {"코멘트": comment} if comment else None
    blocks = await _build_blocks(db, req, "DELEGATED", extra=extra)
    await notify_service.send_for_tenant(
        req.tenant_id, text="결재 위임", user_emails=[email], blocks=blocks,
        feature="approval",
    )
    logger.info(
        "approval notify_delegated: request=%s → %s (수임자)",
        request_id, email,
    )
