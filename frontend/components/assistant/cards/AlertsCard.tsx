"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { fmtDate, relativeTime } from "../format";

type AlertEvent = {
  fired_at: string;
  rule_name: string;
  rule_type: string;
  message: string;
  delivered: boolean;
};

type Result = {
  since: string;
  count: number;
  events: AlertEvent[];
};

export function AlertsCard({ result }: { result: Result }) {
  if (!result.count) {
    return (
      <div className="rounded-md border border-border border-l-2 border-l-emerald-500 bg-card px-3 py-2 flex items-center gap-2 text-[11px] text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        <span>{fmtDate(result.since)} 이후 발생한 비용 알림이 없습니다.</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border border-l-2 border-l-amber-500 bg-card text-foreground px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <AlertTriangle className="h-3 w-3 text-amber-500" />
        <span>비용 알림</span>
        <span className="ml-0.5 rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums bg-amber-100 text-amber-800">
          {result.count}건
        </span>
        <span className="text-muted-foreground font-normal">({fmtDate(result.since)} 이후)</span>
      </div>
      <div className="space-y-1">
        {result.events.slice(0, 6).map((ev, i) => (
          <div key={i} className="rounded bg-muted/50 px-2 py-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span
                className={
                  "h-1.5 w-1.5 rounded-full shrink-0 " +
                  (ev.delivered ? "bg-emerald-500" : "bg-rose-500")
                }
                title={ev.delivered ? "발송 성공" : "발송 실패"}
              />
              <span className="font-mono text-[10px] text-muted-foreground shrink-0">{ev.rule_type}</span>
              <span className="font-medium truncate">{ev.rule_name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums shrink-0">
                {relativeTime(ev.fired_at)}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2 pl-4">
              {ev.message}
            </div>
          </div>
        ))}
        {result.events.length > 6 && (
          <div className="text-[10px] text-muted-foreground text-center pt-0.5">
            외 {result.events.length - 6}건
          </div>
        )}
      </div>
    </div>
  );
}
