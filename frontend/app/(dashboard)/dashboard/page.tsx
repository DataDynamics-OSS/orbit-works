"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Tooltip } from "@/components/ui/Tooltip";
import { AnnouncementDashboardCards } from "@/components/announcements/AnnouncementDashboardCards";
import { PersonalCards } from "@/components/dashboard/PersonalCards";
import Highcharts from "@/lib/highcharts-init";
import HighchartsReact from "highcharts-react-official";

type KPI = {
  won_amount: string;
  won_amount_krw_native: string;
  won_amount_usd_native: string;
  won_amount_prev_year: string;
  open_pipeline: string;
  weighted_pipeline: string;
  current_month_cost: string;
  current_month_revenue: string;
  current_month_margin: string;
  expiring_licenses_30d_count: number;
};

type FunnelBucket = {
  stage: string;
  count: number;
  amount: string;
  weighted: string;
};

type UrgentOpportunity = {
  id: string;
  name: string;
  customer_name: string | null;
  expected_close_date: string;
  days_left: number;
  stage: string;
  amount: string;
  currency: "KRW" | "USD";
};

type ExpiringLicense = {
  id: string;
  product_name: string;
  customer_name: string | null;
  end_date: string;
  days_left: number;
  amount_krw: string | null;
};

type LossProject = {
  id: string;
  name: string;
  cost: string;
  revenue: string;
  profit: string;
};

type IdleEmployee = {
  id: string;
  name: string;
  tag: string | null; // 동명이인 구분 뱃지 (A/B/C...)
  employment_type: "FULL_TIME" | "FREELANCER" | "INSOURCED";
  title: string | null;
  phone: string | null;
  email: string | null; // 회사 이메일 우선, 없으면 개인 이메일
};

type Summary = {
  year: number;
  as_of: string;
  current_month: number;
  fx_rate: string | null;
  kpi: KPI;
  monthly_trend: {
    won: string[];
    lost: string[];
    cost: string[];
    revenue: string[];
    margin: string[];
    opportunities_count: number[];
    quotes_count: number[];
  };
  fx_trend: {
    window_start: string; // ISO date
    window_end: string; // ISO date
    points: { date: string; rate: string }[];
  };
  interest_trend: {
    window_start: string;
    window_end: string;
    series: {
      code: string;
      label: string;
      color: string;
      points: { date: string; rate: string }[];
    }[];
  };
  stock_trend_kr: {
    window_start: string;
    window_end: string;
    series: {
      code: string;
      label: string;
      color: string;
      points: { date: string; close: string }[];
    }[];
  };
  stock_trend_us: {
    window_start: string;
    window_end: string;
    series: {
      code: string;
      label: string;
      color: string;
      points: { date: string; close: string }[];
    }[];
  };
  funnel: FunnelBucket[];
  urgent_opportunities: UrgentOpportunity[];
  expiring_licenses: ExpiringLicense[];
  loss_projects: LossProject[];
  idle_employees: IdleEmployee[];
};

const STAGE_LABEL: Record<string, string> = {
  LEAD: "발굴",
  QUALIFIED: "검증",
  PROPOSAL: "제안",
  NEGOTIATION: "협상",
};

const STAGE_COLOR: Record<string, string> = {
  LEAD: "#64748b",
  QUALIFIED: "#0ea5e9",
  PROPOSAL: "#6366f1",
  NEGOTIATION: "#f59e0b",
};

const EMP_BADGE: Record<IdleEmployee["employment_type"], string> = {
  FULL_TIME: "bg-blue-100 text-blue-700 border-blue-200",
  FREELANCER: "bg-red-100 text-red-700 border-red-200",
  INSOURCED: "bg-orange-100 text-orange-700 border-orange-200",
};

const EMP_LABEL: Record<IdleEmployee["employment_type"], string> = {
  FULL_TIME: "정규직",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
};

function fmtKrw(v: string | number) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "-";
  return Math.round(n).toLocaleString() + "원";
}
function fmtSignedKrw(v: string | number) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "-";
  return (n < 0 ? "-" : "") + Math.abs(Math.round(n)).toLocaleString() + "원";
}
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

export default function DashboardPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);

  const { data: s } = useQuery<Summary>({
    queryKey: ["dashboard-summary", year],
    queryFn: async () =>
      (await api.get("/dashboard/summary", { params: { year } })).data,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // 비즈니스 운영 지표 — ADMIN/HR/SALES 만 노출. ETC (일반 임직원) 와
  // SUPPORT 는 환율/금리/주가 같은 중립 지표만 보임.
  // 게이트 대상:
  //   Row 1: 상단 KPI 5종 (수주 / 영업기회 / 원가 / 수익 / 만료 라이센스)
  //   Row 2: 영업 실적·수익성·펀넬 차트 3종
  //   Row 3: 누적 수주·영업기회·견적서 월별 차트 3종
  //   하단: 적자 프로젝트 / 마감 임박 영업기회 / 만료 임박 라이센스 /
  //         유휴 인력 / 오늘 신규 사업공고 / 북마크 임박 마감 카드
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const canSeeOpsCards =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SALES";

  return (
    <>
      <DashboardHeader
        title="대시보드"
        actions={
          <div className="flex gap-2 items-center">
            <button
              className="h-8 w-8 rounded-md border border-border bg-card shadow-sm text-sm"
              onClick={() => setYear((y) => y - 1)}
            >
              ◀
            </button>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <button
              className="h-8 w-8 rounded-md border border-border bg-card shadow-sm text-sm"
              onClick={() => setYear((y) => y + 1)}
            >
              ▶
            </button>
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {/* Row 1~3 — 비즈니스 운영 지표 (KPI + 영업 차트 + 월별 지표).
            ADMIN/HR/SALES 만 노출. ETC/SUPPORT 는 환율/금리/주가 같은
            중립 지표만 보임. */}
        {canSeeOpsCards && (
        <>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <WonKpi kpi={s?.kpi} year={year} />
          <Kpi
            label="진행중 영업기회"
            value={fmtKrw(s?.kpi.open_pipeline ?? 0)}
            sub={`확률 반영 ${fmtKrw(s?.kpi.weighted_pipeline ?? 0)}`}
          />
          <Kpi
            label={`${s?.current_month ?? "-"}월 예상 원가`}
            value={fmtKrw(s?.kpi.current_month_cost ?? 0)}
            color="text-slate-700"
          />
          <Kpi
            label={`${s?.current_month ?? "-"}월 예상 수익`}
            value={fmtSignedKrw(s?.kpi.current_month_margin ?? 0)}
            sub={`매출 ${fmtKrw(s?.kpi.current_month_revenue ?? 0)}`}
            color={
              Number(s?.kpi.current_month_margin ?? 0) < 0
                ? "text-red-600"
                : "text-emerald-700"
            }
          />
          <Link
            href="/licenses/calendar"
            className="rounded-lg border border-border bg-card p-4 shadow-sm hover:bg-muted/40 transition font-display"
          >
            <div className="text-sm text-muted-foreground">
              만료 임박 라이센스 (30일)
            </div>
            <div className="mt-1 text-2xl font-bold">
              {s?.kpi.expiring_licenses_30d_count ?? 0}건
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              클릭 시 연간 캘린더로 이동
            </div>
          </Link>
        </div>

        {/* Mid: trend charts + funnel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SalesTrendChart summary={s} />
          <ProjectProfitChart summary={s} />
          <FunnelCard funnel={s?.funnel} />
        </div>

        {/* Additional monthly metrics: 누적 수주금액 · 영업기회 · 견적서 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <CumulativeWonChart summary={s} />
          <OpportunitiesCountChart summary={s} />
          <QuotesCountChart summary={s} />
        </div>
        </>
        )}

        {/* 개인 카드 묶음 — 모든 임직원 (ETC 포함) 공통.
            연차/내 액션/결재/내 목표/다음 급여일 + 이번 주 일정 +
            생일자/휴일/출퇴근 + 최근 회의록/공지/회사 목표 진행률. */}
        <PersonalCards />

        {/* FX + Interest trend 병렬 배치 */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <FxTrendChart summary={s} />
          <InterestTrendChart summary={s} />
        </div>

        {/* KR + US 주가 추이 (같은 60일 창) */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <StockTrendChart
            title="국내 주가지수 추이 (최근 2개월)"
            subtitle="ECOS (한국은행) · KOSPI · KOSDAQ"
            emptyHint="Settings > 외부 연동 에서 ECOS API Key 를 활성·저장하세요."
            trend={s?.stock_trend_kr}
            loading={!s}
          />
          <StockTrendChart
            title="미국 주가지수 추이 (최근 2개월)"
            subtitle="FRED · S&P 500 · NASDAQ · Dow Jones"
            emptyHint="Settings > 외부 연동 에서 FRED API Key 를 활성·저장하세요."
            trend={s?.stock_trend_us}
            loading={!s}
          />
        </div>

        {/* Bottom: action lists — ADMIN/HR/SALES 만 노출. ETC/SUPPORT 는 차단. */}
        {canSeeOpsCards && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <UrgentList items={s?.urgent_opportunities ?? []} />
            <ExpiringList items={s?.expiring_licenses ?? []} />
            <LossList items={s?.loss_projects ?? []} />
            <IdleList items={s?.idle_employees ?? []} month={s?.current_month} />
            <AnnouncementDashboardCards />
          </div>
        )}
      </div>
    </>
  );
}

function Kpi({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  // font-display = Roboto Condensed → 좁은 폭으로 큰 숫자가 카드를 덜 차지.
  // Pretendard 본문이 카드 안에서 너무 펼쳐져 보이는 문제 해소.
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm font-display">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function WonKpi({ kpi, year }: { kpi?: KPI; year: number }) {
  const prev = Number(kpi?.won_amount_prev_year ?? 0);
  const curr = Number(kpi?.won_amount ?? 0);
  const deltaPct = prev > 0 ? ((curr - prev) / prev) * 100 : null;
  const deltaColor =
    deltaPct == null
      ? "text-muted-foreground"
      : deltaPct >= 0
        ? "text-emerald-700"
        : "text-red-600";
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm font-display">
      <div className="text-sm text-muted-foreground">{year}년 수주 금액</div>
      <div className="mt-1 text-2xl font-bold text-emerald-700 tabular-nums">
        {fmtKrw(kpi?.won_amount ?? 0)}
      </div>
      {Number(kpi?.won_amount_usd_native ?? 0) > 0 && (
        <div className="text-xs text-muted-foreground mt-1">
          KRW 합 {fmtMoney(kpi?.won_amount_krw_native ?? 0, "KRW")} · USD 합{" "}
          {fmtMoney(kpi?.won_amount_usd_native ?? 0, "USD")}
        </div>
      )}
      <div className={`text-xs mt-1 ${deltaColor}`}>
        전년 대비{" "}
        {deltaPct == null
          ? "-"
          : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`}
      </div>
    </div>
  );
}

// Highcharts 기반 월별 그룹 막대 차트. 이전 SVG 버전과 동일한 props 를 받도록 유지.
// `showLegend=false` 면 범례 숨김 (단순/콤팩트 차트 용).
function MultiBarChart({
  title,
  subtitle,
  series,
  showLegend = true,
}: {
  title: string;
  subtitle?: string;
  series: { label: string; color: string; values: (number | null)[] }[];
  showLegend?: boolean;
}) {
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);
  const options: Highcharts.Options = {
    chart: {
      type: "column",
      height: 240,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      categories: months,
      // 모든 월 라벨을 항상 표시 (Highcharts 기본 auto-skip 비활성).
      labels: { step: 1, style: { fontSize: "10px", color: "#64748b" } },
    },
    yAxis: {
      title: { text: undefined },
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          const v = Number(this.value);
          if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
          if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(0)}만`;
          return v.toLocaleString();
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    legend: {
      enabled: showLegend,
      itemStyle: { fontSize: "11px", fontWeight: "500", color: "#334155" },
    },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        const rows = (this.points ?? [])
          .map(
            (p) =>
              `<div><span style="color:${p.color}">●</span> ${p.series.name}: <b>${fmtSignedKrw(Number(p.y))}</b></div>`,
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
    series: series.map((s) => ({
      type: "column",
      name: s.label,
      color: s.color,
      data: s.values,
    })),
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
      <div className="mb-2">
        <h3 className="font-semibold">{title}</h3>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>
        )}
      </div>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}

function SalesTrendChart({ summary }: { summary?: Summary }) {
  if (!summary) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
        <h3 className="font-semibold mb-2">영업 실적 (월별)</h3>
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      </div>
    );
  }
  const won = summary.monthly_trend.won.map((v) => Number(v));
  const lost = summary.monthly_trend.lost.map((v) => Number(v));
  return (
    <MultiBarChart
      title="영업 실적 (월별)"
      subtitle="영업기회의 종료 월 기준 수주/실주"
      series={[
        { label: "수주", color: "#10b981", values: won },
        { label: "실주", color: "#ef4444", values: lost },
      ]}
    />
  );
}

function ProjectProfitChart({ summary }: { summary?: Summary }) {
  if (!summary) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
        <h3 className="font-semibold mb-2">프로젝트 수익성 (월별)</h3>
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      </div>
    );
  }
  const cost = summary.monthly_trend.cost.map((v) => Number(v));
  const revenue = summary.monthly_trend.revenue.map((v) => Number(v));
  const margin = summary.monthly_trend.margin.map((v) => Number(v));
  return (
    <MultiBarChart
      title="프로젝트 수익성 (월별)"
      subtitle="진행 프로젝트의 월 매출·원가·수익"
      series={[
        { label: "매출", color: "#0ea5e9", values: revenue },
        { label: "원가", color: "#64748b", values: cost },
        { label: "수익", color: "#6366f1", values: margin },
      ]}
    />
  );
}

// 월별 누적 수주 금액 — 1월부터 현재 월까지만 누적 합. 미래 월은 null 로 숨김.
function CumulativeWonChart({ summary }: { summary?: Summary }) {
  if (!summary) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
        <h3 className="font-semibold mb-2">월별 누적 수주금액</h3>
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      </div>
    );
  }
  const won = summary.monthly_trend.won.map((v) => Number(v));
  const cm = summary.current_month; // 1..12
  let acc = 0;
  const cumulative: (number | null)[] = won.map((v, i) => {
    if (i + 1 > cm) return null;
    acc += v;
    return acc;
  });
  return (
    <MultiBarChart
      title="월별 누적 수주금액"
      subtitle={`1월부터 ${cm}월까지 누적 WON (KRW 환산)`}
      series={[{ label: "누적 수주", color: "#059669", values: cumulative }]}
      showLegend={false}
    />
  );
}

// 건수 기반 월별 단일 막대 — 영업기회/견적서 등 count 타입 차트 공용.
function CountBarChart({
  title,
  subtitle,
  values,
  color,
  valueLabel,
}: {
  title: string;
  subtitle?: string;
  values: number[];
  color: string;
  valueLabel: string;
}) {
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);
  const options: Highcharts.Options = {
    chart: {
      type: "column",
      height: 240,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      categories: months,
      // 모든 월 라벨을 항상 표시 (Highcharts 기본 auto-skip 비활성).
      labels: { step: 1, style: { fontSize: "10px", color: "#64748b" } },
    },
    yAxis: {
      title: { text: undefined },
      allowDecimals: false,
      min: 0,
      labels: { style: { fontSize: "10px", color: "#64748b" } },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    legend: { enabled: false },
    tooltip: {
      useHTML: true,
      formatter() {
        return `<div style="font-size:11px;"><div style="font-weight:600;margin-bottom:2px;">${this.x}</div>${valueLabel}: <b>${Number(this.y).toLocaleString()}건</b></div>`;
      },
    },
    plotOptions: { column: { borderWidth: 0, color } },
    series: [{ type: "column", name: valueLabel, data: values }],
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
      <div className="mb-2">
        <h3 className="font-semibold">{title}</h3>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>
        )}
      </div>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}

function OpportunitiesCountChart({ summary }: { summary?: Summary }) {
  if (!summary) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
        <h3 className="font-semibold mb-2">월별 영업기회</h3>
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      </div>
    );
  }
  return (
    <CountBarChart
      title="월별 영업기회"
      subtitle="신규 발생 영업기회 건수 (created_at 기준)"
      values={summary.monthly_trend.opportunities_count}
      color="#6366f1"
      valueLabel="영업기회"
    />
  );
}

function QuotesCountChart({ summary }: { summary?: Summary }) {
  if (!summary) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
        <h3 className="font-semibold mb-2">견적서 발행 건수</h3>
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      </div>
    );
  }
  return (
    <CountBarChart
      title="견적서 발행 건수"
      subtitle="발행일(issue_date) 기준 월별 건수"
      values={summary.monthly_trend.quotes_count}
      color="#a855f7"
      valueLabel="견적서"
    />
  );
}

function FxTrendChart({ summary }: { summary?: Summary }) {
  const pts = summary?.fx_trend.points ?? [];
  const windowStart = summary?.fx_trend.window_start;
  const windowEnd = summary?.fx_trend.window_end;

  if (!summary || pts.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="font-semibold mb-2">USD/KRW 환율 추이 (최근 2개월)</h3>
        <p className="text-sm text-muted-foreground">
          {!summary ? "로딩 중..." : "환율 데이터가 없습니다."}
        </p>
      </div>
    );
  }

  const nums = pts.map((p) => Number(p.rate));
  const maxV = Math.max(...nums);
  const minV = Math.min(...nums);
  // 시계열상 실제 날짜 간격을 반영하기 위해 [timestamp, value] 쌍으로 전달.
  const data: [number, number][] = pts.map((p) => [
    new Date(`${p.date}T00:00:00`).getTime(),
    Number(p.rate),
  ]);
  const latest = pts[pts.length - 1];

  // Y축은 데이터 범위 기준으로 위·아래 패딩만 — 작은 변동도 잘 보이게.
  // 패딩이 0 이 되지 않도록 최소 1 KRW.
  // (이전: yMin=1000 고정 — 1300대 환율의 ±10 변동이 거의 평탄해 보임.)
  const range = maxV - minV;
  const pad = Math.max(1, range * 0.2);
  const yMin = Math.floor(minV - pad);
  const yMax = Math.ceil(maxV + pad);

  // 데이터가 sparse 해도 2개월 윈도우 전체가 X축에 보이도록 min/max 고정.
  const xMin = windowStart
    ? new Date(`${windowStart}T00:00:00`).getTime()
    : undefined;
  const xMax = windowEnd
    ? new Date(`${windowEnd}T00:00:00`).getTime()
    : undefined;
  const options: Highcharts.Options = {
    chart: {
      type: "column",
      height: 240,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      type: "datetime",
      min: xMin,
      max: xMax,
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        format: "{value:%m-%d}",
      },
      tickInterval: 7 * 24 * 3600 * 1000,
    },
    yAxis: {
      title: { text: undefined },
      min: yMin,
      max: yMax,
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          return Number(this.value).toLocaleString();
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    legend: {
      enabled: true,
      align: "right",
      verticalAlign: "top",
      floating: true,
      itemStyle: { fontSize: "10px", color: "#64748b", fontWeight: "500" },
      symbolRadius: 2,
    },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        const d = new Date(Number(this.x));
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const val = (this.points?.[0]?.y ?? this.y) as number;
        return `<div style="font-size:11px;"><div style="font-weight:600;margin-bottom:2px;">${iso}</div>${Math.round(val).toLocaleString()}원</div>`;
      },
    },
    plotOptions: {
      column: { borderWidth: 0, color: "#0ea5e9", pointPadding: 0.1 },
      spline: {
        color: "#f43f5e",
        lineWidth: 2,
        marker: { enabled: true, radius: 2.5, symbol: "circle" },
      },
    },
    series: [
      { type: "column", name: "일별 환율", data, color: "#0ea5e9" },
      {
        type: "spline",
        name: "추세",
        data,
        color: "#f43f5e",
        enableMouseTracking: false,
      },
    ],
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h3 className="font-semibold">USD/KRW 환율 추이 (최근 2개월)</h3>
          <div className="text-xs text-muted-foreground mt-0.5">
            {windowStart} ~ {windowEnd} · 일별 기록, 총 {pts.length}일
          </div>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          최고 {Math.round(maxV).toLocaleString()} · 최저{" "}
          {Math.round(minV).toLocaleString()}
          {latest && (
            <>
              {" "}
              · 최신 {Math.round(Number(latest.rate)).toLocaleString()} (
              {latest.date})
            </>
          )}
        </div>
      </div>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}

type StockTrend = {
  window_start: string;
  window_end: string;
  series: {
    code: string;
    label: string;
    color: string;
    points: { date: string; close: string }[];
  }[];
};

function StockTrendChart({
  title,
  subtitle,
  emptyHint,
  trend,
  loading,
}: {
  title: string;
  subtitle: string;
  emptyHint: string;
  trend?: StockTrend;
  loading: boolean;
}) {
  const seriesMeta = trend?.series ?? [];
  const hasAny = seriesMeta.some((s) => s.points.length > 0);

  if (loading || !hasAny) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="font-semibold mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground">
          {loading ? "로딩 중..." : emptyHint}
        </p>
      </div>
    );
  }

  // 시리즈마다 스케일이 크게 다를 수 있어 "윈도우 시작 대비 % 변화" 로 정규화 —
  // 한 축에 올려도 시각적으로 비교 가능. 절대값은 tooltip 에서 표시.
  const xMin = new Date(`${trend!.window_start}T00:00:00`).getTime();
  const xMax = new Date(`${trend!.window_end}T00:00:00`).getTime();

  const hcSeries: Highcharts.SeriesOptionsType[] = seriesMeta.map((s) => {
    const pts = s.points;
    const base = pts.length > 0 ? Number(pts[0].close) : 0;
    const data = pts.map((p) => {
      const v = Number(p.close);
      const pct = base > 0 ? ((v - base) / base) * 100 : 0;
      return {
        x: new Date(`${p.date}T00:00:00`).getTime(),
        y: pct,
        custom: { close: v },
      };
    });
    return {
      type: "line",
      name: s.label,
      color: s.color,
      data,
      marker: { enabled: false, symbol: "circle" },
      lineWidth: 1.5,
    };
  });

  const options: Highcharts.Options = {
    chart: {
      type: "line",
      height: 240,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      type: "datetime",
      min: xMin,
      max: xMax,
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        format: "{value:%m-%d}",
      },
      tickInterval: 7 * 24 * 3600 * 1000,
    },
    yAxis: {
      title: { text: undefined },
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          const v = Number(this.value);
          return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
      plotLines: [
        { value: 0, color: "rgba(100,116,139,0.4)", width: 1, zIndex: 1 },
      ],
    },
    legend: {
      enabled: true,
      align: "center",
      verticalAlign: "bottom",
      itemStyle: { fontSize: "10px", color: "#64748b", fontWeight: "500" },
      symbolRadius: 2,
    },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        const d = new Date(Number(this.x));
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const rows = (this.points ?? [])
          .map((p) => {
            const pct = Number(p.y);
            const close = (p as any).point?.custom?.close ?? 0;
            return `<div style="display:flex;justify-content:space-between;gap:12px;">
              <span style="color:${p.color};">● ${p.series.name}</span>
              <span style="font-variant-numeric:tabular-nums;">${Number(close).toLocaleString()} <span style="color:#64748b;">(${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</span></span>
            </div>`;
          })
          .join("");
        return `<div style="font-size:11px;"><div style="font-weight:600;margin-bottom:4px;">${iso}</div>${rows}</div>`;
      },
    },
    plotOptions: {
      line: { marker: { enabled: false } },
    },
    series: hcSeries,
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <div className="text-xs text-muted-foreground mt-0.5">
            {subtitle} · 시작일 대비 % 변화
          </div>
        </div>
      </div>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}

function InterestTrendChart({ summary }: { summary?: Summary }) {
  const trend = summary?.interest_trend;
  const windowStart = trend?.window_start;
  const windowEnd = trend?.window_end;
  const seriesMeta = trend?.series ?? [];
  const hasAny = seriesMeta.some((s) => s.points.length > 0);

  if (!summary || !hasAny) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="font-semibold mb-2">국내 금리 추이 (최근 2개월)</h3>
        <p className="text-sm text-muted-foreground">
          {!summary
            ? "로딩 중..."
            : "금리 데이터가 없습니다. Settings > 외부 연동 에서 ECOS API Key 를 활성·저장하세요."}
        </p>
      </div>
    );
  }

  // 6 시리즈 모두 % 단위라 단일 Y축 공유. 최고·최저 금리 ±여유로 축 범위 설정.
  const allValues = seriesMeta.flatMap((s) => s.points.map((p) => Number(p.rate)));
  const maxV = allValues.length ? Math.max(...allValues) : 5;
  const minV = allValues.length ? Math.min(...allValues) : 0;
  const pad = Math.max(0.2, (maxV - minV) * 0.15);
  const yMin = Math.max(0, Math.floor((minV - pad) * 10) / 10);
  const yMax = Math.ceil((maxV + pad) * 10) / 10;

  const xMin = windowStart
    ? new Date(`${windowStart}T00:00:00`).getTime()
    : undefined;
  const xMax = windowEnd
    ? new Date(`${windowEnd}T00:00:00`).getTime()
    : undefined;

  const hcSeries: Highcharts.SeriesOptionsType[] = seriesMeta.map((s) => ({
    type: "line",
    name: s.label,
    color: s.color,
    data: s.points.map((p) => [
      new Date(`${p.date}T00:00:00`).getTime(),
      Number(p.rate),
    ]) as [number, number][],
    marker: { enabled: false, symbol: "circle" },
    lineWidth: 1.5,
  }));

  const options: Highcharts.Options = {
    chart: {
      type: "line",
      height: 240,
      backgroundColor: "transparent",
      style: { fontFamily: "inherit" },
    },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      type: "datetime",
      min: xMin,
      max: xMax,
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        format: "{value:%m-%d}",
      },
      tickInterval: 7 * 24 * 3600 * 1000,
    },
    yAxis: {
      title: { text: undefined },
      min: yMin,
      max: yMax,
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          return `${Number(this.value).toFixed(1)}%`;
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
    },
    legend: {
      enabled: true,
      align: "center",
      verticalAlign: "bottom",
      itemStyle: { fontSize: "10px", color: "#64748b", fontWeight: "500" },
      symbolRadius: 2,
    },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        const d = new Date(Number(this.x));
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const rows = (this.points ?? [])
          .map(
            (p) =>
              `<div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:${p.color};">● ${p.series.name}</span><span style="font-variant-numeric:tabular-nums;">${Number(p.y).toFixed(3)}%</span></div>`,
          )
          .join("");
        return `<div style="font-size:11px;"><div style="font-weight:600;margin-bottom:4px;">${iso}</div>${rows}</div>`;
      },
    },
    plotOptions: {
      line: { marker: { enabled: false } },
    },
    series: hcSeries,
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h3 className="font-semibold">국내 금리 추이 (최근 2개월)</h3>
          <div className="text-xs text-muted-foreground mt-0.5">
            {windowStart} ~ {windowEnd} · ECOS (한국은행)
          </div>
        </div>
      </div>
      <HighchartsReact highcharts={Highcharts} options={options} />
    </div>
  );
}

function FunnelCard({ funnel }: { funnel?: FunnelBucket[] }) {
  const items = funnel ?? [];
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm h-full">
      <h3 className="font-semibold mb-3">단계별 영업기회</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">열린 영업기회가 없습니다.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="py-1.5 font-medium">단계</th>
              <th className="py-1.5 font-medium text-right">건수</th>
              <th className="py-1.5 font-medium text-right">금액</th>
              <th className="py-1.5 font-medium text-right">가중</th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.stage} className="border-b border-border/40 last:border-0">
                <td className="py-1.5">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{
                        backgroundColor: STAGE_COLOR[f.stage] ?? "#64748b",
                      }}
                    />
                    {STAGE_LABEL[f.stage] ?? f.stage}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{f.count}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtKrw(f.amount)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {fmtKrw(f.weighted)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UrgentList({ items }: { items: UrgentOpportunity[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="font-semibold mb-3">마감 임박 영업기회 (D-14)</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">없음</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {items.map((o) => (
            <li key={o.id} className="py-2 flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full`}
                style={{ backgroundColor: STAGE_COLOR[o.stage] ?? "#64748b" }}
              />
              <Link
                href={`/opportunities/${o.id}`}
                className="group/tt relative font-medium hover:underline truncate flex-1"
              >
                {o.name}
                <Tooltip label={o.name} side="top" inline />
              </Link>
              <span className="text-xs text-muted-foreground truncate max-w-[9rem]">
                {o.customer_name ?? "-"}
              </span>
              <span className="text-xs tabular-nums">
                {fmtMoney(o.amount, o.currency)}
              </span>
              <span
                className={`text-xs font-semibold ml-2 ${
                  o.days_left <= 3 ? "text-red-600" : "text-amber-600"
                }`}
              >
                D-{o.days_left}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExpiringList({ items }: { items: ExpiringLicense[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="font-semibold mb-3">만료 임박 라이센스 (30일 이내)</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">없음</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {items.map((l) => (
            <li key={l.id} className="py-2 flex items-center gap-2">
              <Link
                href={`/licenses/${l.id}`}
                className="group/tt relative font-medium hover:underline truncate flex-1"
              >
                {l.product_name}
                <Tooltip label={l.product_name} side="top" inline />
              </Link>
              <span className="text-xs text-muted-foreground truncate max-w-[9rem]">
                {l.customer_name ?? "-"}
              </span>
              <span className="text-xs text-muted-foreground">{l.end_date}</span>
              <span
                className={`text-xs font-semibold ml-2 ${
                  l.days_left <= 7 ? "text-red-600" : "text-amber-600"
                }`}
              >
                D-{l.days_left}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LossList({ items }: { items: LossProject[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="font-semibold mb-3">적자 프로젝트 (마진 {"<"} 0)</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">없음</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {items.map((p) => (
            <li key={p.id} className="py-2 flex items-center gap-2">
              <Link
                href={`/projects/${p.id}`}
                className="group/tt relative font-medium hover:underline truncate flex-1"
              >
                {p.name}
                <Tooltip label={p.name} side="top" inline />
              </Link>
              <span className="text-xs text-muted-foreground tabular-nums">
                매출 {fmtKrw(p.revenue)} / 원가 {fmtKrw(p.cost)}
              </span>
              <span className="text-xs font-semibold text-red-600 tabular-nums ml-2">
                {fmtSignedKrw(p.profit)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IdleList({
  items,
  month,
}: {
  items: IdleEmployee[];
  month?: number;
}) {
  // employment_type 별 그룹 — 정규직 → 프리랜서 → 자사화 순서로 표시. 빈 그룹은 생략.
  const ORDER: IdleEmployee["employment_type"][] = ["FULL_TIME", "FREELANCER", "INSOURCED"];
  const groups = ORDER.map((t) => ({
    type: t,
    items: items.filter((e) => e.employment_type === t),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{month ?? ""}월 유휴 인력</h3>
        {items.length > 0 && (
          <span className="text-xs text-muted-foreground">{items.length}명</span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">없음</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g, gi) => (
            <div
              key={g.type}
              className={gi > 0 ? "pt-3 border-t border-border/60" : ""}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {EMP_LABEL[g.type]}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground/70">
                  {g.items.length}명
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((e) => (
                  <Link
                    key={e.id}
                    href={`/employees/${e.id}`}
                    className={`group/tt relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium hover:brightness-95 transition ${EMP_BADGE[e.employment_type]}`}
                  >
                    <span>
                      {e.name}
                      {e.tag && (
                        <span className="ml-1 opacity-60 font-normal">
                          {e.tag}
                        </span>
                      )}
                    </span>
                    <Tooltip
                      label={
                        <div className="text-[11px] leading-snug min-w-[160px]">
                          <div className="font-semibold">
                            {e.name}
                            {e.tag ? ` ${e.tag}` : ""}
                          </div>
                          <div className="mt-0.5">
                            {EMP_LABEL[e.employment_type]}
                            {e.title ? ` · ${e.title}` : ""}
                          </div>
                          {(e.phone || e.email) && (
                            <div className="mt-1 pt-1 border-t border-border/50 space-y-0.5">
                              {e.phone && <div>📞 {e.phone}</div>}
                              {e.email && <div>✉ {e.email}</div>}
                            </div>
                          )}
                        </div>
                      }
                      side="top"
                      inline
                    />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
