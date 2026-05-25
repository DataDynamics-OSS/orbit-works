"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, Paperclip, Pencil, Plus, Replace, Save, Trash2, Upload, X } from "lucide-react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { api } from "@/lib/api";
import { formatKRW, formatMoney } from "@/lib/format";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, DataGridHandle } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";

type ContractType = "SOLO" | "CONSORTIUM" | "SUBCONTRACT";
type BusinessType = "RESEARCH" | "PUBLIC" | "PRIVATE";
type ContractCurrency = "KRW" | "USD";
type ProjectNature =
  | "CONSULTING"
  | "DEVELOPMENT"
  | "OPERATIONS_MAINTENANCE"
  | "TECHNICAL_SUPPORT";
type AttachmentSlot = "CONTRACT" | "QUOTE" | "PROPOSAL" | "TECH_NEGOTIATION" | "OTHER";

const CONTRACT_TYPE_LABEL: Record<ContractType, string> = {
  SOLO: "단독 수주",
  CONSORTIUM: "컨소시엄",
  SUBCONTRACT: "하도",
};

const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  RESEARCH: "연구과제",
  PUBLIC: "공공사업",
  PRIVATE: "민간사업",
};

const PROJECT_NATURE_LABEL: Record<ProjectNature, string> = {
  CONSULTING: "컨설팅",
  DEVELOPMENT: "개발",
  OPERATIONS_MAINTENANCE: "운영/유지보수",
  TECHNICAL_SUPPORT: "기술지원",
};

const ATTACHMENT_SLOTS: { slot: AttachmentSlot; label: string }[] = [
  { slot: "CONTRACT", label: "계약서" },
  { slot: "QUOTE", label: "견적서" },
  { slot: "PROPOSAL", label: "제안서" },
  { slot: "TECH_NEGOTIATION", label: "기술협상" },
  { slot: "OTHER", label: "기타" },
];

const ALARM_DAY_OPTIONS = [7, 15, 30, 60, 90] as const;

type ProjectAttachment = {
  id: string;
  project_id: string;
  slot: AttachmentSlot;
  file_name: string;
  mime_type?: string;
  size?: number;
};

type Project = {
  id: string;
  name: string;
  customer_id?: string | null;
  orderer_id?: string | null;
  start_date: string;
  end_date: string;
  total_contract_amount: string;
  contract_currency?: ContractCurrency;
  description?: string;
  contract_type?: ContractType | null;
  business_type?: BusinessType | null;
  project_nature?: ProjectNature | null;
  alarm_days_before?: number[] | null;
  ended_at?: string | null;
  attachments?: ProjectAttachment[];
  created_at: string;
};

type Customer = { id: string; name: string };

type ProjectForm = {
  name: string;
  customer_id?: string;
  orderer_id?: string;
  start_date: string;
  end_date: string;
  total_contract_amount: string;
  contract_currency: ContractCurrency;
  description?: string;
  contract_type?: ContractType;
  business_type?: BusinessType;
  project_nature?: ProjectNature;
  alarm_days_before?: number[];
};

const BLANK: ProjectForm = {
  name: "",
  start_date: "",
  end_date: "",
  total_contract_amount: "0",
  contract_currency: "KRW",
};

export default function ProjectsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<Project>>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
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

  // Create
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ProjectForm>(BLANK);
  const [addFiles, setAddFiles] = useState<Partial<Record<AttachmentSlot, File | null>>>({});
  const [addError, setAddError] = useState<string | null>(null);

  // Edit
  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ProjectForm>(BLANK);
  const [editError, setEditError] = useState<string | null>(null);

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects", customerFilter],
    queryFn: async () =>
      (
        await api.get("/projects", {
          params: customerFilter ? { customer_id: customerFilter } : undefined,
        })
      ).data,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
  });

  const { data: taxSummary = [] } = useQuery<
    Array<{ kind: "SALES" | "PURCHASE"; total_amount: number }>
  >({
    queryKey: ["projects-tax-summary"],
    queryFn: async () => (await api.get("/tax-invoices/summary")).data,
    staleTime: 60_000,
  });
  const purchaseTotal =
    taxSummary.find((r) => r.kind === "PURCHASE")?.total_amount ?? 0;
  const salesTotal =
    taxSummary.find((r) => r.kind === "SALES")?.total_amount ?? 0;

  // 프로젝트별 비용 요약 — 그리드의 '총 투입원가/마진율/총 마진' 컬럼용.
  // 백엔드에 bulk endpoint 가 없어 N개 병렬 호출 (보통 수십개 미만이라 OK).
  // 새 프로젝트 추가/삭제 시 'projects' 쿼리가 invalidate 되면 같이 refetch.
  type CostSummary = {
    total_cost?: string;
    personnel_cost?: string;
    procurement_cost?: string;
    margin?: string;
    margin_ratio?: number;
  };
  const { data: costSummaryMap = {} } = useQuery<Record<string, CostSummary>>({
    queryKey: ["projects-cost-summary", projects.map((p) => p.id).sort().join(",")],
    queryFn: async () => {
      if (projects.length === 0) return {};
      const results = await Promise.all(
        projects.map((p) =>
          api
            .get(`/projects/${p.id}/cost-summary`)
            .then((r) => [p.id, r.data] as const)
            .catch(() => [p.id, null] as const),
        ),
      );
      const m: Record<string, CostSummary> = {};
      for (const [id, s] of results) if (s) m[id] = s as CostSummary;
      return m;
    },
    enabled: projects.length > 0,
    staleTime: 30_000,
  });

  const editTarget = useMemo(
    () => (editTargetId ? projects.find((p) => p.id === editTargetId) ?? null : null),
    [editTargetId, projects],
  );

  const summary = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let ended = 0;
    let ongoing = 0;
    let totalKrw = 0;
    let totalUsd = 0;
    for (const p of projects) {
      const end = new Date(`${p.end_date}T00:00:00`);
      const isEnded = !!p.ended_at || end.getTime() < today.getTime();
      if (isEnded) ended += 1;
      else ongoing += 1;
      const n = Number(p.total_contract_amount);
      if (Number.isFinite(n)) {
        if ((p.contract_currency ?? "KRW") === "USD") totalUsd += n;
        else totalKrw += n;
      }
    }
    return { total: projects.length, ended, ongoing, totalKrw, totalUsd };
  }, [projects]);

  const createM = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: addForm.name,
        customer_id: addForm.customer_id || undefined,
        orderer_id: addForm.orderer_id || undefined,
        start_date: addForm.start_date,
        end_date: addForm.end_date,
        total_contract_amount: addForm.total_contract_amount || "0",
        contract_currency: addForm.contract_currency,
        description: addForm.description || undefined,
        contract_type: addForm.contract_type,
        business_type: addForm.business_type,
        project_nature: addForm.project_nature,
        alarm_days_before: addForm.alarm_days_before ?? [],
      };
      const created = (await api.post("/projects", payload)).data as Project;
      const uploads = ATTACHMENT_SLOTS.map(async ({ slot }) => {
        const f = addFiles[slot];
        if (!f) return;
        const fd = new FormData();
        fd.append("file", f);
        await api.post(`/projects/${created.id}/attachments/${slot}`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      });
      await Promise.all(uploads);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setAddForm(BLANK);
      setAddFiles({});
      setAddError(null);
      setAddOpen(false);
    },
    onError: (e: any) => {
      setAddError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "등록 실패",
      );
    },
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return null;
      const payload = {
        name: editForm.name,
        customer_id: editForm.customer_id || null,
        orderer_id: editForm.orderer_id || null,
        start_date: editForm.start_date,
        end_date: editForm.end_date,
        total_contract_amount: editForm.total_contract_amount || "0",
        contract_currency: editForm.contract_currency,
        description: editForm.description || null,
        contract_type: editForm.contract_type ?? null,
        business_type: editForm.business_type ?? null,
        project_nature: editForm.project_nature ?? null,
        alarm_days_before: editForm.alarm_days_before ?? [],
      };
      return (await api.patch(`/projects/${editTargetId}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setEditOpen(false);
      setEditTargetId(null);
    },
    onError: (e: any) => {
      setEditError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "수정 실패",
      );
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/projects/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const endM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.post(`/projects/${id}/end`))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      gridRef.current?.deselectAll();
    },
  });

  async function handleEnd() {
    const selected = gridRef.current?.getSelectedRows() ?? [];
    if (selected.length === 0) {
      await dialog.alert("종료할 프로젝트를 먼저 선택하세요.");
      return;
    }
    const rows = selected.filter((r) => !r.ended_at);
    if (rows.length === 0) {
      await dialog.alert("선택한 프로젝트는 이미 종료되었습니다.");
      return;
    }
    const ok = await dialog.confirm(
      `${rows.length}건을 종료 처리하시겠습니까?`,
    );
    if (!ok) return;
    endM.mutate(rows.map((r) => r.id));
  }

  const custName = (id?: string | null) =>
    id ? customers.find((c) => c.id === id)?.name ?? "-" : "-";

  const columnDefs = useMemo<ColDef<Project>[]>(
    () => [
      // 모든 헤더 가운데 정렬. cellClass 는 컬럼별로 따로 지정.
      // width 정책: 가변(flex:1) 은 프로젝트명 하나, 나머지는 모두 flex:0 + 고정 width.
      // DataGrid 의 defaultColDef 가 flex:1 이라 flex 누락 시 가변폭이 되니 모든 컬럼에 명시.
      {
        field: "name",
        headerName: "프로젝트명",
        headerClass: "ag-center-aligned-header",
        flex: 1,
        minWidth: 240,
        cellRenderer: (p: any) => (
          <Link href={`/projects/${p.data.id}`} className="text-primary hover:underline">
            {p.value}
          </Link>
        ),
      },
      {
        colId: "customer_name",
        headerName: "고객사",
        headerClass: "ag-center-aligned-header",
        cellClass: "ag-cell-center",
        flex: 0,
        width: 140,
        valueGetter: (p) => custName(p.data?.customer_id),
      },
      {
        colId: "orderer_name",
        headerName: "발주사",
        headerClass: "ag-center-aligned-header",
        cellClass: "ag-cell-center",
        flex: 0,
        width: 140,
        valueGetter: (p) => custName(p.data?.orderer_id),
      },
      {
        field: "contract_type",
        headerName: "수주유형",
        headerClass: "ag-center-aligned-header",
        cellClass: "ag-cell-center",
        flex: 0,
        width: 100,
        valueFormatter: (p) =>
          p.value ? CONTRACT_TYPE_LABEL[p.value as ContractType] : "-",
      },
      // '사업유형' 컬럼은 요청대로 제거.
      {
        field: "project_nature",
        headerName: "사업특징",
        headerClass: "ag-center-aligned-header",
        cellClass: "ag-cell-center",
        flex: 0,
        width: 110, // '운영/유지보수' (8자) 수용
        valueFormatter: (p) =>
          p.value ? PROJECT_NATURE_LABEL[p.value as ProjectNature] : "-",
      },
      {
        colId: "period",
        headerName: "기간",
        headerClass: "ag-center-aligned-header",
        cellClass: "ag-cell-center",
        flex: 0,
        width: 120,
        valueGetter: (p) => `${p.data?.start_date} ~ ${p.data?.end_date}`,
      },
      {
        colId: "days_remaining",
        headerName: "남은 기간",
        headerClass: "ag-center-aligned-header",
        cellClass: "ag-cell-center",
        flex: 0,
        width: 70,
        resizable: false,
        valueGetter: (p) =>
          p.data?.ended_at
            ? Number.NEGATIVE_INFINITY
            : p.data?.end_date
            ? daysUntil(p.data.end_date)
            : null,
        cellRenderer: (p: any) => {
          if (p.data?.ended_at) {
            return (
              <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                종료
              </span>
            );
          }
          if (p.value == null) return "-";
          const n = p.value as number;
          if (n < 0)
            return (
              <span className="font-medium text-red-600">지연 {Math.abs(n)}일</span>
            );
          return `${n}일`;
        },
      },
      {
        field: "total_contract_amount",
        headerName: "총 사업비",
        headerClass: "ag-center-aligned-header",
        flex: 0,
        width: 120,
        type: "numericColumn",
        valueFormatter: (p) =>
          formatAmount(p.value, p.data?.contract_currency ?? "KRW"),
      },
      {
        colId: "total_cost",
        headerName: "총 투입원가",
        headerClass: "ag-center-aligned-header",
        flex: 0,
        width: 120,
        type: "numericColumn",
        valueGetter: (p) => {
          const s = p.data?.id ? costSummaryMap[p.data.id] : undefined;
          if (!s?.total_cost) return null;
          const n = Number(s.total_cost);
          return Number.isFinite(n) ? n : null;
        },
        // 소수점 자리 제거 — 원 단위 정수로 반올림.
        valueFormatter: (p) =>
          p.value == null ? "-" : formatAmount(Math.round(p.value), "KRW"),
      },
      {
        colId: "margin_ratio",
        headerName: "마진율",
        headerClass: "ag-center-aligned-header",
        flex: 0,
        width: 70,
        type: "numericColumn",
        valueGetter: (p) => {
          const s = p.data?.id ? costSummaryMap[p.data.id] : undefined;
          if (!s || typeof s.margin_ratio !== "number") return null;
          // 백엔드 margin_ratio 는 0.25 같은 비율 — UI 는 % 로 표시.
          return Math.round(s.margin_ratio * 1000) / 10;
        },
        cellRenderer: (p: any) => {
          if (p.value == null) return "-";
          const n = p.value as number;
          const cls =
            n < 0 ? "text-red-600 font-medium" :
            n < 10 ? "text-amber-600" :
            "text-emerald-700";
          return <span className={cls}>{n.toFixed(1)}%</span>;
        },
      },
      {
        colId: "margin",
        headerName: "총 마진",
        headerClass: "ag-center-aligned-header",
        flex: 0,
        width: 120,
        type: "numericColumn",
        valueGetter: (p) => {
          const s = p.data?.id ? costSummaryMap[p.data.id] : undefined;
          if (!s?.margin) return null;
          const n = Number(s.margin);
          return Number.isFinite(n) ? n : null;
        },
        cellRenderer: (p: any) => {
          if (p.value == null) return "-";
          const n = p.value as number;
          const cls = n < 0 ? "text-red-600 font-medium" : "";
          // 소수점 자리 제거 — 원 단위 정수로 반올림.
          return <span className={cls}>{formatAmount(Math.round(n), "KRW")}</span>;
        },
      },
    ],
    [customers, costSummaryMap],
  );

  async function handleDelete(rows: Project[]) {
    const ok = await dialog.confirm(
      `${rows.length}건을 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(rows.map((r) => r.id));
  }

  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  async function handleExportExcel() {
    if (exporting || projects.length === 0) return;
    setExporting(true);
    try {
      const summaries = await Promise.all(
        projects.map((p) =>
          api
            .get(`/projects/${p.id}/cost-summary`)
            .then((r) => r.data)
            .catch(() => null),
        ),
      );
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const customerName = (id?: string | null) =>
        id ? customers.find((c) => c.id === id)?.name ?? "-" : "-";

      const totals = {
        krw: 0,
        usd: 0,
        personnel: 0,
        procurement: 0,
        cost: 0,
        margin: 0,
      };

      const rows = projects.map((p, i) => {
        const s = summaries[i];
        const end = new Date(`${p.end_date}T00:00:00`);
        const remaining = Math.round((end.getTime() - today.getTime()) / 86_400_000);
        const ended = !!p.ended_at || end.getTime() < today.getTime();

        const contractNum = Number(p.total_contract_amount);
        if (Number.isFinite(contractNum)) {
          if ((p.contract_currency ?? "KRW") === "USD") totals.usd += contractNum;
          else totals.krw += contractNum;
        }
        const personnelNum = s?.personnel_cost ? Number(s.personnel_cost) : NaN;
        const procurementNum = s?.procurement_cost ? Number(s.procurement_cost) : NaN;
        const costNum = s?.total_cost ? Number(s.total_cost) : NaN;
        if (Number.isFinite(personnelNum)) totals.personnel += personnelNum;
        if (Number.isFinite(procurementNum)) totals.procurement += procurementNum;
        if (Number.isFinite(costNum)) totals.cost += costNum;
        const marginNum = s?.margin ? Number(s.margin) : NaN;
        if (Number.isFinite(marginNum)) totals.margin += marginNum;

        return {
          프로젝트명: p.name,
          고객사: customerName(p.customer_id),
          발주사: customerName(p.orderer_id),
          수주유형: p.contract_type ? CONTRACT_TYPE_LABEL[p.contract_type] : "-",
          사업유형: p.business_type ? BUSINESS_TYPE_LABEL[p.business_type] : "-",
          사업특징: p.project_nature ? PROJECT_NATURE_LABEL[p.project_nature] : "-",
          시작일: p.start_date,
          종료일: p.end_date,
          "남은 기간(일)": remaining,
          통화: (p.contract_currency ?? "KRW") as string,
          "총 사업비": Number.isFinite(contractNum) ? contractNum : null,
          "인력 원가(KRW)": Number.isFinite(personnelNum) ? personnelNum : null,
          "매입(KRW)": Number.isFinite(procurementNum) ? procurementNum : null,
          "투입 원가(KRW)": Number.isFinite(costNum) ? costNum : null,
          "마진(KRW)": Number.isFinite(marginNum) ? marginNum : null,
          "마진율(%)":
            s && typeof s.margin_ratio === "number"
              ? Math.round(s.margin_ratio * 1000) / 10
              : null,
          상태: ended ? "종료" : "진행중",
        };
      });

      // Append totals row
      const totalContract =
        totals.krw && totals.usd
          ? `₩${totals.krw.toLocaleString()} + $${totals.usd.toLocaleString()}`
          : totals.usd
          ? totals.usd
          : totals.krw;
      rows.push({
        프로젝트명: "합계",
        고객사: "",
        발주사: "",
        수주유형: "",
        사업유형: "",
        사업특징: "",
        시작일: "",
        종료일: "",
        "남은 기간(일)": "" as any,
        통화: totals.krw && totals.usd ? "KRW/USD" : totals.usd ? "USD" : "KRW",
        "총 사업비": totalContract as any,
        "인력 원가(KRW)": totals.personnel,
        "매입(KRW)": totals.procurement,
        "투입 원가(KRW)": totals.cost,
        "마진(KRW)": totals.margin,
        "마진율(%)": "" as any,
        상태: "",
      });

      const ws = XLSX.utils.json_to_sheet(rows);
      // Column widths
      ws["!cols"] = [
        { wch: 28 }, // 프로젝트명
        { wch: 18 }, // 고객사
        { wch: 18 }, // 발주사
        { wch: 12 }, // 수주유형
        { wch: 12 }, // 사업유형
        { wch: 14 }, // 사업특징
        { wch: 12 }, // 시작일
        { wch: 12 }, // 종료일
        { wch: 12 }, // 남은 기간
        { wch: 8 }, //  통화
        { wch: 18 }, // 총 사업비
        { wch: 18 }, // 인력 원가
        { wch: 18 }, // 매입
        { wch: 18 }, // 투입 원가
        { wch: 18 }, // 마진
        { wch: 10 }, // 마진율
        { wch: 10 }, // 상태
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "프로젝트 현황");
      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `프로젝트_현황_${date}.xlsx`);
    } finally {
      setExporting(false);
      setExportMenuOpen(false);
    }
  }

  async function handleExportPDF() {
    if (exporting || projects.length === 0) return;
    setExporting(true);
    try {
      const summaries = await Promise.all(
        projects.map((p) =>
          api
            .get(`/projects/${p.id}/cost-summary`)
            .then((r) => r.data)
            .catch(() => null),
        ),
      );
      const html = buildStatusHTML(projects, summaries, customers);
      const container = document.createElement("div");
      container.style.cssText =
        "position: fixed; top: -20000px; left: 0; width: 1400px; padding: 24px; background: #ffffff; font-family: 'Noto Sans KR', sans-serif; color: #0f172a;";
      container.innerHTML = html;
      document.body.appendChild(container);
      try {
        // Make sure the web font is ready before snapshot
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
          try {
            await (document as any).fonts.load?.("400 12px 'Noto Sans KR'");
            await (document as any).fonts.load?.("700 12px 'Noto Sans KR'");
          } catch {
            // ignore — fonts.ready is usually enough
          }
        }
        const canvas = await html2canvas(container, {
          scale: 2,
          backgroundColor: "#ffffff",
          useCORS: true,
        });
        const imgData = canvas.toDataURL("image/png");
        const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();
        const imgW = pageW;
        const imgH = (canvas.height * pageW) / canvas.width;
        if (imgH <= pageH) {
          pdf.addImage(imgData, "PNG", 0, 0, imgW, imgH);
        } else {
          let y = 0;
          while (y < imgH) {
            pdf.addImage(imgData, "PNG", 0, -y, imgW, imgH);
            y += pageH;
            if (y < imgH) pdf.addPage();
          }
        }
        const date = new Date().toISOString().slice(0, 10);
        pdf.save(`프로젝트_현황_${date}.pdf`);
      } finally {
        document.body.removeChild(container);
      }
    } finally {
      setExporting(false);
      setExportMenuOpen(false);
    }
  }

  function openAdd() {
    setAddForm(BLANK);
    setAddFiles({});
    setAddError(null);
    setAddOpen(true);
  }

  function openEdit(row: Project) {
    setEditTargetId(row.id);
    setEditForm({
      name: row.name,
      customer_id: row.customer_id ?? undefined,
      orderer_id: row.orderer_id ?? undefined,
      start_date: row.start_date,
      end_date: row.end_date,
      total_contract_amount: row.total_contract_amount,
      contract_currency: row.contract_currency ?? "KRW",
      description: row.description ?? "",
      contract_type: row.contract_type ?? undefined,
      business_type: row.business_type ?? undefined,
      project_nature: row.project_nature ?? undefined,
      alarm_days_before: row.alarm_days_before ?? [],
    });
    setEditError(null);
    setEditOpen(true);
  }

  return (
    <>
      <DashboardHeader title="프로젝트 관리" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <div className="grid grid-cols-6 gap-4">
          <SummaryCard label="프로젝트 수" value={String(summary.total)} />
          <SummaryCard label="종료 프로젝트 수" value={String(summary.ended)} />
          <SummaryCard label="진행중인 프로젝트 수" value={String(summary.ongoing)} />
          <SummaryCard
            label="총 금액"
            value={
              summary.totalKrw && summary.totalUsd
                ? formatMoney(summary.totalKrw, "KRW")
                : summary.totalUsd
                ? formatMoney(summary.totalUsd, "USD")
                : formatKRW(summary.totalKrw)
            }
            sub={
              summary.totalKrw && summary.totalUsd
                ? `+ ${formatMoney(summary.totalUsd, "USD")}`
                : undefined
            }
          />
          <SummaryCard label="매입" value={formatKRW(purchaseTotal)} />
          <SummaryCard label="매출" value={formatKRW(salesTotal)} />
        </div>
        <DataGrid<Project>
          ref={gridRef}
          rowData={projects}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          disableFilters
          searchPlaceholder="프로젝트명, 고객사 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "name",
              "customer_name",
              "orderer_name",
              "contract_type",
              "project_nature",
            ],
          }}
          onAdd={openAdd}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
          extraActions={
            <>
              <select
                value={customerFilter ?? ""}
                onChange={(e) =>
                  updateCustomerFilter(e.target.value || null)
                }
                className="h-8 rounded-md border border-border bg-background px-2 text-xs max-w-[200px]"
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
                type="button"
                onClick={handleEnd}
                disabled={endM.isPending}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CircleStop className="h-3.5 w-3.5" />
                종료
              </button>
              <ExportMenu
                disabled={exporting || projects.length === 0}
                exporting={exporting}
                open={exportMenuOpen}
                onOpenChange={setExportMenuOpen}
                onPDF={handleExportPDF}
                onExcel={handleExportExcel}
              />
            </>
          }
        />
      </div>

      {/* Add modal */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="신규 프로젝트 등록"
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
              onClick={() =>
                addForm.name && addForm.start_date && addForm.end_date && createM.mutate()
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              등록
            </button>
          </>
        }
      >
        <ProjectFormBody
          form={addForm}
          setForm={(updater) =>
            setAddForm((prev) => (typeof updater === "function" ? updater(prev) : updater))
          }
          customers={customers}
        />

        <div className="mt-3 border-t border-border pt-3">
          <div className="text-xs font-semibold mb-2">첨부 파일 (선택)</div>
          <div className="space-y-2">
            {ATTACHMENT_SLOTS.map(({ slot, label }) => (
              <Attachment key={slot} label={label}>
                <FilePicker
                  file={addFiles[slot] ?? null}
                  onChange={(f) => setAddFiles((prev) => ({ ...prev, [slot]: f }))}
                />
              </Attachment>
            ))}
          </div>
        </div>

        {addError && <div className="text-xs text-destructive mt-2">{addError}</div>}
      </Dialog>

      {/* Edit modal */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="프로젝트 수정"
        width="max-w-2xl"
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
                editForm.name && editForm.start_date && editForm.end_date && updateM.mutate()
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        {editTarget && (
          <>
            <ProjectFormBody
              form={editForm}
              setForm={(updater) =>
                setEditForm((prev) => (typeof updater === "function" ? updater(prev) : updater))
              }
              customers={customers}
            />

            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-semibold mb-2">첨부 파일</div>
              <div className="space-y-2">
                {ATTACHMENT_SLOTS.map(({ slot, label }) => (
                  <Attachment key={slot} label={label}>
                    <ExistingAttachment project={editTarget} slot={slot} />
                  </Attachment>
                ))}
              </div>
            </div>

            {editError && <div className="text-xs text-destructive mt-2">{editError}</div>}
          </>
        )}
      </Dialog>
    </>
  );
}

function ProjectFormBody({
  form,
  setForm,
  customers,
}: {
  form: ProjectForm;
  setForm: (f: ProjectForm | ((prev: ProjectForm) => ProjectForm)) => void;
  customers: Customer[];
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="프로젝트명 *" colSpan={2}>
        <input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          className={input}
        />
      </Field>

      <Field label="고객사">
        <select
          value={form.customer_id ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, customer_id: e.target.value || undefined }))}
          className={input}
        >
          <option value="">선택</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="발주사">
        <select
          value={form.orderer_id ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, orderer_id: e.target.value || undefined }))}
          className={input}
        >
          <option value="">선택</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="수주 유형">
        <select
          value={form.contract_type ?? ""}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              contract_type: (e.target.value || undefined) as ContractType | undefined,
            }))
          }
          className={input}
        >
          <option value="">선택</option>
          {(Object.keys(CONTRACT_TYPE_LABEL) as ContractType[]).map((k) => (
            <option key={k} value={k}>
              {CONTRACT_TYPE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="사업 유형">
        <select
          value={form.business_type ?? ""}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              business_type: (e.target.value || undefined) as BusinessType | undefined,
            }))
          }
          className={input}
        >
          <option value="">선택</option>
          {(Object.keys(BUSINESS_TYPE_LABEL) as BusinessType[]).map((k) => (
            <option key={k} value={k}>
              {BUSINESS_TYPE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="사업 특징" colSpan={2}>
        <select
          value={form.project_nature ?? ""}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              project_nature: (e.target.value || undefined) as ProjectNature | undefined,
            }))
          }
          className={input}
        >
          <option value="">선택</option>
          {(Object.keys(PROJECT_NATURE_LABEL) as ProjectNature[]).map((k) => (
            <option key={k} value={k}>
              {PROJECT_NATURE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="시작일">
        <DateInput
          value={form.start_date}
          onChange={(v) => setForm((p) => ({ ...p, start_date: v }))}
        />
      </Field>
      <Field label="종료일">
        <DateInput
          value={form.end_date}
          onChange={(v) => setForm((p) => ({ ...p, end_date: v }))}
        />
      </Field>

      <Field label="총 사업비" colSpan={2}>
        <div className="flex gap-2 min-w-0">
          <select
            value={form.contract_currency}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                contract_currency: e.target.value as ContractCurrency,
              }))
            }
            className="w-20 shrink-0 rounded-md border border-input bg-background px-2 py-2 text-sm"
          >
            <option value="KRW">KRW</option>
            <option value="USD">USD</option>
          </select>
          <input
            type="text"
            inputMode="numeric"
            value={formatAmountInput(form.total_contract_amount)}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^0-9.]/g, "");
              setForm((p) => ({ ...p, total_contract_amount: digits }));
            }}
            placeholder="0"
            className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-right"
          />
        </div>
      </Field>

      <Field label="종료전 알람" colSpan={2}>
        <div className="flex flex-wrap gap-2">
          {ALARM_DAY_OPTIONS.map((d) => {
            const selected = form.alarm_days_before?.includes(d) ?? false;
            return (
              <button
                key={d}
                type="button"
                onClick={() =>
                  setForm((p) => {
                    const curr = new Set(p.alarm_days_before ?? []);
                    if (curr.has(d)) curr.delete(d);
                    else curr.add(d);
                    return {
                      ...p,
                      alarm_days_before: Array.from(curr).sort((a, b) => b - a),
                    };
                  })
                }
                className={`h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {d}일 전
              </button>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

function ExistingAttachment({
  project,
  slot,
}: {
  project: Project;
  slot: AttachmentSlot;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const ref = useRef<HTMLInputElement>(null);
  const row = project.attachments?.find((a) => a.slot === slot) ?? null;

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(`/projects/${project.id}/attachments/${slot}`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const deleteM = useMutation({
    mutationFn: async () =>
      api.delete(`/projects/${project.id}/attachments/${slot}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const renameM = useMutation({
    mutationFn: async (file_name: string) =>
      api.patch(`/projects/${project.id}/attachments/${slot}`, { file_name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  async function downloadClick() {
    if (!row) return;
    const res = await api.get(`/projects/${project.id}/attachments/${slot}`, {
      responseType: "blob",
    });
    const ext = row.file_name.includes(".")
      ? row.file_name.slice(row.file_name.lastIndexOf("."))
      : "";
    const filename = `${project.name}_${row.file_name.replace(ext, "")}${ext}`;
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {row ? (
        <button
          type="button"
          onClick={downloadClick}
          className="text-xs text-primary hover:underline truncate"
        >
          {row.file_name}
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">첨부된 파일 없음</span>
      )}
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
      >
        {row ? (
          <>
            <Replace className="h-3.5 w-3.5" />
            교체
          </>
        ) : (
          <>
            <Upload className="h-3.5 w-3.5" />
            업로드
          </>
        )}
      </button>
      {row && (
        <>
          <Tooltip label="이름 변경" side="top">
            <button
              type="button"
              onClick={async () => {
                const next = await dialog.prompt("파일 표시명 변경", {
                  defaultValue: row.file_name,
                });
                if (next && next.trim() && next !== row.file_name) {
                  renameM.mutate(next.trim());
                }
              }}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
            >
              <Pencil className="h-3.5 w-3.5" />
              이름 변경
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={async () => {
              if (await dialog.confirm("삭제하시겠습니까?", { destructive: true })) {
                deleteM.mutate();
              }
            }}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
            삭제
          </button>
        </>
      )}
      <input
        ref={ref}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadM.mutate(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildStatusHTML(
  projects: Project[],
  summaries: Array<{
    total_cost?: string;
    personnel_cost?: string;
    procurement_cost?: string;
    margin?: string;
    margin_ratio?: number;
  } | null>,
  customers: Customer[],
): string {
  const customerName = (id?: string | null) =>
    id ? customers.find((c) => c.id === id)?.name ?? "-" : "-";
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cell =
    "padding:10px;border-bottom:1px solid #e2e8f0;vertical-align:middle;line-height:1.4;";
  const headerCell =
    "padding:10px;background:#f1f5f9;border-bottom:2px solid #cbd5e1;vertical-align:middle;text-align:left;font-size:12px;font-weight:700;";

  const headers = [
    "프로젝트명",
    "고객사",
    "발주사",
    "수주유형",
    "사업유형",
    "기간",
    "남은 기간",
    "상태",
  ]
    .map((h) => `<th style="${headerCell}">${escapeHtml(h)}</th>`)
    .join("");

  const totals = { krw: 0, usd: 0, cost: 0, margin: 0 };

  const rows = projects
    .map((p, i) => {
      const summary = summaries[i];
      const end = new Date(`${p.end_date}T00:00:00`);
      const remaining = Math.round((end.getTime() - today.getTime()) / 86_400_000);
      const ended = !!p.ended_at || end.getTime() < today.getTime();
      const statusLabel = ended ? "종료" : "진행중";
      const statusColor = ended ? "#1d4ed8" : "#15803d";

      const contractNum = Number(p.total_contract_amount);
      if (Number.isFinite(contractNum)) {
        if ((p.contract_currency ?? "KRW") === "USD") totals.usd += contractNum;
        else totals.krw += contractNum;
      }
      const costNum = summary?.total_cost ? Number(summary.total_cost) : NaN;
      if (Number.isFinite(costNum)) totals.cost += costNum;
      const marginNum = summary?.margin ? Number(summary.margin) : NaN;
      if (Number.isFinite(marginNum)) totals.margin += marginNum;
      const personnelNum = summary?.personnel_cost
        ? Number(summary.personnel_cost)
        : NaN;
      const procurementNum = summary?.procurement_cost
        ? Number(summary.procurement_cost)
        : NaN;

      const contract = formatAmount(p.total_contract_amount, p.contract_currency ?? "KRW");
      const costBreakdown =
        Number.isFinite(personnelNum) || Number.isFinite(procurementNum)
          ? ` <span style="color:#94a3b8;font-size:11px;">(인력 ${formatAmount(
              Number.isFinite(personnelNum) ? String(personnelNum) : "0",
              "KRW",
            )} + 매입 ${formatAmount(
              Number.isFinite(procurementNum) ? String(procurementNum) : "0",
              "KRW",
            )})</span>`
          : "";
      const cost = summary?.total_cost
        ? `${formatAmount(summary.total_cost, "KRW")}${costBreakdown}`
        : "-";
      const margin = summary?.margin
        ? `${formatAmount(summary.margin, "KRW")} (${((summary.margin_ratio ?? 0) * 100).toFixed(1)}%)`
        : "-";

      const mainCells = [
        escapeHtml(p.name),
        escapeHtml(customerName(p.customer_id)),
        escapeHtml(customerName(p.orderer_id)),
        escapeHtml(p.contract_type ? CONTRACT_TYPE_LABEL[p.contract_type] : "-"),
        escapeHtml(p.business_type ? BUSINESS_TYPE_LABEL[p.business_type] : "-"),
        escapeHtml(`${p.start_date} ~ ${p.end_date}`),
        `${remaining}일`,
        `<span style="color:${statusColor};font-weight:700;">${statusLabel}</span>`,
      ]
        .map((v) => `<td style="${cell}">${v}</td>`)
        .join("");

      const financial = `
        <span style="display:inline-block;margin-right:24px;">
          <span style="color:#64748b;font-weight:600;margin-right:6px;">총 사업비</span>
          <span>${escapeHtml(contract)}</span>
        </span>
        <span style="display:inline-block;margin-right:24px;">
          <span style="color:#64748b;font-weight:600;margin-right:6px;">투입 원가</span>
          <span>${cost}</span>
        </span>
        <span style="display:inline-block;">
          <span style="color:#64748b;font-weight:600;margin-right:6px;">마진</span>
          <span>${escapeHtml(margin)}</span>
        </span>`;

      const subRow = `
        <tr>
          <td colspan="${headers ? 8 : 0}" style="padding:4px 10px 14px 10px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#334155;font-size:12px;vertical-align:middle;">
            ${financial}
          </td>
        </tr>`;

      return `<tr>${mainCells}</tr>${subRow}`;
    })
    .join("");

  const totalContract =
    totals.krw && totals.usd
      ? `${formatAmount(String(totals.krw), "KRW")} + ${formatAmount(String(totals.usd), "USD")}`
      : totals.usd
      ? formatAmount(String(totals.usd), "USD")
      : formatAmount(String(totals.krw), "KRW");
  const totalCost = formatAmount(String(totals.cost), "KRW");
  const totalMargin = formatAmount(String(totals.margin), "KRW");

  const totalsRow = `
    <tr>
      <td colspan="8" style="padding:12px 10px;border-top:2px solid #0f172a;background:#e2e8f0;font-weight:700;font-size:13px;vertical-align:middle;">
        <span style="display:inline-block;margin-right:32px;">
          <span style="color:#475569;margin-right:8px;">총 사업비</span>
          <span>${escapeHtml(totalContract)}</span>
        </span>
        <span style="display:inline-block;margin-right:32px;">
          <span style="color:#475569;margin-right:8px;">총 투입 원가</span>
          <span>${escapeHtml(totalCost)}</span>
        </span>
        <span style="display:inline-block;">
          <span style="color:#475569;margin-right:8px;">총 마진</span>
          <span>${escapeHtml(totalMargin)}</span>
        </span>
      </td>
    </tr>`;

  const date = new Date().toLocaleDateString("ko-KR");
  return `
    <div style="margin-bottom:16px;">
      <div style="font-size:20px;font-weight:700;">프로젝트 현황</div>
      <div style="font-size:12px;color:#64748b;margin-top:4px;">생성일: ${date} · 총 ${projects.length}건</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:auto;">
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>${totalsRow}</tfoot>
    </table>
  `;
}

function formatAmount(value: string | number | null | undefined, currency: ContractCurrency): string {
  if (value == null || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const formatted = n.toLocaleString("en-US");
  return currency === "USD" ? `$ ${formatted}` : `₩ ${formatted}`;
}

function formatAmountInput(value: string): string {
  if (!value) return "";
  // Preserve trailing dot while typing decimals
  const [intPart, decPart] = value.split(".");
  const intWithCommas = intPart
    ? Number(intPart).toLocaleString("en-US")
    : "";
  if (value.endsWith(".")) return `${intWithCommas}.`;
  return decPart !== undefined ? `${intWithCommas}.${decPart}` : intWithCommas;
}

function daysUntil(endISO: string): number {
  const end = new Date(`${endISO}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - today.getTime()) / 86_400_000);
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
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
    <label className={`flex flex-col gap-1 ${colSpan === 2 ? "col-span-2" : ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Attachment({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-xs font-semibold text-muted-foreground shrink-0">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function FilePicker({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
      >
        <Paperclip className="h-3.5 w-3.5" />
        파일 선택
      </button>
      <span className="text-xs text-muted-foreground truncate">
        {file ? file.name : "선택된 파일 없음"}
      </span>
      {file && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="지우기"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <input
        ref={ref}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          onChange(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
