"""어댑터 공통 인터페이스.

새 소스를 추가하려면:
1. `adapters/<code>.py` 에 `AnnouncementAdapter` 서브클래스 작성
2. `registry.ADAPTERS` 에 등록
3. `announcement_sources` 테이블에 seed row 삽입 (db.sql)

Adapter 는 **DB 를 건드리지 않는다** — 정규화된 `RawAnnouncement` 리스트만
반환하고, 저장·UPSERT 는 `runner` 가 담당한다.
"""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import date, datetime

# 업무 유형 enum.
BIZ_RESEARCH = "RESEARCH"
BIZ_PUBLIC_BID = "PUBLIC_BID"
BIZ_PRIVATE_BID = "PRIVATE_BID"
BIZ_STARTUP = "STARTUP"
BIZ_SUPPORT = "SUPPORT"
BIZ_OTHER = "OTHER"


class AnnouncementFetchError(Exception):
    """어댑터 내부에서 발생한 복구 불가 에러."""


@dataclass
class RawAnnouncement:
    """어댑터 출력 스키마. DB 컬럼과 거의 1:1."""

    external_id: str
    title: str
    agency: str | None = None
    department: str | None = None
    business_type: str | None = None
    category: str | None = None
    region: str | None = None
    posted_at: date | None = None
    deadline_at: datetime | None = None
    budget_amount: int | None = None
    currency: str = "KRW"
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    detail_url: str | None = None
    attachment_urls: list[str] | None = None
    summary: str | None = None
    raw_payload: dict | None = field(default=None)

    def compute_hash(self) -> str:
        """변경 감지용. title + deadline + budget + summary 에 기반."""
        payload = {
            "title": self.title,
            "agency": self.agency,
            "deadline_at": self.deadline_at.isoformat() if self.deadline_at else None,
            "budget_amount": self.budget_amount,
            "summary": self.summary,
        }
        blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def to_dict(self) -> dict:
        return asdict(self)


class AnnouncementAdapter(ABC):
    """모든 수집 어댑터의 부모. ``fetch`` 만 구현하면 된다."""

    # 소스 코드 (announcement_sources.code 와 일치).
    code: str = ""
    # 사용자 표시용 이름.
    name: str = ""
    # API key 필요 여부. 없으면 runner 가 SKIPPED 로 건너뛴다.
    requires_api_key: bool = False

    def __init__(self, *, api_key: str = "", config: dict | None = None) -> None:
        self.api_key = api_key
        self.config = config or {}

    @abstractmethod
    async def fetch(self, since: date) -> list[RawAnnouncement]:
        """`since` 이후 게시된 공고 수집. 정확한 filter 는 어댑터 자유.

        구현은 네트워크 예외를 자체 로깅 후 비거나 필요 시
        `AnnouncementFetchError` 로 raise.
        """
