"use client";

/**
 * 출장 일정 — 목록.
 *
 * 본인이 만든 출장만 표시. 새 출장 생성 모달에서 이름·기간·출발/도착 공항을
 * 입력하면 IATA 매핑으로 origin_tz/destination_tz 가 자동 채움.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { findAirport } from "@/lib/airports";
import { AirportPicker } from "@/components/trips/AirportPicker";

type TripRow = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  origin_tz: string;
  destination_tz: string;
  origin_iata: string | null;
  destination_iata: string | null;
  notes: string | null;
  events: { id: string }[];
  created_at: string;
};

// 공항 셀 — IATA(상단) + 공항 이름(하단, wrap). wrapText/autoHeight 컬럼 옵션과
// 조합해 행 높이가 자동으로 늘어남.
function airportCellRenderer(p: { value: string | null }) {
  if (!p.value) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const a = findAirport(p.value);
  return (
    <div className="flex flex-col items-center justify-center py-1 text-center leading-tight">
      <span className="font-mono text-xs font-semibold">{p.value}</span>
      {a && (
        <span className="block whitespace-normal break-words text-xs text-muted-foreground">
          {a.name}
        </span>
      )}
    </div>
  );
}

const BLANK = {
  name: "",
  start_date: "",
  end_date: "",
  origin_iata: "",
  origin_tz: "",
  destination_iata: "",
  destination_tz: "",
  notes: "",
};

export default function TripsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();

  const deleteMut = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => api.delete(`/trips/${id}`)));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trips"] }),
    onError: (e: any) =>
      alert(e?.response?.data?.detail || e?.message || "삭제 실패"),
  });

  const { data: rows = [], isLoading } = useQuery<TripRow[]>({
    queryKey: ["trips"],
    queryFn: async () => (await api.get("/trips")).data,
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("출장명을 입력하세요.");
      if (!form.start_date || !form.end_date)
        throw new Error("기간을 모두 입력하세요.");
      if (!form.origin_tz || !form.destination_tz)
        throw new Error("출발지/도착지 공항을 선택하세요.");
      if (form.end_date < form.start_date)
        throw new Error("종료일이 시작일보다 빠릅니다.");
      const { data } = await api.post("/trips", {
        name: form.name.trim(),
        start_date: form.start_date,
        end_date: form.end_date,
        origin_tz: form.origin_tz,
        destination_tz: form.destination_tz,
        origin_iata: form.origin_iata || null,
        destination_iata: form.destination_iata || null,
        notes: form.notes || null,
      });
      return data as TripRow;
    },
    onSuccess: (t) => {
      setOpen(false);
      setForm({ ...BLANK });
      qc.invalidateQueries({ queryKey: ["trips"] });
      router.push(`/trips/${t.id}`);
    },
    onError: (e: any) => {
      alert(e?.response?.data?.detail || e?.message || "생성 실패");
    },
  });

  const cols = useMemo<ColDef<TripRow>[]>(
    () => [
      {
        field: "name",
        headerName: "출장명",
        flex: 2,
        minWidth: 220,
        cellRenderer: (p: any) => {
          const id = p.data?.id;
          const name = p.value || "—";
          if (!id) return name;
          return (
            <Link
              href={`/trips/${id}`}
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {name}
            </Link>
          );
        },
      },
      {
        headerName: "기간",
        width: 176,
        minWidth: 176,
        maxWidth: 176,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueGetter: (p) =>
          p.data ? `${p.data.start_date} → ${p.data.end_date}` : "",
      },
      {
        headerName: "일수",
        width: 60,
        minWidth: 60,
        maxWidth: 60,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueGetter: (p) => {
          if (!p.data) return null;
          const s = new Date(p.data.start_date + "T00:00:00Z").getTime();
          const e = new Date(p.data.end_date + "T00:00:00Z").getTime();
          return Math.round((e - s) / 86400000) + 1;
        },
      },
      {
        field: "origin_iata",
        headerName: "출발 공항",
        width: 140,
        minWidth: 140,
        maxWidth: 140,
        flex: 0,
        headerClass: "ag-header-center",
        wrapText: true,
        autoHeight: true,
        cellRenderer: airportCellRenderer,
      },
      {
        field: "origin_tz",
        headerName: "출발 Timezone",
        width: 176,
        minWidth: 176,
        maxWidth: 176,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
      },
      {
        field: "destination_iata",
        headerName: "도착 공항",
        width: 140,
        minWidth: 140,
        maxWidth: 140,
        flex: 0,
        headerClass: "ag-header-center",
        wrapText: true,
        autoHeight: true,
        cellRenderer: airportCellRenderer,
      },
      {
        field: "destination_tz",
        headerName: "도착 Timezone",
        width: 192,
        minWidth: 192,
        maxWidth: 192,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="해외출장 일정표" />
      <div className="flex flex-1 min-h-0 flex-col gap-2 p-4">
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-900">
          KST Timezone 과 시간 차이가 많이 발생하는 Timezone 으로 출장 시,
          Timezone 의 시간차이로 인하여 스케줄 구성이 어려운 문제를 해결하기 위해
          제공되는 기능이며, 일정표에 KST Timezone 이 같이 표시됩니다.
        </div>
        <DataGrid<TripRow>
          rowData={rows}
          columnDefs={cols}
          getRowId={(r) => r.id}
          onAdd={() => {
            setForm({ ...BLANK });
            setOpen(true);
          }}
          addLabel="새 출장"
          onDelete={async (selected) => {
            if (selected.length === 0) return;
            const names = selected.map((r) => r.name).join(", ");
            if (
              await dialog.confirm(
                `다음 출장(${selected.length}건)을 삭제할까요? 일정과 준비물 모두 사라집니다.\n${names}`,
                { confirmText: "삭제" },
              )
            ) {
              deleteMut.mutate(selected.map((r) => r.id));
            }
          }}
          searchPlaceholder="출장명 검색"
          disableFilters
        />
        {isLoading && (
          <p className="text-xs text-muted-foreground">불러오는 중…</p>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="새 출장"
        width="max-w-xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              취소
            </button>
            <button
              type="button"
              disabled={createMut.isPending}
              onClick={() => createMut.mutate()}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              생성
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 p-4">
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">출장명</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              placeholder="예: SFO 5일 출장"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">시작일 (도착지 기준)</span>
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">종료일 (도착지 기준)</span>
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>

          <div className="col-span-2 grid grid-cols-2 gap-3">
            <div>
              <span className="text-xs text-muted-foreground">출발지 공항</span>
              <AirportPicker
                value={form.origin_iata}
                onChange={(iata) => {
                  const a = findAirport(iata);
                  setForm({
                    ...form,
                    origin_iata: iata,
                    origin_tz: a?.tz ?? "",
                  });
                }}
              />
              {form.origin_tz && (
                <p className="mt-1 text-xs text-muted-foreground">
                  TZ: {form.origin_tz}
                </p>
              )}
            </div>
            <div>
              <span className="text-xs text-muted-foreground">도착지 공항</span>
              <AirportPicker
                value={form.destination_iata}
                onChange={(iata) => {
                  const a = findAirport(iata);
                  setForm({
                    ...form,
                    destination_iata: iata,
                    destination_tz: a?.tz ?? "",
                  });
                }}
              />
              {form.destination_tz && (
                <p className="mt-1 text-xs text-muted-foreground">
                  TZ: {form.destination_tz}
                </p>
              )}
            </div>
          </div>

          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">메모</span>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="rounded-md border border-input bg-background p-2 text-sm"
            />
          </label>
        </div>
      </Dialog>
    </>
  );
}
