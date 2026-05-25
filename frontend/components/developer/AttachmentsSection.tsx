"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Pencil, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { useDialog } from "@/components/ui/DialogProvider";

type Attachment = {
  id: string;
  developer_id: string;
  file_name: string;
  mime_type?: string | null;
  size: number;
  description?: string | null;
  created_at: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentsSection({ developerId }: { developerId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: rows = [], isLoading } = useQuery<Attachment[]>({
    queryKey: ["developer-attachments", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/resumes`)).data,
  });

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      return (
        await api.post(`/developers/${developerId}/resumes`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["developer-attachments", developerId] }),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "업로드 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/developers/resumes/${id}`)).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["developer-attachments", developerId] }),
  });

  const renameM = useMutation({
    mutationFn: async (args: { id: string; file_name: string }) =>
      (
        await api.patch(`/developers/resumes/${args.id}`, {
          file_name: args.file_name,
        })
      ).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["developer-attachments", developerId] }),
  });

  async function downloadOne(a: Attachment) {
    const res = await api.get(`/developers/resumes/${a.id}/download`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = a.file_name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">첨부파일</h2>
        <span className="text-xs text-muted-foreground">{rows.length}개</span>
      </div>

      <FileDropZone
        onFiles={(files) => uploadM.mutate(files)}
        disabled={uploadM.isPending}
        label={
          uploadM.isPending
            ? "업로드 중..."
            : "파일을 여기로 끌어놓거나 클릭해서 선택"
        }
      />

      {isLoading ? (
        <div className="text-sm text-muted-foreground">로딩 중...</div>
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          첨부된 파일이 없습니다.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((a) => (
            <AttachmentRow
              key={a.id}
              att={a}
              onRename={(name) => renameM.mutate({ id: a.id, file_name: name })}
              onDelete={async () => {
                if (await dialog.confirm(`"${a.file_name}" 을(를) 삭제할까요?`)) {
                  deleteM.mutate(a.id);
                }
              }}
              onDownload={() => downloadOne(a)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentRow({
  att,
  onRename,
  onDelete,
  onDownload,
}: {
  att: Attachment;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(att.file_name);

  function commit() {
    const v = draft.trim();
    if (v && v !== att.file_name) onRename(v);
    setEditing(false);
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(att.file_name);
                  setEditing(false);
                }
              }}
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={commit}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted"
              title="저장"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(att.file_name);
                setEditing(false);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted"
              title="취소"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="truncate font-medium">{att.file_name}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatSize(att.size)}
            </span>
          </div>
        )}
      </div>
      {!editing && (
        <>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted"
            title="파일명 변경"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDownload}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted"
            title="다운로드"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted text-destructive"
            title="삭제"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </li>
  );
}
