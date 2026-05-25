import base64
import binascii
import logging
import re
import secrets
import ssl
from email.message import EmailMessage
from uuid import UUID

from app.core.config import MailConfig, get_settings, get_tenant_section

logger = logging.getLogger(__name__)


_DATA_URI_IMG_RE = re.compile(
    r'src=(?P<q>["\'])data:(?P<mime>image/[A-Za-z0-9.+-]+);base64,(?P<data>[^"\']+)(?P=q)',
    re.IGNORECASE,
)


def _extract_data_uri_images(
    body: str,
    existing_inline_images: list[tuple[str, bytes, str]] | None,
) -> tuple[str, list[tuple[str, bytes, str]]]:
    """본문 안 `<img src="data:image/...;base64,...">` 를 cid: 참조로 치환.

    Gmail 등은 본문 102KB 초과 시 메시지를 잘라(clip) 잘린 부분이 raw HTML 처럼
    보이는 사고가 잦다. 큰 base64 이미지는 본문 밖 multipart/related part 로
    빼는 게 표준. 추출된 (cid, bytes, mime) 튜플은 inline_images 리스트에 append.
    """
    images = list(existing_inline_images or [])
    if "data:image/" not in body:
        return body, images

    def repl(m: re.Match[str]) -> str:
        mime = m.group("mime")
        b64 = m.group("data")
        # base64 안의 공백/줄바꿈 정리 (메일 클라이언트가 줄을 끊어둔 경우).
        b64_clean = re.sub(r"\s+", "", b64)
        try:
            content = base64.b64decode(b64_clean, validate=False)
        except (binascii.Error, ValueError):
            return m.group(0)  # 디코드 실패면 원본 유지
        cid = f"embed-{secrets.token_hex(6)}"
        images.append((cid, content, mime))
        return f'src="cid:{cid}"'

    new_body = _DATA_URI_IMG_RE.sub(repl, body)
    delta = len(images) - len(existing_inline_images or [])
    if delta:
        logger.info(
            "본문 data URL 이미지 %d 개를 cid 인라인 첨부로 변환 (본문 %d → %d bytes)",
            delta, len(body), len(new_body),
        )
    return new_body, images


def _strip_html(html: str) -> str:
    """HTML → 거친 plain text. multipart/alternative 의 fallback 용 — 정밀한
    렌더링은 필요 없고 검색·색인·접근성 정도. 태그 제거 + 공백 정리."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>|</div>|</li>|</h[1-6]>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


class MailService:
    """Async SMTP mail sender — tenant 별 `mail:` 섹션 기반.

    Settings UI 가 `app_settings.section='mail'` 에 tenant 별로 저장하므로
    발송 시 `send_for_tenant(tenant_id, ...)` 를 사용하면 그 tenant 의 SMTP
    자격증명이 적용된다. tenant_id None 이면 글로벌 `config.yaml` fallback.

    `mail.enabled` 가 false 이거나 sender 자격증명이 없으면 send 는 False 를
    반환할 뿐 예외를 던지지 않는다 — SMTP 미설정 환경에서도 앱이 계속 동작.
    """

    def __init__(self) -> None:
        # 매 호출마다 설정을 다시 읽어 UI 변경 즉시 반영.
        pass

    async def _resolve_cfg(self, tenant_id: UUID | str | None) -> MailConfig:
        if tenant_id is None:
            return get_settings().mail
        try:
            raw = await get_tenant_section(tenant_id, "mail")
            return MailConfig.model_validate(raw)
        except Exception as exc:
            logger.warning(
                "mail: tenant=%s 설정 파싱 실패 — 글로벌 fallback 으로: %s",
                tenant_id, exc,
            )
            return get_settings().mail

    def _recipients(self, cfg: MailConfig, to: list[str] | None) -> list[str]:
        recipients = list(to or [])
        if not recipients:
            recipients = list(cfg.default_recipients)
        return [r for r in recipients if r]

    async def send(
        self,
        subject: str,
        body: str,
        to: list[str] | None = None,
        html: bool = False,
        attachments: list[tuple[str, bytes, str]] | None = None,
        inline_images: list[tuple[str, bytes, str]] | None = None,
    ) -> bool:
        """글로벌 `config.yaml` 의 mail 설정으로 발송 — tenant 모름·결정 불가한
        호출자(시스템 cron 의 글로벌 알림 등) 전용. tenant 가 명확하면
        `send_for_tenant(...)` 를 쓸 것.
        """
        return await self._dispatch(
            get_settings().mail, subject, body, to, html, attachments, inline_images,
        )

    async def send_for_tenant(
        self,
        tenant_id: UUID | str | None,
        subject: str,
        body: str,
        to: list[str] | None = None,
        html: bool = False,
        attachments: list[tuple[str, bytes, str]] | None = None,
        inline_images: list[tuple[str, bytes, str]] | None = None,
    ) -> bool:
        """tenant 별 SMTP 설정으로 발송. tenant_id None 이면 `send` 와 동일.

        `inline_images`: [(content_id, bytes, mime), ...] — 본문 HTML 의
        `<img src="cid:{content_id}">` 와 매칭되는 자산. multipart/related part
        에 Content-ID 헤더로 들어가 이메일 자체에 임베드된다 (외부 URL 차단
        환경에서도 표시).
        """
        cfg = await self._resolve_cfg(tenant_id)
        return await self._dispatch(cfg, subject, body, to, html, attachments, inline_images)

    async def _dispatch(
        self,
        cfg: MailConfig,
        subject: str,
        body: str,
        to: list[str] | None,
        html: bool,
        attachments: list[tuple[str, bytes, str]] | None,
        inline_images: list[tuple[str, bytes, str]] | None = None,
    ) -> bool:
        """attachments: [(filename, content_bytes, mime_type), ...]. 생략 가능."""
        if not cfg.enabled:
            logger.info("Mail disabled; skipping send (subject=%r)", subject)
            return False
        if not cfg.sender.email or not cfg.sender.app_password:
            logger.warning("Mail sender not configured; skipping send")
            return False

        recipients = self._recipients(cfg, to)
        if not recipients:
            logger.warning("No recipients; skipping send (subject=%r)", subject)
            return False

        msg = EmailMessage()
        msg["From"] = f"{cfg.sender.name} <{cfg.sender.email}>"
        msg["To"] = ", ".join(recipients)
        prefix = cfg.notifications.subject_prefix.strip()
        msg["Subject"] = f"{prefix} {subject}" if prefix else subject
        if html:
            # 본문 안의 data URL 이미지를 cid: 참조 + multipart/related part 로
            # 변환 — Gmail 등의 102KB 본문 clipping 회피 + 일부 클라이언트의
            # data URL 차단 회피.
            body, inline_images = _extract_data_uri_images(body, inline_images)
            # multipart/alternative — plain fallback 먼저 + html 대안.
            # 일부 메일 서버/클라이언트가 단일 html part 를 plain 으로 해석해 본문
            # 이 <img>·<p> 같은 raw HTML 로 보이는 케이스 회피.
            plain_fallback = _strip_html(body) or "HTML 본문은 메일 클라이언트의 HTML 보기에서 확인하세요."
            msg.set_content(plain_fallback, subtype="plain")
            msg.add_alternative(body, subtype="html")
            # cid 인라인 이미지는 html part 안에 multipart/related 로 묶여야
            # 메일 클라이언트가 src="cid:..." 와 매칭한다. 메인 메시지가 아니라
            # html part 에 add_related 호출.
            html_part = msg.get_body(preferencelist=("html",))
            for cid, content, mime in inline_images or []:
                maintype, _, subtype = mime.partition("/")
                if not subtype:
                    maintype, subtype = "application", "octet-stream"
                html_part.add_related(
                    content,
                    maintype=maintype,
                    subtype=subtype,
                    cid=f"<{cid}>",
                )
        else:
            msg.set_content(body, subtype="plain")
        for att in attachments or []:
            filename, content, mime = att
            maintype, _, subtype = mime.partition("/")
            if not subtype:
                maintype, subtype = "application", "octet-stream"
            msg.add_attachment(
                content, maintype=maintype, subtype=subtype, filename=filename
            )

        try:
            import aiosmtplib
        except ImportError:
            logger.warning(
                "aiosmtplib 미설치 — pip install -r requirements.txt 필요. "
                "메일 발송 스킵.",
            )
            return False

        try:
            await aiosmtplib.send(
                msg,
                hostname=cfg.smtp.host,
                port=cfg.smtp.port,
                username=cfg.sender.email,
                password=cfg.sender.app_password,
                start_tls=cfg.smtp.use_tls and not cfg.smtp.use_ssl,
                use_tls=cfg.smtp.use_ssl,
                timeout=cfg.smtp.timeout_seconds,
                tls_context=ssl.create_default_context() if cfg.smtp.use_ssl else None,
            )
            return True
        except Exception as exc:
            logger.warning("Failed to send mail: %s", exc, exc_info=True)
            return False


mail_service = MailService()
