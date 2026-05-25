"use client";

/**
 * 도구 호출 결과 라우터.
 *
 * 등록된 도구 이름에 대해 전용 카드 컴포넌트를 매칭. 미등록 도구는 raw JSON
 * fallback (collapsible) — 새 도구 추가 시 카드를 같이 안 만들어도 깨지지 않음.
 *
 * 상태별 시각적 구분:
 * - 진행 중 (result==null) : 노랑 좌측 보더 + 스피너
 * - 성공 (result 있음)      : 도구별 카드
 * - 실패 (result.error)     : 빨강 좌측 보더 + 메시지
 */

import { Loader2, AlertCircle, Wrench } from "lucide-react";
import { ForecastCard } from "./ForecastCard";
import { SummaryCard } from "./SummaryCard";
import { AlertsCard } from "./AlertsCard";
import { FetchStatusCard } from "./FetchStatusCard";

type Props = {
  name: string;
  args: any;
  result: any;
};

const TOOL_LABEL: Record<string, string> = {
  forecast_monthly_cost: "비용 예측",
  get_cloud_cost_summary: "비용 요약",
  list_recent_cost_alerts: "비용 알림",
  get_last_fetch_status: "수집 상태",
};

export function ToolResultCard({ name, args, result }: Props) {
  // 진행 중 — orchestrator 가 tool_call 만 보내고 아직 result 가 안 옴.
  if (result == null) {
    return (
      <div className="rounded-md border border-border border-l-2 border-l-amber-400 bg-card text-foreground px-3 py-1.5 flex items-center gap-2 text-[11px]">
        <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
        <span className="font-mono">{TOOL_LABEL[name] ?? name}</span>
        <span className="text-muted-foreground">실행 중…</span>
      </div>
    );
  }

  // 실패.
  if (typeof result === "object" && result !== null && "error" in result) {
    return (
      <div className="rounded-md border border-border border-l-2 border-l-rose-500 bg-card text-foreground px-3 py-1.5 flex items-start gap-2 text-[11px]">
        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0 text-rose-500" />
        <div className="min-w-0">
          <div className="font-mono text-rose-600">{TOOL_LABEL[name] ?? name} 실패</div>
          <div className="text-[10px] text-muted-foreground break-words">{String(result.error)}</div>
        </div>
      </div>
    );
  }

  // 도구별 카드.
  switch (name) {
    case "forecast_monthly_cost":
      return <ForecastCard result={result} />;
    case "get_cloud_cost_summary":
      return <SummaryCard result={result} />;
    case "list_recent_cost_alerts":
      return <AlertsCard result={result} />;
    case "get_last_fetch_status":
      return <FetchStatusCard result={result} />;
    default:
      return <RawCard name={name} args={args} result={result} />;
  }
}

/** 카드 미등록 도구용 — raw JSON 접힘. 새 도구가 등록만 되고 카드는 아직 없을 때 fallback. */
function RawCard({ name, args, result }: Props) {
  return (
    <details className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] open:bg-muted/60">
      <summary className="cursor-pointer flex items-center gap-1.5 list-none [&::-webkit-details-marker]:hidden">
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono">{name}</span>
        <span className="text-emerald-600">✓</span>
      </summary>
      <pre className="mt-1.5 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-snug text-muted-foreground bg-background/40 rounded p-2">
{JSON.stringify({ args, result }, null, 2)}
      </pre>
    </details>
  );
}
