"""클라우드 비용 API — list / summary / fetch / fetches.

권한:
- 조회 (`GET /cloud-costs`, `/summary`, `/fetches`): 메뉴 권한 (`cloud_costs.view`).
- 수동 수집 (`POST /cloud-costs/fetch`): 인증된 사용자 (자격증명을 직접 노출하지
  않으므로 announcements 와 동일하게 비교적 느슨하게).
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.config import get_tenant_section
from app.core.database import get_db
from app.models import (
    CloudCost,
    CloudCostAlertEvent,
    CloudCostAlertRule,
    CloudCostFetch,
    User,
)
from app.schemas.cloud_cost import (
    CloudCostFetchOut,
    CloudCostOut,
    CloudCostSummaryRow,
    CloudProvider,
    FetchTriggerRequest,
    FetchTriggerResponse,
)
from app.schemas.cloud_cost_alert import (
    AlertEventOut,
    AlertRuleCreate,
    AlertRuleOut,
    AlertRuleUpdate,
)
from app.services.cloud_cost import (
    evaluate_one_rule,
    fetch_and_upsert_range,
    get_providers,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/cloud-costs", tags=["cloud-costs"])


# ---------------------------------------------------------------------------
# 조회
# ---------------------------------------------------------------------------


@router.get("", response_model=list[CloudCostOut])
async def list_costs(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
    provider: CloudProvider | None = None,
    account_id: str | None = None,
    include_total: bool = False,
):
    """일별 service-level row 목록.

    기본은 service NULL/'' (account 합계 row) 를 *제외* — 차트 표시용. 합계까지
    포함하려면 `include_total=true`.
    """
    if to is None:
        to = date.today()
    if from_ is None:
        from_ = to - timedelta(days=30)

    q = (
        select(CloudCost)
        .where(CloudCost.usage_date >= from_, CloudCost.usage_date <= to)
        .order_by(CloudCost.usage_date.desc(), CloudCost.amount.desc())
    )
    if provider:
        q = q.where(CloudCost.provider == provider)
    if account_id:
        q = q.where(CloudCost.account_id == account_id)
    if not include_total:
        q = q.where(CloudCost.service.is_not(None), CloudCost.service != "")
    rows = list((await db.execute(q)).scalars())
    return rows


@router.get("/summary", response_model=list[CloudCostSummaryRow])
async def summary(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
    provider: CloudProvider | None = None,
):
    """대시보드 차트용 — 일자 + provider + service 별 KRW 합계.

    `service IS NULL/''` (account 합계) 는 제외하여 service 별 시계열로만 반환.
    """
    if to is None:
        to = date.today()
    if from_ is None:
        from_ = to - timedelta(days=30)

    q = (
        select(
            CloudCost.usage_date,
            CloudCost.provider,
            CloudCost.service,
            func.coalesce(func.sum(CloudCost.amount_krw), 0).label("amount_krw"),
        )
        .where(
            CloudCost.usage_date >= from_,
            CloudCost.usage_date <= to,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
        .group_by(CloudCost.usage_date, CloudCost.provider, CloudCost.service)
        .order_by(CloudCost.usage_date.asc())
    )
    if provider:
        q = q.where(CloudCost.provider == provider)
    rows = (await db.execute(q)).all()
    return [
        CloudCostSummaryRow(
            usage_date=r.usage_date,
            provider=r.provider,
            service=r.service,
            amount_krw=Decimal(str(r.amount_krw or 0)),
        )
        for r in rows
    ]


@router.get("/fetches", response_model=list[CloudCostFetchOut])
async def list_fetches(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    limit: int = Query(default=50, ge=1, le=500),
):
    rows = list(
        (await db.execute(
            select(CloudCostFetch)
            .order_by(CloudCostFetch.started_at.desc())
            .limit(limit)
        )).scalars()
    )
    return rows


# ---------------------------------------------------------------------------
# Manual fetch
# ---------------------------------------------------------------------------


@router.post("/fetch", response_model=FetchTriggerResponse)
async def trigger_fetch(
    body: FetchTriggerRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """수동 수집 — 인증된 사용자 누구나. providers 미지정 시 enabled 인 모든 provider."""
    cfg = await get_tenant_section(user.tenant_id, "cloud_cost")
    if not cfg.get("enabled"):
        raise HTTPException(
            status_code=400,
            detail="클라우드 비용 수집이 비활성 상태입니다. (설정 > 외부 연동 > 클라우드 비용)",
        )
    providers = get_providers(cfg)
    if not providers:
        raise HTTPException(
            status_code=400,
            detail="활성화된 provider 가 없습니다. AWS/Azure/GCP 중 최소 1개를 활성화하세요.",
        )

    selected = (
        [p for p in (body.providers or []) if p in providers]
        or list(providers.keys())
    )
    service_top_n = int(cfg.get("service_top_n", 20) or 20)
    today = date.today()
    end = today - timedelta(days=1)
    start = today - timedelta(days=body.since_days)

    # 각 provider 1회 range 호출로 since_days 일치 모두 fetch.
    records: list[CloudCostFetch] = []
    for prov_name in selected:
        provider = providers[prov_name]
        rec = await fetch_and_upsert_range(
            db,
            provider_name=prov_name,
            provider=provider,
            start=start,
            end=end,
            triggered_by=user.id,
            trigger_kind="MANUAL",
            service_top_n=service_top_n,
        )
        records.append(rec)

    return FetchTriggerResponse(results=[CloudCostFetchOut.model_validate(r) for r in records])


# ---------------------------------------------------------------------------
# Alerts (CRUD + events list + test fire)
# ---------------------------------------------------------------------------


@router.get("/alerts", response_model=list[AlertRuleOut])
async def list_alert_rules(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    rows = list(
        (await db.execute(
            select(CloudCostAlertRule).order_by(CloudCostAlertRule.created_at.desc())
        )).scalars()
    )
    return [AlertRuleOut.model_validate(r) for r in rows]


@router.post("/alerts", response_model=AlertRuleOut, status_code=201)
async def create_alert_rule(
    payload: AlertRuleCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_admin),
):
    row = CloudCostAlertRule(
        name=payload.name,
        enabled=payload.enabled,
        rule_type=payload.rule_type,
        provider=payload.provider,
        account_id=payload.account_id,
        threshold_krw=payload.threshold_krw,
        threshold_percent=payload.threshold_percent,
        notify_channels=payload.notify_channels,
        notify_user_emails=payload.notify_user_emails,
        notify_user_ids=payload.notify_user_ids,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("알람 규칙 생성: id=%s name=%s type=%s", row.id, row.name, row.rule_type)
    return AlertRuleOut.model_validate(row)


@router.patch("/alerts/{rule_id}", response_model=AlertRuleOut)
async def update_alert_rule(
    rule_id: UUID,
    payload: AlertRuleUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (await db.execute(
        select(CloudCostAlertRule).where(CloudCostAlertRule.id == rule_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="알람 규칙을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "알람 규칙 수정: id=%s 변경필드=%s (수정자=%s)",
        rule_id, list(data.keys()), user.id,
    )
    return AlertRuleOut.model_validate(row)


@router.delete("/alerts/{rule_id}", status_code=204)
async def delete_alert_rule(
    rule_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (await db.execute(
        select(CloudCostAlertRule).where(CloudCostAlertRule.id == rule_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="알람 규칙을 찾을 수 없습니다.")
    name = row.name
    await db.delete(row)
    await db.commit()
    logger.info("알람 규칙 삭제: id=%s name=%s (삭제자=%s)", rule_id, name, user.id)


@router.post("/alerts/{rule_id}/evaluate", response_model=AlertRuleOut)
async def evaluate_rule_now(
    rule_id: UUID,
    target: date | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """단일 규칙을 지금 평가 — 운영자 테스트용. target 미지정 시 어제 기준."""
    row = (await db.execute(
        select(CloudCostAlertRule).where(CloudCostAlertRule.id == rule_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="알람 규칙을 찾을 수 없습니다.")
    target_date = target or (date.today() - timedelta(days=1))
    logger.info(
        "알람 규칙 즉시 평가: id=%s name=%s target=%s (요청자=%s)",
        rule_id, row.name, target_date, user.id,
    )
    await evaluate_one_rule(db, row, target_date)
    await db.refresh(row)
    return AlertRuleOut.model_validate(row)


@router.get("/alert-events", response_model=list[AlertEventOut])
async def list_alert_events(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    limit: int = Query(default=100, ge=1, le=500),
    rule_id: UUID | None = None,
):
    q = select(CloudCostAlertEvent).order_by(CloudCostAlertEvent.fired_at.desc()).limit(limit)
    if rule_id:
        q = q.where(CloudCostAlertEvent.rule_id == rule_id)
    rows = list((await db.execute(q)).scalars())
    return [AlertEventOut.model_validate(r) for r in rows]
