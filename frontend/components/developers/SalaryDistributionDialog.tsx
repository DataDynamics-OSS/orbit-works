"use client";

/**
 * 연봉 분포 — FULL_TIME + ACTIVE 임직원의 직위 × 연차 × 연봉 산포도.
 *
 * X 축 = 총 경력 (career_months_at_hire + 입사 후 경과 개월) / 12, 단위 년.
 * Y 축 = 연봉 (만원, 1만 단위 콤마).
 * Series = 직위 (job_rank) 별 1 series — 색은 level ASC 로 옅음→진함 그라디언트.
 * Point = 임직원, dataLabel = 이름 (항상 노출).
 * plotLines = job_ranks.years 의 진급 연차 가이드 (PositionTenureDialog 와 동일).
 *
 * 권한: HR/ADMIN 만 진입 (parent 가 버튼 가드). canSeeSalary=false 면 빈 화면.
 *
 * v1: 단순 scatter. 추세선·이상치 강조는 v2.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import { Dialog } from "@/components/ui/Dialog";

const HighchartsReact = dynamic(
  () => import("highcharts-react-official").then((m) => m.default),
  { ssr: false },
);

// --------------------------------------------------------------------------
// 타입 / 입력
// --------------------------------------------------------------------------

type Dev = {
  id: string;
  name: string;
  employment_type?: string;
  status?: string;
  rank_id?: string | null;
  hire_date?: string | null;
  career_months_at_hire?: number | null;
  /** 백엔드가 HR/ADMIN 한정으로 채워주는 필드. 없으면 fallback salary. */
  latest_salary?: string | number | null;
  salary?: string | number | null;
};

type Rank = {
  id: string;
  name: string;
  level?: number | string;
  years?: number | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  devs: Dev[];
  ranks: Rank[];
  /** 권한 가드 — false 면 빈 안내 화면. */
  canSeeSalary: boolean;
};

// --------------------------------------------------------------------------
// 색 팔레트 — 직위 level ASC 로 옅음 → 진함. 직위가 10 종 넘으면 modulo.
// --------------------------------------------------------------------------

const RANK_PALETTE = [
  "#94a3b8",  // slate-400 (연구원 — 가장 옅음)
  "#64748b",  // slate-500 (주임)
  "#0891b2",  // cyan-600 (선임)
  "#0284c7",  // sky-600  (책임)
  "#2563eb",  // blue-600 (수석)
  "#4f46e5",  // indigo-600 (이사)
  "#7c3aed",  // violet-600 (상무)
  "#a21caf",  // fuchsia-700 (전무)
  "#be123c",  // rose-700 (부대표)
  "#9f1239",  // rose-800 (대표이사)
];

function colorOf(idx: number): string {
  return RANK_PALETTE[idx % RANK_PALETTE.length];
}

// --------------------------------------------------------------------------
// 유틸
// --------------------------------------------------------------------------

function monthsSince(iso: string | null | undefined, asOf: Date = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let months = (asOf.getFullYear() - d.getFullYear()) * 12 + (asOf.getMonth() - d.getMonth());
  if (asOf.getDate() < d.getDate()) months -= 1;
  return months >= 0 ? months : null;
}

function asNumber(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtKRW10k(manwon: number): string {
  // 만원 단위. ex) 5400 → "5,400"
  return manwon.toLocaleString("ko-KR");
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export function SalaryDistributionDialog({
  open,
  onClose,
  devs,
  ranks,
  canSeeSalary,
}: Props) {
  const [HC, setHC] = useState<any>(null);
  // 이름 표시 — 기본 OFF (이름이 너무 많으면 어수선). hover tooltip 으로 충분.
  const [showNames, setShowNames] = useState(false);

  useEffect(() => {
    if (!open || HC) return;
    let cancelled = false;
    (async () => {
      const Highcharts = (await import("@/lib/highcharts-init")).default;
      if (!cancelled) setHC(Highcharts);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, HC]);

  // 직위 정렬 — level ASC (낮은 → 높은). 색 매핑도 같은 순서.
  // '대표이사' 는 1인 직위라 분포 의미 약함 + 보안상 별도 → 차트에서 제외.
  const orderedRanks = useMemo(() => {
    const list = ranks.filter((r) => r.name !== "대표이사");
    list.sort((a, b) => Number(a.level ?? 0) - Number(b.level ?? 0));
    return list;
  }, [ranks]);

  const rankIndex = useMemo(() => {
    const m = new Map<string, number>();
    orderedRanks.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [orderedRanks]);

  // 데이터 빌드 — 직위별 series. 점 = (careerYears, salary 만원, name, rank).
  const { series, totalCount, salaryMax } = useMemo(() => {
    const today = new Date();
    const byRank = new Map<
      string,
      Array<{ x: number; y: number; name: string; rankName: string }>
    >();
    let n = 0;
    let yMax = 0;
    for (const d of devs) {
      if (
        d.employment_type !== "FULL_TIME" ||
        d.status !== "ACTIVE" ||
        !d.rank_id ||
        !rankIndex.has(d.rank_id)
      ) {
        continue;
      }
      const since = monthsSince(d.hire_date ?? null, today);
      if (since == null) continue;
      const careerYears = ((d.career_months_at_hire ?? 0) + since) / 12;
      const salaryRaw = asNumber(d.latest_salary ?? d.salary ?? null);
      if (salaryRaw == null) continue;
      const manwon = Math.round(salaryRaw / 10_000);
      if (manwon <= 0) continue;
      yMax = Math.max(yMax, manwon);
      const rank = orderedRanks.find((r) => r.id === d.rank_id);
      if (!rank) continue;
      const arr = byRank.get(d.rank_id) ?? [];
      arr.push({
        x: Number(careerYears.toFixed(1)),
        y: manwon,
        name: d.name,
        rankName: rank.name,
      });
      byRank.set(d.rank_id, arr);
      n += 1;
    }
    // series — orderedRanks 순서 유지 (legend 도 같은 순서).
    const out = orderedRanks
      .filter((r) => byRank.has(r.id))
      .map((r) => ({
        name: r.name,
        color: colorOf(rankIndex.get(r.id) ?? 0),
        data: byRank.get(r.id)!,
      }));
    return { series: out, totalCount: n, salaryMax: yMax };
  }, [devs, orderedRanks, rankIndex]);

  // X 축 max — 가장 큰 연차 + 약간의 여백.
  const xMax = useMemo(() => {
    let max = 0;
    for (const s of series) {
      for (const p of s.data) max = Math.max(max, p.x);
    }
    return Math.ceil(max + 1);
  }, [series]);

  const options = useMemo(() => {
    if (!HC) return null;
    return {
      chart: {
        type: "scatter",
        height: 560,
        backgroundColor: "transparent",
        zoomType: "xy",
      },
      title: { text: undefined },
      credits: { enabled: false },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(255,255,255,0.96)",
        borderColor: "#e2e8f0",
        borderRadius: 6,
        shadow: false,
        style: { color: "#0f172a", fontSize: "12px" },
        formatter: function (this: any) {
          const p = this.point;
          return (
            `<div style="font-weight:700;margin-bottom:2px;color:#0f172a">` +
            `${escapeHtml(p.name)}</div>` +
            `<div style="color:#64748b;font-size:11px">` +
            `${escapeHtml(p.rankName)} · 총 ${p.x.toFixed(1)}년 · ` +
            `<b style="color:#0f172a;font-variant-numeric:tabular-nums">` +
            `${fmtKRW10k(p.y)}만원</b>` +
            `</div>`
          );
        },
      },
      xAxis: {
        title: { text: "총 경력 (년)", style: { fontSize: "11px" } },
        min: 0,
        max: Math.max(xMax, 12),
        tickInterval: 1,
        gridLineWidth: 1,
        gridLineColor: "#f1f5f9",
        // 직위 진급 기준 연차 — Settings → 직위.years 의 동적 plotLines.
        plotLines: ranks
          .filter((r) => r.years != null && Number(r.years) > 0)
          .map((r) => ({ years: Number(r.years), name: r.name }))
          .sort((a, b) => a.years - b.years)
          .map(({ years, name }) => ({
            value: years,
            color: "#dc2626",
            dashStyle: "Dash",
            width: 1.5,
            zIndex: 4,
            label: {
              text: `${years}년 (${name})`,
              align: "left",
              verticalAlign: "top",
              x: 4,
              y: 12,
              style: { color: "#dc2626", fontSize: "10px", fontWeight: "600" },
            },
          })),
      },
      yAxis: {
        title: { text: "연봉 (만원)", style: { fontSize: "11px" } },
        min: 0,
        labels: {
          formatter: function (this: any) {
            return fmtKRW10k(this.value);
          },
          style: { fontSize: "10px" },
        },
        gridLineColor: "#f1f5f9",
      },
      legend: {
        enabled: true,
        align: "right",
        verticalAlign: "top",
        layout: "vertical",
        itemStyle: { fontSize: "11px" },
      },
      plotOptions: {
        scatter: {
          marker: {
            symbol: "circle",
            radius: 5,
            lineWidth: 1,
            lineColor: "#ffffff",
            states: {
              hover: { radiusPlus: 2, lineWidthPlus: 1 },
            },
          },
          dataLabels: {
            enabled: showNames,
            formatter: function (this: any) {
              return escapeHtml(this.point.name);
            },
            style: {
              fontSize: "10px",
              fontWeight: "500",
              color: "#0f172a",
              textOutline: "2px white",
            },
            y: -6,
            allowOverlap: false,
            crop: false,
            overflow: "allow",
          },
          // legend 클릭 시 시리즈 토글 (Highcharts 기본).
          stickyTracking: false,
        },
      },
      series,
    };
  }, [HC, series, xMax, ranks, showNames]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-6xl"
      title={
        <div className="flex items-center gap-2">
          <span>연봉 분포</span>
          <span className="text-[11px] text-muted-foreground font-normal">
            (정규직 · 재직 · {totalCount}명
            {salaryMax > 0 && ` · 최고 ${fmtKRW10k(salaryMax)}만원`})
          </span>
        </div>
      }
    >
      {!canSeeSalary ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          급여 정보 조회 권한이 없습니다 (HR/ADMIN 만).
        </div>
      ) : totalCount === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          표시할 데이터가 없습니다 (FULL_TIME · ACTIVE · 급여 정보 보유 직원 0명).
        </div>
      ) : !options ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          차트 로드 중…
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-2 px-2">
            <div className="text-[11px] text-muted-foreground">
              X = 총 경력 (년) · Y = 연봉 (만원). 빨간 점선 = Settings → 직위 의
              <b> 연차</b> 가이드. 점 hover 로 상세, 범례 클릭으로 직위 토글.
              대표이사 제외.
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showNames}
                onChange={(e) => setShowNames(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              이름 표시
            </label>
          </div>
          <HighchartsReact highcharts={HC} options={options} />
          <div className="text-[11px] text-rose-600 italic mt-2 px-2 text-right">
            * 사내 기밀 — 외부 공유 / 캡처 금지
          </div>
        </>
      )}
    </Dialog>
  );
}
