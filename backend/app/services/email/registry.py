"""프로토콜 코드 → 어댑터 클래스 매핑. announcements.registry 와 동일 패턴."""

from __future__ import annotations

from app.services.email.adapters.imap import ImapAdapter
from app.services.email.adapters.pop3 import Pop3Adapter
from app.services.email.base import EmailAdapter

ADAPTERS: dict[str, type[EmailAdapter]] = {
    "IMAP": ImapAdapter,
    "POP3": Pop3Adapter,
}
