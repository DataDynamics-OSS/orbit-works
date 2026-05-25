// 시간 유틸은 @orbit/shared/lib/time 에 통합. 기존 import 경로 유지용 re-export.
// 주간 그리드가 쓰는 SLOT_PX 는 데스크톱 값으로 alias 한다.

export {
  SLOT_MINUTES,
  SLOTS_PER_HOUR,
  HOUR_START,
  HOUR_END,
  TOTAL_SLOTS,
  DESKTOP_SLOT_PX as SLOT_PX,
  startOfWeek,
  addDays,
  addMinutes,
  ymd,
  formatWeekdayShort,
  formatDayHeader,
  formatHhmm,
  formatRangeShort,
  isSameDay,
  toLocalInput,
  fromLocalInput,
  isoWeekNumber,
} from "@orbit/shared/lib/time";
