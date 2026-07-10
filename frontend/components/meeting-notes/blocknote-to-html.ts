/**
 * 레거시 회의록 본문(BlockNote JSON) → TipTap 호환 HTML 변환기 (best-effort).
 *
 * 회의록 편집기를 BlockNote → TipTap(HTML) 으로 교체하면서, 이미 BlockNote JSON
 * 으로 저장된 기존 본문을 로드 시 HTML 로 변환해 그대로 보여주기 위한 일회성
 * 변환 로직. 사용자가 편집·저장하면 HTML 로 영구 전환된다.
 *
 * 지원: paragraph / heading / bullet·numbered·check list / quote / codeBlock /
 * table / image / divider + 인라인 스타일(bold·italic·underline·strike·code·
 * color·bg) + link + 정렬(textAlignment). 복잡한 중첩/커스텀 블록은 근사 처리.
 */

type AnyBlock = any;

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

// BlockNote 색상 키 → CSS 색. default 는 무시.
const TEXT_COLOR: Record<string, string> = {
  gray: "#6b7280",
  brown: "#92400e",
  red: "#dc2626",
  orange: "#ea580c",
  yellow: "#ca8a04",
  green: "#16a34a",
  blue: "#2563eb",
  purple: "#9333ea",
  pink: "#db2777",
};
const BG_COLOR: Record<string, string> = {
  gray: "#f3f4f6",
  brown: "#f5ede6",
  red: "#fee2e2",
  orange: "#ffedd5",
  yellow: "#fef9c3",
  green: "#dcfce7",
  blue: "#dbeafe",
  purple: "#f3e8ff",
  pink: "#fce7f3",
};

// 인라인 콘텐츠(텍스트/링크 노드 배열 또는 문자열) → HTML.
function inlineToHtml(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return escapeHtml(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((node: any) => {
      if (!node) return "";
      if (node.type === "link") {
        const href = escapeHtml(node.href ?? "#");
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inlineToHtml(
          node.content,
        )}</a>`;
      }
      let text = escapeHtml(node.text ?? "");
      const st = node.styles ?? {};
      if (st.code) text = `<code>${text}</code>`;
      if (st.bold) text = `<strong>${text}</strong>`;
      if (st.italic) text = `<em>${text}</em>`;
      if (st.underline) text = `<u>${text}</u>`;
      if (st.strike) text = `<s>${text}</s>`;
      const styleParts: string[] = [];
      if (st.textColor && st.textColor !== "default") {
        styleParts.push(`color:${TEXT_COLOR[st.textColor] ?? st.textColor}`);
      }
      if (st.backgroundColor && st.backgroundColor !== "default") {
        styleParts.push(
          `background-color:${BG_COLOR[st.backgroundColor] ?? st.backgroundColor}`,
        );
      }
      if (styleParts.length) {
        text = `<span style="${styleParts.join(";")}">${text}</span>`;
      }
      return text;
    })
    .join("");
}

function alignAttr(props: any): string {
  const a = props?.textAlignment;
  return a && a !== "left" ? ` style="text-align:${escapeHtml(a)}"` : "";
}

function tableToHtml(content: any): string {
  const rows = content?.rows ?? [];
  const body = rows
    .map((row: any) => {
      const cells = (row?.cells ?? [])
        .map((cell: any) => {
          let inner: any;
          let props: any = {};
          if (cell && cell.type === "tableCell") {
            inner = cell.content;
            props = cell.props ?? {};
          } else {
            inner = cell;
          }
          const cs =
            props.colspan && props.colspan > 1 ? ` colspan="${props.colspan}"` : "";
          const rs =
            props.rowspan && props.rowspan > 1 ? ` rowspan="${props.rowspan}"` : "";
          return `<td${cs}${rs}>${inlineToHtml(inner)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="tiptap-table"><tbody>${body}</tbody></table>`;
}

function blockToHtml(block: AnyBlock): string {
  const type = block?.type;
  const props = block?.props ?? {};
  const inner = inlineToHtml(block?.content);
  const childrenHtml =
    Array.isArray(block?.children) && block.children.length
      ? blocksToHtml(block.children)
      : "";

  switch (type) {
    case "heading": {
      const lvl = Math.min(3, Math.max(1, Number(props.level ?? 1)));
      return `<h${lvl}${alignAttr(props)}>${inner}</h${lvl}>${childrenHtml}`;
    }
    case "quote":
      return `<blockquote${alignAttr(props)}>${inner}</blockquote>${childrenHtml}`;
    case "codeBlock": {
      const lang = props.language
        ? ` class="language-${escapeHtml(props.language)}"`
        : "";
      const raw = Array.isArray(block.content)
        ? block.content
            .map((n: any) => (typeof n === "string" ? n : (n?.text ?? "")))
            .join("")
        : "";
      return `<pre><code${lang}>${escapeHtml(raw)}</code></pre>`;
    }
    case "image": {
      const src = props.url ? escapeHtml(props.url) : "";
      if (!src) return "";
      const alt = escapeHtml(props.caption ?? props.name ?? "");
      return `<img src="${src}" alt="${alt}" class="max-w-full rounded" />`;
    }
    case "table":
      return tableToHtml(block.content);
    case "divider":
    case "horizontalRule":
      return "<hr />";
    case "checkListItem": {
      const checked = props.checked ? "true" : "false";
      return `<li data-type="taskItem" data-checked="${checked}">${inner}${childrenHtml}</li>`;
    }
    case "bulletListItem":
    case "numberedListItem":
      return `<li${alignAttr(props)}>${inner}${childrenHtml}</li>`;
    case "paragraph":
    default:
      return `<p${alignAttr(props)}>${inner}</p>${childrenHtml}`;
  }
}

// 연속된 같은 종류의 list item 을 하나의 <ul>/<ol> 로 묶는다.
const LIST_TAG: Record<string, string> = {
  bulletListItem: "ul",
  numberedListItem: "ol",
  checkListItem: "ul",
};

export function blocksToHtml(blocks: AnyBlock[]): string {
  if (!Array.isArray(blocks)) return "";
  let html = "";
  let i = 0;
  while (i < blocks.length) {
    const t = blocks[i]?.type;
    if (t === "bulletListItem" || t === "numberedListItem" || t === "checkListItem") {
      const tag = LIST_TAG[t];
      const attr = t === "checkListItem" ? ' data-type="taskList"' : "";
      let group = "";
      while (i < blocks.length && blocks[i]?.type === t) {
        group += blockToHtml(blocks[i]);
        i++;
      }
      html += `<${tag}${attr}>${group}</${tag}>`;
      continue;
    }
    html += blockToHtml(blocks[i]);
    i++;
  }
  return html;
}

/** BlockNote 블록 배열 → HTML 문자열. 비었으면 빈 문자열. */
export function blockNoteJsonToHtml(blocks: AnyBlock[]): string {
  return blocksToHtml(blocks) || "";
}
