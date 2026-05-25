"""조달청 나라장터 (G2B) 입찰공고 어댑터.

공공데이터포털 API: `조달청_나라장터 입찰공고정보서비스` (서비스ID 15129394).
  BASE: apis.data.go.kr/1230000/BidPublicInfoService05/getBidPblancListInfoServc

업무 카테고리별로 네 가지 operation 이 있다:
 - getBidPblancListInfoServc  (용역)
 - getBidPblancListInfoThng   (물품)
 - getBidPblancListInfoCnstwk (공사)
 - getBidPblancListInfoFrgcpt (외자)

response type=json, serviceKey 는 URL-encoded decoding key 를 그대로 전달.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timezone, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.services.announcements.base import (
    BIZ_PUBLIC_BID,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)

_BASE = "https://apis.data.go.kr/1230000/BidPublicInfoService05"
_OPS = [
    ("getBidPblancListInfoServc", "용역"),
    ("getBidPblancListInfoThng", "물품"),
    ("getBidPblancListInfoCnstwk", "공사"),
    ("getBidPblancListInfoFrgcpt", "외자"),
]

# KST
_KST = timezone(timedelta(hours=9))


def _to_datetime(s: Any) -> datetime | None:
    if not s:
        return None
    txt = str(s).strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y%m%d%H%M", "%Y%m%d"):
        try:
            return datetime.strptime(txt, fmt).replace(tzinfo=_KST)
        except ValueError:
            continue
    return None


def _to_date(s: Any) -> date | None:
    dt = _to_datetime(s)
    return dt.date() if dt else None


def _to_int_amount(s: Any) -> int | None:
    if s in (None, "", "0"):
        return None
    try:
        return int(Decimal(str(s).replace(",", "")))
    except (InvalidOperation, ValueError):
        return None


class G2BAdapter(AnnouncementAdapter):
    code = "g2b"
    name = "나라장터 입찰공고"
    requires_api_key = True

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        results: list[RawAnnouncement] = []
        # inqryBgnDt ~ inqryEndDt: yyyyMMddHHmm 범위 (공고 등록일시).
        begin = datetime.combine(since, time.min).strftime("%Y%m%d%H%M")
        end = datetime.now().strftime("%Y%m%d%H%M")

        async with httpx.AsyncClient(
            timeout=30.0,
            headers={"User-Agent": "Orbit Works/announcements"},
        ) as client:
            for op, category in _OPS:
                try:
                    items = await self._fetch_op(client, op, begin, end)
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(
                        f"G2B {op} HTTP error: {exc}"
                    ) from exc
                for it in items:
                    raw = self._normalize(it, category)
                    if raw is not None:
                        results.append(raw)
        return results

    async def _fetch_op(
        self,
        client: httpx.AsyncClient,
        operation: str,
        begin: str,
        end: str,
    ) -> list[dict]:
        url = f"{_BASE}/{operation}"
        items: list[dict] = []
        page = 1
        per_page = 100
        while True:
            params = {
                "serviceKey": self.api_key,
                "pageNo": str(page),
                "numOfRows": str(per_page),
                "inqryDiv": "1",   # 등록일시 기준
                "inqryBgnDt": begin,
                "inqryEndDt": end,
                "type": "json",
            }
            r = await client.get(url, params=params)
            r.raise_for_status()
            try:
                data = r.json()
            except ValueError as exc:
                raise AnnouncementFetchError(
                    f"G2B {operation}: json decode 실패 (앞부분: {r.text[:200]!r})"
                ) from exc
            body = (data.get("response") or {}).get("body") or {}
            header = (data.get("response") or {}).get("header") or {}
            if header.get("resultCode") not in (None, "00", "000"):
                raise AnnouncementFetchError(
                    f"G2B {operation} 응답 오류: {header}"
                )
            batch = (body.get("items") or [])
            if isinstance(batch, dict):
                # 단건만 있을 때 dict 로 오는 경우 처리 (공공데이터 공통 패턴).
                batch = [batch]
            items.extend(batch)
            total = int(body.get("totalCount") or 0)
            if page * per_page >= total or not batch:
                break
            page += 1
            if page > 50:  # 안전장치 — 하루 5000건 이상이면 수동 조정 필요.
                logger.warning("G2B %s: 50 페이지 초과, 중단", operation)
                break
        return items

    def _normalize(self, it: dict, category: str) -> RawAnnouncement | None:
        # bidNtceNo + bidNtceOrd 가 공고+차수 고유키. 차수 없으면 0.
        ntce_no = (it.get("bidNtceNo") or "").strip()
        ntce_ord = (it.get("bidNtceOrd") or "00").strip()
        if not ntce_no:
            return None
        external_id = f"{ntce_no}-{ntce_ord}"
        title = (it.get("bidNtceNm") or "").strip()
        if not title:
            return None
        posted = _to_date(it.get("bidNtceDt"))
        deadline = _to_datetime(it.get("bidClseDt") or it.get("opengDt"))
        budget = _to_int_amount(it.get("presmptPrce") or it.get("bdgtAmt"))
        url = (it.get("bidNtceDtlUrl") or it.get("bidNtceUrl") or "").strip() or None
        agency = (it.get("ntceInsttNm") or it.get("dminsttNm") or "").strip() or None
        dept = (it.get("ntceInsttOfclDeptNm") or "").strip() or None
        contact = (it.get("ntceInsttOfclNm") or "").strip() or None
        phone = (it.get("ntceInsttOfclTelNo") or "").strip() or None
        email = (it.get("ntceInsttOfclEmailAdrs") or "").strip() or None
        region = (it.get("rgstTyNm") or "").strip() or None
        return RawAnnouncement(
            external_id=external_id,
            title=title,
            agency=agency,
            department=dept,
            business_type=BIZ_PUBLIC_BID,
            category=category,
            region=region,
            posted_at=posted,
            deadline_at=deadline,
            budget_amount=budget,
            contact_name=contact,
            contact_phone=phone,
            contact_email=email,
            detail_url=url,
            summary=None,
            raw_payload=it,
        )
