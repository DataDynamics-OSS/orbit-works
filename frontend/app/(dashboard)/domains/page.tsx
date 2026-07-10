"use client";

/**
 * 자원 > 도메인 — 회사가 보유한 도메인 대장.
 *
 * - GRID 컬럼: 도메인명·구매일·만료일·구매금액·구매처·용도·자동 갱신·만료 알람
 * - 추가 / 더블클릭 수정 / 다중 선택 후 삭제
 * - 모든 임직원 열람. CRUD 는 ADMIN/HR 만.
 */

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, type DataGridHandle } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Domain = {
  id: string;
  name: string;
  purchase_date: string | null;
  expiry_date: string | null;
  purchase_amount: string | null;
  currency: string;
  vendor: string | null;
  purpose: string | null;
  auto_renew: boolean;
  expiry_alarm: boolean;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

const BLANK_FORM = {
  name: "",
  purchase_date: "",
  expiry_date: "",
  purchase_amount: "",
  currency: "KRW",
  vendor: "",
  purpose: "",
  auto_renew: false,
  expiry_alarm: true,
  memo: "",
};

const CURRENCY_SYMBOL: Record<string, string> = {
  KRW: "₩",
  USD: "$",
  EUR: "€",
  JPY: "¥",
};

function fmtAmount(v: string | null, currency: string): string {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  // KRW/JPY 는 소수 없음, 그 외 (USD/EUR …) 는 소수점 2자리.
  const minor = currency === "KRW" || currency === "JPY" ? 0 : 2;
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: minor,
    maximumFractionDigits: minor,
  });
  const sym = CURRENCY_SYMBOL[currency] ?? currency;
  return `${sym} ${formatted}`;
}

// 입력창용 — 정수부만 천 단위, 소수점/소수부는 raw 그대로 보존.
// "11.11" → "11.11", "1000000.5" → "1,000,000.5", "" → "".
function fmtAmountInput(raw: string): string {
  if (!raw) return "";
  const [intPart, decPart] = raw.split(".");
  const intFmt = intPart ? Number(intPart).toLocaleString("en-US") : "";
  return decPart !== undefined ? `${intFmt}.${decPart}` : intFmt;
}

function fmtDate(v: string | null): string {
  return v ? String(v).slice(0, 10) : "-";
}

function daysUntil(expiry: string | null): number | null {
  if (!expiry) return null;
  const e = new Date(expiry);
  if (isNaN(e.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((e.getTime() - today.getTime()) / (24 * 3600 * 1000));
}

export default function DomainsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<Domain>>(null);

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const canManage =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  const { data: rows = [], isLoading } = useQuery<Domain[]>({
    queryKey: ["domains"],
    queryFn: async () => (await api.get("/domains")).data,
    staleTime: 30_000,
  });

  // 등록/편집 dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Domain | null>(null);
  const [form, setForm] = useState({ ...BLANK_FORM });

  function openAdd() {
    setEditTarget(null);
    setForm({ ...BLANK_FORM });
    setEditOpen(true);
  }
  function openEdit(d: Domain) {
    if (!canManage) return;
    setEditTarget(d);
    setForm({
      name: d.name,
      purchase_date: d.purchase_date ?? "",
      expiry_date: d.expiry_date ?? "",
      purchase_amount: d.purchase_amount != null ? String(d.purchase_amount) : "",
      currency: d.currency || "KRW",
      vendor: d.vendor ?? "",
      purpose: d.purpose ?? "",
      auto_renew: d.auto_renew,
      expiry_alarm: d.expiry_alarm,
      memo: d.memo ?? "",
    });
    setEditOpen(true);
  }

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("도메인명을 입력하세요.");
      const body = {
        name: form.name.trim(),
        purchase_date: form.purchase_date || null,
        expiry_date: form.expiry_date || null,
        purchase_amount: form.purchase_amount
          ? form.purchase_amount.replace(/[^\d.]/g, "")
          : null,
        currency: form.currency || "KRW",
        vendor: form.vendor.trim() || null,
        purpose: form.purpose.trim() || null,
        auto_renew: form.auto_renew,
        expiry_alarm: form.expiry_alarm,
        memo: form.memo.trim() || null,
      };
      if (editTarget) {
        return (await api.patch(`/domains/${editTarget.id}`, body)).data;
      }
      return (await api.post("/domains", body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      setEditOpen(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/domains/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });

  async function handleDelete() {
    const sel = gridRef.current?.getSelectedRows() ?? [];
    if (sel.length === 0) return;
    const ok = await dialog.confirm(
      `선택된 도메인 ${sel.length}개를 삭제하시겠습니까?`,
      { title: "도메인 삭제", confirmText: "삭제" },
    );
    if (!ok) return;
    await deleteM.mutateAsync(sel.map((d) => d.id));
  }

  const columnDefs = useMemo<ColDef<Domain>[]>(
    () => [
      {
        field: "name",
        headerName: "도메인명",
        flex: 1.4,
        minWidth: 200,
        sortable: true,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "purchase_date",
        headerName: "구매일",
        width: 110,
        flex: 0,
        sortable: true,
        valueFormatter: (p) => fmtDate(p.value),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "expiry_date",
        headerName: "만료일",
        width: 130,
        flex: 0,
        sortable: true,
        valueFormatter: (p) => {
          const d = fmtDate(p.value);
          const days = daysUntil(p.value);
          if (days != null && days <= 30 && days >= 0) {
            return `${d}  (D-${days})`;
          }
          if (days != null && days < 0) return `${d}  (만료)`;
          return d;
        },
        cellStyle: (p: any) => {
          const days = daysUntil(p.value);
          const base = { textAlign: "center" as const };
          if (days == null) return base as any;
          if (days < 0)
            return { ...base, color: "rgb(220 38 38)", fontWeight: 600 } as any;
          if (days <= 30)
            return { ...base, color: "rgb(217 119 6)", fontWeight: 500 } as any;
          return base as any;
        },
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "purchase_amount",
        headerName: "구매금액",
        width: 130,
        flex: 0,
        valueFormatter: (p) => fmtAmount(p.value, p.data?.currency ?? "KRW"),
        cellStyle: { textAlign: "right" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "vendor",
        headerName: "구매처",
        width: 160,
        flex: 0,
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "purpose",
        headerName: "용도",
        flex: 1,
        minWidth: 160,
        valueFormatter: (p) => p.value ?? "-",
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "auto_renew",
        headerName: "자동 갱신",
        width: 100,
        flex: 0,
        cellRenderer: BoolDotRenderer,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "expiry_alarm",
        headerName: "만료 알람",
        width: 100,
        flex: 0,
        cellRenderer: BoolDotRenderer,
        headerClass: "ag-center-aligned-header",
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="도메인" />
      <div className="flex flex-1 flex-col p-4 min-h-0">
        <DataGrid<Domain>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="도메인명·구매처·용도 검색"
          disableFilters
          onAdd={canManage ? openAdd : undefined}
          onDelete={canManage ? handleDelete : undefined}
          onRowDoubleClicked={canManage ? openEdit : undefined}
        />
        {isLoading && (
          <div className="text-xs text-muted-foreground py-2">로딩 중…</div>
        )}
      </div>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editTarget ? "도메인 수정" : "신규 도메인 등록"}
        width="max-w-xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              disabled={saveM.isPending}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => saveM.mutate()}
              disabled={saveM.isPending}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="도메인명" colSpan={2}>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls}
              placeholder="예: orbit-works.app"
            />
          </Field>
          <Field label="구매일">
            <input
              type="date"
              value={form.purchase_date}
              onChange={(e) =>
                setForm({ ...form, purchase_date: e.target.value })
              }
              className={inputCls}
            />
          </Field>
          <Field label="만료일">
            <input
              type="date"
              value={form.expiry_date}
              onChange={(e) =>
                setForm({ ...form, expiry_date: e.target.value })
              }
              className={inputCls}
            />
          </Field>
          <Field label="구매금액">
            <input
              value={fmtAmountInput(form.purchase_amount)}
              onChange={(e) => {
                // 숫자·점만 남기고 점은 1개로 제한. 콤마는 표시용이라 raw 에서 제거.
                let raw = e.target.value.replace(/,/g, "").replace(/[^\d.]/g, "");
                const dot = raw.indexOf(".");
                if (dot !== -1) {
                  raw = raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, "");
                }
                setForm({ ...form, purchase_amount: raw });
              }}
              className={inputCls + " text-right tabular-nums"}
              placeholder="0"
              inputMode="decimal"
            />
          </Field>
          <Field label="통화">
            <select
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
              className={inputCls}
            >
              <option value="KRW">KRW</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="JPY">JPY</option>
            </select>
          </Field>
          <Field label="구매처" colSpan={2}>
            <input
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              className={inputCls}
              placeholder="가비아 / 후이즈 / Namecheap / GoDaddy 등"
            />
          </Field>
          <Field label="용도" colSpan={2}>
            <input
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              className={inputCls}
              placeholder="자유 입력 (예: 운영 사이트, 데모, 마케팅 랜딩)"
            />
          </Field>
          <Field label="자동 갱신">
            <label className="inline-flex items-center gap-2 h-10 px-3 rounded-md border border-input bg-background cursor-pointer">
              <input
                type="checkbox"
                checked={form.auto_renew}
                onChange={(e) =>
                  setForm({ ...form, auto_renew: e.target.checked })
                }
                className="h-4 w-4"
              />
              <span className="text-sm">
                {form.auto_renew ? "ON" : "OFF"}
              </span>
            </label>
          </Field>
          <Field label="만료 30일전 알람">
            <label className="inline-flex items-center gap-2 h-10 px-3 rounded-md border border-input bg-background cursor-pointer">
              <input
                type="checkbox"
                checked={form.expiry_alarm}
                onChange={(e) =>
                  setForm({ ...form, expiry_alarm: e.target.checked })
                }
                className="h-4 w-4"
              />
              <span className="text-sm">
                {form.expiry_alarm ? "ON" : "OFF"}
              </span>
            </label>
          </Field>
          <Field label="비고" colSpan={2}>
            <textarea
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              rows={2}
              className={inputCls + " resize-none"}
              placeholder="DNS 설정·등록자 정보 등"
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function BoolDotRenderer(p: { value: unknown }) {
  const on = Boolean(p.value);
  return (
    <div className="flex h-full w-full items-center justify-center">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        title={on ? "ON" : "OFF"}
        style={{
          backgroundColor: on ? "rgb(34 197 94)" : "rgb(203 213 225)",
        }}
      />
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
    <label
      className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
