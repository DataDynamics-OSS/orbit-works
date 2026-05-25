"""KEIT (한국산업기술기획평가원) 공지·입찰 공고 어댑터.

정적 HTML 파싱 가능한 KEIT 공지사항 게시판(bid=0009)을 대상으로 한다.
이 게시판은 KEIT 자체의 공지·입찰(용역·RFP) 공고 위주이며, 본격적인
R&D 과제공고 는 SROME(srome.keit.re.kr)에 있는데 SPA 라 정적 파싱 불가.
R&D 과제공고 통합 수집은 NTIS 어댑터가 담당.

페이지 URL: /board.es?mid=a10301010000&bid=0009&nPage={page}
"""

from __future__ import annotations

import logging
import re
from datetime import date
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from app.services.announcements.base import (
    BIZ_PUBLIC_BID,
    BIZ_SUPPORT,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)

_BASE = "https://www.keit.re.kr"
_LIST_PATH = "/board.es"
_MID = "a10301010000"
_BID = "0009"
# href 안의 list_no=, 없으면 onclick 속성의 goView('NNNN') 패턴에서 추출.
_LIST_NO_RE = re.compile(r"list_no=(\d+)")
_GOVIEW_RE = re.compile(r"goView\(\s*['\"](\d+)['\"]")


def _parse_date(s: str) -> date | None:
    s = (s or "").strip().replace(".", "-")
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


class KeitAdapter(AnnouncementAdapter):
    code = "keit"
    name = "KEIT 공지·입찰"
    requires_api_key = False

    _MAX_PAGES = 10

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
            for page in range(1, self._MAX_PAGES + 1):
                try:
                    r = await client.get(
                        urljoin(_BASE, _LIST_PATH),
                        params={"mid": _MID, "bid": _BID, "nPage": page},
                    )
                    r.raise_for_status()
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(f"KEIT HTTP error: {exc}") from exc
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
            logger.info("KEIT 공지·입찰 수집: since=%s items=%d", since, len(results))
            return results

    def _parse_list(self, html: str) -> list[RawAnnouncement]:
        soup = BeautifulSoup(html, "lxml")
        tbl = soup.find("table")
        if tbl is None:
            return []
        rows = tbl.find_all("tr")
        items: list[RawAnnouncement] = []
        # 헤더: [번호 · 분류 · 제목 · 등록일 · 첨부파일]
        for tr in rows[1:]:
            cells = tr.find_all("td")
            if len(cells) < 4:
                continue
            link = tr.find("a")
            if link is None:
                continue
            href = link.get("href") or ""
            onclick = link.get("onclick") or ""
            m = _LIST_NO_RE.search(href) or _GOVIEW_RE.search(onclick)
            if not m:
                continue
            list_no = m.group(1)

            no_txt = cells[0].get_text(" ", strip=True)
            bunryu = cells[1].get_text(" ", strip=True)
            raw_title = cells[2].get_text(" ", strip=True)
            # "새글" prefix 제거.
            title = re.sub(r"^새글\s*", "", raw_title).strip()
            if not title:
                continue
            posted = _parse_date(cells[3].get_text(" ", strip=True))
            # 분류 → Orbit Works business_type 매핑.
            biz = BIZ_PUBLIC_BID if "입찰" in bunryu else BIZ_SUPPORT

            detail = urljoin(
                _BASE,
                f"{_LIST_PATH}?mid={_MID}&bid={_BID}&act=view&list_no={list_no}",
            )
            items.append(
                RawAnnouncement(
                    external_id=list_no,
                    title=title,
                    agency="한국산업기술기획평가원",
                    category=bunryu,
                    business_type=biz,
                    posted_at=posted,
                    detail_url=detail,
                    raw_payload={"no": no_txt, "category": bunryu},
                )
            )
        return items
