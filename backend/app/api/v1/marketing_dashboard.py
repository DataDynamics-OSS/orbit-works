"""마케팅 대시보드 — 위젯용 통합 KPI + 수신거부 마스터 CRUD."""

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
    MarketingCampaign,
    MarketingEmailSend,
    MarketingEmailUnsubscribe,
    MarketingGoogleAdsMetric,
    User,
)
from app.schemas.marketing import (
    MarketingDashboardSummary,
    UnsubscribeCreate,
    UnsubscribeOut,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing", tags=["marketing-dashboard"])


@router.get("/dashboard", response_model=MarketingDashboardSummary)
async def dashboard_summary(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """최근 30일 기준 KPI 위젯 데이터."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    date_cutoff = date.today() - timedelta(days=30)

    # 캠페인 카운트
    total_c, active_c, completed_c, email_c, ga_c = (
        await db.execute(
            select(
                func.count(MarketingCampaign.id),
                func.count().filter(MarketingCampaign.status == "RUNNING"),
                func.count().filter(MarketingCampaign.status == "COMPLETED"),
                func.count().filter(MarketingCampaign.channel == "EMAIL"),
                func.count().filter(MarketingCampaign.channel == "GOOGLE_ADS"),
            )
        )
    ).one()

    # 이메일 KPI (30일)
    sent_30 = (
        await db.execute(
            select(func.count(MarketingEmailSend.id)).where(
                MarketingEmailSend.status == "SENT",
                MarketingEmailSend.sent_at >= cutoff,
            )
        )
    ).scalar_one()
    opened_30 = (
        await db.execute(
            select(func.count(MarketingEmailSend.id)).where(
                MarketingEmailSend.first_opened_at >= cutoff,
            )
        )
    ).scalar_one()
    clicked_30 = (
        await db.execute(
            select(func.count(MarketingEmailSend.id)).where(
                MarketingEmailSend.first_clicked_at >= cutoff,
            )
        )
    ).scalar_one()
    unsubs = (
        await db.execute(
            select(func.count(MarketingEmailUnsubscribe.id))
        )
    ).scalar_one()

    open_rate = round(opened_30 / sent_30, 4) if sent_30 else 0.0
    click_rate = round(clicked_30 / sent_30, 4) if sent_30 else 0.0

    # Google Ads (30일)
    ga_imp, ga_clicks, ga_cost_micros, ga_conv = (
        await db.execute(
            select(
                func.coalesce(func.sum(MarketingGoogleAdsMetric.impressions), 0),
                func.coalesce(func.sum(MarketingGoogleAdsMetric.clicks), 0),
                func.coalesce(func.sum(MarketingGoogleAdsMetric.cost_micros), 0),
                func.coalesce(func.sum(MarketingGoogleAdsMetric.conversions), 0),
            ).where(MarketingGoogleAdsMetric.metric_date >= date_cutoff)
        )
    ).one()

    return MarketingDashboardSummary(
        total_campaigns=int(total_c or 0),
        active_campaigns=int(active_c or 0),
        completed_campaigns=int(completed_c or 0),
        email_campaigns=int(email_c or 0),
        google_ads_campaigns=int(ga_c or 0),
        emails_sent_30d=int(sent_30 or 0),
        emails_opened_30d=int(opened_30 or 0),
        emails_clicked_30d=int(clicked_30 or 0),
        open_rate_30d=open_rate,
        click_rate_30d=click_rate,
        unsubscribe_count=int(unsubs or 0),
        ga_impressions_30d=int(ga_imp or 0),
        ga_clicks_30d=int(ga_clicks or 0),
        ga_cost_30d_micros=int(ga_cost_micros or 0),
        ga_conversions_30d=Decimal(ga_conv or 0),
    )


# ---------------------------------------------------------------------------
# 수신거부 마스터 CRUD
# ---------------------------------------------------------------------------


@router.get("/unsubscribes", response_model=list[UnsubscribeOut])
async def list_unsubscribes(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(MarketingEmailUnsubscribe).order_by(
                    MarketingEmailUnsubscribe.unsubscribed_at.desc()
                )
            )
        ).scalars()
    )
    return rows


@router.post(
    "/unsubscribes",
    response_model=UnsubscribeOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_unsubscribe(
    payload: UnsubscribeCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    email = payload.email.lower()
    existing = (
        await db.execute(
            select(MarketingEmailUnsubscribe).where(
                func.lower(MarketingEmailUnsubscribe.email) == email
            )
        )
    ).scalar_one_or_none()
    if existing:
        return existing
    row = MarketingEmailUnsubscribe(
        email=email,
        reason=payload.reason or "manual",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("수신거부 수동 추가: email=%s (등록자=%s)", email, user.id)
    return row


@router.delete(
    "/unsubscribes/{unsub_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_unsubscribe(
    unsub_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(MarketingEmailUnsubscribe).where(
                MarketingEmailUnsubscribe.id == unsub_id
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "항목을 찾을 수 없습니다.")
    logger.warning("수신거부 삭제: id=%s email=%s (삭제자=%s)", row.id, row.email, user.id)
    await db.delete(row)
    await db.commit()
