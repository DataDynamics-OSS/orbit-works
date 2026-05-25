"use client";

/**
 * 목표 — 내 목표 / 회사 목표 / 팀 목표 통합.
 *
 * - 내 목표: scope=PERSONAL & owner=me — 작성/수정 권한.
 * - 회사 목표: scope=COMPANY — readonly (HR/ADMIN 만 수정).
 * - 팀 목표: 매니저 chain 의 부하 PERSONAL 목표 (readonly 으로 모아 보기).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Building2,
  CheckCircle2,
  FileDown,
  HelpCircle,
  Layers,
  Plus,
  Sparkles,
  Target,
  TrendingUp,
  UsersRound,
  Users,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useDialog } from "@/components/ui/DialogProvider";
import { printGoalsTeamOverview } from "@/lib/goals-team-overview-export";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { GoalsHelpDialog } from "@/components/goals/GoalsHelpDialog";

type Goal = {
  id: string;
  scope: "PERSONAL" | "COMPANY";
  year: number;
  owner_id: string | null;
  owner_name: string | null;
  parent_goal_id: string | null;
  parent_title: string | null;
  title: string;
  description: string | null;
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  difficulty: "ROUTINE" | "NORMAL" | "CHALLENGING" | "STRETCH";
  status: "DRAFT" | "IN_PROGRESS" | "AT_RISK" | "DONE" | "DROPPED";
  progress_pct: string | number;
  due_date: string | null;
  self_score: string | number | null;
  self_score_comment: string | null;
  manager_score: string | number | null;
  manager_score_comment: string | null;
  manager_score_by_id: string | null;
  manager_score_by_name: string | null;
  manager_score_at: string | null;
  auto_score: {
    auto_score: number;
    weight: number;
    difficulty_factor: number;
    priority_weight: number;
    category_weight: number;
  } | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_score_self: boolean;
  can_score_manager: boolean;
};

const DIFFICULTY_LABEL: Record<Goal["difficulty"], string> = {
  ROUTINE: "일상",
  NORMAL: "표준",
  CHALLENGING: "도전",
  STRETCH: "도약",
};

const DIFFICULTY_TONE: Record<Goal["difficulty"], string> = {
  ROUTINE: "bg-zinc-100 text-zinc-700 border-zinc-200",
  NORMAL: "bg-blue-50 text-blue-700 border-blue-200",
  CHALLENGING: "bg-amber-50 text-amber-700 border-amber-200",
  STRETCH: "bg-purple-50 text-purple-700 border-purple-200",
};

const GRADE_TONE: Record<string, string> = {
  S: "bg-purple-600 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-blue-600 text-white",
  C: "bg-amber-600 text-white",
  D: "bg-red-600 text-white",
};

type Me = { id: string; mapped_developer_id: string | null; role: string };

const STATUS_LABEL: Record<Goal["status"], string> = {
  DRAFT: "초안",
  IN_PROGRESS: "진행중",
  AT_RISK: "위기",
  DONE: "완료",
  DROPPED: "중단",
};

const STATUS_TONE: Record<Goal["status"], string> = {
  DRAFT: "bg-zinc-100 text-zinc-700",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  AT_RISK: "bg-red-100 text-red-800",
  DONE: "bg-emerald-100 text-emerald-800",
  DROPPED: "bg-zinc-200 text-zinc-700",
};

const PRIORITY_LABEL: Record<Goal["priority"], string> = {
  HIGH: "상",
  MEDIUM: "중",
  LOW: "하",
};

const CATEGORY_LABEL: Record<string, string> = {
  BUSINESS: "사업",
  TECH: "기술",
  CAREER: "커리어",
  OPERATIONS: "운영",
  PERSONAL_GROWTH: "자기계발",
  OTHER: "기타",
};

export default function GoalsPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [tab, setTab] = useState<"mine" | "company" | "team">("mine");
  const dialog = useDialog();

  const { data: me } = useQuery<Me>({
    queryKey: ["auth-me"],
    queryFn: async () => (await api.get("/auth/me")).data,
  });

  const [pdfBusy, setPdfBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  async function onClickPdf() {
    setPdfBusy(true);
    try {
      await printGoalsTeamOverview(year);
    } catch (e: any) {
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "PDF 생성 실패", {
        title: "오류",
      });
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
      <DashboardHeader title="목표" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto">
        <div className="flex items-center justify-between">
          <TabBar>
            <TabItem active={tab === "mine"} onClick={() => setTab("mine")}>
              <Target className="h-3.5 w-3.5 inline mr-1" /> 내 목표
            </TabItem>
            <TabItem active={tab === "company"} onClick={() => setTab("company")}>
              <Building2 className="h-3.5 w-3.5 inline mr-1" /> 회사 목표
            </TabItem>
            <TabItem active={tab === "team"} onClick={() => setTab("team")}>
              <Users className="h-3.5 w-3.5 inline mr-1" /> 팀 목표
            </TabItem>
          </TabBar>
          <div className="flex items-center gap-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
            <Link
              href={
                "/goals/new?year=" +
                year +
                "&scope=" +
                (tab === "company" ? "COMPANY" : "PERSONAL") +
                (tab === "team" ? "&for=team" : "")
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 h-8 text-xs text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-3.5 w-3.5" /> 새 목표
            </Link>
            {(me?.role === "ADMIN" || me?.role === "HR") && (
              <button
                type="button"
                onClick={onClickPdf}
                disabled={pdfBusy}
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted disabled:opacity-50"
                title="직원 현황 보고서를 새 창에 미리보기 후 PDF 인쇄"
              >
                <FileDown className="h-3.5 w-3.5" /> PDF
              </button>
            )}
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted"
              title="목표 시스템 사용법 / 지표 설명"
            >
              <BookOpen className="h-3.5 w-3.5" /> 도움말
            </button>
          </div>
        </div>

        {tab === "mine" && me?.mapped_developer_id ? (
          <GoalGrid
            year={year}
            ownerId={me.mapped_developer_id}
            scope="PERSONAL"
            kind="mine"
          />
        ) : tab === "mine" ? (
          <div className="text-sm text-muted-foreground p-4">
            현재 계정이 임직원 정보에 연결되어 있지 않습니다 (관리자 문의).
          </div>
        ) : tab === "company" ? (
          <GoalGrid year={year} scope="COMPANY" kind="company" />
        ) : (
          <TeamGoals year={year} myDeveloperId={me?.mapped_developer_id ?? null} />
        )}
      </div>

      <GoalsHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

function GoalGrid({
  year,
  ownerId,
  scope,
  kind,
}: {
  year: number;
  ownerId?: string;
  scope?: "PERSONAL" | "COMPANY";
  kind: "mine" | "company";
}) {
  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals", year, scope, ownerId],
    queryFn: async () =>
      (
        await api.get("/goals", {
          params: {
            year,
            ...(scope ? { scope } : {}),
            ...(ownerId ? { owner_id: ownerId } : {}),
          },
        })
      ).data,
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;
  }
  return (
    <div className="space-y-3">
      <MetricsRow goals={goals} kind={kind} year={year} ownerId={ownerId} />
      {/* 내 목표 탭에서만 — 우선순위/분류/난이도 상세 표. */}
      {kind === "mine" && <DistroTables goals={goals} />}
      {goals.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          등록된 목표가 없습니다.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamGoals({
  year,
  myDeveloperId,
}: {
  year: number;
  myDeveloperId: string | null;
}) {
  // 매니저 chain 검증은 서버가 _can_view 로 처리.
  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals", year, "team"],
    queryFn: async () =>
      (await api.get("/goals", { params: { year, scope: "PERSONAL" } })).data,
  });

  const [slideOwnerId, setSlideOwnerId] = useState<string | null>(null);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;
  }
  // 본인 목표는 별도 탭 → 여기서는 부하만 (owner != me).
  const teamGoals = myDeveloperId
    ? goals.filter((g) => g.owner_id !== myDeveloperId)
    : goals;
  // owner 별로 그룹화.
  const byOwner: Record<string, Goal[]> = {};
  for (const g of teamGoals) {
    const k = g.owner_id ?? "unknown";
    (byOwner[k] ??= []).push(g);
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-4">
      {/* 좌 — 기존 팀 목표 */}
      <div className="space-y-4 min-w-0">
        <MetricsRow goals={teamGoals} kind="team" />
        {teamGoals.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
            팀원의 목표가 없습니다.
          </div>
        ) : (
          Object.entries(byOwner).map(([owner_id, list]) => (
            <section key={owner_id}>
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                {list[0].owner_name ?? "—"} ({list.length})
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {list.map((g) => (
                  <GoalCard key={g.id} goal={g} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* 우 — 직원 현황 */}
      <CompanyStatusPanel year={year} onSelect={setSlideOwnerId} />

      {/* 슬라이드 팝업 — 클릭한 직원의 PERSONAL 목표 */}
      {slideOwnerId && (
        <DeveloperGoalsSlide
          year={year}
          ownerId={slideOwnerId}
          onClose={() => setSlideOwnerId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score hero — 내 목표 탭 상단 종합 점수 + 등급 + 분포.
// ---------------------------------------------------------------------------

type SummaryOut = {
  total: number;
  grade: "S" | "A" | "B" | "C" | "D";
  goal_count: number;
  by_priority: Record<string, number>;
  by_category: Record<string, number>;
  by_difficulty: Record<string, number>;
  weight_sum: number | null;
  min_total_weight: number | null;
  floor_applied: boolean;
  min_goal_count: number | null;
};

// MetricsRow 내 '종합 점수' 카드 — 등급 배지 + 점수 + (옵션) BaselineNotice.
// 공식·등급 컷오프 설명은 (?) 아이콘 hover 로 제공.
function ScoreCard({ year, ownerId }: { year: number; ownerId: string }) {
  const { data: s } = useQuery<SummaryOut>({
    queryKey: ["goals-score-summary", year, ownerId],
    queryFn: async () =>
      (
        await api.get("/goals/score/summary", {
          params: { year, owner_id: ownerId },
        })
      ).data,
  });
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        <Layers className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">종합 점수</span>
        <span className="relative inline-flex items-center cursor-help">
          <HelpCircle className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground" />
          <Tooltip
            inline
            side="top"
            label={
              <div className="font-sans text-sm leading-relaxed min-w-[18rem] max-w-[26rem]">
                목표별 환산 점수의 가중평균.
                <div className="text-xs mt-1.5 text-muted-foreground whitespace-pre-line">
{`환산 점수 = 진행률 × 난이도 배율
가중치    = 우선순위 가중치 × 분류 가중치
종합 점수 = Σ(환산 점수 × 가중치) / Σ(가중치)`}
                </div>
                <div className="text-xs mt-1.5 text-muted-foreground">
                  등급 컷오프 — S ≥ 120 · A ≥ 90 · B ≥ 70 · C ≥ 50 · D &lt; 50.
                </div>
              </div>
            }
          />
        </span>
      </div>
      {!s || s.goal_count === 0 ? (
        <div className="flex-1 flex items-center justify-center text-2xl font-semibold tabular-nums text-muted-foreground">
          —
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <div className="flex items-center gap-3">
            <span
              className={
                "inline-flex items-center justify-center h-[62px] w-[62px] rounded-lg text-[26px] font-bold tabular-nums shrink-0 " +
                GRADE_TONE[s.grade]
              }
            >
              {s.grade}
            </span>
            <span className="text-3xl font-bold tabular-nums leading-none">
              {s.total.toFixed(1)}
              <span className="text-xs text-muted-foreground font-normal ml-0.5">
                /200
              </span>
            </span>
          </div>
          <BaselineNotice s={s} />
        </div>
      )}
    </div>
  );
}

function BaselineNotice({ s }: { s: SummaryOut }) {
  if (s.min_total_weight == null) return null;
  const ws = s.weight_sum ?? 0;
  const min = s.min_total_weight;
  const pct = min > 0 ? Math.min(100, Math.round((ws / min) * 100)) : 100;
  const hit = !!s.floor_applied;
  return (
    <div
      className={
        "mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] " +
        (hit
          ? "bg-amber-50 text-amber-800 border border-amber-200"
          : "bg-muted/40 text-muted-foreground border border-border")
      }
      title={
        hit
          ? `등록 가중치 ${ws.toFixed(1)} / 기준 ${min.toFixed(1)}. 분모가 기준으로 고정되어 점수가 비례하여 낮아졌습니다.`
          : `등록 가중치 ${ws.toFixed(1)} / 기준 ${min.toFixed(1)}. 기준 이상으로 정상 가중평균 적용.`
      }
    >
      기준 가중치 {min.toFixed(1)} · 등록 {ws.toFixed(1)} ({pct}%)
      {hit ? " · 하한 적용됨" : ""}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 우선순위/분류/난이도 — 상세 표 (ScoreHero 외부 별도 row)
// ---------------------------------------------------------------------------
//
// 페이지가 받아 둔 goals[] 에서 직접 useMemo 집계 — 별도 API X.
// 빈 row (건수 0) 는 숨김. 50점 미만·30% 미만은 amber 강조.

const PRIORITY_WEIGHT: Record<Goal["priority"], number> = {
  HIGH: 3, MEDIUM: 2, LOW: 1,
};
const DIFFICULTY_FACTOR: Record<Goal["difficulty"], number> = {
  ROUTINE: 0.8, NORMAL: 1.0, CHALLENGING: 1.5, STRETCH: 2.0,
};

function DistroTables({ goals }: { goals: Goal[] }) {
  // 우선순위 — 가중치는 고정.
  const priorityRows = useMemo(() => {
    return (["HIGH", "MEDIUM", "LOW"] as const)
      .map((p) => {
        const rs = goals.filter((g) => g.priority === p);
        if (rs.length === 0) return null;
        const avg =
          rs.reduce((s, g) => s + (g.auto_score?.auto_score ?? 0), 0) / rs.length;
        return {
          key: p,
          label: PRIORITY_LABEL[p],
          weight: PRIORITY_WEIGHT[p],
          count: rs.length,
          avgScore: avg,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [goals]);

  // 분류 — 가중치는 row 의 auto_score.category_weight 첫 값.
  const categoryRows = useMemo(() => {
    const order = ["BUSINESS","TECH","OPERATIONS","CAREER","PERSONAL_GROWTH","OTHER"];
    return order
      .map((c) => {
        const rs = goals.filter((g) => g.category === c);
        if (rs.length === 0) return null;
        const avg =
          rs.reduce((s, g) => s + (g.auto_score?.auto_score ?? 0), 0) / rs.length;
        const weight = rs[0]?.auto_score?.category_weight ?? null;
        return {
          key: c,
          label: CATEGORY_LABEL[c] ?? c,
          weight,
          count: rs.length,
          avgScore: avg,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [goals]);

  // 난이도 — 점수 대신 평균 진행률.
  const difficultyRows = useMemo(() => {
    return (["ROUTINE", "NORMAL", "CHALLENGING", "STRETCH"] as const)
      .map((d) => {
        const rs = goals.filter((g) => g.difficulty === d);
        if (rs.length === 0) return null;
        const avg =
          rs.reduce((s, g) => s + parseFloat(String(g.progress_pct)), 0) / rs.length;
        return {
          key: d,
          label: DIFFICULTY_LABEL[d],
          factor: DIFFICULTY_FACTOR[d],
          count: rs.length,
          avgProgress: avg,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [goals]);

  // 모든 표가 비어 있으면 row 자체 미렌더 (목표 0개일 때).
  if (
    priorityRows.length === 0 &&
    categoryRows.length === 0 &&
    difficultyRows.length === 0
  ) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {/* 우선순위별 */}
      <MetricTable
        title="우선순위별 평균 점수"
        hint={
          <div className="font-sans text-sm leading-relaxed min-w-[20rem] max-w-[26rem]">
            우선순위 (상·중·하) 별 목표들의 <b>환산 점수</b> 평균.
            <div className="text-xs mt-1">환산 점수 = 진행률 × 난이도 배율</div>
            <div className="text-xs mt-1.5 text-muted-foreground">
              100점 = 표준 100% 진행 / 120점 이상 = 도약 도전 + 진척 양호 → S 등급 기여.
            </div>
          </div>
        }
        headers={["우선순위", "가중치", "건수", "평균 점수"]}
        rows={priorityRows.map((r) => [
          r.label,
          r.weight,
          `${r.count}건`,
          <ScoreCell key="s" value={r.avgScore} />,
        ])}
      />
      {/* 분류별 */}
      <MetricTable
        title="분류별 평균 점수"
        hint={
          <div className="font-sans text-sm leading-relaxed min-w-[20rem] max-w-[26rem]">
            분류 (사업·기술·운영 등) 별 목표들의 <b>환산 점수</b> 평균. 같은 척도라
            그룹 간 비교 가능.
            <div className="text-xs mt-1.5 text-muted-foreground">
              관리자가 설정한 분류 가중치가 적용됩니다.
            </div>
          </div>
        }
        headers={["분류", "가중치", "건수", "평균 점수"]}
        rows={categoryRows.map((r) => [
          r.label,
          r.weight != null ? r.weight.toFixed(1) : "—",
          `${r.count}건`,
          <ScoreCell key="s" value={r.avgScore} />,
        ])}
      />
      {/* 난이도별 — 평균 진행률 */}
      <MetricTable
        title="난이도별 평균 진행률"
        hint={
          <div className="font-sans text-sm leading-relaxed min-w-[20rem] max-w-[26rem]">
            난이도별 목표 <b>건수와 평균 진행률</b>.
            <div className="text-xs mt-1.5">
              일상 ×0.8 · 표준 ×1.0 · 도전 ×1.5 · 도약 ×2.0
            </div>
            <div className="text-xs mt-1.5 text-muted-foreground">
              난이도 배율은 환산 점수에 이미 반영. 여기서는 진행률이 어디서 막히는지를 표시.
            </div>
          </div>
        }
        headers={["난이도", "배율", "건수", "평균 진행률"]}
        rows={difficultyRows.map((r) => [
          r.label,
          `×${r.factor.toFixed(1)}`,
          `${r.count}건`,
          <ProgressCell key="p" value={r.avgProgress} />,
        ])}
      />
    </div>
  );
}

function MetricTable({
  title,
  hint,
  headers,
  rows,
}: {
  title: string;
  hint?: React.ReactNode;
  headers: [string, string, string, string];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-1 mb-2">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        {hint && (
          <span className="relative inline-flex items-center cursor-help">
            <HelpCircle className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground" />
            <Tooltip inline side="top" label={hint} />
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">—</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[11px] text-muted-foreground font-medium border-b border-border">
              <th className="text-left py-1 font-medium">{headers[0]}</th>
              <th className="text-right py-1 font-medium">{headers[1]}</th>
              <th className="text-right py-1 font-medium">{headers[2]}</th>
              <th className="text-right py-1 font-medium">{headers[3]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border/40 last:border-0">
                <td className="py-1 text-foreground">{row[0]}</td>
                <td className="py-1 text-right text-muted-foreground tabular-nums">
                  {row[1]}
                </td>
                <td className="py-1 text-right tabular-nums">{row[2]}</td>
                <td className="py-1 text-right tabular-nums font-medium">
                  {row[3]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ScoreCell({ value }: { value: number }) {
  const cls = value < 50 ? "text-amber-600" : "";
  return <span className={cls}>{value.toFixed(0)}점</span>;
}

function ProgressCell({ value }: { value: number }) {
  const cls = value < 30 ? "text-amber-600" : "";
  return <span className={cls}>{value.toFixed(0)}%</span>;
}

// ---------------------------------------------------------------------------
// 지표 row — 공통 4 카드 + 탭별 1 카드.
// ---------------------------------------------------------------------------

function MetricsRow({
  goals,
  kind,
  year,
  ownerId,
}: {
  goals: Goal[];
  kind: "mine" | "company" | "team";
  /** mine 탭의 종합 점수·전체 대비 카드 fetch 에 필요. */
  year?: number;
  ownerId?: string;
}) {
  const total = goals.length;
  const avgPct =
    total === 0
      ? 0
      : goals.reduce(
          (s, g) => s + parseFloat(String(g.progress_pct)),
          0,
        ) / total;
  // '지연' = 마감일이 오늘보다 이전이고 아직 완료/중단되지 않은 목표.
  // (이전 'AT_RISK 상태' 카운트와 다름 — 라벨 의미에 맞게 실제 마감 초과 기준.)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const delayed = goals.filter((g) => {
    if (!g.due_date) return false;
    if (g.status === "DONE" || g.status === "DROPPED") return false;
    return new Date(g.due_date) < today;
  }).length;
  const done = goals.filter((g) => g.status === "DONE").length;

  // mine    탭: 12-col. 합계 = 2+2+1+2+2+3 = 12.
  // company 탭: 11-col. 합계 = 2+1+2+2+2+2 = 11.
  // team    탭:  9-col. 합계 = 2+1+2+2+2 = 9.
  // 모든 탭에서 '지연' 만 col-span-1 (절반 폭), 그 외 카드는 col-span-2.
  const isMine = kind === "mine";
  const isCompany = kind === "company";
  const isTeam = kind === "team";
  const gridCls = isMine
    ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-12"
    : isCompany
      ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-11"
      : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-9";
  const SPAN: Record<1 | 2 | 3, string> = {
    1: "lg:col-span-1",
    2: "lg:col-span-2",
    3: "lg:col-span-3",
  };
  const wrap = (span: 1 | 2 | 3, child: React.ReactNode) => (
    <div className={SPAN[span] + " h-full [&>*]:h-full"}>{child}</div>
  );

  return (
    <div className={`grid ${gridCls} gap-2`}>
      {isMine && year !== undefined && ownerId &&
        wrap(2, <ScoreCard year={year} ownerId={ownerId} />)}
      {wrap(
        2,
        <DonutKpiCard
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="평균 진행률"
          slices={[
            { name: "진행", y: avgPct, color: "#3b82f6" },
            { name: "잔여", y: Math.max(0, 100 - avgPct), color: "#e5e7eb" },
          ]}
          centerText={`${avgPct.toFixed(0)}%`}
        />,
      )}
      {wrap(
        1,
        <KpiCard
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="지연"
          value={`${delayed}`}
          tone={delayed > 0 ? "text-red-600" : "text-muted-foreground"}
        />,
      )}
      {wrap(
        2,
        <DonutKpiCard
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label="완료"
          slices={[
            { name: "완료", y: done, color: "#10b981" },
            { name: "진행중·미완", y: Math.max(0, total - done), color: "#e5e7eb" },
          ]}
          centerText={`${done}/${total}`}
        />,
      )}
      {wrap(
        2,
        kind === "mine" ? (
          <AlignmentCard goals={goals} />
        ) : kind === "company" ? (
          <CategoryCard goals={goals} />
        ) : (
          <OwnerProgressCard goals={goals} />
        ),
      )}
      {/* 회사 탭 — 분류 분포 우측에 우선순위 / 난이도 분포 추가. */}
      {isCompany && wrap(2, <PriorityCard goals={goals} />)}
      {isCompany && wrap(2, <DifficultyCard goals={goals} />)}
      {/* 팀 탭 — '평균 진행률 상위 8' 우측에 '목표 개수 상위 8' 추가. */}
      {isTeam && wrap(2, <OwnerCountCard goals={goals} />)}
      {isMine && year !== undefined && wrap(3, <MyRankBlock year={year} />)}
    </div>
  );
}

// Highcharts 동적 로더 — 카드 단위로 import. ssr:false.
const HighchartsReact = dynamic(
  () => import("highcharts-react-official").then((m) => m.default),
  { ssr: false },
);
function useHighcharts() {
  const [HC, setHC] = useState<any>(null);
  useEffect(() => {
    import("@/lib/highcharts-init").then((m) => setHC(m.default));
  }, []);
  return HC;
}

// 임직원 페이지 '성별 비율' 과 동일 톤의 도넛 KPI 카드.
// 카드 헤더(아이콘+라벨[+? hint]) + 큰 도넛(height 160) + 가운데 큰 숫자.
function DonutKpiCard({
  icon,
  label,
  slices,
  centerText,
  hint,
}: {
  icon?: React.ReactNode;
  label: string;
  slices: { name: string; y: number; color: string }[];
  centerText: string;
  hint?: React.ReactNode;
}) {
  const HC = useHighcharts();
  const total = slices.reduce((s, x) => s + x.y, 0);
  const options = HC && {
    chart: { type: "pie", height: 160, backgroundColor: "transparent" },
    title: { text: "" },
    credits: { enabled: false },
    tooltip: {
      pointFormatter(this: any) {
        // 백분율만 표시 — 평균 진행률처럼 슬라이스 값 자체가 소수일 수 있어
        // 원시값(this.y) 노출은 '82.777... (83%)' 같이 지저분해진다.
        const pct = total > 0 ? ((this.y / total) * 100).toFixed(0) : "0";
        return `<b>${pct}%</b>`;
      },
    },
    plotOptions: {
      pie: {
        innerSize: "62%",
        borderWidth: 0,
        dataLabels: { enabled: false },
        states: { hover: { halo: { size: 4 } } },
      },
    },
    series: [{ type: "pie", name: label, data: slices }],
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs font-semibold text-foreground">{label}</span>
        {hint && (
          <span className="relative inline-flex items-center cursor-help">
            <HelpCircle className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground" />
            <Tooltip inline side="top" label={hint} />
          </span>
        )}
      </div>
      <div className="relative flex-1 min-h-[140px]">
        {HC ? (
          <HighchartsReact highcharts={HC} options={options} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            …
          </div>
        )}
        {/* 도넛 가운데에 큰 텍스트 — 핵심 값. */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {centerText}
          </span>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  tone,
  donut,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
  donut?: number;
}) {
  // 헤더는 위, 값은 카드 본문 정중앙(가로·세로) 정렬.
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs font-semibold text-foreground">{label}</span>
      </div>
      <div className="flex-1 flex items-center justify-center gap-2">
        {donut !== undefined && <DonutMini pct={donut} />}
        <span
          className={
            "text-2xl font-semibold tabular-nums " + (tone ?? "text-foreground")
          }
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function DonutMini({ pct }: { pct: number }) {
  const r = 12;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  const color =
    clamped >= 80
      ? "stroke-emerald-500"
      : clamped >= 50
        ? "stroke-primary"
        : "stroke-amber-500";
  return (
    <svg width={32} height={32} viewBox="0 0 32 32" className="shrink-0">
      <circle
        cx={16}
        cy={16}
        r={r}
        fill="none"
        className="stroke-muted"
        strokeWidth={4}
      />
      <circle
        cx={16}
        cy={16}
        r={r}
        fill="none"
        className={color}
        strokeWidth={4}
        strokeDasharray={`${dash} ${c - dash}`}
        strokeDashoffset={c / 4}
        strokeLinecap="round"
      />
    </svg>
  );
}

// 탭별 5번째 카드 ----------------------------------------------------------

function AlignmentCard({ goals }: { goals: Goal[] }) {
  const total = goals.length;
  const cascaded = goals.filter((g) => g.parent_goal_id).length;
  const pct = total === 0 ? 0 : (cascaded / total) * 100;
  return (
    <DonutKpiCard
      icon={<Layers className="h-3.5 w-3.5" />}
      label="회사 목표 연결률"
      slices={[
        { name: "연결됨", y: cascaded, color: "#8b5cf6" },
        { name: "미연결", y: Math.max(0, total - cascaded), color: "#e5e7eb" },
      ]}
      centerText={`${pct.toFixed(0)}%`}
      hint={
        <div className="font-sans text-sm leading-relaxed min-w-[20rem] max-w-[26rem]">
          내 개인 목표 중 <b>회사 목표를 부모로 둔(연결된)</b> 비율.
          <div className="text-xs mt-1.5 text-muted-foreground">
            목표 작성 시 '부모 목표' 로 회사 목표를 선택하면 cascade 됩니다.
            100% 에 가까울수록 개인 목표가 회사 방향성과 정렬됨.
          </div>
          <div className="text-xs mt-1.5 text-muted-foreground">
            계산: 부모(parent_goal_id) 가 지정된 내 목표 ÷ 전체 내 목표 ({cascaded} / {total}).
          </div>
        </div>
      }
    />
  );
}

function CategoryCard({ goals }: { goals: Goal[] }) {
  const counts: Record<string, number> = {};
  for (const g of goals) {
    counts[g.category] = (counts[g.category] ?? 0) + 1;
  }
  const total = goals.length;
  const ORDER = [
    ["BUSINESS", "사업", "bg-blue-500"],
    ["TECH", "기술", "bg-purple-500"],
    ["OPERATIONS", "운영", "bg-orange-500"],
    ["CAREER", "커리어", "bg-emerald-500"],
    ["PERSONAL_GROWTH", "성장", "bg-pink-500"],
    ["OTHER", "기타", "bg-zinc-400"],
  ] as const;
  const items = ORDER.filter(([k]) => counts[k]);
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
        <Layers className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">분류 분포</span>
      </div>
      <div className="space-y-1">
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">데이터 없음</div>
        ) : (
          items.map(([k, label, color]) => {
            const cnt = counts[k];
            const pct = total === 0 ? 0 : (cnt / total) * 100;
            return (
              <div key={k} className="flex items-center gap-1.5 text-xs">
                <span className="w-10 truncate text-muted-foreground">
                  {label}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full ${color}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-5 text-right tabular-nums">{cnt}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// CategoryCard 와 동일 패턴 — 라벨/막대/카운트. 회사 탭 한정 사용.
function PriorityCard({ goals }: { goals: Goal[] }) {
  const counts: Record<string, number> = {};
  for (const g of goals) counts[g.priority] = (counts[g.priority] ?? 0) + 1;
  const ORDER = [
    ["HIGH",   "상", "bg-red-500"],
    ["MEDIUM", "중", "bg-amber-500"],
    ["LOW",    "하", "bg-zinc-400"],
  ] as const;
  const items = ORDER.filter(([k]) => counts[k]);
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
        <Target className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">우선순위 분포</span>
      </div>
      <div className="space-y-1">
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">데이터 없음</div>
        ) : (
          items.map(([k, label, color]) => {
            const cnt = counts[k];
            const pct = goals.length === 0 ? 0 : (cnt / goals.length) * 100;
            return (
              <div key={k} className="flex items-center gap-1.5 text-xs">
                <span className="w-10 truncate text-muted-foreground">{label}</span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="w-5 text-right tabular-nums">{cnt}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function DifficultyCard({ goals }: { goals: Goal[] }) {
  const counts: Record<string, number> = {};
  for (const g of goals) counts[g.difficulty] = (counts[g.difficulty] ?? 0) + 1;
  const ORDER = [
    ["ROUTINE",     "일상 ×0.8", "bg-zinc-400"],
    ["NORMAL",      "표준 ×1.0", "bg-blue-500"],
    ["CHALLENGING", "도전 ×1.5", "bg-amber-500"],
    ["STRETCH",     "도약 ×2.0", "bg-purple-500"],
  ] as const;
  const items = ORDER.filter(([k]) => counts[k]);
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
        <Sparkles className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">난이도 분포</span>
      </div>
      <div className="space-y-1">
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">데이터 없음</div>
        ) : (
          items.map(([k, label, color]) => {
            const cnt = counts[k];
            const pct = goals.length === 0 ? 0 : (cnt / goals.length) * 100;
            return (
              <div key={k} className="flex items-center gap-1.5 text-xs">
                <span className="w-16 truncate text-muted-foreground tabular-nums">
                  {label}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="w-5 text-right tabular-nums">{cnt}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function OwnerProgressCard({ goals }: { goals: Goal[] }) {
  const byOwner: Record<string, { name: string; pcts: number[] }> = {};
  for (const g of goals) {
    if (!g.owner_id) continue;
    const o = byOwner[g.owner_id] ?? { name: g.owner_name ?? "—", pcts: [] };
    o.pcts.push(parseFloat(String(g.progress_pct)));
    byOwner[g.owner_id] = o;
  }
  const rows = Object.values(byOwner)
    .map((o) => ({
      name: o.name,
      avg: o.pcts.reduce((s, v) => s + v, 0) / o.pcts.length,
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 8); // 상위 8명.
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
        <UsersRound className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">임직원별 평균 진행률 (상위 8)</span>
      </div>
      <div className="space-y-1">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">데이터 없음</div>
        ) : (
          rows.map((r) => (
            <div key={r.name} className="flex items-center gap-1.5 text-xs">
              <span className="w-10 truncate text-muted-foreground">
                {r.name}
              </span>
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={
                    "h-full " +
                    (r.avg >= 80
                      ? "bg-emerald-500"
                      : r.avg >= 50
                        ? "bg-primary"
                        : "bg-amber-500")
                  }
                  style={{ width: `${Math.min(100, r.avg)}%` }}
                />
              </div>
              <span className="w-7 text-right tabular-nums">
                {r.avg.toFixed(0)}%
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// 팀 탭 — 임직원별 목표 개수 (상위 8). 막대는 max 대비 상대 폭.
function OwnerCountCard({ goals }: { goals: Goal[] }) {
  const byOwner: Record<string, { name: string; count: number }> = {};
  for (const g of goals) {
    if (!g.owner_id) continue;
    const o = byOwner[g.owner_id] ?? { name: g.owner_name ?? "—", count: 0 };
    o.count += 1;
    byOwner[g.owner_id] = o;
  }
  const rows = Object.values(byOwner)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
        <Target className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">
          임직원별 목표 개수 (상위 8)
        </span>
      </div>
      <div className="space-y-1">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">데이터 없음</div>
        ) : (
          rows.map((r) => {
            const pct = max === 0 ? 0 : (r.count / max) * 100;
            return (
              <div key={r.name} className="flex items-center gap-1.5 text-xs">
                <span className="w-10 truncate text-muted-foreground">
                  {r.name}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-7 text-right tabular-nums">{r.count}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type DistributionOut = {
  year: number;
  my_score: number | null;
  my_rank: number | null;
  percentile: number | null;
  total_n: number;
  scores: number[];
  stats: { avg: number; median: number; min: number; max: number };
};

function MyRankBlock({ year }: { year: number }) {
  const { data } = useQuery<DistributionOut>({
    queryKey: ["goals-distribution", year],
    queryFn: async () =>
      (await api.get("/goals/score/distribution", { params: { year } })).data,
  });

  // 8 bins × 25점 = 0~25 / 25~50 / ... / 175~200
  const BINS = 8;
  const BIN_W = 200 / BINS;

  const bins = Array(BINS).fill(0);
  let myBin = -1;
  if (data) {
    for (const s of data.scores) {
      const idx = Math.min(BINS - 1, Math.floor(s / BIN_W));
      bins[idx]++;
    }
    if (data.my_score !== null && data.my_score !== undefined) {
      myBin = Math.min(BINS - 1, Math.floor(data.my_score / BIN_W));
    }
  }
  const maxCount = Math.max(1, ...bins);

  return (
    <div className="rounded-lg border border-border bg-card p-3 h-full flex flex-col">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        <BarChart3 className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold text-foreground">나의 현재 위치</span>
        <span className="relative inline-flex items-center cursor-help">
          <HelpCircle className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground" />
          <Tooltip
            inline
            side="top"
            label={
              <div className="font-sans text-sm leading-relaxed min-w-[18rem] max-w-[24rem]">
                전 직원 종합 점수 분포 + 내 위치.
                <div className="text-xs mt-1.5 text-muted-foreground">
                  8개 구간(0~25, 25~50, ..., 175~200) 별 직원 수.
                  ▲ = 내 점수 위치. 익명 (이름 없이 점수만).
                </div>
              </div>
            }
          />
        </span>
      </div>

      <div className="flex-1 flex flex-col justify-center">
      {!data ? (
        <div className="text-xs text-muted-foreground italic">불러오는 중…</div>
      ) : data.total_n === 0 ? (
        <div className="text-xs text-muted-foreground italic">데이터 없음</div>
      ) : (
        <>
          {/* 히스토그램 — 8 막대, 각 bin 비율 높이 */}
          <div className="flex items-end gap-px h-10 mb-1">
            {bins.map((cnt, i) => {
              const isMyBin = i === myBin;
              const h = (cnt / maxCount) * 100;
              return (
                <div
                  key={i}
                  className={
                    "flex-1 rounded-t-sm transition-colors " +
                    (isMyBin
                      ? "bg-primary"
                      : cnt === 0
                        ? "bg-muted"
                        : "bg-muted-foreground/30")
                  }
                  style={{ height: `${Math.max(4, h)}%` }}
                  title={`${i * BIN_W}~${(i + 1) * BIN_W}점 · ${cnt}명`}
                />
              );
            })}
          </div>

          {/* 축 + 마커 */}
          <div className="relative h-3 mb-1">
            {data.my_score !== null && (
              <div
                className="absolute top-0 -translate-x-1/2 text-[10px] text-primary font-bold"
                style={{ left: `${(data.my_score / 200) * 100}%` }}
              >
                ▲
              </div>
            )}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
            <span>0</span>
            <span>100</span>
            <span>200</span>
          </div>

          {/* 통계 */}
          <div className="text-xs mt-1.5 tabular-nums">
            {data.my_score !== null ? (
              <>
                <span className="font-semibold">{data.my_score.toFixed(0)}점</span>
                <span className="text-muted-foreground"> · 상위 </span>
                <span className="font-semibold">
                  {data.percentile?.toFixed(0)}%
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {data.my_rank}/{data.total_n}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground italic">
                내 목표가 없습니다
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
            평균 {data.stats.avg.toFixed(0)} · 중앙값 {data.stats.median.toFixed(0)} · 최고 {data.stats.max.toFixed(0)}
          </div>
        </>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GoalCard({ goal }: { goal: Goal }) {
  const pct = typeof goal.progress_pct === "string"
    ? parseFloat(goal.progress_pct) : goal.progress_pct;
  return (
    <Link
      href={`/goals/${goal.id}`}
      className="block rounded-lg border border-border bg-card p-4 hover:shadow-sm transition-shadow"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs " +
              STATUS_TONE[goal.status]
            }
          >
            {STATUS_LABEL[goal.status]}
          </span>
          <span
            className={
              "inline-flex items-center rounded-full border px-2 py-0.5 text-xs " +
              DIFFICULTY_TONE[goal.difficulty]
            }
            title={`난이도 multiplier ${goal.auto_score?.difficulty_factor ?? 1.0}x`}
          >
            {DIFFICULTY_LABEL[goal.difficulty]}
          </span>
          <span className="text-xs text-muted-foreground">
            {CATEGORY_LABEL[goal.category] ?? goal.category}
          </span>
          <span className="text-xs text-muted-foreground">
            · 우선순위 {PRIORITY_LABEL[goal.priority]}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {goal.auto_score && (
            <span
              className="text-xs tabular-nums font-semibold px-1.5 py-0.5 rounded bg-muted"
              title="자동 점수 = 진행률 × 난이도 multiplier"
            >
              {goal.auto_score.auto_score.toFixed(0)}
            </span>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {goal.year}
          </span>
        </div>
      </div>
      <h3 className="text-base font-semibold leading-snug mb-1">{goal.title}</h3>
      {goal.parent_title && (
        <div className="text-xs text-muted-foreground mb-2">
          ↳ 회사 목표: {goal.parent_title}
        </div>
      )}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-xs text-muted-foreground">진행률</span>
          <span className="text-xs tabular-nums font-medium">
            {pct.toFixed(0)}%
            {pct > 100 && (
              <span className="ml-1 text-purple-600">
                ✨ +{(pct - 100).toFixed(0)}%
              </span>
            )}
          </span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={
              "h-full rounded-full " +
              (pct > 100
                ? "bg-purple-500"
                : goal.status === "AT_RISK"
                  ? "bg-red-500"
                  : goal.status === "DONE"
                    ? "bg-emerald-500"
                    : "bg-primary")
            }
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      </div>
      {goal.due_date && (
        <div className="text-xs text-muted-foreground mt-2">
          마감 {goal.due_date}
        </div>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// 직원 현황 — 우측 패널
// ---------------------------------------------------------------------------

type OverviewDev = {
  id: string;
  name: string;
  tag: string | null;
  title: string | null;
  employment_type: string;
  goal_count: number;
  active_goal_count: number;
  score: number;
  grade: "S" | "A" | "B" | "C" | "D";
  at_risk_count: number;
  overdue_count: number;
  done_count: number;
};

type OverviewOut = {
  year: number;
  summary: {
    total_developers: number;
    with_active_goals: number;
    avg_score: number;
    at_risk_developers: number;
    overdue_developers: number;
  };
  developers: OverviewDev[];
};

type SortKey = "score" | "name" | "at_risk" | "overdue";

function CompanyStatusPanel({
  year,
  onSelect,
}: {
  year: number;
  onSelect: (devId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");

  const { data, isLoading } = useQuery<OverviewOut>({
    queryKey: ["goals-team-overview", year],
    queryFn: async () =>
      (
        await api.get("/goals/score/team-overview", { params: { year } })
      ).data,
  });

  const visible = useMemo(() => {
    const list = data?.developers ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? list.filter((d) => d.name.toLowerCase().includes(q))
      : list;
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === "score") return b.score - a.score;
      if (sortKey === "name") return a.name.localeCompare(b.name, "ko");
      if (sortKey === "at_risk") return b.at_risk_count - a.at_risk_count;
      if (sortKey === "overdue") return b.overdue_count - a.overdue_count;
      return 0;
    });
    return sorted;
  }, [data?.developers, search, sortKey]);

  // 팀 전체의 지연(=마감 초과) 건수 합계 — 직원별 overdue_count 합산.
  const totalDelayed = useMemo(
    () => (data?.developers ?? []).reduce((s, d) => s + d.overdue_count, 0),
    [data?.developers],
  );
  // 1인당 평균 지연 건수 — 활성 목표 보유 직원수로 나눔. 분모 0 이면 0.
  const avgDelayed = useMemo(() => {
    const denom = data?.summary?.with_active_goals ?? 0;
    return denom > 0 ? totalDelayed / denom : 0;
  }, [data?.summary?.with_active_goals, totalDelayed]);

  return (
    <aside className="rounded-lg border border-border bg-card p-3 lg:sticky lg:top-2 self-start min-w-0 max-h-[calc(100vh-5rem)] overflow-y-auto">
      <h3 className="text-sm font-semibold mb-2">직원 현황</h3>

      {/* 요약 카드 */}
      {data && (
        <div className="grid grid-cols-2 gap-1.5 mb-3 text-xs">
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">활성 직원</div>
            <div className="font-semibold tabular-nums">
              {data.summary.with_active_goals} / {data.summary.total_developers}
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">평균 점수</div>
            <div className="font-semibold tabular-nums">
              {data.summary.avg_score.toFixed(0)}
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">전체 지연</div>
            <div
              className={
                "font-semibold tabular-nums " +
                (totalDelayed > 0 ? "text-red-600" : "")
              }
            >
              {totalDelayed}건
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">1인당 평균 지연</div>
            <div
              className={
                "font-semibold tabular-nums " +
                (avgDelayed > 0 ? "text-amber-600" : "")
              }
            >
              {avgDelayed.toFixed(1)}건
            </div>
          </div>
        </div>
      )}

      {/* 검색·정렬 */}
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="이름 검색"
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="score">점수 내림차순</option>
          <option value="name">이름</option>
          <option value="at_risk">위기 많은 순</option>
          <option value="overdue">지각 많은 순</option>
        </select>
      </div>

      {/* 직원 list */}
      {isLoading ? (
        <div className="text-xs text-muted-foreground p-2">불러오는 중…</div>
      ) : visible.length === 0 ? (
        <div className="text-xs text-muted-foreground italic p-2">
          표시할 직원이 없습니다.
        </div>
      ) : (
        <ul className="space-y-1">
          {visible.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => onSelect(d.id)}
                className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted text-xs flex items-center gap-2"
              >
                <span className="flex-1 min-w-0 truncate">
                  <span className="font-medium">{d.name}</span>
                  {d.tag && (
                    <span className="text-muted-foreground/70 ml-1">
                      {d.tag}
                    </span>
                  )}
                  {d.title && (
                    <span className="text-muted-foreground ml-1">
                      · {d.title}
                    </span>
                  )}
                </span>
                <span className="tabular-nums w-8 text-right">{d.score.toFixed(0)}</span>
                <span
                  className={
                    "inline-flex items-center justify-center h-4 w-4 rounded text-[10px] font-bold " +
                    GRADE_TONE[d.grade]
                  }
                >
                  {d.grade}
                </span>
                {d.at_risk_count > 0 && (
                  <span className="text-[10px] text-red-600 tabular-nums">
                    ⚠{d.at_risk_count}
                  </span>
                )}
                {d.overdue_count > 0 && (
                  <span className="text-[10px] text-amber-600 tabular-nums">
                    ⏰{d.overdue_count}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 직원의 PERSONAL 목표 슬라이드 팝업 — 우측에서 슬라이드 인.
// ---------------------------------------------------------------------------

function DeveloperGoalsSlide({
  year,
  ownerId,
  onClose,
}: {
  year: number;
  ownerId: string;
  onClose: () => void;
}) {
  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals", year, "by-owner", ownerId],
    queryFn: async () =>
      (
        await api.get("/goals", {
          params: { year, scope: "PERSONAL", owner_id: ownerId },
        })
      ).data,
  });

  const ownerName = goals[0]?.owner_name ?? "직원";

  return (
    <div className="fixed inset-0 z-50">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />
      {/* slide-in panel */}
      <div className="absolute right-0 top-0 bottom-0 w-full sm:w-[36rem] bg-background border-l border-border shadow-xl flex flex-col animate-in slide-in-from-right">
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold">
            {ownerName} <span className="text-xs text-muted-foreground font-normal">· {year}년 목표</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">불러오는 중…</div>
          ) : goals.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">
              등록된 PERSONAL 목표가 없습니다.
            </div>
          ) : (
            <div className="space-y-3">
              {goals.map((g) => (
                <GoalCard key={g.id} goal={g} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
