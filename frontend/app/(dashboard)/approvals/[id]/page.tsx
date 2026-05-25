"use client";

/**
 * 결재 상세 — 폼 내용 + 결재선 + 이력 + 액션 (승인/반려/위임/취소/제출/코멘트).
 */

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  Ban,
  Check,
  Download,
  MessageSquare,
  Paperclip,
  Send,
  Trash2,
  Upload,
  UserCheck2,
  X,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { fmtLocalDateTime } from "@/lib/format";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";

const Form = dynamic(
  async () => {
    const [{ default: FormCore }, { default: validator }, theme] = await Promise.all([
      import("@rjsf/core"),
      import("@rjsf/validator-ajv8"),
      import("@/components/approvals/RjsfTableTheme"),
    ]);
    function Bound(props: any) {
      return (
        <FormCore
          validator={validator}
          templates={theme.tableTemplates}
          widgets={theme.tableWidgets}
          {...props}
        />
      );
    }
    return { default: Bound };
  },
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">…</div> },
);

type StepStatus = "PENDING" | "APPROVED" | "REJECTED" | "DELEGATED" | "SKIPPED";
type ReqStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "IN_PROGRESS"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED";

type Step = {
  id: string;
  step_no: number;
  step_name: string;
  approver_id: string | null;
  approver_name: string | null;
  approver_title: string | null;
  status: StepStatus;
  decision_comment: string | null;
  decided_at: string | null;
};

type History = {
  id: string;
  event: string;
  actor_id: string | null;
  actor_name: string | null;
  payload: any | null;
  occurred_at: string;
};

type Detail = {
  id: string;
  kind: string;
  template_id: string;
  template_name: string | null;
  template_version: number;
  form_schema_snapshot: any | null;
  ui_schema_snapshot: any | null;
  title: string;
  requester_id: string;
  requester_name: string | null;
  status: ReqStatus;
  form_data: any;
  submitted_at: string | null;
  completed_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  steps: Step[];
  current_pending_step: {
    step_no: number;
    step_name: string;
    approver_id: string | null;
    approver_name: string | null;
    approver_title: string | null;
    approver_phone: string | null;
    approver_email: string | null;
  } | null;
  history: History[];
  attachments: Array<{
    id: string;
    slot: string | null;
    file_name: string;
    mime_type: string | null;
    size: number;
    uploaded_by_id: string | null;
    uploaded_by_name: string | null;
    created_at: string;
  }>;
  attachment_slots_snapshot: {
    slots: Array<{
      slug: string;
      label: string;
      required?: boolean;
      min_count?: number;
      max_count?: number | null;
      description?: string;
    }>;
  } | null;
  can_edit: boolean;
  can_cancel: boolean;
  can_act_step_id: string | null;
};

const STATUS_LABEL: Record<ReqStatus, string> = {
  DRAFT: "임시저장",
  SUBMITTED: "제출됨",
  IN_PROGRESS: "결재 대기",
  APPROVED: "승인",
  REJECTED: "반려",
  CANCELLED: "취소",
};

const STATUS_TONE: Record<ReqStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-amber-100 text-amber-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
  CANCELLED: "bg-zinc-200 text-zinc-700",
};

const STEP_TONE: Record<StepStatus, string> = {
  PENDING: "border-amber-300 bg-amber-50",
  APPROVED: "border-emerald-300 bg-emerald-50",
  REJECTED: "border-red-300 bg-red-50",
  DELEGATED: "border-zinc-300 bg-zinc-50",
  SKIPPED: "border-zinc-200 bg-zinc-50/50",
};

const STEP_LABEL: Record<StepStatus, string> = {
  PENDING: "대기",
  APPROVED: "승인",
  REJECTED: "반려",
  DELEGATED: "위임",
  SKIPPED: "건너뜀",
};

const EVENT_LABEL: Record<string, string> = {
  CREATED: "생성",
  SUBMITTED: "제출",
  APPROVED: "승인",
  REJECTED: "반려",
  CANCELLED: "취소",
  DELEGATED: "위임",
  COMMENTED: "코멘트",
  TIMEOUT: "시간초과",
};

export default function ApprovalDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data, isLoading, error } = useQuery<Detail>({
    queryKey: ["approval", id],
    queryFn: async () => (await api.get(`/approvals/${id}`)).data,
  });

  const [actionDialog, setActionDialog] = useState<
    null | "approve" | "reject" | "delegate" | "cancel" | "comment"
  >(null);
  const [comment, setComment] = useState("");
  const [delegateTo, setDelegateTo] = useState("");

  // 위임 후보자 (활성 임직원).
  const { data: developers = [] } = useQuery<{ id: string; name: string; tag: string | null }[]>({
    queryKey: ["developers", "active"],
    queryFn: async () =>
      (await api.get("/developers", { params: { status: "ACTIVE" } })).data,
    enabled: actionDialog === "delegate",
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["approval", id] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  }

  const submitM = useMutation({
    mutationFn: async () => (await api.post(`/approvals/${id}/submit`)).data,
    onSuccess: invalidate,
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "제출 실패", { title: "오류" }),
  });

  const cancelM = useMutation({
    mutationFn: async () =>
      (await api.post(`/approvals/${id}/cancel`, { comment })).data,
    onSuccess: () => {
      setActionDialog(null);
      setComment("");
      invalidate();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "취소 실패", { title: "오류" }),
  });

  const approveM = useMutation({
    mutationFn: async () => {
      if (!data?.can_act_step_id) throw new Error("처리할 단계가 없습니다.");
      return (
        await api.post(
          `/approvals/${id}/steps/${data.can_act_step_id}/approve`,
          { comment },
        )
      ).data;
    },
    onSuccess: () => {
      setActionDialog(null);
      setComment("");
      invalidate();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "승인 실패", { title: "오류" }),
  });

  const rejectM = useMutation({
    mutationFn: async () => {
      if (!data?.can_act_step_id) throw new Error("처리할 단계가 없습니다.");
      return (
        await api.post(
          `/approvals/${id}/steps/${data.can_act_step_id}/reject`,
          { comment },
        )
      ).data;
    },
    onSuccess: () => {
      setActionDialog(null);
      setComment("");
      invalidate();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "반려 실패", { title: "오류" }),
  });

  const delegateM = useMutation({
    mutationFn: async () => {
      if (!data?.can_act_step_id) throw new Error("처리할 단계가 없습니다.");
      if (!delegateTo) throw new Error("위임 대상자를 선택하세요.");
      return (
        await api.post(
          `/approvals/${id}/steps/${data.can_act_step_id}/delegate`,
          { delegate_to_developer_id: delegateTo, comment },
        )
      ).data;
    },
    onSuccess: () => {
      setActionDialog(null);
      setComment("");
      setDelegateTo("");
      invalidate();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "위임 실패", { title: "오류" }),
  });

  const commentM = useMutation({
    mutationFn: async () =>
      (await api.post(`/approvals/${id}/comment`, { comment })).data,
    onSuccess: () => {
      setActionDialog(null);
      setComment("");
      invalidate();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "코멘트 실패", { title: "오류" }),
  });

  const readonlyUiSchema = useMemo(
    () => makeReadonlyUiSchema(data?.ui_schema_snapshot),
    [data?.ui_schema_snapshot],
  );

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="결재" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <DashboardHeader title="결재" />
        <div className="p-4 text-sm text-red-500">결재 요청을 찾을 수 없습니다.</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader title="결재 상세" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto max-w-[68rem]">
        <Link
          href="/approvals"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 결재함으로
        </Link>

        {/* 헤더 */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-muted-foreground">
                  {data.template_name ?? data.kind}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  v{data.template_version}
                </span>
                <span
                  className={
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] " +
                    STATUS_TONE[data.status]
                  }
                >
                  {STATUS_LABEL[data.status]}
                </span>
              </div>
              <h1 className="text-base font-semibold">{data.title}</h1>
              <div className="text-xs text-muted-foreground mt-0.5">
                신청자 {data.requester_name ?? "—"} ·{" "}
                {fmtLocalDateTime(data.submitted_at ?? data.created_at)}
                {data.completed_at &&
                  ` → ${fmtLocalDateTime(data.completed_at)}`}
              </div>
              {/* 현재 대기 — IN_PROGRESS 시 누구를 기다리는지 + 연락처. */}
              {data.status === "IN_PROGRESS" && data.current_pending_step && (
                <div className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs">
                  <span className="text-amber-800 font-medium">현재 대기</span>
                  <span className="text-amber-900">
                    {data.current_pending_step.step_no}차
                    {data.current_pending_step.step_name && ` · ${data.current_pending_step.step_name}`}
                  </span>
                  <span className="text-amber-900">
                    →{" "}
                    <b>{data.current_pending_step.approver_name ?? "—"}</b>
                    {data.current_pending_step.approver_title && (
                      <span className="ml-1 text-amber-700">
                        / {data.current_pending_step.approver_title}
                      </span>
                    )}
                  </span>
                  {data.current_pending_step.approver_phone && (
                    <a
                      href={`tel:${data.current_pending_step.approver_phone.replace(/[^0-9+]/g, "")}`}
                      className="inline-flex items-center gap-0.5 text-amber-900 hover:underline tabular-nums"
                      title="전화"
                    >
                      📞 {data.current_pending_step.approver_phone}
                    </a>
                  )}
                  {data.current_pending_step.approver_email && (
                    <a
                      href={`mailto:${data.current_pending_step.approver_email}`}
                      className="inline-flex items-center gap-0.5 text-amber-900 hover:underline"
                      title="이메일"
                    >
                      📧 {data.current_pending_step.approver_email}
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
              {data.status === "DRAFT" && (
                <button
                  type="button"
                  onClick={() => submitM.mutate()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 h-8 text-xs text-primary-foreground hover:bg-brand-dark"
                >
                  <Send className="h-3.5 w-3.5" /> 제출
                </button>
              )}
              {data.can_act_step_id && (
                <>
                  <button
                    type="button"
                    onClick={() => setActionDialog("approve")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 h-8 text-xs text-white hover:bg-emerald-700"
                  >
                    <Check className="h-3.5 w-3.5" /> 승인
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionDialog("reject")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 h-8 text-xs text-white hover:bg-red-700"
                  >
                    <X className="h-3.5 w-3.5" /> 반려
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionDialog("delegate")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
                  >
                    <UserCheck2 className="h-3.5 w-3.5" /> 위임
                  </button>
                </>
              )}
              {data.can_cancel && (
                <button
                  type="button"
                  onClick={() => setActionDialog("cancel")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
                >
                  <Ban className="h-3.5 w-3.5" /> 취소
                </button>
              )}
              <button
                type="button"
                onClick={() => setActionDialog("comment")}
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
              >
                <MessageSquare className="h-3.5 w-3.5" /> 코멘트
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_22rem] gap-4">
          {/* 좌 — 폼 내용 */}
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-semibold mb-3 text-muted-foreground">신청 내용</h3>
              {data.form_schema_snapshot ? (
                <Form
                  schema={data.form_schema_snapshot}
                  uiSchema={readonlyUiSchema}
                  formData={data.form_data}
                  disabled={true}
                  onChange={() => {
                    /* read-only */
                  }}
                  onSubmit={() => {
                    /* no-op */
                  }}
                >
                  <div />
                </Form>
              ) : (
                <pre className="text-xs whitespace-pre-wrap font-mono">
                  {JSON.stringify(data.form_data, null, 2)}
                </pre>
              )}
            </div>

            {/* 첨부 */}
            <AttachmentsCard data={data} onChange={invalidate} />

            {/* 이력 */}
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-semibold mb-3 text-muted-foreground">이력</h3>
              <ul className="space-y-1.5">
                {data.history.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-start gap-2 text-xs border-b last:border-0 pb-1.5"
                  >
                    <span className="text-muted-foreground tabular-nums w-32 shrink-0">
                      {fmtLocalDateTime(h.occurred_at)}
                    </span>
                    <span className="font-medium w-12 shrink-0">
                      {EVENT_LABEL[h.event] ?? h.event}
                    </span>
                    <span className="w-24 shrink-0">{h.actor_name ?? "—"}</span>
                    {h.payload?.comment && (
                      <span className="text-muted-foreground">{h.payload.comment}</span>
                    )}
                    {h.payload?.to_name && (
                      <span className="text-muted-foreground">
                        → {h.payload.to_name}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 우 — 결재선 */}
          <div className="rounded-lg border border-border bg-card p-4 h-fit sticky top-2">
            <h3 className="text-xs font-semibold mb-3 text-muted-foreground">결재선</h3>
            <ol className="space-y-1.5">
              {data.steps.map((s) => (
                <li
                  key={s.id}
                  className={
                    "rounded-md border p-2 text-sm " + STEP_TONE[s.status]
                  }
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary text-[10px] text-primary-foreground tabular-nums">
                        {s.step_no}
                      </span>
                      <span className="font-medium text-xs">{s.step_name}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {STEP_LABEL[s.status]}
                    </span>
                  </div>
                  <div className="text-xs mt-1">
                    {s.approver_name ?? (
                      <span className="text-red-500">결재자 미정</span>
                    )}
                    {s.approver_title && (
                      <span className="text-muted-foreground"> ({s.approver_title})</span>
                    )}
                  </div>
                  {s.decision_comment && (
                    <div className="text-xs text-muted-foreground mt-1 italic">
                      "{s.decision_comment}"
                    </div>
                  )}
                  {s.decided_at && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {fmtLocalDateTime(s.decided_at)}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {/* Action dialogs — 공통 코멘트 입력 */}
      {actionDialog && (
        <Dialog
          open
          onClose={() => setActionDialog(null)}
          title={
            actionDialog === "approve"
              ? "결재 승인"
              : actionDialog === "reject"
                ? "결재 반려"
                : actionDialog === "delegate"
                  ? "결재 위임"
                  : actionDialog === "cancel"
                    ? "결재 취소"
                    : "코멘트 추가"
          }
        >
          <div className="space-y-3 min-w-[20rem]">
            {actionDialog === "delegate" && (
              <div>
                <label className="text-xs font-medium">위임 대상자</label>
                <select
                  value={delegateTo}
                  onChange={(e) => setDelegateTo(e.target.value)}
                  className="mt-1 w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">선택…</option>
                  {developers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.tag ? ` (${d.tag})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs font-medium">
                {actionDialog === "reject" ? "반려 사유 (필수)" : "코멘트 (선택)"}
              </label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm"
                placeholder={
                  actionDialog === "reject"
                    ? "반려 사유를 입력하세요"
                    : "코멘트를 입력하세요"
                }
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setActionDialog(null);
                  setComment("");
                  setDelegateTo("");
                }}
                className="rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
              >
                닫기
              </button>
              <button
                type="button"
                disabled={
                  (actionDialog === "reject" && !comment.trim()) ||
                  (actionDialog === "comment" && !comment.trim()) ||
                  (actionDialog === "delegate" && !delegateTo)
                }
                onClick={() => {
                  if (actionDialog === "approve") approveM.mutate();
                  else if (actionDialog === "reject") rejectM.mutate();
                  else if (actionDialog === "delegate") delegateM.mutate();
                  else if (actionDialog === "cancel") cancelM.mutate();
                  else if (actionDialog === "comment") commentM.mutate();
                }}
                className={
                  "rounded-md px-3 h-8 text-xs text-white disabled:opacity-50 " +
                  (actionDialog === "reject" || actionDialog === "cancel"
                    ? "bg-red-600 hover:bg-red-700"
                    : actionDialog === "approve"
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : "bg-primary hover:bg-brand-dark")
                }
              >
                확인
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * ui_schema 에 모든 필드 disabled 가 들어가도록 깊이 동작.
 * 단순화 — `ui:disabled: true` 한 줄로 rjsf 가 자식에 propagate 하지 않으므로
 * 우리는 Form 의 `disabled` prop 을 사용하고 ui_schema 는 그대로 둔다.
 */
function makeReadonlyUiSchema(ui: any): any {
  return ui ?? {};
}

// ---------------------------------------------------------------------------
// 첨부 카드 — 결재 요청에 영수증/계약서 등 파일 추가/다운로드/삭제.
// ---------------------------------------------------------------------------

function AttachmentsCard({
  data,
  onChange,
}: {
  data: Detail;
  onChange: () => void;
}) {
  const dialog = useDialog();
  const canModify =
    data.can_cancel ||
    data.can_edit ||
    data.status === "DRAFT" ||
    data.status === "IN_PROGRESS" ||
    data.status === "SUBMITTED";

  const slots = data.attachment_slots_snapshot?.slots ?? [];

  const uploadM = useMutation({
    mutationFn: async (vars: { file: File; slot: string | null }) => {
      const fd = new FormData();
      fd.append("file", vars.file);
      const url = vars.slot
        ? `/approvals/${data.id}/attachments?slot=${encodeURIComponent(vars.slot)}`
        : `/approvals/${data.id}/attachments`;
      return (
        await api.post(url, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => onChange(),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "업로드 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (aid: string) =>
      api.delete(`/approvals/${data.id}/attachments/${aid}`),
    onSuccess: () => onChange(),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  async function downloadFile(aid: string, name: string) {
    try {
      const r = await api.get(`/approvals/${data.id}/attachments/${aid}/download`, {
        responseType: "blob",
      });
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

  function fileRow(a: Detail["attachments"][number]) {
    return (
      <li
        key={a.id}
        className="flex items-center gap-2 text-xs border-b last:border-0 py-1.5"
      >
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
          downloadPath={`/approvals/${data.id}/attachments/${a.id}/download`}
        />
        {canModify && (
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm(
                <span>
                  <b>{a.file_name}</b> 파일을 삭제하시겠습니까?
                </span>,
                { title: "첨부 삭제", confirmText: "삭제", destructive: true },
              );
              if (ok) deleteM.mutate(a.id);
            }}
            className="text-muted-foreground hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </li>
    );
  }

  function uploadButton(slot: string | null, key: string) {
    return (
      <label
        key={key}
        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted cursor-pointer"
      >
        <Upload className="h-3.5 w-3.5" />
        업로드
        <input
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadM.mutate({ file: f, slot });
            e.target.value = "";
          }}
        />
      </label>
    );
  }

  // 슬롯별 그룹 + 기타.
  const bySlot: Record<string, Detail["attachments"]> = {};
  const other: Detail["attachments"] = [];
  for (const a of data.attachments) {
    if (a.slot) {
      (bySlot[a.slot] ??= []).push(a);
    } else {
      other.push(a);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-muted-foreground inline-flex items-center gap-1.5 mb-3">
        <Paperclip className="h-3.5 w-3.5" /> 첨부파일
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          ({data.attachments.length})
        </span>
      </h3>

      {slots.length === 0 ? (
        // 슬롯이 없는 양식 — 평면 리스트 + 단일 업로드 버튼.
        <div>
          <div className="flex justify-end mb-2">{canModify && uploadButton(null, "single")}</div>
          {data.attachments.length === 0 ? (
            <div className="text-xs text-muted-foreground">첨부된 파일이 없습니다.</div>
          ) : (
            <ul className="space-y-1">{data.attachments.map(fileRow)}</ul>
          )}
        </div>
      ) : (
        // 슬롯별 그룹화.
        <div className="space-y-3">
          {slots.map((s) => {
            const files = bySlot[s.slug] ?? [];
            const reachedMax =
              s.max_count != null && files.length >= s.max_count;
            return (
              <section key={s.slug}>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs">
                    <span className="font-medium">{s.label}</span>
                    {s.required && (
                      <span className="ml-1 text-red-500 text-[10px]">필수</span>
                    )}
                    {!s.required && (
                      <span className="ml-1 text-muted-foreground text-[10px]">선택</span>
                    )}
                    {s.max_count != null && (
                      <span className="ml-1 text-muted-foreground text-[10px]">
                        (최대 {s.max_count}개)
                      </span>
                    )}
                    {s.description && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {s.description}
                      </div>
                    )}
                  </div>
                  {canModify && !reachedMax && uploadButton(s.slug, s.slug)}
                </div>
                {files.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground italic pl-2">
                    (첨부 없음)
                  </div>
                ) : (
                  <ul className="space-y-1">{files.map(fileRow)}</ul>
                )}
              </section>
            );
          })}

          {/* 기타 첨부 그룹 */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs">
                <span className="font-medium">기타</span>
                <span className="ml-1 text-muted-foreground text-[10px]">선택</span>
              </div>
              {canModify && uploadButton(null, "other")}
            </div>
            {other.length === 0 ? (
              <div className="text-[10px] text-muted-foreground italic pl-2">
                (첨부 없음)
              </div>
            ) : (
              <ul className="space-y-1">{other.map(fileRow)}</ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
