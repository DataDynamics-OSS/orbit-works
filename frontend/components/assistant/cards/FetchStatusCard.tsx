"use client";

import { RefreshCw } from "lucide-react";
import { relativeTime, fmtNumber } from "../format";

type ProviderStatus = {
  provider: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  fetched_count: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

type Result = { providers: ProviderStatus[] };

export function FetchStatusCard({ result }: { result: Result }) {
  return (
    <div className="rounded-md border border-border border-l-2 border-l-slate-400 bg-card text-foreground px-3 py-2 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <RefreshCw className="h-3 w-3 text-slate-500" />
        <span>최근 비용 수집 상태</span>
      </div>
      {result.providers.length === 0 && (
        <div className="text-[11px] text-muted-foreground">아직 수집 이력이 없습니다.</div>
      )}
      {result.providers.map((p) => {
        const ok = p.status === "SUCCESS";
        const skipped = p.status === "SKIPPED";
        const failed = p.status === "FAILED";
        return (
          <div key={p.provider} className="text-[11px]">
            <div className="flex items-center gap-1.5">
              <span
                className={
                  "h-1.5 w-1.5 rounded-full shrink-0 " +
                  (ok ? "bg-emerald-500" : skipped ? "bg-slate-400" : "bg-rose-500")
                }
              />
              <span className="font-mono text-[10px] w-12 shrink-0">{p.provider}</span>
              <span
                className={
                  "font-medium " +
                  (ok
                    ? "text-emerald-700"
                    : skipped
                    ? "text-muted-foreground"
                    : "text-rose-600")
                }
              >
                {p.status}
              </span>
              <span className="text-muted-foreground tabular-nums">{fmtNumber(p.fetched_count)}건</span>
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                {relativeTime(p.started_at)}
              </span>
            </div>
            {failed && p.error && (
              <div className="mt-0.5 ml-4 text-[10px] text-rose-600 line-clamp-2">
                {p.error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
