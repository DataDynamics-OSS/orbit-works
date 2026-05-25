"""IRIS (범부처통합연구지원시스템) 사업공고 어댑터 — HTML 파싱.

공식 OpenAPI 가 약해 목록 페이지를 직접 HTML 파싱한다.
  https://www.iris.go.kr/contents/retrieveBsnsAncmBtinSituListView.do

IRIS 는 ancmId 를 쿼리로 받아 상세 페이지를 연다 —
  retrieveBsnsAncmView.do?ancmId={id}&ancmPrg=ancmPre

목록 HTML 구조 변경에 취약 — 파싱 실패 시 runner 가 source 만 FAILED 로 기록.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, time, timezone, timedelta
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from app.services.announcements.base import (
    BIZ_RESEARCH,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)

_BASE = "https://www.iris.go.kr"
_LIST = "/contents/retrieveBsnsAncmBtinSituListView.do"
_KST = timezone(timedelta(hours=9))

_ID_RE = re.compile(r"ancmId=([A-Za-z0-9_]+)")


def _parse_date(s: str) -> date | None:
    s = (s or "").strip().replace(".", "-").replace("/", "-")
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M", "%Y%m%d"):
        try:
            return datetime.strptime(s[: len(fmt)], fmt).date()
        except ValueError:
            continue
    return None


class IrisAdapter(AnnouncementAdapter):
    code = "iris"
    name = "IRIS 사업공고"
    requires_api_key = False

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        async with httpx.AsyncClient(
            timeout=30.0,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; Orbit Works/announcements)",
                "Accept-Language": "ko,en;q=0.8",
            },
            follow_redirects=True,
        ) as client:
            results: list[RawAnnouncement] = []
            page = 1
            # IRIS 페이지 크기 기본 10. max 30 페이지까지 순회.
            while page <= 30:
                try:
                    r = await client.post(
                        urljoin(_BASE, _LIST),
                        data={"pageIndex": str(page), "recordCountPerPage": "30"},
                    )
                    r.raise_for_status()
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(f"IRIS HTTP error: {exc}") from exc
                items = self._parse_list(r.text)
                if not items:
                    break
                stop = False
                for it in items:
                    if it.posted_at and it.posted_at < since:
                        stop = True
                        continue
                    results.append(it)
                if stop:
                    break
                page += 1
            return results

    def _parse_list(self, html: str) -> list[RawAnnouncement]:
        soup = BeautifulSoup(html, "lxml")
        rows = soup.select("table tbody tr")
        items: list[RawAnnouncement] = []
        for tr in rows:
            cells = tr.find_all("td")
            if len(cells) < 4:
                continue
            link = tr.find("a")
            if link is None:
                continue
            href = link.get("href") or link.get("onclick") or ""
            m = _ID_RE.search(href)
            ext = m.group(1) if m else None
            if not ext:
                # onclick="fn_detail('017154','ancmPre')" 패턴
                m2 = re.search(r"fn_detail\(\s*['\"]([^'\"]+)['\"]", href)
                if m2:
                    ext = m2.group(1)
            if not ext:
                continue
            title = link.get_text(strip=True)
            if not title:
                continue
            # 셀 파싱은 테이블 구조에 따라 유연하게 — 보통 [부처 · 제목 · 접수기간 · 담당 · 상태]
            cell_texts = [c.get_text(" ", strip=True) for c in cells]
            agency = cell_texts[0] if len(cell_texts) > 0 else None
            # 접수기간 셀 파싱 (예: "2026-04-10 ~ 2026-05-10")
            deadline_dt = None
            posted_dt = None
            for ct in cell_texts:
                if "~" in ct:
                    parts = [p.strip() for p in ct.split("~")]
                    if len(parts) == 2:
                        posted_dt = _parse_date(parts[0])
                        end = _parse_date(parts[1])
                        if end:
                            deadline_dt = datetime.combine(end, time(18, 0)).replace(
                                tzinfo=_KST
                            )
                    break
            detail = f"{_BASE}/contents/retrieveBsnsAncmView.do?ancmId={ext}&ancmPrg=ancmPre"
            items.append(
                RawAnnouncement(
                    external_id=ext,
                    title=title,
                    agency=agency,
                    business_type=BIZ_RESEARCH,
                    posted_at=posted_dt,
                    deadline_at=deadline_dt,
                    detail_url=detail,
                    raw_payload={"cells": cell_texts},
                )
            )
        return items
