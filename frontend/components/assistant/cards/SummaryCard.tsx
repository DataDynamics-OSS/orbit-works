"use client";

import { Wallet } from "lucide-react";
import { fmtKRW, fmtDate } from "../format";
import { Sparkline } from "../Sparkline";

type Result = {
  period: string;
  start: string;
  end: string;
  provider_filter: string | null;
  total_krw: number;
  by_provider: Record<string, number>;
  top_services: { provider: string; service: string; amount_krw: number }[];
  daily_series?: { usage_date: string; amount_krw: number }[];
};

const PERIOD_LABEL: Record<string, string> = {
  this_month: "이번 달",
  last_month: "지난 달",
  last_7_days: "최근 7일",
  last_30_days: "최근 30일",
};

const PROVIDER_COLOR: Record<string, string> = {
  AWS: "bg-orange-100 text-orange-800",
  AZURE: "bg-blue-100 text-blue-800",
  GCP: "bg-rose-100 text-rose-800",
};

export function SummaryCard({ result }: { result: Result }) {
  const series = (result.daily_series ?? []).map((d) => d.amount_krw);
  const total = result.total_krw || 0;

  return (
    <div className="rounded-md border border-border border-l-2 border-l-sky-500 bg-card text-foreground px-3 py-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Wallet className="h-3 w-3 text-sky-500" />
        <span>클라우드 비용 — {PERIOD_LABEL[result.period] ?? result.period}</span>
        {result.provider_filter && (
          <span className="font-mono text-[10px] text-muted-foreground">({result.provider_filter})</span>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xl font-bold tabular-nums tracking-tight">{fmtKRW(total)}</div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            {fmtDate(result.start)} ~ {fmtDate(result.end)}
          </div>
        </div>
        {series.length >= 2 && (
          <div className="text-sky-500">
            <Sparkline values={series} width={120} height={32} />
          </div>
        )}
      </div>

      {result.by_provider && Object.keys(result.by_provider).length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(result.by_provider).map(([p, v]) => (
            <div
              key={p}
              className={
                "rounded px-2 py-0.5 text-[10px] flex items-baseline gap-1.5 " +
                (PROVIDER_COLOR[p] ?? "bg-muted text-foreground")
              }
            >
              <span className="font-mono">{p}</span>
              <span className="font-mono tabular-nums">{fmtKRW(v)}</span>
            </div>
          ))}
        </div>
      )}

      {result.top_services && result.top_services.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] text-muted-foreground">상위 서비스</div>
          {result.top_services.slice(0, 5).map((s, i) => {
            const pct = total > 0 ? s.amount_krw / total : 0;
            return (
              <div key={i} className="relative flex items-center gap-2 text-[11px] py-0.5">
                <div
                  aria-hidden
                  className="absolute inset-y-0 left-0 rounded-sm bg-sky-100"
                  style={{ width: `${Math.min(pct * 100, 100)}%` }}
                />
                <span className="relative font-mono text-[10px] text-muted-foreground w-10 shrink-0">{s.provider}</span>
                <span className="relative flex-1 truncate">{s.service}</span>
                <span className="relative font-mono tabular-nums shrink-0">{fmtKRW(s.amount_krw)}</span>
              </div>
            );
          })}
        </div>
      )}

      {total === 0 && (
        <div className="text-[10px] text-muted-foreground">
          이 기간의 비용 데이터가 없습니다. (수집이 비활성이거나 KRW 환산 환율 미설정)
        </div>
      )}
    </div>
  );
}
