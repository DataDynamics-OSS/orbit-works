"""클라우드 비용 알람 평가기.

일일 cloud cost 수집 끝난 뒤 evaluator 가 모든 enabled 규칙을 평가해 충족하면
notify_service.send_for_tenant 로 발송. 발송 이력은 cloud_cost_alert_events 에
`(rule_id, dedup_key) UNIQUE` 로 기록 — 같은 dedup_key 는 한 번만 보냄.

Rule types (frontend 와 동기화):
- DAILY_THRESHOLD       — target_date 의 (provider/account 필터된) 합계 > threshold_krw
- MONTHLY_FORECAST      — 이번 달 누적·일평균으로 추정한 월말 합계 > threshold_krw
- FETCH_FAILED          — target_date 에 cloud_cost_fetches.status='FAILED' 발생
- DAY_OVER_DAY_PERCENT  — target_date 합계 vs 그 전날 비교, 증가율 > threshold_percent
- NEW_SERVICE           — 7일 평균에 없던 service 가 target_date 에 새로 청구

dedup_key 예:
- "DAILY:2026-04-29"
- "MONTH:2026-04"
- "FETCH:<fetch_uuid>"
- "DOD:2026-04-29"
- "NEW:2026-04-29:AmazonEC2"
"""

from __future__ import annotations

import logging
from calendar import monthrange
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    CloudCost,
    CloudCostAlertEvent,
    CloudCostAlertRule,
    CloudCostFetch,
)

logger = logging.getLogger(__name__)


def _msg_prefix(rule: CloudCostAlertRule) -> str:
    """공급자·계정 prefix — 메시지 가독성용."""
    parts = []
    if rule.provider:
        parts.append(rule.provider)
    if rule.account_id:
        parts.append(rule.account_id)
    return f"[{' / '.join(parts)}] " if parts else ""


def _apply_filters(stmt, rule: CloudCostAlertRule):
    if rule.provider:
        stmt = stmt.where(CloudCost.provider == rule.provider)
    if rule.account_id:
        stmt = stmt.where(CloudCost.account_id == rule.account_id)
    return stmt


async def _already_fired(db: AsyncSession, rule_id: UUID, dedup_key: str) -> bool:
    row = (
        await db.execute(
            select(CloudCostAlertEvent.id).where(
                CloudCostAlertEvent.rule_id == rule_id,
                CloudCostAlertEvent.dedup_key == dedup_key,
            )
        )
    ).scalar_one_or_none()
    return row is not None


async def _fire(
    db: AsyncSession,
    rule: CloudCostAlertRule,
    dedup_key: str,
    message: str,
    payload: dict | None = None,
) -> None:
    """이벤트 row 생성 + notify 발송. 같은 dedup_key 는 UNIQUE 로 차단."""
    from app.services.notify import notify_service

    ev = CloudCostAlertEvent(
        rule_id=rule.id,
        dedup_key=dedup_key,
        fired_at=datetime.now(timezone.utc),
        message=message,
        payload=payload,
        delivered=False,
    )
    db.add(ev)
    rule.last_fired_at = ev.fired_at
    try:
        await db.flush()  # UNIQUE 제약 위반 시 여기서 IntegrityError → skip
    except Exception as exc:
        # 이미 같은 dedup_key 발송됨 — 정상 흐름.
        logger.debug("alert dedup hit rule=%s key=%s: %s", rule.id, dedup_key, exc)
        await db.rollback()
        return

    # 발송 (DB 커밋 후 — 발송 실패해도 이벤트는 남아 재시도 가능).
    # rule 에 notify override 가 있으면 그 값으로, 없으면 tenant default fallback.
    delivered = False
    error_message: str | None = None
    try:
        delivered = await notify_service.send_for_tenant(
            rule.tenant_id, f"[클라우드 비용 알람] {message}",
            channels=rule.notify_channels or None,
            user_emails=rule.notify_user_emails or None,
            user_ids=rule.notify_user_ids or None,
            feature="cloud_cost",
        )
    except Exception as exc:
        error_message = f"{type(exc).__name__}: {exc}"[:1000]
        logger.warning("알람 발송 예외 rule=%s: %s", rule.id, exc, exc_info=True)
    ev.delivered = delivered
    ev.error_message = error_message
    await db.commit()
    logger.info(
        "알람 발송: rule=%s key=%s delivered=%s",
        rule.name, dedup_key, delivered,
    )


# ---------------------------------------------------------------------------
# 개별 평가 함수
# ---------------------------------------------------------------------------


async def _eval_daily_threshold(
    db: AsyncSession, rule: CloudCostAlertRule, target_date: date
) -> None:
    if not rule.threshold_krw:
        return
    # service 가 NULL 또는 빈문자열인 합계 row 만 (account 별 일별 합계).
    stmt = select(func.coalesce(func.sum(CloudCost.amount_krw), 0)).where(
        CloudCost.usage_date == target_date,
        or_(CloudCost.service.is_(None), CloudCost.service == ""),
    )
    stmt = _apply_filters(stmt, rule)
    total = (await db.execute(stmt)).scalar_one() or Decimal(0)
    if total <= rule.threshold_krw:
        return
    dedup_key = f"DAILY:{target_date.isoformat()}"
    if await _already_fired(db, rule.id, dedup_key):
        return
    msg = (
        f"{_msg_prefix(rule)}{target_date} 비용 {int(total):,}원 — "
        f"일일 임계 {rule.threshold_krw:,}원 초과"
    )
    await _fire(db, rule, dedup_key, msg, {
        "date": target_date.isoformat(),
        "total_krw": str(total),
        "threshold_krw": rule.threshold_krw,
    })


async def _eval_monthly_forecast(
    db: AsyncSession, rule: CloudCostAlertRule, target_date: date
) -> None:
    if not rule.threshold_krw:
        return
    month_start = target_date.replace(day=1)
    days_in_month = monthrange(target_date.year, target_date.month)[1]
    days_elapsed = target_date.day  # target_date 까지 포함

    stmt = select(func.coalesce(func.sum(CloudCost.amount_krw), 0)).where(
        CloudCost.usage_date >= month_start,
        CloudCost.usage_date <= target_date,
        or_(CloudCost.service.is_(None), CloudCost.service == ""),
    )
    stmt = _apply_filters(stmt, rule)
    cumulative = (await db.execute(stmt)).scalar_one() or Decimal(0)
    if days_elapsed == 0:
        return
    daily_avg = cumulative / days_elapsed
    forecast = daily_avg * days_in_month
    if forecast <= rule.threshold_krw:
        return
    month_key = target_date.strftime("%Y-%m")
    dedup_key = f"MONTH:{month_key}"
    if await _already_fired(db, rule.id, dedup_key):
        return
    msg = (
        f"{_msg_prefix(rule)}{month_key} 누적 {int(cumulative):,}원 "
        f"(일평균 {int(daily_avg):,}원) → 월말 추정 {int(forecast):,}원 — "
        f"예산 {rule.threshold_krw:,}원 초과 예상"
    )
    await _fire(db, rule, dedup_key, msg, {
        "month": month_key,
        "cumulative_krw": str(cumulative),
        "forecast_krw": str(forecast),
        "threshold_krw": rule.threshold_krw,
        "days_elapsed": days_elapsed,
        "days_in_month": days_in_month,
    })


async def _eval_fetch_failed(
    db: AsyncSession, rule: CloudCostAlertRule, target_date: date
) -> None:
    """target_date 에 시작된 fetch 중 FAILED 가 있으면 알림."""
    stmt = select(CloudCostFetch).where(
        func.date(CloudCostFetch.started_at) == target_date,
        CloudCostFetch.status == "FAILED",
    )
    if rule.provider:
        stmt = stmt.where(CloudCostFetch.provider == rule.provider)
    rows = list((await db.execute(stmt)).scalars())
    for fetch in rows:
        dedup_key = f"FETCH:{fetch.id}"
        if await _already_fired(db, rule.id, dedup_key):
            continue
        period = (
            f"{fetch.period_start} ~ {fetch.period_end}"
            if fetch.period_start and fetch.period_end and fetch.period_start != fetch.period_end
            else (fetch.period_start.isoformat() if fetch.period_start else "?")
        )
        err = (fetch.error_message or "").splitlines()[0][:200] if fetch.error_message else ""
        msg = (
            f"[{fetch.provider}] 수집 실패 — {period}: {err}"
        )
        await _fire(db, rule, dedup_key, msg, {
            "fetch_id": str(fetch.id),
            "provider": fetch.provider,
            "period_start": fetch.period_start.isoformat() if fetch.period_start else None,
            "period_end": fetch.period_end.isoformat() if fetch.period_end else None,
            "error_message": fetch.error_message,
        })


async def _eval_day_over_day(
    db: AsyncSession, rule: CloudCostAlertRule, target_date: date
) -> None:
    if not rule.threshold_percent:
        return
    from datetime import timedelta as _td
    prev_date = target_date - _td(days=1)

    async def _sum_for(d: date) -> Decimal:
        stmt = select(func.coalesce(func.sum(CloudCost.amount_krw), 0)).where(
            CloudCost.usage_date == d,
            or_(CloudCost.service.is_(None), CloudCost.service == ""),
        )
        stmt = _apply_filters(stmt, rule)
        return (await db.execute(stmt)).scalar_one() or Decimal(0)

    today_sum = await _sum_for(target_date)
    prev_sum = await _sum_for(prev_date)
    if prev_sum <= 0:
        return  # 전날 0 이면 % 의미 없음 (NEW_SERVICE 가 잡음)
    delta_pct = (today_sum - prev_sum) / prev_sum * 100
    if delta_pct < rule.threshold_percent:
        return
    dedup_key = f"DOD:{target_date.isoformat()}"
    if await _already_fired(db, rule.id, dedup_key):
        return
    msg = (
        f"{_msg_prefix(rule)}{target_date} 비용 {int(today_sum):,}원 — "
        f"전일 {int(prev_sum):,}원 대비 +{delta_pct:.1f}% (임계 +{rule.threshold_percent}%)"
    )
    await _fire(db, rule, dedup_key, msg, {
        "date": target_date.isoformat(),
        "prev_date": prev_date.isoformat(),
        "today_krw": str(today_sum),
        "prev_krw": str(prev_sum),
        "delta_percent": str(delta_pct),
    })


async def _eval_new_service(
    db: AsyncSession, rule: CloudCostAlertRule, target_date: date
) -> None:
    """target_date 에 청구된 service 중, 7일 전~target_date-1 에는 청구 없던 게 있으면 알림."""
    from datetime import timedelta as _td

    today_stmt = (
        select(CloudCost.provider, CloudCost.service)
        .where(
            CloudCost.usage_date == target_date,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
        .distinct()
    )
    today_stmt = _apply_filters(today_stmt, rule)
    today_set = {(p, s) for p, s in (await db.execute(today_stmt)).all()}

    prev_stmt = (
        select(CloudCost.provider, CloudCost.service)
        .where(
            CloudCost.usage_date >= target_date - _td(days=7),
            CloudCost.usage_date < target_date,
            CloudCost.service.is_not(None),
            CloudCost.service != "",
        )
        .distinct()
    )
    prev_stmt = _apply_filters(prev_stmt, rule)
    prev_set = {(p, s) for p, s in (await db.execute(prev_stmt)).all()}

    new_pairs = today_set - prev_set
    if not new_pairs:
        return
    for provider, service in new_pairs:
        dedup_key = f"NEW:{target_date.isoformat()}:{provider}:{service}"
        if await _already_fired(db, rule.id, dedup_key):
            continue
        msg = (
            f"[{provider}] 신규 서비스 청구 — '{service}' 가 {target_date} 부터 비용 발생"
        )
        await _fire(db, rule, dedup_key, msg, {
            "date": target_date.isoformat(),
            "provider": provider,
            "service": service,
        })


# ---------------------------------------------------------------------------
# Public entry — 일일 cron 끝에서 호출
# ---------------------------------------------------------------------------


_DISPATCH = {
    "DAILY_THRESHOLD": _eval_daily_threshold,
    "MONTHLY_FORECAST": _eval_monthly_forecast,
    "FETCH_FAILED": _eval_fetch_failed,
    "DAY_OVER_DAY_PERCENT": _eval_day_over_day,
    "NEW_SERVICE": _eval_new_service,
}


async def evaluate_all_rules(
    db: AsyncSession,
    target_date: date,
) -> int:
    """현재 tenant scope 의 모든 enabled 규칙을 평가. fired 이벤트 수 반환."""
    rules = list(
        (await db.execute(
            select(CloudCostAlertRule).where(CloudCostAlertRule.enabled.is_(True))
        )).scalars()
    )
    fired_before = await _count_events_for_rules(db, [r.id for r in rules]) if rules else 0
    for rule in rules:
        evaluator = _DISPATCH.get(rule.rule_type)
        if evaluator is None:
            logger.warning("알 수 없는 알람 rule_type: %s (id=%s)", rule.rule_type, rule.id)
            continue
        try:
            await evaluator(db, rule, target_date)
        except Exception:
            logger.warning(
                "알람 평가 실패 rule=%s type=%s",
                rule.id, rule.rule_type, exc_info=True,
            )
    fired_after = await _count_events_for_rules(db, [r.id for r in rules]) if rules else 0
    return fired_after - fired_before


async def _count_events_for_rules(db: AsyncSession, rule_ids: list[UUID]) -> int:
    if not rule_ids:
        return 0
    return (await db.execute(
        select(func.count(CloudCostAlertEvent.id)).where(
            CloudCostAlertEvent.rule_id.in_(rule_ids)
        )
    )).scalar_one() or 0


# 단발 평가 — 운영자 "테스트 평가" UI 에서 호출.
async def evaluate_one_rule(
    db: AsyncSession, rule: CloudCostAlertRule, target_date: date,
) -> None:
    evaluator = _DISPATCH.get(rule.rule_type)
    if evaluator is None:
        raise ValueError(f"알 수 없는 rule_type: {rule.rule_type}")
    await evaluator(db, rule, target_date)
