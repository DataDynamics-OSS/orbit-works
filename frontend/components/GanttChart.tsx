"use client";

import { useMemo } from "react";
import { colorForId } from "@/lib/format";
import { Tooltip } from "@/components/ui/Tooltip";

export type GanttAssignment = {
  id: string;
  developer_id: string;
  developer_name?: string;
  project_id: string;
  project_name?: string;
  start_date: string;
  end_date: string;
  is_insourced: boolean;
  color?: string;
};

export type GanttDeveloper = {
  id: string;
  name: string;
  color?: string;
};

type Props = {
  assignments: GanttAssignment[];
  developers: GanttDeveloper[];
  rangeStart: string;
  rangeEnd: string;
};

const DAY_MS = 86_400_000;

export function GanttChart({ assignments, developers, rangeStart, rangeEnd }: Props) {
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);
  const totalMs = Math.max(end.getTime() - start.getTime(), DAY_MS);

  const devIds = useMemo(
    () => Array.from(new Set(assignments.map((a) => a.developer_id))),
    [assignments],
  );
  const devs = useMemo(
    () =>
      developers
        .filter((d) => devIds.includes(d.id))
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [developers, devIds],
  );

  const months = useMemo(() => {
    const out: Date[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      out.push(new Date(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return out;
  }, [start, end]);

  const pct = (d: Date) => ((d.getTime() - start.getTime()) / totalMs) * 100;

  if (devs.length === 0) {
    return (
      <div className="p-10 text-center text-slate-400">
        해당 기간에 표시할 투입 데이터가 없습니다.
      </div>
    );
  }

  const ROW_HEIGHT = 44;
  const LABEL_WIDTH = 128;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[900px]">
        {/* Header */}
        <div className="flex border-b border-slate-200">
          <div
            className="shrink-0 px-3 py-2 text-xs font-semibold bg-slate-100 border-r border-slate-200"
            style={{ width: LABEL_WIDTH }}
          >
            개발자
          </div>
          <div className="flex-1 relative bg-slate-50 h-9">
            {months.map((m, i) => {
              const left = pct(m);
              if (left < 0 || left > 100) return null;
              return (
                <div
                  key={i}
                  className="absolute top-0 h-full border-l border-slate-200 text-[11px] text-slate-500"
                  style={{ left: `${left}%` }}
                >
                  <span className="pl-1">
                    {m.getFullYear()}.{String(m.getMonth() + 1).padStart(2, "0")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Rows */}
        {devs.map((dev) => {
          const devAssignments = assignments.filter((a) => a.developer_id === dev.id);
          const color = dev.color ?? colorForId(dev.id);
          return (
            <div
              key={dev.id}
              className="flex border-b border-slate-100 hover:bg-slate-50"
              style={{ height: ROW_HEIGHT }}
            >
              <div
                className="shrink-0 px-3 flex items-center text-sm border-r border-slate-200 bg-white truncate"
                style={{ width: LABEL_WIDTH }}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full mr-2"
                  style={{ backgroundColor: color }}
                />
                {dev.name}
              </div>
              <div className="flex-1 relative">
                {months.map((m, i) => {
                  const left = pct(m);
                  if (left < 0 || left > 100) return null;
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-full border-l border-slate-100"
                      style={{ left: `${left}%` }}
                    />
                  );
                })}
                {devAssignments.map((a) => {
                  const s = new Date(a.start_date);
                  const e = new Date(a.end_date);
                  const endExclusive = new Date(e.getTime() + DAY_MS);
                  const leftPct = Math.max(0, pct(s));
                  const rightPct = Math.min(100, pct(endExclusive));
                  const widthPct = rightPct - leftPct;
                  if (widthPct <= 0) return null;
                  const bg = a.color ?? color;
                  return (
                    <div
                      key={a.id}
                      className="group/tt absolute"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: 6,
                        height: ROW_HEIGHT - 12,
                      }}
                    >
                      <div
                        className="h-full w-full rounded px-2 text-xs text-white flex items-center overflow-hidden whitespace-nowrap shadow-sm"
                        style={{
                          backgroundColor: bg,
                          border: a.is_insourced ? "2px dashed rgba(255,255,255,0.7)" : undefined,
                        }}
                      >
                        {a.project_name ?? ""}
                      </div>
                      <Tooltip
                        inline
                        side="top"
                        label={
                          <>
                            {a.project_name ?? ""}
                            <br />
                            {a.start_date} ~ {a.end_date}
                            {a.is_insourced ? " (자사화)" : ""}
                          </>
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
