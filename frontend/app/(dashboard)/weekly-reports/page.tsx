"use client";

/**
 * 주간보고 — 랜딩 (매트릭스 + 탭).
 *
 * 탭:
 *   내 보고서  : 본인 row 만 (작성한 적 있는 모든 주)
 *   팀 보고서  : 직속 후손 (manager chain) 의 row — 매니저에게만 노출
 *   전체       : HR/ADMIN 만 노출
 *   양식·지정자: HR/ADMIN — Settings 로 직접 이동 (보드 연결)
 *
 * 셀 클릭 시:
 *   - 본인 셀 — POST /weekly-reports lazy create → 받은 id 로 detail 이동
 *   - 다른 사람 셀 (매니저/관리자 가시) — 기존 id 만 열기, 새로 만들 수 없음
 *
 * 화면 표시 범위: 최근 12 주 + 다음 1 주. 무한 스크롤은 미지원.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  Clock,
  FileText,
  Plus,
  RotateCcw,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { ThisWeekCalendar } from "@/components/weekly-reports/ThisWeekCalendar";
import { MyProjectsGantt } from "@/components/weekly-reports/MyProjectsGantt";
import {
  isoWeekOf,
  isoWeekKey,
  shiftWeek,
  weekRange,
  type IsoWeek,
} from "@/lib/iso-week";

type Scope = "me" | "team" | "all";

type ReportRow = {
  id: string;
  developer_id: string;
  developer_name: string | null;
  iso_year: number;
  iso_week: number;
  week_start: string;
  week_end: string;
  status: "DRAFT" | "SUBMITTED";
  submitted_at: string | null;
  attachment_count: number;
  can_edit: boolean;
  updated_at: string;
};

const VISIBLE_WEEKS = 13; // 최근 12주 + 다음 1주

/**
 * 주간보고 첨부 다운로드 — JWT 가 쿠키지만 axios 인터셉터가 Bearer 헤더로
 * 변환하므로 <a href> 직링크 대신 blob → object URL 패턴. 상세 페이지의
 * downloadAtt 와 동일 흐름.
 */
async function downloadWeeklyAttachment(aid: string, filename: string) {
  try {
    const res = await api.get(`/weekly-reports/attachments/${aid}`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("attachment download failed", err);
    alert("첨부 다운로드 실패");
  }
}

export default function WeeklyReportsPage() {
  const router = useRouter();
  const qc = useQueryClient();

  const { data: me } = useQuery<{ role: string; mapped_developer_id: string | null }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const isAdminHr = me?.role === "ADMIN" || me?.role === "HR";

  const [scope, setScope] = useState<Scope>("me");
  // '팀 보고서' 탭의 보기 모드 — matrix(주별 grid) vs stack(이번 주 모아보기).
  const [teamMode, setTeamMode] = useState<"matrix" | "stack">("matrix");

  // anchor = 매트릭스 / 주간 달력의 '기준 주'. 기본 = 오늘 주.
  // 매트릭스는 anchor +1 (다음 주) → anchor -11 (11주 전) = 13주 윈도우.
  // 주간 달력은 anchor 주 그대로 표시.
  const today = new Date();
  const todayWeek = useMemo(() => isoWeekOf(today), [today.toDateString()]);
  const [anchor, setAnchor] = useState<IsoWeek>(() => isoWeekOf(new Date()));
  const isAtToday = isoWeekKey(anchor) === isoWeekKey(todayWeek);

  const weeks: IsoWeek[] = useMemo(() => {
    const list: IsoWeek[] = [];
    // 다음 주(anchor+1) 부터 anchor 거쳐 11주 전까지.
    for (let i = 1; i >= -VISIBLE_WEEKS + 2; i -= 1) {
      list.push(shiftWeek(anchor, i));
    }
    return list;
  }, [anchor]);
  const fromW = weeks[weeks.length - 1];
  const toW = weeks[0];

  const { data: rows = [] } = useQuery<ReportRow[]>({
    queryKey: ["weekly-reports", scope, fromW, toW],
    queryFn: async () =>
      (
        await api.get("/weekly-reports", {
          params: {
            owner: scope,
            from_year: fromW.year,
            from_week: fromW.week,
            to_year: toW.year,
            to_week: toW.week,
          },
        })
      ).data,
    enabled: !!me,
  });

  // 팀 보고서 stack 모드 — anchor 한 주 + body 포함. 모드 전환 / 주 이동 시 refetch.
  type ReportFull = ReportRow & {
    body: string | null;
    plain_text: string | null;
    attachments: { id: string; file_name: string; size: number | null }[];
  };
  const { data: stackRows = [] } = useQuery<ReportFull[]>({
    queryKey: ["weekly-reports-stack", anchor.year, anchor.week],
    queryFn: async () =>
      (
        await api.get("/weekly-reports", {
          params: {
            owner: "team",
            from_year: anchor.year,
            from_week: anchor.week,
            to_year: anchor.year,
            to_week: anchor.week,
            include_body: true,
          },
        })
      ).data,
    enabled: scope === "team" && teamMode === "stack",
    staleTime: 30_000,
  });

  // '전체' / '팀' 탭은 보고서가 한 번도 없는 직원도 row 로 표시해야 하므로
  // 정규직 디렉토리(/developers/org-chart) 를 함께 fetch. '내 보고서' 는 본인
  // 한 명이라 디렉토리 불필요. rank/position/report_count 는 '전체' 탭의 부가
  // 컬럼(직위·직책·매니저) 에도 사용.
  type OrgRow = {
    id: string;
    name: string;
    manager_id: string | null;
    report_count: number;
    rank_name: string | null;
    position_name: string | null;
  };
  const { data: orgRows = [] } = useQuery<OrgRow[]>({
    queryKey: ["developers-org-chart-light"],
    queryFn: async () =>
      (await api.get("/developers/org-chart")).data,
    staleTime: 5 * 60_000,
    enabled: !!me && (scope === "all" || scope === "team"),
  });

  // 셀 lookup: (dev_id, year-week) → row
  const cellMap = useMemo(() => {
    const m = new Map<string, ReportRow>();
    for (const r of rows) {
      m.set(`${r.developer_id}:${r.iso_year}-${r.iso_week}`, r);
    }
    return m;
  }, [rows]);

  // 매트릭스의 row 정보 (이름·직위·직책·매니저 등). 보고서가 한 번도 없는
  // 직원도 row 로 포함.
  type DevRow = {
    id: string;
    name: string;
    rank_name: string | null;
    position_name: string | null;
    is_manager: boolean;
  };
  const developers = useMemo<DevRow[]>(() => {
    const seen = new Map<string, DevRow>();
    const fromOrg = (d: OrgRow): DevRow => ({
      id: d.id,
      name: d.name,
      rank_name: d.rank_name,
      position_name: d.position_name,
      is_manager: d.report_count > 0,
    });

    if (scope === "all") {
      // 정규직 전원 표시 (보고서 한 번도 없어도).
      for (const d of orgRows) seen.set(d.id, fromOrg(d));
    } else if (scope === "team") {
      // 직속 부하 chain — 본인 후손 (depth 10 이내) 모두 포함, 본인 제외.
      const myId = me?.mapped_developer_id ?? null;
      if (myId) {
        const idToDev = new Map(orgRows.map((d) => [d.id, d]));
        const direct: string[] = orgRows
          .filter((d) => d.manager_id === myId)
          .map((d) => d.id);
        const visited = new Set<string>();
        const stack = [...direct];
        while (stack.length) {
          const cur = stack.pop()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          for (const d of orgRows) {
            if (d.manager_id === cur) stack.push(d.id);
          }
        }
        for (const did of visited) {
          const d = idToDev.get(did);
          if (d) seen.set(did, fromOrg(d));
        }
      }
    }

    // 보고서 row 에만 있는 직원도 추가 (퇴사자·directory 제외 등 corner case).
    for (const r of rows) {
      if (!seen.has(r.developer_id)) {
        seen.set(r.developer_id, {
          id: r.developer_id,
          name: r.developer_name ?? "(이름 없음)",
          rank_name: null,
          position_name: null,
          is_manager: false,
        });
      }
    }

    // 본인 먼저, 그 외 이름 가나다.
    const arr = [...seen.values()];
    arr.sort((a, b) => {
      if (a.id === me?.mapped_developer_id) return -1;
      if (b.id === me?.mapped_developer_id) return 1;
      return a.name.localeCompare(b.name, "ko-KR");
    });
    return arr;
  }, [rows, orgRows, scope, me?.mapped_developer_id]);

  // 본인 셀 클릭 — lazy create 후 detail 이동.
  const lazyCreateM = useMutation({
    mutationFn: async (input: {
      developer_id: string;
      iso_year: number;
      iso_week: number;
    }) => (await api.post("/weekly-reports", input)).data as ReportRow,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["weekly-reports"] });
      router.push(`/weekly-reports/${data.id}`);
    },
  });

  const onCellClick = (devId: string, w: IsoWeek) => {
    const key = `${devId}:${w.year}-${w.week}`;
    const existing = cellMap.get(key);
    if (existing) {
      router.push(`/weekly-reports/${existing.id}`);
      return;
    }
    if (devId !== me?.mapped_developer_id) {
      // 미작성 — 본인 행이 아니면 창 안 띄움.
      return;
    }
    lazyCreateM.mutate({
      developer_id: devId,
      iso_year: w.year,
      iso_week: w.week,
    });
  };

  const visibleScopes: { key: Scope; label: string }[] = [
    { key: "me", label: "내 보고서" },
  ];
  if (me?.mapped_developer_id) visibleScopes.push({ key: "team", label: "팀 보고서" });
  if (isAdminHr) visibleScopes.push({ key: "all", label: "전체" });

  return (
    <>
      <DashboardHeader title="주간보고" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <TabBar className="flex-1 min-w-0">
            {visibleScopes.map((s) => (
              <TabItem key={s.key} active={scope === s.key} onClick={() => setScope(s.key)}>
                {s.label}
              </TabItem>
            ))}
          </TabBar>
          {/* '팀 보고서' 탭 한정 — 매트릭스 vs 모아보기 토글. 모아보기는
              anchor 한 주의 모든 부하 본문을 카드 stack 으로 표시. */}
          {scope === "team" && (
            <div className="flex items-center gap-0 shrink-0 rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setTeamMode("matrix")}
                className={
                  "h-7 px-2 text-xs " +
                  (teamMode === "matrix"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted")
                }
                title="주 단위 그리드 보기"
              >
                매트릭스
              </button>
              <button
                type="button"
                onClick={() => setTeamMode("stack")}
                className={
                  "h-7 px-2 text-xs border-l border-border " +
                  (teamMode === "stack"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted")
                }
                title="이번 주(또는 선택 주) 모아보기 — 부하별 카드 stack"
              >
                모아보기
              </button>
            </div>
          )}
          {/* 윈도우 이동 — ◀◀ 13주씩, ◀ 1주씩, [오늘] 기본 위치 복귀, ▶ ▶▶ 동일 */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setAnchor((a) => shiftWeek(a, -VISIBLE_WEEKS))}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              title="13주 이전"
              aria-label="13주 이전"
            >
              <ChevronsLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setAnchor((a) => shiftWeek(a, -1))}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              title="1주 이전"
              aria-label="1주 이전"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setAnchor(todayWeek)}
              disabled={isAtToday}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              title="이번 주 기준으로"
            >
              <RotateCcw className="h-3 w-3" />
              오늘
            </button>
            <button
              type="button"
              onClick={() => setAnchor((a) => shiftWeek(a, 1))}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              title="1주 이후"
              aria-label="1주 이후"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setAnchor((a) => shiftWeek(a, VISIBLE_WEEKS))}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              title="13주 이후"
              aria-label="13주 이후"
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </button>
            {/* anchor 한 주의 SUBMITTED 보고서 모음을 새 창에 띄워 인쇄. 팀
                보고서 / 전체 탭에서만 — 본인 1명짜리 '내 보고서' 탭은 의미가
                없어 미노출. dashboard 라우트 그룹 밖 페이지라 사이드바 없이
                깔끔하게 인쇄 가능. */}
            {(scope === "team" || scope === "all") && (
              <button
                type="button"
                onClick={() => {
                  const url =
                    `/weekly-reports-print?scope=${scope}` +
                    `&year=${anchor.year}&week=${anchor.week}`;
                  window.open(url, "_blank", "width=1024,height=900");
                }}
                className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
                title="anchor 한 주의 제출된 보고서 PDF 인쇄"
                aria-label="PDF 인쇄"
              >
                <FileText className="h-3.5 w-3.5" />
                PDF
              </button>
            )}
          </div>
        </div>

        {/* '내 보고서' 탭에서만 — 주간 일정(legend 포함) + 내 프로젝트 투입
            Gantt. 주간 일정은 anchor (◀ / ▶ 로 이동) 에 맞춰 같이 변경. */}
        {scope === "me" && <ThisWeekCalendar week={anchor} />}
        {scope === "me" && me?.mapped_developer_id && (
          <MyProjectsGantt myDeveloperId={me.mapped_developer_id} />
        )}

        {developers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {scope === "me"
              ? "이번 주 보고서를 시작하세요. 아래 본인 행에서 미작성 셀 클릭 → 새 작성."
              : "표시할 데이터가 없습니다."}
            {scope === "me" && me?.mapped_developer_id && (
              <div className="mt-3 inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onCellClick(me.mapped_developer_id!, isoWeekOf(today))
                  }
                  className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
                >
                  <Plus className="h-3.5 w-3.5" />
                  이번 주 새로 작성
                </button>
              </div>
            )}
          </div>
        ) : scope === "team" && teamMode === "stack" ? (
          <TeamWeekStack
            anchor={anchor}
            developers={developers}
            stackRows={stackRows}
          />
        ) : (
          <Matrix
            developers={developers}
            weeks={weeks}
            cellMap={cellMap}
            onCellClick={onCellClick}
            myDeveloperId={me?.mapped_developer_id ?? null}
            today={today}
            showDirectoryCols={scope !== "me"}
          />
        )}

        <div className="text-[11px] text-muted-foreground">
          ✓ 제출 / ● 작성중 / — 미작성(이번주·미래) / ✗ 미작성(과거, 지각).
          본인 셀 클릭 → 새로 작성·이어 작성. 매니저 / 관리자는 다른 사람 셀
          클릭으로 작성된 보고서를 읽을 수 있습니다.
        </div>
      </div>
    </>
  );
}

type MatrixDevRow = {
  id: string;
  name: string;
  rank_name: string | null;
  position_name: string | null;
  is_manager: boolean;
};

// 팀 보고서 — '모아보기' 카드 stack. 한 anchor 주에 대해 부하별 카드 1개.
// 정렬: 미작성(우선) → DRAFT(작성중) → SUBMITTED(제출), 같은 그룹은 이름순.
function TeamWeekStack({
  anchor,
  developers,
  stackRows,
}: {
  anchor: IsoWeek;
  developers: MatrixDevRow[];
  stackRows: (ReportRow & {
    body: string | null;
    plain_text: string | null;
    attachments: { id: string; file_name: string; size: number | null }[];
  })[];
}) {
  // developer_id → row.
  const byDev = new Map(stackRows.map((r) => [r.developer_id, r]));
  // 본인 제외 (팀 = 부하만).
  const items = developers
    .filter((d) => byDev.has(d.id) || true) // 미작성도 포함
    .map((d) => ({ dev: d, report: byDev.get(d.id) }));

  const order = (it: { report?: typeof stackRows[number] }) => {
    if (!it.report) return 0; // 미작성 우선
    if (it.report.status === "DRAFT") return 1;
    return 2; // SUBMITTED
  };
  items.sort((a, b) => {
    const ao = order(a);
    const bo = order(b);
    if (ao !== bo) return ao - bo;
    return a.dev.name.localeCompare(b.dev.name, "ko-KR");
  });

  const r = weekRange(anchor.year, anchor.week);
  const md = (n: number) => String(n).padStart(2, "0");
  const weekLbl =
    `${anchor.year}-W${String(anchor.week).padStart(2, "0")} ` +
    `(${md(r.start.getMonth() + 1)}.${md(r.start.getDate())} ~ ` +
    `${md(r.end.getMonth() + 1)}.${md(r.end.getDate())})`;

  // 카운트.
  const submitted = items.filter((it) => it.report?.status === "SUBMITTED").length;
  const draft = items.filter((it) => it.report?.status === "DRAFT").length;
  const missing = items.filter((it) => !it.report).length;

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2 px-1 shrink-0">
        <div className="text-sm font-semibold">
          팀 모아보기 — <span className="tabular-nums">{weekLbl}</span>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          제출 {submitted} · 작성중 {draft} · 미작성 {missing} · 합계 {items.length}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          표시할 부하가 없습니다.
        </div>
      ) : (
        // 부하 카드 stack — 부하 수가 많을 때 페이지 전체가 늘어나지 않도록
        // 자체 영역에서 스크롤. 페이지 외곽(헤더·legend) 은 고정.
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
          {items.map(({ dev, report }) => (
            <ReportCard key={dev.id} dev={dev} report={report} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({
  dev,
  report,
}: {
  dev: MatrixDevRow;
  report?: ReportRow & {
    body: string | null;
    plain_text: string | null;
    attachments: { id: string; file_name: string; size: number | null }[];
  };
}) {
  const status = report?.status; // SUBMITTED | DRAFT | undefined
  const statusChip =
    status === "SUBMITTED"
      ? { cls: "border-emerald-300 bg-emerald-50 text-emerald-700", label: "제출 완료" }
      : status === "DRAFT"
        ? { cls: "border-amber-300 bg-amber-50 text-amber-700", label: "작성중" }
        : { cls: "border-rose-300 bg-rose-50 text-rose-700", label: "미작성" };

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap">
        <span className="font-semibold text-sm">{dev.name}</span>
        {dev.is_manager && (
          <span className="inline-flex items-center rounded-full border border-blue-300 bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[10px] font-semibold">
            매니저
          </span>
        )}
        {dev.rank_name && (
          <span className="text-xs text-muted-foreground">{dev.rank_name}</span>
        )}
        {dev.position_name && (
          <span className="text-xs text-muted-foreground">· {dev.position_name}</span>
        )}
        <span
          className={
            "ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold " +
            statusChip.cls
          }
        >
          {statusChip.label}
        </span>
        {report && (
          <Link
            href={`/weekly-reports/${report.id}`}
            className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
          >
            상세 <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="px-4 py-3 text-sm">
        {!report ? (
          <div className="text-muted-foreground italic">
            이번 주 보고서가 작성되지 않았습니다.
          </div>
        ) : !report.body ? (
          <div className="text-muted-foreground italic">본문 없음</div>
        ) : (
          // TipTap HTML 직접 렌더 — board/공지/목표 viewer 와 동일.
          <div
            className="tiptap-content"
            dangerouslySetInnerHTML={{ __html: report.body }}
          />
        )}
        {report && report.attachments.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="text-xs font-semibold mb-1 text-muted-foreground">
              첨부 ({report.attachments.length})
            </div>
            <ul className="text-xs space-y-0.5">
              {report.attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => downloadWeeklyAttachment(a.id, a.file_name)}
                    className="flex-1 truncate text-left text-primary hover:underline"
                    title="다운로드"
                  >
                    {a.file_name}
                  </button>
                  <span className="text-muted-foreground tabular-nums">
                    {a.size ? `${(a.size / 1024).toFixed(1)} KB` : "-"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Matrix({
  developers,
  weeks,
  cellMap,
  onCellClick,
  myDeveloperId,
  today,
  showDirectoryCols,
}: {
  developers: MatrixDevRow[];
  weeks: IsoWeek[];
  cellMap: Map<string, ReportRow>;
  onCellClick: (devId: string, w: IsoWeek) => void;
  myDeveloperId: string | null;
  today: Date;
  showDirectoryCols: boolean;
}) {
  const todayKey = isoWeekKey(isoWeekOf(today));
  const md = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="overflow-auto rounded-md border border-border bg-card">
      <table className="text-xs min-w-full">
        <thead className="sticky top-0 bg-muted/40 z-10">
          <tr>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border min-w-[120px] sticky left-0 bg-muted/40 z-20">
              임직원
            </th>
            {showDirectoryCols && (
              <>
                <th className="text-left px-2 py-2 font-medium text-muted-foreground border-b border-border min-w-[80px]">
                  직위
                </th>
                <th className="text-left px-2 py-2 font-medium text-muted-foreground border-b border-border min-w-[80px]">
                  직책
                </th>
                <th className="text-center px-2 py-2 font-medium text-muted-foreground border-b border-border w-[60px]">
                  매니저
                </th>
              </>
            )}
            {weeks.map((w) => {
              const isCurrent = isoWeekKey(w) === todayKey;
              const r = weekRange(w.year, w.week);
              const range =
                `${md(r.start.getMonth() + 1)}.${md(r.start.getDate())}` +
                `~` +
                `${md(r.end.getMonth() + 1)}.${md(r.end.getDate())}`;
              return (
                <th
                  key={`${w.year}-${w.week}`}
                  className={
                    "px-2 py-2 font-medium border-b border-border " +
                    (isCurrent ? "text-primary font-semibold" : "text-muted-foreground")
                  }
                  title={`${w.year}-W${String(w.week).padStart(2, "0")} (${range})`}
                >
                  <div className="flex flex-col items-center leading-tight">
                    <span className="tabular-nums">W{String(w.week).padStart(2, "0")}</span>
                    <span className="text-[10px] font-normal opacity-80 tabular-nums">
                      {range}
                    </span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {developers.map((d) => {
            const isMe = d.id === myDeveloperId;
            return (
              <tr key={d.id} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5 text-foreground sticky left-0 bg-card font-medium">
                  {d.name}
                  {isMe && (
                    <span className="ml-1 text-[10px] text-primary">(나)</span>
                  )}
                </td>
                {showDirectoryCols && (
                  <>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {d.rank_name ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {d.position_name ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {d.is_manager ? (
                        <span className="inline-flex items-center rounded-full border border-blue-300 bg-blue-50 text-blue-700 px-1.5 py-0.5 text-[10px] font-semibold">
                          매니저
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </>
                )}
                {weeks.map((w) => {
                  const cellKey = `${d.id}:${w.year}-${w.week}`;
                  const r = cellMap.get(cellKey);
                  const wk = isoWeekKey(w);
                  const isPast = wk < todayKey;
                  const isCurrent = wk === todayKey;
                  return (
                    <td key={cellKey} className="text-center p-1">
                      <Cell
                        row={r}
                        isPast={isPast}
                        isCurrent={isCurrent}
                        canCreate={isMe && !r}
                        onClick={() => onCellClick(d.id, w)}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  row,
  isPast,
  isCurrent,
  canCreate,
  onClick,
}: {
  row: ReportRow | undefined;
  isPast: boolean;
  isCurrent: boolean;
  canCreate: boolean;
  onClick: () => void;
}) {
  let content: React.ReactNode;
  let cls = "h-7 w-7 inline-flex items-center justify-center rounded transition-colors ";
  if (row?.status === "SUBMITTED") {
    content = <CheckCircle2 className="h-4 w-4" />;
    cls += "text-emerald-600 hover:bg-emerald-50";
  } else if (row?.status === "DRAFT") {
    content = <Circle className="h-4 w-4 fill-amber-100" />;
    cls += "text-amber-600 hover:bg-amber-50";
  } else if (canCreate && (isCurrent || !isPast)) {
    content = <Plus className="h-3.5 w-3.5" />;
    cls += "text-primary hover:bg-primary/10";
  } else if (canCreate && isPast) {
    content = <Plus className="h-3.5 w-3.5" />;
    cls += "text-rose-500 hover:bg-rose-50";
  } else if (isPast) {
    content = <span className="text-rose-500 font-bold">✗</span>;
    cls += "text-rose-500";
  } else {
    content = <span className="text-muted-foreground/50">—</span>;
    cls += "text-muted-foreground/50";
  }
  // 클릭 가능 여부 — 행이 있거나, 본인 + 새로 만들 수 있을 때.
  const clickable = !!row || canCreate;
  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={
        cls +
        (clickable ? " cursor-pointer" : " cursor-default") +
        (isCurrent ? " ring-1 ring-primary/40" : "")
      }
      title={
        row
          ? `${row.status === "SUBMITTED" ? "제출 완료" : "작성중"} · ${row.attachment_count}첨부`
          : canCreate
            ? "새로 작성"
            : isPast
              ? "미작성 (지각)"
              : "미작성"
      }
    >
      {content}
    </button>
  );
}
