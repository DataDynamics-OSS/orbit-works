"use client";

/**
 * 자사 통장 계좌 관리.
 *
 * - 권한: `bank_accounts.manage` (HR + ADMIN). 다른 역할은 메뉴에 노출 X.
 * - 통화는 ISO 4217 (KRW/USD/EUR/JPY/CNY/GBP 등). 외환 계좌는 SWIFT/IBAN/은행주소
 *   필드가 폼에 조건부 노출 (currency != KRW).
 * - 통화별 primary 1개 — 토글 시 백엔드가 같은 통화 다른 row 의 is_primary 자동 해제.
 * - 통장사본은 row 당 1개 슬롯 — 드래그앤드롭 업로드, 인라인 파일명 변경, 삭제 가능.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Tooltip } from "@/components/ui/Tooltip";

type Status = "ACTIVE" | "INACTIVE";

type BankAccount = {
  id: string;
  bank_name: string;
  account_number: string;
  holder_name: string;
  currency: string;
  purpose: string | null;
  swift_code: string | null;
  iban: string | null;
  bank_address: string | null;
  passbook_name: string | null;
  passbook_size: number | null;
  passbook_mime: string | null;
  is_primary: boolean;
  status: Status;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

type Form = {
  bank_name: string;
  account_number: string;
  holder_name: string;
  currency: string;
  purpose: string;
  swift_code: string;
  iban: string;
  bank_address: string;
  is_primary: boolean;
  status: Status;
  memo: string;
};

const COMMON_CURRENCIES = ["KRW", "USD", "EUR", "JPY", "CNY", "GBP"] as const;

// 국내 은행 목록 — KRW 통화 선택 시 select 옵션. 한국어 localeCompare 로 정렬.
// 외환(USD/EUR 등) 은 외국 은행 한글 표기가 일관되지 않아 직접 입력으로 처리.
const KOREAN_BANKS = [
  "경남은행",
  "광주은행",
  "국민은행",
  "기업은행",
  "농협은행",
  "대구은행",
  "부산은행",
  "산업은행",
  "새마을금고",
  "수출입은행",
  "수협은행",
  "신한은행",
  "씨티은행",
  "우리은행",
  "우체국",
  "전북은행",
  "제일은행",
  "제주은행",
  "카카오뱅크",
  "케이뱅크",
  "토스뱅크",
  "하나은행",
].sort((a, b) => a.localeCompare(b, "ko"));

const BLANK_FORM: Form = {
  bank_name: "",
  account_number: "",
  holder_name: "",
  currency: "KRW",
  purpose: "",
  swift_code: "",
  iban: "",
  bank_address: "",
  is_primary: false,
  status: "ACTIVE",
  memo: "",
};

export default function BankAccountsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();

  const [filterCurrency, setFilterCurrency] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("ACTIVE");
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<Form>(BLANK_FORM);
  const [addPassbook, setAddPassbook] = useState<File | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Form>(BLANK_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const { data: rows = [] } = useQuery<BankAccount[]>({
    queryKey: ["bank-accounts", filterCurrency, filterStatus],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filterCurrency) params.currency = filterCurrency;
      if (filterStatus) params.status_filter = filterStatus;
      return (await api.get("/bank-accounts", { params })).data;
    },
  });

  const editTarget = useMemo(
    () => rows.find((r) => r.id === editTargetId) ?? null,
    [rows, editTargetId],
  );

  const createM = useMutation({
    mutationFn: async () => {
      const created = (
        await api.post("/bank-accounts", formToPayload(addForm))
      ).data as BankAccount;
      if (addPassbook) {
        const fd = new FormData();
        fd.append("file", addPassbook);
        await api.post(`/bank-accounts/${created.id}/passbook`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      setAddOpen(false);
      setAddForm(BLANK_FORM);
      setAddPassbook(null);
      setAddError(null);
    },
    onError: (e: any) => setAddError(extractError(e) ?? "등록 실패"),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return;
      await api.patch(
        `/bank-accounts/${editTargetId}`,
        formToPayload(editForm),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      setEditTargetId(null);
      setEditError(null);
    },
    onError: (e: any) => setEditError(extractError(e) ?? "저장 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/bank-accounts/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-accounts"] }),
  });

  const togglePrimaryM = useMutation({
    mutationFn: async (id: string) =>
      api.patch(`/bank-accounts/${id}/primary`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-accounts"] }),
    onError: async (e: any) =>
      dialog.alert(extractError(e) ?? "토글 실패", { title: "오류" }),
  });

  async function handleDelete(sel: BankAccount[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}개 통장 계좌를 비활성화하시겠습니까?\n` +
        "(데이터는 유지되며 status=INACTIVE 로 전환됩니다.)",
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  function openEdit(row: BankAccount) {
    setEditTargetId(row.id);
    setEditForm({
      bank_name: row.bank_name,
      account_number: row.account_number,
      holder_name: row.holder_name,
      currency: row.currency,
      purpose: row.purpose ?? "",
      swift_code: row.swift_code ?? "",
      iban: row.iban ?? "",
      bank_address: row.bank_address ?? "",
      is_primary: row.is_primary,
      status: row.status,
      memo: row.memo ?? "",
    });
    setEditError(null);
  }

  const columnDefs = useMemo<ColDef<BankAccount>[]>(
    () => [
      {
        field: "currency",
        headerName: "통화",
        flex: 0,
        cellRenderer: (p: any) => (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium">
            {p.value}
          </span>
        ),
      },
      {
        field: "bank_name",
        headerName: "은행",
        flex: 0,
        // 은행명 클릭 시 거래내역 페이지로 이동.
        cellRenderer: (p: any) => (
          <button
            type="button"
            onClick={() => router.push(`/bank-accounts/${p.data?.id}`)}
            className="text-primary hover:underline font-medium"
            title="거래내역 보기"
          >
            {p.value}
          </button>
        ),
      },
      {
        field: "account_number",
        headerName: "계좌번호",
        flex: 0,
        cellRenderer: (p: any) => (
          <span className="font-mono text-xs">{p.value}</span>
        ),
      },
      { field: "holder_name", headerName: "예금주", flex: 0 },
      {
        field: "purpose",
        headerName: "용도",
        flex: 1,
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "swift_code",
        headerName: "SWIFT",
        flex: 0,
        valueFormatter: (p) => p.value || "—",
      },
      {
        colId: "passbook",
        headerName: "통장사본",
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) =>
          p.data?.passbook_name ? (
            <DownloadButton
              onClick={() => downloadPassbook(p.data)}
              title={p.data.passbook_name}
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        colId: "primary",
        headerName: "주계좌",
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => {
          const r: BankAccount | undefined = p.data;
          if (!r) return null;
          if (r.status !== "ACTIVE")
            return <span className="text-muted-foreground">—</span>;
          return (
            <Tooltip
              label={r.is_primary ? "주계좌 해제" : `${r.currency} 주계좌로 지정`}
              side="top"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePrimaryM.mutate(r.id);
                }}
                className={
                  "h-6 w-6 inline-flex items-center justify-center rounded " +
                  (r.is_primary
                    ? "text-amber-500 hover:text-amber-600"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {r.is_primary ? "★" : "☆"}
              </button>
            </Tooltip>
          );
        },
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
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
            {p.value === "ACTIVE" ? "활성" : "비활성"}
          </span>
        ),
      },
    ],
    [togglePrimaryM],
  );

  return (
    <>
      <DashboardHeader title="은행계좌" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<BankAccount>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="은행·계좌번호·예금주·용도 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "currency",
              "bank_name",
              "account_number",
              "holder_name",
              "swift_code",
              "passbook",
              "primary",
              "status",
            ],
          }}
          extraActions={
            <>
              <select
                value={filterCurrency}
                onChange={(e) => setFilterCurrency(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                title="통화 필터"
              >
                <option value="">전체 통화</option>
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                title="상태 필터"
              >
                <option value="ACTIVE">활성</option>
                <option value="INACTIVE">비활성</option>
                <option value="">전체</option>
              </select>
            </>
          }
          onAdd={() => {
            setAddForm(BLANK_FORM);
            setAddPassbook(null);
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
        title="통장 계좌 등록"
        width="max-w-2xl"
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
        <FormBody form={addForm} setForm={setAddForm} />
        <div className="mt-3 border-t border-border pt-3">
          <div className="text-xs font-semibold mb-2">통장사본</div>
          <FileDropZone
            multiple={false}
            onFiles={(fs) => setAddPassbook(fs[0] ?? null)}
            label="여기로 파일을 끌어놓거나 클릭해서 선택"
          />
          {addPassbook && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs">
              <span className="flex-1 truncate">{addPassbook.name}</span>
              <span className="text-muted-foreground">{bytes(addPassbook.size)}</span>
              <button
                type="button"
                onClick={() => setAddPassbook(null)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="제거"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </Dialog>

      {/* 편집 */}
      <Dialog
        open={!!editTargetId}
        onClose={() => setEditTargetId(null)}
        title="통장 계좌 수정"
        width="max-w-2xl"
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
            <FormBody form={editForm} setForm={setEditForm} />
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-semibold mb-2">통장사본</div>
              <ExistingPassbook account={editTarget} />
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
}: {
  form: Form;
  setForm: (f: Form | ((prev: Form) => Form)) => void;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const isForeign = form.currency !== "KRW";

  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="통화 *">
        <select
          value={form.currency}
          onChange={(e) =>
            setForm((p) => ({ ...p, currency: e.target.value.toUpperCase() }))
          }
          className={input}
        >
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {/* 현재 값이 common 에 없으면 last option 으로 보존 */}
          {!COMMON_CURRENCIES.includes(form.currency as any) && form.currency && (
            <option value={form.currency}>{form.currency}</option>
          )}
        </select>
      </Field>
      <Field label="상태">
        <select
          value={form.status}
          onChange={(e) =>
            setForm((p) => ({ ...p, status: e.target.value as Status }))
          }
          className={input}
        >
          <option value="ACTIVE">활성</option>
          <option value="INACTIVE">비활성</option>
        </select>
      </Field>
      <Field label="용도">
        <input
          value={form.purpose}
          onChange={(e) =>
            setForm((p) => ({ ...p, purpose: e.target.value }))
          }
          placeholder="운영자금 / 급여 / USD 수금 등"
          className={input}
        />
      </Field>

      <Field label="은행명 *">
        {isForeign ? (
          // 외환 — 외국 은행 한글 표기가 통일되지 않아 직접 입력.
          <input
            value={form.bank_name}
            onChange={(e) =>
              setForm((p) => ({ ...p, bank_name: e.target.value }))
            }
            placeholder="Bank of America"
            className={input}
          />
        ) : (
          // KRW — 국내 은행 select. 기존 값이 목록에 없으면 last option 으로 보존.
          <select
            value={form.bank_name}
            onChange={(e) =>
              setForm((p) => ({ ...p, bank_name: e.target.value }))
            }
            className={input}
          >
            <option value="">선택</option>
            {KOREAN_BANKS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            {form.bank_name && !KOREAN_BANKS.includes(form.bank_name) && (
              <option value={form.bank_name}>
                {form.bank_name} (기타)
              </option>
            )}
          </select>
        )}
      </Field>
      <Field label="예금주 *">
        <input
          value={form.holder_name}
          onChange={(e) =>
            setForm((p) => ({ ...p, holder_name: e.target.value }))
          }
          className={input}
        />
      </Field>
      <Field label="계좌번호 *">
        <input
          value={form.account_number}
          onChange={(e) =>
            setForm((p) => ({ ...p, account_number: e.target.value }))
          }
          className={input + " font-mono"}
        />
      </Field>

      {isForeign && (
        <>
          <Field label="SWIFT/BIC">
            <input
              value={form.swift_code}
              onChange={(e) =>
                setForm((p) => ({ ...p, swift_code: e.target.value }))
              }
              placeholder="KOEXKRSEXXX"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="IBAN">
            <input
              value={form.iban}
              onChange={(e) =>
                setForm((p) => ({ ...p, iban: e.target.value }))
              }
              placeholder="(유럽 송금 시)"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="은행 주소" colSpan={3}>
            <textarea
              value={form.bank_address}
              onChange={(e) =>
                setForm((p) => ({ ...p, bank_address: e.target.value }))
              }
              rows={2}
              placeholder="해외송금 시 송금 은행 주소"
              className={input}
            />
          </Field>
        </>
      )}

      <Field label="메모" colSpan={3}>
        <textarea
          value={form.memo}
          onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
          rows={2}
          className={input}
        />
      </Field>

      <div className="col-span-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.is_primary}
            onChange={(e) =>
              setForm((p) => ({ ...p, is_primary: e.target.checked }))
            }
          />
          이 계좌를 <span className="font-semibold">{form.currency}</span> 주계좌로
          지정
          <span className="text-xs text-muted-foreground">
            (다른 {form.currency} 주계좌가 있으면 자동 해제됩니다)
          </span>
        </label>
      </div>
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
// 통장사본 첨부 — 단일 슬롯. 드래그앤드롭 업로드 + 인라인 파일명 변경 + 삭제.
// 새 파일을 드롭하면 기존 파일을 교체. PATCH /bank-accounts/{id} 의 passbook_name
// 으로 디스크 파일은 그대로 두고 표시명만 변경.
// ---------------------------------------------------------------------------

function ExistingPassbook({ account }: { account: BankAccount }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(account.passbook_name ?? "");

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(`/bank-accounts/${account.id}/passbook`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-accounts"] }),
  });

  const renameM = useMutation({
    mutationFn: async (name: string) =>
      api.patch(`/bank-accounts/${account.id}`, { passbook_name: name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      setRenaming(false);
    },
  });

  const deleteM = useMutation({
    mutationFn: async () =>
      api.delete(`/bank-accounts/${account.id}/passbook`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-accounts"] }),
  });

  function commitRename() {
    const next = draftName.trim();
    if (next && next !== account.passbook_name) renameM.mutate(next);
    else setRenaming(false);
  }

  const name = account.passbook_name;

  return (
    <div className="space-y-2">
      <FileDropZone
        multiple={false}
        onFiles={(fs) => fs[0] && uploadM.mutate(fs[0])}
        disabled={uploadM.isPending}
        label={
          name
            ? "여기로 새 파일을 끌어놓으면 기존 파일이 교체됩니다"
            : "여기로 파일을 끌어놓거나 클릭해서 선택"
        }
      />
      {name ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs">
          {renaming ? (
            <>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setDraftName(name);
                    setRenaming(false);
                  }
                }}
                autoFocus
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={commitRename}
                className="text-emerald-600 hover:text-emerald-700"
                aria-label="저장"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftName(name);
                  setRenaming(false);
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
                onClick={() => downloadPassbook(account)}
                className="flex-1 text-left text-primary hover:underline truncate"
                title="다운로드"
              >
                {name}
              </button>
              {account.passbook_size != null && (
                <span className="text-muted-foreground shrink-0">
                  {bytes(account.passbook_size)}
                </span>
              )}
              <Tooltip label="파일명 변경" side="top">
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(name);
                    setRenaming(true);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <Tooltip label="삭제" side="top">
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm("통장사본을 삭제하시겠습니까?", {
                        destructive: true,
                      })
                    ) {
                      deleteM.mutate();
                    }
                  }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          첨부된 파일이 없습니다.
        </div>
      )}
    </div>
  );
}

function bytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function DownloadButton({
  onClick,
  title,
}: {
  onClick: () => void;
  title: string;
}) {
  return (
    <Tooltip label={title} side="top">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-primary hover:bg-muted"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </button>
    </Tooltip>
  );
}

async function downloadPassbook(account: BankAccount) {
  if (!account.passbook_name) return;
  const ext = account.passbook_name.includes(".")
    ? account.passbook_name.slice(account.passbook_name.lastIndexOf("."))
    : "";
  const filename = `${account.bank_name}_${account.currency}_통장사본${ext}`;
  const res = await api.get(`/bank-accounts/${account.id}/passbook`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validForm(f: Form): boolean {
  if (!f.bank_name.trim()) return false;
  if (!f.account_number.trim()) return false;
  if (!f.holder_name.trim()) return false;
  if (!/^[A-Z]{3}$/.test(f.currency)) return false;
  return true;
}

function formToPayload(f: Form): Record<string, unknown> {
  const isForeign = f.currency !== "KRW";
  return {
    bank_name: f.bank_name.trim(),
    account_number: f.account_number.trim(),
    holder_name: f.holder_name.trim(),
    currency: f.currency.toUpperCase(),
    purpose: f.purpose.trim() || null,
    swift_code: isForeign && f.swift_code.trim() ? f.swift_code.trim() : null,
    iban: isForeign && f.iban.trim() ? f.iban.trim() : null,
    bank_address: isForeign && f.bank_address.trim() ? f.bank_address.trim() : null,
    is_primary: f.is_primary,
    status: f.status,
    memo: f.memo.trim() || null,
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
