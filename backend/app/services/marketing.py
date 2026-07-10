"""마케팅 도메인 서비스 — 세그먼트 추출, 머지필드 치환, 캠페인 이메일 발송.

발송은 기존 `app.services.mail.MailService` 를 그대로 재사용한다. 마케팅 메일도
같은 SMTP 자격증명이지만, 발송 직전 수신거부·트래킹 픽셀·수신거부 링크를 추가해
법적 의무(정보통신망법 50조) 와 발송 추적을 만족시킨다.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import quote
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import (
    Customer,
    CustomerContact,
    CustomerSegment,
    MarketingCampaign,
    MarketingCampaignTouch,
    MarketingEmailSend,
    MarketingEmailTemplate,
    MarketingEmailUnsubscribe,
)
from app.services.mail import mail_service
from app.services.storage import resolve_upload_path

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 세그먼트 → 수신자 추출
# ---------------------------------------------------------------------------


async def resolve_recipients(
    db: AsyncSession, segment: CustomerSegment
) -> list[tuple[CustomerContact, Customer | None]]:
    """세그먼트 정의에 매칭되는 (contact, customer) 페어 목록.

    규칙:
    - contact_ids 가 비어있지 않으면 그 contact 만 (가장 우선).
    - customer_ids 가 비어있지 않으면 그 회사의 모든 contact (kind 필터 적용).
    - 둘 다 비어있으면 tenant 의 모든 contact (kind 필터 적용).

    이메일 누락 contact 는 자동 제외 (발송 불가).
    """
    kinds = list(segment.include_kinds or ["CUSTOMER"])

    if segment.contact_ids:
        stmt = select(CustomerContact).where(
            CustomerContact.id.in_(segment.contact_ids),
            CustomerContact.email.isnot(None),
            CustomerContact.email != "",
        )
    else:
        stmt = select(CustomerContact).where(
            CustomerContact.email.isnot(None),
            CustomerContact.email != "",
            CustomerContact.kind.in_(kinds),
        )
        if segment.customer_ids:
            stmt = stmt.where(CustomerContact.customer_id.in_(segment.customer_ids))

    contacts = list((await db.execute(stmt)).scalars())
    if not contacts:
        return []

    cust_ids = {c.customer_id for c in contacts if c.customer_id}
    customers: dict[UUID, Customer] = {}
    if cust_ids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cust_ids)))
        ).scalars():
            customers[c.id] = c

    out: list[tuple[CustomerContact, Customer | None]] = []
    for contact in contacts:
        customer = customers.get(contact.customer_id) if contact.customer_id else None
        out.append((contact, customer))
    return out


# ---------------------------------------------------------------------------
# 머지필드 치환
# ---------------------------------------------------------------------------


_MERGE_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


def render_template(
    text: str,
    contact: CustomerContact,
    customer: Customer | None,
) -> str:
    """`{{key}}` 단순 치환. 알 수 없는 키는 빈 문자열로 치환."""
    if not text:
        return ""

    values: dict[str, str] = {
        "contact_name": contact.name or "",
        "contact_email": contact.email or "",
        "contact_title": contact.title or "",
        "customer_name": customer.name if customer else "",
        "customer_representative": customer.representative if customer else "",
    }
    return _MERGE_PATTERN.sub(lambda m: values.get(m.group(1), ""), text)


# ---------------------------------------------------------------------------
# 트래킹 — 픽셀 / 클릭 리다이렉트
# ---------------------------------------------------------------------------


def get_tracking_base_url() -> str:
    """이메일 본문에 박힐 트래킹 URL 의 base.

    `mail.notifications.public_base_url` 가 있으면 우선, 없으면 config.yaml 의
    server.public_url. 둘 다 없으면 빈 문자열 (트래킹 비활성).
    """
    settings = get_settings()
    cfg = settings.mail.notifications
    base = getattr(cfg, "public_base_url", None) or ""
    if not base:
        base = getattr(settings, "server", None)
        base = getattr(base, "public_url", "") if base else ""
    return (base or "").rstrip("/")


def build_tracked_body(
    body_html: str,
    body_text: str,
    send_id: UUID,
    unsubscribe_token: str | None,
) -> tuple[str, str, str]:
    """본문 끝에 수신거부 푸터(법정 필수) + 트래킹 픽셀 부착.

    반환: (body_html, body_text, unsub_url). unsub_url 은 List-Unsubscribe 헤더용.

    수신거부 푸터는 정보통신망법 50조상 (광고) 메일에 반드시 들어가야 하므로
    트래킹(픽셀/클릭)과 **독립적으로** 부착한다. 단 절대 URL 이 필요하므로 base
    가 없으면 링크를 만들 수 없다 — 이 경우 호출부(`send_campaign_emails`)에서
    발송 자체를 막아야 한다. (base 가 빈 채로 여기 도달하면 푸터 없이 나가므로
    호출부 가드가 1차 방어선.)

    클릭 트래킹은 본문 내 `[[track:URL]]` 토큰을 리다이렉트 URL 로 치환.
    """
    base = get_tracking_base_url()
    pixel_html = ""
    footer_html = ""
    footer_text = ""
    unsub_url = ""

    if base:
        pixel_url = f"{base}/api/v1/marketing/track/open/{send_id}.png"
        pixel_html = (
            f'<img src="{pixel_url}" width="1" height="1" '
            f'alt="" style="display:none;border:0;outline:none;text-decoration:none" />'
        )
        # `[[track:URL]]` 토큰 → 리다이렉트 URL 로 치환.
        click_re = re.compile(r"\[\[track:([^\]]+)\]\]")

        def _click(match: re.Match[str]) -> str:
            target = match.group(1).strip()
            return f"{base}/api/v1/marketing/track/click/{send_id}?url={quote(target, safe='')}"

        body_html = click_re.sub(_click, body_html)
        body_text = click_re.sub(_click, body_text)

    # 수신거부 푸터 — 트래킹 비활성(base 만 없는 케이스)과 무관하게, 토큰과 base
    # 가 있으면 항상 부착. base 가 없으면 호출부가 이미 발송을 막았어야 한다.
    if unsubscribe_token and base:
        unsub_url = f"{base}/api/v1/marketing/track/unsubscribe/{unsubscribe_token}"
        footer_html = (
            "<hr style='margin-top:24px;border:none;border-top:1px solid #e5e7eb'/>"
            f"<p style='color:#6b7280;font-size:12px'>"
            f'(광고) 수신을 원치 않으시면 <a href="{unsub_url}">여기를 클릭</a>'
            "해 수신을 해지하실 수 있습니다."
            "</p>"
        )
        footer_text = f"\n\n---\n(광고) 수신거부: {unsub_url}\n"

    if body_html:
        body_html = body_html + footer_html + pixel_html
    if body_text:
        body_text = body_text + footer_text
    return body_html, body_text, unsub_url


# ---------------------------------------------------------------------------
# 캠페인 이메일 발송
# ---------------------------------------------------------------------------


def _signed_token(tenant_id: UUID | str, email: str) -> str:
    """수신거부 링크용 토큰 — JWT 의존 회피 위해 단순 HMAC.

    토큰: base64url(sha256(secret || tenant_id || email).hex || ':' || email).
    검증 라우터에서 다시 계산해 일치 확인.
    """
    import base64
    import hashlib

    settings = get_settings()
    secret = (
        getattr(settings.auth, "jwt_secret", None)
        or getattr(settings, "secret_key", None)
        or "orbit-works-marketing"
    )
    raw = f"{secret}|{tenant_id}|{email.lower()}".encode()
    digest = hashlib.sha256(raw).hexdigest()[:24]
    payload = f"{digest}:{email.lower()}"
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def verify_token(tenant_id: UUID | str, token: str) -> str | None:
    """토큰 → email 복원. 실패 시 None."""
    import base64

    try:
        padding = "=" * (-len(token) % 4)
        decoded = base64.urlsafe_b64decode(token + padding).decode()
        digest, _, email = decoded.partition(":")
        if not email:
            return None
        if _signed_token(tenant_id, email).rstrip("=") != token.rstrip("="):
            return None
        return email
    except Exception:
        return None


def _collect_inline_images(
    template: MarketingEmailTemplate,
) -> list[tuple[str, bytes, str]]:
    """본문에서 참조되는 cid 자산을 디스크에서 읽어 (cid, bytes, mime) 로 반환.

    참조되지 않는 자산은 묶지 않아 메일 사이즈를 절감. 본문에 cid 가 있는데
    디스크에서 못 읽으면 WARNING — 메일은 깨진 이미지로 가지만 발송은 계속.
    """
    body = template.body_html or ""
    if "cid:" not in body:
        return []
    # 본문에서 src="cid:XXX" / src='cid:XXX' / src=cid:XXX 모두 잡음.
    referenced = set(re.findall(r"cid:([A-Za-z0-9_-]+)", body))
    out: list[tuple[str, bytes, str]] = []
    for a in template.assets or []:
        if a.content_id not in referenced:
            continue
        try:
            p = resolve_upload_path(a.file_path)
            with open(p, "rb") as f:
                content = f.read()
        except Exception as exc:
            logger.warning(
                "이메일 인라인 자산 로드 실패 — 깨진 이미지로 발송: template=%s cid=%s path=%s err=%s",
                template.id, a.content_id, a.file_path, exc,
            )
            continue
        out.append((a.content_id, content, a.mime_type or "application/octet-stream"))
    return out


async def send_campaign_emails(
    db: AsyncSession,
    campaign: MarketingCampaign,
    actor_user_id: UUID | None,
) -> dict[str, int]:
    """캠페인의 EMAIL 발송 트리거. 결과 카운트 반환 (sent/skipped/failed)."""
    if campaign.channel != "EMAIL":
        raise ValueError("EMAIL 채널 캠페인만 발송할 수 있습니다.")
    if not campaign.email_template_id:
        raise ValueError("이메일 템플릿이 지정되지 않았습니다.")
    if not campaign.segment_id:
        raise ValueError("발송 세그먼트가 지정되지 않았습니다.")

    template = (
        await db.execute(
            select(MarketingEmailTemplate)
            .options(selectinload(MarketingEmailTemplate.assets))
            .where(MarketingEmailTemplate.id == campaign.email_template_id)
        )
    ).scalar_one_or_none()
    if not template:
        raise ValueError("이메일 템플릿을 찾을 수 없습니다.")

    # 본문에 cid: 참조가 있다면 해당 자산을 디스크에서 읽어 multipart/related 로
    # 함께 보낸다. 본문이 자산을 참조하지 않으면 빈 리스트 — multipart 가 아닌
    # 단순 html 발송이 됨.
    inline_images = _collect_inline_images(template)

    segment = (
        await db.execute(
            select(CustomerSegment).where(CustomerSegment.id == campaign.segment_id)
        )
    ).scalar_one_or_none()
    if not segment:
        raise ValueError("세그먼트를 찾을 수 없습니다.")

    recipients = await resolve_recipients(db, segment)
    if not recipients:
        raise ValueError("세그먼트에서 발송 대상 수신자가 0명입니다.")

    # 수신거부 링크는 절대 URL 이 필요. base 가 없으면 (광고) 메일에 법정 필수
    # 수신거부 수단을 넣을 수 없으므로 발송 자체를 차단한다. (조용히 빠진 채
    # 발송되면 정보통신망법 50조 위반.)
    if not get_tracking_base_url():
        raise ValueError(
            "공개 base URL 이 설정되지 않아 수신거부 링크를 생성할 수 없습니다. "
            "config.yaml 의 mail.notifications.public_base_url 또는 server.public_url 을 "
            "운영 도메인(https://…)으로 설정한 뒤 다시 발송하세요. "
            "(법정 필수 수신거부 수단 누락 방지를 위해 발송을 차단했습니다.)"
        )

    # 수신거부 lookup — lower(email) 매칭. tenant 격리는 RLS 가 자동.
    unsub_rows = (
        await db.execute(
            select(func.lower(MarketingEmailUnsubscribe.email))
        )
    ).scalars()
    unsubscribed = {e for e in unsub_rows if e}

    campaign.send_started_at = datetime.now(timezone.utc)
    campaign.status = "RUNNING"
    await db.flush()

    counts = {"sent": 0, "skipped": 0, "failed": 0, "total": len(recipients)}

    for contact, customer in recipients:
        to_addr = (contact.email or "").strip()
        if not to_addr:
            continue

        send = MarketingEmailSend(
            campaign_id=campaign.id,
            customer_id=contact.customer_id,
            customer_contact_id=contact.id,
            to_address=to_addr,
            status="QUEUED",
        )
        db.add(send)
        await db.flush()

        if to_addr.lower() in unsubscribed:
            send.status = "SKIPPED_UNSUBSCRIBED"
            counts["skipped"] += 1
            continue

        subject = render_template(template.subject, contact, customer)
        body_html = render_template(template.body_html, contact, customer)
        body_text = render_template(template.body_text, contact, customer)

        token = _signed_token(campaign.tenant_id, to_addr)
        body_html, body_text, unsub_url = build_tracked_body(
            body_html, body_text, send.id, token
        )

        from_name = (campaign.from_name or "").strip()
        reply_to = (campaign.reply_to or "").strip()
        attachments = None
        # MailService 가 cfg.sender.email 을 발신자로 강제 — 캠페인 from_address
        # 는 record 용으로만 저장. (운영/마케팅 발신 도메인 분리는 2차에 별도
        # MailConfig profile 도입.)
        try:
            ok = await mail_service.send_for_tenant(
                tenant_id=campaign.tenant_id,
                subject=subject,
                body=body_html if body_html else body_text,
                to=[to_addr],
                html=bool(body_html),
                attachments=attachments,
                inline_images=inline_images,
                list_unsubscribe_url=unsub_url or None,
            )
        except Exception as exc:
            ok = False
            send.error_message = str(exc)[:500]

        now = datetime.now(timezone.utc)
        if ok:
            send.status = "SENT"
            send.sent_at = now
            counts["sent"] += 1
            db.add(
                MarketingCampaignTouch(
                    campaign_id=campaign.id,
                    customer_id=contact.customer_id,
                    customer_contact_id=contact.id,
                    touch_type="SENT",
                    occurred_at=now,
                )
            )
        else:
            send.status = "FAILED"
            counts["failed"] += 1

    campaign.send_finished_at = datetime.now(timezone.utc)
    campaign.status = "COMPLETED"
    template.last_used_at = datetime.now(timezone.utc)

    logger.info(
        "마케팅 캠페인 발송 완료: id=%s sent=%d skipped=%d failed=%d total=%d (actor=%s)",
        campaign.id,
        counts["sent"],
        counts["skipped"],
        counts["failed"],
        counts["total"],
        actor_user_id,
    )
    return counts


# ---------------------------------------------------------------------------
# Google Ads — 인터페이스 (1차 stub)
# ---------------------------------------------------------------------------


class GoogleAdsClientUnavailable(RuntimeError):
    """Google Ads SDK 미설치 / OAuth 자격증명 미설정."""


async def sync_google_ads_metrics(
    db: AsyncSession,
    campaign: MarketingCampaign,
    date_from,
    date_to,
) -> int:
    """Google Ads API 에서 일별 KPI 를 가져와 marketing_google_ads_metrics 에 upsert.

    1차 stub — 실제 API 호출은 `google-ads` SDK 와 OAuth refresh token 이
    필요. 설정이 없으면 친절한 메시지로 RuntimeError.

    2차에서 `app.services.google_ads_client` 추가하여 실제 sync 구현.
    """
    raise GoogleAdsClientUnavailable(
        "Google Ads API 연동은 아직 활성화되지 않았습니다. "
        "설정 > 마케팅 > Google Ads 에서 OAuth 인증 후 동기화 가능합니다. "
        "현재는 수동 입력만 지원합니다."
    )
