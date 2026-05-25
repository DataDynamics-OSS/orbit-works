"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Save } from "lucide-react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  OpportunityFormBody,
  oppToPayload,
  type OppFormValues,
  type DeveloperBrief,
} from "@/components/opportunities/OpportunityFormBody";

type Stage = "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION";
type Status = "OPEN" | "WON" | "LOST" | "ABANDONED";

type Opportunity = {
  id: string;
  name: string;
  customer_id: string | null;
  customer_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  sales_rep_id: string | null;
  sales_rep_name: string | null;
  stage: Stage;
  status: Status;
  probability: number;
  expected_amount: string;
  currency: "KRW" | "USD";
  expected_close_date: string | null;
  registered_at: string | null;
  closed_at: string | null;
  weighted_amount: string;
  created_at: string;
  source: string | null;
  business_type: "RESEARCH" | "PRIVATE" | "PUBLIC" | null;
  description: string | null;
  contact_name: string | null;
  contact_department: string | null;
  contact_phone: string | null;
  contact_email: string | null;
};

type Customer = { id: string; name: string };

type Summary = {
  year: number;
  total_count: number;
  total_amount: string;
  weighted_amount: string;
  won_amount: string;
  won_amount_krw: string;
  won_amount_usd: string;
  lost_amount: string;
  win_rate: number;
  by_stage: { stage: string; count: number; amount: string; weighted: string }[];
};

const STAGE_LABEL: Record<Stage, string> = {
  LEAD: "발굴",
  QUALIFIED: "검증",
  PROPOSAL: "제안",
  NEGOTIATION: "협상",
};

const STATUS_LABEL: Record<Status, string> = {
  OPEN: "진행중",
  WON: "수주",
  LOST: "실주",
  ABANDONED: "중단",
};

const BIZ_LABEL: Record<"RESEARCH" | "PRIVATE" | "PUBLIC", string> = {
  RESEARCH: "연구과제",
  PRIVATE: "민간사업",
  PUBLIC: "공공사업",
};

const BIZ_PREFIX: Record<"RESEARCH" | "PRIVATE" | "PUBLIC", string> = {
  RESEARCH: "[연구]",
  PRIVATE: "[민간]",
  PUBLIC: "[공공]",
};

const STAGE_COLOR: Record<Stage, string> = {
  LEAD: "#64748b", // slate-500
  QUALIFIED: "#0ea5e9", // sky-500
  PROPOSAL: "#6366f1", // indigo-500
  NEGOTIATION: "#f59e0b", // amber-500
};

const STATUS_COLOR: Record<Status, string> = {
  OPEN: "#64748b",
  WON: "#10b981",
  LOST: "#ef4444",
  ABANDONED: "#9ca3af",
};

const STAGE_BADGE: Record<Stage, string> = {
  LEAD: "bg-slate-100 text-slate-700 border-slate-200",
  QUALIFIED: "bg-sky-100 text-sky-700 border-sky-200",
  PROPOSAL: "bg-indigo-100 text-indigo-700 border-indigo-200",
  NEGOTIATION: "bg-amber-100 text-amber-700 border-amber-200",
};

const STATUS_BADGE: Record<Status, string> = {
  OPEN: "bg-slate-100 text-slate-700 border-slate-200",
  WON: "bg-emerald-100 text-emerald-700 border-emerald-200",
  LOST: "bg-red-100 text-red-700 border-red-200",
  ABANDONED: "bg-gray-100 text-gray-500 border-gray-200",
};

const BLANK: OppFormValues = {
  stage: "LEAD",
  status: "OPEN",
  probability: 10,
  expected_amount: "0",
  currency: "KRW",
  // 등록일 기본값은 오늘 — 사용자가 과거/미래 일자로 변경 가능.
  registered_at: new Date().toISOString().slice(0, 10),
};

function fmtMoney(v: string | number, ccy: "KRW" | "USD") {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "-";
  if (ccy === "USD") {
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return Math.round(n).toLocaleString() + "원";
}

function fmtKrw(v: string | number) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "-";
  return Math.round(n).toLocaleString() + "원";
}

export default function OpportunitiesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  // 회사 필터 — URL `?customer_id=…` 와 동기화. 회사 360° "전체보기" 에서 진입.
  const customerIdParam = searchParams.get("customer_id");
  const [customerFilter, setCustomerFilter] = useState<string | null>(
    customerIdParam,
  );
  useEffect(() => {
    setCustomerFilter(customerIdParam);
  }, [customerIdParam]);
  const updateCustomerFilter = (id: string | null) => {
    setCustomerFilter(id);
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("customer_id", id);
    else params.delete("customer_id");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?");
  };
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<OppFormValues>(BLANK);
  const [addError, setAddError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<OppFormValues>({});
  const [editError, setEditError] = useState<string | null>(null);

  const { data: opps = [] } = useQuery<Opportunity[]>({
    queryKey: ["opportunities", year, customerFilter],
    queryFn: async () =>
      (
        await api.get("/opportunities", {
          params: customerFilter
            ? { year, customer_id: customerFilter }
            : { year },
        })
      ).data,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ["opportunities-summary", year],
    queryFn: async () =>
      (await api.get("/opportunities/summary", { params: { year } })).data,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  const { data: developersList = [] } = useQuery<DeveloperBrief[]>({
    queryKey: ["developers-active"],
    queryFn: async () => (await api.get("/developers")).data,
    staleTime: 60_000,
  });

  const { data: fx } = useQuery<{ rate: string; as_of: string }>({
    queryKey: ["fx"],
    queryFn: async () => (await api.get("/exchange/current")).data,
  });

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post("/opportunities", oppToPayload(addForm))).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities", year] });
      qc.invalidateQueries({ queryKey: ["opportunities-summary", year] });
      setAddOpen(false);
      setAddForm(BLANK);
      setAddError(null);
    },
    onError: (e: any) =>
      setAddError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "등록 실패",
      ),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return null;
      return (
        await api.patch(
          `/opportunities/${editTargetId}`,
          oppToPayload(editForm),
        )
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities", year] });
      qc.invalidateQueries({ queryKey: ["opportunities-summary", year] });
      qc.invalidateQueries({ queryKey: ["opportunity", editTargetId ?? ""] });
      setEditOpen(false);
      setEditTargetId(null);
      setEditError(null);
    },
    onError: (e: any) =>
      setEditError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "수정 실패",
      ),
  });

  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  async function handleExportExcel() {
    if (exporting || opps.length === 0) return;
    setExporting(true);
    try {
      const wb = buildOppExcelBook({
        year,
        opps,
        summary,
        fxRate: Number(fx?.rate) || 0,
      });
      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `영업기회_현황_${year}_${date}.xlsx`);
    } finally {
      setExporting(false);
      setExportMenuOpen(false);
    }
  }

  async function handleExportPDF() {
    if (exporting || opps.length === 0) return;
    setExporting(true);
    try {
      const html = buildOppStatusHTML({
        year,
        opps,
        summary,
        fxRate: Number(fx?.rate) || 0,
      });
      const container = document.createElement("div");
      container.style.cssText =
        "position: fixed; top: -20000px; left: 0; width: 1400px; padding: 24px; background: #ffffff; font-family: 'Noto Sans KR', sans-serif; color: #0f172a;";
      container.innerHTML = html;
      document.body.appendChild(container);
      try {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
          try {
            await (document as any).fonts.load?.("400 12px 'Noto Sans KR'");
            await (document as any).fonts.load?.("700 12px 'Noto Sans KR'");
          } catch {
            // ignore
          }
        }
        const canvas = await html2canvas(container, {
          scale: 2,
          backgroundColor: "#ffffff",
          useCORS: true,
        });
        const imgData = canvas.toDataURL("image/png");
        const pdf = new jsPDF({
          orientation: "landscape",
          unit: "pt",
          format: "a4",
        });
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
        pdf.save(`영업기회_현황_${year}_${date}.pdf`);
      } finally {
        document.body.removeChild(container);
      }
    } finally {
      setExporting(false);
      setExportMenuOpen(false);
    }
  }

  function openEdit(row: Opportunity) {
    setEditTargetId(row.id);
    setEditForm({
      name: row.name,
      customer_id: row.customer_id,
      owner_id: row.owner_id,
      sales_rep_id: row.sales_rep_id,
      stage: row.stage,
      status: row.status,
      probability: row.probability,
      expected_amount: String(Number(row.expected_amount) || 0),
      currency: row.currency,
      expected_close_date: row.expected_close_date ?? "",
      registered_at: row.registered_at ?? "",
      source: row.source ?? "",
      business_type: row.business_type,
      description: row.description ?? "",
      contact_name: row.contact_name ?? "",
      contact_department: row.contact_department ?? "",
      contact_phone: row.contact_phone ?? "",
      contact_email: row.contact_email ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  return (
    <>
      <DashboardHeader
        title="영업기회"
        actions={
          <div className="flex gap-2 items-center">
            {fx && (
              <div className="text-sm rounded-md border border-border bg-card px-3 py-1 shadow-sm">
                USD/KRW:{" "}
                <span className="font-semibold">
                  {Number(fx.rate).toLocaleString()}
                </span>{" "}
                <span className="text-muted-foreground">({fx.as_of})</span>
              </div>
            )}
            <select
              value={customerFilter ?? ""}
              onChange={(e) =>
                updateCustomerFilter(e.target.value || null)
              }
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
            <ExportMenu
              disabled={exporting || opps.length === 0}
              exporting={exporting}
              open={exportMenuOpen}
              onOpenChange={setExportMenuOpen}
              onPDF={handleExportPDF}
              onExcel={handleExportExcel}
            />
          </div>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <div className="grid grid-cols-4 gap-4">
          <KpiCard
            label="연간 영업 금액"
            value={fmtKrw(summary?.total_amount ?? 0)}
            sub={`${summary?.total_count ?? 0}건 (진행중 + 수주)`}
          />
          <KpiCard
            label="확률 반영 예상액"
            value={fmtKrw(summary?.weighted_amount ?? 0)}
            sub="금액 × 단계별 확률"
          />
          <WonAmountCard
            krw={summary?.won_amount_krw ?? "0"}
            usd={summary?.won_amount_usd ?? "0"}
            fxRate={fx?.rate}
          />
          <KpiCard
            label="수주율"
            value={`${((summary?.win_rate ?? 0) * 100).toFixed(1)}%`}
            sub={`실주 ${fmtKrw(summary?.lost_amount ?? 0)}`}
          />
        </div>

        <TimelineView
          year={year}
          opps={opps}
          onAdd={() => {
            setAddForm(BLANK);
            setAddError(null);
            setAddOpen(true);
          }}
        />

      </div>

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="영업기회 등록"
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
              onClick={() => addForm.name && createM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              등록
            </button>
          </>
        }
      >
        <OpportunityFormBody
          form={addForm}
          setForm={(u) =>
            setAddForm((prev) => (typeof u === "function" ? u(prev) : u))
          }
          customers={customers}
          developers={developersList}
          error={addError}
        />
      </Dialog>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="영업기회 수정"
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
              onClick={() => editForm.name && updateM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        <OpportunityFormBody
          form={editForm}
          setForm={(u) =>
            setEditForm((prev) => (typeof u === "function" ? u(prev) : u))
          }
          customers={customers}
          developers={developersList}
          error={editError}
        />
      </Dialog>
    </>
  );
}

function WonAmountCard({
  krw,
  usd,
  fxRate,
}: {
  krw: string;
  usd: string;
  fxRate?: string;
}) {
  const k = Number(krw) || 0;
  const u = Number(usd) || 0;
  const rate = Number(fxRate) || 0;
  const usdInKrw = rate > 0 ? u * rate : NaN;
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">수주 금액</div>
      <div className="mt-1 space-y-0.5">
        <div className="text-lg font-bold text-emerald-700 tabular-nums">
          {k > 0 ? Math.round(k).toLocaleString() + "원" : "-"}
        </div>
        <div className="text-lg font-bold text-emerald-700 tabular-nums">
          {u > 0
            ? "$" +
              u.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : "-"}
        </div>
        {u > 0 && Number.isFinite(usdInKrw) && (
          <div className="text-lg font-bold text-emerald-700 tabular-nums">
            ({Math.round(usdInKrw).toLocaleString()}원)
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  color,
  valueClass = "text-2xl font-bold",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`mt-1 ${valueClass} ${color ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline visualization
// Shows each opportunity as a horizontal bar from created_at (clipped to
// Jan 1 of the selected year) to expected_close_date (or closed_at), across
// the 12 months of the selected year. Bar color reflects the current stage;
// WON/LOST pills add an outline.
// ---------------------------------------------------------------------------

function TimelineView({
  year,
  opps,
  onAdd,
}: {
  year: number;
  opps: Opportunity[];
  onAdd?: () => void;
}) {
  const ROW_H = 28;
  const LABEL_W = 360;

  const start = new Date(`${year}-01-01T00:00:00`).getTime();
  const end = new Date(`${year + 1}-01-01T00:00:00`).getTime();
  const totalMs = end - start;

  const rows = useMemo(
    () =>
      opps
        .filter((o) => o.expected_close_date)
        .sort((a, b) =>
          (a.expected_close_date ?? "").localeCompare(b.expected_close_date ?? ""),
        ),
    [opps],
  );

  // 12 month ticks
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(year, i, 1).getTime(),
  );
  const pct = (t: number) =>
    Math.max(0, Math.min(100, ((t - start) / totalMs) * 100));

  const today = Date.now();
  const todayInRange = today >= start && today < end;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-semibold">타임라인</h2>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <Legend color={STAGE_COLOR.LEAD} label="발굴" />
          <Legend color={STAGE_COLOR.QUALIFIED} label="검증" />
          <Legend color={STAGE_COLOR.PROPOSAL} label="제안" />
          <Legend color={STAGE_COLOR.NEGOTIATION} label="협상" />
          <Legend color={STATUS_COLOR.WON} label="수주" />
          <Legend color={STATUS_COLOR.LOST} label="실주" />
        </div>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="ml-auto h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3.5 w-3.5" />
            추가
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          해당 연도의 영업기회가 없습니다.
        </p>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-auto">
          <div className="flex border-b border-border sticky top-0 z-10 bg-card">
            <div
              className="shrink-0 px-3 py-2 text-sm font-semibold bg-muted/40 border-r border-border"
              style={{ width: LABEL_W }}
            >
              기회 / 고객
            </div>
            <div className="flex-1 relative bg-muted/20 h-9">
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full border-l border-border text-xs text-muted-foreground"
                  style={{ left: `${pct(m)}%` }}
                >
                  <span className="pl-1">{i + 1}월</span>
                </div>
              ))}
              {todayInRange && (
                <div
                  className="absolute top-0 h-full border-l-2 border-red-500/60"
                  style={{ left: `${pct(today)}%` }}
                />
              )}
            </div>
          </div>

          {rows.map((o) => {
            // 타임라인 구간 = 등록일(registered_at) → 예상 마감일(expected_close_date).
            // 등록일이 없으면 created_at 로 폴백. closed_at 은 무시 (표시는 색상으로 구분).
            const startIso =
              o.registered_at ?? o.created_at.slice(0, 10);
            const s = new Date(`${startIso}T00:00:00`).getTime();
            const closeIso = o.expected_close_date!;
            const e = new Date(`${closeIso}T00:00:00`).getTime() + 86_400_000;
            // 등록일이 마감일 이후(역전) 인 경우 연도 시작으로 폴백해 항상 표시되게.
            let barStart = Math.max(start, s);
            const barEnd = Math.min(end, e);
            if (barEnd <= barStart) barStart = start;
            if (barEnd <= barStart) return null;
            const left = pct(barStart);
            const width = Math.max(1, pct(barEnd) - left);
            const color =
              o.status === "WON"
                ? STATUS_COLOR.WON
                : o.status === "LOST"
                  ? STATUS_COLOR.LOST
                  : o.status === "ABANDONED"
                    ? STATUS_COLOR.ABANDONED
                    : STAGE_COLOR[o.stage];
            const closed =
              o.status === "WON" || o.status === "LOST" || o.status === "ABANDONED";
            return (
              <div
                key={o.id}
                className="flex border-b border-border hover:bg-muted/30"
              >
                <div
                  className="shrink-0 px-3 py-1.5 flex flex-col gap-0.5 text-sm border-r border-border bg-card"
                  style={{ width: LABEL_W }}
                >
                  <Tooltip
                    side="right"
                    label={
                      o.business_type
                        ? `${BIZ_LABEL[o.business_type]} · ${o.name}`
                        : o.name
                    }
                  >
                    <Link
                      href={`/opportunities/${o.id}`}
                      className="font-medium hover:underline break-words"
                    >
                      {o.business_type ? `${BIZ_PREFIX[o.business_type]} ` : ""}
                      {o.name}
                    </Link>
                  </Tooltip>
                  <span className="text-xs text-muted-foreground break-words">
                    {o.customer_name ?? "-"} / {o.sales_rep_name ?? "-"}
                  </span>
                </div>
                <div
                  className="flex-1 relative"
                  style={{ minHeight: ROW_H }}
                >
                  {months.map((m, i) => (
                    <div
                      key={i}
                      className="absolute top-0 h-full border-l border-border/40"
                      style={{ left: `${pct(m)}%` }}
                    />
                  ))}
                  {todayInRange && (
                    <div
                      className="absolute top-0 h-full border-l-2 border-red-500/60"
                      style={{ left: `${pct(today)}%` }}
                    />
                  )}
                  <div
                    className="group/tt absolute cursor-pointer"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      top: 4,
                      height: ROW_H - 8,
                    }}
                  >
                    <div
                      className="h-full w-full rounded flex items-center px-2 overflow-hidden whitespace-nowrap shadow-sm"
                      style={{
                        backgroundColor: color,
                        color: "#fff",
                        fontSize: 11,
                        border: closed
                          ? "2px solid rgba(255,255,255,0.7)"
                          : undefined,
                        opacity: o.status === "ABANDONED" ? 0.5 : 1,
                      }}
                    >
                      {fmtMoney(o.expected_amount, o.currency)} / {o.probability}%
                    </div>
                    <Tooltip
                      inline
                      side="top"
                      label={`${STAGE_LABEL[o.stage]} · ${STATUS_LABEL[o.status]} · ${fmtMoney(o.expected_amount, o.currency)} · ${o.probability}%`}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="inline-block w-3 h-3 rounded"
        style={{ backgroundColor: color }}
      />
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export helpers (PDF / Excel)
// ---------------------------------------------------------------------------

type ExportCtx = {
  year: number;
  opps: Opportunity[];
  summary: Summary | undefined;
  fxRate: number;
};

function toKrw(
  amount: string | number,
  currency: "KRW" | "USD",
  rate: number,
): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  if (currency === "USD") return rate > 0 ? n * rate : 0;
  return n;
}

function computeBreakdowns({ opps, fxRate }: ExportCtx) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 상태별
  const byStatus: Record<
    Status,
    { count: number; amountKrw: number }
  > = {
    OPEN: { count: 0, amountKrw: 0 },
    WON: { count: 0, amountKrw: 0 },
    LOST: { count: 0, amountKrw: 0 },
    ABANDONED: { count: 0, amountKrw: 0 },
  };

  // 사업유형별
  const byBiz: Record<
    "RESEARCH" | "PRIVATE" | "PUBLIC" | "UNSET",
    { count: number; amountKrw: number }
  > = {
    RESEARCH: { count: 0, amountKrw: 0 },
    PRIVATE: { count: 0, amountKrw: 0 },
    PUBLIC: { count: 0, amountKrw: 0 },
    UNSET: { count: 0, amountKrw: 0 },
  };

  // 담당자별
  const reps = new Map<
    string,
    {
      name: string;
      count: number;
      totalKrw: number;
      wonKrw: number;
      lostKrw: number;
      wonCount: number;
      lostCount: number;
    }
  >();

  // 고객사별
  const customers = new Map<
    string,
    { name: string; count: number; totalKrw: number; wonKrw: number }
  >();

  // 소스별
  const sources = new Map<string, { count: number; totalKrw: number }>();

  // 월별 트렌드 (expected_close_date 월 기준)
  const months: {
    month: number;
    expectedCount: number;
    expectedKrw: number;
    wonCount: number;
    wonKrw: number;
    lostCount: number;
    lostKrw: number;
  }[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    expectedCount: 0,
    expectedKrw: 0,
    wonCount: 0,
    wonKrw: 0,
    lostCount: 0,
    lostKrw: 0,
  }));

  // 주의 리스트
  const overdue: Opportunity[] = [];
  const dueSoon: Opportunity[] = [];

  for (const o of opps) {
    const krw = toKrw(o.expected_amount, o.currency, fxRate);
    byStatus[o.status].count += 1;
    byStatus[o.status].amountKrw += krw;

    const bizKey = (o.business_type ?? "UNSET") as
      | "RESEARCH"
      | "PRIVATE"
      | "PUBLIC"
      | "UNSET";
    byBiz[bizKey].count += 1;
    byBiz[bizKey].amountKrw += krw;

    const repName = o.sales_rep_name ?? "(미지정)";
    const repKey = o.sales_rep_id ?? "none";
    if (!reps.has(repKey)) {
      reps.set(repKey, {
        name: repName,
        count: 0,
        totalKrw: 0,
        wonKrw: 0,
        lostKrw: 0,
        wonCount: 0,
        lostCount: 0,
      });
    }
    const rep = reps.get(repKey)!;
    rep.count += 1;
    rep.totalKrw += krw;
    if (o.status === "WON") {
      rep.wonKrw += krw;
      rep.wonCount += 1;
    } else if (o.status === "LOST") {
      rep.lostKrw += krw;
      rep.lostCount += 1;
    }

    const custName = o.customer_name ?? "(미지정)";
    const custKey = o.customer_id ?? "none";
    if (!customers.has(custKey)) {
      customers.set(custKey, { name: custName, count: 0, totalKrw: 0, wonKrw: 0 });
    }
    const cust = customers.get(custKey)!;
    cust.count += 1;
    cust.totalKrw += krw;
    if (o.status === "WON") cust.wonKrw += krw;

    const srcKey = (o.source ?? "").trim() || "(미분류)";
    if (!sources.has(srcKey)) sources.set(srcKey, { count: 0, totalKrw: 0 });
    const src = sources.get(srcKey)!;
    src.count += 1;
    src.totalKrw += krw;

    if (o.expected_close_date) {
      const m = Number(o.expected_close_date.slice(5, 7));
      if (m >= 1 && m <= 12) {
        months[m - 1].expectedCount += 1;
        months[m - 1].expectedKrw += krw;
      }
    }
    if (o.status === "WON" && o.closed_at) {
      const m = Number(o.closed_at.slice(5, 7));
      if (m >= 1 && m <= 12) {
        months[m - 1].wonCount += 1;
        months[m - 1].wonKrw += krw;
      }
    } else if (o.status === "LOST" && o.closed_at) {
      const m = Number(o.closed_at.slice(5, 7));
      if (m >= 1 && m <= 12) {
        months[m - 1].lostCount += 1;
        months[m - 1].lostKrw += krw;
      }
    }

    // 주의 리스트 (진행중 + 예상마감일 있는 건)
    if (o.status === "OPEN" && o.expected_close_date) {
      const d = new Date(`${o.expected_close_date}T00:00:00`);
      const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      if (diff < 0) overdue.push(o);
      else if (diff <= 30) dueSoon.push(o);
    }
  }

  const repsSorted = [...reps.values()].sort((a, b) => b.totalKrw - a.totalKrw);
  const customersSorted = [...customers.values()]
    .sort((a, b) => b.totalKrw - a.totalKrw)
    .slice(0, 10);
  const sourcesSorted = [...sources.entries()]
    .map(([key, v]) => ({ source: key, ...v }))
    .sort((a, b) => b.totalKrw - a.totalKrw);

  return {
    byStatus,
    byBiz,
    reps: repsSorted,
    topCustomers: customersSorted,
    sources: sourcesSorted,
    months,
    overdue: overdue.sort((a, b) =>
      (a.expected_close_date ?? "").localeCompare(b.expected_close_date ?? ""),
    ),
    dueSoon: dueSoon.sort((a, b) =>
      (a.expected_close_date ?? "").localeCompare(b.expected_close_date ?? ""),
    ),
  };
}

function buildOppExcelBook(ctx: ExportCtx): XLSX.WorkBook {
  const { year, opps, summary, fxRate } = ctx;
  const b = computeBreakdowns(ctx);
  const wb = XLSX.utils.book_new();

  const round = (n: number) => Math.round(n);
  const pct = (n: number) => Math.round(n * 1000) / 10;

  // Sheet 1 — 요약
  const summaryRows: Array<Record<string, string | number>> = [
    { 항목: "대상 연도", 값: year },
    { 항목: "생성일", 값: new Date().toLocaleString("ko-KR") },
    { 항목: "적용 환율(USD→KRW)", 값: fxRate > 0 ? fxRate : "" },
    { 항목: "전체 건수", 값: summary?.total_count ?? opps.length },
    {
      항목: "연간 영업 금액(KRW)",
      값: round(Number(summary?.total_amount ?? 0)),
    },
    {
      항목: "확률 반영 예상액(KRW)",
      값: round(Number(summary?.weighted_amount ?? 0)),
    },
    {
      항목: "수주 금액(KRW 환산)",
      값: round(Number(summary?.won_amount ?? 0)),
    },
    { 항목: "수주 금액(원화)", 값: round(Number(summary?.won_amount_krw ?? 0)) },
    { 항목: "수주 금액(USD)", 값: round(Number(summary?.won_amount_usd ?? 0)) },
    { 항목: "실주 금액(KRW)", 값: round(Number(summary?.lost_amount ?? 0)) },
    { 항목: "수주율(%)", 값: pct(Number(summary?.win_rate ?? 0)) },
  ];
  const ws1 = XLSX.utils.json_to_sheet(summaryRows);
  ws1["!cols"] = [{ wch: 24 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws1, "요약");

  // Sheet 2 — 단계별
  const stageRows = (summary?.by_stage ?? []).map((s) => ({
    단계: STAGE_LABEL[s.stage as Stage] ?? s.stage,
    건수: s.count,
    "금액(KRW)": round(Number(s.amount)),
    "확률 반영(KRW)": round(Number(s.weighted)),
  }));
  const ws2 = XLSX.utils.json_to_sheet(stageRows);
  ws2["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws2, "단계별");

  // Sheet 3 — 상태별
  const statusRows = (["OPEN", "WON", "LOST", "ABANDONED"] as Status[]).map(
    (k) => ({
      상태: STATUS_LABEL[k],
      건수: b.byStatus[k].count,
      "금액(KRW)": round(b.byStatus[k].amountKrw),
    }),
  );
  const ws3 = XLSX.utils.json_to_sheet(statusRows);
  ws3["!cols"] = [{ wch: 10 }, { wch: 8 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws3, "상태별");

  // Sheet 4 — 사업유형별
  const bizRows = (
    ["RESEARCH", "PRIVATE", "PUBLIC", "UNSET"] as const
  ).map((k) => ({
    사업유형: k === "UNSET" ? "(미분류)" : BIZ_LABEL[k],
    건수: b.byBiz[k].count,
    "금액(KRW)": round(b.byBiz[k].amountKrw),
  }));
  const ws4 = XLSX.utils.json_to_sheet(bizRows);
  ws4["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws4, "사업유형별");

  // Sheet 5 — 담당자별
  const repRows = b.reps.map((r) => {
    const closed = r.wonCount + r.lostCount;
    const winRate = closed > 0 ? r.wonCount / closed : 0;
    return {
      담당자: r.name,
      건수: r.count,
      "총 금액(KRW)": round(r.totalKrw),
      "수주 건수": r.wonCount,
      "수주 금액(KRW)": round(r.wonKrw),
      "실주 건수": r.lostCount,
      "실주 금액(KRW)": round(r.lostKrw),
      "수주율(%)": pct(winRate),
    };
  });
  const ws5 = XLSX.utils.json_to_sheet(repRows);
  ws5["!cols"] = [
    { wch: 14 },
    { wch: 8 },
    { wch: 18 },
    { wch: 10 },
    { wch: 18 },
    { wch: 10 },
    { wch: 18 },
    { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, ws5, "담당자별");

  // Sheet 6 — 고객사 Top
  const custRows = b.topCustomers.map((c) => ({
    고객사: c.name,
    건수: c.count,
    "총 금액(KRW)": round(c.totalKrw),
    "수주 금액(KRW)": round(c.wonKrw),
  }));
  const ws6 = XLSX.utils.json_to_sheet(custRows);
  ws6["!cols"] = [{ wch: 24 }, { wch: 8 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws6, "고객사 Top 10");

  // Sheet 7 — 소스별
  const srcRows = b.sources.map((s) => ({
    소스: s.source,
    건수: s.count,
    "금액(KRW)": round(s.totalKrw),
  }));
  const ws7 = XLSX.utils.json_to_sheet(srcRows);
  ws7["!cols"] = [{ wch: 18 }, { wch: 8 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws7, "소스별");

  // Sheet 8 — 월별 트렌드
  const monthRows = b.months.map((m) => ({
    월: `${m.month}월`,
    "예상마감 건수": m.expectedCount,
    "예상마감 금액(KRW)": round(m.expectedKrw),
    "수주 건수": m.wonCount,
    "수주 금액(KRW)": round(m.wonKrw),
    "실주 건수": m.lostCount,
    "실주 금액(KRW)": round(m.lostKrw),
  }));
  const ws8 = XLSX.utils.json_to_sheet(monthRows);
  ws8["!cols"] = [
    { wch: 6 },
    { wch: 12 },
    { wch: 18 },
    { wch: 10 },
    { wch: 18 },
    { wch: 10 },
    { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(wb, ws8, "월별 트렌드");

  // Sheet 9 — 주의 리스트
  const attentionRows: Array<Record<string, string | number>> = [];
  for (const o of b.overdue) {
    attentionRows.push({
      분류: "예상마감 초과",
      제목: o.name,
      고객사: o.customer_name ?? "-",
      담당자: o.sales_rep_name ?? "-",
      단계: STAGE_LABEL[o.stage],
      예상마감일: o.expected_close_date ?? "-",
      "금액(원화)":
        o.currency === "USD"
          ? `$${Number(o.expected_amount).toLocaleString()}`
          : Math.round(Number(o.expected_amount)).toLocaleString(),
      확률: o.probability,
    });
  }
  for (const o of b.dueSoon) {
    attentionRows.push({
      분류: "마감 임박(D-30)",
      제목: o.name,
      고객사: o.customer_name ?? "-",
      담당자: o.sales_rep_name ?? "-",
      단계: STAGE_LABEL[o.stage],
      예상마감일: o.expected_close_date ?? "-",
      "금액(원화)":
        o.currency === "USD"
          ? `$${Number(o.expected_amount).toLocaleString()}`
          : Math.round(Number(o.expected_amount)).toLocaleString(),
      확률: o.probability,
    });
  }
  const ws9 = XLSX.utils.json_to_sheet(
    attentionRows.length ? attentionRows : [{ 분류: "-" }],
  );
  ws9["!cols"] = [
    { wch: 16 },
    { wch: 32 },
    { wch: 18 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
    { wch: 16 },
    { wch: 8 },
  ];
  XLSX.utils.book_append_sheet(wb, ws9, "주의 리스트");

  // Sheet 10 — 상세 목록 (전체)
  const detailRows = opps.map((o) => {
    const krw = toKrw(o.expected_amount, o.currency, fxRate);
    return {
      제목: o.name,
      고객사: o.customer_name ?? "-",
      담당자: o.sales_rep_name ?? "-",
      오너: o.owner_name ?? "-",
      사업유형: o.business_type ? BIZ_LABEL[o.business_type] : "-",
      단계: STAGE_LABEL[o.stage],
      상태: STATUS_LABEL[o.status],
      "확률(%)": o.probability,
      통화: o.currency,
      금액: Math.round(Number(o.expected_amount)),
      "금액(KRW 환산)": Math.round(krw),
      "확률 반영(KRW)": Math.round(
        (krw * (Number(o.probability) || 0)) / 100,
      ),
      예상마감일: o.expected_close_date ?? "-",
      종료일: o.closed_at ? o.closed_at.slice(0, 10) : "-",
      소스: o.source ?? "-",
      등록일: o.registered_at ?? o.created_at.slice(0, 10),
      담당자연락처: o.contact_name
        ? `${o.contact_name}${
            o.contact_phone ? ` / ${o.contact_phone}` : ""
          }${o.contact_email ? ` / ${o.contact_email}` : ""}`
        : "-",
    };
  });
  const ws10 = XLSX.utils.json_to_sheet(
    detailRows.length ? detailRows : [{ 제목: "-" }],
  );
  ws10["!cols"] = [
    { wch: 30 },
    { wch: 18 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 6 },
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, ws10, "상세 목록");

  return wb;
}

function buildOppStatusHTML(ctx: ExportCtx): string {
  const { year, opps, summary, fxRate } = ctx;
  const b = computeBreakdowns(ctx);

  const fmtKrwNum = (n: number) =>
    n > 0 ? Math.round(n).toLocaleString() + "원" : "-";
  const fmtCount = (n: number) => n.toLocaleString() + "건";
  const fmtPct = (n: number) => (n * 100).toFixed(1) + "%";

  const date = new Date().toLocaleString("ko-KR");

  const kpiCard = (label: string, value: string, sub?: string) => `
    <div style="flex:1;min-width:180px;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;background:#f8fafc;">
      <div style="font-size:11px;color:#64748b;">${escapeHtml(label)}</div>
      <div style="font-size:18px;font-weight:700;margin-top:4px;">${escapeHtml(value)}</div>
      ${sub ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${escapeHtml(sub)}</div>` : ""}
    </div>`;

  const kpis = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
      ${kpiCard(
        "연간 영업 금액(KRW)",
        fmtKrwNum(Number(summary?.total_amount ?? 0)),
        `${summary?.total_count ?? opps.length}건 (진행중 + 수주)`,
      )}
      ${kpiCard(
        "확률 반영 예상액(KRW)",
        fmtKrwNum(Number(summary?.weighted_amount ?? 0)),
        "금액 × 단계별 확률",
      )}
      ${kpiCard(
        "수주 금액",
        fmtKrwNum(Number(summary?.won_amount ?? 0)),
        `₩ ${Math.round(Number(summary?.won_amount_krw ?? 0)).toLocaleString()} / $ ${Math.round(
          Number(summary?.won_amount_usd ?? 0),
        ).toLocaleString()}`,
      )}
      ${kpiCard(
        "수주율",
        fmtPct(Number(summary?.win_rate ?? 0)),
        `실주 ${fmtKrwNum(Number(summary?.lost_amount ?? 0))}`,
      )}
    </div>`;

  const sectionTitle = (t: string) =>
    `<div style="font-size:13px;font-weight:700;margin:18px 0 6px 0;color:#0f172a;">${escapeHtml(t)}</div>`;

  const thStyle =
    "padding:6px 8px;background:#f1f5f9;border-bottom:2px solid #cbd5e1;text-align:left;font-size:11px;font-weight:700;";
  const tdStyle =
    "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;vertical-align:middle;";

  const tableStart = `<table style="width:100%;border-collapse:collapse;table-layout:auto;">`;
  const tableEnd = `</table>`;

  // 단계별
  const stageBody = (summary?.by_stage ?? [])
    .map(
      (s) => `
      <tr>
        <td style="${tdStyle}">${escapeHtml(STAGE_LABEL[s.stage as Stage] ?? s.stage)}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(s.count)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(Number(s.amount))}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(Number(s.weighted))}</td>
      </tr>`,
    )
    .join("");
  const stageTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">단계</th>
        <th style="${thStyle};text-align:right;">건수</th>
        <th style="${thStyle};text-align:right;">금액(KRW)</th>
        <th style="${thStyle};text-align:right;">확률 반영(KRW)</th>
      </tr></thead>
      <tbody>${stageBody}</tbody>
    ${tableEnd}`;

  // 상태별
  const statusBody = (["OPEN", "WON", "LOST", "ABANDONED"] as Status[])
    .map(
      (k) => `
      <tr>
        <td style="${tdStyle}">${escapeHtml(STATUS_LABEL[k])}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(b.byStatus[k].count)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(b.byStatus[k].amountKrw)}</td>
      </tr>`,
    )
    .join("");
  const statusTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">상태</th>
        <th style="${thStyle};text-align:right;">건수</th>
        <th style="${thStyle};text-align:right;">금액(KRW)</th>
      </tr></thead>
      <tbody>${statusBody}</tbody>
    ${tableEnd}`;

  // 사업유형별
  const bizBody = (["RESEARCH", "PRIVATE", "PUBLIC", "UNSET"] as const)
    .map(
      (k) => `
      <tr>
        <td style="${tdStyle}">${escapeHtml(k === "UNSET" ? "(미분류)" : BIZ_LABEL[k])}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(b.byBiz[k].count)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(b.byBiz[k].amountKrw)}</td>
      </tr>`,
    )
    .join("");
  const bizTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">사업유형</th>
        <th style="${thStyle};text-align:right;">건수</th>
        <th style="${thStyle};text-align:right;">금액(KRW)</th>
      </tr></thead>
      <tbody>${bizBody}</tbody>
    ${tableEnd}`;

  // 담당자별
  const repsBody = b.reps
    .map((r) => {
      const closed = r.wonCount + r.lostCount;
      const winRate = closed > 0 ? r.wonCount / closed : 0;
      return `
      <tr>
        <td style="${tdStyle}">${escapeHtml(r.name)}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(r.count)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(r.totalKrw)}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(r.wonCount)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(r.wonKrw)}</td>
        <td style="${tdStyle};text-align:right;">${closed > 0 ? fmtPct(winRate) : "-"}</td>
      </tr>`;
    })
    .join("");
  const repsTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">담당자</th>
        <th style="${thStyle};text-align:right;">건수</th>
        <th style="${thStyle};text-align:right;">총 금액(KRW)</th>
        <th style="${thStyle};text-align:right;">수주</th>
        <th style="${thStyle};text-align:right;">수주 금액(KRW)</th>
        <th style="${thStyle};text-align:right;">수주율</th>
      </tr></thead>
      <tbody>${repsBody || `<tr><td style="${tdStyle}" colspan="6">데이터 없음</td></tr>`}</tbody>
    ${tableEnd}`;

  // 고객사 Top 10
  const custBody = b.topCustomers
    .map(
      (c) => `
      <tr>
        <td style="${tdStyle}">${escapeHtml(c.name)}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(c.count)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(c.totalKrw)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(c.wonKrw)}</td>
      </tr>`,
    )
    .join("");
  const custTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">고객사</th>
        <th style="${thStyle};text-align:right;">건수</th>
        <th style="${thStyle};text-align:right;">총 금액(KRW)</th>
        <th style="${thStyle};text-align:right;">수주 금액(KRW)</th>
      </tr></thead>
      <tbody>${custBody || `<tr><td style="${tdStyle}" colspan="4">데이터 없음</td></tr>`}</tbody>
    ${tableEnd}`;

  // 월별 트렌드
  const monthBody = b.months
    .map(
      (m) => `
      <tr>
        <td style="${tdStyle}">${m.month}월</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(m.expectedCount)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(m.expectedKrw)}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(m.wonCount)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(m.wonKrw)}</td>
        <td style="${tdStyle};text-align:right;">${fmtCount(m.lostCount)}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(m.lostKrw)}</td>
      </tr>`,
    )
    .join("");
  const monthTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">월</th>
        <th style="${thStyle};text-align:right;">예상마감</th>
        <th style="${thStyle};text-align:right;">예상마감 금액(KRW)</th>
        <th style="${thStyle};text-align:right;">수주</th>
        <th style="${thStyle};text-align:right;">수주 금액(KRW)</th>
        <th style="${thStyle};text-align:right;">실주</th>
        <th style="${thStyle};text-align:right;">실주 금액(KRW)</th>
      </tr></thead>
      <tbody>${monthBody}</tbody>
    ${tableEnd}`;

  // 주의 리스트
  const attentionBody = [
    ...b.overdue.map((o) => ({ tag: "예상마감 초과", tagColor: "#dc2626", o })),
    ...b.dueSoon.map((o) => ({ tag: "마감 임박 D-30", tagColor: "#d97706", o })),
  ]
    .map(
      ({ tag, tagColor, o }) => `
      <tr>
        <td style="${tdStyle}"><span style="color:${tagColor};font-weight:700;">${escapeHtml(tag)}</span></td>
        <td style="${tdStyle}">${escapeHtml(o.name)}</td>
        <td style="${tdStyle}">${escapeHtml(o.customer_name ?? "-")}</td>
        <td style="${tdStyle}">${escapeHtml(o.sales_rep_name ?? "-")}</td>
        <td style="${tdStyle}">${escapeHtml(STAGE_LABEL[o.stage])}</td>
        <td style="${tdStyle};text-align:right;">${escapeHtml(o.expected_close_date ?? "-")}</td>
        <td style="${tdStyle};text-align:right;">${escapeHtml(
          o.currency === "USD"
            ? `$${Number(o.expected_amount).toLocaleString()}`
            : Math.round(Number(o.expected_amount)).toLocaleString() + "원",
        )}</td>
      </tr>`,
    )
    .join("");
  const attentionTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">분류</th>
        <th style="${thStyle}">제목</th>
        <th style="${thStyle}">고객사</th>
        <th style="${thStyle}">담당자</th>
        <th style="${thStyle}">단계</th>
        <th style="${thStyle};text-align:right;">예상마감일</th>
        <th style="${thStyle};text-align:right;">금액</th>
      </tr></thead>
      <tbody>${attentionBody || `<tr><td style="${tdStyle}" colspan="7">주의 항목 없음</td></tr>`}</tbody>
    ${tableEnd}`;

  // 상세 목록
  const detailBody = opps
    .map((o) => {
      const krw = toKrw(o.expected_amount, o.currency, fxRate);
      return `
      <tr>
        <td style="${tdStyle}">${escapeHtml(o.name)}</td>
        <td style="${tdStyle}">${escapeHtml(o.customer_name ?? "-")}</td>
        <td style="${tdStyle}">${escapeHtml(o.sales_rep_name ?? "-")}</td>
        <td style="${tdStyle}">${escapeHtml(STAGE_LABEL[o.stage])}</td>
        <td style="${tdStyle}">${escapeHtml(STATUS_LABEL[o.status])}</td>
        <td style="${tdStyle};text-align:right;">${o.probability}%</td>
        <td style="${tdStyle};text-align:right;">${escapeHtml(
          o.currency === "USD"
            ? `$${Number(o.expected_amount).toLocaleString()}`
            : Math.round(Number(o.expected_amount)).toLocaleString() + "원",
        )}</td>
        <td style="${tdStyle};text-align:right;">${fmtKrwNum(krw)}</td>
        <td style="${tdStyle};text-align:right;">${escapeHtml(o.expected_close_date ?? "-")}</td>
        <td style="${tdStyle}">${escapeHtml(o.source ?? "-")}</td>
      </tr>`;
    })
    .join("");
  const detailTable = `
    ${tableStart}
      <thead><tr>
        <th style="${thStyle}">제목</th>
        <th style="${thStyle}">고객사</th>
        <th style="${thStyle}">담당자</th>
        <th style="${thStyle}">단계</th>
        <th style="${thStyle}">상태</th>
        <th style="${thStyle};text-align:right;">확률</th>
        <th style="${thStyle};text-align:right;">금액</th>
        <th style="${thStyle};text-align:right;">금액(KRW)</th>
        <th style="${thStyle};text-align:right;">예상마감</th>
        <th style="${thStyle}">소스</th>
      </tr></thead>
      <tbody>${detailBody || `<tr><td style="${tdStyle}" colspan="10">데이터 없음</td></tr>`}</tbody>
    ${tableEnd}`;

  return `
    <div style="margin-bottom:12px;">
      <div style="font-size:20px;font-weight:700;">${year}년 영업기회 현황</div>
      <div style="font-size:11px;color:#64748b;margin-top:4px;">
        생성일: ${escapeHtml(date)} · 전체 ${opps.length}건
        ${fxRate > 0 ? ` · 적용 환율 USD/KRW ${fxRate.toLocaleString()}` : ""}
      </div>
    </div>
    ${kpis}
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
      <div style="flex:2;min-width:420px;">
        ${sectionTitle("단계별")}
        ${stageTable}
      </div>
      <div style="flex:1;min-width:240px;">
        ${sectionTitle("상태별")}
        ${statusTable}
        ${sectionTitle("사업유형별")}
        ${bizTable}
      </div>
    </div>
    ${sectionTitle("월별 트렌드")}
    ${monthTable}
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
      <div style="flex:1;min-width:360px;">
        ${sectionTitle("담당자별")}
        ${repsTable}
      </div>
      <div style="flex:1;min-width:360px;">
        ${sectionTitle("고객사 Top 10")}
        ${custTable}
      </div>
    </div>
    ${sectionTitle("주의 리스트 (예상마감 초과 / D-30)")}
    ${attentionTable}
    ${sectionTitle("상세 목록")}
    ${detailTable}
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
