"""NIPA (정보통신산업진흥원) 사업공고 어댑터 — 정적 HTML 파싱.

공식 페이지 (정적 렌더링 — JS 불필요):
  https://www.nipa.kr/home/bsnsAll/0/nttList?bbsNo=4&bsnsDtlsIemNo=&tab=2&curPage={page}

각 행 구조: [D-day, 제목+신청기간, 담당자, 등록일]
상세 URL: /home/bsnsAll/0/nttDetail?tab=2&bbsNo=4&bsnsDtlsIemNo=&nttNo={id}

제목 셀 안에 "신청기간 : YYYY-MM-DD HH:MM ~ YYYY-MM-DD HH:MM" 문자열이 섞여 있어
정규식으로 떼어낸 뒤 순수 제목·접수 개시·마감을 분리한다. 상시모집·종료
같이 날짜 범위가 없는 행도 무난히 처리 (deadline_at=None).
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from app.services.announcements.base import (
    BIZ_SUPPORT,
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)

_BASE = "https://www.nipa.kr"
_LIST_PATH = "/home/bsnsAll/0/nttList"
_DETAIL_PATH = "/home/bsnsAll/0/nttDetail"
_KST = timezone(timedelta(hours=9))

_NTT_RE = re.compile(r"nttNo=(\d+)")
# "신청기간 : 2026-04-20 19:00 ~ 2026-05-11 15:00" — 양쪽 시각은 선택.
_PERIOD_RE = re.compile(
    r"신청기간\s*:\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*~\s*"
    r"(\d{4}-\d{2}-\d{2})?(?:\s+(\d{2}:\d{2}))?"
)
# 상시·종료 같이 날짜 없는 "신청기간 : ~" 또는 "신청기간 :" 잔존분 제거용.
_PERIOD_TRAIL_RE = re.compile(r"\s*신청기간\s*:\s*~?\s*$")


def _parse_posted(s: str) -> date | None:
    s = (s or "").strip()
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _clean_title(raw: str) -> tuple[str, date | None, datetime | None]:
    """제목 셀에서 "신청기간 : ..." 를 분리. 순수 제목·접수 개시일·마감일 반환."""
    t = re.sub(r"\s+", " ", (raw or "")).strip()
    m = _PERIOD_RE.search(t)
    start_d: date | None = None
    end_dt: datetime | None = None
    if m:
        sd, st, ed, et = m.groups()
        start_d = _parse_posted(sd) if sd else None
        if ed:
            hh, mm = (int(et[:2]), int(et[3:])) if et else (18, 0)
            try:
                end_dt = datetime(
                    *map(int, ed.split("-")), hh, mm, tzinfo=_KST
                )
            except (ValueError, TypeError):
                end_dt = None
        t = _PERIOD_RE.sub("", t).strip()
    # 날짜 없는 "신청기간 : ~" 잔여분도 제거 (상시·종료 행).
    t = _PERIOD_TRAIL_RE.sub("", t).strip()
    return t, start_d, end_dt


class NipaAdapter(AnnouncementAdapter):
    code = "nipa"
    name = "NIPA 사업공고"
    requires_api_key = False

    # 한 번에 순회할 최대 페이지. 대부분 최신 1~2 페이지 안에 since 이전 건까지 도달.
    _MAX_PAGES = 20

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
                        params={
                            "bbsNo": "4",
                            "bsnsDtlsIemNo": "",
                            "tab": "2",
                            "curPage": page,
                        },
                    )
                    r.raise_for_status()
                except httpx.HTTPError as exc:
                    raise AnnouncementFetchError(f"NIPA HTTP error: {exc}") from exc
                items = self._parse_list(r.text)
                if not items:
                    break
                stop = False
                for it in items:
                    # posted_at 이 since 이전이면 더 이상 최신이 아님 — 순회 중단.
                    if it.posted_at and it.posted_at < since:
                        stop = True
                        continue
                    results.append(it)
                if stop:
                    break
            logger.info(
                "NIPA 사업공고 수집: since=%s pages_scanned≤%d items=%d",
                since, page, len(results),
            )
            return results

    def _parse_list(self, html: str) -> list[RawAnnouncement]:
        soup = BeautifulSoup(html, "lxml")
        tbl = soup.find("table")
        if tbl is None:
            return []
        rows = tbl.find_all("tr")
        items: list[RawAnnouncement] = []
        for tr in rows:
            cells = tr.find_all("td")
            # 실제 데이터 행은 td 4개 (D-day · 제목 · 담당자 · 등록일).
            if len(cells) < 4:
                continue
            link = tr.find("a")
            href = link.get("href") if link else ""
            m = _NTT_RE.search(href or "")
            if not m:
                continue
            ntt = m.group(1)

            raw_title = cells[1].get_text(" ", strip=True)
            title, start_d, deadline_dt = _clean_title(raw_title)
            if not title:
                continue

            manager = cells[2].get_text(" ", strip=True)
            posted = _parse_posted(cells[3].get_text(" ", strip=True))
            detail = urljoin(
                _BASE,
                f"{_DETAIL_PATH}?tab=2&bbsNo=4&bsnsDtlsIemNo=&nttNo={ntt}",
            )

            items.append(
                RawAnnouncement(
                    external_id=ntt,
                    title=title,
                    agency="정보통신산업진흥원",
                    business_type=BIZ_SUPPORT,
                    posted_at=posted,
                    deadline_at=deadline_dt,
                    contact_name=manager or None,
                    detail_url=detail,
                    raw_payload={
                        "dday": cells[0].get_text(" ", strip=True),
                        "title_raw": raw_title,
                        "start_date": start_d.isoformat() if start_d else None,
                    },
                )
            )
        return items
