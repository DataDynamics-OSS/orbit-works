"use client";

/**
 * 직위 × 총 경력 분포 — 정규직(FULL_TIME, 재직 중) Gantt-style 차트.
 *
 * 본 코드베이스 정의:
 *   직위 = developers.rank_id (job_ranks)
 *   직책 = developers.position_id (job_positions)
 *
 * Y axis  = 직위 카테고리, level 오름차순 (낮은 직위 = 아래, 높은 직위 = 위).
 * X axis  = 총 경력 (career_months_at_hire + 입사 후 경과 개월) / 12.
 *
 * 직위 row 별로:
 *   * 2명 이상 → [최소 ~ 최대 총 경력] 범위 가로 막대 (xrange).
 *   * 1명만   → 그 값 위치에 동그라미 점 (scatter) — 막대 부풀리는 대신 단일 점.
 *
 * 막대/점에 마우스를 올리면 tooltip 이 그 직위의 전체 인원을 리스트업한다 —
 * 이름 옆에 총 경력을 표기해 "연차 대비 직위가 맞는지" 한눈에 비교 가능.
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
};

type Rank = {
  id: string;
  name: string;
  level?: number | string;
  /** 진급 기준 연차 — Settings → 직위 에서 입력. NULL = 차트 가이드 라인 미표시. */
  years?: number | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  devs: Dev[];
  /** 직위 마스터 — id/name/level. level 오름차순으로 Y 카테고리 정렬. */
  ranks: Rank[];
};

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

type Member = {
  name: string;
  careerYears: number;
};

// --------------------------------------------------------------------------
// 컴포넌트
// --------------------------------------------------------------------------

export function PositionTenureDialog({ open, onClose, devs, ranks }: Props) {
  // Highcharts + xrange 모듈을 다이얼로그 첫 오픈 시점에만 동적 로드.
  const [HC, setHC] = useState<any>(null);
  useEffect(() => {
    if (!open || HC) return;
    (async () => {
      const m = await import("@/lib/highcharts-init");
      // xrange 모듈은 side-effect import — Highcharts 인스턴스에 자동 등록.
      await import("highcharts/modules/xrange");
      setHC(m.default);
    })();
  }, [open, HC]);

  // 직위 카테고리 — level 오름차순 (낮음 → 아래, 높음 → 위).
  const orderedRanks = useMemo(() => {
    return [...ranks].sort((a, b) => {
      const av = Number(a.level ?? 0);
      const bv = Number(b.level ?? 0);
      if (av !== bv) return av - bv;
      return a.name.localeCompare(b.name, "ko-KR");
    });
  }, [ranks]);
  const categories = useMemo(
    () => orderedRanks.map((p) => p.name),
    [orderedRanks],
  );
  const rankIndex = useMemo(() => {
    const m = new Map<string, number>();
    orderedRanks.forEach((p, i) => m.set(p.id, i));
    return m;
  }, [orderedRanks]);

  // 직위별 멤버 집계 → range / single 포인트 빌드.
  const { rangePoints, singlePoints, totalMembers } = useMemo(() => {
    const today = new Date();
    const buckets = new Map<number, Member[]>();
    for (const d of devs) {
      // FULL_TIME + ACTIVE 만. INACTIVE(비활성) 직원은 분포에서 제외.
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
      const yIdx = rankIndex.get(d.rank_id)!;
      const arr = buckets.get(yIdx) ?? [];
      arr.push({ name: d.name, careerYears });
      buckets.set(yIdx, arr);
    }
    const range: Array<{
      x: number; x2: number; y: number;
      low: number; high: number; count: number; members: Member[];
    }> = [];
    const single: Array<{
      x: number; y: number;
      members: Member[]; // 길이 1
    }> = [];
    let n = 0;
    for (const [yIdx, members] of buckets) {
      members.sort((a, b) => b.careerYears - a.careerYears); // 시니어 우선
      n += members.length;
      if (members.length === 1) {
        single.push({ x: members[0].careerYears, y: yIdx, members });
        continue;
      }
      const min = Math.min(...members.map((m) => m.careerYears));
      const max = Math.max(...members.map((m) => m.careerYears));
      range.push({
        x: min, x2: max, y: yIdx,
        low: min, high: max, count: members.length, members,
      });
    }
    return { rangePoints: range, singlePoints: single, totalMembers: n };
  }, [devs, rankIndex]);

  // 차트 높이는 카테고리 수에 비례하되 최소 320px.
  const chartHeight = Math.max(320, 60 + categories.length * 44);

  // X 축 max — 가장 큰 총 경력 + 약간의 여백.
  const xMax = useMemo(() => {
    const xs = [
      ...rangePoints.map((p) => p.x2),
      ...singlePoints.map((p) => p.x),
    ];
    if (xs.length === 0) return 10;
    return Math.ceil(Math.max(...xs) + 1);
  }, [rangePoints, singlePoints]);

  const options = useMemo(() => {
    if (!HC) return null;
    // 두 시리즈 공통 tooltip 포맷 — 직위명 + 멤버 리스트.
    const tooltipFormatter = function (this: any) {
      const p = this.point;
      const positionName = categories[p.y] ?? "";
      const members = p.members as Member[];
      const isRange = typeof p.x2 === "number";
      const summary = isRange
        ? `최소 ${p.low.toFixed(1)}년 · 최대 ${p.high.toFixed(1)}년`
        : `1명`;
      const rows = members
        .map(
          (m) =>
            `<div style="display:flex;justify-content:space-between;gap:12px">` +
            `<span style="font-weight:600">${escapeHtml(m.name)}</span>` +
            `<span style="color:#64748b;font-variant-numeric:tabular-nums">` +
            `총 ${m.careerYears.toFixed(1)}년</span></div>`,
        )
        .join("");
      return (
        `<div style="font-weight:700;margin-bottom:4px;color:#0f172a">` +
        `${escapeHtml(positionName)} ` +
        `<span style="color:#64748b;font-weight:500">(${members.length}명)</span>` +
        `</div>` +
        `<div style="font-size:10px;color:#64748b;margin-bottom:4px">${summary}</div>` +
        rows
      );
    };

    return {
      chart: { type: "xrange", height: chartHeight, backgroundColor: "transparent" },
      title: { text: "" },
      credits: { enabled: false },
      legend: { enabled: false },
      xAxis: {
        title: { text: "총 경력 (년)", style: { fontSize: "11px" } },
        min: 0,
        max: xMax,
        labels: { format: "{value}년", style: { fontSize: "11px" } },
        gridLineWidth: 1,
        gridLineColor: "#f1f5f9",
        // 직위 변경 기준선 — Settings → 직위 의 'years' 컬럼이 채워진 row 만.
        // 빈 값이면 라인 미표시. 오름차순 정렬, 같은 값 중복은 그대로 그림.
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
        title: { text: "" },
        categories,
        reversed: false,
        gridLineColor: "#e2e8f0",
        labels: { style: { fontSize: "11px", fontWeight: "600" } },
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(255,255,255,0.97)",
        borderColor: "#cbd5e1",
        borderRadius: 6,
        shadow: true,
        style: { fontSize: "11px" },
        formatter: tooltipFormatter,
      },
      plotOptions: {
        xrange: {
          // 어두운 글자(검정·네이비)와 대비가 좋도록 밝은 파스텔 블루 채움 +
          // 진한 테두리로 막대 경계 유지.
          color: "#bfdbfe",        // tailwind blue-200
          borderColor: "#2563eb",  // tailwind blue-600
          borderWidth: 1,
          borderRadius: 4,
          pointPadding: 0.15,
          groupPadding: 0.05,
          dataLabels: {
            enabled: true,
            // 막대 우측 바깥, 5px 간격, 막대 세로 중앙에 "N명" 표기.
            formatter(this: any) {
              return `${this.point.count}명`;
            },
            style: { fontSize: "10px", fontWeight: "600", textOutline: "none", color: "#1e3a8a" },
            inside: false,
            align: "right",
            verticalAlign: "middle",
            x: 25,
            y: 0,
            overflow: "allow",
            crop: false,
          },
        },
        scatter: {
          marker: {
            symbol: "circle",
            radius: 6,
            fillColor: "#3b82f6",
            lineColor: "#1d4ed8",
            lineWidth: 1.5,
            states: { hover: { radius: 8 } },
          },
        },
      },
      series: [
        {
          type: "xrange",
          name: "총 경력 범위",
          data: rangePoints,
        },
        {
          type: "scatter",
          name: "1명 직위",
          data: singlePoints,
        },
      ],
    };
  }, [HC, chartHeight, categories, rangePoints, singlePoints, xMax, ranks]);

  return (
    <Dialog open={open} onClose={onClose} title="직위별 총 경력 분포" width="max-w-5xl">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          정규직(FULL_TIME, 재직 중) 의 직위 × 총 경력. 같은 직위에 2명 이상이면
          [최소 ~ 최대 총 경력] 가로 막대, 1명이면 동그라미 점으로 표시합니다.
          마우스를 올리면 해당 직위 인원의 이름과 총 경력을 함께 보여줍니다.
          직위 정렬은 마스터 level 오름차순 (낮은 직위 = 아래).
        </p>
        {!HC ? (
          <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
            차트 로딩…
          </div>
        ) : rangePoints.length + singlePoints.length === 0 ? (
          <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
            정규직 + 직위 + 입사일이 모두 입력된 인원이 없습니다.
          </div>
        ) : (
          <HighchartsReact highcharts={HC} options={options} />
        )}
        <div className="text-[11px] text-muted-foreground">
          표시 인원 {totalMembers}명 · 직위{" "}
          {rangePoints.length + singlePoints.length}종 (다인 {rangePoints.length}{" "}
          / 단일 {singlePoints.length})
        </div>
      </div>
    </Dialog>
  );
}

// 간단한 HTML escape — Highcharts useHTML tooltip 에 사용자 입력이 들어가기 때문.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
