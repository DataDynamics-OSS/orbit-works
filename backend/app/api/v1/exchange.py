"""환율 API.

`/exchange/current` — 단일 페어 (USD↔KRW 등) 의 현재 환율을 반환. 기존 자산
원가 계산용으로 ExchangeRate 테이블 캐시.

`/exchange/multi` — 한 번에 여러 통화 (USD, EUR, CNY, JPY, THB, VND, TWD,
HKD, SGD) 환율을 반환. 사이드바 계산기 위젯의 환율 변환용.
외부 API (open.er-api.com, 무료, API 키 불필요, 161개 통화 지원) 호출 +
in-memory 6시간 캐시. frankfurter 는 VND/TWD 를 지원하지 않아 변경됨.
"""

import asyncio
import logging
import time
from datetime import date as _date

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import User
from app.services.exchange import get_current_rate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/exchange", tags=["exchange"])


@router.get("/current")
async def current_rate(
    base: str = "USD",
    target: str = "KRW",
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rate, as_of = await get_current_rate(db, base, target)
    return {"base": base, "target": target, "rate": str(rate), "as_of": as_of.isoformat()}


# ---------------------------------------------------------------------------
# Multi-currency endpoint — 사이드바 계산기 위젯용.
# ---------------------------------------------------------------------------

# 지원 통화 — 계산기 UI 와 동일. base 가 이 중 하나이면 나머지를 target 으로
# 자동 산출. VND/TWD 는 frankfurter 가 미지원이라 open.er-api.com 사용.
SUPPORTED_CURRENCIES = [
    "KRW", "USD", "EUR", "CNY", "JPY", "THB",
    "VND", "TWD", "HKD", "SGD",
]

# 외부 API 실패 시 사용할 fallback 환율 (1 KRW 당 X 통화). 2026-05 기준
# 대략값 — UI 가 source 필드로 'fallback' 표시.
FALLBACK_RATES_FROM_KRW: dict[str, float] = {
    "USD": 0.00072,
    "EUR": 0.00067,
    "CNY": 0.0052,
    "JPY": 0.107,
    "THB": 0.025,
    "VND": 17.0,
    "TWD": 0.022,
    "HKD": 0.0056,
    "SGD": 0.00097,
}

CACHE_TTL_SECONDS = 6 * 60 * 60  # 6시간

# (base) → (timestamp, payload). asyncio.Lock 으로 동시 호출 dedup.
_multi_cache: dict[str, tuple[float, "ExchangeMultiOut"]] = {}
_multi_lock = asyncio.Lock()


class ExchangeMultiOut(BaseModel):
    base: str
    date: str
    # base 1 단위당 target 통화 (예: base=KRW → {"USD": 0.00072, ...})
    rates: dict[str, float]
    source: str               # "open-er-api" | "fallback"


async def _fetch_multi_from_open_er_api(base: str) -> "ExchangeMultiOut | None":
    """open.er-api.com 으로부터 base 통화 기준 환율 다중 조회.

    응답에 161개 통화가 모두 들어오므로 SUPPORTED_CURRENCIES 만 추려서 반환.
    frankfurter 가 미지원하는 VND/TWD 를 위해 이 소스를 사용.
    """
    url = f"https://open.er-api.com/v6/latest/{base}"
    try:
        async with httpx.AsyncClient(
            timeout=8.0,
            follow_redirects=True,
            headers={"User-Agent": "orbit-fx/1.0"},
        ) as client:
            r = await client.get(url)
            if r.status_code != 200:
                logger.warning(
                    "open.er-api multi status=%s body=%s",
                    r.status_code, r.text[:200],
                )
                return None
            data = r.json()
        if data.get("result") != "success":
            logger.warning("open.er-api result != success: %s", data.get("error-type"))
            return None
        all_rates: dict[str, float] = {
            k: float(v) for k, v in data.get("rates", {}).items()
        }
        # SUPPORTED_CURRENCIES 만 추리고, base 자기 자신은 제외.
        rates = {
            c: all_rates[c]
            for c in SUPPORTED_CURRENCIES
            if c != base and c in all_rates
        }
        # date 는 time_last_update_utc 에서 YYYY-MM-DD 만 추출. 응답 포맷은
        # RFC2822 ('Fri, 01 Mar 2024 00:00:01 +0000') — 안 맞으면 today.
        ts_iso = data.get("time_last_update_utc", "")
        date_str = _date.today().isoformat()
        if ts_iso:
            try:
                from email.utils import parsedate_to_datetime
                dt = parsedate_to_datetime(ts_iso)
                date_str = dt.date().isoformat()
            except Exception:
                pass
        return ExchangeMultiOut(
            base=data.get("base_code", base),
            date=date_str,
            rates=rates,
            source="open-er-api",
        )
    except Exception as e:
        logger.warning("open.er-api multi fetch failed: %s", e)
        return None


def _fallback_multi(base: str) -> "ExchangeMultiOut":
    """외부 API 실패 시 하드코딩된 KRW 환율로 산출."""
    if base == "KRW":
        rates = dict(FALLBACK_RATES_FROM_KRW)
    else:
        krw_per_base = 1.0 / FALLBACK_RATES_FROM_KRW.get(base, 1.0)
        rates = {"KRW": krw_per_base}
        for tgt, krw_rate in FALLBACK_RATES_FROM_KRW.items():
            if tgt == base:
                continue
            rates[tgt] = krw_per_base * krw_rate
    return ExchangeMultiOut(
        base=base,
        date=_date.today().isoformat(),
        rates=rates,
        source="fallback",
    )


@router.get("/multi", response_model=ExchangeMultiOut)
async def multi_rates(
    base: str = "KRW",
    _: User = Depends(get_current_user),
):
    """여러 통화 환율 동시 조회. 6시간 in-memory 캐시.

    `base` 통화 1단위당 다른 통화의 양을 반환. 예: base=KRW 면
    `rates = {"USD": 0.00072, "EUR": ..., ...}`.

    외부 API 호출 실패 시 fallback rates 로 응답 (응답의 `source` 필드로 구분).
    """
    base_upper = base.upper()
    if base_upper not in SUPPORTED_CURRENCIES:
        base_upper = "KRW"

    cached = _multi_cache.get(base_upper)
    now = time.time()
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    async with _multi_lock:
        cached = _multi_cache.get(base_upper)
        if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

        result = await _fetch_multi_from_open_er_api(base_upper)
        if result is None:
            result = _fallback_multi(base_upper)
            logger.warning("환율 multi fallback 사용: base=%s", base_upper)
        else:
            logger.info(
                "환율 multi open.er-api 갱신: base=%s date=%s rates=%s",
                base_upper, result.date, list(result.rates.keys()),
            )
        _multi_cache[base_upper] = (time.time(), result)
        return result
