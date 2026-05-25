"""NTIS 국가R&D통합공고 어댑터.

공공데이터포털: `국가과학기술지식정보서비스(NTIS)` API 중 국가R&D통합공고.
  응답: JSON. 키는 공공데이터포털에서 발급.

NTIS 는 운영 경로가 여러 번 바뀌었다. 여기서는 가장 널리 쓰이는 통합공고
endpoint 를 기본값으로 두고, config 로 override 가능하게 했다.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone, timedelta
from typing import Any

import httpx

from app.services.announcements.base import (
    BIZ_RESEARCH,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)

_DEFAULT_BASE = "https://www.ntis.go.kr/rndopen/openApi/public_rndNoti"

_KST = timezone(timedelta(hours=9))


def _pick(d: dict, *keys: str) -> Any:
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def _to_date(v: Any) -> date | None:
    if not v:
        return None
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%Y.%m.%d", "%Y%m%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _to_datetime(v: Any) -> datetime | None:
    d = _to_date(v)
    if d is None:
        return None
    return datetime.combine(d, datetime.min.time()).replace(tzinfo=_KST)


class NtisAdapter(AnnouncementAdapter):
    code = "ntis"
    name = "NTIS 국가R&D통합공고"
    requires_api_key = True

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        base = self.config.get("base_url") or _DEFAULT_BASE
        async with httpx.AsyncClient(
            timeout=30.0,
            headers={"User-Agent": "Orbit Works/announcements"},
        ) as client:
            params = {
                "apprvKey": self.api_key,
                "searchFld": "NTA",     # 통합공고
                "beginDt": since.strftime("%Y%m%d"),
                "endDt": date.today().strftime("%Y%m%d"),
                "addQuery": "",
                "displayCnt": "100",
                "pageNum": "1",
                "returnType": "JSON",
            }
            items: list[dict] = []
            while True:
                try:
                    r = await client.get(base, params=params)
                    r.raise_for_status()
                    data = r.json()
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(f"NTIS HTTP error: {exc}") from exc
                except ValueError as exc:
                    raise AnnouncementFetchError(
                        f"NTIS JSON decode 실패: {exc}; body 앞부분 {r.text[:200]!r}"
                    ) from exc

                # NTIS 응답 구조 variants: {results: [...], totalHits} vs {response: {body: ...}}
                batch = []
                if isinstance(data, dict):
                    if "results" in data and isinstance(data["results"], list):
                        batch = data["results"]
                        total = int(data.get("totalHits") or len(batch))
                    else:
                        resp = (data.get("response") or {}).get("body") or {}
                        raw_items = resp.get("items") or resp.get("item") or []
                        if isinstance(raw_items, dict):
                            raw_items = [raw_items]
                        batch = raw_items
                        total = int(resp.get("totalCount") or len(batch))
                else:
                    total = 0
                items.extend(batch)
                if not batch or len(items) >= total or len(batch) < 100:
                    break
                params["pageNum"] = str(int(params["pageNum"]) + 1)
                if int(params["pageNum"]) > 30:
                    break

        return [r for r in (self._normalize(it) for it in items) if r is not None]

    def _normalize(self, it: dict) -> RawAnnouncement | None:
        ext = _pick(it, "bsnsAncmtId", "bsnsAncmtSn", "docNo", "dataId")
        title = _pick(it, "bsnsAncmtSj", "title", "ttl")
        if not ext or not title:
            return None
        posted = _to_date(_pick(it, "bsnsAncmtBeginDe", "anncmntBgngDt", "regDate"))
        deadline = _to_datetime(_pick(it, "bsnsAncmtEndDe", "rcptEndDt", "anncmntEndDt"))
        agency = _pick(it, "entrpsNm", "spnsrInsttNm", "orgnName", "mngInsttNm")
        detail = _pick(it, "bsnsAncmtUrl", "detailUrl", "noticeUrl", "url")
        summary = _pick(it, "bsnsAncmtCn", "abstract", "contents")
        return RawAnnouncement(
            external_id=str(ext),
            title=str(title).strip(),
            agency=agency,
            business_type=BIZ_RESEARCH,
            posted_at=posted,
            deadline_at=deadline,
            detail_url=detail,
            summary=summary,
            raw_payload=it,
        )
