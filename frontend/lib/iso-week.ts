/**
 * ISO 8601 주(week) 유틸 — 주간보고 / 캘린더 등 주 단위 UI 에서 사용.
 *
 * 정의:
 *   - 한 주는 월요일 시작.
 *   - 한 해의 1주차는 1월 4일을 포함하는 주 (한 해 끝/다음해 시작에 걸침).
 *   - getISOWeek 등 외부 라이브러리 의존성 없이 자체 계산.
 */

export type IsoWeek = { year: number; week: number };
export type IsoWeekRange = IsoWeek & { start: Date; end: Date };

/** Date → 그 날짜가 속한 ISO 주 (year, week). 시간 정보는 무시. */
export function isoWeekOf(d: Date): IsoWeek {
  // Thursday-based — ISO 8601 알고리즘.
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7;     // 일=7 처리
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { year: dt.getUTCFullYear(), week: weekNo };
}

/** (year, week) → 그 주의 월요일·일요일. */
export function weekRange(year: number, week: number): IsoWeekRange {
  // ISO: 1월 4일을 포함하는 주가 1주차.
  const jan4 = new Date(year, 0, 4);
  const jan4Dow = jan4.getDay() || 7;
  // 1주차 월요일.
  const week1Mon = new Date(year, 0, 4 - (jan4Dow - 1));
  const monday = new Date(week1Mon);
  monday.setDate(monday.getDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return { year, week, start: monday, end: sunday };
}

/** 주 단위 +/- 이동. 음수도 처리. */
export function shiftWeek(w: IsoWeek, delta: number): IsoWeek {
  const { start } = weekRange(w.year, w.week);
  start.setDate(start.getDate() + delta * 7);
  return isoWeekOf(start);
}

/** ISO 주 monotonic key — 정렬·범위 비교 용. (2026, 5) → 202605. */
export function isoWeekKey(w: IsoWeek): number {
  return w.year * 100 + w.week;
}

/** 'YYYY-MM-DD' 포맷. */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 표시용 라벨 — '2026-W19 (5/4 ~ 5/10)'. */
export function weekLabel(w: IsoWeek): string {
  const r = weekRange(w.year, w.week);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${w.year}-W${String(w.week).padStart(2, "0")} (${fmt(r.start)} ~ ${fmt(r.end)})`;
}
