"""보관된 RFC822 `.eml` 에서 첨부를 lazy 추출.

설계 §7: 동기화 때 첨부를 미리 풀지 않고, 열람 시 보관된 .eml 을 파싱해 해당
파트를 꺼낸다(서버 재접속 불필요). 한 번 꺼내면 디스크에 캐시(email_attachments.file_path).
"""

from __future__ import annotations

from datetime import datetime
from email import message_from_bytes
from email.header import decode_header
from email.message import Message
from email.utils import getaddresses, parseaddr, parsedate_to_datetime


def decode_mime_header(value: str | None) -> str:
    """`=?UTF-8?B?...?=` / EUC-KR 등 인코딩된 헤더를 사람이 읽는 문자열로."""
    if not value:
        return ""
    out: list[str] = []
    for raw, enc in decode_header(value):
        if isinstance(raw, bytes):
            try:
                out.append(raw.decode(enc or "utf-8", errors="replace"))
            except (LookupError, UnicodeDecodeError):
                out.append(raw.decode("utf-8", errors="replace"))
        else:
            out.append(raw)
    return "".join(out)


def _iter_attachment_parts(msg: Message):
    """첨부(또는 inline 파일) 파트만 순회."""
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get_content_disposition() or "").lower()
        filename = part.get_filename()
        if disp in ("attachment", "inline") or filename:
            yield part


def _decode_part_text(part: Message) -> str:
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return payload.decode("utf-8", errors="replace")


def parse_raw(raw_bytes: bytes) -> dict:
    """RFC822 raw → 정규화 필드 dict (POP3 등 stdlib 파싱용).

    반환: subject/from_addr/from_name/to_addrs/cc_addrs/sent_at/message_id/
    body_text/body_html/has_attachments/attachments(list[dict]).
    """
    msg = message_from_bytes(raw_bytes)
    from_name, from_addr = parseaddr(msg.get("From", ""))
    to_addrs = [a for _, a in getaddresses(msg.get_all("To", []) or []) if a]
    cc_addrs = [a for _, a in getaddresses(msg.get_all("Cc", []) or []) if a]
    sent_at: datetime | None = None
    if msg.get("Date"):
        try:
            sent_at = parsedate_to_datetime(msg.get("Date"))
        except (TypeError, ValueError):
            sent_at = None

    body_text: str | None = None
    body_html: str | None = None
    attachments: list[dict] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue
            disp = (part.get_content_disposition() or "").lower()
            ctype = part.get_content_type()
            fname = part.get_filename()
            if disp in ("attachment", "inline") or fname:
                payload = part.get_payload(decode=True) or b""
                attachments.append(
                    {
                        "filename": decode_mime_header(fname) or "attachment",
                        "content_type": ctype,
                        "content_id": (part.get("Content-ID") or None),
                        "is_inline": disp == "inline",
                        "size_bytes": len(payload),
                    }
                )
            elif ctype == "text/plain" and body_text is None:
                body_text = _decode_part_text(part)
            elif ctype == "text/html" and body_html is None:
                body_html = _decode_part_text(part)
    else:
        if msg.get_content_type() == "text/html":
            body_html = _decode_part_text(msg)
        else:
            body_text = _decode_part_text(msg)

    return {
        "subject": decode_mime_header(msg.get("Subject")),
        "from_addr": from_addr or None,
        "from_name": decode_mime_header(from_name) or None,
        "to_addrs": to_addrs,
        "cc_addrs": cc_addrs,
        "sent_at": sent_at,
        "message_id": (msg.get("Message-ID") or None),
        "body_text": body_text,
        "body_html": body_html,
        "has_attachments": bool(attachments),
        "attachments": attachments,
    }


def extract_attachment(
    raw_bytes: bytes, *, filename: str | None, content_id: str | None
) -> tuple[bytes, str] | None:
    """매칭되는 첨부의 (payload, content_type) 반환. 못 찾으면 None.

    매칭 우선순위: Content-ID 정확 일치 → 디코드된 파일명 일치.
    """
    msg = message_from_bytes(raw_bytes)
    target_cid = (content_id or "").strip().strip("<>")

    fallback = None  # 파일명 일치 후보(없으면 None)
    for part in _iter_attachment_parts(msg):
        cid = (part.get("Content-ID") or "").strip().strip("<>")
        part_name = decode_mime_header(part.get_filename())
        if target_cid and cid and cid == target_cid:
            payload = part.get_payload(decode=True) or b""
            return payload, (part.get_content_type() or "application/octet-stream")
        if filename and part_name == filename and fallback is None:
            fallback = (
                part.get_payload(decode=True) or b"",
                part.get_content_type() or "application/octet-stream",
            )
    return fallback
