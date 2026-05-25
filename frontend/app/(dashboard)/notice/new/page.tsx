"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Paperclip, Pencil, Save, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { PostEditor } from "@/components/board/PostEditor";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { VisibleRolesPicker } from "@/components/board/VisibleRolesPicker";

type PendingFile = { id: string; file: File; name: string };

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : Math.random().toString(36).slice(2);
}

export default function NoticeNewPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isPinned, setIsPinned] = useState(false);
  const [visibleRoles, setVisibleRoles] = useState<string[] | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const createM = useMutation({
    mutationFn: async () => {
      const { data: post } = await api.post("/board/posts", {
        title,
        content,
        is_pinned: isPinned,
        category: "NOTICE",
        visible_roles: visibleRoles,
      });
      // 첨부 업로드 — FormData.append 의 filename 인자를 사용해 사용자가 바꾼 이름을 반영.
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f.file, f.name);
        await api.post(`/board/posts/${post.id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      return post;
    },
    onSuccess: (post: any) => {
      qc.invalidateQueries({ queryKey: ["board-posts"] });
      router.push(`/notice/${post.id}`);
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      if (Array.isArray(d)) {
        setError(
          d
            .map((it: any) => (it.loc ? `${it.loc.slice(1).join(".")}: ${it.msg}` : it.msg))
            .join(" / "),
        );
      } else {
        setError(d ?? e?.message ?? "등록 실패");
      }
    },
  });

  async function renameLocal(id: string, current: string) {
    const next = await dialog.prompt("파일 이름을 입력하세요", {
      defaultValue: current,
    });
    if (!next || !next.trim() || next === current) return;
    setFiles((p) =>
      p.map((f) => (f.id === id ? { ...f, name: next.trim() } : f)),
    );
  }

  return (
    <>
      <DashboardHeader
        title="공지사항 · 새 글"
        actions={
          <div className="flex gap-2">
            <Link
              href="/notice"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
            {!title.trim() ? (
              <Tooltip label="제목을 입력하세요" side="bottom">
                <button
                  type="button"
                  disabled={!title.trim() || createM.isPending}
                  onClick={() => createM.mutate()}
                  className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {createM.isPending ? "등록 중..." : "등록"}
                </button>
              </Tooltip>
            ) : (
              <button
                type="button"
                disabled={!title.trim() || createM.isPending}
                onClick={() => createM.mutate()}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {createM.isPending ? "등록 중..." : "등록"}
              </button>
            )}
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto max-w-5xl">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <PostEditor
          title={title}
          content={content}
          isPinned={isPinned}
          onTitleChange={setTitle}
          onContentChange={setContent}
          onPinnedChange={setIsPinned}
        />

        <VisibleRolesPicker value={visibleRoles} onChange={setVisibleRoles} />

        <div className="rounded-md border border-border bg-card p-4 space-y-3">
          <div className="text-sm font-semibold">첨부파일</div>
          <FileDropZone
            multiple
            onFiles={(fs) =>
              setFiles((p) => [
                ...p,
                ...fs.map((file) => ({ id: makeId(), file, name: file.name })),
              ])
            }
          />
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
                >
                  <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {(f.file.size / 1024).toFixed(1)} KB
                  </span>
                  <Tooltip label="이름 변경" side="top">
                    <button
                      type="button"
                      onClick={() => renameLocal(f.id, f.name)}
                      className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:underline"
                    >
                      <Pencil className="h-3 w-3" />
                      이름 변경
                    </button>
                  </Tooltip>
                  <Tooltip label="제거" side="top">
                    <button
                      type="button"
                      onClick={() =>
                        setFiles((p) => p.filter((x) => x.id !== f.id))
                      }
                      className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
                    >
                      <Trash2 className="h-3 w-3" />
                      제거
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
