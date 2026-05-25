"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { api } from "@/lib/api";
import { Currency, formatCurrency } from "@/lib/billing";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { useDialog } from "@/components/ui/DialogProvider";

type Customer = { id: string; name: string };

type InvoiceRow = {
  id: string;
  number: string;
  display_number: string;
  version: number;
  title: string;
  business_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_snapshot: { name?: string | null } | null;
  issue_date: string;
  due_date: string | null;
  currency: Currency;
  total_amount: string;
};

export default function InvoicesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  // 회사 필터 — URL `?customer_id=…` 와 동기화. 회사 360° "전체보기" deep link.
  const customerIdParam = searchParams.get("customer_id");
  const [customerFilter, setCustomerFilter] = useState<string | null>(
    customerIdParam,
  );
  useEffect(() => setCustomerFilter(customerIdParam), [customerIdParam]);
  const updateCustomerFilter = (id: string | null) => {
    setCustomerFilter(id);
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("customer_id", id);
    else params.delete("customer_id");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?");
  };

  const { data: rows = [] } = useQuery<InvoiceRow[]>({
    queryKey: ["invoices", year, customerFilter],
    queryFn: async () =>
      (
        await api.get("/invoices", {
          params: customerFilter
            ? { year, customer_id: customerFilter }
            : { year },
        })
      ).data,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  const copyM = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/invoices/${id}/copy`)).data,
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      router.push(`/invoices/${data.id}`);
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/invoices/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });

  async function handleDelete(sel: InvoiceRow[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 매출 인보이스를 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  const columnDefs = useMemo<ColDef<InvoiceRow>[]>(
    () => [
      {
        colId: "number",
        field: "display_number",
        headerName: "인보이스 번호",
        width: 195,
        flex: 0,
        pinned: "left",
        valueGetter: (p) => p.data?.display_number || p.data?.number,
      },
      {
        colId: "business_name",
        field: "business_name",
        headerName: "제목",
        flex: 65,
        minWidth: 180,
        valueGetter: (p) => p.data?.business_name || "-",
      },
      {
        field: "customer_name",
        headerName: "고객사",
        flex: 35,
        minWidth: 140,
        valueGetter: (p) =>
          p.data?.customer_name ||
          p.data?.customer_snapshot?.name ||
          (p.data?.customer_id
            ? customers.find((c) => c.id === p.data!.customer_id)?.name
            : null) ||
          "-",
      },
      { field: "issue_date", headerName: "발행일", width: 120, flex: 0 },
      { field: "due_date", headerName: "지급기일", width: 120, flex: 0 },
      { field: "currency", headerName: "통화", width: 100, flex: 0 },
      {
        field: "total_amount",
        headerName: "합계",
        width: 120,
        flex: 0,
        cellClass: "text-right tabular-nums",
        valueFormatter: (p) =>
          formatCurrency(p.value ?? 0, (p.data?.currency ?? "KRW") as Currency),
      },
      {
        colId: "actions",
        headerName: "동작",
        width: 80,
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              copyM.mutate(p.data.id);
            }}
            className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
          >
            <Copy className="h-3 w-3" />
            복제
          </button>
        ),
      },
    ],
    [customers, copyM],
  );

  return (
    <>
      <DashboardHeader
        title="매출 인보이스"
        actions={
          <div className="flex gap-2 items-center">
            <select
              value={customerFilter ?? ""}
              onChange={(e) => updateCustomerFilter(e.target.value || null)}
              className="h-8 rounded-md border border-border bg-card shadow-sm px-2 text-sm max-w-[200px]"
              title="회사로 필터"
            >
              <option value="">전체 회사</option>
              {customers
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, "ko"))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y - 1)}
              aria-label="이전 연도"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y + 1)}
              aria-label="다음 연도"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          onRowDoubleClicked={(r) => router.push(`/invoices/${r.id}`)}
          onAdd={() => router.push("/invoices/new")}
          onDelete={handleDelete}
          enableCheckbox
          autoSizeStrategy={{ type: "fitCellContents", colIds: [] }}
        />
      </div>
    </>
  );
}
