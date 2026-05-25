"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Eye,
  FileDown,
  ListOrdered,
  Paperclip,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { PostMarkdown } from "@/components/board/PostEditor";
import { TipTapViewer } from "@/components/board/TipTapEditor";
import { TocPanel } from "@/components/ui/TocPanel";
import { TocResizer } from "@/components/ui/TocResizer";
import { VisibleRolesBadges } from "@/components/board/VisibleRolesPicker";
import { extractHeadings, type TocItem } from "@/lib/extract-headings";

type Attachment = {
  id: string;
  post_id: string;
  file_name: string;
  mime_type: string | null;
  size: number;
  created_at: string | null;
};
type Post = {
  id: string;
  title: string;
  content: string;
  author_id: string | null;
  author_name: string | null;
  is_pinned: boolean;
  view_count: number;
  visible_roles: string[] | null;
  attachments: Attachment[];
  created_at: string | null;
  updated_at: string | null;
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function NoticeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: me } = useQuery<{ id: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });

  const { data: post } = useQuery<Post>({
    queryKey: ["board-post", id],
    queryFn: async () => (await api.get(`/board/posts/${id}`)).data,
    staleTime: 0,
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/board/posts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board-posts"] });
      router.push("/notice");
    },
  });

  const renameM = useMutation({
    mutationFn: async (args: { aid: string; file_name: string }) =>
      api.patch(`/board/attachments/${args.aid}`, {
        file_name: args.file_name,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board-post", id] }),
  });

  const deleteAttM = useMutation({
    mutationFn: async (aid: string) =>
      api.delete(`/board/attachments/${aid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board-post", id] }),
  });

  async function download(att: Attachment) {
    const res = await api.get(
      `/board/attachments/${att.id}/download`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // TOC 토글 + 폭 — 둘 다 localStorage 영속. 폭은 드래그 separator 로 조정.
  const [tocOpen, setTocOpen] = useState(false);
  const [tocWidth, setTocWidth] = useState<number>(240);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<TocItem[]>([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("post-toc-open") === "1") setTocOpen(true);
    const w = Number(window.localStorage.getItem("post-toc-width"));
    if (Number.isFinite(w) && w >= 160 && w <= 720) setTocWidth(w);
  }, []);
  function toggleToc() {
    setTocOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("post-toc-open", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  useEffect(() => {
    if (!post?.content) {
      setHeadings([]);
      return;
    }
    const t = setTimeout(() => {
      setHeadings(extractHeadings(viewerRef.current));
    }, 0);
    return () => clearTimeout(t);
  }, [post?.content]);

  if (!post) {
    return (
      <>
        <DashboardHeader title="공지사항" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  const canEdit = me?.role === "ADMIN" || me?.id === post.author_id;

  return (
    <>
      <DashboardHeader
        title="공지사항"
        actions={
          <div className="flex gap-2">
            <Link
              href="/notice"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
            <button
              type="button"
              onClick={toggleToc}
              className={
                "h-8 inline-flex items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted " +
                (tocOpen
                  ? "border-primary/40 bg-primary/5 text-primary"
                  : "border-border bg-background")
              }
              title="목차 패널 토글"
            >
              <ListOrdered className="h-3.5 w-3.5" />
              목차{headings.length > 0 ? ` (${headings.length})` : ""}
            </button>
            {canEdit && (
              <>
                <Link
                  href={`/notice/${id}/edit`}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  수정
                </Link>
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm(
                        "이 글을 삭제하시겠습니까? 첨부파일도 함께 삭제됩니다.",
                        { destructive: true },
                      )
                    ) {
                      deleteM.mutate();
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  삭제
                </button>
              </>
            )}
          </div>
        }
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* 본문은 잔여 공간을 모두 차지 — 우측 TOC 패널(아래) 이 가장자리에 붙도록.
          본문이 너무 넓어지면 article 내부에서 별도 max-w 로 제한. */}
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto min-w-0">
        <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-2 mb-3">
            {post.is_pinned && (
              <Tooltip label="고정 글" side="right">
                <span className="shrink-0 mt-1 inline-flex">
                  <Pin className="h-5 w-5 text-amber-600" />
                </span>
              </Tooltip>
            )}
            <h1 className="text-xl font-bold flex-1">{post.title}</h1>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4 flex-wrap">
            <span>작성자: {post.author_name ?? "-"}</span>
            <span>·</span>
            <span>작성 {fmtDate(post.created_at)}</span>
            {post.updated_at && post.updated_at !== post.created_at && (
              <>
                <span>·</span>
                <span>수정 {fmtDate(post.updated_at)}</span>
              </>
            )}
            <span>·</span>
            <span className="inline-flex items-center gap-0.5">
              <Eye className="h-3 w-3" />
              {post.view_count}
            </span>
            <span>·</span>
            <VisibleRolesBadges roles={post.visible_roles} />
          </div>
          {post.content.trim().startsWith("<") ? (
            <TipTapViewer ref={viewerRef} html={post.content} />
          ) : (
            <div ref={viewerRef} className="prose prose-sm max-w-none">
              <PostMarkdown content={post.content} />
            </div>
          )}
        </div>

        {post.attachments.length > 0 && (
          <div className="rounded-md border border-border bg-card p-4">
            <div className="text-sm font-semibold mb-2">
              첨부파일 ({post.attachments.length})
            </div>
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
                  <AttachmentPreviewButton
                    filename={a.file_name}
                    mime={a.mime_type}
                    downloadPath={`/board/attachments/${a.id}/download`}
                    variant="text"
                  />
                  <button
                    type="button"
                    onClick={() => download(a)}
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    <FileDown className="h-3 w-3" />
                    다운로드
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          const next = await dialog.prompt(
                            "파일 이름을 입력하세요",
                            { defaultValue: a.file_name },
                          );
                          if (next && next.trim() && next !== a.file_name) {
                            renameM.mutate({ aid: a.id, file_name: next.trim() });
                          }
                        }}
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
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {tocOpen && (
        <>
          <TocResizer
            width={tocWidth}
            onChange={setTocWidth}
            storageKey="post-toc-width"
          />
          <TocPanel
            headings={headings}
            onClose={toggleToc}
            width={tocWidth}
          />
        </>
      )}
      </div>
    </>
  );
}
