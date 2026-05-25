"use client";

/**
 * 목표 상세 — 본문 + 메타 + 인라인 편집 (can_edit 일 때만).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, Download, Paperclip, Pencil, Save, Trash2 } from "lucide-react";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { api } from "@/lib/api";
import { fmtLocalDateTime } from "@/lib/format";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

const TipTapEditor = dynamic(
  () => import("@/components/board/TipTapEditor").then((m) => m.TipTapEditor),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">…</div> },
);
const TipTapViewer = dynamic(
  () => import("@/components/board/TipTapEditor").then((m) => m.TipTapViewer),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">…</div> },
);

type Goal = {
  id: string;
  scope: "PERSONAL" | "COMPANY";
  year: number;
  owner_id: string | null;
  owner_name: string | null;
  parent_goal_id: string | null;
  parent_title: string | null;
  title: string;
  description: string | null;
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  difficulty: "ROUTINE" | "NORMAL" | "CHALLENGING" | "STRETCH";
  status: "DRAFT" | "IN_PROGRESS" | "AT_RISK" | "DONE" | "DROPPED";
  progress_pct: string | number;
  due_date: string | null;
  self_score: string | number | null;
  self_score_comment: string | null;
  manager_score: string | number | null;
  manager_score_comment: string | null;
  manager_score_by_id: string | null;
  manager_score_by_name: string | null;
  manager_score_at: string | null;
  auto_score: {
    auto_score: number;
    weight: number;
    difficulty_factor: number;
    priority_weight: number;
    category_weight: number;
  } | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_score_self: boolean;
  can_score_manager: boolean;
};

const CATEGORIES = [
  ["BUSINESS", "사업"],
  ["TECH", "기술"],
  ["CAREER", "커리어"],
  ["OPERATIONS", "운영"],
  ["PERSONAL_GROWTH", "자기계발"],
  ["OTHER", "기타"],
] as const;

const PRIORITIES = [
  ["HIGH", "상"],
  ["MEDIUM", "중"],
  ["LOW", "하"],
] as const;

const DIFFICULTIES = [
  ["ROUTINE", "일상 (×0.8)"],
  ["NORMAL", "표준 (×1.0)"],
  ["CHALLENGING", "도전 (×1.5)"],
  ["STRETCH", "도약 (×2.0)"],
] as const;

const STATUSES = [
  ["DRAFT", "초안"],
  ["IN_PROGRESS", "진행중"],
  ["AT_RISK", "위기"],
  ["DONE", "완료"],
  ["DROPPED", "중단"],
] as const;

const STATUS_TONE: Record<Goal["status"], string> = {
  DRAFT: "bg-zinc-100 text-zinc-700",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  AT_RISK: "bg-red-100 text-red-800",
  DONE: "bg-emerald-100 text-emerald-800",
  DROPPED: "bg-zinc-200 text-zinc-700",
};

export default function GoalDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data, isLoading, error } = useQuery<Goal>({
    queryKey: ["goal", id],
    queryFn: async () => (await api.get(`/goals/${id}`)).data,
  });

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Goal>>({});

  useEffect(() => {
    if (data) {
      setForm({
        title: data.title,
        description: data.description,
        category: data.category,
        priority: data.priority,
        difficulty: data.difficulty,
        status: data.status,
        progress_pct: data.progress_pct,
        due_date: data.due_date,
        parent_goal_id: data.parent_goal_id,
      } as Partial<Goal>);
    }
  }, [data]);

  const saveM = useMutation({
    mutationFn: async () => {
      const body: any = { ...form };
      if (typeof body.progress_pct === "string") {
        body.progress_pct = parseFloat(body.progress_pct);
      }
      if (!body.due_date) body.due_date = null;
      if (!body.parent_goal_id) body.parent_goal_id = null;
      return (await api.patch(`/goals/${id}`, body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goal", id] });
      qc.invalidateQueries({ queryKey: ["goals"] });
      setEditing(false);
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/goals/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      router.push("/goals");
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="목표" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <DashboardHeader title="목표" />
        <div className="p-4 text-sm text-red-500">목표를 찾을 수 없습니다.</div>
      </>
    );
  }

  const pct =
    typeof data.progress_pct === "string"
      ? parseFloat(data.progress_pct)
      : data.progress_pct;

  return (
    <>
      <DashboardHeader title="목표 상세" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto max-w-3xl">
        <Link
          href="/goals"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 목표 목록으로
        </Link>

        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          {/* 메타 헤더 */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] " +
                    STATUS_TONE[data.status]
                  }
                >
                  {STATUSES.find(([v]) => v === data.status)?.[1] ?? data.status}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {CATEGORIES.find(([v]) => v === data.category)?.[1] ?? data.category}
                </span>
                <span className="text-xs text-muted-foreground">
                  · 우선순위 {PRIORITIES.find(([v]) => v === data.priority)?.[1]}
                </span>
                <span className="text-xs text-muted-foreground">
                  · 난이도 {DIFFICULTIES.find(([v]) => v === data.difficulty)?.[1]}
                </span>
                <span className="text-xs text-muted-foreground">
                  · {data.year}년 · {data.scope === "COMPANY" ? "회사" : data.owner_name ?? "—"}
                </span>
              </div>
              <h1 className="text-lg font-semibold">{data.title}</h1>
              {data.parent_title && (
                <div className="text-xs text-muted-foreground mt-1">
                  ↳ 회사 목표:{" "}
                  <Link
                    href={`/goals/${data.parent_goal_id}`}
                    className="underline hover:text-foreground"
                  >
                    {data.parent_title}
                  </Link>
                </div>
              )}
            </div>
            {data.can_edit && !editing && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
                >
                  편집
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await dialog.confirm(
                      <span>
                        이 목표를 삭제하시겠습니까?
                      </span>,
                      { title: "목표 삭제", confirmText: "삭제", destructive: true },
                    );
                    if (ok) deleteM.mutate();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-background px-3 h-8 text-xs text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* 진행률 bar */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">진행률</span>
              <span className="text-xs tabular-nums font-medium">
                {pct.toFixed(0)}%
                {pct > 100 && (
                  <span className="ml-1 text-purple-600">
                    ✨ +{(pct - 100).toFixed(0)}% 초과
                  </span>
                )}
              </span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={
                  "h-full rounded-full " +
                  (pct > 100
                    ? "bg-purple-500"
                    : data.status === "AT_RISK"
                      ? "bg-red-500"
                      : data.status === "DONE"
                        ? "bg-emerald-500"
                        : "bg-primary")
                }
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
          </div>

          {/* 점수 패널 — PERSONAL goal 만 노출 */}
          {data.scope === "PERSONAL" && (
            <ScorePanel data={data} onChanged={() => qc.invalidateQueries({ queryKey: ["goal", id] })} />
          )}

          {/* 본문 / 편집 폼 */}
          {!editing ? (
            <div className="pt-3 border-t border-border">
              <div className="text-xs font-semibold text-muted-foreground mb-2">설명</div>
              {data.description ? (
                <TipTapViewer html={data.description} />
              ) : (
                <p className="text-sm text-muted-foreground italic">(내용 없음)</p>
              )}
              <div className="text-[10px] text-muted-foreground mt-3">
                작성 {data.created_at.slice(0, 10)} · 수정 {data.updated_at.slice(0, 10)}
                {data.due_date && ` · 마감 ${data.due_date}`}
              </div>
            </div>
          ) : (
            <div className="pt-3 border-t border-border space-y-3">
              <Field label="제목">
                <input
                  type="text"
                  value={form.title ?? ""}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <div className="grid grid-cols-4 gap-3">
                <Field label="분류">
                  <select
                    value={form.category as string}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={inputClass}
                  >
                    {CATEGORIES.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </Field>
                <Field label="우선순위">
                  <select
                    value={form.priority as string}
                    onChange={(e) => setForm({ ...form, priority: e.target.value as any })}
                    className={inputClass}
                  >
                    {PRIORITIES.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </Field>
                <Field label="난이도">
                  <select
                    value={(form as any).difficulty ?? "NORMAL"}
                    onChange={(e) => setForm({ ...form, difficulty: e.target.value as any })}
                    className={inputClass}
                  >
                    {DIFFICULTIES.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </Field>
                <Field label="상태">
                  <select
                    value={form.status as string}
                    onChange={async (e) => {
                      const next = e.target.value as Goal["status"];
                      // DONE 으로 전환 시 — 진행률이 100 미만이면 자동 100% 변경 묻기.
                      if (next === "DONE" && Number(form.progress_pct ?? 0) < 100) {
                        const ok = await dialog.confirm(
                          <span>
                            완료 처리 시 진행률을 <b>100%</b> 로 변경하시겠습니까? 100%
                            가 되어야 종합 점수에 완료가 반영됩니다.
                          </span>,
                          {
                            title: "목표 완료",
                            confirmText: "100% 로 변경",
                            cancelText: "현재 진행률 유지",
                          },
                        );
                        setForm({
                          ...form,
                          status: next,
                          progress_pct: ok ? 100 : form.progress_pct,
                        });
                        return;
                      }
                      setForm({ ...form, status: next });
                    }}
                    className={inputClass}
                  >
                    {STATUSES.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="진행률 (%)">
                  <input
                    type="number"
                    value={String(form.progress_pct ?? 0)}
                    onChange={(e) =>
                      setForm({ ...form, progress_pct: Number(e.target.value) })
                    }
                    min={0}
                    max={200}
                    className={inputClass + " tabular-nums"}
                  />
                </Field>
                <Field label="마감일">
                  <input
                    type="date"
                    value={form.due_date ?? ""}
                    onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              </div>
              <Field label="설명">
                <div className="rounded-md border border-input bg-background overflow-hidden">
                  <TipTapEditor
                    value={form.description ?? ""}
                    onChange={(html) => setForm({ ...form, description: html })}
                  />
                </div>
              </Field>

              <NotificationInfoBox />

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-4 h-8 text-xs hover:bg-muted"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={saveM.isPending || !(form.title ?? "").trim()}
                  onClick={() => saveM.mutate()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> 저장
                </button>
              </div>
            </div>
          )}
        </div>

        <AttachmentsSection goalId={id} />

        <CommentsSection goalId={id} />
      </div>
    </>
  );
}

const inputClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 점수 패널 — 자동 점수 + 자기 평가 + 매니저 평가 입력
// ---------------------------------------------------------------------------

function ScorePanel({
  data,
  onChanged,
}: {
  data: Goal;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const auto = data.auto_score?.auto_score ?? 0;
  const selfScore = data.self_score == null ? null : Number(data.self_score);
  const mgrScore = data.manager_score == null ? null : Number(data.manager_score);

  const [editingSelf, setEditingSelf] = useState(false);
  const [editingMgr, setEditingMgr] = useState(false);
  const [selfDraft, setSelfDraft] = useState({
    score: selfScore ?? Math.round(auto),
    comment: data.self_score_comment ?? "",
  });
  const [mgrDraft, setMgrDraft] = useState({
    score: mgrScore ?? Math.round(auto),
    comment: data.manager_score_comment ?? "",
  });

  const saveSelfM = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/goals/${data.id}/score-self`, {
          score: selfDraft.score,
          comment: selfDraft.comment || null,
        })
      ).data,
    onSuccess: () => {
      setEditingSelf(false);
      onChanged();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const saveMgrM = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/goals/${data.id}/score-manager`, {
          score: mgrDraft.score,
          comment: mgrDraft.comment || null,
        })
      ).data,
    onSuccess: () => {
      setEditingMgr(false);
      onChanged();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <h3 className="text-xs font-semibold text-muted-foreground mb-2">평가 점수</h3>
      <div className="grid grid-cols-3 gap-3">
        {/* 자동 */}
        <ScoreBlock
          title="자동"
          subtitle={`진행률 × ${data.auto_score?.difficulty_factor ?? 1.0} (난이도)`}
          score={auto}
          color="primary"
        />
        {/* 자기 평가 */}
        <ScoreBlock
          title="자기 평가"
          subtitle={data.self_score_comment ?? (selfScore !== null ? "" : "미입력")}
          score={selfScore}
          color="emerald"
          actionLabel={data.can_score_self ? (selfScore !== null ? "수정" : "입력") : null}
          onAction={() => {
            setSelfDraft({
              score: selfScore ?? Math.round(auto),
              comment: data.self_score_comment ?? "",
            });
            setEditingSelf(true);
          }}
        />
        {/* 매니저 평가 */}
        <ScoreBlock
          title="매니저 평가"
          subtitle={
            mgrScore !== null
              ? `${data.manager_score_by_name ?? "—"}${
                  data.manager_score_at
                    ? " · " + data.manager_score_at.slice(0, 10)
                    : ""
                }`
              : data.can_score_manager ? "" : "미입력"
          }
          score={mgrScore}
          color="amber"
          actionLabel={data.can_score_manager ? (mgrScore !== null ? "수정" : "입력") : null}
          onAction={() => {
            setMgrDraft({
              score: mgrScore ?? Math.round(auto),
              comment: data.manager_score_comment ?? "",
            });
            setEditingMgr(true);
          }}
        />
      </div>

      {(editingSelf || editingMgr) && (
        <Dialog
          open
          onClose={() => {
            setEditingSelf(false);
            setEditingMgr(false);
          }}
          title={editingSelf ? "자기 평가" : "매니저 평가"}
        >
          <div className="space-y-3 min-w-[24rem]">
            <Field label="점수 (0 ~ 150)">
              <input
                type="number"
                value={editingSelf ? selfDraft.score : mgrDraft.score}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (editingSelf) setSelfDraft({ ...selfDraft, score: v });
                  else setMgrDraft({ ...mgrDraft, score: v });
                }}
                min={0}
                max={150}
                className={inputClass + " tabular-nums"}
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                자동 점수 {auto.toFixed(0)} 참고. 100 = 표준 달성, 120+ = S 등급 기여.
              </div>
            </Field>
            <Field label="코멘트 (선택)">
              <textarea
                value={editingSelf ? selfDraft.comment : mgrDraft.comment}
                onChange={(e) => {
                  if (editingSelf) setSelfDraft({ ...selfDraft, comment: e.target.value });
                  else setMgrDraft({ ...mgrDraft, comment: e.target.value });
                }}
                rows={4}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
                placeholder="평가 근거·맥락"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingSelf(false);
                  setEditingMgr(false);
                }}
                className="rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => (editingSelf ? saveSelfM.mutate() : saveMgrM.mutate())}
                disabled={saveSelfM.isPending || saveMgrM.isPending}
                className="rounded-md bg-primary px-3 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                저장
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function ScoreBlock({
  title,
  subtitle,
  score,
  color,
  actionLabel,
  onAction,
}: {
  title: string;
  subtitle?: string;
  score: number | null;
  color: "primary" | "emerald" | "amber";
  actionLabel?: string | null;
  onAction?: () => void;
}) {
  const colorTone =
    color === "primary"
      ? "text-primary"
      : color === "emerald"
        ? "text-emerald-600"
        : "text-amber-600";
  return (
    <div className="rounded-md bg-background p-2.5 border border-border">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="text-xs text-primary hover:underline"
          >
            {actionLabel}
          </button>
        )}
      </div>
      <div className={"text-2xl font-semibold tabular-nums mt-1 " + colorTone}>
        {score === null ? "—" : score.toFixed(0)}
        {score !== null && (
          <span className="text-xs text-muted-foreground font-normal ml-1">
            / 150
          </span>
        )}
      </div>
      {subtitle && (
        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {subtitle}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 첨부파일 — 본인/직속 매니저/HR/ADMIN 업로드·삭제·이름변경.
//   다운로드는 조회 권한자 모두. 드래그앤드롭 + N개 업로드.
// ---------------------------------------------------------------------------

type Attachment = {
  id: string;
  goal_id: string;
  file_name: string;
  mime_type: string | null;
  size: number;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  created_at: string;
  updated_at: string;
  can_modify: boolean;
};

function AttachmentsSection({ goalId }: { goalId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const { data: items = [], isLoading } = useQuery<Attachment[]>({
    queryKey: ["goal-attachments", goalId],
    queryFn: async () => (await api.get(`/goals/${goalId}/attachments`)).data,
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["goal-attachments", goalId] });

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(`/goals/${goalId}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: refresh,
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "업로드 실패", { title: "오류" }),
  });

  const renameM = useMutation({
    mutationFn: async (vars: { id: string; name: string }) =>
      (
        await api.patch(`/goals/${goalId}/attachments/${vars.id}`, {
          file_name: vars.name,
        })
      ).data,
    onSuccess: () => {
      setRenamingId(null);
      setRenameDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "이름 변경 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (aid: string) =>
      api.delete(`/goals/${goalId}/attachments/${aid}`),
    onSuccess: refresh,
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  async function downloadFile(aid: string, name: string) {
    try {
      const r = await api.get(
        `/goals/${goalId}/attachments/${aid}/download`,
        { responseType: "blob" },
      );
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      dialog.alert(e?.response?.data?.detail ?? "다운로드 실패", { title: "오류" });
    }
  }

  const canModify = items[0]?.can_modify ?? false;
  // items[0] 없으면 권한 미상 — 일단 dropzone 노출 (서버가 403 반환 시 alert).
  // 빈 목록일 때 권한 hint 가 없어 dropzone 항상 보이는 게 일관 UX.

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3 inline-flex items-center gap-1.5">
        <Paperclip className="h-3.5 w-3.5" /> 첨부파일
        <span className="text-xs text-muted-foreground tabular-nums ml-1">
          {items.length}
        </span>
      </h3>

      <FileDropZone
        onFiles={(files) => {
          for (const f of files) uploadM.mutate(f);
        }}
        multiple
        label="파일을 끌어놓거나 클릭해서 업로드 (여러 개 가능)"
      />

      {isLoading ? (
        <div className="text-sm text-muted-foreground mt-3">불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground italic mt-3">
          첨부된 파일이 없습니다.
        </div>
      ) : (
        <ul className="mt-3 space-y-1">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 text-xs border-b last:border-0 py-1.5"
            >
              {renamingId === a.id ? (
                <>
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renameDraft.trim())
                        renameM.mutate({ id: a.id, name: renameDraft.trim() });
                      if (e.key === "Escape") {
                        setRenamingId(null);
                        setRenameDraft("");
                      }
                    }}
                    className="flex-1 h-7 rounded-md border border-input bg-background px-2 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      renameDraft.trim() &&
                      renameM.mutate({ id: a.id, name: renameDraft.trim() })
                    }
                    className="text-primary hover:underline"
                  >
                    저장
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(null);
                      setRenameDraft("");
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    취소
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => downloadFile(a.id, a.file_name)}
                    className="text-left hover:underline flex-1 truncate inline-flex items-center gap-1"
                    title={a.file_name}
                  >
                    <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{a.file_name}</span>
                  </button>
                  <span className="text-[10px] text-muted-foreground tabular-nums w-16 text-right">
                    {humanSize(a.size)}
                  </span>
                  <span className="text-[10px] text-muted-foreground w-20 truncate">
                    {a.uploaded_by_name ?? "—"}
                  </span>
                  <AttachmentPreviewButton
                    filename={a.file_name}
                    mime={a.mime_type}
                    downloadPath={`/goals/${goalId}/attachments/${a.id}/download`}
                  />
                  {a.can_modify && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingId(a.id);
                          setRenameDraft(a.file_name);
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        title="이름 변경"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await dialog.confirm(
                            <span>
                              <b>{a.file_name}</b> 파일을 삭제하시겠습니까?
                            </span>,
                            {
                              title: "첨부 삭제",
                              confirmText: "삭제",
                              destructive: true,
                            },
                          );
                          if (ok) deleteM.mutate(a.id);
                        }}
                        className="text-muted-foreground hover:text-red-500"
                        title="삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 코멘트 — 조회 권한자 누구나 작성, 작성자/HR/ADMIN 만 편집·삭제.
// ---------------------------------------------------------------------------

type Comment = {
  id: string;
  goal_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
};

function CommentsSection({ goalId }: { goalId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const { data: comments = [], isLoading } = useQuery<Comment[]>({
    queryKey: ["goal-comments", goalId],
    queryFn: async () => (await api.get(`/goals/${goalId}/comments`)).data,
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["goal-comments", goalId] });

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post(`/goals/${goalId}/comments`, { body: draft })).data,
    onSuccess: () => {
      setDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "작성 실패", { title: "오류" }),
  });

  const editM = useMutation({
    mutationFn: async (cid: string) =>
      (await api.patch(`/goals/${goalId}/comments/${cid}`, { body: editDraft })).data,
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
      api.delete(`/goals/${goalId}/comments/${cid}`),
    onSuccess: refresh,
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">
        코멘트
        <span className="text-xs text-muted-foreground ml-2 tabular-nums">
          {comments.length}
        </span>
      </h3>

      {/* 작성 box */}
      <div className="rounded-md border border-input bg-background overflow-hidden mb-3">
        <TipTapEditor
          value={draft}
          onChange={setDraft}
          placeholder="코멘트 작성..."
        />
      </div>
      <div className="flex justify-end mb-4">
        <button
          type="button"
          disabled={createM.isPending || !draft.trim() || draft === "<p></p>"}
          onClick={() => createM.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          작성
        </button>
      </div>

      {/* 목록 */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : comments.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">
          아직 코멘트가 없습니다.
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className="border border-border rounded-md p-3 bg-background"
            >
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
                {c.can_edit && editingId !== c.id && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditDraft(c.body);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      수정
                    </button>
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await dialog.confirm(
                          "이 코멘트를 삭제하시겠습니까?",
                          { title: "코멘트 삭제", confirmText: "삭제", destructive: true },
                        );
                        if (ok) deleteM.mutate(c.id);
                      }}
                      className="text-muted-foreground hover:text-red-500"
                    >
                      삭제
                    </button>
                  </div>
                )}
              </div>
              {editingId === c.id ? (
                <>
                  <div className="rounded-md border border-input bg-background overflow-hidden">
                    <TipTapEditor value={editDraft} onChange={setEditDraft} />
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotificationInfoBox() {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Bell className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">알림 안내</span>
      </div>
      <ul className="text-xs space-y-1 text-muted-foreground leading-relaxed">
        <li>
          • <b>마감 1개월 전 (D-30) 1회</b> — 담당자 + 직속 매니저
        </li>
        <li>
          • <b>마감일 이후 첫 영업일 1회</b> — 담당자 + 직속 매니저 (토/일·공휴일은
          자동 다음 평일로 이동)
        </li>
        <li>
          • <b>완료(DONE) 처리 시</b> — 직속 매니저에게 즉시 알림
        </li>
        <li className="text-[11px]">
          ※ 회사 목표(COMPANY) 는 ADMIN role 사용자 전체에게 발송 · 매니저 미설정
          시 해당 수신자만 skip · 발송 채널은 Slack/Mattermost (관리자 설정).
        </li>
      </ul>
    </div>
  );
}
