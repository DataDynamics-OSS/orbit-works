"use client";

/**
 * 자원 > 서버 호스팅 — 회사가 사용 중인 서버 대장.
 *
 * - GRID 컬럼: IP·Core·RAM·Disk·OS·호스팅 업체·시작일·종료일·월 비용·유형·만료 알람
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

type HostingType = "DEDICATED" | "VPS" | "CLOUD" | "COLOCATION";

type ServerHosting = {
  id: string;
  ip: string;
  cpu_cores: number | null;
  ram_gb: number | null;
  disk_gb: number | null;
  os: string | null;
  purpose: string | null;
  vendor: string | null;
  start_date: string | null;
  end_date: string | null;
  monthly_cost: string | null;
  hosting_type: HostingType | null;
  expiry_alarm: boolean;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

const HOSTING_TYPE_OPTIONS: { value: HostingType; label: string }[] = [
  { value: "DEDICATED", label: "전용서버" },
  { value: "VPS", label: "VPS" },
  { value: "CLOUD", label: "클라우드" },
  { value: "COLOCATION", label: "코로케이션" },
];

const HOSTING_TYPE_LABEL: Record<HostingType, string> = Object.fromEntries(
  HOSTING_TYPE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<HostingType, string>;

const BLANK_FORM = {
  ip: "",
  cpu_cores: "",
  ram_gb: "",
  disk_gb: "",
  os: "",
  purpose: "",
  vendor: "",
  start_date: "",
  end_date: "",
  monthly_cost: "",
  hosting_type: "" as "" | HostingType,
  expiry_alarm: true,
  memo: "",
};

function fmtKrw(v: string | null): string {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `₩ ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// 정수부 천 단위 포맷터 — 입력창용. KRW 라 소수 미지원.
function fmtIntInput(raw: string): string {
  if (!raw) return "";
  return Number(raw).toLocaleString("en-US");
}

function fmtDate(v: string | null): string {
  return v ? String(v).slice(0, 10) : "-";
}

function daysUntil(end: string | null): number | null {
  if (!end) return null;
  const e = new Date(end);
  if (isNaN(e.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((e.getTime() - today.getTime()) / (24 * 3600 * 1000));
}

function fmtGb(v: number | null): string {
  return v == null ? "-" : `${v.toLocaleString("en-US")} GB`;
}

export default function ServerHostingsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<ServerHosting>>(null);

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const canManage =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  const { data: rows = [], isLoading } = useQuery<ServerHosting[]>({
    queryKey: ["server-hostings"],
    queryFn: async () => (await api.get("/server-hostings")).data,
    staleTime: 30_000,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ServerHosting | null>(null);
  const [form, setForm] = useState({ ...BLANK_FORM });

  function openAdd() {
    setEditTarget(null);
    setForm({ ...BLANK_FORM });
    setEditOpen(true);
  }
  function openEdit(d: ServerHosting) {
    if (!canManage) return;
    setEditTarget(d);
    setForm({
      ip: d.ip,
      cpu_cores: d.cpu_cores != null ? String(d.cpu_cores) : "",
      ram_gb: d.ram_gb != null ? String(d.ram_gb) : "",
      disk_gb: d.disk_gb != null ? String(d.disk_gb) : "",
      os: d.os ?? "",
      purpose: d.purpose ?? "",
      vendor: d.vendor ?? "",
      start_date: d.start_date ?? "",
      end_date: d.end_date ?? "",
      // numeric(14,2) 라 API 가 "49000.00" 식으로 돌려줌 — 소수부 잘라내고
      // 정수 문자열로만 form 에 넣어야 저장 시 ".00" 이 다시 자릿수로 안 붙음.
      monthly_cost:
        d.monthly_cost != null
          ? String(Math.trunc(Number(d.monthly_cost)))
          : "",
      hosting_type: d.hosting_type ?? "",
      expiry_alarm: d.expiry_alarm,
      memo: d.memo ?? "",
    });
    setEditOpen(true);
  }

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form.ip.trim()) throw new Error("IP 를 입력하세요.");
      const toInt = (s: string): number | null =>
        s.trim() ? Number(s.replace(/[^\d]/g, "")) : null;
      const body = {
        ip: form.ip.trim(),
        cpu_cores: toInt(form.cpu_cores),
        ram_gb: toInt(form.ram_gb),
        disk_gb: toInt(form.disk_gb),
        os: form.os.trim() || null,
        purpose: form.purpose.trim() || null,
        vendor: form.vendor.trim() || null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        // 점이 섞여도 정수부만 — "49000.00" → "49000" (소수부 자리수가 정수에
        // 흡수되는 사고 방지).
        monthly_cost: form.monthly_cost
          ? form.monthly_cost.split(".")[0].replace(/[^\d]/g, "")
          : null,
        hosting_type: form.hosting_type || null,
        expiry_alarm: form.expiry_alarm,
        memo: form.memo.trim() || null,
      };
      if (editTarget) {
        return (await api.patch(`/server-hostings/${editTarget.id}`, body)).data;
      }
      return (await api.post("/server-hostings", body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["server-hostings"] });
      setEditOpen(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/server-hostings/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["server-hostings"] }),
  });

  async function handleDelete() {
    const sel = gridRef.current?.getSelectedRows() ?? [];
    if (sel.length === 0) return;
    const ok = await dialog.confirm(
      `선택된 서버 ${sel.length}개를 삭제하시겠습니까?`,
      { title: "서버 호스팅 삭제", confirmText: "삭제" },
    );
    if (!ok) return;
    await deleteM.mutateAsync(sel.map((d) => d.id));
  }

  const columnDefs = useMemo<ColDef<ServerHosting>[]>(
    () => [
      {
        field: "ip",
        headerName: "IP",
        width: 150,
        flex: 0,
        sortable: true,
        headerClass: "ag-center-aligned-header",
        cellStyle: { textAlign: "center", fontFamily: "ui-monospace, monospace" } as any,
      },
      {
        field: "cpu_cores",
        headerName: "Core",
        width: 60,
        flex: 0,
        sortable: true,
        valueFormatter: (p) => (p.value == null ? "-" : String(p.value)),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "ram_gb",
        headerName: "RAM",
        width: 60,
        flex: 0,
        sortable: true,
        valueFormatter: (p) => fmtGb(p.value),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "disk_gb",
        headerName: "Disk",
        width: 70,
        flex: 0,
        sortable: true,
        valueFormatter: (p) => fmtGb(p.value),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "os",
        headerName: "OS",
        width: 120,
        flex: 0,
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "purpose",
        headerName: "용도",
        flex: 1,
        minWidth: 140,
        valueFormatter: (p) => p.value ?? "-",
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "vendor",
        headerName: "호스팅 업체",
        width: 110,
        flex: 0,
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "start_date",
        headerName: "시작일",
        width: 75,
        flex: 0,
        sortable: true,
        valueFormatter: (p) => fmtDate(p.value),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "end_date",
        headerName: "종료일",
        width: 75,
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
        field: "monthly_cost",
        headerName: "월 비용",
        width: 80,
        flex: 0,
        valueFormatter: (p) => fmtKrw(p.value),
        cellStyle: { textAlign: "right" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "hosting_type",
        headerName: "유형",
        width: 80,
        flex: 0,
        valueFormatter: (p) =>
          p.value ? HOSTING_TYPE_LABEL[p.value as HostingType] ?? p.value : "-",
        cellStyle: { textAlign: "center" } as any,
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
      <DashboardHeader title="서버 호스팅" />
      <div className="flex flex-1 flex-col p-4 min-h-0">
        <DataGrid<ServerHosting>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="IP·OS·용도·호스팅 업체 검색"
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
        title={editTarget ? "서버 호스팅 수정" : "신규 서버 호스팅 등록"}
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
          <Field label="IP" colSpan={2}>
            <input
              autoFocus
              value={form.ip}
              onChange={(e) => setForm({ ...form, ip: e.target.value })}
              className={inputCls + " font-mono"}
              placeholder="예: 203.0.113.10 / 2001:db8::1"
            />
          </Field>
          <Field label="Core (vCPU)">
            <input
              value={form.cpu_cores}
              onChange={(e) =>
                setForm({
                  ...form,
                  cpu_cores: e.target.value.replace(/[^\d]/g, ""),
                })
              }
              className={inputCls + " text-right tabular-nums"}
              placeholder="예: 8"
              inputMode="numeric"
            />
          </Field>
          <Field label="RAM (GB)">
            <input
              value={form.ram_gb}
              onChange={(e) =>
                setForm({
                  ...form,
                  ram_gb: e.target.value.replace(/[^\d]/g, ""),
                })
              }
              className={inputCls + " text-right tabular-nums"}
              placeholder="예: 32"
              inputMode="numeric"
            />
          </Field>
          <Field label="Disk (GB)">
            <input
              value={form.disk_gb}
              onChange={(e) =>
                setForm({
                  ...form,
                  disk_gb: e.target.value.replace(/[^\d]/g, ""),
                })
              }
              className={inputCls + " text-right tabular-nums"}
              placeholder="예: 500"
              inputMode="numeric"
            />
          </Field>
          <Field label="OS">
            <input
              value={form.os}
              onChange={(e) => setForm({ ...form, os: e.target.value })}
              className={inputCls}
              placeholder="예: Ubuntu 22.04"
            />
          </Field>
          <Field label="용도" colSpan={2}>
            <input
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              className={inputCls}
              placeholder="자유 입력 (예: 운영 DB, 백업, 스테이징, 사내 GitLab)"
            />
          </Field>
          <Field label="호스팅 업체">
            <input
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              className={inputCls}
              placeholder="예: KT Cloud / NHN Cloud / AWS"
            />
          </Field>
          <Field label="호스팅 유형">
            <select
              value={form.hosting_type}
              onChange={(e) =>
                setForm({
                  ...form,
                  hosting_type: e.target.value as "" | HostingType,
                })
              }
              className={inputCls}
            >
              <option value="">선택</option>
              {HOSTING_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="호스팅 시작일">
            <input
              type="date"
              value={form.start_date}
              onChange={(e) =>
                setForm({ ...form, start_date: e.target.value })
              }
              className={inputCls}
            />
          </Field>
          <Field label="호스팅 종료일">
            <input
              type="date"
              value={form.end_date}
              onChange={(e) =>
                setForm({ ...form, end_date: e.target.value })
              }
              className={inputCls}
            />
          </Field>
          <Field label="월 비용 (KRW)">
            <input
              value={fmtIntInput(form.monthly_cost)}
              onChange={(e) =>
                setForm({
                  ...form,
                  monthly_cost: e.target.value.replace(/[^\d]/g, ""),
                })
              }
              className={inputCls + " text-right tabular-nums"}
              placeholder="0"
              inputMode="numeric"
            />
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
              placeholder="용도·접근 정보·관리자 등"
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
