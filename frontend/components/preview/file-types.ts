/**
 * 첨부 파일 미리보기 — 확장자/MIME 분류 테이블.
 *
 * `detectFileKind(filename, mime?)` 가 한 가지 `FileKind` 를 반환. dispatcher
 * (AttachmentPreview) 가 이 kind 로 렌더러를 고른다.
 *
 * 우선순위:
 *   1) 확장자 (가장 신뢰) — 동일 mime 라도 .ts vs .tsx 등 구별 필요.
 *   2) mime type — 확장자 없을 때 fallback.
 *   3) 그 외 → 'unsupported' (다운로드만 권장).
 */

export type FileKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "html"
  | "text"        // 단순 텍스트·로그·conf — syntax highlight 없음
  | "code"        // 소스 코드 — highlight.js
  | "markdown"
  | "csv"
  | "json"
  | "yaml"
  | "xml"
  | "xlsx"
  | "docx"
  | "unsupported";

const EXT_MAP: Record<string, FileKind> = {
  // 이미지
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  svg: "image", avif: "image", bmp: "image", ico: "image",
  // PDF
  pdf: "pdf",
  // 비디오 (브라우저 native 만)
  mp4: "video", webm: "video", ogv: "video",
  // 오디오
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
  aac: "audio", oga: "audio",
  // HTML
  html: "html", htm: "html",
  // Markdown
  md: "markdown", markdown: "markdown",
  // CSV / TSV
  csv: "csv", tsv: "csv",
  // JSON
  json: "json", jsonl: "json",
  // YAML
  yaml: "yaml", yml: "yaml", toml: "yaml",
  // XML
  xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", svgz: "xml",
  // 단순 텍스트 / 로그 / 설정
  txt: "text", log: "text", ini: "text", conf: "text", cfg: "text",
  env: "text", properties: "text",
  // 소스 코드 (highlight.js auto-detect)
  py: "code", js: "code", jsx: "code", ts: "code", tsx: "code", mjs: "code",
  cjs: "code", java: "code", kt: "code", kts: "code", scala: "code", c: "code",
  cpp: "code", cc: "code", cxx: "code", h: "code", hpp: "code", hh: "code",
  cs: "code", go: "code", rs: "code", rb: "code", php: "code", swift: "code",
  m: "code", lua: "code", pl: "code", r: "code", dart: "code", sh: "code",
  bash: "code", zsh: "code", fish: "code", ps1: "code", bat: "code",
  cmd: "code", sql: "code", css: "code", scss: "code", sass: "code",
  less: "code", styl: "code", vue: "code", svelte: "code", elm: "code",
  ex: "code", exs: "code", erl: "code", clj: "code", lisp: "code",
  hs: "code", ml: "code", fs: "code", fsx: "code", graphql: "code",
  gql: "code", proto: "code", makefile: "code", dockerfile: "code",
  // Office
  xlsx: "xlsx", xlsm: "xlsx", xls: "xlsx",
  docx: "docx",
};

const MIME_MAP: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/html": "html",
  "text/plain": "text",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
  "text/markdown": "markdown",
  "text/yaml": "yaml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const MIME_PREFIX_MAP: { prefix: string; kind: FileKind }[] = [
  { prefix: "image/", kind: "image" },
  { prefix: "video/", kind: "video" },
  { prefix: "audio/", kind: "audio" },
];

export function fileExtension(filename: string | null | undefined): string {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function detectFileKind(
  filename: string | null | undefined,
  mime?: string | null,
): FileKind {
  // 1) 확장자.
  const ext = fileExtension(filename);
  if (ext && EXT_MAP[ext]) return EXT_MAP[ext];

  // 2) mime exact.
  const m = (mime || "").toLowerCase();
  if (m && MIME_MAP[m]) return MIME_MAP[m];

  // 3) mime prefix (image/* video/* audio/*).
  for (const { prefix, kind } of MIME_PREFIX_MAP) {
    if (m.startsWith(prefix)) return kind;
  }

  // 4) 텍스트 포괄.
  if (m.startsWith("text/")) return "text";

  return "unsupported";
}

// 라벨 (UI 배지·툴팁 용도).
export const KIND_LABEL: Record<FileKind, string> = {
  image: "이미지",
  pdf: "PDF",
  video: "비디오",
  audio: "오디오",
  html: "HTML",
  text: "텍스트",
  code: "코드",
  markdown: "Markdown",
  csv: "표 (CSV)",
  json: "JSON",
  yaml: "YAML",
  xml: "XML",
  xlsx: "Excel",
  docx: "Word",
  unsupported: "미리보기 미지원",
};
