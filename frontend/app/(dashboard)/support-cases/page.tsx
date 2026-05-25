"use client";

/**
 * 기술지원 — 케이스 (Cases) 페이지.
 *
 * 그리드 + 등록·편집 다이얼로그. 첨부·코멘트는 공용 블록 (`AttachmentsBlock`,
 * `CommentsBlock`) 으로 위임. 권한은 `support.manage` (SALES + HR + SUPPORT + ADMIN).
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Highcharts from "@/lib/highcharts-init";
import HighchartsReact from "highcharts-react-official";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { TipTapEditor } from "@/components/board/TipTapEditor";
import {
  AttachmentsBlock,
  type AttachmentRow,
} from "@/components/support/AttachmentsBlock";
import { type CommentRow } from "@/components/support/CommentsBlock";
import {
  SUPPORT_CASE_STATUS_LABEL,
  type SupportCaseStatus,
} from "@/lib/support-vendors";
import { MultiProductPicker, ProductItem } from "@/components/catalog/MultiProductPicker";
import { Combobox } from "@/components/ui/Combobox";
import {
  SUPPORT_SEVERITY_CHIP_CLASS,
  SUPPORT_SEVERITY_DESCRIPTION,
  SUPPORT_SEVERITY_LABEL,
  SUPPORT_SEVERITY_OPTIONS,
  type SupportSeverity,
} from "@/lib/support-severity";
import {
  SUPPORT_CASE_CATEGORY_COLORS,
  SUPPORT_CASE_CATEGORY_LABEL,
  SUPPORT_CASE_CATEGORY_OPTIONS,
  type SupportCaseCategory,
} from "@/lib/support-categories";

type Customer = { id: string; name: string };
type Project = { id: string; name: string; customer_id?: string | null };
type Developer = { id: string; name: string; employment_type: string };

type ProductOut = { product_id: string; product: string | null; version_id: string | null; version: string | null; sort_order: number };

type CaseRow = {
  id: string;
  case_no: string | null;
  customer_id: string;
  project_id: string | null;
  sales_rep_developer_id: string | null;
  support_engineer_developer_id: string | null;
  vendor: string | null;
  products: ProductOut[];
  vendor_case_no: string | null;
  title: string;
  status: SupportCaseStatus;
  category: SupportCaseCategory;
  severity: SupportSeverity;
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
  vendor: string;
  products: ProductItem[];
  vendor_case_no: string;
  title: string;
  status: SupportCaseStatus;
  category: SupportCaseCategory;
  severity: SupportSeverity;
  body: string;
};

const BLANK: Form = {
  customer_id: "",
  project_id: "",
  sales_rep_developer_id: "",
  support_engineer_developer_id: "",
  vendor: "",
  products: [],
  vendor_case_no: "",
  title: "",
  status: "OPEN",
  category: "OTHER",
  severity: "S3",
  body: "",
};

export default function SupportCasesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [statusFilter, setStatusFilter] = useState<SupportCaseStatus | "">("");

  const currentYear = new Date().getFullYear();
  type StatsBucket = { label: string; count: number };
  type CaseStats = {
    year: number;
    year_count: number;
    by_severity: StatsBucket[];
    by_status: StatsBucket[];
    by_category: StatsBucket[];
    by_product: StatsBucket[];
    by_engineer: StatsBucket[];
  };
  const { data: stats } = useQuery<CaseStats>({
    queryKey: ["support-cases-stats", currentYear],
    queryFn: async () =>
      (
        await api.get("/support-cases/stats", { params: { year: currentYear } })
      ).data,
    staleTime: 60_000,
  });

  const { data: rows = [] } = useQuery<CaseRow[]>({
    queryKey: ["support-cases", statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      return (await api.get("/support-cases", { params })).data;
    },
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "support-cases"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 5 * 60_000,
  });
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects-picker", "support-cases"],
    // /projects 는 router-wide 메뉴 게이트("projects" = SALES/HR) 라 SUPPORT 가
    // picker 호출 시 403. customers 메뉴 권한자(SALES/SUPPORT) 모두 호출 가능한
    // sub-endpoint 사용 — 이름·customer_id 만 lightweight 으로 반환.
    queryFn: async () => (await api.get("/customers/projects-picker")).data,
    staleTime: 5 * 60_000,
  });
  // 영업대표 / 엔지니어 — 정규직(FULL_TIME) + 재직(ACTIVE) 만 directory 에서 가져옴.
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
        vendor: form.vendor,
        // 다중 — backend 가 (product, version) 이름쌍 lookup-or-create.
        products: form.products.map((p, i) => ({
          product: p.product,
          version: p.version || null,
          sort_order: i,
        })),
        vendor_case_no: form.vendor_case_no || null,
        title: form.title.trim(),
        status: form.status,
        category: form.category,
        severity: form.severity,
        body: form.body || null,
      };
      let id: string;
      if (form.id) {
        await api.patch(`/support-cases/${form.id}`, body);
        id = form.id;
      } else {
        const { data } = await api.post("/support-cases", body);
        id = data.id;
      }
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        await api.post(`/support-cases/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["support-cases"] });
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
      Promise.all(ids.map((id) => api.delete(`/support-cases/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["support-cases"] }),
  });

  function startAdd() {
    setForm(BLANK);
    setPendingFiles([]);
    setExistingAttachments([]);
    setOpen(true);
  }

  function startEdit(r: CaseRow) {
    setForm({
      id: r.id,
      customer_id: r.customer_id,
      project_id: r.project_id ?? "",
      sales_rep_developer_id: r.sales_rep_developer_id ?? "",
      support_engineer_developer_id: r.support_engineer_developer_id ?? "",
      vendor: r.vendor ?? "",
      products: (r.products ?? []).map((p) => ({
        product: p.product ?? "",
        version: p.version ?? "",
      })),
      vendor_case_no: r.vendor_case_no ?? "",
      title: r.title ?? "",
      status: r.status,
      category: r.category ?? "OTHER",
      severity: r.severity ?? "S3",
      body: r.body ?? "",
    });
    setPendingFiles([]);
    setExistingAttachments(r.attachments || []);
    setOpen(true);
  }

  async function handleDelete(sel: CaseRow[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 케이스를 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  const columnDefs = useMemo<ColDef<CaseRow>[]>(
    () => [
      {
        field: "case_no",
        headerName: "케이스 번호",
        width: 100,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        // 케이스 번호 셀 클릭 → 상세 (case_no 가 있으면 그것을, 없으면 UUID).
        cellRenderer: (p: any) => {
          const cn = p.value as string | null;
          const id = p.data?.id;
          const key = cn || id;
          if (!key) return "—";
          return (
            <Link
              href={`/support-cases/${key}`}
              className="text-primary hover:underline tabular-nums"
              onClick={(e) => e.stopPropagation()}
            >
              {cn || "—"}
            </Link>
          );
        },
      },
      {
        field: "customer_name",
        headerName: "고객사",
        width: 100,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
      },
      {
        field: "title",
        headerName: "제목",
        flex: 50,
        minWidth: 220,
        headerClass: "ag-header-center",
        wrapText: true,
        autoHeight: true,
        // 제목 셀 클릭 → 상세 화면. case_no 우선, 없으면 UUID.
        cellRenderer: (p: any) => {
          const cn = p.data?.case_no as string | null;
          const id = p.data?.id;
          const key = cn || id;
          const name = p.value || "—";
          if (!key) return name;
          return (
            <Link
              href={`/support-cases/${key}`}
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {name}
            </Link>
          );
        },
      },
      {
        field: "project_name",
        headerName: "프로젝트",
        width: 290,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "sales_rep_name",
        headerName: "영업대표",
        width: 80,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "support_engineer_name",
        headerName: "엔지니어",
        width: 80,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "vendor",
        headerName: "벤더",
        width: 100,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) => p.value ?? "—",
      },
      {
        colId: "products",
        headerName: "제품",
        width: 140,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueGetter: (p) => {
          const list = (p.data?.products ?? []) as ProductOut[];
          if (list.length === 0) return "—";
          const first = list[0].product || "—";
          return list.length > 1 ? `${first} 외 ${list.length - 1}건` : first;
        },
      },
      {
        field: "vendor_case_no",
        headerName: "벤더 케이스 #",
        width: 110,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "status",
        headerName: "상태",
        width: 50,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) => SUPPORT_CASE_STATUS_LABEL[p.value as SupportCaseStatus] ?? p.value,
      },
      {
        field: "category",
        headerName: "유형",
        width: 90,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        valueFormatter: (p) =>
          SUPPORT_CASE_CATEGORY_LABEL[p.value as SupportCaseCategory] ?? p.value ?? "—",
      },
      {
        field: "severity",
        headerName: "심각도",
        width: 60,
        flex: 0,
        cellStyle: { textAlign: "center" },
        headerClass: "ag-header-center",
        cellRenderer: (p: any) => {
          const sev = (p.value as SupportSeverity) ?? "S3";
          const cls = SUPPORT_SEVERITY_CHIP_CLASS[sev] ?? "";
          return (
            <Tooltip
              label={SUPPORT_SEVERITY_DESCRIPTION[sev]}
              side="top"
            >
              <span
                className={
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold leading-none " +
                  cls
                }
              >
                <span className="font-mono tracking-tight">{sev}</span>
                <span className="opacity-90">{SUPPORT_SEVERITY_LABEL[sev]}</span>
              </span>
            </Tooltip>
          );
        },
      },
    ],
    [],
  );

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <>
      <DashboardHeader
        title="기술지원 — 케이스"
        actions={
          <div className="flex gap-2 items-center">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as SupportCaseStatus | "")}
              className="h-8 rounded-md border border-border bg-card shadow-sm px-2 text-sm"
            >
              <option value="">전체 상태</option>
              <option value="OPEN">{SUPPORT_CASE_STATUS_LABEL.OPEN}</option>
              <option value="IN_PROGRESS">{SUPPORT_CASE_STATUS_LABEL.IN_PROGRESS}</option>
              <option value="CLOSED">{SUPPORT_CASE_STATUS_LABEL.CLOSED}</option>
            </select>
          </div>
        }
      />

      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        {/* 5 파이 차트 — 1 row. */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <ChartCard title="심각도별">
            <PieChart data={stats?.by_severity ?? []} unit="건" colorMap={SEVERITY_COLORS} />
          </ChartCard>
          <ChartCard title="상태별">
            <PieChart data={stats?.by_status ?? []} unit="건" colorMap={STATUS_COLORS} />
          </ChartCard>
          <ChartCard title="유형별">
            <PieChart
              data={stats?.by_category ?? []}
              unit="건"
              colorMap={SUPPORT_CASE_CATEGORY_COLORS}
              labelMap={SUPPORT_CASE_CATEGORY_LABEL}
            />
          </ChartCard>
          <ChartCard title="제품별">
            <PieChart data={stats?.by_product ?? []} unit="건" />
          </ChartCard>
          <ChartCard title="엔지니어별">
            <PieChart data={stats?.by_engineer ?? []} unit="건" />
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
        title={form.id ? "케이스 편집" : "새 케이스"}
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
                !form.vendor ||
                !form.title.trim()
              }
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="제목 *" colSpan={2}>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={input}
              maxLength={300}
              placeholder="케이스 제목 (예: NiFi flow 처리 지연)"
            />
          </Field>
          <Field label="고객사 *">
            <select
              value={form.customer_id}
              onChange={(e) =>
                // 고객사 변경 시 프로젝트도 리셋 — 새 고객사에 속하지 않는 옛
                // 프로젝트 id 가 남지 않도록.
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
          <Field label="벤더 케이스 번호">
            <input
              value={form.vendor_case_no}
              onChange={(e) => setForm({ ...form, vendor_case_no: e.target.value })}
              className={input}
              placeholder="예: CLDR-12345"
            />
          </Field>
          <Field label="상태">
            <select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as SupportCaseStatus })
              }
              className={input}
            >
              <option value="OPEN">{SUPPORT_CASE_STATUS_LABEL.OPEN}</option>
              <option value="IN_PROGRESS">{SUPPORT_CASE_STATUS_LABEL.IN_PROGRESS}</option>
              <option value="CLOSED">{SUPPORT_CASE_STATUS_LABEL.CLOSED}</option>
            </select>
          </Field>
          <Field label="유형 *">
            <select
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value as SupportCaseCategory })
              }
              className={input}
            >
              {SUPPORT_CASE_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {SUPPORT_CASE_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="심각도">
            <select
              value={form.severity}
              onChange={(e) =>
                setForm({ ...form, severity: e.target.value as SupportSeverity })
              }
              className={input}
              title={SUPPORT_SEVERITY_DESCRIPTION[form.severity]}
            >
              {SUPPORT_SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s} · {SUPPORT_SEVERITY_LABEL[s]} — {SUPPORT_SEVERITY_DESCRIPTION[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="케이스 세부 내용" colSpan={2}>
            <TipTapEditor
              value={form.body}
              onChange={(html) => setForm({ ...form, body: html })}
            />
          </Field>

          <div className="col-span-2 mt-2 pt-3 border-t border-border space-y-2">
            <h4 className="text-sm font-semibold">첨부파일</h4>
            <AttachmentsBlock
              baseUrl="/support-cases"
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
                  href={`/support-cases/${form.id}`}
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

// vendor 단일 Combobox — MultiProductPicker 의 product 옵션 필터링에 필요.
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

// ---------------------------------------------------------------------------
// 파이 차트.
// ---------------------------------------------------------------------------

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <h3 className="font-semibold text-sm mb-1">{title}</h3>
      {children}
    </div>
  );
}

// 심각도/상태는 의미가 강한 색 — 고정 매핑.
const SEVERITY_COLORS: Record<string, string> = {
  S1: "#ef4444",
  S2: "#f97316",
  S3: "#f59e0b",
  S4: "#22c55e",
  S5: "#0ea5e9",
};
const STATUS_COLORS: Record<string, string> = {
  OPEN: "#0ea5e9",
  IN_PROGRESS: "#f59e0b",
  CLOSED: "#22c55e",
};
const STATUS_LABEL_MAP: Record<string, string> = {
  OPEN: "신규",
  IN_PROGRESS: "진행 중",
  CLOSED: "완료",
};
// 임의 라벨용 파레트 — 제품·엔지니어 등.
const FALLBACK_COLORS = [
  "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#6366f1",
  "#06b6d4", "#84cc16", "#f97316", "#a855f7", "#14b8a6",
];

function PieChart({
  data,
  unit,
  colorMap,
  labelMap,
}: {
  data: { label: string; count: number }[];
  unit: string;
  colorMap?: Record<string, string>;
  /** label 의 영문 key 를 한글로 변환할 때 사용. 미지정 시 영문 그대로 + STATUS_LABEL_MAP fallback. */
  labelMap?: Record<string, string>;
}) {
  const options: Highcharts.Options = {
    chart: {
      type: "pie",
      height: 180,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
      spacing: [4, 4, 4, 4],
    },
    title: { text: undefined },
    credits: { enabled: false },
    tooltip: {
      useHTML: true,
      formatter() {
        const v = Number(this.y) || 0;
        const pct = (this as any).percentage as number | undefined;
        return `<div style="font-size:11px"><b>${(this as any).point.name}</b><br/>${v.toLocaleString()}${unit}${pct != null ? ` (${pct.toFixed(1)}%)` : ""}</div>`;
      },
    },
    plotOptions: {
      pie: {
        innerSize: "55%",
        borderWidth: 0,
        dataLabels: {
          enabled: true,
          format: "{point.percentage:.0f}%",
          distance: -16,
          style: { fontSize: "10px", color: "#fff", textOutline: "none" },
          filter: { property: "percentage", operator: ">", value: 6 },
        },
        showInLegend: true,
      },
    },
    legend: {
      enabled: true,
      align: "right",
      verticalAlign: "middle",
      layout: "vertical",
      itemStyle: { fontSize: "10px", fontWeight: "normal", color: "#334155" },
      itemMarginTop: 0,
      itemMarginBottom: 0,
      symbolHeight: 8,
      symbolWidth: 8,
      symbolRadius: 2,
      squareSymbol: true,
      itemDistance: 4,
      padding: 0,
      margin: 0,
    },
    series: [
      {
        type: "pie",
        data: data.map((b, i) => ({
          name: labelMap?.[b.label] ?? STATUS_LABEL_MAP[b.label] ?? b.label,
          y: b.count,
          color:
            (colorMap && colorMap[b.label]) ||
            FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        })),
      },
    ],
  };
  if (data.length === 0) {
    return (
      <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">
        데이터 없음
      </div>
    );
  }
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}
