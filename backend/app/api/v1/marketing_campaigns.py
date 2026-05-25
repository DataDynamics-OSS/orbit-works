"""마케팅 캠페인 — 채널 통합 CRUD + 발송 트리거 + KPI 조회."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    CustomerSegment,
    MarketingCampaign,
    MarketingEmailSend,
    MarketingEmailTemplate,
    MarketingGoogleAdsMetric,
    User,
)
from app.schemas.marketing import (
    CampaignCreate,
    CampaignOut,
    CampaignUpdate,
    EmailSendOut,
)
from app.services.marketing import send_campaign_emails

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing/campaigns", tags=["marketing-campaigns"])


async def _resolve_names(
    db: AsyncSession, campaigns: list[MarketingCampaign]
) -> tuple[dict[UUID, str], dict[UUID, str], dict[UUID, str]]:
    owner_ids = {c.owner_id for c in campaigns if c.owner_id}
    seg_ids = {c.segment_id for c in campaigns if c.segment_id}
    tpl_ids = {c.email_template_id for c in campaigns if c.email_template_id}
    owners: dict[UUID, str] = {}
    segments: dict[UUID, str] = {}
    templates: dict[UUID, str] = {}
    if owner_ids:
        for u in (
            await db.execute(select(User).where(User.id.in_(owner_ids)))
        ).scalars():
            owners[u.id] = u.name or u.email
    if seg_ids:
        for s in (
            await db.execute(
                select(CustomerSegment).where(CustomerSegment.id.in_(seg_ids))
            )
        ).scalars():
            segments[s.id] = s.name
    if tpl_ids:
        for t in (
            await db.execute(
                select(MarketingEmailTemplate).where(
                    MarketingEmailTemplate.id.in_(tpl_ids)
                )
            )
        ).scalars():
            templates[t.id] = t.name
    return owners, segments, templates


async def _email_kpi(db: AsyncSession, campaign_id: UUID) -> dict[str, int]:
    """캠페인의 이메일 발송 KPI 롤업."""
    rows = (
        await db.execute(
            select(MarketingEmailSend.status, func.count(), func.sum(MarketingEmailSend.open_count), func.sum(MarketingEmailSend.click_count))
            .where(MarketingEmailSend.campaign_id == campaign_id)
            .group_by(MarketingEmailSend.status)
        )
    ).all()
    sent = bounced = 0
    opened_total = clicked_total = 0
    for status_, count, opens, clicks in rows:
        if status_ == "SENT":
            sent = int(count or 0)
        elif status_ == "BOUNCED":
            bounced = int(count or 0)
        opened_total += int(opens or 0)
        clicked_total += int(clicks or 0)
    # 오픈 1회 이상 / 클릭 1회 이상 — 별도 count 쿼리.
    opened_count = (
        await db.execute(
            select(func.count(MarketingEmailSend.id)).where(
                MarketingEmailSend.campaign_id == campaign_id,
                MarketingEmailSend.open_count > 0,
            )
        )
    ).scalar_one()
    clicked_count = (
        await db.execute(
            select(func.count(MarketingEmailSend.id)).where(
                MarketingEmailSend.campaign_id == campaign_id,
                MarketingEmailSend.click_count > 0,
            )
        )
    ).scalar_one()
    return {
        "sent": sent,
        "bounced": bounced,
        "opened": int(opened_count or 0),
        "clicked": int(clicked_count or 0),
    }


async def _ga_kpi(db: AsyncSession, campaign_id: UUID) -> dict:
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(MarketingGoogleAdsMetric.impressions), 0),
                func.coalesce(func.sum(MarketingGoogleAdsMetric.clicks), 0),
                func.coalesce(func.sum(MarketingGoogleAdsMetric.cost_micros), 0),
                func.coalesce(func.sum(MarketingGoogleAdsMetric.conversions), 0),
            ).where(MarketingGoogleAdsMetric.campaign_id == campaign_id)
        )
    ).one()
    impressions, clicks, cost_micros, conversions = row
    return {
        "impressions": int(impressions or 0),
        "clicks": int(clicks or 0),
        "cost": Decimal(cost_micros or 0) / Decimal(1_000_000),
        "conversions": Decimal(conversions or 0),
    }


async def _to_out(
    db: AsyncSession,
    c: MarketingCampaign,
    owners: dict[UUID, str],
    segments: dict[UUID, str],
    templates: dict[UUID, str],
    *,
    include_kpi: bool = True,
) -> CampaignOut:
    email_kpi = {"sent": None, "bounced": None, "opened": None, "clicked": None}
    ga_kpi = {"impressions": None, "clicks": None, "cost": None, "conversions": None}
    if include_kpi:
        if c.channel == "EMAIL":
            email_kpi = {k: v for k, v in (await _email_kpi(db, c.id)).items()}
        elif c.channel == "GOOGLE_ADS":
            ga_kpi = await _ga_kpi(db, c.id)

    return CampaignOut(
        id=c.id,
        name=c.name,
        channel=c.channel,  # type: ignore[arg-type]
        status=c.status,  # type: ignore[arg-type]
        objective=c.objective,  # type: ignore[arg-type]
        start_date=c.start_date,
        end_date=c.end_date,
        budget=c.budget,
        actual_cost=c.actual_cost,
        currency=c.currency,
        owner_id=c.owner_id,
        segment_id=c.segment_id,
        utm_source=c.utm_source,
        utm_medium=c.utm_medium,
        utm_campaign=c.utm_campaign,
        notes=c.notes,
        email_template_id=c.email_template_id,
        from_address=c.from_address,
        from_name=c.from_name,
        reply_to=c.reply_to,
        scheduled_at=c.scheduled_at,
        send_started_at=c.send_started_at,
        send_finished_at=c.send_finished_at,
        ga_customer_id=c.ga_customer_id,
        ga_external_id=c.ga_external_id,
        ga_campaign_type=c.ga_campaign_type,  # type: ignore[arg-type]
        ga_daily_budget=c.ga_daily_budget,
        ga_last_synced_at=c.ga_last_synced_at,
        created_at=c.created_at,
        updated_at=c.updated_at,
        owner_name=owners.get(c.owner_id) if c.owner_id else None,
        segment_name=segments.get(c.segment_id) if c.segment_id else None,
        email_template_name=templates.get(c.email_template_id) if c.email_template_id else None,
        sent_count=email_kpi["sent"],
        opened_count=email_kpi["opened"],
        clicked_count=email_kpi["clicked"],
        bounced_count=email_kpi["bounced"],
        ga_impressions=ga_kpi["impressions"],
        ga_clicks=ga_kpi["clicks"],
        ga_cost=ga_kpi["cost"],  # type: ignore[arg-type]
        ga_conversions=ga_kpi["conversions"],  # type: ignore[arg-type]
    )


@router.get("", response_model=list[CampaignOut])
async def list_campaigns(
    channel: str | None = None,
    status_: str | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(MarketingCampaign).order_by(MarketingCampaign.updated_at.desc())
    if channel:
        stmt = stmt.where(MarketingCampaign.channel == channel)
    if status_:
        stmt = stmt.where(MarketingCampaign.status == status_)
    if q:
        stmt = stmt.where(MarketingCampaign.name.ilike(f"%{q}%"))
    rows = list((await db.execute(stmt)).scalars())
    owners, segments, templates = await _resolve_names(db, rows)
    return [await _to_out(db, c, owners, segments, templates) for c in rows]


@router.post("", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    payload: CampaignCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    if not data.get("owner_id"):
        data["owner_id"] = user.id
    c = MarketingCampaign(**data)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info(
        "마케팅 캠페인 등록: id=%s name=%s channel=%s (등록자=%s)",
        c.id,
        c.name,
        c.channel,
        user.id,
    )
    owners, segments, templates = await _resolve_names(db, [c])
    return await _to_out(db, c, owners, segments, templates)


@router.get("/{campaign_id}", response_model=CampaignOut)
async def get_campaign(
    campaign_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    c = (
        await db.execute(
            select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "캠페인을 찾을 수 없습니다.")
    owners, segments, templates = await _resolve_names(db, [c])
    return await _to_out(db, c, owners, segments, templates)


@router.patch("/{campaign_id}", response_model=CampaignOut)
async def update_campaign(
    campaign_id: UUID,
    payload: CampaignUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = (
        await db.execute(
            select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "캠페인을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(c, k, v)
    await db.commit()
    await db.refresh(c)
    logger.info(
        "마케팅 캠페인 수정: id=%s 변경=%s (수정자=%s)", c.id, list(data.keys()), user.id
    )
    owners, segments, templates = await _resolve_names(db, [c])
    return await _to_out(db, c, owners, segments, templates)


@router.delete("/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_campaign(
    campaign_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = (
        await db.execute(
            select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "캠페인을 찾을 수 없습니다.")
    logger.warning("마케팅 캠페인 삭제: id=%s name=%s (삭제자=%s)", c.id, c.name, user.id)
    await db.delete(c)
    await db.commit()


@router.post("/{campaign_id}/send", response_model=dict)
async def send_campaign(
    campaign_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """이메일 캠페인 즉시 발송. 세그먼트의 모든 수신자에 동기 발송 (소규모용)."""
    c = (
        await db.execute(
            select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "캠페인을 찾을 수 없습니다.")
    if c.channel != "EMAIL":
        raise HTTPException(400, "EMAIL 채널 캠페인만 발송할 수 있습니다.")
    if c.status == "RUNNING":
        raise HTTPException(409, "이미 발송 중입니다.")
    try:
        counts = await send_campaign_emails(db, c, actor_user_id=user.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await db.commit()
    return counts


@router.get("/{campaign_id}/sends", response_model=list[EmailSendOut])
async def list_sends(
    campaign_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """발송 로그 (수신자 단위) — 캠페인 detail 페이지에서 사용."""
    sends = list(
        (
            await db.execute(
                select(MarketingEmailSend)
                .where(MarketingEmailSend.campaign_id == campaign_id)
                .order_by(MarketingEmailSend.created_at.desc())
            )
        ).scalars()
    )
    if not sends:
        return []
    # contact·customer 이름 resolve
    from app.models import Customer, CustomerContact

    contact_ids = {s.customer_contact_id for s in sends if s.customer_contact_id}
    cust_ids = {s.customer_id for s in sends if s.customer_id}
    contacts: dict[UUID, CustomerContact] = {}
    customers: dict[UUID, Customer] = {}
    if contact_ids:
        for c in (
            await db.execute(
                select(CustomerContact).where(CustomerContact.id.in_(contact_ids))
            )
        ).scalars():
            contacts[c.id] = c
    if cust_ids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cust_ids)))
        ).scalars():
            customers[c.id] = c

    out: list[EmailSendOut] = []
    for s in sends:
        out.append(
            EmailSendOut(
                id=s.id,
                campaign_id=s.campaign_id,
                customer_id=s.customer_id,
                customer_contact_id=s.customer_contact_id,
                to_address=s.to_address,
                status=s.status,  # type: ignore[arg-type]
                sent_at=s.sent_at,
                error_message=s.error_message,
                open_count=s.open_count,
                first_opened_at=s.first_opened_at,
                last_opened_at=s.last_opened_at,
                click_count=s.click_count,
                first_clicked_at=s.first_clicked_at,
                last_clicked_at=s.last_clicked_at,
                unsubscribed_at=s.unsubscribed_at,
                contact_name=contacts[s.customer_contact_id].name
                if s.customer_contact_id and s.customer_contact_id in contacts
                else None,
                customer_name=customers[s.customer_id].name
                if s.customer_id and s.customer_id in customers
                else None,
            )
        )
    return out
