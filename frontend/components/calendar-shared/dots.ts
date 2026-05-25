/**
 * 캘린더 dot/legend 공통 모듈.
 *
 * `app/(dashboard)/calendar` (YearView mini) 와 헤더의 빠른 달력 드로어
 * (`components/quick-calendar`) 가 동일한 dot 색·우선순위·툴팁 규칙을
 * 공유한다.
 *
 * 규칙: 한 날의 항목 합계가
 *   1 개  → 그 항목의 legend 색
 *   2 개+ → MULTI_DOT (진한 회색) 단일 dot + tooltip 으로 모두 안내
 *   0 개  → dot 없음
 */

export type HolidayType =
  | "STATUTORY"
  | "TEMPORARY"
  | "COMPANY"
  | "EVENT_PUBLIC"
  | "EVENT_PRIVATE"
  | "EVENT_PERSONAL"
  | "EVENT_PAYDAY";

export type EventKind = "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";

export type SharedHoliday = {
  date: string; // YYYY-MM-DD
  name: string;
  type: HolidayType;
};

export type SharedEvent = {
  id: string;
  title: string;
  kind: EventKind;
};

export type SharedAction = {
  id: string;
  title: string;
};

// 근무일수 차감 대상 — 휴일 3종만. EVENT_* 는 일반 영업일.
export const REAL_HOLIDAY_TYPES: readonly HolidayType[] = [
  "STATUTORY",
  "TEMPORARY",
  "COMPANY",
];

export const TYPE_LABEL: Record<HolidayType, string> = {
  STATUTORY: "법정 공휴일",
  TEMPORARY: "임시 공휴일",
  COMPANY: "회사 휴일",
  EVENT_PUBLIC: "공개 일정",
  EVENT_PRIVATE: "비공개 일정",
  EVENT_PERSONAL: "개인 일정",
  EVENT_PAYDAY: "급여일",
};

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  WORKSHOP: "워크샵",
  CONFERENCE: "컨퍼런스",
  BUSINESS_TRIP: "출장",
};

export const EVENT_KIND_ICON: Record<EventKind, string> = {
  WORKSHOP: "🎯",
  CONFERENCE: "🎤",
  BUSINESS_TRIP: "✈️",
};

// 휴일·일정 타입 → dot 색. legend swatch 와 1:1 일치.
export const HOLIDAY_TYPE_DOT: Record<HolidayType, string> = {
  STATUTORY: "bg-red-500",
  TEMPORARY: "bg-amber-500",
  COMPANY: "bg-sky-500",
  EVENT_PUBLIC: "bg-emerald-500",
  EVENT_PRIVATE: "bg-violet-500",
  EVENT_PERSONAL: "bg-pink-500",
  EVENT_PAYDAY: "bg-yellow-500",
};

// 이벤트 종류 → dot 색. legend 와 1:1.
export const EVENT_KIND_DOT: Record<EventKind, string> = {
  WORKSHOP: "bg-emerald-500",
  CONFERENCE: "bg-violet-500",
  BUSINESS_TRIP: "bg-orange-500",
};

// 본인 미완료 액션 마감 dot 색.
export const ACTION_DOT = "bg-slate-500";

// 한 날에 항목이 2개 이상 겹칠 때 — 종류 분간 의미가 없어지므로 진한 회색
// 단일 dot + tooltip 으로 모두 안내.
export const MULTI_DOT = "bg-slate-700";

/**
 * 한 날의 항목들로부터 dot 색 클래스를 결정.
 * - count = 1 → 해당 항목의 legend 색
 * - count >= 2 → MULTI_DOT (진한 회색)
 * - count = 0 → "" (dot 미표시)
 */
export function pickDotCls(
  holidays: SharedHoliday[],
  events: SharedEvent[],
  actions: SharedAction[],
): string {
  const total = holidays.length + events.length + actions.length;
  if (total === 0) return "";
  if (total === 1) {
    if (holidays.length === 1) return HOLIDAY_TYPE_DOT[holidays[0].type];
    if (events.length === 1) return EVENT_KIND_DOT[events[0].kind];
    return ACTION_DOT;
  }
  return MULTI_DOT;
}

/**
 * 한 날의 항목들을 합쳐 native title 용 한 줄 tooltip 문자열로.
 * 휴일명 (타입) · 🎯 이벤트 제목 · 📋 액션 제목
 */
export function buildTooltip(
  holidays: SharedHoliday[],
  events: SharedEvent[],
  actions: SharedAction[],
): string {
  const parts: string[] = [];
  if (holidays.length) {
    parts.push(
      holidays.map((h) => `${h.name} (${TYPE_LABEL[h.type]})`).join(", "),
    );
  }
  if (events.length) {
    parts.push(
      events.map((e) => `${EVENT_KIND_ICON[e.kind]} ${e.title}`).join(", "),
    );
  }
  if (actions.length) {
    parts.push(actions.map((a) => `📋 ${a.title}`).join(", "));
  }
  return parts.filter(Boolean).join(" · ");
}
