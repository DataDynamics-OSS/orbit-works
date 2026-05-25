"use client";

/**
 * 캘린더 공통 범례 — calendar 페이지 (월간/연간) 와 헤더의 빠른 달력 드로어
 * 가 공유. swatch 색은 dots.ts 의 dot 색과 1:1 일치 — 한 날에 1개만 있을
 * 때 셀의 dot 으로 그대로 사용된다.
 *
 * `canSeePrivate` (HR/ADMIN/SUPER_ADMIN) 인 사용자만 비공개 일정 swatch 노출.
 */

type Props = {
  canSeePrivate: boolean;
};

export function CalendarLegend({ canSeePrivate }: Props) {
  const items: { swatch: string; label: string }[] = [
    { swatch: "bg-red-500", label: "법정 공휴일" },
    { swatch: "bg-amber-500", label: "임시 공휴일" },
    { swatch: "bg-sky-500", label: "회사 휴일" },
    { swatch: "bg-emerald-500", label: "공개 일정" },
  ];
  if (canSeePrivate) {
    items.push({ swatch: "bg-violet-500", label: "비공개 일정" });
  }
  items.push({ swatch: "bg-pink-500", label: "개인 일정" });
  items.push({ swatch: "bg-yellow-500", label: "급여일" });

  const events: { swatch: string; label: string }[] = [
    { swatch: "bg-emerald-500", label: "🎯 워크샵" },
    { swatch: "bg-violet-500", label: "🎤 컨퍼런스" },
    { swatch: "bg-orange-500", label: "✈️ 출장" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-2 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <div key={i.label} className="inline-flex items-center gap-1.5">
          <span className={"inline-block w-3 h-3 rounded-sm " + i.swatch} />
          {i.label}
        </div>
      ))}
      <span className="text-muted-foreground/50">|</span>
      {events.map((e) => (
        <div key={e.label} className="inline-flex items-center gap-1.5">
          <span className={"inline-block w-3 h-3 rounded-sm " + e.swatch} />
          {e.label}
        </div>
      ))}
      <span className="text-muted-foreground/50">|</span>
      <div className="inline-flex items-center gap-1.5">
        {/* 셀 배지와 동일한 회색 톤. 액션 마감은 'TODO 알림' 성격이라
            중립적인 slate 가 적합. 임시 공휴일(amber)·이벤트(emerald 등)
            와 색이 겹치지 않게 분리. */}
        <span className="inline-block w-3 h-3 rounded-sm bg-slate-100 border border-slate-300" />
        📋 내 액션 마감
      </div>
    </div>
  );
}
