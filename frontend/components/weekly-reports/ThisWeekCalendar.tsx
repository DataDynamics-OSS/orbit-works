"use client";

/**
 * 주간보고 — '내 보고서' 탭 상단의 주간 일정 strip (이번 주 + 다음 주).
 *
 * sidebar > 일정(`/calendar`) 과 동일 데이터 소스 사용:
 *   - 휴일·일정 (`/calendar?year=`) : STATUTORY/TEMPORARY/COMPANY +
 *     EVENT_PUBLIC/EVENT_PRIVATE/EVENT_PERSONAL.
 *   - 이벤트 (`/events/calendar?year=`) : 워크샵·컨퍼런스·출장 (start_date~end_date).
 *
 * 표시: 이번 ISO 주(월~일) 7 셀 + 다음 주 7 셀 (총 2 행). 각 셀에 요일·일자,
 * 휴일 chip, 이벤트 chip. 일요일/휴일 빨강, 토요일 파랑, 오늘 강조.
 *
 * 연말 케이스 — 다음 주가 다음 해로 넘어가는 경우, 두 해의 휴일·이벤트를 모두
 * fetch 해서 합산 (같은 해면 두 번째 query 는 disabled, 캐시 공유).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isoWeekOf, shiftWeek, weekRange, type IsoWeek } from "@/lib/iso-week";

type HolidayType =
  | "STATUTORY"
  | "TEMPORARY"
  | "COMPANY"
  | "EVENT_PUBLIC"
  | "EVENT_PRIVATE"
  | "EVENT_PERSONAL";

type Holiday = {
  id: string;
  date: string;
  name: string;
  type: HolidayType;
};

type EventKind = "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";

type EventRange = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  kind: EventKind;
};

const TYPE_BADGE: Record<HolidayType, string> = {
  STATUTORY: "bg-red-100 text-red-700 border-red-200",
  TEMPORARY: "bg-amber-100 text-amber-700 border-amber-200",
  COMPANY: "bg-sky-100 text-sky-700 border-sky-200",
  EVENT_PUBLIC: "bg-emerald-100 text-emerald-700 border-emerald-200",
  EVENT_PRIVATE: "bg-violet-100 text-violet-700 border-violet-200",
  EVENT_PERSONAL: "bg-pink-100 text-pink-700 border-pink-200",
};
const REAL_HOLIDAY_TYPES: ReadonlySet<HolidayType> = new Set([
  "STATUTORY",
  "TEMPORARY",
  "COMPANY",
]);
const EVENT_KIND_BADGE: Record<EventKind, string> = {
  WORKSHOP: "bg-blue-100 text-blue-700 border-blue-200",
  CONFERENCE: "bg-purple-100 text-purple-700 border-purple-200",
  BUSINESS_TRIP: "bg-orange-100 text-orange-700 border-orange-200",
};
const EVENT_KIND_ICON: Record<EventKind, string> = {
  WORKSHOP: "🎯",
  CONFERENCE: "🎤",
  BUSINESS_TRIP: "✈️",
};

const DOW_LABEL = ["월", "화", "수", "목", "금", "토", "일"];

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Props = {
  /** 표시할 ISO 주. 미지정 시 오늘이 속한 주. */
  week?: IsoWeek;
};

export function ThisWeekCalendar({ week }: Props = {}) {
  // 비공개 일정 가시 권한 — calendar 페이지와 동일 규칙.
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canSeePrivate =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  // 표시할 주 (월~일). 부모가 prop 으로 지정한 주, 없으면 오늘 주. + 다음 주.
  const today = new Date();
  const tw = week ?? isoWeekOf(today);
  const nextTw = shiftWeek(tw, 1);
  const todayKey = ymd(today);

  // 두 주가 서로 다른 해에 걸치면 양쪽 해 모두 fetch. 같은 해면 두 번째 query
  // 는 disabled (react-query 캐시 공유).
  const crossYear = nextTw.year !== tw.year;
  const { data: hY1 = [] } = useQuery<Holiday[]>({
    queryKey: ["calendar", tw.year],
    queryFn: async () =>
      (await api.get("/calendar", { params: { year: tw.year } })).data,
    staleTime: 60_000,
  });
  const { data: hY2 = [] } = useQuery<Holiday[]>({
    queryKey: ["calendar", nextTw.year],
    queryFn: async () =>
      (await api.get("/calendar", { params: { year: nextTw.year } })).data,
    staleTime: 60_000,
    enabled: crossYear,
  });
  const holidays = useMemo(
    () => (crossYear ? [...hY1, ...hY2] : hY1),
    [hY1, hY2, crossYear],
  );
  const { data: eY1 = [] } = useQuery<EventRange[]>({
    queryKey: ["events-calendar", tw.year],
    queryFn: async () =>
      (await api.get("/events/calendar", { params: { year: tw.year } })).data,
    staleTime: 60_000,
  });
  const { data: eY2 = [] } = useQuery<EventRange[]>({
    queryKey: ["events-calendar", nextTw.year],
    queryFn: async () =>
      (await api.get("/events/calendar", { params: { year: nextTw.year } })).data,
    staleTime: 60_000,
    enabled: crossYear,
  });
  const events = useMemo(
    () => (crossYear ? [...eY1, ...eY2] : eY1),
    [eY1, eY2, crossYear],
  );

  // 일자 → 휴일·일정 lookup (휴일 먼저, 일정 나중 정렬).
  const holidayByDay = useMemo(() => {
    const m = new Map<string, Holiday[]>();
    for (const h of holidays) {
      const arr = m.get(h.date);
      if (arr) arr.push(h);
      else m.set(h.date, [h]);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ah = REAL_HOLIDAY_TYPES.has(a.type) ? 0 : 1;
        const bh = REAL_HOLIDAY_TYPES.has(b.type) ? 0 : 1;
        if (ah !== bh) return ah - bh;
        return a.type.localeCompare(b.type);
      });
    }
    return m;
  }, [holidays]);

  // 이벤트 — start_date ~ end_date 양끝 포함 범위를 일자로 펼침.
  const eventByDay = useMemo(() => {
    const m = new Map<string, { id: string; title: string; kind: EventKind }[]>();
    for (const e of events) {
      const start = new Date(e.start_date);
      const end = new Date(e.end_date);
      const cur = new Date(start);
      while (cur <= end) {
        const k = ymd(cur);
        const arr = m.get(k);
        const item = { id: e.id, title: e.title, kind: e.kind };
        if (arr) arr.push(item);
        else m.set(k, [item]);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return m;
  }, [events]);

  return (
    <section className="rounded-md border border-border bg-card">
      <header className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-sm font-semibold">주간 일정</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          이번 주 + 다음 주
        </span>
      </header>
      <WeekStrip
        tw={tw}
        label="이번 주"
        holidayByDay={holidayByDay}
        eventByDay={eventByDay}
        todayKey={todayKey}
      />
      <WeekStrip
        tw={nextTw}
        label="다음 주"
        holidayByDay={holidayByDay}
        eventByDay={eventByDay}
        todayKey={todayKey}
      />
      {/* Legend — 휴일 3 + 일정 1~2 + 이벤트 3. 캘린더 페이지와 동일 규칙:
          비공개 일정은 권한자(HR/ADMIN/SUPER_ADMIN) 만 표시, 개인 일정은
          단일 사용자 단위라 legend 카테고리에서 제외. */}
      <div className="flex flex-wrap gap-1.5 px-3 py-2 border-t border-border text-xs">
        <LegendChip cls={TYPE_BADGE.STATUTORY}>법정 공휴일</LegendChip>
        <LegendChip cls={TYPE_BADGE.TEMPORARY}>임시 공휴일</LegendChip>
        <LegendChip cls={TYPE_BADGE.COMPANY}>회사 휴일</LegendChip>
        <LegendChip cls={TYPE_BADGE.EVENT_PUBLIC}>공개 일정</LegendChip>
        {canSeePrivate && (
          <LegendChip cls={TYPE_BADGE.EVENT_PRIVATE}>비공개 일정</LegendChip>
        )}
        <LegendChip cls={EVENT_KIND_BADGE.WORKSHOP}>🎯 워크샵</LegendChip>
        <LegendChip cls={EVENT_KIND_BADGE.CONFERENCE}>🎤 컨퍼런스</LegendChip>
        <LegendChip cls={EVENT_KIND_BADGE.BUSINESS_TRIP}>✈️ 출장</LegendChip>
      </div>
    </section>
  );
}


// 단일 ISO 주 7 셀 strip — 헤더(주차 라벨 + 일자 범위) + 셀 그리드.
function WeekStrip({
  tw,
  label,
  holidayByDay,
  eventByDay,
  todayKey,
}: {
  tw: IsoWeek;
  label: string;
  holidayByDay: Map<string, Holiday[]>;
  eventByDay: Map<string, { id: string; title: string; kind: EventKind }[]>;
  todayKey: string;
}) {
  const range = weekRange(tw.year, tw.week);
  const days: Date[] = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(range.start);
      d.setDate(range.start.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [range.start.toDateString()]);

  const md = (n: number) => String(n).padStart(2, "0");
  const rangeLabel =
    `${tw.year}-W${String(tw.week).padStart(2, "0")} ` +
    `(${md(range.start.getMonth() + 1)}.${md(range.start.getDate())} ~ ` +
    `${md(range.end.getMonth() + 1)}.${md(range.end.getDate())})`;

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1 border-t border-border bg-muted/30 text-[11px]">
        <span className="font-semibold text-muted-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{rangeLabel}</span>
      </div>
      <div className="grid grid-cols-7 divide-x divide-border">
        {days.map((d, idx) => {
          const k = ymd(d);
          const dow = idx; // 0=월 ~ 6=일
          const isSat = dow === 5;
          const isSun = dow === 6;
          const isToday = k === todayKey;
          const dayHolidays = holidayByDay.get(k) ?? [];
          const dayEvents = eventByDay.get(k) ?? [];
          const isRealHoliday = dayHolidays.some((h) =>
            REAL_HOLIDAY_TYPES.has(h.type),
          );
          const dateColor =
            isRealHoliday || isSun
              ? "text-rose-600"
              : isSat
                ? "text-blue-600"
                : "text-foreground";

          return (
            <div
              key={k}
              className={
                "min-h-[90px] p-2 flex flex-col gap-1 " +
                (isToday ? "bg-primary/5" : "")
              }
            >
              <div className="flex items-baseline justify-between">
                <span
                  className={
                    "text-sm font-medium " +
                    (isSun
                      ? "text-rose-600"
                      : isSat
                        ? "text-blue-600"
                        : "text-muted-foreground")
                  }
                >
                  {DOW_LABEL[dow]}
                </span>
                <span
                  className={
                    "text-sm tabular-nums " +
                    (isToday ? "font-bold " : "") +
                    dateColor
                  }
                >
                  {d.getDate()}
                </span>
              </div>

              {/* 휴일·일정 chip — wordwrap, 가운데 정렬. */}
              <div className="flex flex-col gap-0.5">
                {dayHolidays.map((h) => (
                  <span
                    key={h.id}
                    title={h.name}
                    className={
                      "block rounded-sm border px-1 py-0.5 text-xs leading-tight " +
                      "text-center break-words whitespace-normal " +
                      TYPE_BADGE[h.type]
                    }
                  >
                    {h.name}
                  </span>
                ))}
                {dayEvents.map((e) => (
                  <span
                    key={e.id}
                    title={e.title}
                    className={
                      "block rounded-sm border px-1 py-0.5 text-xs leading-tight " +
                      "text-center break-words whitespace-normal " +
                      EVENT_KIND_BADGE[e.kind]
                    }
                  >
                    {EVENT_KIND_ICON[e.kind]} {e.title}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function LegendChip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span
      className={"inline-flex items-center rounded-sm border px-1.5 py-0 text-xs " + cls}
    >
      {children}
    </span>
  );
}
