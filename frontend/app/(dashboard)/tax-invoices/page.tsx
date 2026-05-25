"use client";

/**
 * 전자세금계산서 (매입·매출) 목록·상세.
 *
 * 바로빌 API 로부터 수집된 세금계산서를 조회·편집·PDF 다운로드한다. 수집 자체는
 * 백엔드 스케줄러(매일 03:00 KST · 최근 7일 catch-up) 가 담당하며, 본 화면의
 * "지금 수집" 버튼으로 수동 트리거 가능.
 *
 * 페이지네이션: 서버에서 한 번에 최대 500건 로드 후 DataGrid 내장 페이지 번호
 * 네비게이션 사용 (공지사항과 동일한 UX). 회계 연도 단위 데이터 규모 (~1~2천건)
 * 에서는 클라이언트 페이징이 서버 왕복보다 빠르다.
 */

import { useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { BarChart3, Download, FileDown, Package, RefreshCw, Save, Trash2, X } from "lucide-react";
import Highcharts from "@/lib/highcharts-init";
import HighchartsReact from "highcharts-react-official";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { DateInput } from "@/components/ui/DateInput";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { TaxInvoiceDetailDialog } from "@/components/tax-invoices/TaxInvoiceDetailDialog";

type Kind = "SALES" | "PURCHASE";
type Linked = "all" | "matched" | "unmatched";

type TaxInvoiceItem = {
  id: string;
  position: number;
  item_name: string | null;
  spec: string | null;
  quantity: number | null;
  unit_price: number | null;
  supply_amount: number | null;
  tax_amount: number | null;
  memo: string | null;
};

type TaxInvoice = {
  id: string;
  kind: Kind;
  status: string;
  approval_no: string;
  mgt_key: string | null;
  issue_date: string;
  written_date: string | null;
  supplier_biz_no: string | null;
  supplier_name: string | null;
  supplier_ceo: string | null;
  buyer_biz_no: string | null;
  buyer_name: string | null;
  buyer_ceo: string | null;
  supply_amount: number;
  tax_amount: number;
  total_amount: number;
  tax_type: string | null;
  issue_type: string | null;
  source: string;
  has_pdf: boolean;
  linked_customer_id: string | null;
  linked_customer_name: string | null;
  linked_invoice_id: string | null;
  linked_invoice_number: string | null;
  linked_project_id: string | null;
  linked_project_name: string | null;
  memo: string | null;
  items: TaxInvoiceItem[];
  created_at: string;
  updated_at: string;
};

type Page = {
  items: TaxInvoice[];
  total: number;
  page: number;
  page_size: number;
};

type Summary = {
  kind: Kind;
  count: number;
  supply_amount: number;
  tax_amount: number;
  total_amount: number;
  matched_customer_count: number;
  matched_invoice_count: number;
};

type FetchRecord = {
  id: string;
  kind: Kind;
  method: string;
  period_start: string | null;
  period_end: string | null;
  trigger_kind: string;
  status: string;
  fetched_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

function firstDayOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const KRW = (n: number) => n.toLocaleString("ko-KR");

export default function TaxInvoicesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [kind, setKind] = useState<Kind>("PURCHASE");
  const [dateFrom, setDateFrom] = useState<string>(firstDayOfMonth());
  const [dateTo, setDateTo] = useState<string>(todayStr());
  const [q, setQ] = useState("");
  const [linked, setLinked] = useState<Linked>("all");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [topCustomersOpen, setTopCustomersOpen] = useState(false);

  // 서버 페이지네이션 — page/pageSize 를 React state 로 소유, 변경 시 API 재호출.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  // 필터 변경 시 1페이지로 리셋.
  const filterKey = `${kind}|${dateFrom}|${dateTo}|${q}|${linked}`;
  const lastFilterKeyRef = useRef(filterKey);
  if (lastFilterKeyRef.current !== filterKey) {
    lastFilterKeyRef.current = filterKey;
    if (page !== 1) setPage(1);
  }

  const { data: pageData } = useQuery<Page>({
    queryKey: ["tax-invoices", kind, dateFrom, dateTo, q, linked, page, pageSize],
    queryFn: async () =>
      (
        await api.get("/tax-invoices", {
          params: {
            kind,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            q: q.trim() || undefined,
            linked,
            page,
            page_size: pageSize,
          },
        })
      ).data,
    placeholderData: (prev) => prev, // 페이지 전환 시 깜빡임 방지.
  });

  const { data: summary = [] } = useQuery<Summary[]>({
    queryKey: ["tax-invoices-summary", dateFrom, dateTo],
    queryFn: async () =>
      (
        await api.get("/tax-invoices/summary", {
          params: { date_from: dateFrom || undefined, date_to: dateTo || undefined },
        })
      ).data,
  });

  const mySum = useMemo(
    () => summary.find((s) => s.kind === kind),
    [summary, kind],
  );

  const fetchM = useMutation({
    mutationFn: async () =>
      (await api.post("/tax-invoices/fetch", { catchup_days: 7 })).data as FetchRecord[],
    onSuccess: async (records) => {
      qc.invalidateQueries({ queryKey: ["tax-invoices"] });
      qc.invalidateQueries({ queryKey: ["tax-invoices-summary"] });
      const skipped = records.filter((r) => r.status === "SKIPPED").length;
      const failed = records.filter((r) => r.status === "FAILED").length;
      const total = records.reduce((a, r) => a + r.created_count + r.updated_count, 0);
      if (skipped === records.length) {
        await dialog.alert(
          "바로빌 크레덴셜이 아직 설정되지 않아 수집이 건너뛰어졌습니다.\n" +
            "Settings > 외부 연동 > 바로빌 섹션에서 CERTKEY/CORPNUM/UserID 를 입력 후 재시도.",
          { title: "수집 스킵" },
        );
        return;
      }
      await dialog.alert(
        `수집 완료 — 신규/갱신 ${total}건, 실패 ${failed}건, 스킵 ${skipped}건.\n자세한 내역은 [이력] 에서 확인.`,
      );
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "수집 실패", { title: "오류" });
    },
  });

  // 품목 백필 — list-API 시절 수집된 헤더-only row 들을 detail API 로 보강.
  // 1회 운영용. 최대 500건씩 처리하므로 데이터 많으면 여러 번 클릭.
  const backfillM = useMutation({
    mutationFn: async () =>
      (await api.post("/tax-invoices/backfill-items", null, { params: { limit: 500 } })).data as {
        candidates: number;
        filled: number;
        skipped: number;
        errors: number;
      },
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ["tax-invoices"] });
      qc.invalidateQueries({ queryKey: ["tax-invoice-detail"] });
      await dialog.alert(
        `품목 백필 완료 — 대상 ${r.candidates}건, 채움 ${r.filled}, 스킵 ${r.skipped}, 실패 ${r.errors}.`,
      );
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "백필 실패", { title: "오류" });
    },
  });

  const rows = pageData?.items ?? [];

  // 컬럼 정의는 안정적 identity 가 필수 — inline 생성 시 AG Grid 가
  // "getColDef on null" 예외를 throw 한다. `field` 가 없는 컬럼은 colId 명시.
  const columnDefs = useMemo<ColDef<TaxInvoice>[]>(
    () => [
      {
        field: "written_date",
        colId: "written_date",
        headerName: "작성일",
        valueFormatter: (p: any) => p.value || "—",
      },
      { field: "issue_date", headerName: "발행일", colId: "issue_date" },
      {
        field: "approval_no",
        headerName: "승인번호",
        colId: "approval_no",
        cellRenderer: (p: any) => (
          <button
            onClick={() => setDetailId(p.data.id)}
            className="font-mono text-primary hover:underline"
          >
            {p.value}
          </button>
        ),
      },
      {
        headerName: "상대방",
        colId: "counterparty",
        valueGetter: (p: any) => {
          const r: TaxInvoice = p.data;
          return r.kind === "SALES"
            ? r.buyer_name || r.buyer_biz_no
            : r.supplier_name || r.supplier_biz_no;
        },
      },
      {
        headerName: "사업자번호",
        colId: "counterparty_biz_no",
        valueGetter: (p: any) => {
          const r: TaxInvoice = p.data;
          return r.kind === "SALES" ? r.buyer_biz_no : r.supplier_biz_no;
        },
      },
      {
        field: "supply_amount",
        colId: "supply_amount",
        headerName: "공급가액",
        valueFormatter: (p: any) => KRW(p.value || 0),
        cellStyle: { textAlign: "right" } as any,
      },
      {
        field: "tax_amount",
        colId: "tax_amount",
        headerName: "부가세",
        valueFormatter: (p: any) => KRW(p.value || 0),
        cellStyle: { textAlign: "right" } as any,
      },
      {
        field: "total_amount",
        colId: "total_amount",
        headerName: "합계",
        valueFormatter: (p: any) => KRW(p.value || 0),
        cellStyle: { textAlign: "right", fontWeight: 500 } as any,
      },
      {
        headerName: "매칭 고객사",
        colId: "linked_customer_name",
        valueGetter: (p: any) =>
          p.data.linked_customer_name ? p.data.linked_customer_name : "—",
        width: 140,
      },
      {
        headerName: "매칭 프로젝트",
        colId: "linked_project_name",
        valueGetter: (p: any) =>
          p.data.linked_project_name ? p.data.linked_project_name : "—",
        width: 160,
      },
      {
        field: "memo",
        colId: "memo",
        headerName: "메모",
        width: 120,
        // 10자 초과 시 말줄임 — 그리드 폭을 크게 잡아먹지 않도록. 원문은 title
        // 속성(브라우저 기본 tooltip) 으로 hover 시 노출.
        cellRenderer: (p: any) => {
          const v: string | null = p.value ?? "";
          if (!v) return "";
          const short = v.length > 10 ? v.slice(0, 10) + "…" : v;
          return (
            <Tooltip label={v} side="top">
              <span>{short}</span>
            </Tooltip>
          );
        },
      },
      { field: "status", colId: "status", headerName: "상태" },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="전자세금계산서" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        {/* 매입/매출 토글 + 기간 + 검색 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <KindBtn active={kind === "PURCHASE"} onClick={() => setKind("PURCHASE")}>
              매입
            </KindBtn>
            <KindBtn active={kind === "SALES"} onClick={() => setKind("SALES")}>
              매출
            </KindBtn>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <DateInput value={dateFrom} onChange={setDateFrom} />
            <span className="text-muted-foreground">~</span>
            <DateInput value={dateTo} onChange={setDateTo} />
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="상호·사업자번호·승인번호 검색"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[220px]"
          />
          <select
            value={linked}
            onChange={(e) => setLinked(e.target.value as Linked)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">전체</option>
            <option value="matched">매칭됨</option>
            <option value="unmatched">미매칭</option>
          </select>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => fetchM.mutate()}
            disabled={fetchM.isPending}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <RefreshCw className={"h-4 w-4 " + (fetchM.isPending ? "animate-spin" : "")} />
            {fetchM.isPending ? "수집 중..." : "지금 수집"}
          </button>
          <button
            type="button"
            onClick={() => backfillM.mutate()}
            disabled={backfillM.isPending}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
            title="품목이 비어 있는 기존 row 를 바로빌 detail API 로 보강 (최대 500건/회)"
          >
            <Package className={"h-4 w-4 " + (backfillM.isPending ? "animate-spin" : "")} />
            {backfillM.isPending ? "백필 중..." : "품목 백필"}
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            이력
          </button>
          <button
            type="button"
            onClick={() => setTopCustomersOpen(true)}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            title="올해 매출처 상위 10 — 매출세금계산서 buyer_biz_no 기준"
          >
            <BarChart3 className="h-4 w-4" /> 매출처 집계
          </button>
        </div>

        {/* 요약 카드 */}
        {mySum && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <SummaryCard label="건수" value={String(mySum.count)} />
            <SummaryCard label="공급가액" value={KRW(mySum.supply_amount)} />
            <SummaryCard label="부가세" value={KRW(mySum.tax_amount)} />
            <SummaryCard label="합계" value={KRW(mySum.total_amount)} />
            <SummaryCard
              label="매칭"
              value={`${mySum.matched_customer_count} / ${mySum.count}`}
              sub="고객사 매칭"
            />
          </div>
        )}

        {/* 그리드 — 서버 페이지네이션. */}
        <DataGrid<TaxInvoice>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          onRowDoubleClicked={(r) => setDetailId(r.id)}
          hideSearch
          enableCheckbox={false}
          compact
          serverPagination={{
            page,
            pageSize,
            totalCount: pageData?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: (n) => {
              setPageSize(n);
              setPage(1);
            },
            pageSizeOptions: [20, 50, 100, 200, 500],
          }}
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "written_date",
              "issue_date",
              "counterparty_biz_no",
              "supply_amount",
              "tax_amount",
              "total_amount",
              "status",
            ],
          }}
        />
      </div>

      <TaxInvoiceDetailDialog
        invoiceId={detailId}
        onClose={() => setDetailId(null)}
      />

      {historyOpen && <FetchHistoryDialog onClose={() => setHistoryOpen(false)} />}
      {topCustomersOpen && (
        <TopCustomersDialog onClose={() => setTopCustomersOpen(false)} />
      )}
    </>
  );
}

function KindBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-9 px-4 text-sm " +
        (active
          ? "bg-primary text-primary-foreground"
          : "bg-background hover:bg-muted")
      }
    >
      {children}
    </button>
  );
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}


// ---------------------------------------------------------------------------
// 수집 이력 다이얼로그
// ---------------------------------------------------------------------------

function FetchHistoryDialog({ onClose }: { onClose: () => void }) {
  const { data: records = [] } = useQuery<FetchRecord[]>({
    queryKey: ["tax-invoice-fetches"],
    queryFn: async () => (await api.get("/tax-invoices/fetches")).data,
  });

  function formatDt(iso: string) {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="수집 이력"
      width="max-w-4xl"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          닫기
        </button>
      }
    >
      <div className="rounded-md border border-border overflow-auto max-h-[60vh]">
        <table className="w-full text-xs">
          <thead className="bg-muted/60">
            <tr>
              <th className="px-2 py-2 text-left">실행시각</th>
              <th className="px-2 py-2 text-left">방향</th>
              <th className="px-2 py-2 text-left">방식</th>
              <th className="px-2 py-2 text-left">기간</th>
              <th className="px-2 py-2 text-left">트리거</th>
              <th className="px-2 py-2 text-right">조회</th>
              <th className="px-2 py-2 text-right">신규</th>
              <th className="px-2 py-2 text-right">갱신</th>
              <th className="px-2 py-2 text-left">상태</th>
              <th className="px-2 py-2 text-left">오류</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-2 py-6 text-center text-muted-foreground">
                  수집 이력이 없습니다.
                </td>
              </tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} className="border-t border-border/60 tabular-nums">
                  <td className="px-2 py-1">{formatDt(r.started_at)}</td>
                  <td className="px-2 py-1">{r.kind}</td>
                  <td className="px-2 py-1">{r.method}</td>
                  <td className="px-2 py-1">
                    {r.period_start || ""}
                    {r.period_end && r.period_end !== r.period_start ? ` ~ ${r.period_end}` : ""}
                  </td>
                  <td className="px-2 py-1">{r.trigger_kind}</td>
                  <td className="px-2 py-1 text-right">{r.fetched_count}</td>
                  <td className="px-2 py-1 text-right text-emerald-600">{r.created_count}</td>
                  <td className="px-2 py-1 text-right text-amber-600">{r.updated_count}</td>
                  <td className="px-2 py-1">
                    <span
                      className={
                        r.status === "SUCCESS"
                          ? "text-emerald-600"
                          : r.status === "SKIPPED"
                            ? "text-muted-foreground"
                            : "text-destructive"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-destructive max-w-[280px] truncate">
                    {r.error_message || ""}
                    {r.error_message && <Tooltip label={r.error_message} side="top" inline />}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 매출처 집계 다이얼로그 — 올해 매출처 상위 10 파이 차트.
// ---------------------------------------------------------------------------

type SalesCustomerBucket = {
  biz_no: string | null;
  name: string | null;
  total_amount: number;
};
type SalesCustomerTop = {
  date_from: string;
  date_to: string;
  total_amount: number;
  items: SalesCustomerBucket[];
};

const PIE_COLORS = [
  "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#6366f1",
  "#06b6d4", "#84cc16", "#f97316", "#a855f7", "#14b8a6",
];

function TopCustomersDialog({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useQuery<SalesCustomerTop>({
    queryKey: ["tax-invoices", "sales-customers-top"],
    queryFn: async () =>
      (await api.get("/tax-invoices/sales-customers-top", { params: { limit: 10 } })).data,
  });

  const items = data?.items ?? [];
  const grandTotal = data?.total_amount ?? 0;
  const top10Sum = items.reduce((s, b) => s + b.total_amount, 0);
  const others = Math.max(0, grandTotal - top10Sum);

  const options: Highcharts.Options = {
    chart: {
      type: "pie",
      height: 380,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    tooltip: {
      useHTML: true,
      formatter() {
        const v = Number(this.y) || 0;
        const pct = grandTotal > 0 ? (v / grandTotal) * 100 : 0;
        const name = (this as any).point.name as string;
        return `<div style="font-size:11px"><b>${name}</b><br/>${v.toLocaleString()}원<br/>전체 매출 대비 <b>${pct.toFixed(1)}%</b></div>`;
      },
    },
    plotOptions: {
      pie: {
        innerSize: "45%",
        borderWidth: 0,
        dataLabels: {
          enabled: true,
          format: "{point.name}<br/>{point.percentage:.1f}%",
          style: { fontSize: "10px", color: "#334155", textOutline: "none" },
          distance: 12,
          filter: { property: "percentage", operator: ">", value: 2 },
        },
        showInLegend: true,
      },
    },
    legend: {
      enabled: true,
      align: "right",
      verticalAlign: "middle",
      layout: "vertical",
      itemStyle: { fontSize: "11px", color: "#334155" },
      itemMarginTop: 0,
      itemMarginBottom: 0,
      symbolHeight: 8,
      symbolWidth: 8,
      symbolRadius: 2,
      squareSymbol: true,
      itemDistance: 6,
    },
    series: [
      {
        type: "pie",
        data: [
          ...items.map((b, i) => ({
            name: b.name || b.biz_no || "(미지정)",
            y: b.total_amount,
            color: PIE_COLORS[i % PIE_COLORS.length],
          })),
          ...(others > 0
            ? [{ name: "기타", y: others, color: "#94a3b8" }]
            : []),
        ],
      },
    ],
  };

  return (
    <Dialog open onClose={onClose} title="매출처 집계" width="max-w-3xl">
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground">
          {data ? (
            <>
              기간 <b>{data.date_from}</b> ~ <b>{data.date_to}</b> · 전체 매출 합계{" "}
              <b className="tabular-nums">{Number(grandTotal).toLocaleString()}원</b>
            </>
          ) : (
            "로딩 중..."
          )}
        </div>
        {isLoading ? (
          <div className="h-[380px] flex items-center justify-center text-sm text-muted-foreground">
            데이터 불러오는 중...
          </div>
        ) : items.length === 0 ? (
          <div className="h-[380px] flex items-center justify-center text-sm text-muted-foreground">
            매출 데이터가 없습니다.
          </div>
        ) : (
          <>
            <HighchartsReact highcharts={Highcharts} options={options} />
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-2 py-1 text-left">순위</th>
                  <th className="px-2 py-1 text-left">매출처</th>
                  <th className="px-2 py-1 text-left">사업자번호</th>
                  <th className="px-2 py-1 text-right">금액</th>
                  <th className="px-2 py-1 text-right">비중</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b, i) => {
                  const pct = grandTotal > 0 ? (b.total_amount / grandTotal) * 100 : 0;
                  return (
                    <tr key={`${b.biz_no || "_unset"}-${i}`} className="border-b border-border/50">
                      <td className="px-2 py-1 tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1">{b.name || "(미지정)"}</td>
                      <td className="px-2 py-1 tabular-nums">{b.biz_no || "—"}</td>
                      <td className="px-2 py-1 tabular-nums text-right">
                        {Number(b.total_amount).toLocaleString()}
                      </td>
                      <td className="px-2 py-1 tabular-nums text-right">
                        {pct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Dialog>
  );
}
