"use client";

/**
 * 첨부 파일 미리보기 — 포맷별 렌더러 모음.
 *
 * 모든 렌더러는 공통 props 인터페이스 `RendererProps` 를 구현:
 *   - blob  : 미리 fetch 된 Blob (object URL 은 dispatcher 가 lifecycle 관리)
 *   - url   : 위 blob 의 object URL (image / pdf / video / audio 가 직접 src 로 사용)
 *   - filename, mime — 메타.
 *
 * 텍스트 계열 (text/code/markdown/csv/json/yaml/xml) 은 blob → text 로 디코드
 * 후 표시. 인코딩은 UTF-8 가정 (BOM 자동 처리).
 *
 * 외부 라이브러리 (highlight.js / docx-preview / xlsx / papaparse / js-yaml)
 * 는 동적 import — 미리보기 모달이 열릴 때만 로드돼 첫 페이지 bundle 영향 0.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type RendererProps = {
  blob: Blob;
  url: string;       // object URL — image/pdf/video/audio 가 직접 사용
  filename: string;
  mime: string | null;
};

// 공용: blob → text (UTF-8 decoder, BOM strip).
async function blobToText(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// 텍스트 비동기 로딩 hook — 모든 텍스트 계열이 공유.
function useText(blob: Blob) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    blobToText(blob)
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [blob]);
  return { text, error };
}

// ---------------------------------------------------------------------------
// Tier 1 — 네이티브 (image/pdf/video/audio/html)
// ---------------------------------------------------------------------------

export function ImagePreview({ url, filename }: RendererProps) {
  return (
    <div className="flex items-center justify-center bg-black/5 min-h-[300px] p-2">
      <img
        src={url}
        alt={filename}
        className="max-w-full max-h-[80vh] object-contain"
      />
    </div>
  );
}

export function PdfPreview({ url }: RendererProps) {
  // type=application/pdf 명시 — 일부 브라우저는 mime 으로 viewer 분기.
  return (
    <iframe
      src={url}
      className="w-full"
      style={{ height: "80vh", border: 0 }}
      title="PDF preview"
    />
  );
}

export function VideoPreview({ url, mime }: RendererProps) {
  return (
    <div className="flex items-center justify-center bg-black/90 min-h-[300px]">
      <video
        src={url}
        controls
        className="max-w-full max-h-[80vh]"
      >
        {mime && <source src={url} type={mime} />}
        브라우저가 비디오 재생을 지원하지 않습니다.
      </video>
    </div>
  );
}

export function AudioPreview({ url, mime, filename }: RendererProps) {
  return (
    <div className="p-6 flex flex-col items-center gap-3">
      <div className="text-sm text-muted-foreground">{filename}</div>
      <audio src={url} controls className="w-full max-w-md">
        {mime && <source src={url} type={mime} />}
      </audio>
    </div>
  );
}

export function HtmlPreview({ blob }: RendererProps) {
  // sandbox — JS 차단, 외부 폰트·이미지 동작은 'allow-same-origin' 으로 제한적
  // 허용. XSS 방지 위해 'allow-scripts' 는 빼는 게 안전.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    blobToText(blob).then((t) => {
      if (cancelled) return;
      const b = new Blob([t], { type: "text/html" });
      setSrc(URL.createObjectURL(b));
    });
    return () => {
      cancelled = true;
      if (src) URL.revokeObjectURL(src);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);
  if (!src) return <Loading />;
  return (
    <iframe
      src={src}
      sandbox=""
      className="w-full bg-white"
      style={{ height: "80vh", border: 0 }}
      title="HTML preview"
    />
  );
}

// ---------------------------------------------------------------------------
// Tier 2 — 텍스트 / 코드 / Markdown / CSV / JSON / YAML / XML
// ---------------------------------------------------------------------------

export function TextPreview({ blob }: RendererProps) {
  const { text, error } = useText(blob);
  if (error) return <ErrorBox msg={error} />;
  if (text === null) return <Loading />;
  return (
    <pre className="p-4 text-xs whitespace-pre-wrap break-all max-h-[80vh] overflow-auto bg-muted/20">
      {text}
    </pre>
  );
}

export function CodePreview({ blob, filename }: RendererProps) {
  const { text, error } = useText(blob);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    if (text === null) return;
    let cancelled = false;
    // 동적 import — highlight.js 는 모달이 열릴 때만 로드.
    (async () => {
      try {
        const hljs = (await import("highlight.js")).default;
        // CSS 도 동적 로드 — 첫 진입 시 1회만.
        await import("highlight.js/styles/github.css");
        const ext = filename.split(".").pop()?.toLowerCase() || "";
        // 확장자 → hljs 언어 alias.
        const lang =
          ext &&
          (hljs.getLanguage(ext) ||
            hljs.getLanguage(ext === "tsx" || ext === "jsx" ? "typescript" : ""))
            ? ext === "tsx" || ext === "jsx"
              ? "typescript"
              : ext
            : null;
        const html = lang
          ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
          : hljs.highlightAuto(text).value;
        if (!cancelled) setHighlighted(html);
      } catch {
        if (!cancelled) setHighlighted(escapeHtml(text));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text, filename]);

  if (error) return <ErrorBox msg={error} />;
  if (text === null || highlighted === null) return <Loading />;
  return (
    <pre className="p-4 text-xs whitespace-pre-wrap break-all max-h-[80vh] overflow-auto bg-white">
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  );
}

export function MarkdownPreview({ blob }: RendererProps) {
  const { text, error } = useText(blob);
  if (error) return <ErrorBox msg={error} />;
  if (text === null) return <Loading />;
  return (
    <div className="p-4 prose prose-sm max-w-none max-h-[80vh] overflow-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function CsvPreview({ blob, filename }: RendererProps) {
  const { text, error } = useText(blob);
  const [rows, setRows] = useState<string[][] | null>(null);

  useEffect(() => {
    if (text === null) return;
    let cancelled = false;
    (async () => {
      // papaparse 동적 import.
      const Papa = (await import("papaparse")).default;
      const isTsv = filename.toLowerCase().endsWith(".tsv");
      const result = Papa.parse<string[]>(text, {
        delimiter: isTsv ? "\t" : "",  // 빈 string = 자동 감지
        skipEmptyLines: true,
      });
      if (!cancelled) setRows(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [text, filename]);

  if (error) return <ErrorBox msg={error} />;
  if (rows === null) return <Loading />;
  if (rows.length === 0)
    return <div className="p-4 text-muted-foreground italic">빈 표.</div>;

  // 1행 = 헤더 가정. 너무 큰 파일은 위 1000행만 표시.
  const head = rows[0];
  const body = rows.slice(1, 1001);
  const truncated = rows.length - 1 > 1000;

  return (
    <div className="max-h-[80vh] overflow-auto">
      <table className="w-full text-xs border-collapse">
        <thead className="bg-muted/40 sticky top-0">
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="text-left px-2 py-1.5 border-b border-border font-semibold"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="hover:bg-muted/20">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="px-2 py-1 border-b border-border/30 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="p-2 text-xs text-muted-foreground italic">
          이후 {rows.length - 1001}행 생략 — 다운로드 후 확인하세요.
        </div>
      )}
    </div>
  );
}

export function JsonPreview({ blob }: RendererProps) {
  const { text, error } = useText(blob);
  if (error) return <ErrorBox msg={error} />;
  if (text === null) return <Loading />;
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    // JSON 파싱 실패 → raw text.
    pretty = text;
  }
  return <CodePretty code={pretty} lang="json" />;
}

export function YamlPreview({ blob, filename }: RendererProps) {
  const { text, error } = useText(blob);
  const [parsed, setParsed] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    let cancelled = false;
    (async () => {
      try {
        const yaml = await import("js-yaml");
        const obj = yaml.load(text);
        if (!cancelled) setParsed(JSON.stringify(obj, null, 2));
      } catch {
        if (!cancelled) setParsed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (error) return <ErrorBox msg={error} />;
  if (text === null) return <Loading />;
  // 파싱 성공 시: 본문 + 변환된 JSON tree 둘 다 보여줌.
  return (
    <div className="grid md:grid-cols-2 max-h-[80vh] overflow-hidden">
      <CodePretty code={text} lang="yaml" title="원본" />
      {parsed !== null ? (
        <CodePretty code={parsed} lang="json" title="JSON 변환" />
      ) : (
        <div className="p-4 text-xs text-muted-foreground border-l border-border">
          파싱 실패 — 원본만 표시.
        </div>
      )}
    </div>
  );
}

export function XmlPreview({ blob }: RendererProps) {
  const { text, error } = useText(blob);
  if (error) return <ErrorBox msg={error} />;
  if (text === null) return <Loading />;
  return <CodePretty code={text} lang="xml" />;
}

// ---------------------------------------------------------------------------
// Tier 2 — Office
// ---------------------------------------------------------------------------

export function XlsxPreview({ blob }: RendererProps) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const buf = await blob.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const out = wb.SheetNames.map((n) => ({
          name: n,
          html: XLSX.utils.sheet_to_html(wb.Sheets[n]),
        }));
        if (!cancelled) setSheets(out);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  if (error) return <ErrorBox msg={error} />;
  if (sheets === null) return <Loading />;
  if (sheets.length === 0)
    return <div className="p-4 text-muted-foreground italic">시트 없음.</div>;

  return (
    <div className="flex flex-col max-h-[80vh]">
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-muted/30 overflow-x-auto shrink-0">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActive(i)}
              className={
                "px-2 py-1 text-xs rounded " +
                (i === active
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted")
              }
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="flex-1 overflow-auto bg-white text-xs xlsx-preview"
        dangerouslySetInnerHTML={{ __html: sheets[active].html }}
      />
    </div>
  );
}

export function DocxPreview({ blob }: RendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docx = await import("docx-preview");
        if (!containerRef.current || cancelled) return;
        await docx.renderAsync(blob, containerRef.current, undefined, {
          inWrapper: false,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
        });
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  return (
    <div className="max-h-[80vh] overflow-auto bg-white">
      {loading && <Loading />}
      {error && <ErrorBox msg={error} />}
      <div ref={containerRef} className="docx-preview-host" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

export function UnsupportedPreview({ filename, mime }: RendererProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[300px] gap-2 p-6 text-center">
      <div className="text-sm font-medium">{filename}</div>
      <div className="text-xs text-muted-foreground">
        이 형식은 미리보기를 지원하지 않습니다 ({mime || "unknown"}).
      </div>
      <div className="text-xs text-muted-foreground italic">
        다운로드 후 로컬 앱으로 열어주세요.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 공용 보조 컴포넌트
// ---------------------------------------------------------------------------

function Loading() {
  return (
    <div className="flex items-center justify-center min-h-[200px] text-sm text-muted-foreground">
      불러오는 중…
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="p-4 text-xs text-destructive">
      미리보기 오류: <span className="font-mono">{msg}</span>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// JSON / XML / YAML 같이 highlight.js 적용한 표시 — 코드 블록 mini 컴포넌트.
function CodePretty({
  code,
  lang,
  title,
}: {
  code: string;
  lang: string;
  title?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hljs = (await import("highlight.js")).default;
        await import("highlight.js/styles/github.css");
        const out = hljs.getLanguage(lang)
          ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
          : escapeHtml(code);
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(escapeHtml(code));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return (
    <div className="flex flex-col max-h-[80vh] overflow-hidden">
      {title && (
        <div className="px-3 py-1 text-[11px] text-muted-foreground bg-muted/30 border-b border-border shrink-0">
          {title}
        </div>
      )}
      <pre className="p-4 text-xs whitespace-pre-wrap break-all overflow-auto bg-white flex-1">
        <code
          dangerouslySetInnerHTML={{ __html: html ?? escapeHtml(code) }}
        />
      </pre>
    </div>
  );
}
