"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Tooltip } from "@/components/ui/Tooltip";

type Assignment = {
  id: string;
  project_id: string;
  developer_id: string;
  developer_name?: string;
  project_name?: string;
  start_date: string;
  end_date: string;
  is_insourced: boolean;
  color?: string | null;
};

type Project = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
};

type Developer = {
  id: string;
  name: string;
  employment_type: "FULL_TIME" | "FREELANCER" | "INSOURCED";
  status: "ACTIVE" | "INACTIVE";
};

const EMP_LABEL: Record<Developer["employment_type"], string> = {
  FULL_TIME: "정규직",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
};

const EMP_BADGE: Record<Developer["employment_type"], string> = {
  FULL_TIME: "bg-blue-100 text-blue-700 border-blue-200",
  FREELANCER: "bg-red-100 text-red-700 border-red-200",
  INSOURCED: "bg-orange-100 text-orange-700 border-orange-200",
};

// 프로젝트 단위 색상 (Gantt 바). 같은 프로젝트는 같은 색상.
const PROJECT_PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#f97316",
  "#10b981",
  "#8b5cf6",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
  "#22c55e",
  "#eab308",
  "#06b6d4",
  "#a855f7",
  "#d946ef",
  "#84cc16",
  "#f43f5e",
  "#0ea5e9",
  "#64748b",
  "#78716c",
  "#7c3aed",
];

type GroupBy = "dev" | "project";

export default function AssignmentsPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ["assignments-year", year],
    queryFn: async () =>
      (
        await api.get("/assignments", {
          params: { month_start: yearStart, month_end: yearEnd },
        })
      ).data,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data,
    staleTime: 60_000,
  });

  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers-all"],
    queryFn: async () => (await api.get("/developers")).data,
    staleTime: 60_000,
  });

  const devMap = useMemo(
    () => new Map(developers.map((d) => [d.id, d])),
    [developers],
  );
  const projMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // 프로젝트별 색상 매핑 (연도 내 나타난 프로젝트 순서대로).
  const projectColors = useMemo(() => {
    const order: string[] = [];
    for (const a of assignments) {
      if (!order.includes(a.project_id)) order.push(a.project_id);
    }
    const m = new Map<string, string>();
    order.forEach((pid, i) => m.set(pid, PROJECT_PALETTE[i % PROJECT_PALETTE.length]));
    return m;
  }, [assignments]);

  // 개발자별 그룹핑 — 연도 내 어떤 프로젝트에든 투입된 사람만 노출.
  const perDev = useMemo(() => {
    const m = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const arr = m.get(a.developer_id) ?? [];
      arr.push(a);
      m.set(a.developer_id, arr);
    }
    return Array.from(m.entries())
      .map(([devId, list]) => ({
        dev: devMap.get(devId),
        devId,
        list: list.sort((a, b) => a.start_date.localeCompare(b.start_date)),
      }))
      .sort((a, b) => (a.dev?.name ?? "").localeCompare(b.dev?.name ?? ""));
  }, [assignments, devMap]);

  // 프로젝트별 그룹핑 — 같은 연도 데이터를 프로젝트 단위로 묶기. 프로젝트명 가나다 정렬.
  const perProject = useMemo(() => {
    const m = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const arr = m.get(a.project_id) ?? [];
      arr.push(a);
      m.set(a.project_id, arr);
    }
    return Array.from(m.entries())
      .map(([projId, list]) => ({
        proj: projMap.get(projId),
        projId,
        list: list.sort((a, b) => a.start_date.localeCompare(b.start_date)),
      }))
      .sort((a, b) =>
        (a.proj?.name ?? a.list[0]?.project_name ?? "").localeCompare(
          b.proj?.name ?? b.list[0]?.project_name ?? "",
        ),
      );
  }, [assignments, projMap]);

  // 그룹핑을 한 가지 row 구조로 정규화 — TimelineBoard 는 이것만 본다.
  const rows = useMemo<TimelineRow[]>(() => {
    if (groupBy === "project") {
      return perProject.map(({ proj, projId, list }) => ({
        id: projId,
        label: proj?.name ?? list[0]?.project_name ?? "(삭제됨)",
        href: `/projects/${projId}`,
        list,
      }));
    }
    return perDev.map(({ dev, devId, list }) => ({
      id: devId,
      label: dev?.name ?? "(알 수 없음)",
      href: `/employees/${devId}`,
      badges:
        dev?.employment_type
          ? [
              {
                label: EMP_LABEL[dev.employment_type],
                cls: EMP_BADGE[dev.employment_type],
              },
            ]
          : [],
      suffix: dev?.status === "INACTIVE" ? "(퇴사)" : undefined,
      list,
    }));
  }, [groupBy, perDev, perProject]);

  return (
    <>
      <DashboardHeader
        title="프로젝트 투입 현황 (연간)"
        actions={
          <div className="flex gap-2 items-center">
            <div className="inline-flex items-center rounded-md border border-border bg-card shadow-sm overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setGroupBy("dev")}
                className={`h-8 px-3 ${groupBy === "dev" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                aria-pressed={groupBy === "dev"}
              >
                사람별
              </button>
              <button
                type="button"
                onClick={() => setGroupBy("project")}
                className={`h-8 px-3 border-l border-border ${groupBy === "project" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                aria-pressed={groupBy === "project"}
              >
                프로젝트별
              </button>
            </div>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y - 1)}
              aria-label="이전 연도"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y + 1)}
              aria-label="다음 연도"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <TimelineBoard
          year={year}
          groupBy={groupBy}
          rows={rows}
          projMap={projMap}
          projectColors={projectColors}
        />
      </div>
    </>
  );
}

type TimelineRow = {
  id: string;
  label: string;
  href: string;
  badges?: { label: string; cls: string }[];
  /** 라벨 옆 작은 텍스트 (예: "(퇴사)"). */
  suffix?: string;
  list: Assignment[];
};

function TimelineBoard({
  year,
  groupBy,
  rows,
  projMap,
  projectColors,
}: {
  year: number;
  groupBy: GroupBy;
  rows: TimelineRow[];
  projMap: Map<string, Project>;
  projectColors: Map<string, string>;
}) {
  // 단일 바 높이 + 슬롯 간 간격. 한 행에 들어가는 바 수 = slotCount.
  // 한 슬롯 ROW 높이 = BAR_H + GAP; 첫 슬롯은 상단 여백 OUTER_PAD.
  const BAR_H = 24;
  const SLOT_GAP = 4;
  const OUTER_PAD = 4;
  const MIN_ROW_H = 32; // 빈 행도 최소 높이 유지.
  const LABEL_W = 240;

  // 같은 행 안에서 시간 구간이 겹치지 않는 바들은 같은 슬롯을 공유.
  // greedy interval scheduling — list 는 start_date 정렬 가정.
  function allocateSlots(list: Assignment[]): { slots: number[]; count: number } {
    const slotEnd: string[] = []; // 각 슬롯의 가장 최근 end_date
    const slots: number[] = [];
    for (const a of list) {
      let placed = -1;
      for (let s = 0; s < slotEnd.length; s++) {
        if (slotEnd[s] < a.start_date) {
          placed = s;
          slotEnd[s] = a.end_date;
          break;
        }
      }
      if (placed < 0) {
        placed = slotEnd.length;
        slotEnd.push(a.end_date);
      }
      slots.push(placed);
    }
    return { slots, count: Math.max(1, slotEnd.length) };
  }

  const start = new Date(`${year}-01-01T00:00:00`).getTime();
  const end = new Date(`${year + 1}-01-01T00:00:00`).getTime();
  const totalMs = end - start;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - start) / totalMs) * 100));

  const today = Date.now();
  const todayInRange = today >= start && today < end;

  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(year, i, 1).getTime(),
  );

  // Legend: only projects that appear this year.
  const legendProjects = Array.from(projectColors.entries())
    .map(([pid, color]) => ({ id: pid, color, name: projMap.get(pid)?.name ?? "(삭제됨)" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="font-semibold">
          {year}년 {groupBy === "project" ? "프로젝트별" : "엔지니어별"} 투입 현황
        </h2>
        <span className="text-xs text-muted-foreground">
          {groupBy === "project"
            ? `${rows.length}개 프로젝트`
            : `${rows.length}명 · ${legendProjects.length}개 프로젝트`}
        </span>
      </div>

      {legendProjects.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs mb-3">
          {legendProjects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 hover:bg-muted"
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: p.color, opacity: 0.8 }}
              />
              <span>{p.name}</span>
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          해당 연도에 투입된 인력이 없습니다.
        </p>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-auto">
          {/* Month header */}
          <div className="flex border-b border-border sticky top-0 z-10 bg-card">
            <div
              className="shrink-0 px-3 py-2 text-sm font-semibold bg-muted/40 border-r border-border"
              style={{ width: LABEL_W }}
            >
              {groupBy === "project" ? "프로젝트" : "인력"}
            </div>
            <div className="flex-1 relative bg-muted/20 h-9">
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full border-l border-border text-xs text-muted-foreground"
                  style={{ left: `${pct(m)}%` }}
                >
                  <span className="pl-1">{i + 1}월</span>
                </div>
              ))}
              {todayInRange && (
                <div
                  className="absolute top-0 h-full border-l-2 border-red-500/60"
                  style={{ left: `${pct(today)}%` }}
                />
              )}
            </div>
          </div>

          {rows.map((row) => {
            const { slots, count } = allocateSlots(row.list);
            const rowHeight = Math.max(
              MIN_ROW_H,
              OUTER_PAD * 2 + count * BAR_H + (count - 1) * SLOT_GAP,
            );
            return (
            <div
              key={row.id}
              className="flex border-b border-border hover:bg-muted/30"
            >
              <div
                className="shrink-0 px-3 py-1.5 flex items-start gap-2 text-sm border-r border-border bg-card"
                style={{ width: LABEL_W }}
              >
                <Tooltip label={row.label} side="top">
                  <Link
                    href={row.href}
                    className="font-medium hover:underline break-words"
                  >
                    {row.label}
                  </Link>
                </Tooltip>
                {row.badges?.map((b, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium shrink-0 ${b.cls}`}
                  >
                    {b.label}
                  </span>
                ))}
                {row.suffix && (
                  <span className="text-[10px] text-muted-foreground">
                    {row.suffix}
                  </span>
                )}
              </div>
              <div
                className="flex-1 relative"
                style={{ minHeight: rowHeight }}
              >
                {months.map((m, i) => (
                  <div
                    key={i}
                    className="absolute top-0 h-full border-l border-border/40"
                    style={{ left: `${pct(m)}%` }}
                  />
                ))}
                {todayInRange && (
                  <div
                    className="absolute top-0 h-full border-l-2 border-red-500/60"
                    style={{ left: `${pct(today)}%` }}
                  />
                )}
                {row.list.map((a, idx) => {
                  const s = new Date(`${a.start_date}T00:00:00`).getTime();
                  const e =
                    new Date(`${a.end_date}T00:00:00`).getTime() + 86_400_000;
                  const barStart = Math.max(start, s);
                  const barEnd = Math.min(end, e);
                  if (barEnd <= barStart) return null;
                  const left = pct(barStart);
                  const width = Math.max(1, pct(barEnd) - left);
                  const color =
                    projectColors.get(a.project_id) ?? PROJECT_PALETTE[0];
                  // 사람 그룹: 바 = 프로젝트. 프로젝트 그룹: 바 = 사람.
                  const barLabel =
                    groupBy === "project"
                      ? a.developer_name ?? "(인력)"
                      : a.project_name ?? "(프로젝트)";
                  const barHref =
                    groupBy === "project"
                      ? `/employees/${a.developer_id}`
                      : `/projects/${a.project_id}`;
                  const tooltipLabel =
                    groupBy === "project"
                      ? `${a.developer_name ?? ""} · ${a.start_date} ~ ${a.end_date}${a.is_insourced ? " · 자사화" : ""}`
                      : `${a.project_name ?? ""} · ${a.start_date} ~ ${a.end_date}${a.is_insourced ? " · 자사화" : ""}`;
                  const slot = slots[idx] ?? 0;
                  const top = OUTER_PAD + slot * (BAR_H + SLOT_GAP);
                  return (
                    <div
                      key={a.id}
                      className="group/tt absolute"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        top,
                        height: BAR_H,
                        // 바 색상 투명도 20% — Tooltip 은 portal 로 body 에 렌더되므로
                        // 영향 없음 (호버 시 글자는 선명하게 보임).
                        opacity: 0.8,
                      }}
                    >
                      <Link
                        href={barHref}
                        className="h-full w-full rounded px-2 flex items-center overflow-hidden whitespace-nowrap shadow-sm"
                        style={{
                          backgroundColor: color,
                          color: "#fff",
                          fontSize: 11,
                          border: a.is_insourced
                            ? "2px dashed rgba(255,255,255,0.7)"
                            : undefined,
                        }}
                      >
                        {barLabel}
                      </Link>
                      <Tooltip inline side="top" label={tooltipLabel} />
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
