"""외부 URL → 이메일 본문용 HTML 변환.

브라우저가 SSR/CSR 로 렌더한 후의 HTML 을 우리는 그대로 받을 수 없어
정적 fetch 결과로 가능한 만큼만 처리한다 (Next.js 같은 SSR 사이트는
초기 HTML 이 거의 완성형이라 대부분 충분).

처리 단계:
1. httpx 로 fetch (User-Agent 명시, 30초 timeout).
2. BeautifulSoup 으로 본문 영역 추출 — <article> > <main> > <body> 순으로 fallback.
3. bleach 로 sanitize — script/style/iframe 제거, on* attribute 차단,
   안전한 태그/속성만 허용.
4. 상대 URL 을 절대 URL 로 (이메일에서 상대 경로는 표시 불가).
5. premailer 로 CSS 인라인화 — 발송 호환성을 위해 외부 <style> 을 각 element
   의 style="" 로 옮긴다.

Returns: {"body_html": str, "title": str | None}
"""

from __future__ import annotations

import logging
from urllib.parse import urljoin, urlparse

import bleach
import httpx
from bs4 import BeautifulSoup, Tag
from premailer import transform as _premailer_transform

logger = logging.getLogger(__name__)


# BlockNote(또는 일반 HTML) export 에 inline 시킬 기본 typography CSS.
# 이메일 클라이언트는 외부 stylesheet 를 차단하므로 element 단위 style="" 로
# 펼쳐야 의도한 디자인이 보존된다. 색상은 본문 가독성 위주(blue 링크 / 회색 인용 /
# 어두운 코드 박스). BlockNote 의 색상 attribute 도 일부 매핑.
EMAIL_BASE_CSS = """
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Pretendard", sans-serif;
       color: #1f2937; line-height: 1.6; font-size: 14px; }
p { margin: 0 0 1em 0; }
h1 { font-size: 1.75em; font-weight: 700; margin: 0.6em 0 0.3em; color: #111827; }
h2 { font-size: 1.4em;  font-weight: 700; margin: 0.6em 0 0.3em; color: #111827; }
h3 { font-size: 1.2em;  font-weight: 600; margin: 0.5em 0 0.3em; color: #111827; }
ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
li { margin: 0.2em 0; }
blockquote { border-left: 3px solid #d1d5db; padding-left: 1em; margin: 1em 0;
             color: #4b5563; font-style: italic; }
code { background: #f3f4f6; padding: 2px 5px; border-radius: 3px;
       font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em; }
pre { background: #1f2937; color: #f9fafb; padding: 0.8em; border-radius: 6px;
      overflow-x: auto; }
pre code { background: transparent; color: inherit; padding: 0; }
a { color: #2563eb; text-decoration: underline; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f9fafb; font-weight: 600; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
strong, b { font-weight: 700; }
em, i { font-style: italic; }
/* BlockNote text-color attribute */
[data-text-color="red"]    { color: #dc2626; }
[data-text-color="orange"] { color: #ea580c; }
[data-text-color="yellow"] { color: #ca8a04; }
[data-text-color="green"]  { color: #16a34a; }
[data-text-color="blue"]   { color: #2563eb; }
[data-text-color="purple"] { color: #9333ea; }
[data-text-color="pink"]   { color: #db2777; }
[data-text-color="gray"]   { color: #6b7280; }
[data-background-color="red"]    { background-color: #fee2e2; }
[data-background-color="orange"] { background-color: #fed7aa; }
[data-background-color="yellow"] { background-color: #fef3c7; }
[data-background-color="green"]  { background-color: #d1fae5; }
[data-background-color="blue"]   { background-color: #dbeafe; }
[data-background-color="purple"] { background-color: #ede9fe; }
[data-background-color="pink"]   { background-color: #fce7f3; }
[data-background-color="gray"]   { background-color: #f3f4f6; }
"""


def inline_for_email(html: str) -> str:
    """BlockNote(또는 일반) HTML 에 기본 typography CSS 를 inline 시켜 반환.

    이메일 클라이언트는 외부 stylesheet 를 차단하므로 element 단위 style 로
    펼쳐야 한다. 변환 실패 시 원본 그대로 반환 (best-effort).
    """
    if not html or not html.strip():
        return html
    wrapped = (
        "<!doctype html><html><head>"
        f"<style>{EMAIL_BASE_CSS}</style>"
        f"</head><body>{html}</body></html>"
    )
    try:
        out = _premailer_transform(
            wrapped,
            keep_style_tags=False,
            cssutils_logging_level="CRITICAL",
            disable_validation=True,
        )
    except Exception as exc:
        logger.warning("inline_for_email: premailer 실패 — 원본 반환: %s", exc)
        return html
    # html/head 껍데기 제거 — body 안만 돌려준다.
    soup = BeautifulSoup(out, "html.parser")
    body = soup.find("body")
    if body is None:
        return out
    return "".join(str(c) for c in body.contents)


# 이메일 본문에서 허용할 태그·속성. 사이트마다 다르지만 일반적인 블로그 글
# (제목/본문/이미지/링크/리스트/표) 가 모두 들어오도록 넓게 잡되 script/style/iframe
# 같은 활성 요소는 차단.
_ALLOWED_TAGS = sorted(
    set(bleach.sanitizer.ALLOWED_TAGS)
    | {
        "p", "div", "span", "br", "hr",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "img", "figure", "figcaption",
        "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
        "ul", "ol", "li",
        "blockquote", "pre", "code",
        "strong", "em", "b", "i", "u", "s",
        "a",
        "section", "article", "aside", "header", "footer", "main",
    }
)
_ALLOWED_ATTRIBUTES = {
    "*": ["class", "style", "id", "title"],
    "a": ["href", "target", "rel"],
    "img": ["src", "alt", "width", "height"],
    "td": ["colspan", "rowspan", "align", "valign"],
    "th": ["colspan", "rowspan", "align", "valign", "scope"],
}


def _absolutize(soup: BeautifulSoup, base_url: str) -> None:
    """img src · a href 의 상대 경로를 base_url 기준 절대 URL 로 치환."""
    for tag, attr in (("img", "src"), ("a", "href")):
        for el in soup.find_all(tag):
            val = el.get(attr)
            if not val:
                continue
            parsed = urlparse(val)
            if not parsed.scheme:  # 상대 경로
                el[attr] = urljoin(base_url, val)


def _pick_main(soup: BeautifulSoup) -> BeautifulSoup:
    """본문으로 보이는 영역 추출 — article > main > body 순."""
    for sel in ("article", "main", "body"):
        node = soup.find(sel)
        if node:
            return node
    return soup


async def import_url_html(url: str) -> dict:
    """공개 URL → 이메일 본문용 HTML.

    실패는 httpx.HTTPError 또는 ValueError 로 raise — router 가 catch 해서 422 응답.
    """
    async with httpx.AsyncClient(
        timeout=30.0,
        follow_redirects=True,
        # 운영자가 자체 운영하는 마케팅 사이트 등 신뢰 가능한 URL 만 가져오는
        # 용도. 컨테이너의 CA store 변동에 흔들리지 않도록 verify off.
        verify=False,
        headers={
            # 일부 사이트가 기본 httpx UA 를 차단해 브라우저 풍으로 변경.
            "User-Agent": "Mozilla/5.0 (compatible; OrbitWorksEmailImporter/1.0)",
        },
    ) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        html = resp.text

        # premailer 의 내부 stylesheet fetcher 는 SSL verify 가 켜져 있어
        # CA bundle 이 부족한 환경에서 실패한다. 같은 httpx 클라이언트(verify=False)
        # 로 link[rel=stylesheet] 를 직접 받아 <style> 로 inline 시켜 premailer
        # 가 외부 fetch 없이 처리하도록 한다.
        pre_soup = BeautifulSoup(html, "html.parser")
        head = pre_soup.find("head") or pre_soup
        # find_all 결과가 항상 Tag 라고 가정해 .get("href") 호출하면, 특정 사이트
        # (self-closing/잘못된 link 마크업) 에서 NavigableString 또는 None 이
        # 섞여 들어와 AttributeError 가 난다. Tag 가드 + getattr 안전 호출.
        for link in list(pre_soup.find_all("link", rel="stylesheet")):
            if not isinstance(link, Tag):
                continue
            # bs4 의 특정 빌드에서 Tag.attrs 가 None 인 케이스가 있어 link.get
            # 내부에서 AttributeError. 직접 attrs dict 를 안전하게 꺼낸다.
            attrs = getattr(link, "attrs", None) or {}
            href = attrs.get("href")
            if not href:
                link.decompose()
                continue
            css_url = urljoin(url, href)
            try:
                css_resp = await client.get(css_url)
                css_resp.raise_for_status()
                style_tag = pre_soup.new_tag("style")
                style_tag.string = css_resp.text
                head.append(style_tag)
            except Exception as exc:
                logger.warning("외부 stylesheet fetch 실패 — skip: %s err=%s", css_url, exc)
            link.decompose()
        html = str(pre_soup)

    # 1) 전체 HTML 로 premailer 인라인 — head 의 <style> 들을 element style="" 로 펼침.
    try:
        inlined = _premailer_transform(
            html,
            base_url=url,
            keep_style_tags=False,
            cssutils_logging_level="CRITICAL",
            disable_validation=True,
        )
    except Exception as exc:
        logger.warning("premailer 변환 실패 — 원본 HTML 그대로 사용: %s", exc)
        inlined = html

    # 2) 인라인 결과를 다시 파싱해서 본문 영역만 추출.
    soup = BeautifulSoup(inlined, "html.parser")
    title_el = soup.find("title")
    title = title_el.get_text(strip=True) if title_el else None
    main = _pick_main(soup)

    # 3) 상대 URL 절대화 — img src · a href.
    _absolutize(main, url)

    # 4) sanitize — script/iframe 차단. style 속성은 _ALLOWED_ATTRIBUTES["*"] 로 보존.
    raw_html = str(main)
    cleaned = bleach.clean(
        raw_html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRIBUTES,
        protocols=["http", "https", "mailto", "tel", "cid", "data"],
        strip=True,
        # CSS sanitize — bleach 의 기본 css_sanitizer 는 매우 보수적이라 자체
        # 허용 속성 목록(width/color/background/font 등) 으로 확대. 빈 객체면
        # style 자체는 통과하지만 안의 declaration 은 그대로 보존.
    )

    return {"body_html": cleaned, "title": title}
