"""회의록 이메일 발송 — 본문 HTML sanitize + 메일 템플릿 조립.

흐름:
1. 클라이언트가 BlockNote 의 `editor.blocksToHTMLLossy(blocks)` 결과를 함께 전송.
2. 이 모듈이 화이트리스트 기반 bleach 로 sanitize 후 메일 본문 HTML 에 삽입.
3. `mail_service.send_for_tenant(...)` 로 발송.

권한 / 수신자 / 사용 흐름은 호출하는 API 가 책임진다 (이 모듈은 sanitize +
HTML 조립 + 발송만).
"""

import logging
from html import escape

import bleach

from app.services.mail import mail_service

logger = logging.getLogger(__name__)


# BlockNote export 가 사용하는 태그/속성을 화이트리스트로 명시.
# 위험한 태그 (script, iframe, style 등) 는 자동 제거.
_ALLOWED_TAGS = {
    # 블록
    "p", "div", "span", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    # 인라인 스타일
    "strong", "b", "em", "i", "u", "s", "small", "sub", "sup",
    # 테이블
    "table", "thead", "tbody", "tr", "th", "td",
    # 링크 & 이미지
    "a", "img",
}

_ALLOWED_ATTRS = {
    "*": ["class", "style"],
    "a": ["href", "title", "target", "rel"],
    "img": ["src", "alt", "title", "width", "height"],
    "td": ["colspan", "rowspan", "align"],
    "th": ["colspan", "rowspan", "align"],
}

# style 속성에 허용할 CSS 속성 — 색·정렬·일부 폰트만.
_ALLOWED_CSS_PROPS = {
    "color", "background-color", "background",
    "text-align", "font-weight", "font-style", "text-decoration",
    "padding", "margin",
    "border", "border-color", "border-width", "border-style",
    "width", "height",
}


def sanitize_body_html(html: str) -> str:
    """클라이언트가 보낸 BlockNote HTML 을 안전하게 정리.

    - 화이트리스트 외 태그/속성 제거
    - data: src 는 이미지에 한해 허용 (BlockNote 가 paste 이미지를 base64
      로 임베드하는 케이스). javascript: 등 위험 스킴은 차단.
    """
    if not html:
        return ""
    cleaner = bleach.Cleaner(
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        protocols=["http", "https", "mailto", "tel", "data"],
        strip=True,
        strip_comments=True,
        css_sanitizer=bleach.css_sanitizer.CSSSanitizer(
            allowed_css_properties=list(_ALLOWED_CSS_PROPS)
        ) if hasattr(bleach, "css_sanitizer") else None,
    )
    return cleaner.clean(html)


def build_email_html(
    *,
    title: str,
    sender_name: str,
    author_name: str,
    customer_name: str | None,
    project_name: str | None,
    created_at_iso: str,
    note_url: str,
    custom_message: str | None,
    body_html_safe: str,
) -> str:
    """회의록 메일 본문 HTML 조립.

    상단에 메타 (제목/작성자/일시/고객사/프로젝트) → 링크 → custom_message →
    회의록 본문. 단순 inline-style 만 사용 (메일 클라이언트 호환).
    """
    meta_rows = [
        ("제목", escape(title)),
        ("작성자", escape(author_name)),
        ("일시", escape(created_at_iso)),
    ]
    if customer_name:
        meta_rows.append(("고객사", escape(customer_name)))
    if project_name:
        meta_rows.append(("프로젝트", escape(project_name)))

    meta_html = "".join(
        f'<tr><td style="padding:4px 12px 4px 0;color:#71717a;width:80px">{k}</td>'
        f'<td style="padding:4px 0">{v}</td></tr>'
        for k, v in meta_rows
    )

    custom_block = ""
    if custom_message and custom_message.strip():
        # 줄바꿈 보존
        msg_html = escape(custom_message).replace("\n", "<br>")
        custom_block = f"""
<div style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #3b82f6;border-radius:4px">
  <div style="font-size:11px;color:#71717a;margin-bottom:4px">{escape(sender_name)} 님의 메시지</div>
  <div style="font-size:14px;color:#0f172a">{msg_html}</div>
</div>
""".strip()

    return f"""<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,'Segoe UI',Pretendard,sans-serif;color:#0f172a">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;padding:24px">
    <div style="font-size:11px;color:#71717a;margin-bottom:8px">📝 회의록 공유</div>
    <h1 style="font-size:20px;margin:0 0 16px 0">{escape(title)}</h1>

    <table cellspacing="0" cellpadding="0" style="font-size:13px;border-collapse:collapse;margin-bottom:16px">{meta_html}</table>

    <a href="{escape(note_url)}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:500">▶ 회의록 보기</a>

    {custom_block}

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">

    <div style="font-size:11px;color:#71717a;margin-bottom:8px">--- 회의록 내용 ---</div>
    <div style="font-size:14px;line-height:1.6">{body_html_safe or '<i style="color:#94a3b8">(본문 비어있음)</i>'}</div>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
    <div style="font-size:11px;color:#94a3b8">
      이 메일은 <a href="{escape(note_url)}" style="color:#94a3b8">{escape(note_url)}</a> 에서 보낸 자동 발송 메일입니다.
    </div>
  </div>
</body>
</html>"""


def build_notify_text(
    *,
    title: str,
    sender_name: str,
    author_name: str,
    customer_name: str | None,
    project_name: str | None,
    created_at_iso: str,
    note_url: str,
    body_plain: str,
    custom_message: str | None,
) -> str:
    """Slack/Mattermost DM 본문 — 이메일 본문과 동일한 구성.

    구조:
      📝 *[회의록]* "제목"
      • 제목     ...
      • 작성자   ...
      • 일시     ...
      • 고객사   ...   (있을 때만)
      • 프로젝트 ...   (있을 때만)

      ▶ 회의록 보기: <url>

      > 발신자 님의 메시지        (custom_message 있을 때만)
      > ...

      --- 회의록 내용 ---
      (본문 plain_text 1500자까지)

    Slack / Mattermost 둘 다 위 markdown(*bold*, > blockquote) 을 지원한다.
    """
    excerpt = (body_plain or "").strip()
    # DM 길이 폭주 방지 — 1500자에서 자르고 ellipsis.
    if len(excerpt) > 1500:
        excerpt = excerpt[:1500].rstrip() + "…"

    parts: list[str] = [f'📝 *[회의록]* "{title}"', ""]

    meta_lines = [
        f"• 제목: {title}",
        f"• 작성자: {author_name}",
    ]
    if created_at_iso:
        meta_lines.append(f"• 일시: {created_at_iso}")
    if customer_name:
        meta_lines.append(f"• 고객사: {customer_name}")
    if project_name:
        meta_lines.append(f"• 프로젝트: {project_name}")
    parts.extend(meta_lines)

    parts.append("")
    parts.append(f"▶ 회의록 보기: {note_url}")

    if custom_message and custom_message.strip():
        parts.append("")
        parts.append(f"> *{sender_name} 님의 메시지*")
        for line in custom_message.strip().splitlines():
            parts.append(f"> {line}" if line else ">")

    if excerpt:
        parts.append("")
        parts.append("--- 회의록 내용 ---")
        parts.append(excerpt)

    return "\n".join(parts)


async def send_meeting_note_email(
    *,
    tenant_id,
    title: str,
    sender_name: str,
    author_name: str,
    customer_name: str | None,
    project_name: str | None,
    created_at_iso: str,
    note_url: str,
    custom_message: str | None,
    body_html_raw: str,
    recipient_emails: list[str],
) -> bool:
    """이메일 1통을 모든 수신자에게 발송 (BCC 가 아니라 To 다중)."""
    if not recipient_emails:
        logger.warning("회의록 이메일 — 수신자 0명, skip (title=%r)", title)
        return False
    raw_len = len(body_html_raw or "")
    safe_html = sanitize_body_html(body_html_raw)
    safe_len = len(safe_html)
    if raw_len and not safe_len:
        # 화이트리스트가 모두 제거한 경우 — sanitize 가 너무 공격적이거나 입력이
        # 손상된 케이스. 본문이 전부 사라지지만 발송 자체는 진행 (메타·링크는 살아남음).
        logger.warning(
            "회의록 이메일 — bleach sanitize 후 본문 0byte (raw=%d). "
            "BlockNote export 결과를 확인하세요.", raw_len,
        )
    full_html = build_email_html(
        title=title,
        sender_name=sender_name,
        author_name=author_name,
        customer_name=customer_name,
        project_name=project_name,
        created_at_iso=created_at_iso,
        note_url=note_url,
        custom_message=custom_message,
        body_html_safe=safe_html,
    )
    subject = f'[회의록] "{title}"'
    logger.info(
        "회의록 이메일 발송 시도: subject=%r recipients=%d body_html=%d→%dbyte",
        subject, len(recipient_emails), raw_len, safe_len,
    )
    ok = await mail_service.send_for_tenant(
        tenant_id, subject, full_html, to=recipient_emails, html=True
    )
    if not ok:
        logger.warning(
            "회의록 이메일 SMTP 실패 — Mail 비활성/자격증명 미설정/SMTP 연결 실패. "
            "subject=%r", subject,
        )
    return ok
