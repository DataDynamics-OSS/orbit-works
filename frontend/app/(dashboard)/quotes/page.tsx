"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { api } from "@/lib/api";
import { Currency, formatCurrency } from "@/lib/billing";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { useDialog } from "@/components/ui/DialogProvider";

type Customer = { id: string; name: string };

type QuoteRow = {
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
  valid_until: string | null;
  currency: Currency;
  locale?: "ko" | "en";
  total_amount: string;
};

export default function QuotesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);

  const { data: rows = [] } = useQuery<QuoteRow[]>({
    queryKey: ["quotes", year],
    queryFn: async () => (await api.get("/quotes", { params: { year } })).data,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  const copyM = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/quotes/${id}/copy`)).data,
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      router.push(`/quotes/${data.id}`);
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/quotes/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quotes"] }),
  });

  async function handleDelete(sel: QuoteRow[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 견적서를 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  const columnDefs = useMemo<ColDef<QuoteRow>[]>(
    () => [
      {
        colId: "number",
        field: "display_number",
        headerName: "견적서 번호",
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
      { field: "valid_until", headerName: "유효기간", width: 120, flex: 0 },
      { field: "currency", headerName: "통화", width: 80, flex: 0 },
      {
        field: "locale",
        headerName: "언어",
        width: 70,
        flex: 0,
        cellRenderer: (p: any) => {
          const v = (p.value ?? "ko") as "ko" | "en";
          return (
            <span
              className={
                "inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-semibold " +
                (v === "en"
                  ? "bg-blue-100 text-blue-700"
                  : "bg-zinc-100 text-zinc-700")
              }
              title={v === "en" ? "영문 (English)" : "한국어"}
            >
              {v.toUpperCase()}
            </span>
          );
        },
      },
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
        title="견적서"
        actions={
          <div className="flex gap-2 items-center">
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
          onRowDoubleClicked={(r) => router.push(`/quotes/${r.id}`)}
          onAdd={() => router.push("/quotes/new")}
          onDelete={handleDelete}
          enableCheckbox
          autoSizeStrategy={{ type: "fitCellContents", colIds: [] }}
        />
      </div>
    </>
  );
}
