"use client";

/**
 * 기술지원 — 활동 로그 (Logs) 페이지.
 *
 * 케이스 페이지와 같은 패턴. 차이:
 *  - 상태 enum 없음
 *  - 시작일/종료일 (default 동일) + duration_minutes ("Xh Ym" 형식 입력)
 *  - 필터: 벤더 / 기간(start_date 기준)
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Highcharts from "@/lib/highcharts-init";
import HighchartsReact from "highcharts-react-official";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import {
  AttachmentsBlock,
  type AttachmentRow,
} from "@/components/support/AttachmentsBlock";
import { type CommentRow } from "@/components/support/CommentsBlock";
import {
  formatDurationMinutes,
  parseDurationMinutes,
} from "@/lib/support-vendors";
import { MultiProductPicker, ProductItem } from "@/components/catalog/MultiProductPicker";
import { Combobox } from "@/components/ui/Combobox";
import { TipTapEditor } from "@/components/board/TipTapEditor";

type Customer = { id: string; name: string };
type Project = { id: string; name: string; customer_id?: string | null };
type Developer = { id: string; name: string; employment_type: string };

type ProductOut = { product_id: string; product: string | null; version_id: string | null; version: string | null; sort_order: number };

type LogRow = {
  id: string;
  customer_id: string;
  project_id: string | null;
  sales_rep_developer_id: string | null;
  support_engineer_developer_id: string | null;
  start_date: string;
  end_date: string;
  duration_minutes: number;
  vendor: string | null;
  products: ProductOut[];
  body: string | null;
  customer_name: string | null;
  project_name: string | null;
  sales_rep_name: string | null;
  support_engineer_name: string | null;
  attachments: AttachmentRow[];
  comments: CommentRow[];
  created_at: string;
};

type Form = {
  id?: string;
  customer_id: string;
  project_id: string;
  sales_rep_developer_id: string;
  support_engineer_developer_id: string;
  start_date: string;
  end_date: string;
  duration_text: string;        // 입력은 "2시간 30분" 형식. 저장 시 분으로 변환.
  vendor: string;
  products: ProductItem[];       // 다중 — { product, version } 의 리스트.
  body: string;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BLANK: Form = {
  customer_id: "",
  project_id: "",
  sales_rep_developer_id: "",
  support_engineer_developer_id: "",
  start_date: todayISO(),
  end_date: todayISO(),
  duration_text: "",
  vendor: "",
  products: [],
  body: "",
};

export default function SupportLogsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  // 그리드 기간 필터 — < YYYY-MM > 단위. 기본 현재 월.
  const [yearMonth, setYearMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const { from, to } = useMemo(() => {
    const [y, m] = yearMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const mm = String(m).padStart(2, "0");
    return {
      from: `${y}-${mm}-01`,
      to: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
    };
  }, [yearMonth]);
  function shiftMonth(delta: number) {
    const [y, m] = yearMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setYearMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const { data: rows = [] } = useQuery<LogRow[]>({
    queryKey: ["support-logs", from, to],
    queryFn: async () => {
      const params: Record<string, string> = { from, to };
      return (await api.get("/support-logs", { params })).data;
    },
  });

  // KPI — 코멘트 단위 집계 (comment.start_date 기준). 헤더의 < > 로 선택한
  // yearMonth 를 따라 함께 변함. "이번달*" 라벨은 선택된 월의 데이터를 의미.
  const [selectedYear, selectedMonth] = useMemo(() => {
    const [y, m] = yearMonth.split("-").map(Number);
    return [y, m];
  }, [yearMonth]);
  type StatsResp = {
    year: number;
    month: number;
    year_count: number;
    year_minutes: number;
    year_customers: number;
    month_count: number;
    month_minutes: number;
    month_customers: number;
  };
  const { data: stats } = useQuery<StatsResp>({
    queryKey: ["support-logs-stats", selectedYear, selectedMonth],
    queryFn: async () =>
      (
        await api.get("/support-logs/stats", {
          params: { year: selectedYear, month: selectedMonth },
        })
      ).data,
    staleTime: 60_000,
  });

  const { data: charts } = useQuery<ChartsResp>({
    queryKey: ["support-logs-charts", selectedYear],
    queryFn: async () =>
      (
        await api.get("/support-logs/charts", { params: { year: selectedYear } })
      ).data,
    staleTime: 60_000,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "support-logs"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 5 * 60_000,
  });
  // /projects 는 router-wide 메뉴 게이트("projects" = SALES/HR) 라 SUPPORT 가
  // 다이얼로그 호출 시 403. customers 메뉴 권한자(SALES/SUPPORT) 모두 호출 가능한
  // sub-endpoint 사용 — 이름·customer_id 만 lightweight 으로 반환.
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects-picker", "support-logs"],
    queryFn: async () => (await api.get("/customers/projects-picker")).data,
    staleTime: 5 * 60_000,
  });
  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers-directory", "FULL_TIME"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<AttachmentRow[]>([]);

  const saveM = useMutation({
    mutationFn: async () => {
      const body = {
        customer_id: form.customer_id,
        project_id: form.project_id || null,
        sales_rep_developer_id: form.sales_rep_developer_id || null,
        support_engineer_developer_id: form.support_engineer_developer_id || null,
        start_date: form.start_date,
        end_date: form.end_date,
        duration_minutes: parseDurationMinutes(form.duration_text),
        vendor: form.vendor,
        // 다중 — backend 가 (product, version) 이름쌍을 lookup-or-create.
        products: form.products.map((p, i) => ({
          product: p.product,
          version: p.version || null,
          sort_order: i,
        })),
        body: form.body || null,
      };
      let id: string;
      if (form.id) {
        await api.patch(`/support-logs/${form.id}`, body);
        id = form.id;
      } else {
        const { data } = await api.post("/support-logs", body);
        id = data.id;
      }
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        await api.post(`/support-logs/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["support-logs"] });
      setOpen(false);
      setForm(BLANK);
      setPendingFiles([]);
      setExistingAttachments([]);
    },
    onError: async (e: any) => {
      const msg = e?.response?.data?.detail ?? "저장 실패";
      await dialog.alert(typeof msg === "string" ? msg : JSON.stringify(msg), {
        title: "오류",
      });
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/support-logs/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["support-logs"] }),
  });

  function startAdd() {
    setForm(BLANK);
    setPendingFiles([]);
    setExistingAttachments([]);
    setOpen(true);
  }

  function startEdit(r: LogRow) {
    setForm({
      id: r.id,
      customer_id: r.customer_id,
      project_id: r.project_id ?? "",
      sales_rep_developer_id: r.sales_rep_developer_id ?? "",
      support_engineer_developer_id: r.support_engineer_developer_id ?? "",
      start_date: r.start_date,
      end_date: r.end_date,
      duration_text: formatDurationMinutes(r.duration_minutes),
      vendor: r.vendor ?? "",
      products: (r.products ?? []).map((p) => ({
        product: p.product ?? "",
        version: p.version ?? "",
      })),
      body: r.body ?? "",
    });
    setPendingFiles([]);
    setExistingAttachments(r.attachments || []);
    setOpen(true);
  }

  async function handleDelete(sel: LogRow[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 기술지원 로그를 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  const columnDefs = useMemo<ColDef<LogRow>[]>(
    () => [
      { field: "start_date", headerName: "시작일", width: 80, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" } },
      { field: "end_date", headerName: "종료일", width: 80, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" } },
      {
        field: "duration_minutes",
        headerName: "소요 시간",
        width: 110,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        valueFormatter: (p) => formatDurationMinutes(p.value as number),
      },
      { field: "customer_name", headerName: "고객사", width: 190, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" } },
      {
        field: "project_name",
        headerName: "프로젝트",
        // 그리드 폭이 바뀌면 남은 공간을 비례 차지 — flex:1, minWidth 로 너무 좁아지지 않게.
        flex: 1,
        minWidth: 180,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        // 프로젝트 셀 클릭 → 상세 화면 이동. 정렬은 가능, 단순 link 표시.
        cellRenderer: (p: any) => {
          const id = p.data?.id;
          const name = p.value || "—";
          if (!id) return name;
          return (
            <Link
              href={`/support-logs/${id}`}
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {name}
            </Link>
          );
        },
      },
      { field: "sales_rep_name", headerName: "영업대표", width: 100, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" }, valueFormatter: (p) => p.value || "—" },
      { field: "support_engineer_name", headerName: "엔지니어", width: 100, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" }, valueFormatter: (p) => p.value || "—" },
      {
        field: "vendor",
        headerName: "벤더",
        width: 100,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        valueFormatter: (p) => p.value ?? "—",
      },
      // 다중 product — 첫 product 이름 + 나머지 개수.
      {
        colId: "products",
        headerName: "제품",
        width: 140,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        valueGetter: (p) => {
          const list = (p.data?.products ?? []) as ProductOut[];
          if (list.length === 0) return "—";
          const first = list[0].product || "—";
          return list.length > 1 ? `${first} 외 ${list.length - 1}건` : first;
        },
      },
    ],
    [],
  );

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <>
      <DashboardHeader
        title="기술지원 — 활동 로그"
        actions={
          <div className="flex gap-2 items-center">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                title="이전 월"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm hover:bg-muted"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <input
                type="month"
                value={yearMonth}
                onChange={(e) => e.target.value && setYearMonth(e.target.value)}
                className="h-8 rounded-md border border-border bg-card shadow-sm px-2 text-sm tabular-nums"
                title="조회 월"
              />
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                title="다음 월"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm hover:bg-muted"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        }
      />

      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <KpiCard label={`올해 지원 건수 (${selectedYear})`}   value={`${stats?.year_count ?? 0} 건`} />
          <KpiCard label={`올해 지원 시간 (${selectedYear})`}   value={formatDurationMinutes(stats?.year_minutes ?? 0) || "0분"} />
          <KpiCard label={`올해 고객사 수 (${selectedYear})`}   value={`${stats?.year_customers ?? 0} 곳`} />
          <KpiCard label={`${selectedMonth}월 지원 건수`}        value={`${stats?.month_count ?? 0} 건`} />
          <KpiCard label={`${selectedMonth}월 지원 시간`}        value={formatDurationMinutes(stats?.month_minutes ?? 0) || "0분"} />
          <KpiCard label={`${selectedMonth}월 고객사 수`}        value={`${stats?.month_customers ?? 0} 곳`} />
        </div>

        {/* 월별 차트 — 코멘트 단위. 1 row x 4 columns. */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <ChartCard title={`월별 지원 시간 (${selectedYear})`}>
            <MonthlyMinutesChart values={charts?.monthly_minutes ?? new Array(12).fill(0)} />
          </ChartCard>
          <ChartCard title={`월별 지원 건수 (${selectedYear})`}>
            <MonthlyCountChart values={charts?.monthly_count ?? new Array(12).fill(0)} />
          </ChartCard>
          <ChartCard title={`월별 엔지니어별 지원 건수 (${selectedYear})`}>
            <EngineerStackChart
              series={charts?.by_engineer ?? []}
              field="monthly_count"
              unit="건"
            />
          </ChartCard>
          <ChartCard title={`월별 엔지니어별 지원 시간 (${selectedYear})`}>
            <EngineerStackChart
              series={charts?.by_engineer ?? []}
              field="monthly_minutes"
              unit="분"
            />
          </ChartCard>
        </div>

        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          onRowDoubleClicked={(r) => startEdit(r)}
          onAdd={startAdd}
          onDelete={handleDelete}
          enableCheckbox
          disableFilters
          autoSizeStrategy={{ type: "fitCellContents", colIds: [] }}
        />
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width="max-w-3xl"
        title={form.id ? "기술지원 활동 로그 편집" : "새 기술지원 활동 로그"}
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => saveM.mutate()}
              disabled={
                saveM.isPending ||
                !form.customer_id ||
                !form.start_date ||
                !form.end_date
              }
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="고객사 *">
            <select
              value={form.customer_id}
              onChange={(e) =>
                // 고객사가 바뀌면 선택돼 있던 프로젝트가 더 이상 유효하지 않을 수
                // 있으므로 project_id 도 같이 리셋.
                setForm({
                  ...form,
                  customer_id: e.target.value,
                  project_id: "",
                })
              }
              className={input}
            >
              <option value="">— 선택 —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="프로젝트">
            <select
              value={form.project_id}
              onChange={(e) => setForm({ ...form, project_id: e.target.value })}
              disabled={!form.customer_id}
              className={input}
            >
              <option value="">
                {form.customer_id ? "— 미연결 —" : "— 고객사 먼저 선택 —"}
              </option>
              {projects
                .filter((p) => p.customer_id === form.customer_id)
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </select>
          </Field>
          <Field label="영업대표 (정규직)">
            <select
              value={form.sales_rep_developer_id}
              onChange={(e) =>
                setForm({ ...form, sales_rep_developer_id: e.target.value })
              }
              className={input}
            >
              <option value="">— 선택 —</option>
              {developers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="기술지원 담당자 (정규직)">
            <select
              value={form.support_engineer_developer_id}
              onChange={(e) =>
                setForm({ ...form, support_engineer_developer_id: e.target.value })
              }
              className={input}
            >
              <option value="">— 선택 —</option>
              {developers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>

          {/* 시작일/종료일/소요 시간 — 모두 코멘트 집계로 자동 계산 (MIN/MAX/SUM). */}
          <div className="col-span-2 grid grid-cols-3 gap-3">
            <Field label="시작일 (코멘트 MIN)">
              <input
                type="date"
                value={form.start_date}
                readOnly
                tabIndex={-1}
                className={`${input} bg-muted text-muted-foreground cursor-not-allowed`}
              />
            </Field>
            <Field label="종료일 (코멘트 MAX)">
              <input
                type="date"
                value={form.end_date}
                readOnly
                tabIndex={-1}
                className={`${input} bg-muted text-muted-foreground cursor-not-allowed`}
              />
            </Field>
            <Field label="소요 시간 (코멘트 합)">
              <input
                value={form.duration_text || "0분"}
                readOnly
                tabIndex={-1}
                className={`${input} bg-muted text-muted-foreground cursor-not-allowed`}
              />
            </Field>
          </div>

          <Field label="제조사">
            <VendorCombobox
              value={form.vendor}
              onChange={(v) => setForm({ ...form, vendor: v, products: [] })}
              placeholder="예: Cloudera"
            />
          </Field>
          <Field label="제품 (여러 개 가능)" colSpan={2}>
            <MultiProductPicker
              vendor={form.vendor}
              items={form.products}
              onChange={(items) => setForm({ ...form, products: items })}
            />
          </Field>

          <Field label="기술지원 개요" colSpan={2}>
            <TipTapEditor
              value={form.body}
              onChange={(html) => setForm({ ...form, body: html })}
            />
          </Field>

          <div className="col-span-2 mt-2 pt-3 border-t border-border space-y-2">
            <h4 className="text-sm font-semibold">첨부파일</h4>
            <AttachmentsBlock
              baseUrl="/support-logs"
              recordId={form.id ?? null}
              pendingFiles={pendingFiles}
              setPendingFiles={setPendingFiles}
              existingAttachments={existingAttachments}
              setExistingAttachments={setExistingAttachments}
            />
          </div>

          {form.id && (
            <div className="col-span-2 mt-2 pt-3 border-t border-border">
              <p className="text-[11px] text-muted-foreground">
                코멘트 관리는{" "}
                <Link
                  href={`/support-logs/${form.id}`}
                  className="text-primary hover:underline"
                >
                  상세 화면
                </Link>
                에서 가능합니다.
              </p>
            </div>
          )}
        </div>
      </Dialog>
    </>
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
  const cls = colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// vendor 단일 Combobox — MultiProductPicker 의 product 옵션 필터링용으로 외부에서 관리.
// catalog/vendors 응답 캐싱은 react-query staleTime 60s.
function VendorCombobox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { data: vendors = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["catalog", "vendors", "active"],
    queryFn: async () => (await api.get("/catalog/vendors")).data,
    staleTime: 60_000,
  });
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={vendors.map((v) => v.name)}
      placeholder={placeholder}
    />
  );
}

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 월별 차트 (Highcharts column).
// ---------------------------------------------------------------------------

type EngineerSeries = {
  engineer_id: string | null;
  engineer_name: string;
  monthly_count: number[];
  monthly_minutes: number[];
};
type ChartsResp = {
  year: number;
  monthly_count: number[];
  monthly_minutes: number[];
  by_engineer: EngineerSeries[];
};

const MONTH_CATEGORIES = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);
// 엔지니어 시리즈용 팔레트 (반복 사용).
const ENG_COLORS = [
  "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#6366f1",
  "#06b6d4", "#84cc16", "#f97316", "#a855f7", "#14b8a6",
];

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="font-semibold mb-2 text-sm">{title}</h3>
      {children}
    </div>
  );
}

function buildBaseOptions(): Highcharts.Options {
  return {
    chart: {
      type: "column",
      height: 154,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      categories: MONTH_CATEGORIES,
      // 1/4 폭에서는 12개 라벨이 빽빽 — 짝수 월만 표시.
      labels: { step: 2, style: { fontSize: "10px", color: "#64748b" } },
    },
    yAxis: {
      title: { text: undefined },
      allowDecimals: false,
      min: 0,
      labels: { style: { fontSize: "10px", color: "#64748b" } },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    plotOptions: { column: { borderWidth: 0, pointPadding: 0.08, groupPadding: 0.12 } },
  };
}

function MonthlyMinutesChart({ values }: { values: number[] }) {
  const options: Highcharts.Options = {
    ...buildBaseOptions(),
    yAxis: {
      ...(buildBaseOptions().yAxis as object),
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          const v = Number(this.value);
          if (v >= 60) return `${Math.round(v / 60)}h`;
          return `${v}m`;
        },
      },
    },
    legend: { enabled: false },
    tooltip: {
      useHTML: true,
      formatter() {
        const monthLabel =
          (this as any).point?.category ??
          MONTH_CATEGORIES[Number(this.x) as number] ??
          this.x;
        const v = Number(this.y) || 0;
        const h = Math.floor(v / 60);
        const m = v % 60;
        const label = h > 0 ? `${h}시간 ${m}분` : `${m}분`;
        return `<div style="font-size:11px"><b>${monthLabel}</b><br/>지원 시간: <b>${label}</b></div>`;
      },
    },
    series: [
      { type: "column", name: "지원 시간(분)", color: "#0ea5e9", data: values },
    ],
  };
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}

function MonthlyCountChart({ values }: { values: number[] }) {
  const options: Highcharts.Options = {
    ...buildBaseOptions(),
    legend: { enabled: false },
    tooltip: {
      useHTML: true,
      formatter() {
        const monthLabel =
          (this as any).point?.category ??
          MONTH_CATEGORIES[Number(this.x) as number] ??
          this.x;
        return `<div style="font-size:11px"><b>${monthLabel}</b><br/>지원 건수: <b>${Number(this.y).toLocaleString()}건</b></div>`;
      },
    },
    series: [
      { type: "column", name: "지원 건수", color: "#10b981", data: values },
    ],
  };
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}

function EngineerStackChart({
  series,
  field,
  unit,
}: {
  series: EngineerSeries[];
  field: "monthly_count" | "monthly_minutes";
  unit: "건" | "분";
}) {
  const options: Highcharts.Options = {
    ...buildBaseOptions(),
    yAxis: {
      ...(buildBaseOptions().yAxis as object),
      ...(unit === "분"
        ? {
            labels: {
              style: { fontSize: "10px", color: "#64748b" },
              formatter() {
                const v = Number(this.value);
                if (v >= 60) return `${Math.round(v / 60)}h`;
                return `${v}m`;
              },
            },
          }
        : {}),
    },
    legend: {
      enabled: true,
      align: "center",
      verticalAlign: "bottom",
      layout: "horizontal",
      itemStyle: { fontSize: "10px", fontWeight: "normal", color: "#334155" },
      itemHiddenStyle: { color: "#94a3b8" },
      itemDistance: 8,
      margin: 2,
      padding: 0,
      symbolHeight: 8,
      symbolWidth: 8,
      symbolRadius: 2,
      symbolPadding: 4,
      itemMarginTop: 0,
      itemMarginBottom: 0,
      squareSymbol: true,
    },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        // shared 모드의 this.x 는 카테고리 인덱스 — 월 라벨로 매핑.
        const monthLabel =
          (this.points?.[0] as any)?.category ??
          MONTH_CATEGORIES[Number(this.x) as number] ??
          this.x;
        const rows = (this.points ?? [])
          .filter((p) => (p.y ?? 0) > 0)
          .map((p) => {
            const v = Number(p.y) || 0;
            const label =
              unit === "분"
                ? v >= 60
                  ? `${Math.floor(v / 60)}시간 ${v % 60}분`
                  : `${v}분`
                : `${v.toLocaleString()}건`;
            return `<div><span style="color:${p.color}">●</span> ${p.series.name}: <b>${label}</b></div>`;
          })
          .join("");
        return `<div style="font-size:11px;"><div style="margin-bottom:2px;font-weight:600;">${monthLabel}</div>${rows}</div>`;
      },
    },
    plotOptions: {
      column: {
        stacking: "normal",
        borderWidth: 0,
        pointPadding: 0.08,
        groupPadding: 0.12,
      },
    },
    series: series.map((s, i) => ({
      type: "column",
      name: s.engineer_name,
      color: ENG_COLORS[i % ENG_COLORS.length],
      data: s[field],
    })),
  };
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}
