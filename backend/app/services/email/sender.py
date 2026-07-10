"""SMTP 발송 — aiosmtplib + Sent 폴더 APPEND + 공유함 신원 표기(설계 §4).

공유 메일함에서 보낼 때:
- From   = 공유 계정 주소(대외 표기)
- Sender = 실제 발신자(RFC 5322 "on behalf of")
- X-Orbit-Sent-By = 발신자 user_id (내부 감사)
- email_outbox.user_id 에 발신자 기록(목록의 '보낸 사람')
"""

from __future__ import annotations

import base64
import logging
import re
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, formataddr, make_msgid

from app.models import EmailAccount, EmailOutbox, User
from app.services.email_html_import import inline_for_email
from app.services.email.adapters.imap import ImapAdapter
from app.services.email.base import AccountConn
from app.services.email.secrets import get_account_secrets
from app.services.storage import resolve_upload_path

logger = logging.getLogger(__name__)

# 본문 HTML 의 base64 data URI 이미지. Gmail 등은 data: 이미지를 차단하므로
# 발송 시 cid: 참조 + inline 파트(multipart/related)로 변환해야 보인다.
_IMG_DATA_RE = re.compile(
    r"""src=(["'])data:(image/[A-Za-z0-9.+-]+);base64,([^"']+)\1""",
    re.IGNORECASE,
)


def _extract_inline_images(html: str):
    """body_html 의 data:image 들을 cid 참조로 치환하고 (새 html, [(cid, maintype,
    subtype, bytes)]) 반환. 디코드 실패한 항목은 원본 그대로 둔다."""
    images: list[tuple[str, str, str, bytes]] = []

    def repl(m: re.Match) -> str:
        quote, ctype, b64 = m.group(1), m.group(2), m.group(3)
        try:
            data = base64.b64decode(b64)
        except Exception:
            return m.group(0)
        cid = make_msgid()[1:-1]  # <...> → ...
        maintype, _, subtype = ctype.partition("/")
        images.append((cid, maintype or "image", subtype or "png", data))
        return f"src={quote}cid:{cid}{quote}"

    return _IMG_DATA_RE.sub(repl, html), images


def _build_mime(
    account: EmailAccount,
    outbox: EmailOutbox,
    sender_user: User,
    in_reply_to_msgid: str | None,
) -> EmailMessage:
    msg = EmailMessage()
    msg["Message-ID"] = make_msgid()
    # Date 헤더 — 없으면 Sent 폴더 사본을 재동기화할 때 imap-tools 가 날짜를
    # 1900-01-01 로 파싱한다(라이브러리 기본값). 발송 시각을 명시한다.
    msg["Date"] = format_datetime(datetime.now(timezone.utc))
    msg["From"] = formataddr((account.display_name or "", account.email_addr))
    # 공유함: 실제 발신자를 Sender + 커스텀 헤더로 남긴다.
    if account.kind == "SHARED" and sender_user is not None:
        if sender_user.email:
            msg["Sender"] = formataddr((sender_user.name or "", sender_user.email))
        msg["X-Orbit-Sent-By"] = str(sender_user.id)
    msg["Reply-To"] = account.email_addr
    msg["To"] = ", ".join(outbox.to_addrs)
    if outbox.cc_addrs:
        msg["Cc"] = ", ".join(outbox.cc_addrs)
    if outbox.subject:
        msg["Subject"] = outbox.subject
    if in_reply_to_msgid:
        msg["In-Reply-To"] = in_reply_to_msgid
        msg["References"] = in_reply_to_msgid

    msg.set_content(outbox.body_text or "")
    if outbox.body_html:
        # 편집기 CSS(class 기반)는 메일 클라이언트에서 무시되므로 element 단위
        # inline style 로 펼친다 — 특히 table 테두리/패딩(class 로만 그려져 Gmail 에서
        # 표가 안 보이던 문제). 그 뒤 data:image → cid 변환.
        html, inline_imgs = _extract_inline_images(inline_for_email(outbox.body_html))
        msg.add_alternative(html, subtype="html")
        if inline_imgs:
            # html 파트(마지막 alternative)에 cid 이미지를 related 로 묶는다.
            html_part = msg.get_payload()[-1]
            for cid, maintype, subtype, data in inline_imgs:
                html_part.add_related(
                    data, maintype=maintype, subtype=subtype, cid=f"<{cid}>"
                )

    for att in outbox.attachments or []:
        path = att.get("file_path")
        if not path:
            continue
        try:
            data = resolve_upload_path(path).read_bytes()
        except OSError as exc:  # pragma: no cover
            logger.warning("첨부 파일 읽기 실패 [%s]: %s", path, exc)
            continue
        ctype = att.get("content_type") or "application/octet-stream"
        maintype, _, subtype = ctype.partition("/")
        msg.add_attachment(
            data,
            maintype=maintype or "application",
            subtype=subtype or "octet-stream",
            filename=att.get("filename", "attachment"),
        )
    return msg


async def send_outbox(
    db,
    outbox: EmailOutbox,
    account: EmailAccount,
    sender_user: User,
    *,
    in_reply_to_msgid: str | None = None,
) -> None:
    """발송 + Sent APPEND + status=SENT. 실패는 호출자가 잡아 FAILED 처리."""
    import aiosmtplib

    if not account.smtp_host:
        raise ValueError("SMTP 호스트가 설정되지 않았습니다")

    secrets = await get_account_secrets(db, account.tenant_id, account.id)
    smtp_pw = secrets.get("smtp_password") or secrets.get("password")
    if not smtp_pw:
        raise ValueError("SMTP 비밀번호가 설정되지 않았습니다")

    msg = _build_mime(account, outbox, sender_user, in_reply_to_msgid)
    recipients = (
        list(outbox.to_addrs)
        + list(outbox.cc_addrs or [])
        + list(outbox.bcc_addrs or [])
    )
    sec = (account.smtp_security or "STARTTLS").upper()
    await aiosmtplib.send(
        msg,
        hostname=account.smtp_host,
        port=account.smtp_port or 587,
        username=account.smtp_username or account.username,
        password=smtp_pw,
        start_tls=(sec == "STARTTLS"),
        use_tls=(sec == "SSL"),
        recipients=recipients,
    )

    # Sent 폴더에 사본 보관 — 실패해도 발송은 성공이므로 경고만.
    try:
        adapter = ImapAdapter(
            AccountConn(
                host=account.host,
                port=account.port,
                security=account.security,
                username=account.username,
                password=secrets.get("password", ""),
            )
        )
        await adapter.connect()
        await adapter.append(
            account.sent_folder or "Sent", msg.as_bytes(), {"\\Seen"}
        )
        await adapter.close()
    except Exception as exc:  # pragma: no cover
        logger.warning("Sent APPEND 실패(메일은 발송됨) [%s]: %s", account.id, exc)

    outbox.status = "SENT"
    outbox.sent_at = datetime.now(timezone.utc)
    logger.info(
        "메일 발송 완료 [account=%s outbox=%s] 수신자 %d명",
        account.id,
        outbox.id,
        len(recipients),
    )
