"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Info, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";

type Campaign = {
  id: string;
  name: string;
  status: string;
  ga_customer_id: string | null;
  ga_external_id: string | null;
  ga_campaign_type: string | null;
  ga_daily_budget: string | null;
  ga_last_synced_at: string | null;
  ga_impressions: number | null;
  ga_clicks: number | null;
  ga_cost: string | null;
  ga_conversions: string | null;
};

export default function GoogleAdsPage() {
  const qc = useQueryClient();

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["marketing", "campaigns", { channel: "GOOGLE_ADS" }],
    queryFn: async () =>
      (await api.get(`/marketing/campaigns?channel=GOOGLE_ADS`)).data,
  });

  const sync = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/marketing/google-ads/campaigns/${id}/sync`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      alert(err.response?.data?.detail || "동기화 실패"),
  });

  return (
    <>
      <DashboardHeader title="Google Ads" />
      <div className="p-4 space-y-4">
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm flex items-start gap-2 text-sky-900">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Google Ads 연동 안내</div>
            <div className="text-xs mt-1">
              1차에서는 수동 입력만 지원합니다. OAuth 인증 + 자동 동기화는 설정 &gt;
              마케팅에서 활성화 후 사용 가능. <b>지금은 동기화 버튼이 503 으로 응답</b>합니다.
              일별 KPI 는 각 캠페인 상세 페이지에서 수동 입력하세요.
            </div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">캠페인</th>
                <th className="text-left px-3 py-2 font-medium">유형</th>
                <th className="text-left px-3 py-2 font-medium">계정 ID</th>
                <th className="text-left px-3 py-2 font-medium">외부 ID</th>
                <th className="text-right px-3 py-2 font-medium">노출</th>
                <th className="text-right px-3 py-2 font-medium">클릭</th>
                <th className="text-right px-3 py-2 font-medium">비용 (KRW)</th>
                <th className="text-right px-3 py-2 font-medium">전환</th>
                <th className="text-left px-3 py-2 font-medium">마지막 sync</th>
                <th className="text-right px-3 py-2 font-medium w-24">동작</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center text-muted-foreground p-8"
                  >
                    Google Ads 채널 캠페인이 없습니다.{" "}
                    <Link
                      href="/marketing/campaigns"
                      className="text-primary hover:underline"
                    >
                      캠페인 만들기
                    </Link>
                  </td>
                </tr>
              )}
              {campaigns.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-border hover:bg-muted/30"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/marketing/campaigns/${c.id}`}
                      className="text-primary hover:underline font-medium inline-flex items-center gap-1"
                    >
                      <BarChart3 className="h-3.5 w-3.5" />
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{c.ga_campaign_type || "-"}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {c.ga_customer_id || "-"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {c.ga_external_id || "-"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(c.ga_impressions ?? 0).toLocaleString("ko-KR")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(c.ga_clicks ?? 0).toLocaleString("ko-KR")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {Number(c.ga_cost ?? 0).toLocaleString("ko-KR")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {Number(c.ga_conversions ?? 0).toLocaleString("ko-KR")}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {c.ga_last_synced_at
                      ? new Date(c.ga_last_synced_at).toLocaleString("ko-KR")
                      : "-"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => sync.mutate(c.id)}
                      disabled={sync.isPending}
                      className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border hover:bg-muted disabled:opacity-50"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Sync
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
