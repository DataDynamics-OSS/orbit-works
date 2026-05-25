"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Eye,
  FileDown,
  ListOrdered,
  MessageSquare,
  Paperclip,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { PostMarkdown } from "@/components/board/PostEditor";
import { TipTapEditor, TipTapViewer } from "@/components/board/TipTapEditor";
import { TocPanel } from "@/components/ui/TocPanel";
import { TocResizer } from "@/components/ui/TocResizer";
import { VisibleRolesBadges } from "@/components/board/VisibleRolesPicker";
import { extractHeadings, type TocItem } from "@/lib/extract-headings";
import { fmtLocalDateTime } from "@/lib/format";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";

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

export default function BoardDetailPage() {
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
      router.push("/board");
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
  // 본문 렌더 후 heading 추출. 내용이 비동기로 채워지므로 post.content 의존.
  useEffect(() => {
    if (!post?.content) {
      setHeadings([]);
      return;
    }
    // 렌더 직후 다음 tick 에 추출 — DOM 이 준비된 후.
    const t = setTimeout(() => {
      setHeadings(extractHeadings(viewerRef.current));
    }, 0);
    return () => clearTimeout(t);
  }, [post?.content]);

  if (!post) {
    return (
      <>
        <DashboardHeader title="게시판" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  const canEdit = me?.role === "ADMIN" || me?.id === post.author_id;

  return (
    <>
      <DashboardHeader
        title="게시판"
        actions={
          <div className="flex gap-2">
            <Link
              href="/board"
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
                  href={`/board/${id}/edit`}
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
          {/* TipTap HTML 저장글 vs legacy markdown 자동 감지.
              `<` 로 시작하면 TipTap 렌더, 아니면 PostMarkdown fallback. */}
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
        {/* 코멘트 — read 권한자 누구나 작성. */}
        <CommentsSection postId={id} />
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


// ---------------------------------------------------------------------------
// 코멘트 섹션 — 글에 달리는 코멘트 (TipTap HTML).
// 읽기·작성 = 글을 볼 수 있는 사용자 모두. 편집·삭제 = 작성자 + ADMIN
// (백엔드 _can_edit_comment 가 강제, 프론트는 can_edit 으로 버튼 노출 가드).
// ---------------------------------------------------------------------------

type Comment = {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
};

// 코멘트 박스 height — 본문 에디터(min-h-[300px]) 의 1/4. 신규/답글/편집 모두 동일.
const COMMENT_EDITOR_MIN_HEIGHT = 75;

function CommentsSection({ postId }: { postId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // 답글 박스 — 어느 부모 코멘트 아래에 열려 있는지 + 그 박스의 본문.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");

  const { data: comments = [], isLoading } = useQuery<Comment[]>({
    queryKey: ["board-comments", postId],
    queryFn: async () =>
      (await api.get(`/board/posts/${postId}/comments`)).data,
  });

  // 평면 list → 트리 그룹 (parent_id 기준). N 레벨 깊이 무제한.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of comments) {
      const key = c.parent_id ?? "__root__";
      const arr = m.get(key) ?? [];
      arr.push(c);
      m.set(key, arr);
    }
    // 같은 그룹 내 시간순 정렬 (서버도 ASC 지만 방어적).
    for (const arr of m.values()) {
      arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return m;
  }, [comments]);
  const roots = childrenByParent.get("__root__") ?? [];

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["board-comments", postId] });

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post(`/board/posts/${postId}/comments`, { body: draft })).data,
    onSuccess: () => {
      setDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "작성 실패", { title: "오류" }),
  });

  // 답글 작성 — parent_id 를 함께 보냄.
  const replyM = useMutation({
    mutationFn: async () => {
      if (!replyingTo) throw new Error("부모 코멘트 미지정");
      return (
        await api.post(`/board/posts/${postId}/comments`, {
          body: replyDraft,
          parent_id: replyingTo,
        })
      ).data;
    },
    onSuccess: () => {
      setReplyingTo(null);
      setReplyDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "답글 작성 실패", {
        title: "오류",
      }),
  });

  const editM = useMutation({
    mutationFn: async (cid: string) =>
      (await api.patch(`/board/comments/${cid}`, { body: editDraft })).data,
    onSuccess: () => {
      setEditingId(null);
      setEditDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "수정 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (cid: string) =>
      api.delete(`/board/comments/${cid}`),
    onSuccess: refresh,
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  function openReply(target: Comment) {
    setReplyingTo(target.id);
    setReplyDraft("");
    // 동시에 다른 편집 모드는 닫기.
    setEditingId(null);
  }

  function cancelReply() {
    setReplyingTo(null);
    setReplyDraft("");
  }

  // 코멘트 1개 + 그 자손들을 재귀 렌더. depth 는 들여쓰기·border 색 변화 용도.
  function renderNode(c: Comment, depth: number): React.ReactNode {
    const children = childrenByParent.get(c.id) ?? [];
    return (
      <li key={c.id} className="space-y-2">
        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex items-center justify-between mb-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {c.author_name ?? "(작성자 없음)"}
              </span>
              <span className="text-muted-foreground">
                {fmtLocalDateTime(c.created_at)}
                {c.updated_at !== c.created_at && " · 수정됨"}
              </span>
            </div>
            {editingId !== c.id && (
              <div className="flex items-center gap-1 text-muted-foreground">
                <button
                  type="button"
                  onClick={() => openReply(c)}
                  className="hover:text-foreground"
                >
                  답글
                </button>
                {c.can_edit && (
                  <>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditDraft(c.body);
                        setReplyingTo(null);
                      }}
                      className="hover:text-foreground inline-flex items-center gap-0.5"
                    >
                      <Pencil className="h-3 w-3" /> 수정
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await dialog.confirm(
                          children.length > 0
                            ? `이 코멘트와 그 답글 ${children.length}개 (이하 모두) 를 삭제하시겠습니까?`
                            : "이 코멘트를 삭제하시겠습니까?",
                          {
                            title: "코멘트 삭제",
                            confirmText: "삭제",
                            destructive: true,
                          },
                        );
                        if (ok) deleteM.mutate(c.id);
                      }}
                      className="hover:text-red-500 inline-flex items-center gap-0.5"
                    >
                      <Trash2 className="h-3 w-3" /> 삭제
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {editingId === c.id ? (
            <>
              <div className="rounded-md border border-input bg-background overflow-hidden">
                <TipTapEditor
                  value={editDraft}
                  onChange={setEditDraft}
                  minHeight={COMMENT_EDITOR_MIN_HEIGHT}
                />
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setEditDraft("");
                  }}
                  className="rounded-md border border-input bg-background px-3 h-7 text-xs hover:bg-muted"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={editM.isPending || !editDraft.trim()}
                  onClick={() => editM.mutate(c.id)}
                  className="rounded-md bg-primary px-3 h-7 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                >
                  저장
                </button>
              </div>
            </>
          ) : (
            <div className="text-sm">
              <TipTapViewer html={c.body} />
            </div>
          )}
        </div>

        {/* 답글 입력 박스 — 이 코멘트 아래에 attached. */}
        {replyingTo === c.id && (
          <div className="ml-6 border-l-2 border-primary/40 pl-3">
            <div className="rounded-md border border-input bg-background overflow-hidden">
              <TipTapEditor
                value={replyDraft}
                onChange={setReplyDraft}
                placeholder="답글 작성..."
                minHeight={COMMENT_EDITOR_MIN_HEIGHT}
              />
            </div>
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={cancelReply}
                className="rounded-md border border-input bg-background px-3 h-7 text-xs hover:bg-muted"
              >
                취소
              </button>
              <button
                type="button"
                disabled={
                  replyM.isPending ||
                  !replyDraft.trim() ||
                  replyDraft === "<p></p>"
                }
                onClick={() => replyM.mutate()}
                className="rounded-md bg-primary px-3 h-7 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                답글 작성
              </button>
            </div>
          </div>
        )}

        {/* 자식 코멘트 — N 레벨 들여쓰기 (border-l 로 시각 계층 표현). */}
        {children.length > 0 && (
          <ul className="ml-6 space-y-2 border-l-2 border-border pl-3">
            {children.map((ch) => renderNode(ch, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
        <MessageSquare className="h-3.5 w-3.5" />
        코멘트
        <span className="text-xs text-muted-foreground ml-1 tabular-nums font-normal">
          {comments.length}
        </span>
      </h3>

      <div className="rounded-md border border-input bg-background overflow-hidden mb-3">
        <TipTapEditor
          value={draft}
          onChange={setDraft}
          placeholder="코멘트 작성..."
          minHeight={COMMENT_EDITOR_MIN_HEIGHT}
        />
      </div>
      <div className="flex justify-end mb-3">
        <button
          type="button"
          disabled={createM.isPending || !draft.trim() || draft === "<p></p>"}
          onClick={() => createM.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          작성
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : roots.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">
          아직 코멘트가 없습니다.
        </div>
      ) : (
        <ul className="space-y-3">{roots.map((c) => renderNode(c, 0))}</ul>
      )}
    </div>
  );
}
