"use client";

/**
 * 시스템 정보 — SUPER_ADMIN 전용 운영 대시보드.
 *
 * 호스트 (Docker Compose 단일 호스트) 의 CPU·메모리·디스크·DB 상태를 보여준다.
 * 5초 자동 새로고침, CPU/메모리 사용률은 클라이언트 ring buffer (60분) 로
 * 시계열 spline 차트 그림.
 *
 * 백엔드는 /api/v1/system/metrics, /api/v1/system/health 두 엔드포인트.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  Activity,
  Bell,
  Cpu,
  Database,
  HardDrive,
  HeartPulse,
  MemoryStick,
  RefreshCw,
  Server,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { api } from "@/lib/api";

const HighchartsReact = dynamic(
  () => import("highcharts-react-official").then((m) => m.default),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Metrics = {
  cpu: { percent: number; count: number; count_physical: number; load_avg: number[] };
  memory: {
    total: number;
    available: number;
    used: number;
    percent: number;
    swap: { total: number; used: number; percent: number };
  };
  disk: { path: string; total: number; used: number; free: number; percent: number }[];
  db_pool: {
    size: number;
    checked_in: number;
    checked_out: number;
    overflow: number;
    max_overflow: number;
  };
  db_conn: {
    total: number;
    active: number;
    idle: number;
    idle_in_tx: number;
    longest_running_s: number;
  };
  process: { pid: number; uptime_s: number; rss: number; threads: number; fd_count: number };
  app: {
    name: string;
    started_at: string;
    tenants_count: number;
    active_users_count: number;
  };
  ts: string;
};

type Health = {
  status: "ok" | "warn" | "down";
  components: {
    name: string;
    status: "ok" | "warn" | "down";
    latency_ms?: number;
    detail?: string;
    last_run_at?: string;
  }[];
  ts: string;
};

type NotifyTenants = {
  summary: {
    total: number;
    enabled: number;
    by_provider: Record<string, number>;
  };
  tenants: {
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    enabled: boolean;
    provider: string;
    configured: boolean;
    channels_count: number;
    user_emails_count: number;
  }[];
  ts: string;
};

const RING_MAX = 720; // 60분 @ 5초

type Sample = { t: number; cpu: number; mem: number };

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  const d = Math.floor(h / 24);
  return `${d}일 ${h % 24}시간`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)} %`;
}

function colorByPct(p: number): string {
  if (p >= 90) return "text-red-600";
  if (p >= 70) return "text-amber-600";
  return "text-emerald-600";
}

function bgByPct(p: number): string {
  if (p >= 90) return "bg-red-500";
  if (p >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function borderByPct(p: number): string {
  if (p >= 90) return "border-l-red-500";
  if (p >= 70) return "border-l-amber-500";
  return "border-l-emerald-500";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SystemInfoPage() {
  const [auto, setAuto] = useState(true);
  const ringRef = useRef<Sample[]>([]);
  const [, forceTick] = useState(0);

  const { data: metrics, refetch: refetchMetrics, isFetching: fM } = useQuery<Metrics>({
    queryKey: ["system-metrics"],
    queryFn: async () => (await api.get("/system/metrics")).data,
    refetchInterval: auto ? 5000 : false,
    staleTime: 0,
  });

  const { data: health, refetch: refetchHealth } = useQuery<Health>({
    queryKey: ["system-health"],
    queryFn: async () => (await api.get("/system/health")).data,
    refetchInterval: auto ? 10000 : false,
    staleTime: 0,
  });

  const { data: notifyTenants, refetch: refetchNotify } = useQuery<NotifyTenants>({
    queryKey: ["system-notify-tenants"],
    queryFn: async () => (await api.get("/system/notify-tenants")).data,
    refetchInterval: auto ? 30000 : false,
    staleTime: 0,
  });

  // metrics 수신 시 ring buffer 에 적재.
  useEffect(() => {
    if (!metrics) return;
    const t = new Date(metrics.ts).getTime();
    const buf = ringRef.current;
    buf.push({ t, cpu: metrics.cpu.percent, mem: metrics.memory.percent });
    if (buf.length > RING_MAX) buf.splice(0, buf.length - RING_MAX);
    forceTick((x) => x + 1);
  }, [metrics]);

  function refreshNow() {
    refetchMetrics();
    refetchHealth();
    refetchNotify();
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">시스템 정보</h1>
          {metrics && (
            <span className="text-xs text-muted-foreground ml-2">
              마지막 업데이트{" "}
              {new Date(metrics.ts).toLocaleTimeString("ko-KR", { hour12: false })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAuto((a) => !a)}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent"
            title={auto ? "자동 새로고침 끄기 (5초)" : "자동 새로고침 켜기 (5초)"}
          >
            {auto ? (
              <ToggleRight className="h-4 w-4 text-emerald-600" />
            ) : (
              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
            )}
            자동 5초
          </button>
          <button
            onClick={refreshNow}
            disabled={fM}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${fM ? "animate-spin" : ""}`} />
            지금 새로고침
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {!metrics ? (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        ) : (
          <>
            <StatStrip metrics={metrics} />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <CpuCard metrics={metrics} ring={ringRef.current} />
              <MemoryCard metrics={metrics} ring={ringRef.current} />
            </div>
            <DiskCard metrics={metrics} />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <DbPoolCard metrics={metrics} />
              <DbConnCard metrics={metrics} />
            </div>
            <HealthCard health={health} />
            <NotifyTenantsCard data={notifyTenants} />
            <AppInfoCard metrics={metrics} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

function StatStrip({ metrics }: { metrics: Metrics }) {
  const root = metrics.disk[0];
  const poolPct = metrics.db_pool.size
    ? (metrics.db_pool.checked_out / Math.max(1, metrics.db_pool.size)) * 100
    : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <BigStat
        icon={<Cpu className="h-5 w-5" />}
        label="CPU"
        valueText={fmtPct(metrics.cpu.percent)}
        sub={`${metrics.cpu.count} 코어 · load ${metrics.cpu.load_avg.join(" / ")}`}
        pct={metrics.cpu.percent}
      />
      <BigStat
        icon={<MemoryStick className="h-5 w-5" />}
        label="메모리"
        valueText={fmtPct(metrics.memory.percent)}
        sub={`${fmtBytes(metrics.memory.used)} / ${fmtBytes(metrics.memory.total)}`}
        pct={metrics.memory.percent}
      />
      <BigStat
        icon={<HardDrive className="h-5 w-5" />}
        label="디스크 (루트)"
        valueText={root ? fmtPct(root.percent) : "-"}
        sub={
          root ? `${fmtBytes(root.used)} / ${fmtBytes(root.total)}` : "측정 불가"
        }
        pct={root?.percent ?? 0}
      />
      <BigStat
        icon={<Database className="h-5 w-5" />}
        label="DB Pool"
        valueText={`${metrics.db_pool.checked_out} / ${metrics.db_pool.size}`}
        sub={`overflow ${metrics.db_pool.overflow} (max ${metrics.db_pool.max_overflow})`}
        pct={poolPct}
      />
    </div>
  );
}

function BigStat({
  icon,
  label,
  valueText,
  sub,
  pct,
}: {
  icon: React.ReactNode;
  label: string;
  valueText: string;
  sub: string;
  pct: number;
}) {
  return (
    <div className={`rounded-lg border-l-4 ${borderByPct(pct)} bg-card border p-4`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-semibold ${colorByPct(pct)}`}>
        {valueText}
      </div>
      <div className="mt-1 text-xs text-muted-foreground truncate" title={sub}>
        {sub}
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full transition-all ${bgByPct(pct)}`}
          style={{ width: `${Math.min(100, pct).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

function CpuCard({ metrics, ring }: { metrics: Metrics; ring: Sample[] }) {
  const [Highcharts, setHC] = useState<any>(null);
  useEffect(() => {
    import("@/lib/highcharts-init").then((m) => setHC(m.default));
  }, []);

  const options = useMemo(() => {
    const data = ring.map((s) => [s.t, s.cpu]);
    return {
      chart: { type: "spline", height: 220, backgroundColor: "transparent" },
      title: { text: "" },
      credits: { enabled: false },
      legend: { enabled: false },
      xAxis: {
        type: "datetime",
        labels: { style: { fontSize: "10px" } },
      },
      yAxis: {
        title: { text: "" },
        min: 0,
        max: 100,
        labels: { format: "{value}%", style: { fontSize: "10px" } },
        plotLines: [
          { value: 70, color: "#f59e0b", dashStyle: "Dash", width: 1 },
          { value: 90, color: "#ef4444", dashStyle: "Dash", width: 1 },
        ],
      },
      tooltip: {
        xDateFormat: "%H:%M:%S",
        valueSuffix: " %",
        valueDecimals: 1,
      },
      plotOptions: {
        spline: {
          marker: { enabled: false },
          lineWidth: 2,
        },
      },
      series: [
        {
          type: "spline",
          name: "CPU",
          data,
          color: "#3b82f6",
        },
      ],
    };
  }, [ring.length, ring[ring.length - 1]?.t]);

  return (
    <Section title="CPU" icon={<Cpu className="h-4 w-4" />}>
      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <KV k="사용률" v={fmtPct(metrics.cpu.percent)} hl={colorByPct(metrics.cpu.percent)} />
        <KV
          k="코어 (논리/물리)"
          v={`${metrics.cpu.count} / ${metrics.cpu.count_physical}`}
        />
        <KV
          k="load avg (1/5/15분)"
          v={metrics.cpu.load_avg.join(" / ")}
        />
      </div>
      {Highcharts ? (
        <HighchartsReact highcharts={Highcharts} options={options} />
      ) : (
        <div className="h-[220px] grid place-items-center text-xs text-muted-foreground">
          차트 로딩 중…
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function MemoryCard({ metrics, ring }: { metrics: Metrics; ring: Sample[] }) {
  const [Highcharts, setHC] = useState<any>(null);
  useEffect(() => {
    import("@/lib/highcharts-init").then((m) => setHC(m.default));
  }, []);

  const donut = useMemo(() => {
    return {
      chart: { type: "pie", height: 220, backgroundColor: "transparent" },
      title: { text: "" },
      credits: { enabled: false },
      legend: { enabled: false },
      tooltip: {
        pointFormatter: function (this: any) {
          return `${fmtBytes(this.y)} (${this.percentage.toFixed(1)} %)`;
        },
      },
      plotOptions: {
        pie: {
          innerSize: "65%",
          dataLabels: {
            enabled: true,
            format: "{point.name}: {point.percentage:.0f}%",
            style: { fontSize: "11px" },
          },
        },
      },
      series: [
        {
          type: "pie",
          name: "메모리",
          data: [
            { name: "사용", y: metrics.memory.used, color: "#3b82f6" },
            { name: "가용", y: metrics.memory.available, color: "#e2e8f0" },
          ],
        },
      ],
    };
  }, [metrics.memory.used, metrics.memory.available]);

  // ring buffer 의 mem% 추이 (작은 sparkline 자리에는 도넛이 있어 미사용 — ring 인자 향후용)
  void ring;

  return (
    <Section title="메모리" icon={<MemoryStick className="h-4 w-4" />}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          {Highcharts ? (
            <HighchartsReact highcharts={Highcharts} options={donut} />
          ) : (
            <div className="h-[220px] grid place-items-center text-xs text-muted-foreground">
              차트 로딩 중…
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 text-xs content-center">
          <KV k="총 메모리" v={fmtBytes(metrics.memory.total)} />
          <KV
            k="사용 / 가용"
            v={`${fmtBytes(metrics.memory.used)} / ${fmtBytes(metrics.memory.available)}`}
          />
          <KV
            k="사용률"
            v={fmtPct(metrics.memory.percent)}
            hl={colorByPct(metrics.memory.percent)}
          />
          <div className="h-px bg-border my-1" />
          <KV
            k="Swap 총량"
            v={
              metrics.memory.swap.total
                ? fmtBytes(metrics.memory.swap.total)
                : "없음"
            }
          />
          {metrics.memory.swap.total > 0 && (
            <KV
              k="Swap 사용"
              v={`${fmtBytes(metrics.memory.swap.used)} (${fmtPct(metrics.memory.swap.percent)})`}
              hl={colorByPct(metrics.memory.swap.percent)}
            />
          )}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

function DiskCard({ metrics }: { metrics: Metrics }) {
  return (
    <Section title="디스크" icon={<HardDrive className="h-4 w-4" />}>
      <div className="space-y-3">
        {metrics.disk.length === 0 && (
          <div className="text-xs text-muted-foreground">측정 불가</div>
        )}
        {metrics.disk.map((d) => (
          <div key={d.path}>
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="font-mono">{d.path}</span>
              <span className={`tabular-nums ${colorByPct(d.percent)}`}>
                {fmtBytes(d.used)} / {fmtBytes(d.total)} ({fmtPct(d.percent)})
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full ${bgByPct(d.percent)}`}
                style={{ width: `${Math.min(100, d.percent).toFixed(1)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// DB Pool / Conn
// ---------------------------------------------------------------------------

function DbPoolCard({ metrics }: { metrics: Metrics }) {
  const p = metrics.db_pool;
  const pct = p.size ? (p.checked_out / Math.max(1, p.size)) * 100 : 0;
  return (
    <Section
      title="DB Connection Pool (SQLAlchemy)"
      icon={<Database className="h-4 w-4" />}
    >
      <div className="grid grid-cols-2 gap-2 text-xs">
        <KV k="Pool size" v={String(p.size)} />
        <KV k="checked out" v={String(p.checked_out)} hl={colorByPct(pct)} />
        <KV k="checked in" v={String(p.checked_in)} />
        <KV k="overflow / max" v={`${p.overflow} / ${p.max_overflow}`} />
      </div>
      <div className="mt-3">
        <div className="text-xs text-muted-foreground mb-1">사용률 {fmtPct(pct)}</div>
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full ${bgByPct(pct)}`}
            style={{ width: `${Math.min(100, pct).toFixed(1)}%` }}
          />
        </div>
      </div>
    </Section>
  );
}

function DbConnCard({ metrics }: { metrics: Metrics }) {
  const c = metrics.db_conn;
  const idleTxWarn = c.idle_in_tx > 0;
  const longRunWarn = c.longest_running_s >= 60;
  return (
    <Section
      title="PostgreSQL pg_stat_activity"
      icon={<Database className="h-4 w-4" />}
    >
      <div className="grid grid-cols-2 gap-2 text-xs">
        <KV k="총 connection" v={String(c.total)} />
        <KV k="active" v={String(c.active)} />
        <KV k="idle" v={String(c.idle)} />
        <KV
          k="idle in transaction"
          v={String(c.idle_in_tx)}
          hl={idleTxWarn ? "text-amber-600" : undefined}
        />
        <KV
          k="가장 오래 실행 중인 쿼리"
          v={`${c.longest_running_s} 초`}
          hl={longRunWarn ? "text-amber-600" : undefined}
        />
      </div>
      {idleTxWarn && (
        <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          idle in transaction 이 있습니다 — 트랜잭션 누수 가능성을 점검하세요.
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function HealthCard({ health }: { health: Health | undefined }) {
  return (
    <Section title="헬스 체크" icon={<HeartPulse className="h-4 w-4" />}>
      {!health ? (
        <div className="text-xs text-muted-foreground">불러오는 중…</div>
      ) : (
        <ul className="divide-y">
          {health.components.map((c) => (
            <li
              key={c.name}
              className="py-2 flex items-center gap-3 text-sm"
            >
              <Dot status={c.status} />
              <span className="font-medium w-32 shrink-0">{c.name}</span>
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {c.detail || "-"}
              </span>
              {c.latency_ms !== undefined && (
                <span className="text-xs tabular-nums">{c.latency_ms} ms</span>
              )}
              {c.last_run_at && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {new Date(c.last_run_at).toLocaleString("ko-KR", {
                    hour12: false,
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Dot({ status }: { status: "ok" | "warn" | "down" }) {
  const c =
    status === "ok"
      ? "bg-emerald-500"
      : status === "warn"
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span
        className={`absolute inline-flex h-full w-full rounded-full opacity-50 ${c} animate-ping`}
      />
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${c}`} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Notify (tenant 별)
// ---------------------------------------------------------------------------

function NotifyTenantsCard({ data }: { data: NotifyTenants | undefined }) {
  return (
    <Section title="테넌트별 알람 설정" icon={<Bell className="h-4 w-4" />}>
      {!data ? (
        <div className="text-xs text-muted-foreground">불러오는 중…</div>
      ) : data.tenants.length === 0 ? (
        <div className="text-xs text-muted-foreground">활성 tenant 가 없습니다.</div>
      ) : (
        <>
          <div className="text-xs text-muted-foreground mb-2">
            전체 {data.summary.total}개 중 {data.summary.enabled}개 활성
            {Object.keys(data.summary.by_provider).length > 0 && (
              <>
                {" "}—{" "}
                {Object.entries(data.summary.by_provider)
                  .map(([p, n]) => `${p} ${n}`)
                  .join(", ")}
              </>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1.5 pr-3 font-medium">Tenant</th>
                  <th className="py-1.5 pr-3 font-medium">Slug</th>
                  <th className="py-1.5 pr-3 font-medium">활성</th>
                  <th className="py-1.5 pr-3 font-medium">Provider</th>
                  <th className="py-1.5 pr-3 font-medium">자격증명</th>
                  <th className="py-1.5 pr-3 font-medium tabular-nums text-right">
                    채널
                  </th>
                  <th className="py-1.5 pr-3 font-medium tabular-nums text-right">
                    DM 대상
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((t) => (
                  <tr key={t.tenant_id} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3">{t.tenant_name}</td>
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                      {t.tenant_slug}
                    </td>
                    <td className="py-1.5 pr-3">
                      {t.enabled ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-0.5">
                          활성
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5">
                          비활성
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{t.provider}</td>
                    <td className="py-1.5 pr-3">
                      {t.configured ? (
                        <span className="text-emerald-600">설정됨</span>
                      ) : (
                        <span className="text-amber-600">미설정</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-right">
                      {t.channels_count}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-right">
                      {t.user_emails_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// App / Process
// ---------------------------------------------------------------------------

function AppInfoCard({ metrics }: { metrics: Metrics }) {
  return (
    <Section title="앱 · 프로세스" icon={<Server className="h-4 w-4" />}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <KV k="앱" v={metrics.app.name} />
        <KV
          k="시작 시각"
          v={new Date(metrics.app.started_at).toLocaleString("ko-KR", {
            hour12: false,
          })}
        />
        <KV k="uptime" v={fmtUptime(metrics.process.uptime_s)} />
        <KV k="PID" v={String(metrics.process.pid)} />
        <KV k="RSS (프로세스 메모리)" v={fmtBytes(metrics.process.rss)} />
        <KV k="스레드" v={String(metrics.process.threads)} />
        <KV k="파일 디스크립터" v={String(metrics.process.fd_count)} />
        <KV
          k="활성 tenant / 사용자"
          v={`${metrics.app.tenants_count} / ${metrics.app.active_users_count}`}
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-1.5 mb-3 text-sm font-semibold">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v, hl }: { k: string; v: string; hl?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`tabular-nums font-medium ${hl ?? ""}`}>{v}</span>
    </div>
  );
}
