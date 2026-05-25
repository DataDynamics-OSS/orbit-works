"""클라우드 비용 도구 — summary / forecast / alerts.

설계 원칙:
1. NL2SQL 금지. 모델은 미리 정의된 합의 함수(이 파일) 만 호출 가능.
2. 모델 prompt 로 돌아가는 결과 JSON 은 *작게*. 일별 raw row 가 아니라 사람이
   바로 답할 수 있는 요약 통계(MTD 합계, 예상 월말, top services, …).
3. KRW 환산은 cloud_costs.amount_krw 캐시를 그대로 신뢰. 환율 누락 row 는 0 처리.
4. 모든 쿼리는 호출자 user 의 tenant_id 로 자동 필터 (RLS 가 강제하지만 명시).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import and_, func, select

from app.models import (
    CloudCost,
    CloudCostAlertEvent,
    CloudCostAlertRule,
    CloudCostFetch,
)
from app.services.assistant.registry import registry
from app.services.assistant.types import Tool, ToolContext


def _to_int(v) -> int:
    if v is None:
        return 0
    if isinstance(v, Decimal):
        return int(v)
    return int(v)


def _month_bounds(today: date) -> tuple[date, date]:
    """해당 월의 (1일, 말일) 반환."""
    first = today.replace(day=1)
    if first.month == 12:
        next_first = first.replace(year=first.year + 1, month=1)
    else:
        next_first = first.replace(month=first.month + 1)
    last = next_first - timedelta(days=1)
    return first, last


def _parse_provider(p: str | None) -> str | None:
    if not p:
        return None
    p = p.strip().upper()
    if p in {"AWS", "AZURE", "GCP"}:
        return p
    return None


# ---------------------------------------------------------------------------
# tool: get_cloud_cost_summary
# ---------------------------------------------------------------------------


async def _get_cloud_cost_summary(args: dict, ctx: ToolContext) -> dict:
    today = date.today()
    period = (args.get("period") or "this_month").lower()
    provider = _parse_provider(args.get("provider"))

    if period == "this_month":
        start, _ = _month_bounds(today)
        end = today
    elif period == "last_month":
        first_this, _ = _month_bounds(today)
        end = first_this - timedelta(days=1)
        start, _ = _month_bounds(end)
    elif period == "last_7_days":
        end = today
        start = today - timedelta(days=7)
    elif period == "last_30_days":
        end = today
        start = today - timedelta(days=30)
    else:
        return {"error": f"unknown period: {period}"}

    # 합계.
    total_q = (
        select(func.coalesce(func.sum(CloudCost.amount_krw), 0))
        .where(
            CloudCost.usage_date >= start,
            CloudCost.usage_date <= end,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
    )
    if provider:
        total_q = total_q.where(CloudCost.provider == provider)
    total_krw = _to_int((await ctx.db.execute(total_q)).scalar())

    # provider 별.
    by_prov_q = (
        select(
            CloudCost.provider,
            func.coalesce(func.sum(CloudCost.amount_krw), 0).label("amt"),
        )
        .where(
            CloudCost.usage_date >= start,
            CloudCost.usage_date <= end,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
        .group_by(CloudCost.provider)
    )
    if provider:
        by_prov_q = by_prov_q.where(CloudCost.provider == provider)
    by_provider = {
        r.provider: _to_int(r.amt)
        for r in (await ctx.db.execute(by_prov_q)).all()
    }

    # 일별 시계열 — UI sparkline 용. 모델 prompt 에도 포함되지만 N=30 정도라 토큰 영향 미미.
    daily_q = (
        select(
            CloudCost.usage_date,
            func.coalesce(func.sum(CloudCost.amount_krw), 0).label("amt"),
        )
        .where(
            CloudCost.usage_date >= start,
            CloudCost.usage_date <= end,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
        .group_by(CloudCost.usage_date)
        .order_by(CloudCost.usage_date.asc())
    )
    if provider:
        daily_q = daily_q.where(CloudCost.provider == provider)
    daily_series = [
        {"usage_date": r.usage_date.isoformat(), "amount_krw": _to_int(r.amt)}
        for r in (await ctx.db.execute(daily_q)).all()
    ]

    # top services.
    top_n = int(args.get("top_services") or 5)
    top_q = (
        select(
            CloudCost.provider,
            CloudCost.service,
            func.coalesce(func.sum(CloudCost.amount_krw), 0).label("amt"),
        )
        .where(
            CloudCost.usage_date >= start,
            CloudCost.usage_date <= end,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
        .group_by(CloudCost.provider, CloudCost.service)
        .order_by(func.sum(CloudCost.amount_krw).desc())
        .limit(top_n)
    )
    if provider:
        top_q = top_q.where(CloudCost.provider == provider)
    top_services = [
        {
            "provider": r.provider,
            "service": r.service,
            "amount_krw": _to_int(r.amt),
        }
        for r in (await ctx.db.execute(top_q)).all()
    ]

    return {
        "period": period,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "provider_filter": provider,
        "total_krw": total_krw,
        "by_provider": by_provider,
        "top_services": top_services,
        "daily_series": daily_series,
        "currency": "KRW",
    }


registry.register(Tool(
    name="get_cloud_cost_summary",
    description=(
        "지정된 기간의 클라우드(AWS/Azure/GCP) 사용 비용 합계를 KRW 기준으로 반환. "
        "비용 분석·요약·청구 관련 질문에 사용. 'period' 는 this_month / last_month / "
        "last_7_days / last_30_days 중 하나. provider 미지정 시 전체."
    ),
    parameters={
        "type": "object",
        "properties": {
            "period": {
                "type": "string",
                "enum": ["this_month", "last_month", "last_7_days", "last_30_days"],
                "description": "조회 기간. 기본값 this_month.",
            },
            "provider": {
                "type": "string",
                "enum": ["AWS", "AZURE", "GCP"],
                "description": "특정 provider 만 조회. 미지정 시 전체 합산.",
            },
            "top_services": {
                "type": "integer",
                "description": "비용 상위 N개 service 를 함께 반환 (기본 5).",
            },
        },
    },
    handler=_get_cloud_cost_summary,
))


# ---------------------------------------------------------------------------
# tool: forecast_monthly_cost
# ---------------------------------------------------------------------------


async def _forecast_monthly_cost(args: dict, ctx: ToolContext) -> dict:
    """이번 달 (또는 지정된 달) 의 월말 예상 비용.

    방식: MTD 실적 / 경과일수 × 월 일수 (단순 프로레이션). 기본은 7일 이동평균
    기반(`method=trailing7`) — 최근 7일 일평균을 남은 일수에 곱해 더한다.
    `method=prorate` 로 단순 프로레이션 선택 가능.
    """
    today = date.today()
    method = (args.get("method") or "trailing7").lower()
    provider = _parse_provider(args.get("provider"))
    target_str = args.get("month")  # "YYYY-MM" 또는 None
    if target_str:
        try:
            y, m = target_str.split("-")
            ref = date(int(y), int(m), 1)
        except Exception:
            return {"error": f"invalid month: {target_str} (expected YYYY-MM)"}
    else:
        ref = today
    first, last = _month_bounds(ref)
    days_in_month = (last - first).days + 1

    # 측정 종료일 = min(오늘, 월말) — 아직 지나지 않은 달의 미래 일자는 0.
    if today < first:
        return {
            "error": f"{first.isoformat()} 는 미래 — 예측 불가",
        }
    measured_end = min(today, last)
    elapsed_days = (measured_end - first).days + 1
    remaining_days = max(days_in_month - elapsed_days, 0)

    # MTD 합계.
    base_q = (
        select(func.coalesce(func.sum(CloudCost.amount_krw), 0))
        .where(
            CloudCost.usage_date >= first,
            CloudCost.usage_date <= measured_end,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
    )
    if provider:
        base_q = base_q.where(CloudCost.provider == provider)
    mtd_krw = _to_int((await ctx.db.execute(base_q)).scalar())

    if method == "prorate":
        if elapsed_days <= 0:
            forecast = 0
        else:
            forecast = int(mtd_krw * days_in_month / elapsed_days)
        method_used = "prorate (MTD × 월일수 / 경과일수)"
    else:
        # trailing 7-day 평균. 측정 종료일이 매우 이른 달이면 자동으로 prorate fallback.
        window_start = max(measured_end - timedelta(days=6), first)
        win_q = (
            select(func.coalesce(func.sum(CloudCost.amount_krw), 0))
            .where(
                CloudCost.usage_date >= window_start,
                CloudCost.usage_date <= measured_end,
                CloudCost.service.is_not(None),
                CloudCost.service != "",
            )
        )
        if provider:
            win_q = win_q.where(CloudCost.provider == provider)
        win_krw = _to_int((await ctx.db.execute(win_q)).scalar())
        win_days = (measured_end - window_start).days + 1
        if win_days <= 0:
            forecast = mtd_krw
            method_used = "fallback (실적 없음)"
        else:
            daily_avg = win_krw / win_days
            forecast = int(mtd_krw + daily_avg * remaining_days)
            method_used = f"trailing-{win_days}-day avg × 잔여일수 + MTD"

    return {
        "month": f"{first.year:04d}-{first.month:02d}",
        "days_in_month": days_in_month,
        "elapsed_days": elapsed_days,
        "remaining_days": remaining_days,
        "provider_filter": provider,
        "mtd_krw": mtd_krw,
        "forecast_total_krw": forecast,
        "method": method_used,
        "currency": "KRW",
        "as_of": measured_end.isoformat(),
    }


registry.register(Tool(
    name="forecast_monthly_cost",
    description=(
        "이번 달(또는 지정된 달) 클라우드 비용의 월말 예상 합계를 KRW 로 추정. "
        "'예상 비용', '월말까지 얼마', '예측' 등의 질문에 사용. "
        "기본 method=trailing7 (최근 7일 일평균 × 잔여일수 + MTD), method=prorate 는 단순 비례."
    ),
    parameters={
        "type": "object",
        "properties": {
            "month": {
                "type": "string",
                "description": "대상 월 YYYY-MM. 미지정 시 이번 달.",
            },
            "provider": {
                "type": "string",
                "enum": ["AWS", "AZURE", "GCP"],
                "description": "특정 provider 만 예측. 미지정 시 전체 합산.",
            },
            "method": {
                "type": "string",
                "enum": ["trailing7", "prorate"],
                "description": "예측 방식. 기본 trailing7.",
            },
        },
    },
    handler=_forecast_monthly_cost,
))


# ---------------------------------------------------------------------------
# tool: list_recent_cost_alerts
# ---------------------------------------------------------------------------


async def _list_recent_cost_alerts(args: dict, ctx: ToolContext) -> dict:
    days = int(args.get("days") or 30)
    limit = max(min(int(args.get("limit") or 20), 100), 1)
    since = date.today() - timedelta(days=days)

    q = (
        select(CloudCostAlertEvent, CloudCostAlertRule.name, CloudCostAlertRule.rule_type)
        .join(CloudCostAlertRule, CloudCostAlertRule.id == CloudCostAlertEvent.rule_id)
        .where(CloudCostAlertEvent.fired_at >= since)
        .order_by(CloudCostAlertEvent.fired_at.desc())
        .limit(limit)
    )
    rows = (await ctx.db.execute(q)).all()
    events = [
        {
            "fired_at": ev.fired_at.isoformat(),
            "rule_name": rule_name,
            "rule_type": rule_type,
            "message": ev.message,
            "delivered": ev.delivered,
        }
        for (ev, rule_name, rule_type) in rows
    ]
    return {
        "since": since.isoformat(),
        "count": len(events),
        "events": events,
    }


registry.register(Tool(
    name="list_recent_cost_alerts",
    description=(
        "최근 N일 (기본 30일) 발화된 클라우드 비용 알림 이벤트를 조회. "
        "임계 초과·이상치 등 알림 상태를 묻는 질문에 사용."
    ),
    parameters={
        "type": "object",
        "properties": {
            "days":  {"type": "integer", "description": "조회 일수 (기본 30)."},
            "limit": {"type": "integer", "description": "최대 반환 개수 (기본 20, 최대 100)."},
        },
    },
    handler=_list_recent_cost_alerts,
))


# ---------------------------------------------------------------------------
# tool: get_last_fetch_status
# ---------------------------------------------------------------------------


async def _get_last_fetch_status(args: dict, ctx: ToolContext) -> dict:
    """provider 별 가장 최근 수집 이력 — 데이터 신선도 확인용."""
    q = (
        select(
            CloudCostFetch.provider,
            CloudCostFetch.status,
            CloudCostFetch.period_start,
            CloudCostFetch.period_end,
            CloudCostFetch.fetched_count,
            CloudCostFetch.error_message,
            CloudCostFetch.started_at,
            CloudCostFetch.finished_at,
        )
        .order_by(CloudCostFetch.started_at.desc())
        .limit(20)
    )
    rows = (await ctx.db.execute(q)).all()
    seen: dict[str, dict] = {}
    for r in rows:
        if r.provider in seen:
            continue
        seen[r.provider] = {
            "provider": r.provider,
            "status": r.status,
            "period_start": r.period_start.isoformat() if r.period_start else None,
            "period_end": r.period_end.isoformat() if r.period_end else None,
            "fetched_count": r.fetched_count,
            "error": r.error_message,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        }
    return {"providers": list(seen.values())}


registry.register(Tool(
    name="get_last_fetch_status",
    description=(
        "AWS/Azure/GCP 각각의 가장 최근 비용 수집 작업 상태(SUCCESS/FAILED/SKIPPED)와 "
        "수집된 행 수를 반환. '데이터가 최신인지', '수집이 실패했는지' 류 질문에 사용."
    ),
    parameters={"type": "object", "properties": {}},
    handler=_get_last_fetch_status,
))
