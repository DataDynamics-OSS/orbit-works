import logging
from datetime import date, datetime, timezone
from decimal import Decimal

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.config import get_settings
from app.models import ExchangeRate

logger = logging.getLogger(__name__)
settings = get_settings()


async def fetch_and_cache_rate(db: AsyncSession, base: str = "USD", target: str = "KRW") -> Decimal:
    async with httpx.AsyncClient(
        timeout=10,
        follow_redirects=True,
        headers={"User-Agent": "orbit-fx/1.0"},
    ) as client:
        r = await client.get(settings.exchange.api_url)
        r.raise_for_status()
        data = r.json()
    rate = Decimal(str(data["rates"][target]))

    today = date.today()
    stmt = (
        pg_insert(ExchangeRate)
        .values(date=today, base=base, target=target, rate=rate)
        .on_conflict_do_update(
            index_elements=["date", "base", "target"],
            set_={"rate": rate, "updated_at": datetime.now(timezone.utc)},
        )
    )
    await db.execute(stmt)
    await db.commit()
    return rate


async def backfill_fx_history(
    db: AsyncSession,
    start: date,
    end: date,
    base: str = "USD",
    target: str = "KRW",
) -> int:
    """Fetch historical USD/KRW rates from frankfurter.app (ECB data, free,
    no API key) and upsert them into ``exchange_rates``. Returns the number
    of rows inserted/updated.

    Frankfurter only serves ECB working-day rates (no weekends/holidays), so
    gaps are expected. Missing days are carry-forwarded at read time.
    """
    # frankfurter.app 은 .dev/v1 으로 301 리다이렉트됨 → 바로 신규 엔드포인트 사용
    # + 혹시 모를 도메인 변경에 대비해 follow_redirects=True.
    url = f"https://api.frankfurter.dev/v1/{start.isoformat()}..{end.isoformat()}?from={base}&to={target}"
    try:
        # frankfurter.dev 는 기본 python-httpx User-Agent 를 403 차단 → UA 지정.
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=True,
            headers={"User-Agent": "orbit-fx-backfill/1.0"},
        ) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
    except Exception as exc:  # pragma: no cover — network failure fallback
        logger.warning("환율 히스토리 조회 실패: %s", exc)
        return 0
    rows = data.get("rates") or {}
    if not rows:
        return 0
    count = 0
    for iso_date, per_target in rows.items():
        rate_val = per_target.get(target)
        if rate_val is None:
            continue
        rate = Decimal(str(rate_val))
        stmt = (
            pg_insert(ExchangeRate)
            .values(
                date=date.fromisoformat(iso_date),
                base=base,
                target=target,
                rate=rate,
            )
            .on_conflict_do_update(
                index_elements=["date", "base", "target"],
                set_={"rate": rate, "updated_at": datetime.now(timezone.utc)},
            )
        )
        await db.execute(stmt)
        count += 1
    await db.commit()
    logger.info(
        "환율 히스토리 백필: %s ~ %s %s/%s, %d일",
        start,
        end,
        base,
        target,
        count,
    )
    return count


async def ensure_fx_window(
    db: AsyncSession,
    start: date,
    end: date,
    min_days: int = 20,
    base: str = "USD",
    target: str = "KRW",
) -> None:
    """DB에 해당 기간의 환율 기록이 ``min_days``건 미만이면 frankfurter로
    백필한다. 충분히 있으면 아무 것도 하지 않음."""
    existing = (
        await db.execute(
            select(func.count(ExchangeRate.date)).where(
                ExchangeRate.base == base,
                ExchangeRate.target == target,
                ExchangeRate.date >= start,
                ExchangeRate.date <= end,
            )
        )
    ).scalar_one()
    if int(existing) >= min_days:
        return
    await backfill_fx_history(db, start, end, base, target)


async def get_current_rate(
    db: AsyncSession, base: str = "USD", target: str = "KRW"
) -> tuple[Decimal, date]:
    today = date.today()
    result = await db.execute(
        select(ExchangeRate).where(
            ExchangeRate.date == today,
            ExchangeRate.base == base,
            ExchangeRate.target == target,
        )
    )
    cached = result.scalar_one_or_none()
    if cached:
        return cached.rate, cached.date
    try:
        rate = await fetch_and_cache_rate(db, base, target)
        return rate, today
    except Exception as exc:
        logger.warning(
            "환율 외부 API 조회 실패 (base=%s target=%s) — DB 의 가장 최근 캐시로 fallback: %s",
            base, target, exc, exc_info=True,
        )
        result = await db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.base == base, ExchangeRate.target == target)
            .order_by(ExchangeRate.date.desc())
            .limit(1)
        )
        latest = result.scalar_one_or_none()
        if latest:
            return latest.rate, latest.date
        return Decimal("0"), today
