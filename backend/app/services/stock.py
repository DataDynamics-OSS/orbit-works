"""주가지수 일별 종가 수집 (한국 = ECOS 802Y001, 미국 = FRED).

FX·금리 백필과 동일한 range-fetch + upsert 패턴. series 별로 소스가
다르므로 `Series.source` 에 "ECOS" 또는 "FRED" 를 두고 `_fetch_*` 함수로
디스패치.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal

import httpx
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import StockPrice

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Series:
    code: str           # 내부 식별자 (StockPrice.series_code)
    label: str          # UI 표시명
    color: str          # Highcharts 라인 색상
    source: str         # "ECOS" | "FRED"
    # ECOS: (stat_code, item_code) / FRED: (series_id, "")
    ext_a: str
    ext_b: str = ""


# 국내(ECOS 802Y001 일별) + 해외(FRED 일별). 2개 차트(한국/미국)로 나눌 때
# region 으로 그룹핑 — chart_region 은 "KR" | "US".
SERIES: list[tuple[str, Series]] = [
    ("KR", Series("KOSPI",  "KOSPI",  "#ef4444", "ECOS", "802Y001", "0001000")),
    ("KR", Series("KOSDAQ", "KOSDAQ", "#3b82f6", "ECOS", "802Y001", "0089000")),
    ("US", Series("SP500",  "S&P 500",      "#10b981", "FRED", "SP500")),
    ("US", Series("NASDAQ", "NASDAQ Comp.", "#8b5cf6", "FRED", "NASDAQCOM")),
    ("US", Series("DJIA",   "Dow Jones",    "#f59e0b", "FRED", "DJIA")),
]


def _fmt_ymd_slash(d: date) -> str:
    return d.isoformat()  # FRED: YYYY-MM-DD


def _fmt_ymd_compact(d: date) -> str:
    return d.strftime("%Y%m%d")  # ECOS: YYYYMMDD


async def _fetch_ecos(
    client: httpx.AsyncClient, api_key: str, base_url: str, s: Series, start: date, end: date
) -> list[tuple[date, Decimal]]:
    url = (
        f"{base_url.rstrip('/')}/StatisticSearch/{api_key}/json/kr/1/10000/"
        f"{s.ext_a}/D/{_fmt_ymd_compact(start)}/{_fmt_ymd_compact(end)}/{s.ext_b}"
    )
    try:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        logger.warning("ECOS %s 주가 조회 실패: %s", s.code, exc)
        return []
    if "RESULT" in data:
        code = data["RESULT"].get("CODE")
        if code != "INFO-200":
            logger.warning("ECOS %s 응답 오류: %s", s.code, data["RESULT"])
        return []
    rows = data.get("StatisticSearch", {}).get("row", []) or []
    out: list[tuple[date, Decimal]] = []
    for row in rows:
        t = str(row.get("TIME", ""))
        v = row.get("DATA_VALUE")
        if len(t) != 8 or v in (None, "", "-"):
            continue
        try:
            d = date(int(t[:4]), int(t[4:6]), int(t[6:8]))
            out.append((d, Decimal(str(v))))
        except Exception:
            continue
    return out


async def _fetch_fred(
    client: httpx.AsyncClient, api_key: str, base_url: str, s: Series, start: date, end: date
) -> list[tuple[date, Decimal]]:
    url = f"{base_url.rstrip('/')}/series/observations"
    params = {
        "series_id": s.ext_a,
        "observation_start": _fmt_ymd_slash(start),
        "observation_end": _fmt_ymd_slash(end),
        "api_key": api_key,
        "file_type": "json",
    }
    try:
        r = await client.get(url, params=params)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        logger.warning("FRED %s 조회 실패: %s", s.code, exc)
        return []
    obs = data.get("observations") or []
    out: list[tuple[date, Decimal]] = []
    for row in obs:
        v = row.get("value")
        # FRED 는 결측치를 "." 로 표현.
        if v in (None, "", "."):
            continue
        try:
            d = date.fromisoformat(row["date"])
            out.append((d, Decimal(str(v))))
        except Exception:
            continue
    return out


async def backfill_stock_history(
    db: AsyncSession, start: date, end: date
) -> int:
    """ECOS + FRED 에서 모든 시리즈를 범위 조회 후 upsert. 총 행 수 반환.

    키 미설정 시 해당 소스는 건너뜀 (non-blocking). 예: ECOS 만 있고 FRED 키가
    없으면 국내 지수만 수집, US 시리즈는 DB 에 안 들어간다.
    """
    s = get_settings()
    ecos_cfg = s.ecos
    fred_cfg = s.fred
    total = 0
    async with httpx.AsyncClient(
        timeout=15,
        follow_redirects=True,
        headers={"User-Agent": "orbit-stock/1.0"},
    ) as client:
        for _region, sr in SERIES:
            rows: list[tuple[date, Decimal]] = []
            if sr.source == "ECOS":
                if not (ecos_cfg.enabled and ecos_cfg.api_key):
                    continue
                rows = await _fetch_ecos(client, ecos_cfg.api_key, ecos_cfg.base_url, sr, start, end)
            elif sr.source == "FRED":
                if not (fred_cfg.enabled and fred_cfg.api_key):
                    continue
                rows = await _fetch_fred(client, fred_cfg.api_key, fred_cfg.base_url, sr, start, end)
            for d, close in rows:
                stmt = (
                    pg_insert(StockPrice)
                    .values(date=d, series_code=sr.code, close=close)
                    .on_conflict_do_update(
                        index_elements=["date", "series_code"],
                        set_={"close": close, "updated_at": datetime.now(timezone.utc)},
                    )
                )
                await db.execute(stmt)
                total += 1
    await db.commit()
    if total > 0:
        logger.info("주가 히스토리 백필: %s ~ %s, %d rows", start, end, total)
    return total


async def ensure_stock_window(
    db: AsyncSession, start: date, end: date, min_days_per_series: int = 15
) -> None:
    """어느 시리즈든 윈도우 내 행수가 min_days 미만이면 전체 백필. 그 외 no-op."""
    for _region, sr in SERIES:
        existing = (
            await db.execute(
                select(func.count(StockPrice.date)).where(
                    StockPrice.series_code == sr.code,
                    StockPrice.date >= start,
                    StockPrice.date <= end,
                )
            )
        ).scalar_one()
        if int(existing) < min_days_per_series:
            await backfill_stock_history(db, start, end)
            return
