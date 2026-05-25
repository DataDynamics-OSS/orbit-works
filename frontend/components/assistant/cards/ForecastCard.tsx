"use client";

import { TrendingUp } from "lucide-react";
import { fmtKRW } from "../format";

type Result = {
  month: string;
  days_in_month: number;
  elapsed_days: number;
  remaining_days: number;
  provider_filter: string | null;
  mtd_krw: number;
  forecast_total_krw: number;
  method: string;
  as_of: string;
};

export function ForecastCard({ result }: { result: Result }) {
  const progress = result.days_in_month > 0
    ? Math.min(result.elapsed_days / result.days_in_month, 1)
    : 0;
  const overshoot = result.forecast_total_krw > 0 && result.mtd_krw > 0
    ? result.mtd_krw / result.forecast_total_krw
    : 0;

  return (
    <div className="rounded-md border border-border border-l-2 border-l-emerald-500 bg-card text-foreground px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <TrendingUp className="h-3 w-3 text-emerald-500" />
        <span>{result.month} 클라우드 비용 예측</span>
        {result.provider_filter && (
          <span className="font-mono text-[10px] text-muted-foreground">({result.provider_filter})</span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums tracking-tight">{fmtKRW(result.forecast_total_krw)}</span>
        <span className="text-[10px] text-muted-foreground">월말 예상</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px]">
        <div>
          <div className="text-[10px] text-muted-foreground">MTD 실적</div>
          <div className="font-mono tabular-nums">{fmtKRW(result.mtd_krw)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">경과</div>
          <div className="tabular-nums">
            {result.elapsed_days} / {result.days_in_month}일
            <span className="text-muted-foreground"> · 잔여 {result.remaining_days}일</span>
          </div>
        </div>
      </div>
      <div className="mt-1.5 relative h-1 rounded-full bg-muted overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500"
          style={{ width: `${overshoot * 100}%` }}
          title="현재 누적"
        />
        <div
          className="absolute inset-y-0 left-0 border-r-2 border-foreground/60"
          style={{ width: `${progress * 100}%` }}
          title="시간 경과"
        />
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">방식: {result.method}</div>
    </div>
  );
}
