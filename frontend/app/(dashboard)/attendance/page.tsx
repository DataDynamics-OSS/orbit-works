"use client";

/**
 * 출퇴근 모니터링 (admin) — sidebar > 근태 > 출퇴근 모니터링.
 *
 * 모드 3가지:
 * - 일 (DayGantt): 시간축 Gantt, 직원 가나다 순. 외근/반차/연차/결근/공휴일 색 구분.
 *   진행중 세션은 1분마다 우측 끝이 현재시각으로 갱신.
 * - 주 (WeekHeatmap): 7컬럼 (월~일) 히트맵.
 * - 월 (MonthMatrix): 직원 × 일자 매트릭스. 한눈에 패턴 파악.
 *
 * 권한: attendance.admin (HR + ADMIN). dashboard layout 가드 외에 페이지 진입
 * 시점에서도 me.permissions 확인.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Tooltip } from "@/components/ui/Tooltip";

// 다중 라인 툴팁 — 기본 Tooltip 의 whitespace-nowrap 을 풀고 라인별 div 로.
function MultilineTip({ lines }: { lines: string[] }) {
  return (
    <div className="text-left text-xs font-normal whitespace-normal">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

type Mode = "day" | "week" | "month";

type SessionRow = {
  id: string;
  check_in_at: string;
  check_out_at: string | null;
  check_in_within_radius: boolean | null;
  check_out_within_radius: boolean | null;
  check_in_distance_m: number | null;
  check_out_distance_m: number | null;
  check_in_reason: string | null;
  check_out_reason: string | null;
};

type LeaveInfo = {
  leave_type: "ANNUAL" | "HALF" | "UNPAID_PUBLIC";
  half_kind: "AM" | "PM" | null;
  category: string | null;
  reason: string | null;
};

type DailyDeveloper = {
  developer_id: string;
  name: string;
  employment_type: string;
  status: string;
  worksite: {
    id: string;
    name: string;
    address: string | null;
    radius_meters: number;
    work_start_time: string;
    work_end_time: string;
    projects: Array<{ id: string; name: string }>;
  } | null;
  leave: LeaveInfo | null;
  state: AttendanceState;
  sessions: SessionRow[];
};

type AttendanceState =
  | "NORMAL"
  | "IN_PROGRESS"
  | "NORMAL_OUT_OF_RANGE"
  | "LEAVE_ANNUAL"
  | "LEAVE_HALF_AM"
  | "LEAVE_HALF_PM"
  | "LEAVE_PUBLIC"
  | "ABSENT"
  | "HOLIDAY"
  | "WEEKEND"
  | "FUTURE"        // 아직 도래 안 한 날 — 결근으로 표시 X
  | "NOT_EMPLOYED"; // 입사 전 / 퇴사 후 — 그 사람의 재직 기간 밖

type DailyResponse = {
  date: string;
  is_holiday: boolean;
  holiday_name: string | null;
  is_weekend: boolean;
  developers: DailyDeveloper[];
};

type WeekDayCell = {
  date: string;
  weekday: number;
  state: AttendanceState;
  holiday_name: string | null;
  leave: LeaveInfo | null;
  summary: {
    minutes: number;
    first_in: string | null;
    last_out: string | null;
    has_open: boolean;
  } | null;
};

type WeeklyDeveloper = {
  developer_id: string;
  name: string;
  employment_type: string;
  status: string;
  days: WeekDayCell[];
};

type WeeklyResponse = {
  week_start: string;
  week_end: string;
  developers: WeeklyDeveloper[];
};

type MonthlyDay = WeekDayCell & { day: number };
type MonthlyDeveloper = {
  developer_id: string;
  name: string;
  employment_type: string;
  status: string;
  days: MonthlyDay[];
};
type MonthlyResponse = {
  year: number;
  month: number;
  days_in_month: number;
  developers: MonthlyDeveloper[];
};

// 색상 — 모드 공통.
const STATE_COLOR: Record<AttendanceState, string> = {
  NORMAL: "bg-emerald-500",
  IN_PROGRESS: "bg-emerald-500",
  NORMAL_OUT_OF_RANGE: "bg-amber-500",
  LEAVE_ANNUAL: "bg-sky-500",
  LEAVE_HALF_AM: "bg-sky-400",
  LEAVE_HALF_PM: "bg-sky-400",
  LEAVE_PUBLIC: "bg-violet-500",
  ABSENT: "bg-red-400",
  HOLIDAY: "bg-slate-300",
  WEEKEND: "bg-slate-200",
  FUTURE: "bg-transparent",       // 미래 날짜 — 비어있게
  NOT_EMPLOYED: "bg-slate-50",    // 재직 기간 밖 — 매우 옅은 회색
};

const STATE_LABEL: Record<AttendanceState, string> = {
  NORMAL: "정상",
  IN_PROGRESS: "진행중",
  NORMAL_OUT_OF_RANGE: "외근",
  LEAVE_ANNUAL: "연차",
  LEAVE_HALF_AM: "오전 반차",
  LEAVE_HALF_PM: "오후 반차",
  LEAVE_PUBLIC: "공가",
  ABSENT: "결근",
  HOLIDAY: "공휴일",
  WEEKEND: "주말",
  FUTURE: "—",
  NOT_EMPLOYED: "재직 기간 외",
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function startOfWeekMon(d: Date): Date {
  const day = d.getDay(); // 0=일
  const diff = day === 0 ? -6 : 1 - day;
  const r = new Date(d);
  r.setDate(d.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

type FilterFlags = {
  exclude_freelancer: boolean;
  exclude_resigned: boolean;
  exclude_directory: boolean;
};

export default function AttendanceMonitorPage() {
  const [mode, setMode] = useState<Mode>("day");
  const [date, setDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [query, setQuery] = useState("");
  // 3 개 필터 — 모두 기본 checked.
  const [filters, setFilters] = useState<FilterFlags>({
    exclude_freelancer: true,
    exclude_resigned: true,
    exclude_directory: true,
  });

  function shiftDate(delta: number) {
    setDate((d) => {
      const nd = new Date(d);
      if (mode === "day") nd.setDate(d.getDate() + delta);
      if (mode === "week") nd.setDate(d.getDate() + delta * 7);
      if (mode === "month") nd.setMonth(d.getMonth() + delta);
      return nd;
    });
  }

  const headerLabel = useMemo(() => {
    if (mode === "day") {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} (${"일월화수목금토"[date.getDay()]})`;
    }
    if (mode === "week") {
      const ws = startOfWeekMon(date);
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      return `${ymd(ws)} ~ ${ymd(we)}`;
    }
    return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
  }, [mode, date]);

  return (
    <>
      <DashboardHeader title="출퇴근 기록" />
      <div className="flex flex-col gap-3 p-4 min-h-0 flex-1">
        {/* 모드 + 네비 + 검색 */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {(["day", "week", "month"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={
                  "px-3 h-9 text-sm " +
                  (mode === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted")
                }
              >
                {m === "day" ? "일" : m === "week" ? "주" : "월"}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => shiftDate(-1)}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border hover:bg-muted"
              aria-label="이전"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-sm font-medium tabular-nums min-w-[180px] text-center">
              {headerLabel}
            </div>
            <button
              type="button"
              onClick={() => shiftDate(1)}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border hover:bg-muted"
              aria-label="다음"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                setDate(d);
              }}
              className="ml-1 h-9 px-3 text-xs rounded-md border border-border hover:bg-muted"
            >
              오늘
            </button>
          </div>

          <div className="ml-auto flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="이름·이메일 검색"
                className="h-9 pl-8 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring w-64"
              />
            </div>
            <FilterCheckbox
              label="프리랜서 제외"
              checked={filters.exclude_freelancer}
              onChange={(v) =>
                setFilters((p) => ({ ...p, exclude_freelancer: v }))
              }
            />
            <FilterCheckbox
              label="퇴사자 제외"
              checked={filters.exclude_resigned}
              onChange={(v) =>
                setFilters((p) => ({ ...p, exclude_resigned: v }))
              }
            />
            <FilterCheckbox
              label="제외자 미포함"
              checked={filters.exclude_directory}
              onChange={(v) =>
                setFilters((p) => ({ ...p, exclude_directory: v }))
              }
            />
          </div>
        </div>

        {/* 본문. overflow-y 만 auto — overflow-auto(=both) 는 세로 스크롤바 공간을
            미리 못 잡아 가로 1~16px overflow 를 유발 (table-fixed w-full 가 부모
            전체 폭으로 계산되는데 실제 가용 폭은 그보다 좁음) → 영구 가로 스크롤바.
            overflow-x-hidden 으로 가로는 명시적으로 차단. */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {mode === "day" && (
            <DayView date={date} query={query} filters={filters} />
          )}
          {mode === "week" && (
            <WeekView date={date} query={query} filters={filters} />
          )}
          {mode === "month" && (
            <MonthView date={date} query={query} filters={filters} />
          )}
        </div>

        {/* 범례 */}
        <Legend />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 일단위 — Gantt
// ---------------------------------------------------------------------------

function DayView({
  date,
  query,
  filters,
}: {
  date: Date;
  query: string;
  filters: FilterFlags;
}) {
  const dateStr = ymd(date);
  const { data, isLoading } = useQuery<DailyResponse>({
    queryKey: ["att-admin-daily", dateStr, query, filters],
    queryFn: async () =>
      (
        await api.get("/attendance/admin/daily", {
          params: {
            date: dateStr,
            query: query || undefined,
            exclude_freelancer: filters.exclude_freelancer,
            exclude_resigned: filters.exclude_resigned,
            exclude_directory: filters.exclude_directory,
          },
        })
      ).data,
    refetchInterval: 60_000,
  });

  // 진행중 세션 라이브 갱신 — 현재시각.
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (isLoading || !data) return <Skeleton />;

  const isToday = ymd(new Date()) === dateStr;

  // 시간축 — 00:00 ~ 23:00 (24h 풀 스케일).
  const HOUR_START = 0;
  const hourEnd = 24;
  const hours: number[] = [];
  for (let h = HOUR_START; h < hourEnd; h += 1) hours.push(h);

  function pctOfDay(date: Date | string): number {
    const d = typeof date === "string" ? new Date(date) : date;
    const minutesFromStart =
      d.getHours() * 60 + d.getMinutes() - HOUR_START * 60;
    const totalMinutes = (hourEnd - HOUR_START) * 60;
    return Math.min(100, Math.max(0, (minutesFromStart / totalMinutes) * 100));
  }

  const nowPct =
    isToday &&
    new Date().getHours() >= HOUR_START &&
    new Date().getHours() < hourEnd
      ? pctOfDay(now)
      : null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-x-auto">
      {/* 시간 눈금 */}
      <div className="flex border-b border-border sticky top-0 bg-card z-10">
        <div className="w-52 shrink-0 px-3 py-2 text-xs font-medium border-r border-border bg-muted/40">
          직원 ({data.developers.length}명)
        </div>
        <div className="flex-1 relative h-8">
          {hours.map((h) => {
            const left = ((h - HOUR_START) / (hourEnd - HOUR_START)) * 100;
            return (
              <div
                key={h}
                className="absolute top-0 bottom-0 text-xs text-muted-foreground border-l border-border/50"
                style={{ left: `${left}%` }}
              >
                <span className="absolute left-1 top-1">{h}:00</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 직원 rows */}
      {data.developers.length === 0 && (
        <div className="p-6 text-sm text-muted-foreground text-center">
          표시할 직원이 없습니다.
        </div>
      )}
      {data.developers.map((d) => (
        <div
          key={d.developer_id}
          className="flex border-b border-border last:border-b-0 group hover:bg-muted/20"
        >
          <div className="w-52 shrink-0 px-3 py-2 border-r border-border">
            <div className="text-sm font-medium flex items-center gap-1.5">
              {d.name}
              {d.status !== "ACTIVE" && (
                <span className="text-[9px] rounded bg-slate-200 text-slate-600 px-1">
                  퇴사
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {d.worksite?.name ?? "근무지 미배정"}
            </div>
            {d.worksite?.projects && d.worksite.projects.length > 0 && (
              <div className="text-[10px] text-muted-foreground truncate">
                {d.worksite.projects.map((p) => p.name).join(", ")}
              </div>
            )}
          </div>
          <div
            className={
              "flex-1 relative h-12 " +
              // legend 색과 같은 hue 계열의 옅은 톤. STATE_COLOR (bg-*-400/500) 의
              // 4단계 약화 버전으로 일관성 유지.
              (d.state === "ABSENT"
                ? "bg-red-100"
                : d.state === "LEAVE_ANNUAL" || d.state === "LEAVE_PUBLIC"
                  ? "bg-sky-100"
                  : d.state === "HOLIDAY"
                    ? "bg-slate-200"
                    : d.state === "WEEKEND"
                      ? "bg-slate-100"
                      : d.state === "NOT_EMPLOYED"
                        ? "bg-slate-50"
                        : "")
            }
          >
            {/* 시간 그리드 라인 */}
            {hours.slice(1).map((h) => {
              const left = ((h - HOUR_START) / (hourEnd - HOUR_START)) * 100;
              return (
                <div
                  key={h}
                  className="absolute top-0 bottom-0 border-l border-border/30"
                  style={{ left: `${left}%` }}
                />
              );
            })}

            {/* 반차 — 시간 구간으로 표시 (09:00~14:00 / 14:00~18:00) */}
            {d.state === "LEAVE_HALF_AM" && (
              <BarBg
                left={pctOfDay(new Date(date.toDateString() + " 09:00"))}
                width={
                  pctOfDay(new Date(date.toDateString() + " 14:00")) -
                  pctOfDay(new Date(date.toDateString() + " 09:00"))
                }
                color="bg-sky-300"
                label="오전 반차"
                tooltipLines={[
                  "오전 반차 (09:00~14:00)",
                  ...(d.leave?.reason ? [d.leave.reason] : []),
                ]}
              />
            )}
            {d.state === "LEAVE_HALF_PM" && (
              <BarBg
                left={pctOfDay(new Date(date.toDateString() + " 14:00"))}
                width={
                  pctOfDay(new Date(date.toDateString() + " 18:00")) -
                  pctOfDay(new Date(date.toDateString() + " 14:00"))
                }
                color="bg-sky-300"
                label="오후 반차"
                tooltipLines={[
                  "오후 반차 (14:00~18:00)",
                  ...(d.leave?.reason ? [d.leave.reason] : []),
                ]}
              />
            )}

            {/* 출근 세션 막대 */}
            {d.sessions.map((s) => {
              const inDate = new Date(s.check_in_at);
              const outDate = s.check_out_at
                ? new Date(s.check_out_at)
                : isToday
                  ? now
                  : null;
              if (!outDate) return null;
              const left = pctOfDay(inDate);
              const width = pctOfDay(outDate) - left;
              const outOfRange =
                s.check_in_within_radius === false ||
                s.check_out_within_radius === false;
              const isOpen = s.check_out_at === null;
              return (
                <SessionBar
                  key={s.id}
                  left={left}
                  width={width}
                  outOfRange={outOfRange}
                  isOpen={isOpen}
                  session={s}
                  worksite={d.worksite}
                />
              );
            })}

            {/* 연차 / 결근 / 공휴일 등 — 라벨만 (배경은 이미 row bg) */}
            {(d.state === "LEAVE_ANNUAL" ||
              d.state === "LEAVE_PUBLIC" ||
              d.state === "ABSENT" ||
              d.state === "HOLIDAY" ||
              d.state === "WEEKEND" ||
              d.state === "NOT_EMPLOYED" ||
              d.state === "FUTURE") && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground pointer-events-none">
                {STATE_LABEL[d.state]}
                {d.state === "HOLIDAY" && data.holiday_name
                  ? ` (${data.holiday_name})`
                  : ""}
                {d.state === "LEAVE_PUBLIC" && d.leave?.category
                  ? ` (${d.leave.category})`
                  : ""}
              </div>
            )}
          </div>
        </div>
      ))}

      {/* 현재시각 vertical line (오늘일 때) */}
      {nowPct !== null && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: `calc(10rem + ${nowPct}% * (100% - 10rem) / 100)`,
          }}
        />
      )}
    </div>
  );
}

function BarBg({
  left,
  width,
  color,
  label,
  tooltipLines,
}: {
  left: number;
  width: number;
  color: string;
  label: string;
  tooltipLines: string[];
}) {
  return (
    <div
      className={`group/tt absolute top-1.5 h-9 rounded ${color} opacity-60 flex items-center justify-center text-[10px] text-white font-medium`}
      style={{ left: `${left}%`, width: `${Math.max(width, 1)}%` }}
    >
      {label}
      <Tooltip
        inline
        side="top"
        label={<MultilineTip lines={tooltipLines} />}
        className="whitespace-normal w-[140px]"
      />
    </div>
  );
}

function SessionBar({
  left,
  width,
  outOfRange,
  isOpen,
  session,
  worksite,
}: {
  left: number;
  width: number;
  outOfRange: boolean;
  isOpen: boolean;
  session: SessionRow;
  worksite: DailyDeveloper["worksite"];
}) {
  const inT = new Date(session.check_in_at).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const outT = session.check_out_at
    ? new Date(session.check_out_at).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "(진행중)";
  const lines = [
    `${inT} ~ ${outT}`,
    worksite ? `근무지: ${worksite.name}` : null,
    worksite?.projects.length
      ? `프로젝트: ${worksite.projects.map((p) => p.name).join(", ")}`
      : null,
    outOfRange
      ? `반경 밖 (출근 ${session.check_in_distance_m ?? "?"}m, 퇴근 ${session.check_out_distance_m ?? "?"}m)`
      : null,
    session.check_in_reason ? `출근 사유: ${session.check_in_reason}` : null,
    session.check_out_reason ? `퇴근 사유: ${session.check_out_reason}` : null,
  ].filter((x): x is string => Boolean(x));
  return (
    <div
      className={
        "group/tt absolute top-1.5 h-9 rounded shadow-sm flex items-center justify-start px-2 text-sm text-white font-medium overflow-hidden " +
        (outOfRange ? "bg-amber-500" : "bg-emerald-500") +
        (isOpen ? " bg-stripes" : "")
      }
      style={{ left: `${left}%`, width: `${Math.max(width, 1.5)}%` }}
    >
      <span className="truncate">
        {inT} ~ {outT}
      </span>
      <Tooltip
        inline
        side="top"
        label={<MultilineTip lines={lines} />}
        className="whitespace-normal w-[140px]"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 주단위 — Heatmap
// ---------------------------------------------------------------------------

const WEEKDAY_LABEL = ["월", "화", "수", "목", "금", "토", "일"];

function WeekView({
  date,
  query,
  filters,
}: {
  date: Date;
  query: string;
  filters: FilterFlags;
}) {
  const ws = startOfWeekMon(date);
  const wsStr = ymd(ws);
  const { data, isLoading } = useQuery<WeeklyResponse>({
    queryKey: ["att-admin-weekly", wsStr, query, filters],
    queryFn: async () =>
      (
        await api.get("/attendance/admin/weekly", {
          params: {
            week_start: wsStr,
            query: query || undefined,
            exclude_freelancer: filters.exclude_freelancer,
            exclude_resigned: filters.exclude_resigned,
            exclude_directory: filters.exclude_directory,
          },
        })
      ).data,
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <Skeleton />;

  return (
    <div className="rounded-lg border border-border bg-card">
      <table className="w-full text-sm border-collapse">
        <thead className="bg-muted/40 sticky top-0 z-10">
          <tr>
            <th className="px-3 py-2 text-left font-medium border-r border-border w-[88px]">
              직원 ({data.developers.length}명)
            </th>
            {WEEKDAY_LABEL.map((label, i) => {
              const d = parseYmd(data.week_start);
              d.setDate(d.getDate() + i);
              return (
                <th
                  key={i}
                  className="px-2 py-2 text-center font-medium border-r border-border last:border-r-0"
                >
                  <div>{label}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {d.getMonth() + 1}/{d.getDate()}
                  </div>
                </th>
              );
            })}
            <th className="px-2 py-2 text-right font-medium w-20">합계</th>
          </tr>
        </thead>
        <tbody>
          {data.developers.map((d, idx) => {
            const totalMin = d.days.reduce(
              (sum, day) => sum + (day.summary?.minutes ?? 0),
              0,
            );
            return (
              <tr key={d.developer_id} className="hover:bg-muted/20">
                <td className="px-3 py-2 border-r border-border">
                  <div className="font-medium flex items-center gap-1.5">
                    {d.name}
                    {d.status !== "ACTIVE" && (
                      <span className="text-[9px] rounded bg-slate-200 text-slate-600 px-1">
                        퇴사
                      </span>
                    )}
                  </div>
                </td>
                {d.days.map((day) => (
                  <td
                    key={day.date}
                    className="border-r border-border last:border-r-0 align-middle p-1"
                  >
                    <DayCell
                      day={day}
                      rowIndex={idx}
                      totalRows={data.developers.length}
                    />
                  </td>
                ))}
                <td className="px-2 py-2 text-right tabular-nums text-xs">
                  {fmtDuration(totalMin)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DayCell({
  day,
  rowIndex = 0,
  totalRows = 1,
}: {
  day: WeekDayCell | MonthlyDay;
  rowIndex?: number;
  totalRows?: number;
}) {
  const lines = buildCellTooltipLines(day);
  let inner: React.ReactNode;
  if (day.state === "LEAVE_HALF_AM") {
    inner = (
      <div className="h-7 rounded flex overflow-hidden">
        <div className="flex-1 bg-sky-400" />
        <div className="flex-1 bg-emerald-500" />
      </div>
    );
  } else if (day.state === "LEAVE_HALF_PM") {
    inner = (
      <div className="h-7 rounded flex overflow-hidden">
        <div className="flex-1 bg-emerald-500" />
        <div className="flex-1 bg-sky-400" />
      </div>
    );
  } else {
    inner = (
      <div
        className={
          "h-7 rounded " +
          STATE_COLOR[day.state] +
          (day.state === "IN_PROGRESS" ? " bg-stripes" : "")
        }
      />
    );
  }
  // 부모 overflow-x-auto 가 Y 축까지 implicit clip 시키는 CSS 명세 quirk:
  // 위쪽 절반 행은 "bottom" 으로 셀 아래에, 아래쪽 절반 행은 "top" 으로 셀 위에
  // 띄워 컨테이너 안에 들어오도록 동적 선택.
  const side: "top" | "bottom" =
    rowIndex < totalRows / 2 ? "bottom" : "top";
  return (
    <div className="group/tt relative">
      {inner}
      <Tooltip
        inline
        side={side}
        label={<MultilineTip lines={lines} />}
        className="whitespace-normal w-[140px]"
      />
    </div>
  );
}

function buildCellTooltipLines(day: WeekDayCell | MonthlyDay): string[] {
  const lines: string[] = [`${day.date} · ${STATE_LABEL[day.state]}`];
  if (day.holiday_name) lines.push(`공휴일: ${day.holiday_name}`);
  if (day.leave) {
    if (day.leave.leave_type === "HALF") {
      lines.push(
        `${day.leave.half_kind === "AM" ? "오전" : "오후"} 반차${day.leave.reason ? " — " + day.leave.reason : ""}`,
      );
    } else if (day.leave.leave_type === "UNPAID_PUBLIC") {
      lines.push(
        `공가 (${day.leave.category ?? "기타"})${day.leave.reason ? " — " + day.leave.reason : ""}`,
      );
    } else {
      lines.push(`연차${day.leave.reason ? " — " + day.leave.reason : ""}`);
    }
  }
  if (day.summary) {
    if (day.summary.first_in)
      lines.push(`출근: ${fmtTime(day.summary.first_in)}`);
    if (day.summary.last_out)
      lines.push(`퇴근: ${fmtTime(day.summary.last_out)}`);
    if (day.summary.has_open) lines.push("(진행중)");
    if (day.summary.minutes > 0)
      lines.push(`근무: ${fmtDuration(day.summary.minutes)}`);
  }
  return lines;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(min: number): string {
  if (min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// 월단위 — 직원 × 일자 매트릭스
// ---------------------------------------------------------------------------

function MonthView({
  date,
  query,
  filters,
}: {
  date: Date;
  query: string;
  filters: FilterFlags;
}) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const { data, isLoading } = useQuery<MonthlyResponse>({
    queryKey: ["att-admin-monthly", year, month, query, filters],
    queryFn: async () =>
      (
        await api.get("/attendance/admin/monthly", {
          params: {
            year,
            month,
            query: query || undefined,
            exclude_freelancer: filters.exclude_freelancer,
            exclude_resigned: filters.exclude_resigned,
            exclude_directory: filters.exclude_directory,
          },
        })
      ).data,
    refetchInterval: 60_000,
  });

  // useMemo 는 항상 호출 — early return 뒤에 두면 Rules of Hooks 위반.
  const stats = useMemo(() => {
    let normal = 0,
      absent = 0,
      leave = 0;
    let totalMin = 0;
    for (const d of data?.developers ?? []) {
      for (const day of d.days) {
        if (
          day.state === "NORMAL" ||
          day.state === "IN_PROGRESS" ||
          day.state === "NORMAL_OUT_OF_RANGE"
        )
          normal += 1;
        if (day.state === "ABSENT") absent += 1;
        if (
          day.state === "LEAVE_ANNUAL" ||
          day.state === "LEAVE_HALF_AM" ||
          day.state === "LEAVE_HALF_PM" ||
          day.state === "LEAVE_PUBLIC"
        )
          leave += 1;
        totalMin += day.summary?.minutes ?? 0;
      }
    }
    return { normal, absent, leave, totalMin };
  }, [data]);

  if (isLoading || !data) return <Skeleton />;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label="총 출근일" value={String(stats.normal)} suffix="일" />
        <StatCard label="총 결근일" value={String(stats.absent)} suffix="일" />
        <StatCard label="총 연차일" value={String(stats.leave)} suffix="일" />
        <StatCard label="총 근무시간" value={fmtDuration(stats.totalMin)} />
      </div>

      <div className="rounded-lg border border-border bg-card">
        {/* table-fixed + w-full + border-collapse → column 균등 분배 + 우측 fit.
            border-collapse 가 핵심: 기본 border-separate 는 column 사이에 2px
            spacing 을 추가해 32 cols × 2px ≈ 60px 만큼 w-full 을 넘겨 부모
            overflow-auto 에 가로 스크롤바를 만든다. */}
        <table className="text-xs w-full table-fixed border-collapse">
          <thead className="bg-muted/40 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-medium border-r border-border w-[72px] sticky left-0 bg-muted/40 z-10">
                직원 ({data.developers.length}명)
              </th>
              {data.developers[0]?.days.map((d) => {
                const isWeekend = d.weekday >= 5;
                return (
                  <th
                    key={d.date}
                    className={
                      "px-0.5 py-1 text-center font-medium border-r border-border last:border-r-0 last:pr-[5px] " +
                      (isWeekend ? "text-muted-foreground" : "")
                    }
                  >
                    {d.day}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.developers.map((d, idx) => (
              <tr key={d.developer_id} className="hover:bg-muted/20">
                <td className="px-2 py-1 border-r border-border sticky left-0 bg-card hover:bg-muted/20">
                  <span className="text-sm font-medium">{d.name}</span>
                  {d.status !== "ACTIVE" && (
                    <span className="ml-1 text-[9px] rounded bg-slate-200 text-slate-600 px-1">
                      퇴사
                    </span>
                  )}
                </td>
                {d.days.map((day) => (
                  <td
                    key={day.date}
                    className="border-r border-border last:border-r-0 p-0.5 last:pr-[5px]"
                  >
                    <DayCell
                      day={day}
                      rowIndex={idx}
                      totalRows={data.developers.length}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums mt-0.5">
        {value}
        {suffix && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function FilterCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-input"
      />
      {label}
    </label>
  );
}

function Skeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-12 text-sm text-muted-foreground text-center">
      불러오는 중…
    </div>
  );
}

function Legend() {
  const items: Array<{ state: AttendanceState; label: string }> = [
    { state: "NORMAL", label: "정상" },
    { state: "IN_PROGRESS", label: "진행중" },
    { state: "NORMAL_OUT_OF_RANGE", label: "외근" },
    { state: "LEAVE_ANNUAL", label: "연차" },
    { state: "LEAVE_HALF_AM", label: "반차" },
    { state: "LEAVE_PUBLIC", label: "공가" },
    { state: "ABSENT", label: "결근" },
    { state: "HOLIDAY", label: "공휴일" },
    { state: "WEEKEND", label: "주말" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 pt-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <div key={i.state} className="inline-flex items-center gap-1.5">
          <span
            className={"inline-block w-3 h-3 rounded " + STATE_COLOR[i.state]}
          />
          {i.label}
        </div>
      ))}
    </div>
  );
}
