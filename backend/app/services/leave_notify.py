"""연차 신청 이벤트 Slack 알림.

- 신청 생성  → 관리자(설정 채널) + 신청자 본인
- 승인/반려  → 신청자 본인
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import Developer, DeveloperApprover, LeaveRequest, User
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


def _header(status: str) -> str:
    return {
        "PENDING": "🗓️ 연차 신청",
        "APPROVED": "✅ 연차 승인",
        "REJECTED": "❌ 연차 반려",
        "CANCELLED": "🚫 연차 취소",
    }.get(status, "🗓️ 연차")


def _type_label(row: LeaveRequest) -> str:
    if row.leave_type == "HALF":
        return f"반차 ({row.half_kind})"
    if row.leave_type == "UNPAID_PUBLIC":
        return f"공가 ({row.category or '기타'})"
    return "연차"


async def _load(db: AsyncSession, request_id: UUID) -> LeaveRequest | None:
    return (
        await db.execute(
            select(LeaveRequest)
            .where(LeaveRequest.id == request_id)
            .options(selectinload(LeaveRequest.allocations))
        )
    ).scalar_one_or_none()


async def _build_blocks(db: AsyncSession, row: LeaveRequest, status: str) -> list[dict]:
    dev = (
        await db.execute(select(Developer).where(Developer.id == row.developer_id))
    ).scalar_one_or_none()
    dev_name = dev.name if dev else "-"
    fields = [
        {"type": "mrkdwn", "text": f"*신청자*\n{dev_name}"},
        {"type": "mrkdwn", "text": f"*유형*\n{_type_label(row)}"},
        {
            "type": "mrkdwn",
            "text": f"*기간*\n{row.start_date} ~ {row.end_date} ({row.days_total}일)",
        },
    ]
    if row.reason:
        fields.append({"type": "mrkdwn", "text": f"*사유*\n{row.reason}"})
    if status == "REJECTED" and row.rejected_reason:
        fields.append(
            {"type": "mrkdwn", "text": f"*반려 사유*\n{row.rejected_reason}"}
        )
    return [
        {"type": "header", "text": {"type": "plain_text", "text": _header(status)}},
        {"type": "section", "fields": fields},
    ]


async def _recipients(db: AsyncSession, row: LeaveRequest) -> list[str]:
    """신청자 본인 이메일(+ 관리자 요청 시 admins) 반환."""
    dev = (
        await db.execute(select(Developer).where(Developer.id == row.developer_id))
    ).scalar_one_or_none()
    emails: list[str] = []
    if dev:
        if dev.company_email:
            emails.append(dev.company_email)
        elif dev.personal_email:
            emails.append(dev.personal_email)
    return emails


async def _admin_emails(db: AsyncSession) -> list[str]:
    rows = list(
        (
            await db.execute(
                select(User.email).where(
                    User.role == "ADMIN", User.is_active.is_(True)
                )
            )
        ).scalars()
    )
    # "admin" 처럼 이메일 형태가 아닌 계정은 Slack 조회 실패 → 제외.
    return [e for e in rows if e and "@" in e]


async def _approver_emails(
    db: AsyncSession, developer_id
) -> tuple[list[str], list[str]]:
    """(primary_emails, secondary_emails) 반환.

    직원에게 지정 승인자가 없으면 둘 다 빈 리스트 — 호출측이 admin fallback 사용.
    """
    rows = list(
        (
            await db.execute(
                select(DeveloperApprover, User)
                .join(User, User.id == DeveloperApprover.approver_user_id)
                .where(
                    DeveloperApprover.developer_id == developer_id,
                    User.is_active.is_(True),
                )
            )
        ).all()
    )
    primary: list[str] = []
    secondary: list[str] = []
    for a, u in rows:
        if not u.email or "@" not in u.email:
            continue
        if a.is_primary:
            primary.append(u.email)
        else:
            secondary.append(u.email)
    return primary, secondary


async def notify_created(db: AsyncSession, request_id: UUID) -> None:
    row = await _load(db, request_id)
    if row is None:
        return
    blocks = await _build_blocks(db, row, "PENDING")
    # 신청자 본인 + 지정 승인자 (primary+secondary). 승인자 없으면 admin 풀로 폴백.
    primary, secondary = await _approver_emails(db, row.developer_id)
    target = await _recipients(db, row)
    target += primary + secondary
    if not primary and not secondary:
        target += await _admin_emails(db)
    await notify_service.send_for_tenant(
        row.tenant_id,
        text="연차 신청",
        user_emails=list(set(target)),
        blocks=blocks,
        feature="leave",
    )


async def notify_status_change(
    db: AsyncSession, request_id: UUID, status: str
) -> None:
    row = await _load(db, request_id)
    if row is None:
        return
    blocks = await _build_blocks(db, row, status)
    emails = await _recipients(db, row)
    await notify_service.send_for_tenant(
        row.tenant_id,
        text=f"연차 {status}",
        user_emails=list(set(emails)),
        blocks=blocks,
        feature="leave",
    )
