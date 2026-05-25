"""기업마당(BizInfo) 지원사업 공고 어댑터.

공공데이터포털: `중소벤처기업부_기업마당 지원사업 정보` (서비스ID 15081808 / 15121294).
  응답: JSON. 하나의 endpoint 로 중앙부처·지자체·유관기관 지원사업을 통합 조회.
"""

from __future__ import annotations

from datetime import date, datetime, timezone, timedelta
from typing import Any

import httpx

from app.services.announcements.base import (
    BIZ_SUPPORT,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

_DEFAULT_BASE = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"
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
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            continue
    return None


def _to_deadline(v: Any) -> datetime | None:
    d = _to_date(v)
    if d is None:
        return None
    # 접수 마감 기본 18:00 KST 로 보정.
    return datetime.combine(d, datetime.min.time()).replace(tzinfo=_KST).replace(hour=18)


class BizInfoAdapter(AnnouncementAdapter):
    code = "bizinfo"
    name = "기업마당 지원사업"
    requires_api_key = True

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        base = self.config.get("base_url") or _DEFAULT_BASE
        params = {
            "crtfcKey": self.api_key,
            "dataType": "json",
            "searchCnt": "100",
            "searchPagingStart": "1",
        }
        async with httpx.AsyncClient(
            timeout=30.0,
            headers={"User-Agent": "Orbit Works/announcements"},
        ) as client:
            items: list[dict] = []
            page = 1
            while True:
                params["searchPagingStart"] = str(page)
                try:
                    r = await client.get(base, params=params)
                    r.raise_for_status()
                    data = r.json()
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(f"BizInfo HTTP error: {exc}") from exc
                except ValueError as exc:
                    raise AnnouncementFetchError(
                        f"BizInfo JSON decode 실패: body {r.text[:200]!r}"
                    ) from exc

                # BizInfo 응답 variants.
                batch = []
                total = 0
                if isinstance(data, dict):
                    if "jsonArray" in data:
                        batch = data["jsonArray"] or []
                        total = int(data.get("totalCount") or len(batch))
                    elif "response" in data:
                        body = (data["response"].get("body") or {})
                        raw_items = body.get("items") or body.get("item") or []
                        if isinstance(raw_items, dict):
                            raw_items = [raw_items]
                        batch = raw_items
                        total = int(body.get("totalCount") or len(batch))
                items.extend(batch)
                if not batch or len(items) >= total or len(batch) < 100:
                    break
                page += 1
                if page > 30:
                    break

        # since 이후 등록분만.
        normalized: list[RawAnnouncement] = []
        for it in items:
            raw = self._normalize(it)
            if raw is None:
                continue
            if raw.posted_at and raw.posted_at < since:
                continue
            normalized.append(raw)
        return normalized

    def _normalize(self, it: dict) -> RawAnnouncement | None:
        ext = _pick(it, "pblancId", "sno", "id")
        title = _pick(it, "pblancNm", "title")
        if not ext or not title:
            return None
        posted = _to_date(_pick(it, "creatPnttm", "regDate", "pblancBeginDate"))
        deadline = _to_deadline(
            _pick(it, "reqstEndDate", "reqstEndde", "pblancEndDate", "rceptEndDate")
        )
        agency = _pick(it, "jrsdInsttNm", "excInsttNm", "spnsrOrgnNm")
        dept = _pick(it, "trgetNm", "industry")
        region = _pick(it, "areaNm", "pldirSportRealmLclasCodeNm")
        detail_path = _pick(it, "pblancUrl", "noticeUrl")
        detail = None
        if detail_path:
            detail = str(detail_path)
            if detail.startswith("/"):
                detail = "https://www.bizinfo.go.kr" + detail
        return RawAnnouncement(
            external_id=str(ext),
            title=str(title).strip(),
            agency=agency,
            department=dept,
            business_type=BIZ_SUPPORT,
            region=region,
            posted_at=posted,
            deadline_at=deadline,
            detail_url=detail,
            summary=_pick(it, "bsnsSumryCn", "sumryCn", "summary"),
            raw_payload=it,
        )
