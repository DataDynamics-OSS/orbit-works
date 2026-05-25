"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  BarChart3,
  Inbox,
  Mail,
  MailWarning,
  MousePointerClick,
  Send,
  Target,
  TrendingUp,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";

type Summary = {
  total_campaigns: number;
  active_campaigns: number;
  completed_campaigns: number;
  email_campaigns: number;
  google_ads_campaigns: number;
  emails_sent_30d: number;
  emails_opened_30d: number;
  emails_clicked_30d: number;
  open_rate_30d: number;
  click_rate_30d: number;
  unsubscribe_count: number;
  ga_impressions_30d: number;
  ga_clicks_30d: number;
  ga_cost_30d_micros: number;
  ga_conversions_30d: string;
};

function formatNum(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  return v.toLocaleString("ko-KR");
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function microsToKrw(micros: number | string): string {
  const v = typeof micros === "string" ? Number(micros) : micros;
  return Math.round(v / 1_000_000).toLocaleString("ko-KR");
}

function StatCard({
  label,
  value,
  hint,
  icon,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  href?: string;
}) {
  const body = (
    <div className="rounded-lg border border-border bg-card p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-muted-foreground">{icon}</div>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default function MarketingDashboardPage() {
  const { data, isLoading } = useQuery<Summary>({
    queryKey: ["marketing", "dashboard"],
    queryFn: async () => (await api.get("/marketing/dashboard")).data,
  });

  return (
    <>
      <DashboardHeader title="마케팅 대시보드" />
      <div className="p-4 space-y-6">
        {isLoading || !data ? (
          <div className="text-sm text-muted-foreground">불러오는 중…</div>
        ) : (
          <>
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">
                캠페인 현황
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard
                  label="전체 캠페인"
                  value={formatNum(data.total_campaigns)}
                  icon={<Target className="h-4 w-4" />}
                  href="/marketing/campaigns"
                />
                <StatCard
                  label="진행 중"
                  value={formatNum(data.active_campaigns)}
                  icon={<TrendingUp className="h-4 w-4" />}
                  href="/marketing/campaigns?status=RUNNING"
                />
                <StatCard
                  label="이메일 캠페인"
                  value={formatNum(data.email_campaigns)}
                  icon={<Mail className="h-4 w-4" />}
                  href="/marketing/campaigns?channel=EMAIL"
                />
                <StatCard
                  label="Google Ads"
                  value={formatNum(data.google_ads_campaigns)}
                  icon={<BarChart3 className="h-4 w-4" />}
                  href="/marketing/campaigns?channel=GOOGLE_ADS"
                />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">
                이메일 KPI · 최근 30일
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <StatCard
                  label="발송 수"
                  value={formatNum(data.emails_sent_30d)}
                  icon={<Send className="h-4 w-4" />}
                />
                <StatCard
                  label="오픈"
                  value={formatNum(data.emails_opened_30d)}
                  hint={`오픈율 ${formatPct(data.open_rate_30d)}`}
                  icon={<Inbox className="h-4 w-4" />}
                />
                <StatCard
                  label="클릭"
                  value={formatNum(data.emails_clicked_30d)}
                  hint={`클릭률 ${formatPct(data.click_rate_30d)}`}
                  icon={<MousePointerClick className="h-4 w-4" />}
                />
                <StatCard
                  label="수신거부 (전체)"
                  value={formatNum(data.unsubscribe_count)}
                  icon={<MailWarning className="h-4 w-4" />}
                  href="/marketing/emails?tab=unsubscribes"
                />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">
                Google Ads · 최근 30일
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                <StatCard
                  label="노출"
                  value={formatNum(data.ga_impressions_30d)}
                  icon={<BarChart3 className="h-4 w-4" />}
                />
                <StatCard
                  label="클릭"
                  value={formatNum(data.ga_clicks_30d)}
                  icon={<MousePointerClick className="h-4 w-4" />}
                />
                <StatCard
                  label="비용 (KRW)"
                  value={microsToKrw(data.ga_cost_30d_micros)}
                  icon={<TrendingUp className="h-4 w-4" />}
                />
                <StatCard
                  label="전환"
                  value={formatNum(data.ga_conversions_30d)}
                  icon={<Target className="h-4 w-4" />}
                />
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
