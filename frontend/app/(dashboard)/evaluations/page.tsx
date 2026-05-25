"use client";

/**
 * 임직원 평가 — 메인 페이지.
 *
 * 단일 메뉴 안에서 role 별 탭으로 분기:
 *   - 내 평가 (모든 사용자)
 *   - 소속 구성원 평가 (직속 부하 ≥1)
 *   - 전체 / cycle 관리 (HR/ADMIN)
 *   - 양식 설정 (ADMIN)
 *
 * 각 탭은 cycle dropdown + evaluation 카드 grid. cycle 관리 탭은 cycle CRUD
 * + open/close 버튼.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarRange,
  CheckCircle2,
  Play,
  Plus,
  Printer,
  Settings as SettingsIcon,
  Square,
  Trash2,
  UserCheck,
  Users,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Role = "ADMIN" | "HR" | "SALES" | "SUPPORT" | "ETC" | "SUPER_ADMIN";
type CycleStatus = "DRAFT" | "OPEN" | "CALIBRATING" | "CLOSED";
type EvalStatus =
  | "NOT_STARTED"
  | "SELF_DRAFT"
  | "SELF_SUBMITTED"
  | "MGR_DRAFT"
  | "MGR_SUBMITTED"
  | "CALIBRATED"
  | "FINALIZED";
type Grade = "S" | "A" | "B" | "C" | "D";
type Period = "1H" | "2H";

type Cycle = {
  id: string;
  year: number;
  period: Period;
  name: string;
  start_date: string;
  end_date: string;
  self_due: string;
  manager_due: string;
  finalize_due: string;
  status: CycleStatus;
  evaluation_count: number;
  submitted_count: number;
  finalized_count: number;
};

type CompetencyLite = {
  dimension_key: string;
  self_score: number | null;
  manager_score: number | null;
  final_score: number | null;
};

type EvalRow = {
  id: string;
  cycle_id: string;
  developer_id: string;
  developer_name: string | null;
  manager_name: string | null;
  status: EvalStatus;
  final_grade: Grade | null;
  self_submitted_at: string | null;
  manager_submitted_at: string | null;
  finalized_at: string | null;
  can_self: boolean;
  can_manager: boolean;
  can_calibrate: boolean;
  competencies: CompetencyLite[];
  // 직위 — 카드 그룹핑·정렬용. NULL = 직위 미지정 그룹.
  rank_id: string | null;
  rank_name: string | null;
  rank_sort_order: number | null;
};

type Tab = "me" | "team" | "all" | "settings";

const STATUS_LABEL: Record<EvalStatus, string> = {
  NOT_STARTED: "미시작",
  SELF_DRAFT: "자기평가 작성중",
  SELF_SUBMITTED: "자기평가 제출",
  MGR_DRAFT: "매니저 작성중",
  MGR_SUBMITTED: "매니저 제출",
  CALIBRATED: "조정 완료",
  FINALIZED: "공개 완료",
};
const STATUS_COLOR: Record<EvalStatus, string> = {
  NOT_STARTED: "bg-slate-100 text-slate-600",
  SELF_DRAFT: "bg-amber-100 text-amber-700",
  SELF_SUBMITTED: "bg-sky-100 text-sky-700",
  MGR_DRAFT: "bg-amber-100 text-amber-700",
  MGR_SUBMITTED: "bg-sky-100 text-sky-700",
  CALIBRATED: "bg-violet-100 text-violet-700",
  FINALIZED: "bg-emerald-100 text-emerald-700",
};
// 등급 배지 색조 — goals 페이지의 "종합 점수" 와 동일 톤 (진한 배경 + 흰 글자).
// 시각 일관성 위해 두 도메인 사용 색 통일.
const GRADE_COLOR: Record<Grade, string> = {
  S: "bg-purple-600 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-blue-600 text-white",
  C: "bg-amber-600 text-white",
  D: "bg-red-600 text-white",
};
const CYCLE_STATUS_COLOR: Record<CycleStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  OPEN: "bg-emerald-100 text-emerald-700",
  CALIBRATING: "bg-violet-100 text-violet-700",
  CLOSED: "bg-zinc-200 text-zinc-700",
};

export default function EvaluationsPage() {
  const { data: me } = useQuery<{ role: Role; mapped_developer_id: string | null }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const isHrAdmin =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";
  const isAdmin = me?.role === "ADMIN" || me?.role === "SUPER_ADMIN";

  // 매니저 여부 — team 탭 노출 결정. 부하 evaluation rows 가 있으면 true.
  const myDevId = me?.mapped_developer_id ?? null;
  const { data: teamRows = [] } = useQuery<EvalRow[]>({
    queryKey: ["evals", "team-probe", myDevId],
    queryFn: async () =>
      (await api.get("/evaluations", { params: { owner: "team" } })).data,
    enabled: !!myDevId,
    staleTime: 60_000,
  });
  const isManager = teamRows.length > 0;

  const [tab, setTab] = useState<Tab>("me");
  // role 결정 후 default 탭 — HR/ADMIN 은 "전체" 로, 매니저는 "내 평가" 유지.
  useEffect(() => {
    if (!me) return;
    if (tab === "me") return;  // 사용자가 이동했으면 유지.
  }, [me, tab]);

  return (
    <>
      <DashboardHeader title="임직원 평가" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-y-auto">
        {/* 탭 */}
        <div className="flex items-center gap-1 border-b border-border">
          <TabBtn active={tab === "me"} onClick={() => setTab("me")} icon={<UserCheck className="h-3.5 w-3.5" />}>
            내 평가
          </TabBtn>
          {isManager && (
            <TabBtn active={tab === "team"} onClick={() => setTab("team")} icon={<Users className="h-3.5 w-3.5" />}>
              소속 구성원 평가
            </TabBtn>
          )}
          {isHrAdmin && (
            <TabBtn active={tab === "all"} onClick={() => setTab("all")} icon={<CalendarRange className="h-3.5 w-3.5" />}>
              전체 / 주기 관리
            </TabBtn>
          )}
          {isAdmin && (
            <TabBtn active={tab === "settings"} onClick={() => setTab("settings")} icon={<SettingsIcon className="h-3.5 w-3.5" />}>
              양식 설정
            </TabBtn>
          )}
        </div>

        {tab === "me" && <ScopedTab owner="me" />}
        {tab === "team" && isManager && <ScopedTab owner="team" />}
        {tab === "all" && isHrAdmin && <AllTab />}
        {tab === "settings" && isAdmin && <DimensionsSettingsTab />}
      </div>
    </>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-9 inline-flex items-center gap-1.5 px-3 text-sm border-b-2 -mb-px " +
        (active
          ? "border-primary text-foreground font-semibold"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// "내 평가" / "소속 구성원 평가" 탭 — cycle dropdown + 카드 그리드.
// ---------------------------------------------------------------------------

function ScopedTab({ owner }: { owner: "me" | "team" }) {
  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["evals", "cycles"],
    queryFn: async () => (await api.get("/evaluations/cycles")).data,
  });

  const [cycleId, setCycleId] = useState<string>("");
  useEffect(() => {
    if (!cycleId && cycles.length > 0) setCycleId(cycles[0].id);
  }, [cycles, cycleId]);

  const { data: rows = [] } = useQuery<EvalRow[]>({
    queryKey: ["evals", "list", owner, cycleId],
    queryFn: async () =>
      (
        await api.get("/evaluations", {
          params: cycleId ? { owner, cycle_id: cycleId } : { owner },
        })
      ).data,
    enabled: cycles.length > 0,
  });

  return (
    <div className="flex flex-col gap-3">
      <CycleSelector cycles={cycles} value={cycleId} onChange={setCycleId} />
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {owner === "me" ? "내 평가가 없습니다." : "소속 구성원 평가가 없습니다."}
        </div>
      ) : (
        <GroupedEvalList rows={rows} />
      )}
    </div>
  );
}

function CycleSelector({
  cycles,
  value,
  onChange,
}: {
  cycles: Cycle[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (cycles.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic px-1">
        활성 평가 주기가 없습니다.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-xs text-muted-foreground">평가 주기</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs rounded-md border border-input bg-background px-2"
      >
        {cycles.map((c) => (
          <option key={c.id} value={c.id}>
            {c.year} {c.period} · {c.name} · {c.status}
          </option>
        ))}
      </select>
    </div>
  );
}

// 평가 카드 list 를 직위(rank) 별 group section 으로 묶어 렌더. rank_sort_order
// asc, NULL 은 "(직위 미지정)" 그룹으로 맨 뒤. ScopedTab/AllTab 양쪽 공통.
function GroupedEvalList({ rows }: { rows: EvalRow[] }) {
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        rank_id: string | null;
        rank_name: string;
        rank_sort_order: number;
        items: EvalRow[];
      }
    >();
    for (const r of rows) {
      // 같은 rank_id 끼리 묶기. NULL 은 빈 string key 로.
      const key = r.rank_id ?? "__none__";
      const cur = map.get(key);
      if (cur) {
        cur.items.push(r);
      } else {
        map.set(key, {
          rank_id: r.rank_id,
          rank_name: r.rank_name ?? "(직위 미지정)",
          // NULL 은 정렬상 맨 뒤로.
          rank_sort_order: r.rank_sort_order ?? Number.MAX_SAFE_INTEGER,
          items: [r],
        });
      }
    }
    const list = Array.from(map.values());
    // 직위 역순 (sort_order desc) — 보통 sort_order asc 가 사원→부장이므로
    // desc 면 부장(상위) → 사원(하위). NULL 그룹은 항상 맨 뒤 유지.
    list.sort((a, b) => {
      const aNull = a.rank_id === null;
      const bNull = b.rank_id === null;
      if (aNull && !bNull) return 1;
      if (!aNull && bNull) return -1;
      return b.rank_sort_order - a.rank_sort_order;
    });
    // 그룹 안에서는 이름 가나다순.
    for (const g of list) {
      g.items.sort((a, b) =>
        (a.developer_name ?? "").localeCompare(b.developer_name ?? "", "ko"),
      );
    }
    return list;
  }, [rows]);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <section
          key={g.rank_id ?? "__none__"}
          className="rounded-md border border-border bg-muted/10"
        >
          <header className="px-3 py-2 border-b border-border bg-muted/30 text-sm font-semibold flex items-center gap-2">
            <span>{g.rank_name}</span>
            <span className="text-xs text-muted-foreground font-normal">
              ({g.items.length}명)
            </span>
          </header>
          {/* 카드 360px 고정 — auto-fill 로 viewport 폭에 맞춰 칸 수 자동 결정. */}
          <ul className="grid gap-3 p-3 [grid-template-columns:repeat(auto-fill,360px)]">
            {g.items.map((r) => (
              <EvaluationCard key={r.id} row={r} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EvaluationCard({ row }: { row: EvalRow }) {
  return (
    <li className="rounded-md border border-border bg-card hover:bg-muted/40 transition-colors">
      <Link
        href={`/evaluations/${row.id}`}
        className="block p-3 flex flex-col gap-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium text-sm truncate">
            {row.developer_name ?? "(이름 없음)"}
          </div>
          {row.final_grade && (
            <span
              className={
                // 이전(w-14 h-14)에서 약 30% 축소: w-10 h-10 text-lg.
                "inline-flex items-center justify-center w-10 h-10 rounded-md text-lg font-bold " +
                GRADE_COLOR[row.final_grade]
              }
            >
              {row.final_grade}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>매니저 {row.manager_name ?? "—"}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={
              "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " +
              STATUS_COLOR[row.status]
            }
          >
            {STATUS_LABEL[row.status]}
          </span>
          {row.can_self && (
            <span className="text-[11px] text-amber-600">✎ 본인 작성 필요</span>
          )}
          {row.can_manager && (
            <span className="text-[11px] text-amber-600">✎ 매니저 작성 필요</span>
          )}
          {row.can_calibrate && (
            <span className="text-[11px] text-violet-600">⚖ 조정 필요</span>
          )}
        </div>
        {/* dimension 별 mini 게이지 — self/manager 두 줄로 비교. 점수 없는 평가
            (NOT_STARTED 등) 는 회색 빈 게이지로 표시. */}
        {row.competencies.length > 0 && (
          <DimensionMiniBars items={row.competencies} />
        )}
      </Link>
    </li>
  );
}

// 카드 안 인라인 mini 게이지 — dimension 마다 self/manager 짧은 5칸. dimension
// 이름은 좁은 라벨 (6자 truncate). 게이지 자체가 점수+색 으로 의미 다 전달.
function DimensionMiniBars({ items }: { items: CompetencyLite[] }) {
  const { data: dimensions = [] } = useQuery<Dimension[]>({
    queryKey: ["evals", "dimensions"],
    queryFn: async () => (await api.get("/evaluations/dimensions")).data,
    staleTime: 5 * 60_000,
  });
  const dimName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of dimensions) m[d.key] = d.label;
    return m;
  }, [dimensions]);
  return (
    <div className="pt-1 border-t border-border/50 grid grid-cols-1 gap-1">
      {items.map((c) => (
        <div key={c.dimension_key} className="flex items-center gap-1.5 text-[10px]">
          {/* 평가 항목 라벨 — 검정 글꼴, w-16 (한글 6자 truncate 여유). */}
          <span className="w-16 truncate text-foreground shrink-0" title={dimName[c.dimension_key]}>
            {dimName[c.dimension_key] ?? c.dimension_key}
          </span>
          <MiniGauge score={c.self_score} />
          <MiniGauge score={c.manager_score} />
        </div>
      ))}
    </div>
  );
}

// 5칸 짧은 게이지 — 카드 안 inline 용 (h-1.5). 점수 1=빨강 ~ 5=초록.
function MiniGauge({ score }: { score: number | null }) {
  const n = score && score >= 1 && score <= 5 ? Math.round(score) : 0;
  const color = score ? SCORE_COLOR[n] ?? "bg-slate-300" : "bg-slate-200";
  return (
    <div className="flex gap-px flex-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={"h-1.5 flex-1 rounded-[1px] " + (i <= n ? color : "bg-slate-100")}
        />
      ))}
    </div>
  );
}

// 점수(1~5) → 색 매핑. 신호등 변형 — 4(sky)→5(emerald) 사이에 따뜻↔차가운 점프
// 를 두어 인접 점수(이전엔 lime/emerald 가 거의 같아 보임) 식별성 확보.
const SCORE_COLOR: Record<number, string> = {
  1: "bg-red-600",
  2: "bg-orange-500",
  3: "bg-yellow-500",
  4: "bg-sky-500",
  5: "bg-emerald-600",
};

// ---------------------------------------------------------------------------
// PDF 출력 — 직원 multi-select 다이얼로그.
// 선택된 evaluation ids 를 query 로 넘겨 /evaluations-print 신규 탭 오픈.
// ---------------------------------------------------------------------------

function EvaluationPrintPickerDialog({
  cycleId,
  rows,
  onClose,
}: {
  cycleId: string;
  rows: EvalRow[];
  onClose: () => void;
}) {
  // 모든 항목 초기 선택 — "출력 안 할 사람만 해제" 가 자주 있는 흐름.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.map((r) => r.id)),
  );

  // 직위별 그룹 — GroupedEvalList 의 정렬과 동일 (sort_order desc, NULL 끝).
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        rank_id: string | null;
        rank_name: string;
        rank_sort_order: number;
        items: EvalRow[];
      }
    >();
    for (const r of rows) {
      const key = r.rank_id ?? "__none__";
      const cur = map.get(key);
      if (cur) cur.items.push(r);
      else
        map.set(key, {
          rank_id: r.rank_id,
          rank_name: r.rank_name ?? "(직위 미지정)",
          rank_sort_order: r.rank_sort_order ?? Number.MAX_SAFE_INTEGER,
          items: [r],
        });
    }
    const list = Array.from(map.values());
    list.sort((a, b) => {
      const aNull = a.rank_id === null;
      const bNull = b.rank_id === null;
      if (aNull && !bNull) return 1;
      if (!aNull && bNull) return -1;
      return b.rank_sort_order - a.rank_sort_order;
    });
    for (const g of list) {
      g.items.sort((a, b) =>
        (a.developer_name ?? "").localeCompare(b.developer_name ?? "", "ko"),
      );
    }
    return list;
  }, [rows]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected = selected.size === rows.length;
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  }
  function openPrint() {
    if (selected.size === 0) return;
    const ids = Array.from(selected).join(",");
    // 새 탭에서 print 페이지 오픈 — 사이드바 없는 깨끗한 layout.
    window.open(
      `/evaluations-print?cycle=${encodeURIComponent(cycleId)}&ids=${encodeURIComponent(ids)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="PDF 출력 대상 선택"
      width="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={openPrint}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Printer className="h-3.5 w-3.5" />
            {selected.size}명 출력
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            선택된 임직원만 인쇄 페이지에 포함됩니다 (직위 순).
          </span>
          <button
            type="button"
            onClick={toggleAll}
            className="text-xs text-primary hover:underline"
          >
            {allSelected ? "전체 해제" : "전체 선택"}
          </button>
        </div>
        <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {groups.map((g) => (
            <section
              key={g.rank_id ?? "__none__"}
              className="rounded-md border border-border bg-muted/10"
            >
              <header className="px-3 py-1.5 border-b border-border bg-muted/30 text-xs font-semibold flex items-center gap-2">
                <span>{g.rank_name}</span>
                <span className="text-muted-foreground font-normal">
                  ({g.items.length}명)
                </span>
              </header>
              <ul className="divide-y divide-border/50">
                {g.items.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/20 cursor-pointer"
                    onClick={() => toggle(r.id)}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="text-sm">
                      {r.developer_name ?? "(이름 없음)"}
                    </span>
                    <span className="text-[11px] text-muted-foreground ml-auto">
                      매니저 {r.manager_name ?? "—"}
                    </span>
                    {r.final_grade && (
                      <span
                        className={
                          "inline-flex items-center justify-center w-6 h-6 rounded-md text-[11px] font-bold " +
                          GRADE_COLOR[r.final_grade]
                        }
                      >
                        {r.final_grade}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// "전체 / 주기 관리" 탭 — HR/ADMIN.
// ---------------------------------------------------------------------------

function AllTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [createOpen, setCreateOpen] = useState(false);
  const [printPickerOpen, setPrintPickerOpen] = useState(false);

  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["evals", "cycles"],
    queryFn: async () => (await api.get("/evaluations/cycles")).data,
  });

  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  useEffect(() => {
    if (!selectedCycleId && cycles.length > 0) setSelectedCycleId(cycles[0].id);
  }, [cycles, selectedCycleId]);

  const { data: rows = [] } = useQuery<EvalRow[]>({
    queryKey: ["evals", "list", "all", selectedCycleId],
    queryFn: async () =>
      (
        await api.get("/evaluations", {
          params: selectedCycleId
            ? { owner: "all", cycle_id: selectedCycleId }
            : { owner: "all" },
        })
      ).data,
    enabled: cycles.length > 0,
  });

  const openM = useMutation({
    mutationFn: async (cid: string) =>
      (await api.post(`/evaluations/cycles/${cid}/open`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["evals", "cycles"] });
      qc.invalidateQueries({ queryKey: ["evals", "list"] });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "오픈 실패", { title: "오류" }),
  });
  const closeM = useMutation({
    mutationFn: async (cid: string) =>
      (await api.post(`/evaluations/cycles/${cid}/close`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["evals", "cycles"] }),
  });

  return (
    <div className="flex flex-col gap-3">
      {/* 주기 관리 */}
      <section className="rounded-md border border-border bg-card">
        <header className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h3 className="text-sm font-semibold">평가 주기</h3>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="h-7 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3.5 w-3.5" /> 신규
          </button>
        </header>
        {cycles.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground italic">
            평가 주기가 없습니다.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5">연도/반기</th>
                <th className="text-left px-3 py-1.5">이름</th>
                <th className="text-left px-3 py-1.5">기간</th>
                <th className="text-left px-3 py-1.5">상태</th>
                <th className="text-left px-3 py-1.5">진행</th>
                <th className="text-left px-3 py-1.5">액션</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => (
                <tr
                  key={c.id}
                  className={
                    "border-t border-border/50 hover:bg-muted/20 cursor-pointer " +
                    (selectedCycleId === c.id ? "bg-muted/30" : "")
                  }
                  onClick={() => setSelectedCycleId(c.id)}
                >
                  <td className="px-3 py-1.5 font-semibold">
                    {c.year} {c.period}
                  </td>
                  <td className="px-3 py-1.5">{c.name}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {c.start_date} ~ {c.end_date}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-[11px] " +
                        CYCLE_STATUS_COLOR[c.status]
                      }
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 tabular-nums">
                    제출 {c.submitted_count} / 공개 {c.finalized_count} / 전체 {c.evaluation_count}
                  </td>
                  <td className="px-3 py-1.5">
                    {c.status === "DRAFT" && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const ok = await dialog.confirm(
                            `${c.year} ${c.period} 평가를 시작합니다. 모든 정규직 활성 직원에 평가 row 가 자동 생성됩니다. 진행할까요?`,
                            { title: "평가 시작" },
                          );
                          if (ok) openM.mutate(c.id);
                        }}
                        className="text-emerald-600 hover:underline inline-flex items-center gap-0.5"
                      >
                        <Play className="h-3 w-3" /> 시작
                      </button>
                    )}
                    {(c.status === "OPEN" || c.status === "CALIBRATING") && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const ok = await dialog.confirm(
                            `${c.year} ${c.period} 평가를 종료합니다. 본인·매니저는 더 이상 작성할 수 없습니다.`,
                            { title: "평가 종료", destructive: true },
                          );
                          if (ok) closeM.mutate(c.id);
                        }}
                        className="text-rose-600 hover:underline inline-flex items-center gap-0.5"
                      >
                        <Square className="h-3 w-3" /> 종료
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 평가 목록 — 소속 구성원 평가 탭(ScopedTab)과 동일 grid. 카드 자체에
          dimension 별 mini 게이지 인라인. */}
      <section className="rounded-md border border-border bg-card">
        <header className="px-3 py-2 border-b border-border text-sm font-semibold flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5" />
          평가 목록 — 선택 주기
          <span className="text-xs text-muted-foreground font-normal">
            ({rows.length}명)
          </span>
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={() => setPrintPickerOpen(true)}
            className="ml-auto h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" /> PDF 출력
          </button>
        </header>
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground italic">
            평가 row 가 없습니다.
          </div>
        ) : (
          <div className="p-3">
            <GroupedEvalList rows={rows} />
          </div>
        )}
      </section>

      {createOpen && (
        <CycleCreateDialog onClose={() => setCreateOpen(false)} />
      )}
      {printPickerOpen && (
        <EvaluationPrintPickerDialog
          cycleId={selectedCycleId}
          rows={rows}
          onClose={() => setPrintPickerOpen(false)}
        />
      )}
    </div>
  );
}

function CycleCreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const today = new Date();
  const yr = today.getFullYear();
  const [form, setForm] = useState({
    year: yr,
    period: "1H" as Period,
    name: `${yr}년 상반기`,
    start_date: `${yr}-01-01`,
    end_date: `${yr}-06-30`,
    self_due: `${yr}-07-15`,
    manager_due: `${yr}-07-31`,
    finalize_due: `${yr}-08-15`,
  });

  // period 토글 시 기본 날짜 자동 보정.
  useEffect(() => {
    if (form.period === "1H") {
      setForm((p) => ({
        ...p,
        name: `${p.year}년 상반기`,
        start_date: `${p.year}-01-01`,
        end_date: `${p.year}-06-30`,
        self_due: `${p.year}-07-15`,
        manager_due: `${p.year}-07-31`,
        finalize_due: `${p.year}-08-15`,
      }));
    } else {
      setForm((p) => ({
        ...p,
        name: `${p.year}년 하반기`,
        start_date: `${p.year}-07-01`,
        end_date: `${p.year}-12-31`,
        self_due: `${p.year + 1}-01-15`,
        manager_due: `${p.year + 1}-01-31`,
        finalize_due: `${p.year + 1}-02-15`,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.period, form.year]);

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post("/evaluations/cycles", form)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["evals", "cycles"] });
      onClose();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "생성 실패", { title: "오류" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-md border border-border p-4 w-[480px] flex flex-col gap-3">
        <h3 className="text-sm font-semibold">신규 평가 주기</h3>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Field label="연도">
            <input
              type="number"
              value={form.year}
              onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
          <Field label="반기">
            <select
              value={form.period}
              onChange={(e) => setForm({ ...form, period: e.target.value as Period })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            >
              <option value="1H">1H (상반기)</option>
              <option value="2H">2H (하반기)</option>
            </select>
          </Field>
          <Field label="이름" col2>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
          <Field label="시작일">
            <input
              type="date" value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
          <Field label="종료일">
            <input
              type="date" value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
          <Field label="자기평가 마감">
            <input
              type="date" value={form.self_due}
              onChange={(e) => setForm({ ...form, self_due: e.target.value })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
          <Field label="매니저 마감">
            <input
              type="date" value={form.manager_due}
              onChange={(e) => setForm({ ...form, manager_due: e.target.value })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
          <Field label="공개 마감" col2>
            <input
              type="date" value={form.finalize_due}
              onChange={(e) => setForm({ ...form, finalize_due: e.target.value })}
              className="h-7 w-full rounded-md border border-input bg-background px-2"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded-md border border-input bg-background px-3 text-xs hover:bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            disabled={createM.isPending}
            onClick={() => createM.mutate()}
            className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            생성
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  col2,
}: {
  label: string;
  children: React.ReactNode;
  col2?: boolean;
}) {
  return (
    <label className={"flex flex-col gap-0.5 " + (col2 ? "col-span-2" : "")}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 양식 설정 — competency dimensions bulk upsert.
// ---------------------------------------------------------------------------

type Dimension = {
  id?: string;
  key: string;
  label: string;
  description: string | null;
  sort_order: number;
  active: boolean;
};

function DimensionsSettingsTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const { data: dims = [] } = useQuery<Dimension[]>({
    queryKey: ["evals", "dimensions"],
    queryFn: async () => (await api.get("/evaluations/dimensions")).data,
  });
  const [draft, setDraft] = useState<Dimension[]>([]);
  useEffect(() => {
    // 활성 항목만 편집 대상 — 사용자가 "삭제" 한 항목(soft 비활성화) 이 다음
    // load 에 다시 보이는 혼란 회피. 비활성 항목의 데이터는 backend 에 보존됨.
    setDraft(dims.filter((d) => d.active).map((d) => ({ ...d })));
  }, [dims]);

  const saveM = useMutation({
    mutationFn: async () =>
      (
        await api.put("/evaluations/dimensions", {
          items: draft.map(({ id: _id, ...rest }) => rest),
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["evals", "dimensions"] });
      dialog.alert("양식이 저장되었습니다.", { title: "저장" });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  return (
    <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">역량 dimension 설정</h3>
        <button
          type="button"
          onClick={() =>
            setDraft([
              ...draft,
              {
                key: "",
                label: "",
                description: null,
                sort_order: (draft.at(-1)?.sort_order ?? 0) + 10,
                active: true,
              },
            ])
          }
          className="h-7 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-xs hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" /> 추가
        </button>
      </header>
      <table className="w-full text-xs">
        <thead className="bg-muted/30 text-muted-foreground">
          <tr>
            <th className="text-left px-2 py-1.5 w-32">key (slug)</th>
            <th className="text-left px-2 py-1.5 w-40">표시명</th>
            <th className="text-left px-2 py-1.5">설명</th>
            <th className="text-left px-2 py-1.5 w-16">순서</th>
            <th className="text-left px-2 py-1.5 w-12">활성</th>
            <th className="text-center px-2 py-1.5 w-10"></th>
          </tr>
        </thead>
        <tbody>
          {draft.map((d, idx) => (
            <tr key={idx} className="border-t border-border/50">
              <td className="px-2 py-1">
                <input
                  value={d.key}
                  onChange={(e) => {
                    const next = [...draft];
                    next[idx] = { ...d, key: e.target.value };
                    setDraft(next);
                  }}
                  className="h-7 w-full rounded-md border border-input bg-background px-2"
                />
              </td>
              <td className="px-2 py-1">
                <input
                  value={d.label}
                  onChange={(e) => {
                    const next = [...draft];
                    next[idx] = { ...d, label: e.target.value };
                    setDraft(next);
                  }}
                  className="h-7 w-full rounded-md border border-input bg-background px-2"
                />
              </td>
              <td className="px-2 py-1">
                <input
                  value={d.description ?? ""}
                  onChange={(e) => {
                    const next = [...draft];
                    next[idx] = { ...d, description: e.target.value || null };
                    setDraft(next);
                  }}
                  className="h-7 w-full rounded-md border border-input bg-background px-2"
                />
              </td>
              <td className="px-2 py-1">
                <input
                  type="number"
                  value={d.sort_order}
                  onChange={(e) => {
                    const next = [...draft];
                    next[idx] = { ...d, sort_order: Number(e.target.value) };
                    setDraft(next);
                  }}
                  className="h-7 w-16 rounded-md border border-input bg-background px-2"
                />
              </td>
              <td className="px-2 py-1 text-center">
                <input
                  type="checkbox"
                  checked={d.active}
                  onChange={(e) => {
                    const next = [...draft];
                    next[idx] = { ...d, active: e.target.checked };
                    setDraft(next);
                  }}
                />
              </td>
              <td className="px-2 py-1 text-center">
                <button
                  type="button"
                  onClick={async () => {
                    if (d.id) {
                      // 기존 항목 — backend 에 soft 비활성화. 점수 row 는 보존.
                      const ok = await dialog.confirm(
                        `'${d.label || d.key}' 항목을 삭제할까요? (이미 매겨진 점수는 보존됩니다.)`,
                        { title: "항목 삭제", confirmText: "삭제", destructive: true },
                      );
                      if (!ok) return;
                    }
                    setDraft(draft.filter((_, i) => i !== idx));
                  }}
                  className="h-6 inline-flex items-center justify-center rounded-md border border-destructive/40 bg-red-50 px-1.5 text-destructive hover:bg-red-100"
                  aria-label="항목 삭제"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={saveM.isPending}
          onClick={() => saveM.mutate()}
          className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          저장
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        * payload 에 없는 기존 key 는 자동 비활성화 (이미 진행 중인 평가의 점수
        row 는 보존). key (slug) 변경은 진행 중인 평가에 영향 — 가급적 유지.
      </p>
    </div>
  );
}
