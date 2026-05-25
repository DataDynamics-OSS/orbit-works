"use client";

/**
 * 매입/매출 현황 — 올해와 작년의 분기·월별 비교 대시보드.
 *
 * 데이터: `GET /tax-invoices/yearly-comparison?year=YYYY` (written_date 기준 공급가액 합계).
 * 권한: 메뉴 `tax_invoices.dashboard` (기본 SALES/HR).
 *
 * 차트 구성:
 *   - 상단 KPI 4: 올해 누적 매출·매입 + 전년 대비 증감률
 *   - 분기별 매출 4 (Q1~Q4) — 각 차트 작년/올해 2-bar
 *   - 분기별 매입 4 (Q1~Q4) — 동일
 *   - 월별 매출 1 — 12개월 grouped (작년 + 올해 series)
 *   - 월별 매입 1 — 동일
 *
 * 미래 월(올해 current month 이후) 은 올해 series 에서 `null` 로 표시 — 막대가
 * 안 그려져 추세 왜곡 방지. 작년 series 는 항상 12개월 full.
 *
 * URL 쿼리: `?year=2025` 로 비교 기준 연도 변경. 기본은 올해.
 */

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Highcharts from "@/lib/highcharts-init";
import HighchartsReact from "highcharts-react-official";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";


type Period = {
  period: number;
  sales_current: number;
  sales_prev: number;
  purchase_current: number;
  purchase_prev: number;
};

type Comparison = {
  year: number;
  prev_year: number;
  sales_current_total: number;
  sales_prev_total: number;
  purchase_current_total: number;
  purchase_prev_total: number;
  quarters: Period[];
  months: Period[];
};

const COLOR_PREV = "#94a3b8";    // slate-400 — 작년
const COLOR_SALES = "#10b981";   // emerald-500 — 올해 매출
const COLOR_PURCHASE = "#3b82f6"; // blue-500 — 올해 매입


// 한국식 통화 포맷 — y축 라벨용 (1.2억, 4,500만 등).
function fmtKoreanShort(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e8) {
    const eok = v / 1e8;
    return `${eok.toFixed(eok >= 10 ? 0 : 1)}억`;
  }
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}만`;
  return v.toLocaleString();
}

// tooltip 풀 표기 — 원 + 천단위 콤마.
function fmtKrwFull(v: number): string {
  return `${Math.round(v).toLocaleString()}원`;
}

// 증감률 (%). prev=0 인 경우 — current>0 면 N/A 대신 "신규" 처리.
function deltaPct(current: number, prev: number): string {
  if (prev === 0) return current > 0 ? "신규" : "—";
  const pct = ((current - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}


function KpiCard({
  title,
  value,
  sub,
  trend,
}: {
  title: string;
  value: string;
  sub?: string;
  trend?: { pct: string; positive: boolean };
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      {trend && (
        <div
          className={`mt-1 text-sm font-medium ${
            trend.positive ? "text-emerald-600" : "text-rose-600"
          }`}
        >
          {trend.pct}
        </div>
      )}
    </div>
  );
}


/**
 * 단일 비교 차트 (작년·올해 2-bar).
 * 분기 카드용 — 작고 단일 카테고리 ("Q1" 등 라벨 1개).
 */
function CompareBar({
  title,
  category,
  prevYear,
  curYear,
  prev,
  cur,
  curColor,
}: {
  title: string;
  category: string;
  prevYear: number;
  curYear: number;
  prev: number;
  cur: number;
  curColor: string;
}) {
  const options: Highcharts.Options = {
    chart: {
      type: "column",
      height: 200,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      categories: [category],
      labels: { style: { fontSize: "11px", color: "#64748b" } },
    },
    yAxis: {
      title: { text: undefined },
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          return fmtKoreanShort(Number(this.value));
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    legend: {
      enabled: true,
      itemStyle: { fontSize: "10px", fontWeight: "500", color: "#334155" },
    },
    tooltip: {
      useHTML: true,
      formatter() {
        return `<div style="font-size:11px;"><div style="margin-bottom:2px;font-weight:600;">${this.series.name}</div>${fmtKrwFull(Number(this.y))}</div>`;
      },
    },
    plotOptions: {
      column: {
        borderWidth: 0,
        pointPadding: 0.1,
        groupPadding: 0.15,
      },
    },
    series: [
      { type: "column", name: `${prevYear}`, color: COLOR_PREV, data: [prev] },
      { type: "column", name: `${curYear}`, color: curColor, data: [cur] },
    ],
  };
  const delta = deltaPct(cur, prev);
  const positive = !delta.startsWith("-");
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span
          className={`text-xs font-medium ${
            positive ? "text-emerald-600" : "text-rose-600"
          }`}
        >
          {delta}
        </span>
      </div>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}


/**
 * 월별 12개월 grouped bar — 작년 + 올해 두 series.
 * 미래 월의 `cur` 는 `null` 로 전달해 막대를 그리지 않음.
 */
function MonthlyCompareChart({
  title,
  prevYear,
  curYear,
  prev,
  cur,
  curColor,
}: {
  title: string;
  prevYear: number;
  curYear: number;
  prev: number[];        // 12 entries
  cur: (number | null)[]; // 12 entries (미래 월 null)
  curColor: string;
}) {
  const options: Highcharts.Options = {
    chart: {
      type: "column",
      height: 280,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      categories: Array.from({ length: 12 }, (_, i) => `${i + 1}월`),
      labels: { step: 1, style: { fontSize: "10px", color: "#64748b" } },
    },
    yAxis: {
      title: { text: undefined },
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          return fmtKoreanShort(Number(this.value));
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    legend: {
      enabled: true,
      itemStyle: { fontSize: "11px", fontWeight: "500", color: "#334155" },
    },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        const rows = (this.points ?? [])
          .map(
            (p) =>
              `<div><span style="color:${p.color}">●</span> ${p.series.name}: <b>${fmtKrwFull(Number(p.y))}</b></div>`,
          )
          .join("");
        return `<div style="font-size:11px;"><div style="margin-bottom:2px;font-weight:600;">${this.x}</div>${rows}</div>`;
      },
    },
    plotOptions: {
      column: {
        borderWidth: 0,
        pointPadding: 0.08,
        groupPadding: 0.12,
      },
    },
    series: [
      { type: "column", name: `${prevYear}`, color: COLOR_PREV, data: prev },
      { type: "column", name: `${curYear}`, color: curColor, data: cur },
    ],
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="font-semibold mb-2">{title}</h3>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}


export default function TaxInvoicesDashboardPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const today = new Date();
  const defaultYear = today.getFullYear();
  const year = Number(sp?.get("year")) || defaultYear;
  const isCurrentYear = year === defaultYear;
  // 미래 월 마스킹용 — 올해를 보는 경우만 마스크. 과거 연도면 전체 12개월 표시.
  const cutoffMonth = isCurrentYear ? today.getMonth() + 1 : 12;

  const { data, isLoading } = useQuery<Comparison>({
    queryKey: ["tax-invoices-yearly-comparison", year],
    queryFn: async () =>
      (await api.get("/tax-invoices/yearly-comparison", { params: { year } })).data,
    staleTime: 60_000,
  });

  // 월별 series — 올해는 cutoffMonth 이후 null.
  const monthlySales = useMemo(() => {
    if (!data) return { prev: Array(12).fill(0), cur: Array(12).fill(null) };
    return {
      prev: data.months.map((m) => m.sales_prev),
      cur: data.months.map((m) =>
        m.period <= cutoffMonth ? m.sales_current : null,
      ) as (number | null)[],
    };
  }, [data, cutoffMonth]);

  const monthlyPurchase = useMemo(() => {
    if (!data) return { prev: Array(12).fill(0), cur: Array(12).fill(null) };
    return {
      prev: data.months.map((m) => m.purchase_prev),
      cur: data.months.map((m) =>
        m.period <= cutoffMonth ? m.purchase_current : null,
      ) as (number | null)[],
    };
  }, [data, cutoffMonth]);

  function changeYear(y: number) {
    const params = new URLSearchParams(sp?.toString() ?? "");
    if (y === defaultYear) params.delete("year");
    else params.set("year", String(y));
    const qs = params.toString();
    router.push(`/tax-invoices/dashboard${qs ? `?${qs}` : ""}`);
  }

  // 연도 셀렉터 — 올해 ± 4년 정도.
  const yearOptions = useMemo(() => {
    const out: number[] = [];
    for (let y = defaultYear; y >= defaultYear - 4; y--) out.push(y);
    return out;
  }, [defaultYear]);

  return (
    <>
      <DashboardHeader
        title="매입/매출 현황"
        actions={
          <select
            value={year}
            onChange={(e) => changeYear(Number(e.target.value))}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}년 (vs {y - 1})
              </option>
            ))}
          </select>
        }
      />
      <div className="flex-1 overflow-auto px-4 py-4 space-y-6">
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground">집계 데이터 로딩 중...</p>
        ) : (
          <>
            {/* KPI 4 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                title={`${year}년 누적 매출`}
                value={fmtKrwFull(data.sales_current_total)}
                sub={`전년 ${fmtKrwFull(data.sales_prev_total)}`}
              />
              <KpiCard
                title="매출 전년 대비"
                value={deltaPct(data.sales_current_total, data.sales_prev_total)}
                sub={`증감 ${fmtKrwFull(data.sales_current_total - data.sales_prev_total)}`}
                trend={{
                  pct: deltaPct(data.sales_current_total, data.sales_prev_total),
                  positive:
                    data.sales_current_total - data.sales_prev_total >= 0,
                }}
              />
              <KpiCard
                title={`${year}년 누적 매입`}
                value={fmtKrwFull(data.purchase_current_total)}
                sub={`전년 ${fmtKrwFull(data.purchase_prev_total)}`}
              />
              <KpiCard
                title="매입 전년 대비"
                value={deltaPct(
                  data.purchase_current_total,
                  data.purchase_prev_total,
                )}
                sub={`증감 ${fmtKrwFull(data.purchase_current_total - data.purchase_prev_total)}`}
                trend={{
                  pct: deltaPct(
                    data.purchase_current_total,
                    data.purchase_prev_total,
                  ),
                  // 매입 증가는 통상 "긍정"이 아니지만 단순 부호로 표시.
                  positive:
                    data.purchase_current_total - data.purchase_prev_total <= 0,
                }}
              />
            </div>

            {/* 분기별 매출 4 */}
            <section>
              <h2 className="text-sm font-semibold mb-2 text-muted-foreground">
                분기별 매출 비교
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {data.quarters.map((q) => (
                  <CompareBar
                    key={`sales-q${q.period}`}
                    title={`${q.period}분기 매출`}
                    category={`Q${q.period}`}
                    prevYear={data.prev_year}
                    curYear={data.year}
                    prev={q.sales_prev}
                    cur={q.sales_current}
                    curColor={COLOR_SALES}
                  />
                ))}
              </div>
            </section>

            {/* 분기별 매입 4 */}
            <section>
              <h2 className="text-sm font-semibold mb-2 text-muted-foreground">
                분기별 매입 비교
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {data.quarters.map((q) => (
                  <CompareBar
                    key={`purchase-q${q.period}`}
                    title={`${q.period}분기 매입`}
                    category={`Q${q.period}`}
                    prevYear={data.prev_year}
                    curYear={data.year}
                    prev={q.purchase_prev}
                    cur={q.purchase_current}
                    curColor={COLOR_PURCHASE}
                  />
                ))}
              </div>
            </section>

            {/* 월별 매출 */}
            <MonthlyCompareChart
              title="월별 매출 비교"
              prevYear={data.prev_year}
              curYear={data.year}
              prev={monthlySales.prev}
              cur={monthlySales.cur}
              curColor={COLOR_SALES}
            />

            {/* 월별 매입 */}
            <MonthlyCompareChart
              title="월별 매입 비교"
              prevYear={data.prev_year}
              curYear={data.year}
              prev={monthlyPurchase.prev}
              cur={monthlyPurchase.cur}
              curColor={COLOR_PURCHASE}
            />
          </>
        )}
      </div>
    </>
  );
}
