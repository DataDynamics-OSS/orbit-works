"""마케팅 — Google Ads 연동 + 일별 KPI 시계열."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import MarketingCampaign, MarketingGoogleAdsMetric, User
from app.schemas.marketing import GoogleAdsMetricOut, GoogleAdsMetricUpsert
from app.services.marketing import (
    GoogleAdsClientUnavailable,
    sync_google_ads_metrics,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing/google-ads", tags=["marketing-google-ads"])


@router.get("/campaigns/{campaign_id}/metrics", response_model=list[GoogleAdsMetricOut])
async def list_metrics(
    campaign_id: UUID,
    date_from: date | None = None,
    date_to: date | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if not date_to:
        date_to = date.today()
    if not date_from:
        date_from = date_to - timedelta(days=30)
    rows = list(
        (
            await db.execute(
                select(MarketingGoogleAdsMetric)
                .where(
                    MarketingGoogleAdsMetric.campaign_id == campaign_id,
                    MarketingGoogleAdsMetric.metric_date >= date_from,
                    MarketingGoogleAdsMetric.metric_date <= date_to,
                )
                .order_by(MarketingGoogleAdsMetric.metric_date)
            )
        ).scalars()
    )
    return rows


@router.post(
    "/campaigns/{campaign_id}/metrics",
    response_model=GoogleAdsMetricOut,
    status_code=status.HTTP_201_CREATED,
)
async def upsert_metric(
    campaign_id: UUID,
    payload: GoogleAdsMetricUpsert,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """수동 입력/sync 결과를 (campaign_id, metric_date) 단위 upsert."""
    c = (
        await db.execute(
            select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "캠페인을 찾을 수 없습니다.")
    if c.channel != "GOOGLE_ADS":
        raise HTTPException(400, "GOOGLE_ADS 채널 캠페인만 KPI 입력 가능합니다.")

    stmt = (
        pg_insert(MarketingGoogleAdsMetric)
        .values(
            tenant_id=c.tenant_id,
            campaign_id=campaign_id,
            metric_date=payload.metric_date,
            impressions=payload.impressions,
            clicks=payload.clicks,
            cost_micros=payload.cost_micros,
            conversions=payload.conversions,
            conversions_value=payload.conversions_value,
        )
        .on_conflict_do_update(
            index_elements=["campaign_id", "metric_date"],
            set_={
                "impressions": payload.impressions,
                "clicks": payload.clicks,
                "cost_micros": payload.cost_micros,
                "conversions": payload.conversions,
                "conversions_value": payload.conversions_value,
            },
        )
    )
    await db.execute(stmt)
    await db.commit()
    logger.info(
        "Google Ads metric upsert: campaign=%s date=%s impr=%d clicks=%d (입력자=%s)",
        campaign_id,
        payload.metric_date,
        payload.impressions,
        payload.clicks,
        user.id,
    )
    row = (
        await db.execute(
            select(MarketingGoogleAdsMetric).where(
                MarketingGoogleAdsMetric.campaign_id == campaign_id,
                MarketingGoogleAdsMetric.metric_date == payload.metric_date,
            )
        )
    ).scalar_one()
    return row


@router.post("/campaigns/{campaign_id}/sync", response_model=dict)
async def sync_campaign(
    campaign_id: UUID,
    date_from: date | None = Body(None, embed=True),
    date_to: date | None = Body(None, embed=True),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Google Ads API 에서 KPI 동기화 — 1차 stub (SDK·OAuth 미구성 시 503)."""
    c = (
        await db.execute(
            select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(404, "캠페인을 찾을 수 없습니다.")
    if not date_to:
        date_to = date.today()
    if not date_from:
        date_from = date_to - timedelta(days=30)
    try:
        rows_updated = await sync_google_ads_metrics(db, c, date_from, date_to)
    except GoogleAdsClientUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        )
    await db.commit()
    logger.info(
        "Google Ads sync: campaign=%s rows=%d (요청자=%s)", campaign_id, rows_updated, user.id
    )
    return {"updated": rows_updated}
