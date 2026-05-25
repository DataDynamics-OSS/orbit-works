"""NIA (한국지능정보사회진흥원) 입찰공고 어댑터 — **스캐폴드**.

대상 페이지: https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=78336
(NIA 알림 > 입찰공고)

현재 상태:
- NIA 게시판은 초기 HTML 에 테이블·리스트가 렌더되지 않고 Vue/JS 로 비동기
  로드됨. 정적 파싱 불가. 인라인 script 에서도 AJAX 엔드포인트를 찾지 못함.
- 실수집 하려면 Playwright 같은 headless 브라우저 도입 필요 (IITP·KEIT 과제
  공고와 동일한 제약).

빈 리스트 + INFO 로그 반환 → 파이프라인은 정상 동작 (OK 0 rows).
"""

from __future__ import annotations

import logging
from datetime import date

from app.services.announcements.base import (
    AnnouncementAdapter,
    RawAnnouncement,
)

logger = logging.getLogger(__name__)


class NiaAdapter(AnnouncementAdapter):
    code = "nia"
    name = "NIA 입찰공고"
    requires_api_key = False

    async def fetch(self, since: date) -> list[RawAnnouncement]:
        logger.info(
            "NiaAdapter.fetch skipped — NIA 입찰공고 목록이 JS 렌더링이라 "
            "정적 파싱 불가. 실구현 전까지 빈 리스트 반환."
        )
        return []
