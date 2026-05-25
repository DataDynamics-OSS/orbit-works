"use client";

/**
 * 임직원 평가 PDF 인쇄용 페이지 — 사이드바 없는 별도 라우트.
 *
 * 사용처: evaluations 페이지 "전체/주기 관리" 의 PDF 출력 다이얼로그가 새 창
 * 으로 이 페이지를 연다.
 * Query:
 *   - cycle = cycle_id (헤더 표시용)
 *   - ids   = comma-sep evaluation ids (출력 대상)
 *
 * 표시: 직위(rank_sort_order desc) 순 + 이름순. 각 평가가 1 페이지로 깨끗하게
 * 분리되도록 @media print 에 page-break-after.
 *
 * PDF 저장은 브라우저 print → "PDF 로 저장" 사용. @media print 가 컨트롤 바를
 * 숨겨 깔끔한 출력.
 */

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { FileText, Printer } from "lucide-react";

import { api } from "@/lib/api";

type Grade = "S" | "A" | "B" | "C" | "D";

type Comp = {
  dimension_key: string;
  self_score: number | null;
  manager_score: number | null;
  final_score: number | null;
  self_comment: string | null;
  manager_comment: string | null;
  final_comment: string | null;
};

type EvalDetail = {
  id: string;
  cycle_id: string;
  developer_id: string;
  developer_name: string | null;
  manager_name: string | null;
  final_grade: Grade | null;
  final_overall_score: number | string | null;
  competency_avg_self: number | string | null;
  competency_avg_manager: number | string | null;
  competency_avg_final: number | string | null;
  // 종합평가 — 본인·매니저·조정자(HR) 가 평가 전체에 대해 남긴 commentary.
  self_narrative: string | null;
  manager_narrative: string | null;
  calibration_note: string | null;
  competencies: Comp[];
};

type Dimension = { key: string; label: string; sort_order: number };
type Cycle = { id: string; year: number; period: string; name: string };
type DevLite = {
  id: string;
  name: string | null;
  rank_id: string | null;
  rank_name: string | null;
  rank_sort_order: number | null;
};

const GRADE_COLOR: Record<Grade, string> = {
  S: "bg-purple-600 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-blue-600 text-white",
  C: "bg-amber-600 text-white",
  D: "bg-red-600 text-white",
};

const SCORE_COLOR: Record<number, string> = {
  1: "bg-red-600",
  2: "bg-orange-500",
  3: "bg-yellow-500",
  4: "bg-sky-500",
  5: "bg-emerald-600",
};

function ScoreBar({ score }: { score: number | null }) {
  const n = score && score >= 1 && score <= 5 ? Math.round(score) : 0;
  const color = score ? SCORE_COLOR[n] ?? "bg-slate-300" : "bg-slate-200";
  return (
    <div className="flex gap-0.5 flex-1 max-w-[120px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={"h-2 flex-1 rounded-sm " + (i <= n ? color : "bg-slate-100")}
        />
      ))}
    </div>
  );
}

// Next.js 정적 prerender 가 useSearchParams 못 읽어 빌드 실패를 막기 위한 wrap.
export default function EvaluationsPrintPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">불러오는 중…</div>}>
      <PrintPageInner />
    </Suspense>
  );
}

function PrintPageInner() {
  const params = useSearchParams();
  const cycleId = params.get("cycle") ?? "";
  const idsParam = params.get("ids") ?? "";

  // bulk 응답.
  const { data: details = [], isLoading } = useQuery<EvalDetail[]>({
    queryKey: ["evaluations-print", cycleId, idsParam],
    queryFn: async () =>
      (
        await api.get("/evaluations/bulk", {
          params: { ids: idsParam },
        })
      ).data,
    enabled: !!idsParam,
  });

  // 직위·이름 정렬용 — list 응답에서 가져오기. (bulk 가 detail 만 반환)
  const { data: listRows = [] } = useQuery<
    Array<{
      id: string;
      developer_id: string;
      developer_name: string | null;
      rank_id: string | null;
      rank_name: string | null;
      rank_sort_order: number | null;
    }>
  >({
    queryKey: ["evaluations-print-list", cycleId],
    queryFn: async () =>
      (
        await api.get("/evaluations", {
          params: { owner: "all", cycle_id: cycleId },
        })
      ).data,
    enabled: !!cycleId,
  });

  // dimension key → label/sort_order 매핑.
  const { data: dimensions = [] } = useQuery<Dimension[]>({
    queryKey: ["evals", "dimensions"],
    queryFn: async () => (await api.get("/evaluations/dimensions")).data,
    staleTime: 5 * 60_000,
  });
  const dimMap = useMemo(() => {
    const m: Record<string, { label: string; sort_order: number }> = {};
    for (const d of dimensions) m[d.key] = { label: d.label, sort_order: d.sort_order };
    return m;
  }, [dimensions]);

  // 헤더 표시용 cycle 정보.
  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["evals", "cycles"],
    queryFn: async () => (await api.get("/evaluations/cycles")).data,
    staleTime: 60_000,
  });
  const cycle = cycles.find((c) => c.id === cycleId);

  // detail + list 결합 (rank 정보) + 정렬.
  const sorted = useMemo(() => {
    const rankByDev: Record<string, DevLite> = {};
    for (const r of listRows) {
      rankByDev[r.developer_id] = {
        id: r.developer_id,
        name: r.developer_name,
        rank_id: r.rank_id,
        rank_name: r.rank_name,
        rank_sort_order: r.rank_sort_order,
      };
    }
    const merged = details.map((d) => ({
      detail: d,
      dev: rankByDev[d.developer_id] ?? {
        id: d.developer_id,
        name: d.developer_name,
        rank_id: null,
        rank_name: null,
        rank_sort_order: null,
      },
    }));
    merged.sort((a, b) => {
      const aOrd = a.dev.rank_sort_order ?? Number.MAX_SAFE_INTEGER;
      const bOrd = b.dev.rank_sort_order ?? Number.MAX_SAFE_INTEGER;
      const aNull = a.dev.rank_id === null;
      const bNull = b.dev.rank_id === null;
      // NULL 그룹은 맨 뒤.
      if (aNull && !bNull) return 1;
      if (!aNull && bNull) return -1;
      // 직위 desc — 상위 직위부터.
      if (aOrd !== bOrd) return bOrd - aOrd;
      // 같은 직위 안에서는 이름 가나다순.
      return (a.dev.name ?? "").localeCompare(b.dev.name ?? "", "ko");
    });
    return merged;
  }, [details, listRows]);

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <style jsx global>{`
        /* 인쇄 시 — 컨트롤 바 숨김 + 직원 카드 사이 페이지 분리. */
        @media print {
          .no-print { display: none !important; }
          .eval-card {
            page-break-after: always;
            break-after: page;
          }
          .eval-card:last-child {
            page-break-after: auto;
            break-after: auto;
          }
          @page { margin: 12mm; }
          body { background: #fff; }
        }
      `}</style>

      {/* 컨트롤 바 — 인쇄에서는 숨김 */}
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-white px-6 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-base font-semibold">
            임직원 평가 — {cycle ? `${cycle.year} ${cycle.period}` : "—"}
          </h1>
          <span className="text-xs text-muted-foreground">
            · {sorted.length} 명
          </span>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={sorted.length === 0}
          className="h-8 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Printer className="h-4 w-4" />
          PDF 로 인쇄
        </button>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 flex flex-col gap-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        ) : sorted.length === 0 ? (
          <div className="text-sm text-muted-foreground italic">
            선택된 평가가 없습니다.
          </div>
        ) : (
          sorted.map(({ detail, dev }) => (
            <article
              key={detail.id}
              className="eval-card rounded-md border border-slate-300 bg-white p-6 flex flex-col gap-4"
            >
              {/* 카드 헤더 — 이름 / 직위 / 매니저 / 등급 */}
              <header className="flex items-start justify-between gap-4 pb-3 border-b border-slate-200">
                <div className="flex flex-col gap-0.5">
                  <div className="text-xl font-bold">
                    {dev.name ?? "(이름 없음)"}
                    {dev.rank_name && (
                      <span className="ml-2 text-sm font-normal text-slate-500">
                        {dev.rank_name}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    매니저 {detail.manager_name ?? "—"}
                    {cycle && ` · ${cycle.year} ${cycle.period}`}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end text-xs text-slate-600 gap-0.5">
                    <span>
                      자기평가{" "}
                      <b className="tabular-nums">
                        {detail.competency_avg_self !== null
                          ? Number(detail.competency_avg_self).toFixed(2)
                          : "—"}
                      </b>
                    </span>
                    <span>
                      매니저{" "}
                      <b className="tabular-nums">
                        {detail.competency_avg_manager !== null
                          ? Number(detail.competency_avg_manager).toFixed(2)
                          : "—"}
                      </b>
                    </span>
                    {detail.final_overall_score !== null && (
                      <span>
                        최종{" "}
                        <b className="tabular-nums">
                          {Number(detail.final_overall_score).toFixed(2)}
                        </b>
                      </span>
                    )}
                  </div>
                  {detail.final_grade && (
                    <span
                      className={
                        "inline-flex items-center justify-center w-14 h-14 rounded-md text-2xl font-bold " +
                        GRADE_COLOR[detail.final_grade]
                      }
                    >
                      {detail.final_grade}
                    </span>
                  )}
                </div>
              </header>

              {/* 종합평가 — 평균 점수 + commentary 를 한 테이블로 정렬. */}
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-bold text-slate-700">종합평가</h2>
                <table className="w-full border-collapse text-sm eval-table">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border border-slate-300 px-3 py-2 text-center align-middle w-28">구분</th>
                      <th className="border border-slate-300 px-3 py-2 text-center align-middle w-24">평균 점수</th>
                      <th className="border border-slate-300 px-3 py-2 text-left align-middle">종합 코멘트</th>
                    </tr>
                  </thead>
                  <tbody>
                    <OverallRow
                      label="자기평가"
                      avg={detail.competency_avg_self}
                      body={detail.self_narrative}
                    />
                    <OverallRow
                      label="매니저"
                      avg={detail.competency_avg_manager}
                      body={detail.manager_narrative}
                    />
                    <OverallRow
                      label="최종 (조정)"
                      avg={detail.final_overall_score ?? detail.competency_avg_final}
                      body={detail.calibration_note}
                      grade={detail.final_grade}
                    />
                  </tbody>
                </table>
              </section>

              {/* 각 항목별 평가 — dimension × (자기/매니저/최종) 매트릭스 테이블. */}
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-bold text-slate-700">각 항목별 평가</h2>
                {detail.competencies.length === 0 ? (
                  <div className="text-xs text-slate-500 italic">
                    평가 항목이 없습니다.
                  </div>
                ) : (
                  <table className="w-full border-collapse text-sm eval-table">
                    <thead>
                      <tr className="bg-slate-100 text-slate-700">
                        <th className="border border-slate-300 px-3 py-2 text-center align-middle w-36">평가 항목</th>
                        <th className="border border-slate-300 px-3 py-2 text-center align-middle w-24">구분</th>
                        <th className="border border-slate-300 px-3 py-2 text-center align-middle w-16">점수</th>
                        <th className="border border-slate-300 px-3 py-2 text-left align-middle">코멘트</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...detail.competencies]
                        .sort((a, b) => {
                          const ao = dimMap[a.dimension_key]?.sort_order ?? 9999;
                          const bo = dimMap[b.dimension_key]?.sort_order ?? 9999;
                          return ao - bo;
                        })
                        .map((c) => {
                          const label = dimMap[c.dimension_key]?.label ?? c.dimension_key;
                          return (
                            <CompetencyRows
                              key={c.dimension_key}
                              dimLabel={label}
                              comp={c}
                            />
                          );
                        })}
                    </tbody>
                  </table>
                )}
              </section>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

/** 1~5 점수에 따라 cell 배경색 매핑 — 인쇄 시에도 차이가 보이도록 옅은 톤. */
const SCORE_CELL_BG: Record<number, string> = {
  1: "bg-red-50",
  2: "bg-orange-50",
  3: "bg-yellow-50",
  4: "bg-sky-50",
  5: "bg-emerald-50",
};

function scoreCellClass(score: number | null): string {
  if (score == null) return "";
  const n = Math.round(score);
  return SCORE_CELL_BG[n] ?? "";
}

/** 종합평가 한 row — 구분 / 평균 점수 / 코멘트. grade 가 있으면 점수 옆에 배지. */
function OverallRow({
  label,
  avg,
  body,
  grade,
}: {
  label: string;
  avg: number | string | null;
  body: string | null;
  grade?: Grade | null;
}) {
  const num = avg != null ? Number(avg) : null;
  return (
    <tr>
      <th className="border border-slate-300 bg-slate-50 px-3 py-2 text-center align-middle font-medium text-slate-700">
        {label}
      </th>
      <td
        className={
          "border border-slate-300 px-3 py-2 text-center tabular-nums " +
          (num != null ? scoreCellClass(num) : "")
        }
      >
        <div className="flex items-center justify-center gap-1.5">
          <span className="font-semibold">{num != null ? num.toFixed(2) : "—"}</span>
          {grade && (
            <span
              className={
                "inline-flex items-center justify-center w-5 h-5 rounded text-[11px] font-bold " +
                GRADE_COLOR[grade]
              }
            >
              {grade}
            </span>
          )}
        </div>
      </td>
      <td className="border border-slate-300 px-3 py-2 align-top whitespace-pre-wrap text-slate-800">
        {body || <span className="text-slate-400 italic">—</span>}
      </td>
    </tr>
  );
}

/** 한 dimension 의 세 행 (자기/매니저/최종) — 첫 컬럼은 rowSpan=3 으로 dimension 명. */
function CompetencyRows({
  dimLabel,
  comp,
}: {
  dimLabel: string;
  comp: Comp;
}) {
  const rows: Array<{ label: string; score: number | null; comment: string | null }> = [
    { label: "자기평가", score: comp.self_score, comment: comp.self_comment },
    { label: "매니저",   score: comp.manager_score, comment: comp.manager_comment },
    { label: "최종",     score: comp.final_score, comment: comp.final_comment },
  ];
  return (
    <>
      {rows.map((r, i) => (
        <tr key={r.label}>
          {i === 0 && (
            <th
              rowSpan={3}
              className="border border-slate-300 bg-slate-50 px-3 py-2 text-center align-middle font-semibold text-slate-800"
            >
              {dimLabel}
            </th>
          )}
          <th className="border border-slate-300 bg-slate-50/60 px-3 py-2 text-center align-middle font-medium text-slate-700">
            {r.label}
          </th>
          <td
            className={
              "border border-slate-300 px-3 py-2 text-center tabular-nums " +
              scoreCellClass(r.score)
            }
          >
            {r.score ?? "—"}
          </td>
          <td className="border border-slate-300 px-3 py-2 align-top whitespace-pre-wrap text-slate-800">
            {r.comment || <span className="text-slate-400 italic">—</span>}
          </td>
        </tr>
      ))}
    </>
  );
}
