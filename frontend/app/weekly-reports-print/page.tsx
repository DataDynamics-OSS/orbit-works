"use client";

/**
 * 주간보고 PDF 인쇄용 페이지 — 사이드바 없는 별도 라우트.
 *
 * 사용처: weekly-reports 페이지의 PDF 버튼이 새 창으로 이 페이지를 연다.
 * Query: ?scope=team|all&year=YYYY&week=WW (= anchor 한 주).
 *
 * 표시: 해당 주의 SUBMITTED 보고서만, rank 우선·이름순 정렬. 각 보고서는
 * `<TipTapViewer />` 로 본문 렌더 + 첨부 파일명 리스트만 (실제 파일은
 * 인쇄 PDF 에 포함 X — 큰 binary 회피).
 *
 * "PDF로 인쇄" 클릭 시 window.print() — 브라우저 인쇄 다이얼로그에서 "PDF
 * 로 저장" 선택 가능. @media print 에서 컨트롤 바 숨김.
 */

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip, Printer, X } from "lucide-react";

import { api } from "@/lib/api";
import { TipTapViewer } from "@/components/board/TipTapEditor";
import { weekRange } from "@/lib/iso-week";

type Scope = "team" | "all";

type ReportFull = {
  id: string;
  developer_id: string;
  developer_name: string | null;
  iso_year: number;
  iso_week: number;
  week_start: string;
  week_end: string;
  status: "DRAFT" | "SUBMITTED";
  submitted_at: string | null;
  body: string | null;
  plain_text: string | null;
  attachments: { id: string; file_name: string; size: number | null }[];
  // 정렬용 — API 가 함께 반환하지 않을 수 있어 optional. 없으면 이름순.
  rank_level?: number | null;
  position_level?: number | null;
};

type Assignment = {
  id: string;
  project_id: string;
  developer_id: string;
  start_date: string;
  end_date: string;
};

type ProjectLite = { id: string; name: string };

const SCOPE_LABEL: Record<Scope, string> = {
  team: "팀 보고서",
  all: "전체",
};

function fmtDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Next.js 의 정적 prerender 가 useSearchParams 를 평가하지 못해 빌드가
// 실패하는 것을 막기 위해 Suspense 로 감싼 inner 컴포넌트를 default export
// 한다. 빈 fallback 으로 짧은 깜빡임만 발생.
export default function WeeklyReportsPrintPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">불러오는 중…</div>}>
      <PrintPageInner />
    </Suspense>
  );
}

function PrintPageInner() {
  const params = useSearchParams();
  const scope = (params.get("scope") as Scope | null) ?? "team";
  const year = Number(params.get("year") ?? new Date().getFullYear());
  const week = Number(params.get("week") ?? 1);

  const range = useMemo(() => weekRange(year, week), [year, week]);

  const { data: rows = [], isLoading } = useQuery<ReportFull[]>({
    queryKey: ["weekly-reports-print", scope, year, week],
    queryFn: async () =>
      (
        await api.get("/weekly-reports", {
          params: {
            owner: scope,
            from_year: year,
            from_week: week,
            to_year: year,
            to_week: week,
            include_body: true,
          },
        })
      ).data,
  });

  // anchor 한 주의 모든 투입 row — developer_id 필터 없이 한 번에. RLS 가
  // tenant 격리 자동 적용. assignments + projects 두 호출로 N+1 회피.
  const monthStart = useMemo(() => {
    const d = range.start;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, [range]);
  const monthEnd = useMemo(() => {
    const d = range.end;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, [range]);

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ["weekly-reports-print-assignments", monthStart, monthEnd],
    queryFn: async () =>
      (
        await api.get("/assignments", {
          params: { month_start: monthStart, month_end: monthEnd },
        })
      ).data,
    staleTime: 60_000,
  });

  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ["projects-lite"],
    queryFn: async () => (await api.get("/projects")).data,
    staleTime: 5 * 60_000,
  });

  // developer_id → 그 주에 활성인 프로젝트 리스트 (이름순, 중복 제거).
  const assignmentsByDev = useMemo(() => {
    const projMap = new Map(projects.map((p) => [p.id, p]));
    const m = new Map<string, ProjectLite[]>();
    for (const a of assignments) {
      const proj = projMap.get(a.project_id);
      if (!proj) continue;
      const arr = m.get(a.developer_id) ?? [];
      if (!arr.find((p) => p.id === proj.id)) arr.push(proj);
      m.set(a.developer_id, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    return m;
  }, [assignments, projects]);

  // SUBMITTED 만. rank → name 정렬 (rank 정보가 없으면 이름순).
  const visible = useMemo(() => {
    const submitted = rows.filter((r) => r.status === "SUBMITTED");
    return [...submitted].sort((a, b) => {
      const ar = a.rank_level ?? 9999;
      const br = b.rank_level ?? 9999;
      if (ar !== br) return ar - br;
      return (a.developer_name ?? "").localeCompare(b.developer_name ?? "");
    });
  }, [rows]);

  const periodLabel = `${fmtDate(range.start.toISOString())} ~ ${fmtDate(range.end.toISOString())}`;

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <style jsx global>{`
        /* 인쇄 시 — 컨트롤 바 숨기고 보고서 카드 사이에서 페이지 깨지지 않게. */
        @media print {
          .no-print { display: none !important; }
          .report-card {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          @page { margin: 12mm; }
          body { background: #fff; }
        }
      `}</style>

      {/* 컨트롤 바 — 인쇄에서는 숨김 */}
      <div
        className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-white px-6 py-3 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-base font-semibold">
            주간보고 — {SCOPE_LABEL[scope]} · {year}년 W
            {String(week).padStart(2, "0")}
          </h1>
          <span className="text-xs text-muted-foreground tabular-nums">
            {periodLabel}
          </span>
          <span className="text-xs text-muted-foreground">
            · 제출 {visible.length} 건
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            disabled={visible.length === 0}
            className="h-8 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Printer className="h-4 w-4" />
            PDF로 인쇄
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="h-8 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <X className="h-4 w-4" />
            닫기
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-6 py-6 space-y-6">
        {/* 인쇄용 헤더 (컨트롤 바와 별개로, 인쇄 결과물 첫 줄에 노출). */}
        <div className="border-b border-slate-300 pb-3">
          <div className="text-xl font-bold">
            주간보고 — {SCOPE_LABEL[scope]}
          </div>
          <div className="mt-1 text-sm text-slate-600 tabular-nums">
            {year}년 W{String(week).padStart(2, "0")} ({periodLabel}) · 제출{" "}
            {visible.length} 건
          </div>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        ) : visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500">
            제출된 보고서가 없습니다.
          </div>
        ) : (
          visible.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              projects={assignmentsByDev.get(r.developer_id) ?? []}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ReportCard({
  report,
  projects,
}: {
  report: ReportFull;
  projects: ProjectLite[];
}) {
  return (
    <section className="report-card rounded-md border border-slate-300 bg-white p-5">
      <header className="mb-3">
        <div className="text-sm font-semibold">
          {report.developer_name ?? "(이름 없음)"}
        </div>
        <div className="mt-0.5 text-sm text-slate-500 tabular-nums">
          {report.iso_year}년 W{String(report.iso_week).padStart(2, "0")} ·{" "}
          {fmtDate(report.week_start)} ~ {fmtDate(report.week_end)}
          {report.submitted_at && ` · 제출 ${fmtDate(report.submitted_at)}`}
        </div>
        {/* anchor 한 주에 활성인 프로젝트 — 0건이면 줄 자체 미노출. */}
        {projects.length > 0 && (
          <div className="mt-0.5 text-sm text-slate-600">
            <span className="text-slate-500">참여 프로젝트:</span>{" "}
            {projects.map((p) => p.name).join(", ")}
          </div>
        )}
      </header>

      {report.body && report.body.trim() ? (
        <div className="text-sm">
          <TipTapViewer html={report.body} />
        </div>
      ) : (
        <div className="text-xs italic text-slate-400">(본문 없음)</div>
      )}

      {report.attachments.length > 0 && (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <div className="mb-1 text-[11px] font-semibold text-slate-500">
            첨부 ({report.attachments.length})
          </div>
          <ul className="text-[11px] text-slate-600">
            {report.attachments.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1">
                <Paperclip className="h-3 w-3" />
                <span className="font-mono">{a.file_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
