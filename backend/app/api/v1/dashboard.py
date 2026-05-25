"""Dashboard summary endpoint.

Aggregates KPI / trend / funnel / action lists in a single round-trip so the
dashboard page doesn't fan-out to many endpoints on initial load.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import PayrollConfig, get_tenant_section
from app.core.database import get_db
from app.services.payday import compute_next_payday
from app.models import (
    Assignment,
    Customer,
    Developer,
    ExchangeRate,
    License,
    Opportunity,
    Project,
    Quote,
    TaxInvoice,
    User,
)
from app.api.v1.projects import _compute_monthly_cost_matrix, _latest_usd_krw_rate
from app.models import InterestRate, StockPrice
from app.services.exchange import ensure_fx_window
from app.services.interest import SERIES as INTEREST_SERIES, ensure_interest_window
from app.services.stock import SERIES as STOCK_SERIES, ensure_stock_window

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


async def _latest_fx_rate(db: AsyncSession) -> Decimal | None:
    row = (
        await db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.base == "USD", ExchangeRate.target == "KRW")
            .order_by(ExchangeRate.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return row.rate if row else None


def _to_krw(amount: Decimal, currency: str, fx: Decimal | None) -> Decimal:
    if currency == "KRW":
        return amount
    if currency == "USD" and fx and fx > 0:
        return (amount * fx).quantize(Decimal("0.01"))
    return amount


@router.get("/summary")
async def dashboard_summary(
    year: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    today = date.today()
    in_14 = today + timedelta(days=14)
    in_30 = today + timedelta(days=30)
    fx = await _latest_fx_rate(db)

    # 현재 연도일 때만 "이번 달"이 의미가 있다. 과거/미래 연도는 12월 또는 1월로.
    current_month = today.month if today.year == year else 12
    target_ym = f"{year:04d}-{current_month:02d}"

    # -------------------------------------------------------------------
    # Opportunities (pipeline + funnel + won)
    # -------------------------------------------------------------------
    opps = list(
        (
            await db.execute(
                select(Opportunity).where(
                    extract("year", Opportunity.expected_close_date) == year
                )
            )
        ).scalars()
    )

    zero = Decimal("0")
    won_amount = zero
    won_amount_krw_native = zero
    won_amount_usd_native = zero
    open_amount = zero
    weighted_open = zero
    funnel: dict[str, dict[str, object]] = {
        s: {"count": 0, "amount": zero, "weighted": zero}
        for s in ("LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION")
    }
    urgent: list[dict] = []

    customer_ids = {o.customer_id for o in opps if o.customer_id}
    customer_names: dict[UUID, str] = {}
    if customer_ids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(customer_ids)))
        ).scalars():
            customer_names[c.id] = c.name

    for o in opps:
        native = Decimal(o.expected_amount or 0)
        krw = _to_krw(native, o.currency, fx)
        if o.status == "WON":
            won_amount += krw
            if o.currency == "USD":
                won_amount_usd_native += native
            else:
                won_amount_krw_native += native
        elif o.status == "OPEN":
            open_amount += krw
            w = (krw * Decimal(o.probability or 0) / Decimal(100)).quantize(
                Decimal("0.01")
            )
            weighted_open += w
            if o.stage in funnel:
                b = funnel[o.stage]
                b["count"] = int(b["count"]) + 1  # type: ignore[operator]
                b["amount"] = Decimal(b["amount"]) + krw  # type: ignore[operator]
                b["weighted"] = Decimal(b["weighted"]) + w  # type: ignore[operator]
            # D-14 urgent
            if o.expected_close_date and today <= o.expected_close_date <= in_14:
                urgent.append(
                    {
                        "id": str(o.id),
                        "name": o.name,
                        "customer_name": customer_names.get(o.customer_id),
                        "expected_close_date": o.expected_close_date.isoformat(),
                        "days_left": (o.expected_close_date - today).days,
                        "stage": o.stage,
                        "amount": str(native.quantize(Decimal("0.01"))),
                        "currency": o.currency,
                    }
                )

    urgent.sort(key=lambda r: r["days_left"])

    # -------------------------------------------------------------------
    # Licenses — expiring within 30 days
    # -------------------------------------------------------------------
    lic_customer_ids: set[UUID] = set()
    licenses = list((await db.execute(select(License))).scalars())
    for l in licenses:
        if l.customer_id:
            lic_customer_ids.add(l.customer_id)
    missing_cids = lic_customer_ids - set(customer_names.keys())
    if missing_cids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(missing_cids)))
        ).scalars():
            customer_names[c.id] = c.name

    expiring: list[dict] = []
    for l in licenses:
        if l.end_date and today <= l.end_date <= in_30:
            expiring.append(
                {
                    "id": str(l.id),
                    "product_name": l.product_name,
                    "customer_name": customer_names.get(l.customer_id),
                    "end_date": l.end_date.isoformat(),
                    "days_left": (l.end_date - today).days,
                    "amount_krw": str(l.amount_krw) if l.amount_krw else None,
                }
            )
    expiring.sort(key=lambda r: r["days_left"])

    # -------------------------------------------------------------------
    # Projects — per-month cost/revenue matrix aggregated across projects
    # -------------------------------------------------------------------
    projects = list((await db.execute(select(Project))).scalars())
    monthly_trend_cost = [zero] * 12
    monthly_trend_revenue = [zero] * 12
    current_month_cost = zero
    current_month_revenue = zero
    loss_projects: list[dict] = []

    # 프로젝트별 매입원가 — PURCHASE 세금계산서 supply_amount 합. 적자 판정 시
    # cost-summary 와 동일하게 인적원가에 더해진다.
    procurement_rows = (
        await db.execute(
            select(
                TaxInvoice.linked_project_id,
                func.coalesce(func.sum(TaxInvoice.supply_amount), 0),
            )
            .where(
                TaxInvoice.kind == "PURCHASE",
                TaxInvoice.linked_project_id.is_not(None),
            )
            .group_by(TaxInvoice.linked_project_id)
        )
    ).all()
    procurement_by_project: dict[UUID, Decimal] = {
        pid: Decimal(amt or 0) for pid, amt in procurement_rows
    }
    usd_krw_rate: Decimal | None = None  # lazy — USD 계약 만나면 조회

    for proj in projects:
        try:
            matrix = await _compute_monthly_cost_matrix(db, proj)
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning(
                "대시보드: 프로젝트 비용 집계 실패 id=%s err=%s", proj.id, exc
            )
            continue

        # Walk matrix months that fall in the selected year.
        for i, ym in enumerate(matrix.months):
            try:
                y, m = ym.split("-")
                if int(y) != year:
                    continue
                idx = int(m) - 1
                monthly_trend_cost[idx] += Decimal(matrix.monthly_totals[i])
                if matrix.monthly_revenues:
                    monthly_trend_revenue[idx] += Decimal(
                        matrix.monthly_revenues[i]
                    )
                if ym == target_ym:
                    cost_m = Decimal(matrix.monthly_totals[i])
                    rev_m = (
                        Decimal(matrix.monthly_revenues[i])
                        if matrix.monthly_revenues
                        else zero
                    )
                    current_month_cost += cost_m
                    current_month_revenue += rev_m
            except (ValueError, IndexError):
                continue

        # 적자 판정 — 프로젝트 페이지 cost-summary 와 동일 공식:
        #   margin = contract_krw − (인적원가 + 매입원가)
        # estimate-line 매핑이 없는 프로젝트(grand_revenue=0) 가 적자로 잘못
        # 잡히는 문제 회피. USD 계약은 최신 USD/KRW 로 환산.
        personnel_cost = Decimal(matrix.grand_total)
        procurement_cost = procurement_by_project.get(proj.id, zero)
        total_cost = personnel_cost + procurement_cost
        contract = proj.total_contract_amount or zero
        if (proj.contract_currency or "KRW") == "USD":
            if usd_krw_rate is None:
                usd_krw_rate = await _latest_usd_krw_rate(db)
            contract_krw = (
                (contract * usd_krw_rate).quantize(Decimal("0.01"))
                if usd_krw_rate
                else contract
            )
        else:
            contract_krw = contract
        margin = (contract_krw - total_cost).quantize(Decimal("0.01"))
        if margin < zero:
            loss_projects.append(
                {
                    "id": str(proj.id),
                    "name": proj.name,
                    "cost": str(total_cost.quantize(Decimal("0.01"))),
                    "revenue": str(contract_krw.quantize(Decimal("0.01"))),
                    "profit": str(margin),
                }
            )

    loss_projects.sort(key=lambda r: Decimal(r["profit"]))

    # -------------------------------------------------------------------
    # USD/KRW 최근 2개월 일별 추이 (rolling, 선택된 연도와 독립).
    # DB에 기록이 적으면 frankfurter.app 에서 히스토리 백필.
    # -------------------------------------------------------------------
    fx_window_start = today - timedelta(days=60)
    await ensure_fx_window(db, fx_window_start, today)
    fx_rows = list(
        (
            await db.execute(
                select(ExchangeRate)
                .where(
                    ExchangeRate.base == "USD",
                    ExchangeRate.target == "KRW",
                    ExchangeRate.date >= fx_window_start,
                    ExchangeRate.date <= today,
                )
                .order_by(ExchangeRate.date.asc())
            )
        ).scalars()
    )
    fx_points = [
        {
            "date": r.date.isoformat(),
            "rate": str(r.rate.quantize(Decimal("0.01"))),
        }
        for r in fx_rows
    ]

    # -------------------------------------------------------------------
    # 국내 금리 (ECOS) 최근 2개월 — FX 와 같은 윈도우를 공유.
    # DB 에 기록이 적으면 ECOS 에서 히스토리 백필 (API 키 없으면 no-op).
    # -------------------------------------------------------------------
    await ensure_interest_window(db, fx_window_start, today)
    ir_rows = list(
        (
            await db.execute(
                select(InterestRate)
                .where(
                    InterestRate.date >= fx_window_start,
                    InterestRate.date <= today,
                )
                .order_by(InterestRate.date.asc())
            )
        ).scalars()
    )
    # Group by series_code → points.
    by_code: dict[str, list[dict]] = {}
    for r in ir_rows:
        by_code.setdefault(r.series_code, []).append(
            {"date": r.date.isoformat(), "rate": str(r.rate.quantize(Decimal("0.001")))}
        )
    interest_series_out = [
        {
            "code": s.code,
            "label": s.label,
            "color": s.color,
            "points": by_code.get(s.code, []),
        }
        for s in INTEREST_SERIES
    ]

    # -------------------------------------------------------------------
    # 주가지수 (한국 = ECOS, 미국 = FRED) 같은 윈도우에서 수집.
    # -------------------------------------------------------------------
    await ensure_stock_window(db, fx_window_start, today)
    stock_rows = list(
        (
            await db.execute(
                select(StockPrice)
                .where(
                    StockPrice.date >= fx_window_start,
                    StockPrice.date <= today,
                )
                .order_by(StockPrice.date.asc())
            )
        ).scalars()
    )
    stock_by_code: dict[str, list[dict]] = {}
    for r in stock_rows:
        stock_by_code.setdefault(r.series_code, []).append(
            {"date": r.date.isoformat(), "close": str(r.close.quantize(Decimal("0.01")))}
        )
    kr_series_out = [
        {"code": s.code, "label": s.label, "color": s.color, "points": stock_by_code.get(s.code, [])}
        for region, s in STOCK_SERIES
        if region == "KR"
    ]
    us_series_out = [
        {"code": s.code, "label": s.label, "color": s.color, "points": stock_by_code.get(s.code, [])}
        for region, s in STOCK_SERIES
        if region == "US"
    ]

    # -------------------------------------------------------------------
    # WON / LOST 월별 트렌드 — opportunities.closed_at 기준 (실제 수주/실주 발생월).
    # 누적 수주금액도 이 값을 기준으로 집계되므로 영업기회 건수 집계(registered_at)
    # 와는 기준이 다르다.
    # -------------------------------------------------------------------
    monthly_won = [zero] * 12
    monthly_lost = [zero] * 12
    closed_rows = list(
        (
            await db.execute(
                select(Opportunity).where(
                    Opportunity.status.in_(("WON", "LOST"))
                )
            )
        ).scalars()
    )
    for o in closed_rows:
        if not o.closed_at or o.closed_at.year != year:
            continue
        native = Decimal(o.expected_amount or 0)
        krw = _to_krw(native, o.currency, fx)
        idx = o.closed_at.month - 1
        if o.status == "WON":
            monthly_won[idx] += krw
        else:
            monthly_lost[idx] += krw

    # -------------------------------------------------------------------
    # 월별 영업기회 건수 — registered_at (사용자 지정) 우선, 없으면 created_at 로 폴백.
    # -------------------------------------------------------------------
    monthly_opportunities = [0] * 12
    all_opps = list((await db.execute(select(Opportunity))).scalars())
    for o in all_opps:
        ref = o.registered_at or (o.created_at.date() if o.created_at else None)
        if not ref or ref.year != year:
            continue
        monthly_opportunities[ref.month - 1] += 1

    # -------------------------------------------------------------------
    # 월별 견적서 발행 건수 — issue_date 기준.
    # -------------------------------------------------------------------
    monthly_quotes = [0] * 12
    quote_rows = list(
        (
            await db.execute(
                select(Quote).where(extract("year", Quote.issue_date) == year)
            )
        ).scalars()
    )
    for q in quote_rows:
        monthly_quotes[q.issue_date.month - 1] += 1

    # -------------------------------------------------------------------
    # Idle employees — ACTIVE, not resigned, no assignment covering
    # the current/target month.
    # -------------------------------------------------------------------
    month_start = date(year, current_month, 1)
    from calendar import monthrange as _mr

    month_end = date(year, current_month, _mr(year, current_month)[1])

    # 유휴 인력 — 정규직/프리랜서/자사화 모두 포함. UI 가 employment_type 별로
    # 그룹 표시 (정규직 / 프리랜서 / 자사화) 하므로 백엔드는 평면 list 로 반환.
    active_devs = list(
        (
            await db.execute(
                select(Developer).where(Developer.status == "ACTIVE")
            )
        ).scalars()
    )
    assigned_in_month = set(
        (
            await db.execute(
                select(Assignment.developer_id).where(
                    Assignment.start_date <= month_end,
                    Assignment.end_date >= month_start,
                )
            )
        ).scalars()
    )
    idle: list[dict] = []
    for d in active_devs:
        if d.resigned_date and d.resigned_date <= today:
            continue
        if d.id in assigned_in_month:
            continue
        idle.append(
            {
                "id": str(d.id),
                "name": d.name,
                "tag": d.tag,  # 동명이인 구분 뱃지 (A/B/C...), 유일하면 None
                "employment_type": d.employment_type,
                "title": d.title,
                "phone": d.phone,
                # 회사 이메일 우선, 없으면 개인 이메일. 둘 다 없으면 None.
                "email": d.company_email or d.personal_email,
            }
        )
    idle.sort(key=lambda r: r["name"])

    # -------------------------------------------------------------------
    # KPI deltas — won for previous year (same cutoff)
    # -------------------------------------------------------------------
    prev_won = zero
    prev_year_opps = list(
        (
            await db.execute(
                select(Opportunity).where(
                    Opportunity.status == "WON",
                )
            )
        ).scalars()
    )
    # closed_at-based to measure business achieved in the year.
    for o in prev_year_opps:
        if not o.closed_at or o.closed_at.year != year - 1:
            continue
        prev_won += _to_krw(
            Decimal(o.expected_amount or 0), o.currency, fx
        )

    def _q(v: Decimal) -> str:
        return str(v.quantize(Decimal("0.01")))

    return {
        "year": year,
        "as_of": today.isoformat(),
        "current_month": current_month,
        "fx_rate": str(fx) if fx else None,
        # KPI
        "kpi": {
            "won_amount": _q(won_amount),
            "won_amount_krw_native": _q(won_amount_krw_native),
            "won_amount_usd_native": _q(won_amount_usd_native),
            "won_amount_prev_year": _q(prev_won),
            "open_pipeline": _q(open_amount),
            "weighted_pipeline": _q(weighted_open),
            "current_month_cost": _q(current_month_cost),
            "current_month_revenue": _q(current_month_revenue),
            "current_month_margin": _q(current_month_revenue - current_month_cost),
            "expiring_licenses_30d_count": len(expiring),
        },
        # Monthly trend (year, 12 data points each)
        "monthly_trend": {
            "won": [_q(v) for v in monthly_won],
            "lost": [_q(v) for v in monthly_lost],
            "cost": [_q(v) for v in monthly_trend_cost],
            "revenue": [_q(v) for v in monthly_trend_revenue],
            "margin": [
                _q(monthly_trend_revenue[i] - monthly_trend_cost[i])
                for i in range(12)
            ],
            # 영업기회 발생 건수 (created_at 기준) / 견적서 발행 건수 (issue_date 기준).
            "opportunities_count": monthly_opportunities,
            "quotes_count": monthly_quotes,
        },
        # FX trend is daily, last ~60 days (independent of the selected year).
        "fx_trend": {
            "window_start": fx_window_start.isoformat(),
            "window_end": today.isoformat(),
            "points": fx_points,
        },
        # 국내 금리 시계열 (같은 60일 윈도우, 시리즈별 분리).
        "interest_trend": {
            "window_start": fx_window_start.isoformat(),
            "window_end": today.isoformat(),
            "series": interest_series_out,
        },
        # 주가지수 — 한·미 분리 (다른 스케일). 각각 시리즈별 일별 종가.
        "stock_trend_kr": {
            "window_start": fx_window_start.isoformat(),
            "window_end": today.isoformat(),
            "series": kr_series_out,
        },
        "stock_trend_us": {
            "window_start": fx_window_start.isoformat(),
            "window_end": today.isoformat(),
            "series": us_series_out,
        },
        # Funnel
        "funnel": [
            {
                "stage": s,
                "count": int(funnel[s]["count"]),  # type: ignore[arg-type]
                "amount": _q(Decimal(funnel[s]["amount"])),  # type: ignore[arg-type]
                "weighted": _q(Decimal(funnel[s]["weighted"])),  # type: ignore[arg-type]
            }
            for s in ("LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION")
        ],
        # Lists
        "urgent_opportunities": urgent[:20],
        "expiring_licenses": expiring[:20],
        "loss_projects": loss_projects[:20],
        "idle_employees": idle[:30],
    }



@router.get("/next-payday")
async def next_payday_endpoint(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """다음 급여일 — `app_settings.payroll` 설정 + 휴일 보정.

    응답:
      scheduled_date  설정한 N일 (예: 2026-05-22) — 보정 전 raw.
      actual_date     휴일 보정 후 실제 지급일 (예: 토요일 → 금요일).
      days_until      오늘 기준 D-카운트 (오늘이면 0).
      is_today        bool.
      rolled_back     보정 발생 여부 (UI 안내용).
      label           subtitle ("매월 22일") — UI 가 그대로 표시.
    """
    # tenant 별 payroll 설정 조회 (미설정이면 기본값).
    raw = await get_tenant_section(user.tenant_id, "payroll")
    try:
        cfg = PayrollConfig.model_validate(raw)
    except Exception as exc:  # pragma: no cover — validation 실패 시 default.
        logger.warning(
            "payroll config 파싱 실패 — 기본값으로: %s", exc,
        )
        cfg = PayrollConfig()

    today = date.today()
    result = await compute_next_payday(db, today=today, settings=cfg)
    return {
        "scheduled_date": result.scheduled_date.isoformat(),
        "actual_date": result.actual_date.isoformat(),
        "days_until": result.days_until,
        "is_today": result.is_today,
        "rolled_back": result.rolled_back,
        "label": f"매월 {cfg.payday_of_month}일",
    }
