"use client";

/**
 * 한 달짜리 캘린더 렌더 — 헤더(월·요일) + 6×7 셀 grid.
 *
 * 휴일 (STATUTORY/TEMPORARY/COMPANY) 은 빨강 + 굵은 글씨, 일요일 = 빨강,
 * 토요일 = 파랑, 평일 = 기본. 다른 달 cell 은 흐림. 오늘 = 원형 primary 배경.
 *
 * 셀 우상단 작은 dot — 그 날의 항목 합계가
 *   1 개   → 해당 항목의 legend 색
 *   2 개+  → 진한 회색 (slate-700) 단일 dot + native title 로 모두 안내
 *   0 개   → dot 없음
 * 색 매핑·헬퍼는 `@/components/calendar-shared/dots` 와 공유 (calendar
 * 페이지의 YearView mini 와 동일 규칙).
 *
 * 정확한 표시 라벨 ('전달', '이번달', '다음달') 은 부모 (QuickCalendarDrawer)
 * 가 결정해 prop 으로 전달.
 */

import {
  REAL_HOLIDAY_TYPES,
  buildTooltip,
  pickDotCls,
  type SharedAction,
  type SharedEvent,
  type SharedHoliday,
} from "@/components/calendar-shared/dots";

// drawer 가 사용하는 구체 Holiday 타입 — 공유 SharedHoliday 와 호환되는
// 최소 형태 (date / name / type).
export type Holiday = SharedHoliday;

const DOW_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

type Props = {
  /** 표시할 월의 1일 자정 Date — year/month 만 사용. */
  anchor: Date;
  /** 부모 라벨 (전달/이번달/다음달 등). 없으면 표시 X. */
  positionLabel?: string;
  /** 휴일 lookup — 'YYYY-MM-DD' → Holiday[]. 같은 날 여러 row 가능. */
  holidayMap: Map<string, Holiday[]>;
  /** 이벤트 (워크샵/컨퍼런스/출장) lookup. */
  eventMap?: Map<string, SharedEvent[]>;
  /** 본인 미완료 액션 마감 lookup. */
  actionMap?: Map<string, SharedAction[]>;
};

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function MonthGrid({
  anchor,
  positionLabel,
  holidayMap,
  eventMap,
  actionMap,
}: Props) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth(); // 0-based
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay(); // 0(일) ~ 6(토)

  // 6 row × 7 col = 42 cell. 첫 cell 은 그 주 일요일에 해당하는 날짜.
  const startDate = new Date(year, month, 1 - startDow);
  const todayKey = ymd(new Date());

  return (
    <div className="rounded-md border border-border bg-card">
      {/* 월 라벨 */}
      <div className="flex items-baseline justify-between px-2 pt-2 pb-1">
        <div className="text-sm font-semibold tabular-nums">
          {year}년 {month + 1}월
        </div>
        {positionLabel && (
          <div className="text-[11px] text-muted-foreground">{positionLabel}</div>
        )}
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 px-1.5">
        {DOW_LABEL.map((d, i) => (
          <div
            key={d}
            className={
              "text-center text-[11px] font-medium py-1 " +
              (i === 0
                ? "text-rose-600"
                : i === 6
                  ? "text-blue-600"
                  : "text-muted-foreground")
            }
          >
            {d}
          </div>
        ))}
      </div>

      {/* 일자 grid */}
      <div className="grid grid-cols-7 px-1.5 pb-2 gap-y-0.5">
        {Array.from({ length: 42 }, (_, i) => {
          const d = new Date(startDate);
          d.setDate(startDate.getDate() + i);
          const k = ymd(d);
          const inMonth = d.getMonth() === month;
          const isToday = k === todayKey;
          const dow = d.getDay();
          const list = holidayMap.get(k) ?? [];
          const evs = eventMap?.get(k) ?? [];
          const acts = actionMap?.get(k) ?? [];
          const isHoliday = list.some((h) =>
            (REAL_HOLIDAY_TYPES as readonly string[]).includes(h.type),
          );
          const baseTone = !inMonth
            ? "text-muted-foreground/40"
            : isHoliday || dow === 0
              ? "text-rose-600 font-semibold"
              : dow === 6
                ? "text-blue-600"
                : "text-foreground";
          // dot 은 inMonth 만 (다른 달 셀은 흐림 처리, 표시 안 함).
          const dotCls = inMonth
            ? pickDotCls(list, evs, acts)
            : "";
          const tip = inMonth ? buildTooltip(list, evs, acts) : "";
          return (
            <div
              key={i}
              className="relative flex items-center justify-center"
              title={tip || undefined}
            >
              <span
                className={
                  "h-7 w-7 inline-flex items-center justify-center text-xs tabular-nums rounded-full " +
                  (isToday
                    ? "bg-primary text-primary-foreground font-semibold"
                    : baseTone)
                }
              >
                {d.getDate()}
              </span>
              {dotCls && (
                <span
                  className={
                    "absolute top-0 right-1 h-1.5 w-1.5 rounded-full " + dotCls
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
