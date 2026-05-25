"use client";

/**
 * 대출 (Loan) 관리 — 사이드바 RESOURCE 그룹.
 *
 * - 권한: `loans.manage` (HR + ADMIN). 통화 KRW 고정.
 * - 은행 select 는 /bank-accounts 활성 row 에서 채움. 선택값은 bank_account_id
 *   FK 로 저장되며, 백엔드가 bank_name 을 snapshot 으로 함께 보존.
 * - 약정금액·대출잔액·마이너스 한도는 입력 즉시 콤마 포매팅.
 * - 첨부는 드래그앤드롭 다중 업로드 + 파일명 인라인 변경 + 삭제.
 */

import { useMemo, useRef, useState } from "react";
import { ColDef } from "ag-grid-community";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Check,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Tooltip } from "@/components/ui/Tooltip";

type LoanType = "SME_FACILITY" | "SME_GENERAL" | "CORP_OPERATING";
type LoanStatus = "ACTIVE" | "CLOSED";

const LOAN_TYPE_LABEL: Record<LoanType, string> = {
  SME_FACILITY: "중소기업시설자금",
  SME_GENERAL: "중소기업자금",
  CORP_OPERATING: "기업운전일반자금",
};

type Attachment = {
  id: string;
  loan_id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  description: string | null;
  created_at: string;
};

type Loan = {
  id: string;
  bank_account_id: string | null;
  bank_name: string;
  category: string | null;
  loan_type: LoanType;
  bank_account_number: string | null;  // bank_accounts JOIN derived (표시 전용)
  contract_amount: string;
  balance_amount: string;
  interest_pay_day: number | null;
  maturity_date: string | null;
  is_overdraft: boolean;
  overdraft_limit: string | null;
  memo: string | null;
  status: LoanStatus;
  attachments: Attachment[];
  created_at: string;
  updated_at: string;
};

type BankAccountBrief = {
  id: string;
  bank_name: string;
  currency: string;
  account_number: string;
  status: string;
};

type Form = {
  bank_account_id: string;
  category: string;
  loan_type: LoanType | "";
  contract_amount: string;     // 콤마 포함 표시 문자열
  balance_amount: string;
  interest_pay_day: string;     // "" or "1".."31"
  maturity_date: string;
  is_overdraft: boolean;
  overdraft_limit: string;      // 콤마 포함
  memo: string;
  status: LoanStatus;
};

const BLANK_FORM: Form = {
  bank_account_id: "",
  category: "",
  loan_type: "",
  contract_amount: "",
  balance_amount: "",
  interest_pay_day: "",
  maturity_date: "",
  is_overdraft: false,
  overdraft_limit: "",
  memo: "",
  status: "ACTIVE",
};

export default function LoansPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [filterStatus, setFilterStatus] = useState<string>("ACTIVE");
  const [filterType, setFilterType] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<Form>(BLANK_FORM);
  const [addFiles, setAddFiles] = useState<File[]>([]);
  const [addError, setAddError] = useState<string | null>(null);

  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Form>(BLANK_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const { data: rows = [] } = useQuery<Loan[]>({
    queryKey: ["loans", filterStatus, filterType],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filterStatus) params.status_filter = filterStatus;
      if (filterType) params.loan_type = filterType;
      return (await api.get("/loans", { params })).data;
    },
  });

  const { data: bankAccounts = [] } = useQuery<BankAccountBrief[]>({
    queryKey: ["bank-accounts", "active"],
    queryFn: async () =>
      (await api.get("/bank-accounts", { params: { status_filter: "ACTIVE" } }))
        .data,
    staleTime: 60_000,
  });

  const editTarget = useMemo(
    () => rows.find((r) => r.id === editTargetId) ?? null,
    [rows, editTargetId],
  );

  const createM = useMutation({
    mutationFn: async () => {
      const created = (
        await api.post("/loans", formToPayload(addForm))
      ).data as Loan;
      // 첨부 일괄 업로드 — 병렬 POST.
      if (addFiles.length > 0) {
        await Promise.all(
          addFiles.map((f) => {
            const fd = new FormData();
            fd.append("file", f);
            return api.post(`/loans/${created.id}/attachments`, fd, {
              headers: { "Content-Type": "multipart/form-data" },
            });
          }),
        );
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loans"] });
      setAddOpen(false);
      setAddForm(BLANK_FORM);
      setAddFiles([]);
      setAddError(null);
    },
    onError: (e: any) => setAddError(extractError(e) ?? "등록 실패"),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return;
      await api.patch(`/loans/${editTargetId}`, formToPayload(editForm));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loans"] });
      setEditTargetId(null);
      setEditError(null);
    },
    onError: (e: any) => setEditError(extractError(e) ?? "저장 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/loans/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loans"] }),
  });

  async function handleDelete(sel: Loan[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 대출을 종료(CLOSED) 처리하시겠습니까?\n` +
        "(데이터·첨부는 보존됩니다.)",
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  function openEdit(row: Loan) {
    setEditTargetId(row.id);
    setEditForm({
      bank_account_id: row.bank_account_id ?? "",
      category: row.category ?? "",
      loan_type: row.loan_type,
      contract_amount: formatComma(row.contract_amount),
      balance_amount: formatComma(row.balance_amount),
      interest_pay_day: row.interest_pay_day
        ? String(row.interest_pay_day)
        : "",
      maturity_date: row.maturity_date ?? "",
      is_overdraft: row.is_overdraft,
      overdraft_limit: row.overdraft_limit
        ? formatComma(row.overdraft_limit)
        : "",
      memo: row.memo ?? "",
      status: row.status,
    });
    setEditError(null);
  }

  const columnDefs = useMemo<ColDef<Loan>[]>(
    () => [
      { field: "bank_name", headerName: "은행", flex: 0 },
      {
        field: "category",
        headerName: "구분",
        flex: 0,
        valueFormatter: (p) => p.value || "—",
      },
      {
        colId: "loan_type",
        headerName: "종류",
        flex: 0,
        valueGetter: (p) =>
          p.data ? LOAN_TYPE_LABEL[p.data.loan_type] : "",
      },
      {
        colId: "bank_account_number",
        headerName: "계좌번호",
        flex: 0,
        valueGetter: (p) => p.data?.bank_account_number ?? "",
        cellRenderer: (p: any) => (
          <span className="font-mono text-xs">{p.value || "—"}</span>
        ),
      },
      {
        field: "contract_amount",
        headerName: "약정금액",
        flex: 0,
        type: "rightAligned",
        valueFormatter: (p) => `₩ ${formatComma(p.value)}`,
        cellStyle: { textAlign: "right" } as any,
      },
      {
        field: "balance_amount",
        headerName: "대출잔액",
        flex: 0,
        type: "rightAligned",
        valueFormatter: (p) => `₩ ${formatComma(p.value)}`,
        cellStyle: { textAlign: "right" } as any,
      },
      {
        field: "interest_pay_day",
        headerName: "이자납입일",
        flex: 0,
        valueFormatter: (p) => (p.value ? `매월 ${p.value}일` : "—"),
      },
      {
        field: "maturity_date",
        headerName: "만기일자",
        flex: 0,
        valueFormatter: (p) => p.value || "—",
      },
      {
        colId: "overdraft",
        headerName: "마이너스통장",
        flex: 0,
        valueGetter: (p) => {
          const r = p.data;
          if (!r) return "";
          if (!r.is_overdraft) return "—";
          return r.overdraft_limit
            ? `✓ 한도 ₩ ${formatComma(r.overdraft_limit)}`
            : "✓";
        },
      },
      {
        field: "memo",
        headerName: "메모",
        flex: 1,
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "status",
        headerName: "상태",
        flex: 0,
        cellRenderer: (p: any) => (
          <span
            className={
              "rounded px-1.5 py-0.5 text-xs " +
              (p.value === "ACTIVE"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-200 text-slate-600")
            }
          >
            {p.value === "ACTIVE" ? "활성" : "종료"}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="대출" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<Loan>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="은행·계좌번호·구분·메모 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "bank_name",
              "category",
              "loan_type",
              "bank_account_number",
              "contract_amount",
              "balance_amount",
              "interest_pay_day",
              "maturity_date",
              "overdraft",
              "status",
            ],
          }}
          extraActions={
            <>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                title="종류 필터"
              >
                <option value="">전체 종류</option>
                <option value="SME_FACILITY">중소기업시설자금</option>
                <option value="SME_GENERAL">중소기업자금</option>
                <option value="CORP_OPERATING">기업운전일반자금</option>
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                title="상태 필터"
              >
                <option value="ACTIVE">활성</option>
                <option value="CLOSED">종료</option>
                <option value="">전체</option>
              </select>
            </>
          }
          onAdd={() => {
            setAddForm(BLANK_FORM);
            setAddFiles([]);
            setAddError(null);
            setAddOpen(true);
          }}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
        />
      </div>

      {/* 신규 등록 */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="대출 등록"
        width="max-w-3xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!validForm(addForm) || createM.isPending}
              onClick={() => createM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {createM.isPending ? "등록 중..." : "등록"}
            </button>
          </>
        }
      >
        {addError && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
            {addError}
          </div>
        )}
        <FormBody form={addForm} setForm={setAddForm} bankAccounts={bankAccounts} />
        <div className="mt-3 border-t border-border pt-3">
          <div className="text-xs font-semibold mb-2">첨부 (대출약정서 등)</div>
          <FileDropZone
            multiple
            onFiles={(fs) => setAddFiles((p) => [...p, ...fs])}
            label="여기로 파일을 끌어놓거나 클릭해서 선택"
          />
          {addFiles.length > 0 && (
            <ul className="mt-2 space-y-1">
              {addFiles.map((f, idx) => (
                <li
                  key={`${f.name}-${idx}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-muted-foreground">{bytes(f.size)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setAddFiles((p) => p.filter((_, i) => i !== idx))
                    }
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="제거"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      {/* 편집 */}
      <Dialog
        open={!!editTargetId}
        onClose={() => setEditTargetId(null)}
        title="대출 수정"
        width="max-w-3xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditTargetId(null)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!validForm(editForm) || updateM.isPending}
              onClick={() => updateM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {updateM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        {editTarget && (
          <>
            {editError && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
                {editError}
              </div>
            )}
            <FormBody
              form={editForm}
              setForm={setEditForm}
              bankAccounts={bankAccounts}
            />
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-semibold mb-2">첨부</div>
              <ExistingAttachments loanId={editTarget.id} attachments={editTarget.attachments} />
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// 폼 본체
// ---------------------------------------------------------------------------

function FormBody({
  form,
  setForm,
  bankAccounts,
}: {
  form: Form;
  setForm: (f: Form | ((prev: Form) => Form)) => void;
  bankAccounts: BankAccountBrief[];
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const krwAccounts = bankAccounts.filter((b) => b.currency === "KRW");
  // 통장 0건일 때도 폼은 동작하지만 안내 노출.
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="은행 *" colSpan={2}>
        <select
          value={form.bank_account_id}
          onChange={(e) =>
            setForm((p) => ({ ...p, bank_account_id: e.target.value }))
          }
          className={input}
        >
          <option value="">선택</option>
          {krwAccounts.map((b) => (
            <option key={b.id} value={b.id}>
              {b.bank_name} · {b.account_number}
            </option>
          ))}
        </select>
        {krwAccounts.length === 0 && (
          <span className="text-[11px] text-amber-700">
            등록된 KRW 통장이 없습니다. Bank Accounts 에서 먼저 등록하세요.
          </span>
        )}
      </Field>
      <Field label="상태">
        <select
          value={form.status}
          onChange={(e) =>
            setForm((p) => ({ ...p, status: e.target.value as LoanStatus }))
          }
          className={input}
        >
          <option value="ACTIVE">활성</option>
          <option value="CLOSED">종료</option>
        </select>
      </Field>

      <Field label="구분">
        <input
          value={form.category}
          onChange={(e) =>
            setForm((p) => ({ ...p, category: e.target.value }))
          }
          placeholder="신용 / 담보 / 시설 / 운전 등"
          className={input}
        />
      </Field>
      <Field label="종류 *">
        <select
          value={form.loan_type}
          onChange={(e) =>
            setForm((p) => ({ ...p, loan_type: e.target.value as LoanType }))
          }
          className={input}
        >
          <option value="">선택</option>
          <option value="SME_FACILITY">중소기업시설자금</option>
          <option value="SME_GENERAL">중소기업자금</option>
          <option value="CORP_OPERATING">기업운전일반자금</option>
        </select>
      </Field>

      <Field label="약정금액 *">
        <input
          value={form.contract_amount}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              contract_amount: formatCommaInput(e.target.value),
            }))
          }
          inputMode="numeric"
          placeholder="0"
          className={input + " text-right tabular-nums"}
        />
      </Field>
      <Field label="대출잔액 *">
        <input
          value={form.balance_amount}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              balance_amount: formatCommaInput(e.target.value),
            }))
          }
          inputMode="numeric"
          placeholder="0"
          className={input + " text-right tabular-nums"}
        />
      </Field>
      <Field label="이자납입일">
        <select
          value={form.interest_pay_day}
          onChange={(e) =>
            setForm((p) => ({ ...p, interest_pay_day: e.target.value }))
          }
          className={input}
        >
          <option value="">미지정</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              매월 {d}일
            </option>
          ))}
        </select>
      </Field>

      <Field label="만기일자">
        <DateInput
          value={form.maturity_date}
          onChange={(v) => setForm((p) => ({ ...p, maturity_date: v }))}
          clearable
        />
      </Field>
      <Field label="마이너스 통장" colSpan={2}>
        <div className="flex items-center gap-3 h-9">
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={form.is_overdraft}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  is_overdraft: e.target.checked,
                  // 체크 해제 시 한도 입력값 비움.
                  overdraft_limit: e.target.checked ? p.overdraft_limit : "",
                }))
              }
            />
            마이너스 통장 여부
          </label>
          {form.is_overdraft && (
            <div className="flex items-center gap-2 flex-1">
              <span className="text-xs text-muted-foreground">한도</span>
              <input
                value={form.overdraft_limit}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    overdraft_limit: formatCommaInput(e.target.value),
                  }))
                }
                inputMode="numeric"
                placeholder="0"
                className={input + " text-right tabular-nums max-w-[200px]"}
              />
            </div>
          )}
        </div>
      </Field>

      <Field label="메모" colSpan={3}>
        <textarea
          value={form.memo}
          onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
          rows={2}
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
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const cls =
    colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 첨부 — 편집 다이얼로그용 (이미 등록된 첨부 + 신규 추가 + 파일명 변경 + 삭제)
// ---------------------------------------------------------------------------

function ExistingAttachments({
  loanId,
  attachments,
}: {
  loanId: string;
  attachments: Attachment[];
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      await Promise.all(
        files.map((f) => {
          const fd = new FormData();
          fd.append("file", f);
          return api.post(`/loans/${loanId}/attachments`, fd, {
            headers: { "Content-Type": "multipart/form-data" },
          });
        }),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loans"] }),
  });

  const renameM = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      api.patch(`/loans/attachments/${id}`, { file_name: name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loans"] }),
  });

  const removeM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/loans/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loans"] }),
  });

  return (
    <div className="space-y-2">
      <FileDropZone
        multiple
        onFiles={(fs) => uploadM.mutate(fs)}
        disabled={uploadM.isPending}
        label="여기로 파일을 끌어놓거나 클릭해서 추가"
      />
      {attachments.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          첨부된 파일이 없습니다.
        </div>
      ) : (
        <ul className="space-y-1">
          {attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              att={a}
              previewPath={`/loans/attachments/${a.id}/download`}
              onDownload={() => downloadAttachment(a)}
              onRename={(name) => renameM.mutate({ id: a.id, name })}
              onRemove={async () => {
                const ok = await dialog.confirm(
                  `"${a.file_name}" 첨부를 삭제하시겠습니까?`,
                  { destructive: true },
                );
                if (ok) removeM.mutate(a.id);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentRow({
  att,
  previewPath,
  onDownload,
  onRename,
  onRemove,
}: {
  att: Attachment;
  previewPath: string;
  onDownload: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(att.file_name);
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const next = draft.trim();
    if (next && next !== att.file_name) onRename(next);
    setEditing(false);
  }

  return (
    <li className="flex items-center gap-2 text-xs rounded-md border border-border bg-background px-2 py-1.5">
      {editing ? (
        <>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(att.file_name);
                setEditing(false);
              }
            }}
            autoFocus
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={commit}
            className="text-emerald-600 hover:text-emerald-700"
            aria-label="저장"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(att.file_name);
              setEditing(false);
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="취소"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onDownload}
            className="flex-1 text-left text-primary hover:underline truncate"
            title="다운로드"
          >
            {att.file_name}
          </button>
          <span className="text-muted-foreground shrink-0">
            {bytes(att.size ?? 0)}
          </span>
          <AttachmentPreviewButton
            filename={att.file_name}
            mime={att.mime_type ?? null}
            downloadPath={previewPath}
          />
          <Tooltip label="파일명 변경" side="top">
            <button
              type="button"
              onClick={() => {
                setDraft(att.file_name);
                setEditing(true);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip label="삭제" side="top">
            <button
              type="button"
              onClick={onRemove}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </>
      )}
    </li>
  );
}

async function downloadAttachment(a: Attachment) {
  const res = await api.get(`/loans/attachments/${a.id}/download`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data as Blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = a.file_name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 입력 중 콤마 포매팅 — 숫자만 추출 후 3자리 콤마 삽입. */
function formatCommaInput(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("ko-KR");
}

/** 출력용 콤마 — 서버가 보낸 string/Decimal 을 그대로. */
function formatComma(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "0";
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("ko-KR");
}

function bytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function validForm(f: Form): boolean {
  if (!f.bank_account_id) return false;
  if (!f.loan_type) return false;
  if (!f.contract_amount || Number(f.contract_amount.replace(/,/g, "")) < 0)
    return false;
  if (!f.balance_amount || Number(f.balance_amount.replace(/,/g, "")) < 0)
    return false;
  if (f.is_overdraft && !f.overdraft_limit) return false;
  return true;
}

function formToPayload(f: Form): Record<string, unknown> {
  const stripComma = (s: string) =>
    s ? Number(s.replace(/,/g, "")) : null;
  return {
    bank_account_id: f.bank_account_id || null,
    category: f.category.trim() || null,
    loan_type: f.loan_type || null,
    contract_amount: stripComma(f.contract_amount) ?? 0,
    balance_amount: stripComma(f.balance_amount) ?? 0,
    interest_pay_day: f.interest_pay_day ? Number(f.interest_pay_day) : null,
    maturity_date: f.maturity_date || null,
    is_overdraft: f.is_overdraft,
    overdraft_limit: f.is_overdraft ? stripComma(f.overdraft_limit) : null,
    memo: f.memo.trim() || null,
    status: f.status,
  };
}

function extractError(e: any): string | null {
  const d = e?.response?.data?.detail;
  if (Array.isArray(d)) {
    return d
      .map((it: any) => {
        const field = Array.isArray(it.loc) ? it.loc.slice(1).join(".") : "";
        return field ? `${field}: ${it.msg}` : it.msg;
      })
      .join("\n");
  }
  if (typeof d === "string") return d;
  return e?.message ?? null;
}
