"use client";

/**
 * 인사 > 임직원 가동율 — 행=임직원·열=월 매트릭스.
 *
 * - 캐시 테이블(`employee_utilization_cells`) 만 읽음. 매일 03:00 cron 갱신.
 * - 모드 토글: 시간기반 / 수익기여도 (응답엔 둘 다 포함).
 * - 범위 토글: 본인 / 팀 / 전체. 권한은 backend 가 scope 별 게이트 (HR/ADMIN=all,
 *   매니저 자동인지=team, 일반=me).
 * - 셀 클릭 → popover 로 프로젝트별 breakdown.
 */

import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";

type Mode = "time" | "cost";
type Scope = "me" | "team" | "all";

type BreakdownEntry = {
  project_id: string;
  project_name: string;
  days: number;
  allocation_percent: number;
  monthly_rate: number;
  contrib: number;
};

type CellOut = {
  month: string;
  workdays: number;
  allocated_days: number;
  time_ratio: number | null;
  revenue_contrib: number;
  monthly_cost: number;
  cost_ratio: number | null;
  breakdown: BreakdownEntry[];
};

type RowOut = {
  developer: {
    id: string;
    name: string;
    rank_name: string | null;
    position_name: string | null;
    hire_date: string | null;
    resigned_date: string | null;
  };
  cells: CellOut[];
  avg_time_ratio: number | null;
  avg_cost_ratio: number | null;
};

type MatrixOut = {
  months: string[];
  scope: Scope;
  mode: Mode;
  rows: RowOut[];
  summary: {
    company_avg_time_by_month: (number | null)[];
    company_avg_cost_by_month: (number | null)[];
    headcount_by_month: number[];
    bench_count_by_month: number[];
  };
};

// 기본: 최근 6개월 (이번 달 포함).
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return { from, to };
}

const RANGE_OPTIONS = [3, 6, 12, 24];

function rangeBack(months: number): { from: string; to: string } {
  const now = new Date();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return { from, to };
}

function ratioColor(r: number | null, mode: Mode): string {
  if (r == null) return "bg-slate-100 text-slate-400";  // 분모 0
  if (mode === "time") {
    if (r === 0) return "bg-slate-200 text-slate-500";          // 벤치
    if (r > 1.0) return "bg-red-100 text-red-700 font-semibold"; // 초과 투입
    if (r < 0.3) return "bg-yellow-100 text-yellow-800";        // 저활용
    if (r < 0.6) return "bg-lime-100 text-lime-800";            // 보통 (30~60%) — yellow ↔ emerald 중간
    return "bg-emerald-100 text-emerald-800";                   // 정상 (60~100%)
  }
  // cost mode: 1.0 = 손익분기, <1.0 적자, >1.0 흑자.
  if (r < 0.7) return "bg-red-100 text-red-700 font-semibold";
  if (r < 1.0) return "bg-yellow-100 text-yellow-800";
  if (r < 1.5) return "bg-emerald-100 text-emerald-800";
  return "bg-emerald-200 text-emerald-900 font-semibold";
}

function fmtRatio(r: number | null): string {
  if (r == null) return "-";
  return `${(r * 100).toFixed(0)}%`;
}

function fmtRatioMultiple(r: number | null): string {
  // cost mode 는 배수로 — 1.25× 같이.
  if (r == null) return "-";
  return `${r.toFixed(2)}×`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function LegendItem({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={"inline-block h-3 w-5 rounded " + cls} />
      <span>{label}</span>
    </span>
  );
}

export default function UtilizationPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: me } = useQuery<{ role: string; tenant_id: string | null }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const isAdminHr =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  const [scope, setScope] = useState<Scope>("me");
  const [mode, setMode] = useState<Mode>("time");
  const [rangeMonths, setRangeMonths] = useState<number>(6);
  const [howOpen, setHowOpen] = useState(false);

  // 행 숨김 — tenant 단위 localStorage 영속. 본인 브라우저에서만 적용 (다른
  // 기기 / 다른 사용자에 영향 없음). 임원급 등 가동율 항상 0% 인 사람을 매트릭스
  // 에서 빼고 싶을 때 사용. '숨김 표시' 토글 ON 으로 다시 보여서 복원 가능.
  const hiddenKey = `orbit-utilization-hidden-${me?.tenant_id ?? "anon"}`;
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !me?.tenant_id) return;
    try {
      const raw = window.localStorage.getItem(hiddenKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setHiddenIds(new Set(arr.filter((x) => typeof x === "string")));
      }
    } catch {
      /* localStorage 비활성 / 권한 거부 / 깨진 JSON — 빈 set 유지 */
    }
  }, [hiddenKey, me?.tenant_id]);
  function persistHidden(next: Set<string>) {
    setHiddenIds(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(hiddenKey, JSON.stringify([...next]));
    } catch {
      /* 무시 — 다음 reload 까지만 적용 */
    }
  }
  function hideDev(id: string) {
    const next = new Set(hiddenIds);
    next.add(id);
    persistHidden(next);
  }
  function unhideDev(id: string) {
    const next = new Set(hiddenIds);
    next.delete(id);
    persistHidden(next);
  }

  // 사용자가 ADMIN/HR 이면 처음부터 all 로 시작 (가장 가치 있는 절단면).
  useEffect(() => {
    if (isAdminHr) setScope("all");
  }, [isAdminHr]);

  const { from, to } = useMemo(() => rangeBack(rangeMonths), [rangeMonths]);

  const { data, isLoading } = useQuery<MatrixOut>({
    queryKey: ["utilization", from, to, mode, scope],
    queryFn: async () =>
      (
        await api.get("/utilization", {
          params: { from, to, mode, scope },
        })
      ).data,
    staleTime: 30_000,
  });

  const recomputeM = useMutation({
    mutationFn: async () => {
      const [yf, mf] = from.split("-").map((s) => parseInt(s, 10));
      const [yt, mt] = to.split("-").map((s) => parseInt(s, 10));
      return (
        await api.post("/utilization/recompute", {
          year_from: yf, month_from: mf,
          year_to: yt, month_to: mt,
        })
      ).data;
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["utilization"] });
      dialog.alert(
        `재계산 완료: ${r.cells_upserted} 셀 / ${r.duration_ms}ms`,
        { title: "Recompute" },
      );
    },
    onError: async (e: any) =>
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "재계산 실패",
        { title: "오류" },
      ),
  });

  const [popoverCell, setPopoverCell] = useState<{
    devName: string;
    cell: CellOut;
  } | null>(null);

  return (
    <>
      <DashboardHeader title="임직원 가동율" />
      <div className="flex flex-1 flex-col p-4 min-h-0 gap-3">
        {/* 계산 방법 — 접힘 토글. 기본 닫힘. */}
        <details
          open={howOpen}
          onToggle={(e) => setHowOpen((e.target as HTMLDetailsElement).open)}
          className="rounded-md border border-border bg-muted/30 text-sm"
        >
          <summary className="cursor-pointer select-none px-3 py-2 font-medium">
            계산 방법
          </summary>
          <div className="px-4 pb-3 pt-1 space-y-3 text-xs leading-relaxed">
            <div>
              <div className="font-semibold text-foreground mb-1">
                시간기반 가동율 = 투입 영업일 ÷ 가용 영업일
              </div>
              <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                <li>
                  <b>가용 영업일 (분모)</b> = 그 달 영업일 (평일 − 공휴일 · 임시휴일 · 회사휴일) − 입사 전·퇴사 후 일수 − 승인된 휴가 (반차 0.5일 반영)
                </li>
                <li>
                  <b>투입 영업일 (분자)</b> = 그 달과 겹치는 모든 assignment 에 대해{" "}
                  <code className="font-mono">Σ(영업일 교집합 × allocation% / 100)</code>
                </li>
                <li>
                  여러 프로젝트 동시 투입이면 합산 → <b>100% 초과 가능</b> (overbook, 빨강)
                </li>
                <li>분모가 0 (휴직·미입사) 인 칸은 <code className="font-mono">-</code> 로 표시</li>
              </ul>
            </div>
            <div>
              <div className="font-semibold text-foreground mb-1">
                수익기여도 = 프로젝트 인건비 단가 합 ÷ 회사 부담 월 비용
              </div>
              <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                <li>
                  <b>분자</b> ={" "}
                  <code className="font-mono">
                    Σ(assignment.monthly_rate × 영업일 교집합 / 월 영업일 × allocation% / 100)
                  </code>
                </li>
                <li>
                  <b>분모 (월 비용)</b> ={" "}
                  <code className="font-mono">
                    annual_salary / 12 + 회사부담 4대보험(actual 우선, 없으면 estimated)
                  </code>
                </li>
                <li>
                  <b>1.0× = 손익분기.</b> &gt;1.0× 흑자, &lt;1.0× 적자. 프리랜서·자사화는 단가=원가라 의미 없어 정규직만 표시
                </li>
                <li>salary 없으면 비용=0 으로 cost_ratio=<code className="font-mono">-</code></li>
              </ul>
            </div>
            <div className="text-muted-foreground">
              <b>대상</b>: <code className="font-mono">employment_type=FULL_TIME</code> 인 정규직만.
              매트릭스 셀은 매일 03:00 cron 이 이번 달을 재계산, 백엔드 startup 시 빈 테이블이면 올해 1~현재월 백필.
              지난달 retroactive 수정 후 갱신이 필요하면 <b>재계산</b> 버튼(ADMIN/HR) 또는 CLI 사용.
            </div>
          </div>
        </details>

        {/* 컨트롤 바 */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {/* scope */}
          <div className="inline-flex rounded-md border border-input overflow-hidden">
            {(["me", "team", "all"] as Scope[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={
                  "px-3 py-1.5 " +
                  (scope === s
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted")
                }
                disabled={s === "all" && !isAdminHr}
                title={s === "all" && !isAdminHr ? "ADMIN/HR 만" : ""}
              >
                {s === "me" ? "본인" : s === "team" ? "팀" : "전체"}
              </button>
            ))}
          </div>

          {/* mode */}
          <div className="inline-flex rounded-md border border-input overflow-hidden">
            {(["time", "cost"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={
                  "px-3 py-1.5 " +
                  (mode === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted")
                }
              >
                {m === "time" ? "시간기반" : "수익기여도"}
              </button>
            ))}
          </div>

          {/* range */}
          <div className="inline-flex rounded-md border border-input overflow-hidden">
            {RANGE_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRangeMonths(n)}
                className={
                  "px-3 py-1.5 " +
                  (rangeMonths === n
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted")
                }
              >
                {n}개월
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {hiddenIds.size > 0 && (
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                className={
                  "h-8 rounded-md border px-3 text-xs " +
                  (showHidden
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background")
                }
                title="숨긴 임직원 행 표시/숨김 토글"
              >
                숨김 {hiddenIds.size}명 {showHidden ? "표시 중" : "표시"}
              </button>
            )}
            {isAdminHr && (
              <button
                type="button"
                onClick={() => recomputeM.mutate()}
                disabled={recomputeM.isPending}
                className="h-8 rounded-md border border-border bg-background px-3 text-xs disabled:opacity-50"
              >
                {recomputeM.isPending ? "재계산 중…" : "재계산"}
              </button>
            )}
          </div>
        </div>

        {/* 매트릭스 */}
        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border bg-background">
          {isLoading && (
            <div className="p-4 text-xs text-muted-foreground">로딩 중…</div>
          )}
          {!isLoading && data && (
            <table className="min-w-full text-sm">
              {/*
                sticky thead — bg-background (불투명) 로 스크롤 시 행 내용이
                헤더 뒤로 비치지 않게 한다. 이전 bg-muted/50 은 50% 알파라
                중첩 발생. z-20 으로 본문 위에 확실히 올림. shadow-sm 으로
                헤더 아래 경계선 강조.
              */}
              <thead className="sticky top-0 z-20 bg-background shadow-sm">
                <tr className="bg-muted">
                  <th className="text-left px-3 py-2 w-56 border-b border-border bg-muted">
                    임직원
                  </th>
                  {data.months.map((m) => (
                    <th
                      key={m}
                      className="text-center px-2 py-2 border-b border-border whitespace-nowrap bg-muted"
                    >
                      {m}
                    </th>
                  ))}
                  <th className="text-center px-2 py-2 border-b border-border bg-muted">
                    평균
                  </th>
                  <th className="w-[58px] border-b border-border bg-muted" aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {data.rows
                  .filter((row) => showHidden || !hiddenIds.has(row.developer.id))
                  .map((row) => {
                    const isHidden = hiddenIds.has(row.developer.id);
                    return (
                  <tr
                    key={row.developer.id}
                    className={
                      "border-b border-border last:border-0 group " +
                      (isHidden ? "opacity-50" : "")
                    }
                  >
                    <td className="px-3 py-2 align-middle whitespace-nowrap">
                      <div className="font-medium flex items-center gap-2">
                        {row.developer.name}
                        {isHidden && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                            숨김
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[row.developer.rank_name, row.developer.position_name]
                          .filter(Boolean)
                          .join(" · ") || "-"}
                      </div>
                    </td>
                    {row.cells.map((c) => {
                      const r = mode === "time" ? c.time_ratio : c.cost_ratio;
                      const cls = ratioColor(r, mode);
                      const txt =
                        mode === "time" ? fmtRatio(r) : fmtRatioMultiple(r);
                      return (
                        <td
                          key={c.month}
                          className="px-1 py-1"
                          onClick={() =>
                            setPopoverCell({ devName: row.developer.name, cell: c })
                          }
                        >
                          <div
                            className={
                              "rounded text-center px-2 py-1.5 cursor-pointer hover:ring-2 hover:ring-primary/40 " +
                              cls
                            }
                            title={`영업일 ${c.workdays} · 투입 ${c.allocated_days.toFixed(1)}일`}
                          >
                            {txt}
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-center font-medium bg-muted/30">
                      {mode === "time"
                        ? fmtRatio(row.avg_time_ratio)
                        : fmtRatioMultiple(row.avg_cost_ratio)}
                    </td>
                    <td className="px-1 py-1 text-center">
                      {/* hover 에만 노출 (group-hover) — 항상 표시는 노이즈. */}
                      {isHidden ? (
                        <button
                          type="button"
                          onClick={() => unhideDev(row.developer.id)}
                          className="text-[11px] w-[50px] py-0.5 rounded border border-border bg-background hover:bg-muted"
                          title="이 임직원을 다시 매트릭스에 표시"
                        >
                          복원
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => hideDev(row.developer.id)}
                          className="text-[11px] w-[50px] py-0.5 rounded border border-border bg-background hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                          title="이 임직원을 매트릭스에서 숨김 (본인 브라우저에만)"
                        >
                          숨김
                        </button>
                      )}
                    </td>
                  </tr>
                    );
                  })}
                {/* 합계 행 — 백엔드 summary 그대로 (숨김 적용 X). 운영자가
                    숨김으로 가리고 싶지 않을 합계 값. */}
                <tr className="bg-muted/60 font-medium">
                  <td className="px-3 py-2">
                    전사 평균
                    <span className="ml-1 text-xs text-muted-foreground">
                      (N={Math.max(...data.summary.headcount_by_month, 0)})
                    </span>
                  </td>
                  {data.months.map((m, i) => {
                    const v =
                      mode === "time"
                        ? data.summary.company_avg_time_by_month[i]
                        : data.summary.company_avg_cost_by_month[i];
                    return (
                      <td key={m} className="px-2 py-2 text-center">
                        {mode === "time" ? fmtRatio(v) : fmtRatioMultiple(v)}
                      </td>
                    );
                  })}
                  <td className="px-2 py-2 text-center bg-muted">-</td>
                  <td className="bg-muted/60" />
                </tr>
                {/* 벤치 행 */}
                <tr className="text-xs text-muted-foreground">
                  <td className="px-3 py-1">벤치 인원 (0%)</td>
                  {data.summary.bench_count_by_month.map((b, i) => (
                    <td key={i} className="text-center px-2 py-1">
                      {b}
                    </td>
                  ))}
                  <td className="px-2 py-1 bg-muted/30 text-center">-</td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}
          {!isLoading && data && data.rows.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground text-center">
              표시할 데이터가 없습니다 (scope={scope}). 권한이 없거나 직속 부하가 없을 수 있습니다.
            </div>
          )}
        </div>

        {/* legend — 모드별 색상 의미. 매트릭스 하단 왼쪽. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {mode === "time" ? (
            <>
              <LegendItem cls="bg-slate-200 text-slate-500" label="미투입 (0%)" />
              <LegendItem cls="bg-yellow-100 text-yellow-800" label="매우 저조 (<30%)" />
              <LegendItem cls="bg-lime-100 text-lime-800" label="저조 (30~60%)" />
              <LegendItem cls="bg-emerald-100 text-emerald-800" label="보통 (60~100%)" />
              <LegendItem cls="bg-red-100 text-red-700 font-semibold" label="초과 (>100%)" />
              <LegendItem cls="bg-slate-100 text-slate-400" label="가용 0일 (휴직·미입사)" />
            </>
          ) : (
            <>
              <LegendItem cls="bg-red-100 text-red-700 font-semibold" label="적자 (<0.7×)" />
              <LegendItem cls="bg-yellow-100 text-yellow-800" label="손실 임계 (0.7~1.0×)" />
              <LegendItem cls="bg-emerald-100 text-emerald-800" label="흑자 (1.0~1.5×)" />
              <LegendItem cls="bg-emerald-200 text-emerald-900 font-semibold" label="큰 흑자 (≥1.5×)" />
              <LegendItem cls="bg-slate-100 text-slate-400" label="비용 0 (salary 누락)" />
            </>
          )}
        </div>

        {/* breakdown popover */}
        {popoverCell && (
          <div
            className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4"
            onClick={() => setPopoverCell(null)}
          >
            <div
              className="bg-background rounded-md shadow-lg max-w-[43.2rem] w-full p-4 border border-border"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-semibold">{popoverCell.devName}</div>
                  <div className="text-xs text-muted-foreground">
                    {popoverCell.cell.month} · 영업일 {popoverCell.cell.workdays} · 투입 {popoverCell.cell.allocated_days.toFixed(1)}일
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPopoverCell(null)}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  닫기
                </button>
              </div>
              {popoverCell.cell.breakdown.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  이 달에 투입된 프로젝트가 없습니다.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-1">프로젝트</th>
                      <th className="text-right py-1 w-20">일수</th>
                      <th className="text-right py-1 w-16">투입%</th>
                      <th className="text-right py-1 w-28">월 단가</th>
                      <th className="text-right py-1 w-24">기여분</th>
                    </tr>
                  </thead>
                  <tbody>
                    {popoverCell.cell.breakdown.map((b, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-1">{b.project_name}</td>
                        <td className="text-right py-1 tabular-nums">{b.days.toFixed(1)}</td>
                        <td className="text-right py-1 tabular-nums">{b.allocation_percent}%</td>
                        <td className="text-right py-1 tabular-nums">₩ {fmtNumber(b.monthly_rate)}</td>
                        <td className="text-right py-1 tabular-nums">₩ {fmtNumber(b.contrib)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-medium bg-muted/30">
                      <td className="py-1">합계</td>
                      <td className="text-right py-1 tabular-nums">
                        {popoverCell.cell.allocated_days.toFixed(1)}
                      </td>
                      <td></td>
                      <td className="text-right py-1 tabular-nums">
                        ₩ {fmtNumber(popoverCell.cell.monthly_cost)}
                      </td>
                      <td className="text-right py-1 tabular-nums">
                        ₩ {fmtNumber(popoverCell.cell.revenue_contrib)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
              <div className="mt-3 text-xs text-muted-foreground">
                시간기반 가동율: {fmtRatio(popoverCell.cell.time_ratio)} ·{" "}
                수익기여도: {fmtRatioMultiple(popoverCell.cell.cost_ratio)}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
