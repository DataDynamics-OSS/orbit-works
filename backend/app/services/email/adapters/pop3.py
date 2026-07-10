"""POP3 어댑터 — 레거시 서버용 단방향 수집(설계 §1).

POP3 는 폴더·플래그·증분동기화(UIDVALIDITY) 개념이 없다. 단일 INBOX 만 다루고,
양방향(플래그/이동/발송보관)·플래그증분·EXPUNGE 는 미지원(NotImplementedError →
runner 가 skip). 메시지 번호(msgnum)를 `imap_uid`, `uid_validity=1` 로 매핑하고
`since_uid` 초과분만 받는다(삭제 없는 보관 용도 가정 — msgnum 안정).

⚠️ poplib 은 블로킹 → anyio.to_thread 로 감싼다.
"""

from __future__ import annotations

import logging

import anyio

from app.services.email.base import (
    AccountConn,
    EmailAdapter,
    EmailFetchError,
    FolderState,
    RawAttachment,
    RawEmail,
)
from app.services.email.eml import parse_raw

logger = logging.getLogger(__name__)

# POP3 는 단일 폴더 — uid_validity 고정.
_POP3_UIDVALIDITY = 1


class Pop3Adapter(EmailAdapter):
    protocol = "POP3"
    supports_bidirectional = False

    def __init__(self, conn: AccountConn) -> None:
        super().__init__(conn)
        self._client = None  # poplib.POP3 / POP3_SSL

    def _connect_sync(self):
        import poplib

        c = self.conn
        try:
            if c.security == "SSL":
                cli = poplib.POP3_SSL(c.host, port=c.port or 995, timeout=30)
            else:
                cli = poplib.POP3(c.host, port=c.port or 110, timeout=30)
                if c.security == "STARTTLS":
                    cli.stls()
            cli.user(c.username)
            cli.pass_(c.password)
        except Exception as exc:
            raise EmailFetchError(f"POP3 접속/인증 실패: {exc}") from exc
        return cli

    def _count_sync(self) -> int:
        count, _size = self._client.stat()
        return int(count)

    def _fetch_new_sync(self, since_uid: int, limit: int) -> list[RawEmail]:
        cli = self._client
        count = self._count_sync()
        out: list[RawEmail] = []
        # msgnum 은 1..count. since_uid 초과분만, 오름차순으로 limit 까지.
        start = max(1, since_uid + 1)
        for msgnum in range(start, count + 1):
            if len(out) >= limit:
                break
            try:
                _resp, lines, _octets = cli.retr(msgnum)
            except Exception as exc:  # pragma: no cover
                logger.warning("POP3 RETR 실패 [msg=%d]: %s", msgnum, exc)
                continue
            raw = b"\r\n".join(lines)
            fields = parse_raw(raw)
            atts = [
                RawAttachment(
                    filename=a["filename"],
                    content_type=a.get("content_type"),
                    content_id=a.get("content_id"),
                    is_inline=a.get("is_inline", False),
                    size_bytes=a.get("size_bytes"),
                )
                for a in fields["attachments"]
            ]
            snippet = None
            if fields["body_text"]:
                snippet = " ".join(fields["body_text"].split())[:500]
            out.append(
                RawEmail(
                    imap_uid=msgnum,
                    uid_validity=_POP3_UIDVALIDITY,
                    message_id=fields["message_id"],
                    subject=fields["subject"] or None,
                    from_addr=fields["from_addr"],
                    from_name=fields["from_name"],
                    to_addrs=fields["to_addrs"],
                    cc_addrs=fields["cc_addrs"],
                    sent_at=fields["sent_at"],
                    received_at=fields["sent_at"],
                    flags=set(),
                    body_text=fields["body_text"],
                    body_html=fields["body_html"],
                    snippet=snippet,
                    has_attachments=fields["has_attachments"],
                    size_bytes=len(raw),
                    attachments=atts,
                    raw_bytes=raw,
                )
            )
        return out

    def _close_sync(self) -> None:
        if self._client is not None:
            try:
                self._client.quit()
            except Exception:  # pragma: no cover
                pass
            self._client = None

    async def connect(self) -> None:
        self._client = await anyio.to_thread.run_sync(self._connect_sync)

    async def list_folders(self) -> list[FolderState]:
        if self._client is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        count = await anyio.to_thread.run_sync(self._count_sync)
        return [
            FolderState(
                name="INBOX",
                raw_name="INBOX",
                role="INBOX",
                uid_validity=_POP3_UIDVALIDITY,
                uid_next=count + 1,
                total=count,
                unseen=0,
            )
        ]

    async def fetch_new(
        self, folder_raw_name: str, *, since_uid: int, limit: int
    ) -> list[RawEmail]:
        if self._client is None:
            raise EmailFetchError("connect() 먼저 호출해야 합니다")
        try:
            return await anyio.to_thread.run_sync(
                self._fetch_new_sync, since_uid, limit
            )
        except EmailFetchError:
            raise
        except Exception as exc:
            raise EmailFetchError(f"POP3 fetch 실패: {exc}") from exc

    async def close(self) -> None:
        await anyio.to_thread.run_sync(self._close_sync)
