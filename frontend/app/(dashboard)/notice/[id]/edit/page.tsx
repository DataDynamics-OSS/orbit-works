"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FileDown,
  Paperclip,
  Pencil,
  Save,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { PostEditor } from "@/components/board/PostEditor";
import { VisibleRolesPicker } from "@/components/board/VisibleRolesPicker";
import { FileDropZone } from "@/components/ui/FileDropZone";

type Attachment = {
  id: string;
  post_id: string;
  file_name: string;
  mime_type: string | null;
  size: number;
};
type Post = {
  id: string;
  title: string;
  content: string;
  author_id: string | null;
  is_pinned: boolean;
  visible_roles: string[] | null;
  attachments: Attachment[];
};

type PendingFile = { id: string; file: File; name: string };

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : Math.random().toString(36).slice(2);
}

export default function NoticeEditPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: post } = useQuery<Post>({
    queryKey: ["board-post", id],
    queryFn: async () => (await api.get(`/board/posts/${id}`)).data,
    staleTime: 0,
  });

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isPinned, setIsPinned] = useState(false);
  const [visibleRoles, setVisibleRoles] = useState<string[] | null>(null);
  const [newFiles, setNewFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (post) {
      setTitle(post.title);
      setContent(post.content);
      setIsPinned(post.is_pinned);
      setVisibleRoles(post.visible_roles ?? null);
    }
  }, [post?.id]);

  const updateM = useMutation({
    mutationFn: async () => {
      await api.patch(`/board/posts/${id}`, {
        title,
        content,
        is_pinned: isPinned,
        visible_roles: visibleRoles,
      });
      for (const f of newFiles) {
        const fd = new FormData();
        fd.append("file", f.file, f.name);
        await api.post(`/board/posts/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board-post", id] });
      qc.invalidateQueries({ queryKey: ["board-posts"] });
      router.push(`/notice/${id}`);
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
        setError(d ?? e?.message ?? "수정 실패");
      }
    },
  });

  const renameM = useMutation({
    mutationFn: async (args: { aid: string; file_name: string }) =>
      api.patch(`/board/attachments/${args.aid}`, { file_name: args.file_name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board-post", id] }),
  });

  const deleteAttM = useMutation({
    mutationFn: async (aid: string) => api.delete(`/board/attachments/${aid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board-post", id] }),
  });

  async function download(att: Attachment) {
    const res = await api.get(`/board/attachments/${att.id}/download`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function renameExisting(att: Attachment) {
    const next = await dialog.prompt("파일 이름을 입력하세요", {
      defaultValue: att.file_name,
    });
    if (next && next.trim() && next !== att.file_name) {
      renameM.mutate({ aid: att.id, file_name: next.trim() });
    }
  }

  async function renameLocal(id: string, current: string) {
    const next = await dialog.prompt("파일 이름을 입력하세요", {
      defaultValue: current,
    });
    if (!next || !next.trim() || next === current) return;
    setNewFiles((p) =>
      p.map((f) => (f.id === id ? { ...f, name: next.trim() } : f)),
    );
  }

  if (!post) {
    return (
      <>
        <DashboardHeader title="공지사항 · 수정" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="공지사항 · 수정"
        actions={
          <div className="flex gap-2">
            <Link
              href={`/notice/${id}`}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              취소
            </Link>
            <button
              type="button"
              disabled={!title.trim() || updateM.isPending}
              onClick={() => updateM.mutate()}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {updateM.isPending ? "저장 중..." : "저장"}
            </button>
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
              setNewFiles((p) => [
                ...p,
                ...fs.map((file) => ({ id: makeId(), file, name: file.name })),
              ])
            }
          />

          {post.attachments.length === 0 && newFiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">첨부파일이 없습니다.</p>
          ) : (
            <ul className="space-y-1">
              {post.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
                >
                  <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate">{a.file_name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {(a.size / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => download(a)}
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    <FileDown className="h-3 w-3" />
                    다운로드
                  </button>
                  <button
                    type="button"
                    onClick={() => renameExisting(a)}
                    className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:underline"
                  >
                    <Pencil className="h-3 w-3" />
                    이름 변경
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        await dialog.confirm(
                          `${a.file_name} 을(를) 삭제하시겠습니까?`,
                          { destructive: true },
                        )
                      ) {
                        deleteAttM.mutate(a.id);
                      }
                    }}
                    className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
                  >
                    <Trash2 className="h-3 w-3" />
                    삭제
                  </button>
                </li>
              ))}
              {newFiles.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
                >
                  <Paperclip className="h-3 w-3 text-sky-600 shrink-0" />
                  <span className="flex-1 truncate">
                    {f.name}{" "}
                    <span className="text-sky-600 text-[10px]">
                      (저장 시 업로드)
                    </span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {(f.file.size / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => renameLocal(f.id, f.name)}
                    className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:underline"
                  >
                    <Pencil className="h-3 w-3" />
                    이름 변경
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setNewFiles((p) => p.filter((x) => x.id !== f.id))
                    }
                    className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
                  >
                    <Trash2 className="h-3 w-3" />
                    제거
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
