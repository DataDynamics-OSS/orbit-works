"use client";

/**
 * 첨부 파일 미리보기 — 통합 dispatcher + 모달.
 *
 * 사용 예 (게시판·주간보고·이벤트 등 첨부 row 안):
 *
 *   <AttachmentPreviewButton
 *     filename={a.file_name}
 *     mime={a.mime_type}
 *     downloadPath={`/board/attachments/${a.id}/download`}
 *   />
 *
 * `downloadPath` 는 axios 인터셉터가 Bearer 헤더를 붙여주는 일반 API path.
 * (절대 URL X — 보안상 항상 사내 인증 통과한 fetch). 받은 blob 으로 object URL
 * 만들어 native viewer 에 주입하거나 (image/pdf/video/audio), text 디코드
 * 후 렌더러에 전달.
 *
 * 라이브러리 (highlight.js / docx-preview / xlsx / papaparse / js-yaml) 는
 * renderers.tsx 안에서 동적 import — 모달이 열릴 때만 로드돼 첫 페이지
 * bundle 영향 0.
 */

import { useEffect, useState, type ComponentType } from "react";
import { Eye } from "lucide-react";

import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { detectFileKind, KIND_LABEL, type FileKind } from "./file-types";
import {
  AudioPreview,
  CodePreview,
  CsvPreview,
  DocxPreview,
  HtmlPreview,
  ImagePreview,
  JsonPreview,
  MarkdownPreview,
  PdfPreview,
  TextPreview,
  UnsupportedPreview,
  VideoPreview,
  XlsxPreview,
  XmlPreview,
  YamlPreview,
  type RendererProps,
} from "./renderers";

const RENDERERS: Record<FileKind, ComponentType<RendererProps>> = {
  image: ImagePreview,
  pdf: PdfPreview,
  video: VideoPreview,
  audio: AudioPreview,
  html: HtmlPreview,
  text: TextPreview,
  code: CodePreview,
  markdown: MarkdownPreview,
  csv: CsvPreview,
  json: JsonPreview,
  yaml: YamlPreview,
  xml: XmlPreview,
  xlsx: XlsxPreview,
  docx: DocxPreview,
  unsupported: UnsupportedPreview,
};

// 인증된 axios 인스턴스로 blob fetch.
async function fetchBlob(downloadPath: string): Promise<Blob> {
  const res = await api.get(downloadPath, { responseType: "blob" });
  return res.data as Blob;
}

type Props = {
  filename: string;
  mime: string | null | undefined;
  /** axios baseURL 기준 path. ex) "/board/attachments/123/download". */
  downloadPath: string;
  /** 트리거 버튼 라벨 — 기본 아이콘만. 'text' 면 라벨 노출. */
  variant?: "icon" | "text";
};

export function AttachmentPreviewButton({
  filename,
  mime,
  downloadPath,
  variant = "icon",
}: Props) {
  const [open, setOpen] = useState(false);
  const kind = detectFileKind(filename, mime ?? null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          variant === "icon"
            ? "text-muted-foreground hover:text-foreground"
            : "inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
        }
        title={`미리보기 (${KIND_LABEL[kind]})`}
      >
        <Eye className={variant === "icon" ? "h-3.5 w-3.5" : "h-3 w-3"} />
        {variant === "text" && <span className="ml-0.5">미리보기</span>}
      </button>
      {open && (
        <PreviewModal
          filename={filename}
          mime={mime ?? null}
          kind={kind}
          downloadPath={downloadPath}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PreviewModal({
  filename,
  mime,
  kind,
  downloadPath,
  onClose,
}: {
  filename: string;
  mime: string | null;
  kind: FileKind;
  downloadPath: string;
  onClose: () => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const b = await fetchBlob(downloadPath);
        if (cancelled) return;
        // image/pdf/video/audio 는 mime 을 명시한 새 Blob 으로 감싸서 viewer
        // 가 정확히 처리하도록 한다 (서버 응답 mime 이 octet-stream 일 때 대비).
        const typed = mime ? new Blob([b], { type: mime }) : b;
        setBlob(typed);
        createdUrl = URL.createObjectURL(typed);
        setUrl(createdUrl);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "다운로드 실패");
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [downloadPath, mime]);

  // 다운로드 헬퍼 — 모달 헤더의 '다운로드' 버튼.
  const download = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const Renderer = RENDERERS[kind];

  return (
    <Dialog
      open={true}
      onClose={onClose}
      width="max-w-5xl"
      title={
        <div className="flex items-center gap-2">
          <span className="truncate">{filename}</span>
          <span className="text-[11px] text-muted-foreground font-normal shrink-0">
            ({KIND_LABEL[kind]})
          </span>
        </div>
      }
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button
            type="button"
            onClick={download}
            disabled={!url}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            다운로드
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            닫기
          </button>
        </div>
      }
    >
      <div className="-mx-4 -my-2">
        {error ? (
          <div className="p-4 text-xs text-destructive">
            미리보기 오류: <span className="font-mono">{error}</span>
          </div>
        ) : !blob || !url ? (
          <div className="flex items-center justify-center min-h-[300px] text-sm text-muted-foreground">
            불러오는 중…
          </div>
        ) : (
          <Renderer blob={blob} url={url} filename={filename} mime={mime} />
        )}
      </div>
    </Dialog>
  );
}
