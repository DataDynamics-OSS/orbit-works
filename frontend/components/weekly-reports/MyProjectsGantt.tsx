"use client";

/**
 * 주간보고 — 내 프로젝트 투입 Gantt (이번 해).
 *
 * sidebar > 인력투입(`/assignments`) 의 본인 row 만 추출한 mini-Gantt.
 * 각 프로젝트별 본인 투입 기간 막대 + 오늘 marker. 프로젝트 색상은
 * 프로젝트 이름 가나다순에 PROJECT_PALETTE 매핑.
 *
 * 데이터: GET /pickers/my-assignments?year=YYYY (본인 row 만, 메뉴 가드 없음)
 *        + GET /pickers/projects (이름 lookup, 메뉴 가드 없음).
 *
 * 도메인 라우터 (/assignments, /projects) 는 `_menu(...)` 로 SALES/HR 만 허용
 * 이라 ETC 직원은 본인 투입조차 못 보던 회기를 picker 라우터로 우회.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

// 프로젝트 상세 이동 권한 — ADMIN/HR 만. 그 외는 텍스트만 노출.

type Assignment = {
  id: string;
  project_id: string;
  developer_id: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD
  is_insourced: boolean;
};

type Project = {
  id: string;
  name: string;
};

const PROJECT_PALETTE = [
  "#3b82f6", "#ef4444", "#f97316", "#10b981", "#8b5cf6",
  "#f59e0b", "#ec4899", "#14b8a6", "#6366f1", "#22c55e",
  "#eab308", "#06b6d4", "#a855f7", "#d946ef", "#84cc16",
  "#f43f5e", "#0ea5e9", "#64748b", "#78716c", "#7c3aed",
];

type Props = {
  myDeveloperId: string;
};

export function MyProjectsGantt({ myDeveloperId }: Props) {
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canViewProject = me?.role === "ADMIN" || me?.role === "HR";

  const year = new Date().getFullYear();

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ["my-assignments", myDeveloperId, year],
    queryFn: async () =>
      (
        await api.get("/pickers/my-assignments", {
          params: { year },
        })
      ).data,
    staleTime: 60_000,
  });

  // 프로젝트 이름 — picker 라우터 (메뉴 가드 없음) 로 모든 role 호출.
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["pickers", "projects"],
    queryFn: async () => (await api.get("/pickers/projects")).data,
    staleTime: 5 * 60_000,
  });
  const projMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // 프로젝트별 색상 — 본 row 에 등장 순서대로 매핑.
  const projectColors = useMemo(() => {
    const order: string[] = [];
    for (const a of assignments) {
      if (!order.includes(a.project_id)) order.push(a.project_id);
    }
    const m = new Map<string, string>();
    order.forEach((pid, i) =>
      m.set(pid, PROJECT_PALETTE[i % PROJECT_PALETTE.length]),
    );
    return m;
  }, [assignments]);

  // 프로젝트별 grouping (한 프로젝트 안에서 여러 기간이 있을 수 있음).
  const perProject = useMemo(() => {
    const m = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const arr = m.get(a.project_id) ?? [];
      arr.push(a);
      m.set(a.project_id, arr);
    }
    return [...m.entries()]
      .map(([pid, list]) => ({
        pid,
        name: projMap.get(pid)?.name ?? "(삭제됨)",
        list: list.sort((a, b) => a.start_date.localeCompare(b.start_date)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"));
  }, [assignments, projMap]);

  // 연도 timeline.
  const start = new Date(`${year}-01-01T00:00:00`).getTime();
  const end = new Date(`${year + 1}-01-01T00:00:00`).getTime();
  const totalMs = end - start;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - start) / totalMs) * 100));
  const today = Date.now();
  const todayInRange = today >= start && today < end;
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(year, i, 1).getTime(),
  );

  const ROW_H = 28;
  const LABEL_W = 200;

  return (
    <section className="rounded-md border border-border bg-card">
      <header className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-sm font-semibold">
          내 프로젝트 투입 (이번 해)
          {perProject.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {perProject.length}개 프로젝트
            </span>
          )}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">{year}년</span>
      </header>

      {perProject.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground italic">
          올해 투입된 프로젝트가 없습니다.
        </div>
      ) : (
        <div className="overflow-auto">
          {/* 월 헤더 */}
          <div className="flex border-b border-border bg-muted/20">
            <div
              className="shrink-0 px-3 py-1.5 text-xs font-semibold border-r border-border"
              style={{ width: LABEL_W }}
            >
              프로젝트
            </div>
            <div className="flex-1 relative h-7">
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 h-full border-l border-border text-[11px] text-muted-foreground"
                  style={{ left: `${pct(m)}%` }}
                >
                  <span className="pl-1">{i + 1}월</span>
                </div>
              ))}
              {todayInRange && (
                <div
                  className="absolute top-0 h-full border-l-2 border-red-500/60"
                  style={{ left: `${pct(today)}%` }}
                  title="오늘"
                />
              )}
            </div>
          </div>

          {/* 프로젝트 row */}
          {perProject.map(({ pid, name, list }) => {
            const color = projectColors.get(pid) ?? "#64748b";
            const proj = projMap.get(pid);
            return (
              <div
                key={pid}
                className="flex border-b border-border/50 last:border-0 hover:bg-muted/20"
              >
                <div
                  className="shrink-0 px-3 py-1.5 flex items-start gap-1.5 text-xs border-r border-border"
                  style={{ width: LABEL_W }}
                >
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1"
                    style={{ backgroundColor: color }}
                  />
                  {canViewProject ? (
                    <Link
                      href={`/projects/${pid}`}
                      className="font-medium hover:underline break-words whitespace-normal leading-tight"
                      title={name}
                    >
                      {name}
                    </Link>
                  ) : (
                    <span
                      className="font-medium break-words whitespace-normal leading-tight"
                      title={name}
                    >
                      {name}
                    </span>
                  )}
                </div>
                <div className="flex-1 relative" style={{ minHeight: ROW_H }}>
                  {/* 월 격자 — visual guide */}
                  {months.map((m, i) => (
                    <div
                      key={i}
                      className="absolute top-0 h-full border-l border-border/40"
                      style={{ left: `${pct(m)}%` }}
                    />
                  ))}
                  {/* 오늘 — visual marker */}
                  {todayInRange && (
                    <div
                      className="absolute top-0 h-full border-l-2 border-red-500/60 z-[1]"
                      style={{ left: `${pct(today)}%` }}
                    />
                  )}
                  {/* 투입 기간 막대 */}
                  {list.map((a) => {
                    const s = new Date(`${a.start_date}T00:00:00`).getTime();
                    const e = new Date(`${a.end_date}T23:59:59`).getTime();
                    const left = pct(s);
                    const right = pct(e);
                    const width = Math.max(0.4, right - left);
                    return (
                      <div
                        key={a.id}
                        className="absolute rounded shadow-sm cursor-default"
                        style={{
                          top: 4,
                          height: ROW_H - 8,
                          left: `${left}%`,
                          width: `${width}%`,
                          backgroundColor: color,
                          opacity: 0.85,
                        }}
                        title={`${name} · ${a.start_date} ~ ${a.end_date}`}
                      />
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
