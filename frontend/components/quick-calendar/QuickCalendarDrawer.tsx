"use client";

/**
 * 보기용 달력 드로어 — 우측 슬라이드.
 *
 * 전달 / 이번달(anchor) / 다음달 3개를 세로 stack. 휴일은 빨강 + 휴일명
 * tooltip, 요일/토요일 색 구분. 헤더에 prev/next 화살표로 anchor 월 이동,
 * '오늘' 버튼으로 즉시 복귀.
 *
 * 셀 우상단 dot — 휴일·일정 + 이벤트(워크샵/컨퍼런스/출장) + 본인 미완료
 * 액션 마감 통합. 1개면 legend 색, 2개+ 면 진한 회색. calendar 페이지의
 * YearView mini 와 동일 규칙 (`@/components/calendar-shared/dots`).
 *
 * 데이터:
 *   /calendar?year=YYYY        — 휴일·일정 통합 (EVENT_PRIVATE 는 권한자만)
 *   /events/calendar?year=YYYY — 워크샵/컨퍼런스/출장
 *   /meeting-notes/action-items/mine?include_done=false — 본인 미완료 액션
 * 3 개월 윈도우가 연 경계를 넘으면 calendar/events 만 두 해를 fetch.
 *
 * React Query key 는 calendar 페이지와 동일 — 그 페이지를 한 번이라도
 * 방문했다면 캐시 공유로 즉시 표시.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";

import { api } from "@/lib/api";
import { useQuickCalendar } from "./QuickCalendarProvider";
import { MonthGrid, type Holiday } from "./MonthGrid";
import { CalendarLegend } from "@/components/calendar-shared/Legend";
import type {
  EventKind,
  SharedAction,
  SharedEvent,
} from "@/components/calendar-shared/dots";

function shiftMonth(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type EventRow = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  kind: EventKind;
};

type ActionRow = {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
};

export function QuickCalendarDrawer() {
  const { isOpen, close } = useQuickCalendar();

  // anchor = '이번달' 자리에 보일 월의 1일.
  const [anchor, setAnchor] = useState<Date>(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });
  // 드로어 열 때마다 오늘 기준으로 reset (사용자가 닫고 다시 열면 처음으로).
  useEffect(() => {
    if (!isOpen) return;
    const t = new Date();
    setAnchor(new Date(t.getFullYear(), t.getMonth(), 1));
  }, [isOpen]);

  // ESC 닫기.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  // 표시 3개월 — 전·anchor·다음.
  const prev = shiftMonth(anchor, -1);
  const next = shiftMonth(anchor, 1);

  // 필요한 연도 — prev/anchor/next 가 차지한 연도 집합.
  const years = useMemo(() => {
    const s = new Set<number>([
      prev.getFullYear(),
      anchor.getFullYear(),
      next.getFullYear(),
    ]);
    return [...s];
  }, [prev, anchor, next]);

  // 비공개 일정 노출 여부 (legend 의 '비공개 일정' swatch 만 영향;
  // /calendar API 가 이미 EVENT_PRIVATE 를 권한자에게만 반환).
  const { data: me } = useQuery<{ id: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
    enabled: isOpen,
  });
  const canSeePrivate =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  // 휴일 / 일정 fetch — 연도 별. 드로어 열렸을 때만. calendar 페이지와
  // 동일한 queryKey ['calendar', year] 라 그 페이지 캐시와 공유.
  const yearKey = years.join(",");
  const { data: holidays = [] } = useQuery<Holiday[]>({
    queryKey: ["quick-calendar-holidays", yearKey],
    queryFn: async () => {
      const all: Holiday[] = [];
      for (const y of years) {
        const rows = (await api.get("/calendar", { params: { year: y } })).data;
        all.push(...rows);
      }
      return all;
    },
    enabled: isOpen,
    staleTime: 5 * 60_000,
  });

  // 이벤트 (워크샵/컨퍼런스/출장) — 연도별. calendar 페이지와 동일 queryKey.
  const { data: events = [] } = useQuery<EventRow[]>({
    queryKey: ["quick-events-calendar", yearKey],
    queryFn: async () => {
      const all: EventRow[] = [];
      for (const y of years) {
        const rows = (
          await api.get("/events/calendar", { params: { year: y } })
        ).data;
        all.push(...rows);
      }
      return all;
    },
    enabled: isOpen,
    staleTime: 5 * 60_000,
  });

  // 본인 미완료 액션 — 마감일이 있는 항목만 표시. 연도 무관.
  const { data: actionItems = [] } = useQuery<ActionRow[]>({
    queryKey: ["my-action-items", false],
    queryFn: async () =>
      (
        await api.get("/meeting-notes/action-items/mine", {
          params: { include_done: false },
        })
      ).data,
    enabled: isOpen,
    staleTime: 60_000,
  });

  // 'YYYY-MM-DD' → Holiday[] (배열, 같은 날 여러 row 보존). dot 카운트에 필요.
  const holidayMap = useMemo(() => {
    const m = new Map<string, Holiday[]>();
    for (const h of holidays) {
      const arr = m.get(h.date);
      if (arr) arr.push(h);
      else m.set(h.date, [h]);
    }
    return m;
  }, [holidays]);

  // start_date ~ end_date (양끝 포함) 범위를 일자별로 펼침.
  const eventMap = useMemo(() => {
    const m = new Map<string, SharedEvent[]>();
    for (const e of events) {
      const start = new Date(e.start_date);
      const end = new Date(e.end_date);
      const cur = new Date(start);
      while (cur <= end) {
        const key = ymd(cur);
        const arr = m.get(key) ?? [];
        arr.push({ id: e.id, title: e.title, kind: e.kind });
        m.set(key, arr);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return m;
  }, [events]);

  const actionMap = useMemo(() => {
    const m = new Map<string, SharedAction[]>();
    for (const a of actionItems) {
      if (!a.due_date) continue;
      const arr = m.get(a.due_date) ?? [];
      arr.push({ id: a.id, title: a.title });
      m.set(a.due_date, arr);
    }
    return m;
  }, [actionItems]);

  const todayMonthKey =
    new Date().getFullYear() * 100 + (new Date().getMonth() + 1);
  const anchorMonthKey = anchor.getFullYear() * 100 + (anchor.getMonth() + 1);
  const isAtToday = anchorMonthKey === todayMonthKey;

  return (
    <div
      className={
        "fixed top-0 right-0 h-full z-40 transition-transform duration-200 ease-out " +
        (isOpen ? "translate-x-0" : "translate-x-full pointer-events-none")
      }
      aria-hidden={!isOpen}
      style={{ width: 360 }}
    >
      <div className="h-full flex flex-col bg-card border-l border-border shadow-xl">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            <h2 className="text-sm font-semibold">달력</h2>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="닫기"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 네비게이션 — prev/next/오늘 */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <button
            type="button"
            onClick={() => setAnchor((a) => shiftMonth(a, -1))}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
            aria-label="이전 달"
            title="이전 달"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              const t = new Date();
              setAnchor(new Date(t.getFullYear(), t.getMonth(), 1));
            }}
            disabled={isAtToday}
            className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
            title="오늘 기준으로"
          >
            <RotateCcw className="h-3 w-3" />
            오늘
          </button>
          <button
            type="button"
            onClick={() => setAnchor((a) => shiftMonth(a, 1))}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
            aria-label="다음 달"
            title="다음 달"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 본문 — 3개월 stack */}
        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          <MonthGrid
            anchor={prev}
            positionLabel={isAtToday ? "전달" : undefined}
            holidayMap={holidayMap}
            eventMap={eventMap}
            actionMap={actionMap}
          />
          <MonthGrid
            anchor={anchor}
            positionLabel={isAtToday ? "이번달" : "기준 월"}
            holidayMap={holidayMap}
            eventMap={eventMap}
            actionMap={actionMap}
          />
          <MonthGrid
            anchor={next}
            positionLabel={isAtToday ? "다음달" : undefined}
            holidayMap={holidayMap}
            eventMap={eventMap}
            actionMap={actionMap}
          />
        </div>

        {/* 범례 — drawer 하단 고정. 스크롤 영역과 분리. */}
        <div className="shrink-0 border-t border-border px-3 pb-3">
          <CalendarLegend canSeePrivate={canSeePrivate} />
        </div>
      </div>
    </div>
  );
}
