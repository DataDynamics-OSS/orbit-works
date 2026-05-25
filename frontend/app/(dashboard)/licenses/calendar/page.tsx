"use client";

import { useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import multiMonthPlugin from "@fullcalendar/multimonth";
import koLocale from "@fullcalendar/core/locales/ko";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";

type Event = {
  license_id: string;
  title: string;
  customer_name?: string;
  type: string;
  date: string;
};

const TYPE_COLOR: Record<string, string> = {
  START: "#2563eb", // blue-600
  END: "#dc2626", // red-600
  RENEWAL_PREP: "#f59e0b",
};

export default function LicenseCalendarPage() {
  const [year, setYear] = useState(new Date().getFullYear());

  const { data, isFetching } = useQuery<{ year: number; events: Event[] }>({
    queryKey: ["license-calendar", year],
    queryFn: async () => (await api.get(`/licenses/calendar/${year}`)).data,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Mount FullCalendar only once we have the data for the active year, and
  // key it by `year|event-count` so any response change forces a clean mount
  // with the right `initialDate` + populated events.
  const ready = !!data && data.year === year;
  const calKey = ready ? `${year}-${data!.events.length}` : `loading-${year}`;

  // Map iso-date → list of { color, tooltip } for direct day-cell painting.
  // 고객사명은 더 이상 셀 내부에 렌더하지 않고 색상 + tooltip 으로만 표현.
  const dayMarkers = useMemo(() => {
    const m = new Map<string, { color: string; tooltip: string }[]>();
    (data?.events ?? []).forEach((e) => {
      const tooltip = e.customer_name
        ? `${e.customer_name} - ${e.title}`
        : e.title;
      const color = TYPE_COLOR[e.type] ?? "#2563eb";
      const arr = m.get(e.date) ?? [];
      arr.push({ color, tooltip });
      m.set(e.date, arr);
    });
    return m;
  }, [data]);

  return (
    <>
      <DashboardHeader title="라이센스 연간 캘린더" />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">

      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        {ready ? (
          <FullCalendar
            key={calKey}
            plugins={[multiMonthPlugin]}
            initialView="multiMonthYear"
            initialDate={`${year}-01-01`}
            locale={koLocale}
            events={[]}
            height="auto"
            multiMonthMaxColumns={4}
            headerToolbar={{
              start: "title",
              center: "",
              end: "prev,next",
            }}
            titleFormat={{ year: "numeric" }}
            datesSet={(arg) => {
              // multiMonthYear view: start = Jan 1, end = Dec 31 + 1 day of the
              // displayed year. Use the midpoint to avoid off-by-one when
              // landing on Jan 1 after a timezone conversion.
              const mid = new Date(
                (arg.start.getTime() + arg.end.getTime()) / 2,
              );
              const y = mid.getFullYear();
              if (y !== year) setYear(y);
            }}
            dayCellDidMount={(arg) => {
              // Skip cells borrowed from adjacent months (e.g., Apr 1 shown
              // at the end of March's grid) — they should not be painted.
              if (arg.isOther) return;
              const d = arg.date;
              const iso = `${d.getFullYear()}-${String(
                d.getMonth() + 1,
              ).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              const hits = dayMarkers.get(iso);
              if (!hits || hits.length === 0) return;
              const frame =
                arg.el.querySelector<HTMLElement>(
                  ".fc-daygrid-day-frame",
                ) ?? arg.el;
              // Layered gradient stripes if more than one marker on the same day,
              // otherwise solid fill. Opacity 는 hex alpha 로 색상에 직접 섞어서
              // frame 의 opacity 가 children (tooltip bubble) 까지 흐리는 것을 방지.
              const WITH_ALPHA = "8C"; // 0x8C ≈ 140/255 ≈ 0.55
              if (hits.length === 1) {
                frame.style.backgroundColor = `${hits[0].color}${WITH_ALPHA}`;
              } else {
                const pct = 100 / hits.length;
                const stops = hits
                  .map((h, i) => {
                    const a = (i * pct).toFixed(2);
                    const b = ((i + 1) * pct).toFixed(2);
                    return `${h.color}${WITH_ALPHA} ${a}%, ${h.color}${WITH_ALPHA} ${b}%`;
                  })
                  .join(", ");
                frame.style.background = `linear-gradient(to bottom, ${stops})`;
              }

              // 앱 공통 Tooltip 컴포넌트와 동일한 Tailwind 클래스로 DOM 으로
              // 주입. FullCalendar 셀은 React 재렌더 없이 dayCellDidMount 안에서
              // imperative 로 다뤄야 하므로 group/tt + hover 클래스 구조를 손으로 구성.
              frame.style.position = "relative";
              frame.classList.add("group/tt");

              const bubble = document.createElement("div");
              bubble.setAttribute("role", "tooltip");
              bubble.className = [
                "pointer-events-none absolute z-50",
                "px-2.5 py-1 rounded-md",
                "bg-popover text-popover-foreground",
                "text-sm font-medium",
                "border border-border shadow-md",
                "opacity-0 transition-all duration-100 ease-out",
                "group-hover/tt:opacity-100",
                "bottom-full left-1/2 -translate-x-1/2 mb-2",
                "translate-y-[2px] group-hover/tt:translate-y-0",
                "whitespace-pre",
              ].join(" ");
              bubble.textContent = hits.map((h) => h.tooltip).join("\n");
              frame.appendChild(bubble);
            }}
          />
        ) : (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            {isFetching ? "불러오는 중..." : "데이터가 없습니다."}
          </div>
        )}
        <div className="mt-4 flex gap-3 text-xs">
          <Legend color={TYPE_COLOR.START} label="시작" />
          <Legend color={TYPE_COLOR.END} label="종료" />
          <Legend color={TYPE_COLOR.RENEWAL_PREP} label="연장 준비" />
        </div>
      </div>
      </div>
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="inline-block w-3 h-3 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </div>
  );
}

