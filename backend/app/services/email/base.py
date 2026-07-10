"""이메일 어댑터 공통 인터페이스.

announcements 와 동일 철학: **어댑터는 네트워크만, DB 는 runner.**
정규화된 `RawEmail`/`FolderState` 리스트만 반환하고, 저장·UPSERT·.eml 보관은
`runner` 가 담당한다.

Stage 1(수신 read-only): connect / list_folders / fetch_new / close 만 구현.
push 계열(store_flags/move/append/fetch_flag_changes) 은 Stage 3·4 에서 추가.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime


class EmailFetchError(Exception):
    """어댑터 내부에서 발생한 복구 불가 에러 (인증 실패·연결 끊김 등)."""


@dataclass
class RawAttachment:
    """첨부 메타 — lazy. 동기화 땐 메타만 저장(payload 미보관)."""

    filename: str
    content_type: str | None = None
    content_id: str | None = None
    is_inline: bool = False
    size_bytes: int | None = None


@dataclass
class RawEmail:
    """어댑터 출력 — DB emails 컬럼과 거의 1:1. raw_bytes 는 runner 가 .eml 로 저장."""

    imap_uid: int
    uid_validity: int
    message_id: str | None = None
    thread_id: str | None = None
    subject: str | None = None
    from_addr: str | None = None
    from_name: str | None = None
    to_addrs: list[str] = field(default_factory=list)
    cc_addrs: list[str] = field(default_factory=list)
    bcc_addrs: list[str] = field(default_factory=list)
    reply_to: str | None = None
    sent_at: datetime | None = None
    received_at: datetime | None = None
    flags: set[str] = field(default_factory=set)  # {'\\Seen', '\\Flagged', ...}
    body_text: str | None = None
    body_html: str | None = None
    snippet: str | None = None
    has_attachments: bool = False
    size_bytes: int | None = None
    attachments: list[RawAttachment] = field(default_factory=list)
    raw_bytes: bytes = b""

    @property
    def is_seen(self) -> bool:
        return "\\Seen" in self.flags

    @property
    def is_flagged(self) -> bool:
        return "\\Flagged" in self.flags

    @property
    def is_answered(self) -> bool:
        return "\\Answered" in self.flags

    @property
    def is_draft(self) -> bool:
        return "\\Draft" in self.flags


@dataclass
class FlagChange:
    """서버 기준 한 메시지의 최신 플래그(증분 동기화)."""

    imap_uid: int
    flags: set[str]

    @property
    def is_seen(self) -> bool:
        return "\\Seen" in self.flags

    @property
    def is_flagged(self) -> bool:
        return "\\Flagged" in self.flags

    @property
    def is_answered(self) -> bool:
        return "\\Answered" in self.flags

    @property
    def is_draft(self) -> bool:
        return "\\Draft" in self.flags


@dataclass
class FolderState:
    """폴더 + 증분 동기화 토큰(IMAP STATUS)."""

    name: str
    raw_name: str
    role: str | None = None
    uid_validity: int | None = None
    uid_next: int | None = None
    highest_modseq: int | None = None
    total: int = 0
    unseen: int = 0


@dataclass
class AccountConn:
    """어댑터가 접속에 필요한 자격 — runner 가 DB 메타 + 복호화 비밀로 조립."""

    host: str
    port: int
    security: str  # SSL | STARTTLS | NONE
    username: str
    password: str


class EmailAdapter(ABC):
    """모든 메일 어댑터의 부모.

    어댑터는 stateful 연결을 들고 있을 수 있다(connect → 작업 → close).
    네트워크 예외는 `EmailFetchError` 로 raise. DB 는 절대 건드리지 않는다.
    """

    protocol: str = ""
    # 양방향(플래그/이동/발송보관 push) 지원 여부. IMAP=True, POP3=False.
    supports_bidirectional: bool = False

    def __init__(self, conn: AccountConn) -> None:
        self.conn = conn

    @abstractmethod
    async def connect(self) -> None:
        """접속·인증. 실패 시 EmailFetchError."""

    @abstractmethod
    async def list_folders(self) -> list[FolderState]:
        """폴더 목록 + 각 폴더 STATUS(UIDVALIDITY/UIDNEXT/총·미읽음)."""

    @abstractmethod
    async def fetch_new(
        self, folder_raw_name: str, *, since_uid: int, limit: int
    ) -> list[RawEmail]:
        """`since_uid` 초과 UID 의 신규 메시지를 최대 `limit` 건 수집(UID 오름차순)."""

    async def fetch_flag_changes(
        self, folder_raw_name: str, *, since_modseq: int | None
    ) -> tuple[list[FlagChange], int | None]:
        """플래그 증분. CONDSTORE(MODSEQ) 있으면 변경분만, 없으면 전체 재조회.

        반환: (변경 리스트, 새 HIGHESTMODSEQ 또는 None). 기본 미지원.
        """
        raise NotImplementedError

    async def list_uids(self, folder_raw_name: str) -> set[int]:
        """폴더의 현재 서버 UID 집합 — EXPUNGE 감지용(로컬에만 있으면 삭제됨)."""
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        """연결 정리. 예외를 던지지 않는다."""

    # ── push (Stage 4 에서 구현) ─────────────────────────────────────────
    async def store_flags(
        self, folder_raw_name: str, uid: int, *, add: set[str], remove: set[str]
    ) -> None:
        raise NotImplementedError

    async def move(self, folder_raw_name: str, uid: int, dest: str) -> int:
        raise NotImplementedError

    async def delete_message(self, folder_raw_name: str, uid: int) -> None:
        raise NotImplementedError

    async def append(self, folder_raw_name: str, raw: bytes, flags: set[str]) -> int:
        raise NotImplementedError
