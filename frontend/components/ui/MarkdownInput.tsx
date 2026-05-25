"use client";

/**
 * 공용 마크다운 에디터 + 렌더러.
 *
 * 게시판(PostEditor) 과 코멘트(CommentsBlock) 가 공유. 풀 사이즈(`size="lg"`,
 * 게시판) / 컴팩트(`size="sm"`, 코멘트) 두 모드 지원.
 *
 * 기능:
 *  - 작성/미리보기 토글
 *  - 마크다운 툴바 (헤딩 H1·H2·H3 / 굵게·기울임·인라인코드 / 목록·인용 / 링크·코드블록·테이블·구분선)
 *  - `react-markdown` + `remark-gfm` + `remark-breaks` 로 렌더 (GFM 테이블·체크리스트 + 단일 \n 하드 브레이크)
 *
 * `MarkdownInput` 은 controlled — 부모가 value/onChange. preview 상태만 내부 관리.
 */

import { useRef, useState } from "react";
import {
  Bold,
  Code,
  Code2,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Pencil,
  Quote,
  Table,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypePrism from "rehype-prism-plus";
import { Tooltip } from "@/components/ui/Tooltip";

type Size = "sm" | "lg";

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  /** 'lg' (게시판) — text-sm font-mono. 'sm' (코멘트) — text-sm 일반체. */
  size?: Size;
  /** 글자수 카운터 표시 여부 (게시판: true, 코멘트: false). */
  showCounter?: boolean;
  /** 미리보기 prose 사이즈 — 'sm' / 'lg'. */
  previewProseSize?: "sm" | "base";
  /** sm 모드에서 min-h 를 2배(240px)로 — 코멘트 페이지처럼 마크다운 작성 공간이 필요한 곳. */
  tall?: boolean;
};

export function MarkdownInput({
  value,
  onChange,
  placeholder = "내용을 작성하세요. 마크다운 문법 지원 (**굵게**, _기울임_, [링크](url), ```code``` 등)",
  rows = 14,
  size = "lg",
  showCounter = true,
  previewProseSize = "sm",
  tall = false,
}: Props) {
  const [preview, setPreview] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 선택 영역을 prefix/suffix 로 감싸거나, placeholder 삽입.
  function wrap(prefix: string, suffix: string = prefix, ph = "텍스트") {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const body = selected || ph;
    const next = value.slice(0, start) + prefix + body + suffix + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const cursorStart = start + prefix.length;
      const cursorEnd = cursorStart + body.length;
      ta.setSelectionRange(cursorStart, cursorEnd);
    });
  }

  // 선택된 각 줄 시작에 prefix 부착 (헤딩/목록 등).
  function prefixLines(prefix: string, ph = "텍스트") {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const selected = value.slice(lineStart, end) || ph;
    const prefixed = selected
      .split("\n")
      .map((l) => (l.length === 0 ? l : prefix + l))
      .join("\n");
    const next = value.slice(0, lineStart) + prefixed + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(lineStart, lineStart + prefixed.length);
    });
  }

  function insert(text: string) {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function insertLink() {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const sel = value.slice(start, end) || "링크 텍스트";
    const body = `[${sel}](https://)`;
    const next = value.slice(0, start) + body + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const urlStart = start + sel.length + 3;
      ta.setSelectionRange(urlStart + 8, urlStart + 8);
    });
  }

  function insertCodeBlock() {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || "코드";
    const body = `\n\`\`\`\n${selected}\n\`\`\`\n`;
    const next = value.slice(0, start) + body + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const cursor = start + 5;
      ta.setSelectionRange(cursor, cursor + selected.length);
    });
  }

  function insertTable() {
    insert(
      "\n| 제목1 | 제목2 | 제목3 |\n|-------|-------|-------|\n| 셀1   | 셀2   | 셀3   |\n",
    );
  }

  const btn =
    "h-7 w-7 inline-flex items-center justify-center rounded border border-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground";
  const Sep = () => <span className="h-5 w-px bg-border mx-0.5" aria-hidden />;

  const proseClass =
    previewProseSize === "base" ? "prose max-w-none" : "prose prose-sm max-w-none";
  const taClass =
    size === "lg"
      ? "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed outline-none"
      : "w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none";
  const minH =
    size === "lg"
      ? "min-h-[300px]"
      : tall
        ? "min-h-[240px]"
        : "min-h-[120px]";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setPreview(false)}
          className={
            "h-7 inline-flex items-center gap-1 rounded-md border px-3 " +
            (!preview
              ? "border-primary bg-primary/10 text-primary font-medium"
              : "border-border bg-card hover:bg-muted")
          }
        >
          <Pencil className="h-3.5 w-3.5" />
          작성
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          className={
            "h-7 inline-flex items-center gap-1 rounded-md border px-3 " +
            (preview
              ? "border-primary bg-primary/10 text-primary font-medium"
              : "border-border bg-card hover:bg-muted")
          }
        >
          <Eye className="h-3.5 w-3.5" />
          미리보기
        </button>
        {showCounter && (
          <span className="ml-auto text-muted-foreground">
            Markdown · {value.length.toLocaleString("ko-KR")}자
          </span>
        )}
      </div>

      {!preview && (
        <div className="flex items-center gap-1 flex-wrap rounded-md border border-border bg-card px-2 py-1">
          <Tooltip label="제목 1" side="bottom">
            <button type="button" onClick={() => prefixLines("# ", "제목")} className={btn}>
              <Heading1 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="제목 2" side="bottom">
            <button type="button" onClick={() => prefixLines("## ", "제목")} className={btn}>
              <Heading2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="제목 3" side="bottom">
            <button type="button" onClick={() => prefixLines("### ", "제목")} className={btn}>
              <Heading3 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Sep />
          <Tooltip label="굵게 (Bold)" side="bottom">
            <button type="button" onClick={() => wrap("**", "**", "굵은 글씨")} className={btn}>
              <Bold className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="기울임 (Italic)" side="bottom">
            <button type="button" onClick={() => wrap("_", "_", "기울임")} className={btn}>
              <Italic className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="인라인 코드" side="bottom">
            <button type="button" onClick={() => wrap("`", "`", "code")} className={btn}>
              <Code className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Sep />
          <Tooltip label="순서없는 목록" side="bottom">
            <button type="button" onClick={() => prefixLines("- ", "항목")} className={btn}>
              <List className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="순서 있는 목록" side="bottom">
            <button type="button" onClick={() => prefixLines("1. ", "항목")} className={btn}>
              <ListOrdered className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="인용구" side="bottom">
            <button type="button" onClick={() => prefixLines("> ", "인용")} className={btn}>
              <Quote className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Sep />
          <Tooltip label="링크" side="bottom">
            <button type="button" onClick={insertLink} className={btn}>
              <LinkIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="코드 블록" side="bottom">
            <button type="button" onClick={insertCodeBlock} className={btn}>
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="표 삽입" side="bottom">
            <button type="button" onClick={insertTable} className={btn}>
              <Table className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="구분선" side="bottom">
            <button type="button" onClick={() => insert("\n---\n")} className={btn}>
              <Minus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      )}

      {preview ? (
        <div
          className={`${minH} rounded-md border border-border bg-card p-4 ${proseClass}`}
        >
          <PostMarkdown content={value} />
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${taClass} ${minH}`}
          rows={rows}
        />
      )}
    </div>
  );
}

/**
 * 마크다운 렌더링 — react-markdown + remark-gfm/remark-breaks.
 * 부모가 prose 컨테이너로 감싸야 글꼴·간격 기본값 적용 (Tailwind Typography).
 */
export function PostMarkdown({ content }: { content: string }) {
  if (!content.trim()) {
    return <p className="text-muted-foreground text-sm italic">(내용 없음)</p>;
  }
  // 마크다운은 단일 개행을 줄바꿈으로 인식하지 않음. remark-breaks 가 있더라도
  // 환경에 따라 동작이 불안정해, 코드 블록이 아닌 본문의 단일 \n 을 hard break
  // (`  \n`) 로 명시 변환해 확실히 <br> 로 렌더되게 한다. \n\n 은 그대로(문단).
  const prepared = withHardBreaks(content);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[[rehypePrism, { showLineNumbers: true, ignoreMissing: true }]]}
      components={{
        p: (p) => <p className="my-2 leading-6" {...p} />,
        h1: (p) => <h1 className="text-2xl font-bold mt-4 mb-2" {...p} />,
        h2: (p) => <h2 className="text-xl font-bold mt-4 mb-2" {...p} />,
        h3: (p) => <h3 className="text-lg font-bold mt-3 mb-2" {...p} />,
        h4: (p) => <h4 className="text-base font-bold mt-3 mb-1" {...p} />,
        ul: (p) => <ul className="list-disc pl-6 my-2 space-y-1" {...p} />,
        ol: (p) => <ol className="list-decimal pl-6 my-2 space-y-1" {...p} />,
        li: (p) => <li className="leading-6" {...p} />,
        blockquote: (p) => (
          <blockquote
            className="border-l-4 border-border pl-3 my-2 text-muted-foreground italic"
            {...p}
          />
        ),
        hr: (p) => <hr className="my-3 border-border" {...p} />,
        strong: (p) => <strong className="font-bold" {...p} />,
        em: (p) => <em className="italic" {...p} />,
        a: (props) => (
          <a
            {...props}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          />
        ),
        // react-markdown v9+ 는 `inline` prop 을 더 이상 전달하지 않는다.
        // fenced code block 은 항상 <pre><code class="language-xxx"> 구조 →
        // language-* className 또는 children 에 \n 이 있는지로 블록 판정.
        // 블록은 <pre> 에서 외곽을 만들고 <code> 는 plain (인라인 pill 스타일 없이).
        // 인라인 `code` 는 className 없고 single-line → 둥근 배경 pill.
        pre: (p) => (
          // bg/색상은 Prism 테마(prism-tomorrow) 가 잡으니 padding·radius·margin 만.
          <pre
            className="rounded-md overflow-auto text-sm my-2"
            {...p}
          />
        ),
        code: ({ className, children, ...props }: any) => {
          const isBlock =
            !!className || String(children ?? "").includes("\n");
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code
              className="rounded bg-muted px-1 py-0.5 text-[1em]"
              {...props}
            >
              {children}
            </code>
          );
        },
        table: (p) => (
          <table className="border-collapse border border-border text-sm my-2" {...p} />
        ),
        th: (p) => (
          <th className="border border-border bg-muted px-2 py-1 text-left" {...p} />
        ),
        td: (p) => <td className="border border-border px-2 py-1" {...p} />,
      }}
    >
      {prepared}
    </ReactMarkdown>
  );
}

function withHardBreaks(src: string): string {
  // Windows 브라우저/textarea 가 줄바꿈을 \r\n 으로 저장하는 경우 대비.
  // 정규화 없이 두면 hard-break 변환 결과가 "\r  \n" 형태가 되어 일부 마크다운
  // parser 가 줄바꿈을 인식 못 하고 모든 줄이 한 문단으로 붙어버린다.
  const norm = src.replace(/\r\n?/g, "\n");
  const parts = norm.split(/(```[\s\S]*?```)/g);
  return parts
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk;
      return chunk.replace(/(?<!\n)\n(?!\n)/g, "  \n");
    })
    .join("");
}
