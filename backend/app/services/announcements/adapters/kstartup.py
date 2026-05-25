"""K-Startup (창업지원포털) 창업지원사업 공고 어댑터.

공공데이터포털: `창업진흥원_K-Startup 창업지원사업 공고정보` (서비스ID 15121654).
  응답: JSON.
"""

from __future__ import annotations

from datetime import date, datetime, timezone, timedelta
from typing import Any

import httpx

from app.services.announcements.base import (
    BIZ_STARTUP,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

_DEFAULT_BASE = "https://apis.data.go.kr/B552735/kisedKstartupService01/getAnnouncementInformation01"
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
    return (
        datetime.combine(d, datetime.min.time()).replace(tzinfo=_KST, hour=18)
        if d
        else None
    )


class KStartupAdapter(AnnouncementAdapter):
    code = "kstartup"
    name = "K-Startup 창업지원"
    requires_api_key = True

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        base = self.config.get("base_url") or _DEFAULT_BASE
        params = {
            "serviceKey": self.api_key,
            "numOfRows": "100",
            "pageNo": "1",
            "resultType": "json",
        }
        async with httpx.AsyncClient(
            timeout=30.0,
            headers={"User-Agent": "Orbit Works/announcements"},
        ) as client:
            items: list[dict] = []
            page = 1
            while True:
                params["pageNo"] = str(page)
                try:
                    r = await client.get(base, params=params)
                    r.raise_for_status()
                    data = r.json()
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(
                        f"K-Startup HTTP error: {exc}"
                    ) from exc
                except ValueError as exc:
                    raise AnnouncementFetchError(
                        f"K-Startup JSON decode 실패: {r.text[:200]!r}"
                    ) from exc

                body = {}
                if isinstance(data, dict):
                    body = (data.get("response") or {}).get("body") or data.get(
                        "body"
                    ) or {}
                raw_items = body.get("items") or body.get("item") or []
                if isinstance(raw_items, dict):
                    raw_items = raw_items.get("item") or [raw_items]
                items.extend(raw_items or [])
                total = int(body.get("totalCount") or 0)
                if not raw_items or len(items) >= total or len(raw_items) < 100:
                    break
                page += 1
                if page > 30:
                    break

        normalized = []
        for it in items:
            r = self._normalize(it)
            if r is None:
                continue
            if r.posted_at and r.posted_at < since:
                continue
            normalized.append(r)
        return normalized

    def _normalize(self, it: dict) -> RawAnnouncement | None:
        ext = _pick(it, "pbancSn", "pbancId", "id")
        title = _pick(it, "biz_pbanc_nm", "bizPbancNm", "pbancNm", "title")
        if not ext or not title:
            return None
        posted = _to_date(
            _pick(it, "pbanc_rcpt_bgng_dt", "pbancRcptBgngDt", "regdate")
        )
        deadline = _to_deadline(
            _pick(it, "pbanc_rcpt_end_dt", "pbancRcptEndDt", "rcptEndDt")
        )
        agency = _pick(it, "pbanc_ntrp_nm", "pbancNtrpNm", "host")
        category = _pick(it, "supt_biz_clsfc", "suptBizClsfc")
        region = _pick(it, "aply_trgt_ctnt", "aplyTrgtCtnt", "area")
        detail = _pick(it, "detl_pg_url", "detlPgUrl", "pbancUrl")
        return RawAnnouncement(
            external_id=str(ext),
            title=str(title).strip(),
            agency=agency,
            business_type=BIZ_STARTUP,
            category=category,
            region=region,
            posted_at=posted,
            deadline_at=deadline,
            detail_url=detail,
            summary=_pick(it, "bsnsSumryCn", "intg_pbanc_yn"),
            raw_payload=it,
        )
