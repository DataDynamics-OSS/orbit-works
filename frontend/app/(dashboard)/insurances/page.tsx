"use client";

/**
 * 법인 보험 관리 — 카드 레이아웃 + 첨부(다파일) 드래그&드롭.
 *
 * /api/v1/company-insurances CRUD + 자유 업로드 첨부.
 * 카드: 보험사/보험명/상태 뱃지/월납·총납·남은 기간/설계사 연락처.
 */

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Tooltip } from "@/components/ui/Tooltip";

type Status = "PAYING" | "SUSPENDED" | "COMPLETED" | "CANCELED";

type Attachment = {
  id: string;
  insurance_id: string;
  file_name: string;
  mime_type?: string | null;
  size?: number | null;
};

type Insurance = {
  id: string;
  insurer: string;
  name: string;
  planner_name: string | null;
  planner_phone: string | null;
  planner_email: string | null;
  monthly_payment: string | null;
  final_amount: string | null;
  payment_start: string | null;
  payment_end: string | null;
  status: Status;
  memo: string | null;
  attachments: Attachment[];
  created_at: string;
};

type InsuranceForm = {
  insurer: string;
  name: string;
  planner_name: string;
  planner_phone: string;
  planner_email: string;
  monthly_payment: string;
  final_amount: string;
  payment_start: string;
  payment_end: string;
  status: Status;
  memo: string;
};

const BLANK: InsuranceForm = {
  insurer: "",
  name: "",
  planner_name: "",
  planner_phone: "",
  planner_email: "",
  monthly_payment: "",
  final_amount: "",
  payment_start: "",
  payment_end: "",
  status: "PAYING",
  memo: "",
};

const STATUS_LABEL: Record<Status, string> = {
  PAYING: "납입중",
  SUSPENDED: "중지",
  COMPLETED: "완납",
  CANCELED: "해지",
};

const STATUS_COLOR: Record<Status, string> = {
  PAYING: "bg-emerald-100 text-emerald-700 border-emerald-200",
  SUSPENDED: "bg-amber-100 text-amber-700 border-amber-200",
  COMPLETED: "bg-blue-100 text-blue-700 border-blue-200",
  CANCELED: "bg-slate-100 text-slate-600 border-slate-200",
};

function fmtKRW(v: string | number | null | undefined) {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString() + "원";
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

/**
 * 시작일로부터 기준일까지 경과한 "개월 수" — 일 단위까지 반영한 분수.
 * 예: 2025-01-15 ~ 2026-04-24 → 15.3개월.
 * - start 가 미래면 0
 * - anchor 이 start 이전이면 0
 */
function monthsElapsed(start: Date, anchor: Date): number {
  if (anchor < start) return 0;
  const years = anchor.getFullYear() - start.getFullYear();
  const months = anchor.getMonth() - start.getMonth();
  const dayDiff = anchor.getDate() - start.getDate();
  const daysInAnchorMonth = new Date(
    anchor.getFullYear(), anchor.getMonth() + 1, 0,
  ).getDate();
  return years * 12 + months + dayDiff / daysInAnchorMonth;
}

/**
 * 납입 시작일부터 "현재" 까지 월 납입금을 곱한 누적 예상 납입금액.
 * - status=COMPLETED: 완납 시점(payment_end)까지 계산 (이후 증가 중단)
 * - status=CANCELED:  해지 시점까지 계산. 해지일 UI 입력값이 따로 없어 payment_end 사용
 * - status=SUSPENDED: 중지해도 지금까지 납입은 유효 → 오늘까지 계산
 * - status=PAYING:    오늘까지. payment_end 가 이미 지났으면 payment_end 에서 cap
 */
function estimatedPaid(row: Insurance): number | null {
  if (!row.payment_start || !row.monthly_payment) return null;
  const start = new Date(`${row.payment_start}T00:00:00`);
  if (!Number.isFinite(start.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endCap =
    row.payment_end && (row.status === "COMPLETED" || row.status === "CANCELED")
      ? new Date(`${row.payment_end}T00:00:00`)
      : null;
  const paymentEnd = row.payment_end
    ? new Date(`${row.payment_end}T00:00:00`)
    : null;
  const anchor =
    endCap ??
    (paymentEnd && paymentEnd < today ? paymentEnd : today);
  const months = monthsElapsed(start, anchor);
  const monthly = Number(row.monthly_payment);
  if (!Number.isFinite(monthly)) return null;
  return Math.round(months * monthly);
}

export default function InsurancesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: items = [] } = useQuery<Insurance[]>({
    queryKey: ["company-insurances"],
    queryFn: async () => (await api.get("/company-insurances")).data,
  });

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InsuranceForm>(BLANK);
  const [error, setError] = useState<string | null>(null);

  const editing = useMemo(
    () => (editingId ? items.find((i) => i.id === editingId) ?? null : null),
    [editingId, items],
  );

  function openCreate() {
    setEditingId(null);
    setForm(BLANK);
    setError(null);
    setOpen(true);
  }

  function openEdit(row: Insurance) {
    setEditingId(row.id);
    setForm({
      insurer: row.insurer,
      name: row.name,
      planner_name: row.planner_name ?? "",
      planner_phone: row.planner_phone ?? "",
      planner_email: row.planner_email ?? "",
      monthly_payment: row.monthly_payment ?? "",
      final_amount: row.final_amount ?? "",
      payment_start: row.payment_start ?? "",
      payment_end: row.payment_end ?? "",
      status: row.status,
      memo: row.memo ?? "",
    });
    setError(null);
    setOpen(true);
  }

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        insurer: form.insurer,
        name: form.name,
        planner_name: form.planner_name || null,
        planner_phone: form.planner_phone || null,
        planner_email: form.planner_email || null,
        monthly_payment: form.monthly_payment || null,
        final_amount: form.final_amount || null,
        payment_start: form.payment_start || null,
        payment_end: form.payment_end || null,
        status: form.status,
        memo: form.memo || null,
      };
      if (editingId) {
        return (await api.patch(`/company-insurances/${editingId}`, payload)).data as Insurance;
      }
      return (await api.post("/company-insurances", payload)).data as Insurance;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["company-insurances"] });
      if (!editingId) setEditingId(row.id);
      setError(null);
    },
    onError: (e: any) => {
      setError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "저장 실패",
      );
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/company-insurances/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-insurances"] });
      setOpen(false);
      setEditingId(null);
    },
  });

  async function handleDelete() {
    if (!editing) return;
    const ok = await dialog.confirm(
      `${editing.insurer} / ${editing.name} 보험을 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (ok) deleteM.mutate(editing.id);
  }

  return (
    <>
      <DashboardHeader title="법인 보험" />
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">총 {items.length}건</div>
          <button
            type="button"
            onClick={openCreate}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-4 w-4" />
            보험 추가
          </button>
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
            등록된 보험이 없습니다. 우측 상단에서 "보험 추가" 로 시작하세요.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {items.map((r) => (
              <InsuranceCard key={r.id} row={r} onClick={() => openEdit(r)} />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setEditingId(null);
        }}
        title={editingId ? "보험 수정" : "보험 추가"}
        width="max-w-3xl"
        footer={
          <>
            {editingId && (
              <button
                type="button"
                onClick={handleDelete}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100 mr-auto"
              >
                <Trash2 className="h-4 w-4" />
                삭제
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setEditingId(null);
              }}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              닫기
            </button>
            <button
              type="button"
              disabled={!form.insurer || !form.name || saveM.isPending}
              onClick={() => saveM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {editingId ? (
                <>
                  <Save className="h-4 w-4" /> 저장
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> 등록
                </>
              )}
            </button>
          </>
        }
      >
        <InsuranceFormBody form={form} setForm={setForm} />
        {editing ? (
          <AttachmentsEditor
            insuranceId={editing.id}
            attachments={editing.attachments}
          />
        ) : (
          <div className="mt-3 text-xs text-muted-foreground">
            먼저 보험을 저장한 뒤 보험증서·약관 등 파일을 업로드할 수 있습니다.
          </div>
        )}
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------

function InsuranceCard({
  row,
  onClick,
}: {
  row: Insurance;
  onClick: () => void;
}) {
  const d = daysUntil(row.payment_end);
  return (
    <div
      onClick={onClick}
      role="button"
      className="rounded-lg border border-border bg-card p-4 shadow-sm hover:shadow-md transition cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">{row.insurer}</div>
          <div className="text-base font-semibold truncate">{row.name}</div>
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_COLOR[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">월 납입</span>
          <span className="tabular-nums">{fmtKRW(row.monthly_payment)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">최종 납입</span>
          <span className="tabular-nums">{fmtKRW(row.final_amount)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">예상 납입</span>
          <span className="tabular-nums">{fmtKRW(estimatedPaid(row))}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">납입기간</span>
          <span>
            {row.payment_start || "?"} ~ {row.payment_end || "?"}
            {d != null && row.status === "PAYING" && (
              <span className={d < 0 ? " text-red-600 ml-1" : d <= 30 ? " text-amber-600 ml-1" : " text-muted-foreground ml-1"}>
                {d < 0 ? `(만료 ${Math.abs(d)}일 경과)` : d === 0 ? "(오늘)" : `(D-${d})`}
              </span>
            )}
          </span>
        </div>
        {row.planner_name && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">설계사</span>
            <span className="truncate">
              {row.planner_name}
              {row.planner_phone ? ` · ${row.planner_phone}` : ""}
            </span>
          </div>
        )}
      </div>

      {row.attachments.length > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          📎 첨부 {row.attachments.length}건
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function InsuranceFormBody({
  form,
  setForm,
}: {
  form: InsuranceForm;
  setForm: React.Dispatch<React.SetStateAction<InsuranceForm>>;
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  function upd<K extends keyof InsuranceForm>(k: K, v: InsuranceForm[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="보험사 *">
        <input
          value={form.insurer}
          onChange={(e) => upd("insurer", e.target.value)}
          placeholder="삼성화재·한화생명 …"
          className={input}
        />
      </Field>
      <Field label="보험명 *">
        <input
          value={form.name}
          onChange={(e) => upd("name", e.target.value)}
          placeholder="단체 건강보험 / 영업배상책임 …"
          className={input}
        />
      </Field>

      <Field label="보험 설계사">
        <input
          value={form.planner_name}
          onChange={(e) => upd("planner_name", e.target.value)}
          className={input}
        />
      </Field>
      <Field label="상태">
        <select
          value={form.status}
          onChange={(e) => upd("status", e.target.value as Status)}
          className={input}
        >
          {(Object.keys(STATUS_LABEL) as Status[]).map((k) => (
            <option key={k} value={k}>
              {STATUS_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="설계사 전화번호">
        <input
          value={form.planner_phone}
          onChange={(e) => upd("planner_phone", e.target.value)}
          placeholder="010-xxxx-xxxx"
          className={input}
        />
      </Field>
      <Field label="설계사 이메일">
        <input
          type="email"
          value={form.planner_email}
          onChange={(e) => upd("planner_email", e.target.value)}
          className={input}
        />
      </Field>

      <Field label="월 납입금 (KRW)">
        <input
          type="text"
          inputMode="numeric"
          value={formatAmt(form.monthly_payment)}
          onChange={(e) => upd("monthly_payment", stripDigits(e.target.value))}
          className={input + " text-right tabular-nums"}
        />
      </Field>
      <Field label="최종 납입금액 (KRW)">
        <input
          type="text"
          inputMode="numeric"
          value={formatAmt(form.final_amount)}
          onChange={(e) => upd("final_amount", stripDigits(e.target.value))}
          className={input + " text-right tabular-nums"}
        />
      </Field>

      <Field label="납입 시작일">
        <DateInput
          value={form.payment_start}
          onChange={(v) => upd("payment_start", v)}
        />
      </Field>
      <Field label="납입 종료일">
        <DateInput
          value={form.payment_end}
          onChange={(v) => upd("payment_end", v)}
        />
      </Field>

      <Field label="메모" colSpan={2}>
        <textarea
          value={form.memo}
          onChange={(e) => upd("memo", e.target.value)}
          rows={3}
          className={input}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${colSpan === 2 ? "col-span-2" : ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function formatAmt(s: string) {
  if (!s) return "";
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "";
}
function stripDigits(s: string) {
  return s.replace(/[^0-9]/g, "");
}

// ---------------------------------------------------------------------------
// 첨부 — 자유 다파일 (보험증서·약관·갱신서 등)
// ---------------------------------------------------------------------------

function AttachmentsEditor({
  insuranceId,
  attachments,
}: {
  insuranceId: string;
  attachments: Attachment[];
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      // 순차 업로드 (백엔드가 file 1개씩 받음). 병렬로 보내도 되지만 용량 큰
      // 경우 네트워크 압박 피하려고 직렬.
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        await api.post(
          `/company-insurances/${insuranceId}/attachments`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-insurances"] }),
  });

  const renameM = useMutation({
    mutationFn: async (v: { id: string; file_name: string }) =>
      api.patch(`/company-insurances/attachments/${v.id}`, {
        file_name: v.file_name,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-insurances"] }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/company-insurances/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-insurances"] }),
  });

  async function handleDownload(att: Attachment) {
    const res = await api.get(
      `/company-insurances/attachments/${att.id}/download`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-4 border-t border-border pt-4 space-y-3">
      <div className="text-sm font-semibold">첨부 파일 ({attachments.length}건)</div>
      <FileDropZone
        multiple
        label="보험증서·약관·갱신서 등 파일을 끌어놓거나 클릭해 업로드"
        onFiles={(files) => uploadM.mutate(files)}
      />
      {attachments.length > 0 && (
        <ul className="space-y-1">
          {attachments.map((att) => (
            <li
              key={att.id}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            >
              <button
                type="button"
                onClick={() => handleDownload(att)}
                className="flex-1 text-left text-primary hover:underline truncate"
              >
                {att.file_name}
              </button>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {((att.size ?? 0) / 1024).toFixed(1)} KB
              </span>
              <Tooltip label="이름 변경" side="top">
                <button
                  type="button"
                  onClick={async () => {
                    const next = await dialog.prompt("파일 표시명", {
                      defaultValue: att.file_name,
                    });
                    if (next && next.trim() && next !== att.file_name) {
                      renameM.mutate({ id: att.id, file_name: next.trim() });
                    }
                  }}
                  className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </Tooltip>
              <Tooltip label="삭제" side="top">
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm("첨부를 삭제하시겠습니까?", {
                        destructive: true,
                      })
                    ) {
                      deleteM.mutate(att.id);
                    }
                  }}
                  className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-2 text-xs text-destructive hover:bg-red-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {uploadM.isPending && (
        <div className="text-[11px] text-muted-foreground">
          <Upload className="inline h-3 w-3 mr-1 animate-pulse" />
          업로드 중...
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) uploadM.mutate(files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
