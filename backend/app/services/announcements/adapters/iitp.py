"""IITP (정보통신기획평가원) 사업공고 어댑터 — **스캐폴드**.

현재 상태:
- iitp.kr/kr/1/notice/Business/list.it 은 JS 기반 게시판으로 초기 HTML 에
  공고 목록이 포함되지 않음. 정적 파싱 불가.
- 실구현을 위해서는 AJAX 엔드포인트 분석 또는 headless 브라우저 도입이 필요.

`fetch()` 는 빈 리스트 + INFO 로그를 반환해 파이프라인이 성공(0 rows)으로
집계되게 함. 실 URL 확보 시 `fetch()` 본문만 채우면 됨.
"""

from __future__ import annotations

import logging
from datetime import date

from app.services.announcements.base import (
    AnnouncementAdapter,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)


class IitpAdapter(AnnouncementAdapter):
    code = "iitp"
    name = "IITP 사업공고"
    requires_api_key = False

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        logger.info(
            "IitpAdapter.fetch skipped — IITP 목록 페이지가 JS 렌더링이라 "
            "정적 파싱 불가. 실구현 전까지 빈 리스트 반환."
        )
        return []
