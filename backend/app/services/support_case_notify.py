"""신규 케이스 등록 시 SUPPORT 역할 사용자에게 DM 발송.

알림 내용: 고객사, 제목, 벤더, 제품, 심각도, 케이스 상세 link.

수신자: 같은 tenant 의 user.role == "SUPPORT" 이고 활성 + 이메일 존재.
ADMIN/SUPER_ADMIN 은 SUPPORT 권한을 자동 포함하지만 — 이 알림의 목적은
실제 기술지원 인력 호출이라 SUPPORT 역할로 제한.

알림 비활성/이메일 없음/대상 0명 등은 silently skip — 케이스 등록 자체는
실패시키지 않는다 (호출 측에서 try/except 로 감싸 호출).
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Customer,
    Developer,
    Project,
    SupportCase,
    SupportCaseComment,
    User,
)
from app.core.config import get_settings
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


SEVERITY_LABEL = {
    "S1": "S1 (긴급)",
    "S2": "S2 (높음)",
    "S3": "S3 (보통)",
    "S4": "S4 (낮음)",
}
VENDOR_LABEL = {
    "DATABRICKS": "Databricks",
    "MONGODB": "MongoDB",
    "CLOUDERA": "Cloudera",
    "OTHER": "기타",
}


async def notify_new_support_case(
    db: AsyncSession,
    *,
    case_id: UUID,
) -> None:
    """신규 케이스 → SUPPORT 역할 DM. 발송 실패는 silently swallow."""
    case = (
        await db.execute(select(SupportCase).where(SupportCase.id == case_id))
    ).scalar_one_or_none()
    if not case:
        logger.warning("support_case_notify: case=%s 없음 — skip", case_id)
        return

    # 고객사 이름.
    customer_name = "(고객사 미지정)"
    if case.customer_id:
        cn = (
            await db.execute(
                select(Customer.name).where(Customer.id == case.customer_id)
            )
        ).scalar_one_or_none()
        if cn:
            customer_name = cn

    # 같은 tenant 의 SUPPORT 역할 + 활성 + 이메일 있음.
    recipients = list(
        (
            await db.execute(
                select(User).where(
                    User.tenant_id == case.tenant_id,
                    User.role == "SUPPORT",
                    User.is_active.is_(True),
                )
            )
        )
        .scalars()
    )
    emails = [u.email for u in recipients if u.email and "@" in u.email]
    if not emails:
        logger.info(
            "support_case_notify: case=%s SUPPORT 역할 수신자 0명 — skip",
            case_id,
        )
        return

    # vendor/product 는 카탈로그 FK → 이름 lookup. nullable.
    vendor_name = "—"
    product_name = "—"
    if case.vendor_id:
        from app.models import Vendor

        vname = (
            await db.execute(select(Vendor.name).where(Vendor.id == case.vendor_id))
        ).scalar_one_or_none()
        if vname:
            vendor_name = vname
    # products 는 다대다 join 으로 변경됨 — 첫 번째 (sort_order=0) product 의 이름을
    # 알림 카드의 "제품" 자리에 표시. 여러 개면 ", +N" 형태로 축약.
    from app.models import Product, SupportCaseProduct

    prod_rows = (
        await db.execute(
            select(Product.name, SupportCaseProduct.sort_order)
            .join(Product, Product.id == SupportCaseProduct.product_id)
            .where(SupportCaseProduct.support_case_id == case.id)
            .order_by(SupportCaseProduct.sort_order)
        )
    ).all()
    if prod_rows:
        first = prod_rows[0][0]
        if len(prod_rows) > 1:
            product_name = f"{first} 외 {len(prod_rows) - 1}건"
        else:
            product_name = first

    severity = SEVERITY_LABEL.get(str(case.severity), str(case.severity))
    link_key = case.case_no or str(case.id)
    base = get_settings().server.public_url.rstrip("/")
    link = f"{base}/support-cases/{link_key}"

    title_with_no = case.case_no and f"[{case.case_no}] {case.title}" or case.title
    fields = [
        {"type": "mrkdwn", "text": f"*고객사*\n{customer_name}"},
        {"type": "mrkdwn", "text": f"*제목*\n{title_with_no}"},
        {"type": "mrkdwn", "text": f"*벤더*\n{vendor_name}"},
        {"type": "mrkdwn", "text": f"*제품*\n{product_name}"},
        {"type": "mrkdwn", "text": f"*심각도*\n{severity}"},
        {"type": "mrkdwn", "text": f"*링크*\n<{link}|케이스 열기>"},
    ]
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🛟 신규 기술지원 케이스"},
        },
        {"type": "section", "fields": fields},
    ]

    await notify_service.send_for_tenant(
        case.tenant_id,
        text=f"[케이스] {customer_name} · {case.title} ({severity})",
        user_emails=emails,
        blocks=blocks,
        feature="support_case",
    )
    logger.info(
        "support_case_notify: case=%s customer=%s → SUPPORT %d명",
        case_id, customer_name, len(emails),
    )


# 코멘트 미리보기 길이 — Slack/MM section text 의 안전한 길이 + 본문이 길어도
# DM 만 보고 흐름 파악 가능한 정도. 초과분은 단어 단위가 아닌 단순 잘라내기 + '…'.
_COMMENT_PREVIEW_MAX = 300


async def notify_new_support_comment(
    db: AsyncSession,
    *,
    case_id: UUID,
    comment_id: UUID,
    author_user_id: UUID,
) -> None:
    """케이스 코멘트 추가 → 같은 tenant SUPPORT 역할 DM (작성자 본인 제외).

    메시지 필드: 고객사, 케이스 제목, 프로젝트, 기술지원 담당자, 심각도,
    작성자, 링크 + 코멘트 본문 미리보기. 발송 실패는 silently swallow.
    """
    case = (
        await db.execute(select(SupportCase).where(SupportCase.id == case_id))
    ).scalar_one_or_none()
    if not case:
        logger.warning("support_comment_notify: case=%s 없음 — skip", case_id)
        return
    comment = (
        await db.execute(
            select(SupportCaseComment).where(SupportCaseComment.id == comment_id)
        )
    ).scalar_one_or_none()
    if not comment:
        logger.warning("support_comment_notify: comment=%s 없음 — skip", comment_id)
        return

    customer_name = "(고객사 미지정)"
    if case.customer_id:
        cn = (
            await db.execute(
                select(Customer.name).where(Customer.id == case.customer_id)
            )
        ).scalar_one_or_none()
        if cn:
            customer_name = cn

    project_name = "—"
    if case.project_id:
        pn = (
            await db.execute(
                select(Project.name).where(Project.id == case.project_id)
            )
        ).scalar_one_or_none()
        if pn:
            project_name = pn

    engineer_name = "—"
    if case.support_engineer_developer_id:
        en = (
            await db.execute(
                select(Developer.name).where(
                    Developer.id == case.support_engineer_developer_id
                )
            )
        ).scalar_one_or_none()
        if en:
            engineer_name = en

    # 작성자 — 이름 우선, 없으면 이메일.
    author = (
        await db.execute(select(User).where(User.id == author_user_id))
    ).scalar_one_or_none()
    author_name = "(알 수 없음)"
    if author:
        author_name = author.name or author.email or "(알 수 없음)"

    # 같은 tenant SUPPORT — 작성자 본인은 제외 (자기 코멘트 DM 노이즈 차단).
    recipients = list(
        (
            await db.execute(
                select(User).where(
                    User.tenant_id == case.tenant_id,
                    User.role == "SUPPORT",
                    User.is_active.is_(True),
                    User.id != author_user_id,
                )
            )
        )
        .scalars()
    )
    emails = [u.email for u in recipients if u.email and "@" in u.email]
    if not emails:
        logger.info(
            "support_comment_notify: case=%s SUPPORT 수신자 0명 (작성자 제외 후) — skip",
            case_id,
        )
        return

    severity = SEVERITY_LABEL.get(str(case.severity), str(case.severity))
    link_key = case.case_no or str(case.id)
    base = get_settings().server.public_url.rstrip("/")
    link = f"{base}/support-cases/{link_key}"

    body_text = (comment.body or "").strip()
    if len(body_text) > _COMMENT_PREVIEW_MAX:
        body_preview = body_text[:_COMMENT_PREVIEW_MAX] + "…"
    else:
        body_preview = body_text or "(빈 코멘트)"

    title_with_no = case.case_no and f"[{case.case_no}] {case.title}" or case.title
    fields = [
        {"type": "mrkdwn", "text": f"*고객사*\n{customer_name}"},
        {"type": "mrkdwn", "text": f"*케이스 제목*\n{title_with_no}"},
        {"type": "mrkdwn", "text": f"*프로젝트*\n{project_name}"},
        {"type": "mrkdwn", "text": f"*기술지원 담당자*\n{engineer_name}"},
        {"type": "mrkdwn", "text": f"*심각도*\n{severity}"},
        {"type": "mrkdwn", "text": f"*작성자*\n{author_name}"},
        {"type": "mrkdwn", "text": f"*링크*\n<{link}|케이스 열기>"},
    ]
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "💬 케이스 코멘트 추가"},
        },
        {"type": "section", "fields": fields},
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*코멘트*\n{body_preview}"},
        },
    ]

    await notify_service.send_for_tenant(
        case.tenant_id,
        text=f"[케이스 코멘트] {customer_name} · {case.title} — {author_name}",
        user_emails=emails,
        blocks=blocks,
        feature="support_case_comment",
    )
    logger.info(
        "support_comment_notify: case=%s comment=%s author=%s → SUPPORT %d명",
        case_id, comment_id, author_user_id, len(emails),
    )
