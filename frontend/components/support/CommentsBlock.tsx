"use client";

/**
 * 기술지원 (케이스/로그) 공용 코멘트 블록.
 *
 * 본인(작성자) 또는 ADMIN/SUPER_ADMIN 만 수정·삭제 — 서버에서도 동일 가드.
 * UI 는 추가/수정/삭제만 노출하고, 권한 부족 시 버튼이 안 보임.
 *
 * 신규 생성 모드(`recordId` 없음) 에서는 코멘트 추가 불가 — 케이스/로그 본체
 * 저장 후 다시 열어 추가하도록 안내.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { MarkdownInput, PostMarkdown } from "@/components/ui/MarkdownInput";

export type CommentRow = {
  id: string;
  author_user_id: string | null;
  author_name: string | null;
  body: string;
  /** 코멘트별 지원 시간 (분). support-logs 에서만 사용. 그 외는 0 / 무시. */
  duration_minutes?: number;
  /** 코멘트별 지원 시작·종료일 (ISO yyyy-mm-dd). support-logs 에서만 사용. */
  start_date?: string | null;
  end_date?: string | null;
  created_at: string;
  updated_at: string;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

export function CommentsBlock({
  baseUrl,
  recordId,
  resourcePath = "comments",
  comments,
  invalidateKey,
  currentUserId,
  currentUserRole,
  emptyMessage,
  draftPlaceholder,
  rows,
  tall = false,
  showDurationMinutes = false,
}: {
  baseUrl: string;            // "/support-cases" or "/support-logs" or "/developers"
  recordId: string | null;    // null = 신규 생성 모드 (코멘트 추가 비활성)
  // 자원 경로 — default "comments" (지원 케이스/로그 호환). 면담은 "interviews".
  resourcePath?: string;
  comments: CommentRow[];
  invalidateKey: unknown[];   // 부모의 react-query key — 응답 후 invalidate.
  currentUserId: string | null;
  currentUserRole: string | null;
  emptyMessage?: string;
  draftPlaceholder?: string;
  // textarea 높이 — default draft 3 / edit 4. 호출자가 지정 시 둘 다 override.
  rows?: number;
  /** 에디터 최소 높이 2배 (240px). 마크다운 작성 공간이 필요한 페이지에서. */
  tall?: boolean;
  /** true 면 코멘트마다 지원 시간(분) 입력·표시. support-logs 전용. */
  showDurationMinutes?: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [draft, setDraft] = useState("");
  const [draftMinutes, setDraftMinutes] = useState<number>(0);
  const [draftStart, setDraftStart] = useState<string>(todayISO());
  const [draftEnd, setDraftEnd] = useState<string>(todayISO());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [editingMinutes, setEditingMinutes] = useState<number>(0);
  const [editingStart, setEditingStart] = useState<string>(todayISO());
  const [editingEnd, setEditingEnd] = useState<string>(todayISO());
  // 코멘트 수정 직후 3초간 메타 행에 "방금 저장됨" pill 표시.
  const [recentlySavedId, setRecentlySavedId] = useState<string | null>(null);

  const addM = useMutation({
    mutationFn: async (vars: {
      body: string;
      duration_minutes: number;
      start_date?: string;
      end_date?: string;
    }) => (await api.post(`${baseUrl}/${recordId}/${resourcePath}`, vars)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invalidateKey });
      setDraft("");
      setDraftMinutes(0);
      setDraftStart(todayISO());
      setDraftEnd(todayISO());
    },
    // 권한 부족(403) 등 서버 거부를 사용자가 인지할 수 있도록 dialog 로 노출.
    // 미설정 시 react-query 가 콘솔로만 던져 'silent failure' 가 되어버린다.
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "코멘트 추가 실패", {
        title: "오류",
      }),
  });
  const editM = useMutation({
    mutationFn: async (vars: {
      id: string;
      body: string;
      duration_minutes: number;
      start_date?: string;
      end_date?: string;
    }) => {
      const { id, ...payload } = vars;
      return (
        await api.patch(`${baseUrl}/${recordId}/${resourcePath}/${id}`, payload)
      ).data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: invalidateKey });
      setEditingId(null);
      setEditingBody("");
      setEditingMinutes(0);
      setRecentlySavedId(vars.id);
      setTimeout(() => {
        setRecentlySavedId((cur) => (cur === vars.id ? null : cur));
      }, 3000);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "코멘트 수정 실패", {
        title: "오류",
      }),
  });
  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`${baseUrl}/${recordId}/${resourcePath}/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "코멘트 삭제 실패", {
        title: "오류",
      }),
  });

  function canEdit(c: CommentRow): boolean {
    if (currentUserRole === "ADMIN" || currentUserRole === "SUPER_ADMIN") return true;
    return c.author_user_id !== null && c.author_user_id === currentUserId;
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {comments.length === 0 && (
          <li className="text-[11px] text-muted-foreground">{emptyMessage ?? "코멘트가 없습니다."}</li>
        )}
        {comments.map((c) => {
          const editable = canEdit(c);
          const isEditing = editingId === c.id;
          // 시스템 코멘트 — 상태 변경 같은 자동 이벤트. author_user_id 가 null.
          // 별도 톤(회색·점선)으로 inline 렌더, 편집/삭제 UI 비활성.
          const isSystem = c.author_user_id === null;
          if (isSystem) {
            // 본문에 "[시스템] " prefix 가 있으면 떼고 표시 (라벨이 따로 있음).
            const display = c.body.replace(/^\[시스템\]\s*/, "");
            return (
              <li
                key={c.id}
                className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2"
              >
                <span className="inline-flex items-center rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 shrink-0">
                  시스템
                </span>
                <span className="flex-1">{display}</span>
                <span className="tabular-nums shrink-0">{fmtDateTime(c.created_at)}</span>
              </li>
            );
          }
          return (
            <li
              key={c.id}
              className="rounded-md border border-border bg-muted/20 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span>
                    <span className="font-medium text-foreground">
                      {c.author_name ?? "(unknown)"}
                    </span>
                    {" · "}
                    {showDurationMinutes && (c.start_date || c.end_date) ? (
                      <>
                        <span className="tabular-nums">
                          {c.start_date === c.end_date
                            ? c.start_date
                            : `${c.start_date} ~ ${c.end_date}`}
                        </span>
                        {(c.duration_minutes ?? 0) > 0 && (
                          <span className="ml-2 tabular-nums">
                            {c.duration_minutes}분
                          </span>
                        )}
                      </>
                    ) : (
                      fmtDateTime(c.created_at)
                    )}
                    {c.updated_at !== c.created_at && " (수정됨)"}
                  </span>
                  {recentlySavedId === c.id && (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      방금 저장됨
                    </span>
                  )}
                </span>
                {editable && !isEditing && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditingBody(c.body);
                        setEditingMinutes(c.duration_minutes ?? 0);
                        setEditingStart(c.start_date || todayISO());
                        setEditingEnd(c.end_date || todayISO());
                      }}
                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                    >
                      <Pencil className="h-3 w-3" /> 수정
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await dialog.confirm(
                          "이 코멘트를 삭제하시겠습니까?",
                          { destructive: true },
                        );
                        if (ok) deleteM.mutate(c.id);
                      }}
                      className="text-destructive hover:underline inline-flex items-center gap-0.5"
                    >
                      <Trash2 className="h-3 w-3" /> 삭제
                    </button>
                  </div>
                )}
              </div>
              {isEditing ? (
                <div className="mt-2 space-y-2">
                  <MarkdownInput
                    value={editingBody}
                    onChange={setEditingBody}
                    size="sm"
                    rows={rows ?? 4}
                    tall={tall}
                    showCounter={false}
                    placeholder="코멘트 수정..."
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {showDurationMinutes ? (
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <label className="flex items-center gap-1.5">
                          시작일
                          <input
                            type="date"
                            value={editingStart}
                            onChange={(e) => setEditingStart(e.target.value)}
                            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                          />
                        </label>
                        <label className="flex items-center gap-1.5">
                          종료일
                          <input
                            type="date"
                            value={editingEnd}
                            onChange={(e) => setEditingEnd(e.target.value)}
                            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                          />
                        </label>
                        <label className="flex items-center gap-1.5">
                          지원 시간
                          <input
                            type="number"
                            min={0}
                            step={5}
                            value={editingMinutes}
                            onChange={(e) =>
                              setEditingMinutes(Math.max(0, Number(e.target.value) || 0))
                            }
                            className="h-7 w-20 rounded-md border border-border bg-background px-2 text-xs tabular-nums text-right"
                          />
                          <span>분</span>
                        </label>
                      </div>
                    ) : (
                      <span />
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingBody("");
                          setEditingMinutes(0);
                        }}
                        className="h-7 rounded-md border border-border bg-background px-3 text-xs"
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const body = editingBody.trim();
                          if (!body) return;
                          editM.mutate({
                            id: c.id,
                            body,
                            duration_minutes: showDurationMinutes ? editingMinutes : 0,
                            start_date: showDurationMinutes ? editingStart : undefined,
                            end_date: showDurationMinutes ? editingEnd : undefined,
                          });
                        }}
                        disabled={editM.isPending || !editingBody.trim()}
                        className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                      >
                        저장
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-1 prose prose-sm font-sans max-w-none">
                  <PostMarkdown content={c.body} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {recordId ? (
        <div className="space-y-2">
          <MarkdownInput
            value={draft}
            onChange={setDraft}
            size="sm"
            rows={rows ?? 3}
            tall={tall}
            showCounter={false}
            placeholder={draftPlaceholder ?? "코멘트 추가... (마크다운 지원)"}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {showDurationMinutes ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                  시작일
                  <input
                    type="date"
                    value={draftStart}
                    onChange={(e) => setDraftStart(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  종료일
                  <input
                    type="date"
                    value={draftEnd}
                    onChange={(e) => setDraftEnd(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  지원 시간
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={draftMinutes}
                    onChange={(e) =>
                      setDraftMinutes(Math.max(0, Number(e.target.value) || 0))
                    }
                    placeholder="0"
                    className="h-8 w-20 rounded-md border border-border bg-background px-2 text-sm tabular-nums text-right"
                  />
                  <span>분</span>
                </label>
              </div>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => {
                const body = draft.trim();
                if (!body) return;
                addM.mutate({
                  body,
                  duration_minutes: showDurationMinutes ? draftMinutes : 0,
                  start_date: showDurationMinutes ? draftStart : undefined,
                  end_date: showDurationMinutes ? draftEnd : undefined,
                });
              }}
              disabled={addM.isPending || !draft.trim()}
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {addM.isPending ? "추가 중..." : "코멘트 추가"}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          저장 후 코멘트를 추가할 수 있습니다.
        </p>
      )}
    </div>
  );
}
