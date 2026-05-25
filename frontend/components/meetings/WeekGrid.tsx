"use client";

import { useMemo } from "react";
import type { MeetingReservation } from "./types";
import {
  HOUR_END,
  HOUR_START,
  SLOTS_PER_HOUR,
  TOTAL_SLOTS,
  addDays,
  formatDayHeader,
  formatRangeShort,
  isSameDay,
  ymd,
} from "./time";

// /calendar 의 휴일·일정 5종 — sidebar 일정과 동일.
type HolidayType =
  | "STATUTORY"
  | "TEMPORARY"
  | "COMPANY"
  | "EVENT_PUBLIC"
  | "EVENT_PRIVATE";
type Holiday = { id: string; date: string; name: string; type: HolidayType };
type EventKind = "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";
type EventItem = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  kind: EventKind;
};

const HOLIDAY_CHIP: Record<HolidayType, string> = {
  STATUTORY: "bg-red-50 text-red-700 border-red-200",
  TEMPORARY: "bg-amber-50 text-amber-700 border-amber-200",
  COMPANY: "bg-sky-50 text-sky-700 border-sky-200",
  EVENT_PUBLIC: "bg-emerald-50 text-emerald-700 border-emerald-200",
  EVENT_PRIVATE: "bg-violet-50 text-violet-700 border-violet-200",
};

const EVENT_CHIP: Record<EventKind, string> = {
  WORKSHOP: "bg-emerald-50 text-emerald-700 border-emerald-200",
  CONFERENCE: "bg-violet-50 text-violet-700 border-violet-200",
  BUSINESS_TRIP: "bg-orange-50 text-orange-700 border-orange-200",
};

const EVENT_ICON: Record<EventKind, string> = {
  WORKSHOP: "🎯",
  CONFERENCE: "🎤",
  BUSINESS_TRIP: "✈️",
};

type Props = {
  weekStart: Date; // 월요일 00:00
  reservations: MeetingReservation[];
  holidayDates: Set<string>; // YYYY-MM-DD — 음영 처리용 (휴일 3종만)
  /** sidebar > 일정 의 휴일·일정 — 칩 형태로 day 헤더 아래 표시. */
  holidays: Holiday[];
  /** sidebar > 이벤트 의 워크샵/컨퍼런스/출장 — 칩으로 표시. */
  events: EventItem[];
  currentUserId: string | null;
  currentDeveloperId: string | null;
  onSlotClick: (start: Date) => void;
  onReservationClick: (res: MeetingReservation) => void;
};

const TIME_COL_W = 56;

// 겹치는 예약에 lane 을 할당 (단순 탐욕 알고리즘).
function assignLanes(
  items: MeetingReservation[],
): Array<{ res: MeetingReservation; lane: number; lanes: number }> {
  const sorted = [...items].sort(
    (a, b) =>
      new Date(a.start_at).getTime() - new Date(b.start_at).getTime() ||
      new Date(a.end_at).getTime() - new Date(b.end_at).getTime(),
  );
  type LaneEnd = { end: number };
  const lanes: LaneEnd[] = [];
  const assignment = new Map<string, number>();
  for (const res of sorted) {
    const s = new Date(res.start_at).getTime();
    const e = new Date(res.end_at).getTime();
    let placed = -1;
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i].end <= s) {
        lanes[i].end = e;
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      lanes.push({ end: e });
      placed = lanes.length - 1;
    }
    assignment.set(res.id, placed);
  }
  const totalLanes = Math.max(1, lanes.length);
  return sorted.map((res) => ({
    res,
    lane: assignment.get(res.id) ?? 0,
    lanes: totalLanes,
  }));
}

function reservationColor(
  res: MeetingReservation,
  currentUserId: string | null,
  currentDeveloperId: string | null,
): string {
  if (res.status === "CANCELLED") return "bg-slate-300/70 text-slate-500";
  const isOrganizer = currentUserId && res.organizer_id === currentUserId;
  const isParticipant =
    currentDeveloperId &&
    res.participants.some((p) => p.developer_id === currentDeveloperId);
  if (isOrganizer) return "bg-primary text-primary-foreground";
  if (isParticipant)
    return "bg-primary/10 text-primary border border-primary/40";
  return "bg-slate-400 text-white";
}

export function WeekGrid({
  weekStart,
  reservations,
  holidayDates,
  holidays,
  events,
  currentUserId,
  currentDeveloperId,
  onSlotClick,
  onReservationClick,
}: Props) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const today = new Date();

  // 일자별 일정 모음 — day 헤더 아래 칩으로 노출.
  // holidays 는 단일 date, events 는 start~end 범위라 일자별로 펼쳐 매핑.
  type DayChip =
    | { kind: "holiday"; id: string; label: string; cls: string }
    | { kind: "event"; id: string; label: string; cls: string };
  const chipsByDay = useMemo(() => {
    const map = new Map<string, DayChip[]>();
    for (const h of holidays) {
      const arr = map.get(h.date) ?? [];
      arr.push({
        kind: "holiday",
        id: h.id,
        label: h.name,
        cls: HOLIDAY_CHIP[h.type],
      });
      map.set(h.date, arr);
    }
    for (const e of events) {
      const start = new Date(e.start_date);
      const end = new Date(e.end_date);
      const cur = new Date(start);
      while (cur <= end) {
        const key = ymd(cur);
        const arr = map.get(key) ?? [];
        arr.push({
          kind: "event",
          id: `${e.id}-${key}`,
          label: `${EVENT_ICON[e.kind]} ${e.title}`,
          cls: EVENT_CHIP[e.kind],
        });
        map.set(key, arr);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }, [holidays, events]);

  // 운영 시간 총 분. 내부 좌표는 모두 이 값 대비 % 로 계산 → 높이 가변.
  const totalMinutes = (HOUR_END - HOUR_START) * 60;

  // 시간 라벨 (1시간 단위).
  const hourLabels = useMemo(() => {
    const arr: { hour: number; topPct: number }[] = [];
    for (let h = HOUR_START; h <= HOUR_END; h += 1) {
      arr.push({
        hour: h,
        topPct: ((h - HOUR_START) * 60 * 100) / totalMinutes,
      });
    }
    return arr;
  }, [totalMinutes]);

  // 일자별 예약 분할.
  const byDay = useMemo(() => {
    const map: MeetingReservation[][] = Array.from({ length: 7 }, () => []);
    for (const r of reservations) {
      const s = new Date(r.start_at);
      for (let i = 0; i < 7; i += 1) {
        if (isSameDay(s, days[i])) {
          map[i].push(r);
          break;
        }
      }
    }
    return map.map((items) => assignLanes(items));
  }, [reservations, days]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      {/* 헤더: 요일 */}
      <div className="flex shrink-0 border-b border-border bg-muted/30">
        <div
          className="shrink-0 border-r border-border text-xs text-muted-foreground"
          style={{ width: TIME_COL_W }}
        />
        {days.map((d, i) => {
          const isToday = isSameDay(d, today);
          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
          const dateKey = ymd(d);
          const isHoliday = holidayDates.has(dateKey);
          const chips = chipsByDay.get(dateKey) ?? [];
          return (
            <div
              key={i}
              className={
                "flex-1 min-w-0 border-r border-border last:border-r-0 " +
                (isToday ? "bg-primary/10 " : "")
              }
            >
              <div
                className={
                  "text-center py-2 text-sm " +
                  (isToday ? "font-semibold text-primary " : "") +
                  (isWeekend || isHoliday ? "text-red-600 " : "")
                }
              >
                {formatDayHeader(d)}
              </div>
              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1 px-1 pb-1.5 justify-center">
                  {chips.map((c) => (
                    <span
                      key={c.id}
                      title={c.label}
                      className={
                        "inline-block max-w-full truncate rounded border px-1.5 py-0.5 text-[11px] leading-tight " +
                        c.cls
                      }
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 본체: 시간축 + 7 day 컬럼 — 부모 높이 전체를 채움 (스크롤 불필요). */}
      <div className="flex flex-1 min-h-0">
        <div
          className="relative shrink-0 border-r border-border bg-muted/10"
          style={{ width: TIME_COL_W }}
        >
          {hourLabels.map(({ hour, topPct }) => (
            <div
              key={hour}
              className="absolute left-0 right-0 text-xs text-muted-foreground text-right pr-1 -translate-y-1/2"
              style={{ top: `${topPct}%` }}
            >
              {String(hour).padStart(2, "0")}:00
            </div>
          ))}
        </div>

        {days.map((day, dayIdx) => {
          const isWeekend = day.getDay() === 0 || day.getDay() === 6;
          const isHoliday = holidayDates.has(
            `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
              day.getDate(),
            ).padStart(2, "0")}`,
          );
          return (
            <div
              key={dayIdx}
              className={
                "relative flex-1 min-w-0 border-r border-border last:border-r-0 " +
                (isWeekend || isHoliday ? "bg-slate-100" : "bg-background")
              }
            >
              {/* 시간대 그리드 라인 + 클릭 슬롯 */}
              {Array.from({ length: TOTAL_SLOTS }, (_, slot) => {
                const slotDate = new Date(day);
                slotDate.setHours(
                  HOUR_START + Math.floor(slot / SLOTS_PER_HOUR),
                  (slot % SLOTS_PER_HOUR) * (60 / SLOTS_PER_HOUR),
                  0,
                  0,
                );
                const isHourLine = slot % SLOTS_PER_HOUR === 0;
                return (
                  <button
                    type="button"
                    key={slot}
                    onClick={() => onSlotClick(slotDate)}
                    className={
                      "absolute left-0 right-0 cursor-pointer hover:bg-primary/5 " +
                      (isHourLine
                        ? "border-t border-border"
                        : "border-t border-dashed border-border/40")
                    }
                    style={{
                      top: `${(slot * 100) / TOTAL_SLOTS}%`,
                      height: `${100 / TOTAL_SLOTS}%`,
                    }}
                    aria-label={`${formatDayHeader(day)} ${String(
                      slotDate.getHours(),
                    ).padStart(2, "0")}:${String(slotDate.getMinutes()).padStart(
                      2,
                      "0",
                    )} 예약`}
                  />
                );
              })}

              {/* 예약 블록 */}
              {byDay[dayIdx].map(({ res, lane, lanes }) => {
                const s = new Date(res.start_at);
                const e = new Date(res.end_at);
                const dayStart = new Date(day);
                dayStart.setHours(HOUR_START, 0, 0, 0);
                const startMin =
                  (s.getTime() - dayStart.getTime()) / 60_000;
                const endMin = (e.getTime() - dayStart.getTime()) / 60_000;
                const topPct = (startMin * 100) / totalMinutes;
                const heightPct = ((endMin - startMin) * 100) / totalMinutes;
                const widthPct = 100 / lanes;
                const leftPct = lane * widthPct;
                return (
                  <button
                    type="button"
                    key={res.id}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onReservationClick(res);
                    }}
                    className={
                      "absolute rounded-md px-1.5 py-0.5 text-sm text-center shadow-sm hover:ring-2 hover:ring-primary/50 transition-shadow overflow-hidden flex flex-col items-center justify-center " +
                      reservationColor(res, currentUserId, currentDeveloperId) +
                      (res.status === "CANCELLED" ? " line-through" : "")
                    }
                    style={{
                      top: `calc(${topPct}% + 1px)`,
                      height: `calc(${heightPct}% - 2px)`,
                      left: `calc(${leftPct}% + 2px)`,
                      width: `calc(${widthPct}% - 4px)`,
                    }}
                    title={`${res.title} · ${formatRangeShort(s, e)}`}
                  >
                    <div className="font-medium truncate w-full">{res.title}</div>
                    <div className="text-xs opacity-80 truncate w-full">
                      {formatRangeShort(s, e)}
                      {res.participants.length > 0
                        ? ` · ${res.participants.length}명`
                        : ""}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
