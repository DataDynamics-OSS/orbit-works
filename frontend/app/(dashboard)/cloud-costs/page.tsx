"use client";

/**
 * 클라우드 비용 — AWS / Azure / GCP 일별 service-level 추이.
 *
 * 데이터 소스: `/cloud-costs/summary` (일/provider/service 별 KRW 합계).
 * 차트: 최근 30일 일별 합계 (provider stacked bar). 우상단 "지금 수집" 버튼
 * 으로 수동 trigger. 하단에 service top 리스트 + 수집 이력 테이블.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Highcharts from "@/lib/highcharts-init";
import HighchartsReact from "highcharts-react-official";
import { Bell, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { CloudCostAlertsDialog } from "@/components/cloud-costs/AlertsDialog";

type SummaryRow = {
  usage_date: string;
  provider: "AWS" | "AZURE" | "GCP";
  service: string | null;
  amount_krw: string;       // numeric → string
};

type FetchRow = {
  id: string;
  provider: "AWS" | "AZURE" | "GCP";
  period_start: string | null;
  period_end: string | null;
  trigger_kind: string;
  status: "SUCCESS" | "FAILED" | "PARTIAL" | "SKIPPED";
  fetched_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

const PROVIDER_COLOR: Record<string, string> = {
  AWS: "#FF9900",
  AZURE: "#0078D4",
  GCP: "#4285F4",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtKRW(v: number): string {
  return v.toLocaleString("ko-KR", { maximumFractionDigits: 0 }) + "원";
}

export default function CloudCostsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [alertsOpen, setAlertsOpen] = useState(false);

  const { data: summary = [] } = useQuery<SummaryRow[]>({
    queryKey: ["cloud-cost-summary", from, to],
    queryFn: async () =>
      (await api.get("/cloud-costs/summary", { params: { from, to } })).data,
  });

  const { data: fetches = [] } = useQuery<FetchRow[]>({
    queryKey: ["cloud-cost-fetches"],
    queryFn: async () => (await api.get("/cloud-costs/fetches", { params: { limit: 50 } })).data,
  });

  // 일자 × provider 합계 — stacked bar 용. Highcharts 의 categories(x) +
  // series(provider 별 stacking 'normal') 형태로 가공.
  const chart = useMemo(() => {
    const byDate: Record<string, Record<string, number>> = {};
    for (const r of summary) {
      const amt = Number(r.amount_krw) || 0;
      byDate[r.usage_date] ??= {};
      byDate[r.usage_date][r.provider] = (byDate[r.usage_date][r.provider] || 0) + amt;
    }
    const dates = Object.keys(byDate).sort();
    const seriesFor = (p: "AWS" | "AZURE" | "GCP") =>
      dates.map((d) => byDate[d]?.[p] || 0);
    return {
      categories: dates,
      aws: seriesFor("AWS"),
      azure: seriesFor("AZURE"),
      gcp: seriesFor("GCP"),
    };
  }, [summary]);

  const chartOptions: Highcharts.Options = {
    chart: { type: "column", height: 360, backgroundColor: "transparent", style: { fontFamily: "inherit" } },
    title: { text: undefined },
    credits: { enabled: false },
    xAxis: {
      categories: chart.categories,
      labels: { style: { fontSize: "10px", color: "#64748b" } },
    },
    yAxis: {
      title: { text: undefined },
      labels: {
        style: { fontSize: "10px", color: "#64748b" },
        formatter() {
          const v = Number(this.value);
          if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
          if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(0)}만`;
          return v.toLocaleString();
        },
      },
      gridLineColor: "rgba(100,116,139,0.15)",
      stackLabels: { enabled: false },
    },
    legend: { itemStyle: { fontSize: "11px", color: "#334155" } },
    tooltip: {
      shared: true,
      useHTML: true,
      formatter() {
        const rows = (this.points ?? [])
          .map((p) => `<div><span style="color:${p.color}">●</span> ${p.series.name}: <b>${fmtKRW(Number(p.y))}</b></div>`)
          .join("");
        return `<div style="font-size:11px;"><div style="margin-bottom:2px;font-weight:600;">${this.x}</div>${rows}</div>`;
      },
    },
    plotOptions: { column: { stacking: "normal", borderWidth: 0 } },
    series: [
      { type: "column", name: "AWS", color: PROVIDER_COLOR.AWS, data: chart.aws },
      { type: "column", name: "Azure", color: PROVIDER_COLOR.AZURE, data: chart.azure },
      { type: "column", name: "GCP", color: PROVIDER_COLOR.GCP, data: chart.gcp },
    ],
  };

  // service top 합계 — 기간 내 누적 KRW. 글로벌 top 20 을 추린 뒤 provider 별로
  // 그룹핑. 각 provider 안에서는 금액 desc 정렬. provider 헤더에 그 그룹의 합계
  // 표시 + chevron 으로 접기/펼치기.
  const topByProvider = useMemo(() => {
    const m = new Map<string, { provider: string; service: string; amount: number }>();
    for (const r of summary) {
      const key = `${r.provider}::${r.service ?? ""}`;
      const prev = m.get(key);
      const amt = Number(r.amount_krw) || 0;
      if (prev) prev.amount += amt;
      else m.set(key, { provider: r.provider, service: r.service ?? "", amount: amt });
    }
    const top = Array.from(m.values())
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 20);

    const groups = new Map<string, { provider: string; total: number; items: typeof top }>();
    for (const it of top) {
      let g = groups.get(it.provider);
      if (!g) {
        g = { provider: it.provider, total: 0, items: [] };
        groups.set(it.provider, g);
      }
      g.items.push(it);
      g.total += it.amount;
    }
    // provider 그룹 자체는 합계 desc 정렬, 그룹 내부는 이미 desc.
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [summary]);

  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});

  const totalKRW =
    chart.aws.reduce((s, v) => s + v, 0) +
    chart.azure.reduce((s, v) => s + v, 0) +
    chart.gcp.reduce((s, v) => s + v, 0);

  const fetchM = useMutation({
    mutationFn: async () =>
      (await api.post("/cloud-costs/fetch", { since_days: 1 })).data,
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["cloud-cost-summary"] });
      qc.invalidateQueries({ queryKey: ["cloud-cost-fetches"] });
      await dialog.alert("수집 완료. 잠시 후 차트가 갱신됩니다.");
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "수집 실패", { title: "오류" });
    },
  });

  return (
    <>
      <DashboardHeader title="클라우드 비용" />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {/* 툴바 */}
        <div className="flex items-center gap-2 flex-wrap">
          <label className="inline-flex items-center gap-1 text-sm">
            <span className="text-muted-foreground">시작</span>
            <input
              type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="inline-flex items-center gap-1 text-sm">
            <span className="text-muted-foreground">종료</span>
            <input
              type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setAlertsOpen(true)}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            title="알람 규칙 + 발송 이력"
          >
            <Bell className="h-4 w-4" />
            알람
          </button>
          <button
            type="button"
            onClick={() => fetchM.mutate()}
            disabled={fetchM.isPending}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <RefreshCw className={"h-4 w-4 " + (fetchM.isPending ? "animate-spin" : "")} />
            {fetchM.isPending ? "수집 중…" : "지금 수집"}
          </button>
        </div>

        {/* 합계 카드 + 차트 */}
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-baseline gap-2 mb-3">
            <h3 className="text-sm font-semibold">기간 합계</h3>
            <span className="text-lg font-bold tabular-nums">{fmtKRW(totalKRW)}</span>
            <span className="text-xs text-muted-foreground">
              ({from} ~ {to})
            </span>
          </div>
          <HighchartsReact highcharts={Highcharts} options={chartOptions} />
        </section>

        {/* Service top — provider 별 tree */}
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-2">서비스 Top 20 (기간 누적)</h3>
          {topByProvider.length === 0 ? (
            <p className="text-xs text-muted-foreground">데이터가 없습니다.</p>
          ) : (
            <div className="space-y-1">
              {topByProvider.map((g) => {
                const collapsed = collapsedProviders[g.provider];
                return (
                  <div key={g.provider} className="border border-border rounded-md overflow-hidden">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedProviders((p) => ({ ...p, [g.provider]: !collapsed }))
                      }
                      className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/60 text-sm font-medium"
                    >
                      <span className="text-muted-foreground text-xs">
                        {collapsed ? "▶" : "▼"}
                      </span>
                      <span
                        className="inline-block rounded px-1.5 py-0.5 text-[11px] text-white"
                        style={{ backgroundColor: PROVIDER_COLOR[g.provider] }}
                      >
                        {g.provider}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({g.items.length} services)
                      </span>
                      <span className="ml-auto tabular-nums font-semibold">
                        {fmtKRW(g.total)}
                      </span>
                    </button>
                    {!collapsed && (
                      <table className="w-full text-sm">
                        <tbody>
                          {g.items.map((r, i) => (
                            <tr key={i} className="border-t border-border/50">
                              <td className="py-1 pl-9 pr-2 text-muted-foreground text-xs w-6">
                                {i + 1}
                              </td>
                              <td className="py-1 px-2">{r.service || "—"}</td>
                              <td className="py-1 px-3 text-right tabular-nums">
                                {fmtKRW(r.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 수집 이력 */}
        <section className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-2">수집 이력 ({fetches.length}건)</h3>
          {fetches.length === 0 ? (
            <p className="text-xs text-muted-foreground">아직 수집 이력이 없습니다.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-1">시작</th>
                  <th className="text-left py-1">Provider</th>
                  <th className="text-left py-1">기간</th>
                  <th className="text-left py-1">상태</th>
                  <th className="text-right py-1">fetched</th>
                  <th className="text-right py-1">created</th>
                  <th className="text-right py-1">updated</th>
                  <th className="text-left py-1">에러</th>
                </tr>
              </thead>
              <tbody>
                {fetches.map((f) => (
                  <tr key={f.id} className="border-t border-border/50">
                    <td className="py-1 tabular-nums">{f.started_at.replace("T", " ").slice(0, 19)}</td>
                    <td className="py-1">
                      <span
                        className="inline-block rounded px-1.5 py-0.5 text-[10px] text-white"
                        style={{ backgroundColor: PROVIDER_COLOR[f.provider] }}
                      >
                        {f.provider}
                      </span>
                    </td>
                    <td className="py-1">{f.period_start === f.period_end ? f.period_start : `${f.period_start} ~ ${f.period_end}`}</td>
                    <td className="py-1">
                      <span
                        className={
                          "inline-block rounded px-1.5 py-0.5 text-[10px] " +
                          (f.status === "SUCCESS"
                            ? "bg-emerald-100 text-emerald-700"
                            : f.status === "FAILED"
                              ? "bg-red-100 text-red-700"
                              : f.status === "SKIPPED"
                                ? "bg-gray-200 text-gray-700"
                                : "bg-amber-100 text-amber-700")
                        }
                      >
                        {f.status}
                      </span>
                    </td>
                    <td className="py-1 text-right tabular-nums">{f.fetched_count}</td>
                    <td className="py-1 text-right tabular-nums">{f.created_count}</td>
                    <td className="py-1 text-right tabular-nums">{f.updated_count}</td>
                    <td className="py-1 text-muted-foreground truncate max-w-[260px]">
                      {f.error_message ?? ""}
                      {f.error_message && <Tooltip label={f.error_message} side="top" inline />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <CloudCostAlertsDialog
        open={alertsOpen}
        onClose={() => setAlertsOpen(false)}
      />
    </>
  );
}
