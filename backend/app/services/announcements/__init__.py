"""사업공고 수집 서비스.

구성:
- `base.RawAnnouncement`          — 어댑터 공통 출력 dataclass.
- `base.AnnouncementAdapter`      — 어댑터 ABC.
- `registry.ADAPTERS`             — code → adapter class 매핑.
- `runner.run_all` / `run_one`    — 소스 전체/단일 실행 + run 기록.

스케줄러에서 `runner.run_all(trigger_kind='SCHEDULED')` 호출.
"""

from app.services.announcements.base import (
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)
from app.services.announcements.registry import ADAPTERS
from app.services.announcements.runner import run_all, run_one

__all__ = [
    "AnnouncementAdapter",
    "AnnouncementFetchError",
    "RawAnnouncement",
    "ADAPTERS",
    "run_all",
    "run_one",
]
