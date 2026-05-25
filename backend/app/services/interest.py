"""ECOS(한국은행 경제통계시스템) 국내 금리 시계열 수집.

Usage (app/main.py lifespan + scheduler):
    await backfill_interest_history(db, start, end)   # 범위 백필
    await ensure_interest_window(db, start, end)      # 부족하면 백필

Dashboard 에 6개 시리즈 (기준금리 · 콜금리 · CD91 · 국고채 3/10년 · 회사채 3년)
를 한 차트에 그린다. ECOS API 키는 `get_settings().ecos.api_key` 로 관리.
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
from app.models import InterestRate

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Series:
    code: str           # 내부 식별자 (InterestRate.series_code 에 저장)
    label: str          # UI 표시명
    color: str          # Highcharts 라인 색상
    stat_code: str      # ECOS 통계표 코드
    item_code: str      # ECOS 항목 코드


# 차트에 한 화면에 같이 보여주는 6개 시리즈. 순서 = legend·Y 범위 영향 순서.
# 라인 색상은 기존 대시보드 팔레트 (#0ea5e9 FX 와 충돌 안 나는 범위).
SERIES: list[Series] = [
    Series("BASE_RATE",   "기준금리",        "#ef4444", "722Y001", "0101000"),
    Series("CALL_1D",     "콜금리(1일)",     "#f59e0b", "817Y002", "010101000"),
    Series("CD_91",       "CD(91일)",       "#10b981", "817Y002", "010502000"),
    Series("TB_3Y",       "국고채(3년)",     "#3b82f6", "817Y002", "010200000"),
    Series("TB_10Y",      "국고채(10년)",    "#8b5cf6", "817Y002", "010210000"),
    Series("CORP_3Y_AA",  "회사채(3년,AA-)", "#ec4899", "817Y002", "010300000"),
]
SERIES_BY_CODE: dict[str, Series] = {s.code: s for s in SERIES}


def _fmt_ymd(d: date) -> str:
    return d.strftime("%Y%m%d")


async def _fetch_one(client: httpx.AsyncClient, api_key: str, base_url: str, s: Series, start: date, end: date) -> list[tuple[date, Decimal]]:
    """ECOS 에서 한 시리즈를 범위 조회 후 (date, rate) 리스트 반환."""
    url = (
        f"{base_url.rstrip('/')}/StatisticSearch/{api_key}/json/kr/1/10000/"
        f"{s.stat_code}/D/{_fmt_ymd(start)}/{_fmt_ymd(end)}/{s.item_code}"
    )
    try:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # pragma: no cover — 네트워크/HTTP 실패
        logger.warning("ECOS %s 조회 실패: %s", s.code, exc)
        return []
    if "RESULT" in data:
        # INFO-200 = 데이터 없음 (기간 내 공시 미발생 등). 키 오류면 ERROR-XXX.
        code = data["RESULT"].get("CODE")
        msg = data["RESULT"].get("MESSAGE")
        if code == "INFO-200":
            return []
        logger.warning("ECOS %s 응답 오류: %s %s", s.code, code, msg)
        return []
    rows = data.get("StatisticSearch", {}).get("row", []) or []
    out: list[tuple[date, Decimal]] = []
    for row in rows:
        time_str = str(row.get("TIME", ""))
        val_str = row.get("DATA_VALUE")
        if len(time_str) != 8 or val_str in (None, "", "-"):
            continue
        try:
            d = date(int(time_str[0:4]), int(time_str[4:6]), int(time_str[6:8]))
            rate = Decimal(str(val_str))
        except Exception:
            continue
        out.append((d, rate))
    return out


async def backfill_interest_history(
    db: AsyncSession, start: date, end: date
) -> int:
    """ECOS 범위 조회로 모든 시리즈를 백필. 삽입/갱신된 총 행 수 반환.

    ECOS 키가 비어 있으면 아무 것도 안 하고 0 리턴 (non-blocking 기동 정책).
    """
    cfg = get_settings().ecos
    if not cfg.enabled or not cfg.api_key:
        logger.info("ECOS 비활성 또는 API key 미설정 — 금리 백필 건너뜀")
        return 0

    total = 0
    async with httpx.AsyncClient(
        timeout=15,
        follow_redirects=True,
        headers={"User-Agent": "orbit-interest/1.0"},
    ) as client:
        for s in SERIES:
            rows = await _fetch_one(client, cfg.api_key, cfg.base_url, s, start, end)
            for d, rate in rows:
                stmt = (
                    pg_insert(InterestRate)
                    .values(date=d, series_code=s.code, rate=rate)
                    .on_conflict_do_update(
                        index_elements=["date", "series_code"],
                        set_={"rate": rate, "updated_at": datetime.now(timezone.utc)},
                    )
                )
                await db.execute(stmt)
                total += 1
    await db.commit()
    logger.info("금리 히스토리 백필: %s ~ %s, %d rows (%d series)", start, end, total, len(SERIES))
    return total


async def ensure_interest_window(
    db: AsyncSession, start: date, end: date, min_days_per_series: int = 20
) -> None:
    """시리즈당 기간 내 행수가 min_days 미만이면 전체 범위 백필. 그렇지 않으면 no-op."""
    need_backfill = False
    for s in SERIES:
        existing = (
            await db.execute(
                select(func.count(InterestRate.date)).where(
                    InterestRate.series_code == s.code,
                    InterestRate.date >= start,
                    InterestRate.date <= end,
                )
            )
        ).scalar_one()
        if int(existing) < min_days_per_series:
            need_backfill = True
            break
    if need_backfill:
        await backfill_interest_history(db, start, end)
