"use client";

/**
 * 기술지원 (케이스/로그) 공용 첨부 블록.
 *
 * - 다이얼로그 신규 생성 모드(`recordId` 없음): 파일 선택만 → 부모가
 *   pending list 로 들고 있다가 case/log 생성 후 일괄 업로드.
 * - 편집 모드(`recordId` 존재): 직접 API 호출 (upload/rename/delete/download).
 *
 * 부모는 `pendingFiles` / `existingAttachments` 두 state 를 관리하고,
 * 본 컴포넌트는 표시 + 사용자 인터랙션만 담당.
 */

import { Paperclip, Pencil, X } from "lucide-react";
import { api } from "@/lib/api";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { useDialog } from "@/components/ui/DialogProvider";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";

export type AttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

export function AttachmentsBlock({
  baseUrl,
  recordId,
  pendingFiles,
  setPendingFiles,
  existingAttachments,
  setExistingAttachments,
}: {
  baseUrl: string;            // 예: "/support-cases" or "/support-logs"
  recordId: string | null;    // null = 신규 생성 모드
  pendingFiles: File[];
  setPendingFiles: (fn: (p: File[]) => File[]) => void;
  existingAttachments: AttachmentRow[];
  setExistingAttachments: (fn: (p: AttachmentRow[]) => AttachmentRow[]) => void;
}) {
  const dialog = useDialog();

  async function downloadAttachment(att: AttachmentRow) {
    if (!recordId) return;
    const res = await api.get(`${baseUrl}/${recordId}/attachments/${att.id}`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <FileDropZone
        multiple
        label="파일을 끌어놓거나 클릭해서 선택"
        onFiles={(files) => setPendingFiles((p) => [...p, ...files])}
      />
      {existingAttachments.length > 0 && (
        <ul className="mt-2 space-y-1">
          {existingAttachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
            >
              <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
              <button
                type="button"
                onClick={() => downloadAttachment(a)}
                className="flex-1 truncate text-left text-primary hover:underline"
              >
                {a.file_name}
              </button>
              <span className="text-muted-foreground tabular-nums">
                {a.size ? `${(a.size / 1024).toFixed(1)} KB` : ""}
              </span>
              {recordId && (
                <AttachmentPreviewButton
                  filename={a.file_name}
                  mime={a.mime_type}
                  downloadPath={`${baseUrl}/${recordId}/attachments/${a.id}`}
                />
              )}
              <button
                type="button"
                onClick={async () => {
                  if (!recordId) return;
                  const next = await dialog.prompt("파일 이름", {
                    defaultValue: a.file_name,
                  });
                  if (!next || !next.trim() || next === a.file_name) return;
                  await api.patch(`${baseUrl}/${recordId}/attachments/${a.id}`, {
                    file_name: next.trim(),
                  });
                  setExistingAttachments((p) =>
                    p.map((x) =>
                      x.id === a.id ? { ...x, file_name: next.trim() } : x,
                    ),
                  );
                }}
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                <Pencil className="h-3 w-3" />
                이름
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!recordId) return;
                  const ok = await dialog.confirm("이 첨부를 삭제하시겠습니까?", {
                    destructive: true,
                  });
                  if (!ok) return;
                  await api.delete(`${baseUrl}/${recordId}/attachments/${a.id}`);
                  setExistingAttachments((p) => p.filter((x) => x.id !== a.id));
                }}
                className="text-destructive hover:underline inline-flex items-center gap-0.5"
              >
                <X className="h-3 w-3" />
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      {pendingFiles.length > 0 && (
        <ul className="mt-2 space-y-1">
          {pendingFiles.map((f, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
            >
              <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {(f.size / 1024).toFixed(1)} KB
              </span>
              <button
                type="button"
                onClick={() =>
                  setPendingFiles((p) => p.filter((_, idx) => idx !== i))
                }
                className="text-destructive hover:underline inline-flex items-center gap-0.5"
              >
                <X className="h-3 w-3" />
                제거
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
