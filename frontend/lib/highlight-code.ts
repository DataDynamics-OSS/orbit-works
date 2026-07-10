/**
 * 저장된 본문 HTML 의 코드 블록(`<pre><code class="language-xx">`)에 문법 강조를
 * 입히는 유틸. 편집기(TipTap+lowlight)는 렌더 시점 decoration 으로 강조하지만 그
 * 색은 저장 HTML 에 남지 않으므로, 읽기전용 뷰어·PDF·이메일에서는 여기서 다시
 * highlight.js 로 강조한다.
 *
 * - 언어가 명시(`language-xx`)되고 highlight.js 에 등록된 경우에만 강조한다
 *   (편집기 동작과 일치 — 언어 미지정이면 강조하지 않음). 잘못된 auto-detect 방지.
 * - highlight.js/lib/common = 약 37개 주요 언어 (full 번들보다 가벼움).
 */

import hljs from "highlight.js/lib/common";

function langFromClass(el: Element): string | undefined {
  const m = el.className.match(/(?:language|lang)-([\w-]+)/i);
  return m?.[1];
}

function highlightValue(code: string, lang: string): string {
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

/**
 * DOM 기반(읽기전용 뷰어·PDF) — 컨테이너 안 `<pre><code>` 를 제자리 강조.
 * 토큰 색은 주변 CSS(`.tiptap-content pre .hljs-*` 또는 PDF `<style>`)가 입힌다.
 */
export function highlightCodeBlocksInDom(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("pre code").forEach((el) => {
    const lang = langFromClass(el);
    if (!lang || !hljs.getLanguage(lang)) return; // 언어 미지정 → 강조 안 함.
    try {
      el.innerHTML = highlightValue(el.textContent ?? "", lang);
      el.classList.add("hljs");
    } catch {
      /* 무시 */
    }
  });
}

// 이메일용 인라인 스타일 — 외부 CSS/클래스가 적용 안 되므로 토큰 색을 직접 박는다.
// atom-one-dark 계열 (어두운 코드블록 배경 #0f172a 위 가독성).
const TOKEN_INLINE: Record<string, string> = {
  "hljs-comment": "color:#7f848e;font-style:italic",
  "hljs-quote": "color:#7f848e;font-style:italic",
  "hljs-keyword": "color:#c678dd",
  "hljs-doctag": "color:#c678dd",
  "hljs-formula": "color:#c678dd",
  "hljs-section": "color:#e06c75",
  "hljs-name": "color:#e06c75",
  "hljs-selector-tag": "color:#e06c75",
  "hljs-deletion": "color:#e06c75",
  "hljs-subst": "color:#e06c75",
  "hljs-literal": "color:#56b6c2",
  "hljs-string": "color:#98c379",
  "hljs-regexp": "color:#98c379",
  "hljs-addition": "color:#98c379",
  "hljs-attribute": "color:#98c379",
  "hljs-attr": "color:#d19a66",
  "hljs-variable": "color:#d19a66",
  "hljs-template-variable": "color:#d19a66",
  "hljs-type": "color:#d19a66",
  "hljs-selector-class": "color:#d19a66",
  "hljs-selector-attr": "color:#d19a66",
  "hljs-selector-pseudo": "color:#d19a66",
  "hljs-number": "color:#d19a66",
  "hljs-symbol": "color:#61afef",
  "hljs-bullet": "color:#61afef",
  "hljs-link": "color:#61afef;text-decoration:underline",
  "hljs-meta": "color:#61afef",
  "hljs-selector-id": "color:#61afef",
  "hljs-title": "color:#61afef",
  "hljs-built_in": "color:#e5c07b",
  "hljs-class": "color:#e5c07b",
  "hljs-emphasis": "font-style:italic",
  "hljs-strong": "font-weight:700",
};

const PRE_INLINE =
  "background:#0f172a;color:#f1f5f9;padding:12px 14px;border-radius:6px;" +
  "overflow-x:auto;font-family:'D2Coding',ui-monospace,Menlo,Consolas,monospace;" +
  "font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;";
const CODE_INLINE = "background:transparent;color:inherit;padding:0;font-family:inherit;";

// hljs 출력의 `<span class="hljs-xxx">` 를 인라인 style span 으로 치환.
function classSpansToInline(value: string): string {
  return value.replace(/<span class="([^"]+)">/g, (_m, cls: string) => {
    const key = cls.split(/\s+/).find((c) => TOKEN_INLINE[c]);
    return key ? `<span style="${TOKEN_INLINE[key]}">` : "<span>";
  });
}

/**
 * 이메일용(문자열) — body HTML 의 코드 블록을 강조 + 인라인 스타일로 굽는다.
 * 이메일 클라이언트는 JS 미실행 + 외부 CSS/클래스 제거 가능성이 있어, 다크 배경과
 * 토큰 색을 모두 인라인 style 로 넣는다. 언어 미지정 코드도 다크 배경은 입힌다.
 */
export function highlightHtmlForEmail(html: string): string {
  if (!html || typeof window === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pres = doc.querySelectorAll("pre");
  if (pres.length === 0) return html; // 코드 블록 없으면 원본 그대로.
  pres.forEach((pre) => {
    const code = pre.querySelector("code");
    if (code) {
      const lang = langFromClass(code);
      if (lang && hljs.getLanguage(lang)) {
        try {
          code.innerHTML = classSpansToInline(
            highlightValue(code.textContent ?? "", lang),
          );
        } catch {
          /* 강조 실패 시 원문 유지 */
        }
      }
      code.setAttribute("style", CODE_INLINE);
    }
    pre.setAttribute("style", PRE_INLINE);
  });
  return doc.body.innerHTML;
}
