"""IMAP 어댑터 — `imap-tools` 를 threadpool 로 감싼다.

⚠️ `imaplib`(imap-tools 의 기반) 은 동기 블로킹이므로 async 루프를 막지 않도록
모든 네트워크 작업을 `anyio.to_thread.run_sync` 로 실행한다(설계 §11 A안).

imap-tools 는 lazy import — 라이브러리 미설치 환경에서도 모듈 import 는 되고,
실제 연결 시점에만 ImportError → EmailFetchError 로 변환한다.

Stage 1: connect / list_folders / fetch_new / close. push 계열은 Stage 4.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

import anyio

from app.services.email.base import (
    AccountConn,
    EmailAdapter,
    EmailFetchError,
    FlagChange,
    FolderState,
    RawAttachment,
    RawEmail,
)

_RE_UID = re.compile(rb"UID (\d+)")
_RE_FLAGS = re.compile(rb"FLAGS \(([^)]*)\)")
_RE_MODSEQ = re.compile(rb"MODSEQ \((\d+)\)")

logger = logging.getLogger(__name__)

# 서버 폴더 flag → 우리 role 매핑(특수목적 폴더 식별, RFC 6154 SPECIAL-USE).
_ROLE_BY_FLAG = {
    "\\Sent": "SENT",
    "\\Archive": "ARCHIVE",
    "\\Trash": "TRASH",
    "\\Drafts": "DRAFTS",
    "\\Junk": "JUNK",
}


def _to_addr_list(value) -> list[str]:
    """imap-tools 의 from_/to/cc (tuple[str]) → list[str]."""
    if not value:
        return []
    return [a for a in value if a]


class ImapAdapter(EmailAdapter):
    protocol = "IMAP"
    supports_bidirectional = True

    def __init__(self, conn: AccountConn) -> None:
        super().__init__(conn)
        self._mailbox = None  # imap_tools.MailBox (동기 객체 — thread 안에서만 접근)

    # ── 동기 헬퍼 (thread 안에서 실행) ────────────────────────────────────

    def _connect_sync(self):
        try:
            from imap_tools import (
                MailBox,
                MailBoxStartTls as MailBoxTls,
                MailBoxUnencrypted,
            )
        except ImportError as exc:  # pragma: no cover
            raise EmailFetchError(
                "imap-tools 미설치 — requirements 설치 필요"
            ) from exc

        c = self.conn
        try:
            if c.security == "STARTTLS":
                box = MailBoxTls(c.host, port=c.port)
            elif c.security == "NONE":
                box = MailBoxUnencrypted(c.host, port=c.port)
            else:  # SSL (기본)
                box = MailBox(c.host, port=c.port)
            box.login(c.username, c.password)
        except Exception as exc:
            raise EmailFetchError(f"IMAP 접속/인증 실패: {exc}") from exc
        return box

    def _list_folders_sync(self) -> list[FolderState]:
        box = self._mailbox
        out: list[FolderState] = []
        for fi in box.folder.list():
            role = None
            flags = {f for f in (fi.flags or ())}
            for flag, r in _ROLE_BY_FLAG.items():
                if flag in flags:
                    role = r
                    break
            if role is None and fi.name.upper() in ("INBOX",):
                role = "INBOX"
            st = {}
            try:
                st = box.folder.status(
                    fi.name, ("MESSAGES", "UIDNEXT", "UIDVALIDITY", "UNSEEN")
                )
            except Exception as exc:  # 일부 폴더는 STATUS 실패 — 건너뜀
                logger.debug("folder STATUS 실패 [%s]: %s", fi.name, exc)
            out.append(
                FolderState(
                    name=fi.name,
                    raw_name=fi.name,
                    role=role,
                    uid_validity=int(st["UIDVALIDITY"]) if st.get("UIDVALIDITY") else None,
                    uid_next=int(st["UIDNEXT"]) if st.get("UIDNEXT") else None,
                    total=int(st.get("MESSAGES", 0) or 0),
                    unseen=int(st.get("UNSEEN", 0) or 0),
                )
            )
        return out

    def _fetch_new_sync(
        self, folder_raw_name: str, since_uid: int, limit: int
    ) -> list[RawEmail]:
        from imap_tools import AND

        box = self._mailbox
        box.folder.set(folder_raw_name)
        # since_uid 초과 UID 만. IMAP UID range 는 'N:*' (N 포함이므로 +1).
        start = since_uid + 1
        uids = box.uids(AND(uid=f"{start}:*"))
        # 'N:*' 는 N 이 마지막보다 크면 마지막 1건을 돌려주는 IMAP 특성 → 재필터.
        uids = sorted({int(u) for u in uids if int(u) >= start})
        if not uids:
            return []
        uids = uids[:limit]
        out: list[RawEmail] = []
        for msg in box.fetch(
            AND(uid=",".join(str(u) for u in uids)),
            mark_seen=False,
            bulk=True,
        ):
            out.append(self._to_raw(msg))
        return out

    @staticmethod
    def _to_raw(msg) -> RawEmail:
        atts = [
            RawAttachment(
                filename=a.filename or "attachment",
                content_type=a.content_type,
                content_id=(a.content_id or None),
                is_inline=bool(getattr(a, "content_disposition", "") == "inline"),
                size_bytes=(len(a.payload) if a.payload is not None else a.size),
            )
            for a in (msg.attachments or [])
        ]
        try:
            raw_bytes = msg.obj.as_bytes()
        except Exception:  # pragma: no cover
            raw_bytes = b""
        # imap-tools 는 Date 헤더가 없거나 파싱 불가하면 datetime(1900,1,1) 을
        # 돌려준다. 잘못된 날짜로 저장하지 않도록 sentinel(1970 이전) 은 None 처리.
        date_val: datetime | None = msg.date
        if date_val is not None and date_val.year < 1970:
            date_val = None
        text = msg.text or None
        snippet = None
        if text:
            snippet = " ".join(text.split())[:500]
        return RawEmail(
            imap_uid=int(msg.uid) if msg.uid else 0,
            uid_validity=0,  # runner 가 폴더 STATUS 의 uid_validity 로 채움
            message_id=(msg.obj.get("Message-ID") or None),
            subject=msg.subject or None,
            from_addr=(msg.from_ or None),
            from_name=(msg.from_values.name if msg.from_values else None),
            to_addrs=_to_addr_list(msg.to),
            cc_addrs=_to_addr_list(msg.cc),
            bcc_addrs=_to_addr_list(msg.bcc),
            reply_to=(msg.reply_to[0] if msg.reply_to else None),
            sent_at=date_val,
            received_at=date_val,
            flags=set(msg.flags or ()),
            body_text=text,
            body_html=(msg.html or None),
            snippet=snippet,
            has_attachments=bool(atts),
            size_bytes=(len(raw_bytes) if raw_bytes else None),
            attachments=atts,
            raw_bytes=raw_bytes,
        )

    def _fetch_flag_changes_sync(
        self, folder_raw_name: str, since_modseq: int | None
    ) -> tuple[list[FlagChange], int | None]:
        box = self._mailbox
        box.folder.set(folder_raw_name)
        cli = box.client  # imaplib.IMAP4
        caps = " ".join(
            (c.decode() if isinstance(c, bytes) else str(c)) for c in cli.capabilities
        ).upper()
        has_condstore = "CONDSTORE" in caps
        if has_condstore and since_modseq:
            typ, data = cli.uid(
                "FETCH", "1:*", f"(FLAGS) (CHANGEDSINCE {int(since_modseq)})"
            )
        else:
            typ, data = cli.uid("FETCH", "1:*", "(FLAGS)")
        if typ != "OK":
            return [], since_modseq

        changes: list[FlagChange] = []
        max_modseq = since_modseq or 0
        for raw in data or []:
            line = raw if isinstance(raw, (bytes, bytearray)) else None
            if not line:
                continue
            m_uid = _RE_UID.search(line)
            m_flags = _RE_FLAGS.search(line)
            if not m_uid or m_flags is None:
                continue
            flags_str = m_flags.group(1).decode(errors="replace").strip()
            flags = set(flags_str.split()) if flags_str else set()
            changes.append(FlagChange(imap_uid=int(m_uid.group(1)), flags=flags))
            m_modseq = _RE_MODSEQ.search(line)
            if m_modseq:
                max_modseq = max(max_modseq, int(m_modseq.group(1)))
        return changes, (max_modseq or None)

    def _list_uids_sync(self, folder_raw_name: str) -> set[int]:
        box = self._mailbox
        box.folder.set(folder_raw_name)
        return {int(u) for u in box.uids()}

    # ── push (양방향) ────────────────────────────────────────────────────

    def _store_flags_sync(
        self, folder_raw_name: str, uid: int, add: set[str], remove: set[str]
    ) -> None:
        box = self._mailbox
        box.folder.set(folder_raw_name)
        if add:
            box.flag([str(uid)], list(add), True)
        if remove:
            box.flag([str(uid)], list(remove), False)

    def _move_sync(self, folder_raw_name: str, uid: int, dest: str) -> None:
        box = self._mailbox
        box.folder.set(folder_raw_name)
        try:
            if not box.folder.exists(dest):
                box.folder.create(dest)
        except Exception as exc:  # 생성 실패는 move 시점에서 다시 드러난다
            logger.debug("폴더 생성 시도 실패 [%s]: %s", dest, exc)
        box.move([str(uid)], dest)

    def _delete_sync(self, folder_raw_name: str, uid: int) -> None:
        box = self._mailbox
        box.folder.set(folder_raw_name)
        box.delete([str(uid)])

    async def store_flags(
        self, folder_raw_name: str, uid: int, *, add: set[str], remove: set[str]
    ) -> None:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            await anyio.to_thread.run_sync(
                self._store_flags_sync, folder_raw_name, uid, add, remove
            )
        except Exception as exc:
            raise EmailFetchError(f"IMAP STORE 실패 [uid={uid}]: {exc}") from exc

    async def move(self, folder_raw_name: str, uid: int, dest: str) -> int:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            await anyio.to_thread.run_sync(self._move_sync, folder_raw_name, uid, dest)
        except Exception as exc:
            raise EmailFetchError(f"IMAP MOVE 실패 [uid={uid}→{dest}]: {exc}") from exc
        return 0  # 새 UID 는 다음 PULL 에서 반영

    async def delete_message(self, folder_raw_name: str, uid: int) -> None:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            await anyio.to_thread.run_sync(self._delete_sync, folder_raw_name, uid)
        except Exception as exc:
            raise EmailFetchError(f"IMAP DELETE 실패 [uid={uid}]: {exc}") from exc

    def _append_sync(self, folder_raw_name: str, raw: bytes, flags: set[str]) -> None:
        box = self._mailbox
        try:
            if not box.folder.exists(folder_raw_name):
                box.folder.create(folder_raw_name)
        except Exception as exc:
            logger.debug("APPEND 대상 폴더 생성 시도 실패 [%s]: %s", folder_raw_name, exc)
        box.append(raw, folder_raw_name, dt=None, flag_set=list(flags) if flags else None)

    async def append(self, folder_raw_name: str, raw: bytes, flags: set[str]) -> int:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            await anyio.to_thread.run_sync(
                self._append_sync, folder_raw_name, raw, flags
            )
        except Exception as exc:
            raise EmailFetchError(f"IMAP APPEND 실패 [{folder_raw_name}]: {exc}") from exc
        return 0

    def _close_sync(self) -> None:
        if self._mailbox is not None:
            try:
                self._mailbox.logout()
            except Exception:  # pragma: no cover
                pass
            self._mailbox = None

    # ── async 인터페이스 ─────────────────────────────────────────────────

    async def connect(self) -> None:
        self._mailbox = await anyio.to_thread.run_sync(self._connect_sync)

    async def list_folders(self) -> list[FolderState]:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        return await anyio.to_thread.run_sync(self._list_folders_sync)

    async def fetch_new(
        self, folder_raw_name: str, *, since_uid: int, limit: int
    ) -> list[RawEmail]:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            return await anyio.to_thread.run_sync(
                self._fetch_new_sync, folder_raw_name, since_uid, limit
            )
        except EmailFetchError:
            raise
        except Exception as exc:
            raise EmailFetchError(f"IMAP fetch 실패 [{folder_raw_name}]: {exc}") from exc

    async def fetch_flag_changes(
        self, folder_raw_name: str, *, since_modseq: int | None
    ) -> tuple[list[FlagChange], int | None]:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            return await anyio.to_thread.run_sync(
                self._fetch_flag_changes_sync, folder_raw_name, since_modseq
            )
        except Exception as exc:
            raise EmailFetchError(
                f"IMAP 플래그 동기화 실패 [{folder_raw_name}]: {exc}"
            ) from exc

    async def list_uids(self, folder_raw_name: str) -> set[int]:
        if self._mailbox is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            return await anyio.to_thread.run_sync(self._list_uids_sync, folder_raw_name)
        except Exception as exc:
            raise EmailFetchError(
                f"IMAP UID 목록 조회 실패 [{folder_raw_name}]: {exc}"
            ) from exc

    async def close(self) -> None:
        await anyio.to_thread.run_sync(self._close_sync)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
