"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save } from "lucide-react";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";

type License = {
  id: string;
  customer_id: string;
  product_name: string;
  vendor?: string;
  currency: "KRW" | "USD";
  amount: string;
  applied_fx_rate?: string;
  amount_krw?: string;
  purchase_amount?: string;
  purchase_currency?: string;
  start_date: string;
  end_date: string;
  renewal_prep_date?: string;
  status: string;
  description?: string;
  quotes: any[];
};

type Customer = { id: string; name: string; contacts: any[] };

const BLANK: Partial<License> = { currency: "KRW", amount: "0", status: "ACTIVE" };

const EMPTY_STRING_FIELDS = [
  "vendor",
  "applied_fx_rate",
  "renewal_prep_date",
  "description",
] as const;

function preparePayload(form: Partial<License>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...form };
  for (const k of EMPTY_STRING_FIELDS) {
    if (payload[k] === "") payload[k] = null;
  }
  return payload;
}

export default function LicensesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  // Create
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<Partial<License>>(BLANK);

  // Edit
  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<License>>({});

  const { data: licenses = [] } = useQuery<License[]>({
    queryKey: ["licenses"],
    queryFn: async () => (await api.get("/licenses")).data,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
  });

  const { data: fx } = useQuery<{ rate: string; as_of: string }>({
    queryKey: ["fx"],
    queryFn: async () => (await api.get("/exchange/current")).data,
  });

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post("/licenses", preparePayload(addForm))).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      setAddForm(BLANK);
      setAddOpen(false);
    },
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return null;
      return (
        await api.patch(`/licenses/${editTargetId}`, preparePayload(editForm))
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      setEditOpen(false);
      setEditTargetId(null);
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/licenses/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["licenses"] }),
  });

  const custName = (id: string) => customers.find((c) => c.id === id)?.name ?? "-";

  const columnDefs = useMemo<ColDef<License>[]>(
    () => [
      {
        field: "product_name",
        headerName: "제품명",
        flex: 1,
        cellRenderer: (p: any) => (
          <Link
            href={`/licenses/${p.data.id}`}
            className="text-primary hover:underline"
          >
            {p.value}
          </Link>
        ),
      },
      {
        colId: "customer",
        headerName: "고객사",
        flex: 1,
        valueGetter: (p) => custName(p.data!.customer_id),
      },
      { field: "vendor", headerName: "공급사" },
      {
        colId: "amount",
        headerName: "금액",
        valueGetter: (p) => formatMoney(p.data?.amount, p.data?.currency),
        cellStyle: { textAlign: "right" } as any,
      },
      {
        colId: "applied_fx_rate",
        headerName: "적용환율",
        valueGetter: (p) =>
          p.data?.applied_fx_rate
            ? Number(p.data.applied_fx_rate).toLocaleString()
            : "-",
        cellStyle: { textAlign: "right" } as any,
      },
      {
        colId: "amount_krw",
        headerName: "원화 환산",
        valueGetter: (p) => formatMoney(p.data?.amount_krw, "KRW"),
        cellStyle: { textAlign: "right" } as any,
      },
      { field: "start_date", headerName: "시작일" },
      { field: "end_date", headerName: "종료일" },
      {
        colId: "remaining",
        headerName: "남은 기간",
        valueGetter: (p) => {
          if (!p.data?.end_date) return null;
          const end = new Date(`${p.data.end_date}T00:00:00`).getTime();
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const n = Math.round((end - today.getTime()) / 86_400_000);
          // 종료일이 지났으면 표시하지 않음 (상태에서 EXPIRED로 구분)
          return n < 0 ? null : n;
        },
        valueFormatter: (p) => {
          const n = p.value as number | null;
          if (n == null) return "";
          if (n === 0) return "오늘 만료";
          return `${n}일 남음`;
        },
        cellStyle: ((p: any) => {
          const n = p.value as number | null;
          if (n == null) return { textAlign: "right" };
          if (n < 30) return { textAlign: "right", color: "#d97706" };
          return { textAlign: "right" };
        }) as any,
      },
      { field: "renewal_prep_date", headerName: "연장준비" },
      {
        colId: "status",
        headerName: "상태",
        valueGetter: (p) => deriveStatus(p.data),
        cellRenderer: (p: any) => <StatusBadge status={p.value} />,
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
    ],
    [customers],
  );

  async function handleDelete(rows: License[]) {
    const ok = await dialog.confirm(
      `${rows.length}건을 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(rows.map((r) => r.id));
  }

  function openAdd() {
    setAddForm(BLANK);
    setAddOpen(true);
  }

  function openEdit(row: License) {
    setEditTargetId(row.id);
    setEditForm({
      customer_id: row.customer_id,
      product_name: row.product_name,
      vendor: row.vendor ?? "",
      currency: row.currency,
      amount: row.amount ?? "",
      applied_fx_rate: row.applied_fx_rate ?? "",
      start_date: row.start_date,
      end_date: row.end_date,
      renewal_prep_date: row.renewal_prep_date ?? "",
      status: row.status,
      description: row.description ?? "",
    });
    setEditOpen(true);
  }

  return (
    <>
      <DashboardHeader
        title="SW 라이센스"
        actions={
          fx ? (
            <div className="text-sm rounded-md border border-border bg-card px-3 py-1 shadow-sm">
              USD/KRW: <span className="font-semibold">{Number(fx.rate).toLocaleString()}</span>{" "}
              <span className="text-muted-foreground">({fx.as_of})</span>
            </div>
          ) : undefined
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<License>
          rowData={licenses}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="제품명, 공급사, 고객사 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "vendor",
              "amount",
              "applied_fx_rate",
              "amount_krw",
              "start_date",
              "end_date",
              "remaining",
              "renewal_prep_date",
              "status",
            ],
          }}
          onAdd={openAdd}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
        />
      </div>

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="신규 라이센스 등록"
        width="max-w-lg"
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
              onClick={() =>
                addForm.customer_id &&
                addForm.product_name &&
                addForm.start_date &&
                addForm.end_date &&
                createM.mutate()
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              등록
            </button>
          </>
        }
      >
        <LicenseFormBody
          form={addForm}
          setForm={(u) =>
            setAddForm((prev) => (typeof u === "function" ? u(prev) : u))
          }
          customers={customers}
          fx={fx}
        />
      </Dialog>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="라이센스 수정"
        width="max-w-lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() =>
                editForm.customer_id &&
                editForm.product_name &&
                editForm.start_date &&
                editForm.end_date &&
                updateM.mutate()
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        <LicenseFormBody
          form={editForm}
          setForm={(u) =>
            setEditForm((prev) => (typeof u === "function" ? u(prev) : u))
          }
          customers={customers}
          fx={fx}
          showStatus
        />
      </Dialog>
    </>
  );
}

function LicenseFormBody({
  form,
  setForm,
  customers,
  fx,
  showStatus,
}: {
  form: Partial<License>;
  setForm: (
    u: Partial<License> | ((prev: Partial<License>) => Partial<License>),
  ) => void;
  customers: Customer[];
  fx: { rate: string; as_of: string } | undefined;
  showStatus?: boolean;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <div className="flex flex-col gap-3">
      <LField label="고객사 *">
        <select
          value={form.customer_id ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, customer_id: e.target.value }))
          }
          className={input}
        >
          <option value="">선택</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </LField>
      <LField label="제품명 *">
        <input
          value={form.product_name ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, product_name: e.target.value }))
          }
          className={input}
        />
      </LField>
      <LField label="공급사">
        <input
          value={form.vendor ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, vendor: e.target.value }))}
          className={input}
        />
      </LField>
      <div className="grid grid-cols-3 gap-2">
        <LField label="통화">
          <select
            value={form.currency ?? "KRW"}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                currency: e.target.value as "KRW" | "USD",
              }))
            }
            className={input}
          >
            <option value="KRW">KRW</option>
            <option value="USD">USD</option>
          </select>
        </LField>
        <div className="col-span-2">
          <LField label="금액">
            <input
              type="number"
              value={form.amount ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, amount: e.target.value }))
              }
              className={input}
            />
          </LField>
        </div>
      </div>
      {form.currency === "USD" && (
        <LField label="적용 환율 (USD→KRW)">
          <input
            type="number"
            value={form.applied_fx_rate ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, applied_fx_rate: e.target.value }))
            }
            className={input}
          />
          {fx && form.applied_fx_rate && (
            <p className="text-xs text-muted-foreground mt-1">
              현재 환율 대비{" "}
              {(Number(form.applied_fx_rate) - Number(fx.rate)).toFixed(2)} 차이
            </p>
          )}
        </LField>
      )}
      <div className="grid grid-cols-2 gap-2">
        <LField label="시작일 *">
          <DateInput
            value={form.start_date ?? ""}
            onChange={(v) => setForm((p) => ({ ...p, start_date: v }))}
          />
        </LField>
        <LField label="종료일 *">
          <DateInput
            value={form.end_date ?? ""}
            onChange={(v) => setForm((p) => ({ ...p, end_date: v }))}
          />
        </LField>
      </div>
      <LField label="연장 준비일">
        <DateInput
          value={form.renewal_prep_date ?? ""}
          onChange={(v) => setForm((p) => ({ ...p, renewal_prep_date: v }))}
        />
      </LField>
      {showStatus && (
        <LField label="상태">
          <select
            value={form.status ?? "ACTIVE"}
            onChange={(e) =>
              setForm((p) => ({ ...p, status: e.target.value }))
            }
            className={input}
          >
            <option value="ACTIVE">활성</option>
            <option value="EXPIRED">만료</option>
            <option value="CANCELLED">해지</option>
          </select>
        </LField>
      )}
      <LField label="설명">
        <textarea
          value={form.description ?? ""}
          onChange={(e) =>
            setForm((p) => ({ ...p, description: e.target.value }))
          }
          rows={2}
          className={input}
        />
      </LField>
    </div>
  );
}

function LField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function deriveStatus(row?: License | null): string {
  if (!row) return "ACTIVE";
  if (row.status === "CANCELLED") return "CANCELLED";
  if (!row.end_date) return row.status ?? "ACTIVE";
  const end = new Date(`${row.end_date}T00:00:00`).getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end < today.getTime() ? "EXPIRED" : "ACTIVE";
}

const STATUS_DOT: Record<string, string> = {
  ACTIVE: "bg-blue-500",
  EXPIRED: "bg-red-500",
  CANCELLED: "bg-slate-400",
};

const STATUS_LABEL_KO: Record<string, string> = {
  ACTIVE: "사용중",
  EXPIRED: "만료",
  CANCELLED: "해지",
};

function StatusBadge({ status }: { status: string }) {
  const dot = STATUS_DOT[status] ?? "bg-slate-400";
  const label = STATUS_LABEL_KO[status] ?? status;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
      <span>{label}</span>
    </span>
  );
}
