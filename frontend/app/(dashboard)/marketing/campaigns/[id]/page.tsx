"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  Mail,
  RefreshCw,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/ToastProvider";

type Channel = "EMAIL" | "GOOGLE_ADS";
type Status = "PLANNED" | "RUNNING" | "PAUSED" | "COMPLETED" | "ARCHIVED";

type Campaign = {
  id: string;
  name: string;
  channel: Channel;
  status: Status;
  objective: string;
  start_date: string | null;
  end_date: string | null;
  budget: string;
  actual_cost: string;
  currency: string;
  owner_id: string | null;
  owner_name: string | null;
  segment_id: string | null;
  segment_name: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  notes: string | null;
  // EMAIL
  email_template_id: string | null;
  email_template_name: string | null;
  from_address: string | null;
  from_name: string | null;
  reply_to: string | null;
  scheduled_at: string | null;
  send_started_at: string | null;
  send_finished_at: string | null;
  // GA
  ga_customer_id: string | null;
  ga_external_id: string | null;
  ga_campaign_type: string | null;
  ga_daily_budget: string | null;
  ga_last_synced_at: string | null;
  // KPI
  sent_count: number | null;
  opened_count: number | null;
  clicked_count: number | null;
  bounced_count: number | null;
  ga_impressions: number | null;
  ga_clicks: number | null;
  ga_cost: string | null;
  ga_conversions: string | null;
};

type Segment = { id: string; name: string; recipient_count: number | null };
type Template = { id: string; name: string };
type EmailSend = {
  id: string;
  to_address: string;
  status: string;
  sent_at: string | null;
  error_message: string | null;
  open_count: number;
  click_count: number;
  contact_name: string | null;
  customer_name: string | null;
};
type GaMetric = {
  metric_date: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: string;
};

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const { data: campaign, isLoading } = useQuery<Campaign>({
    queryKey: ["marketing", "campaign", id],
    queryFn: async () => (await api.get(`/marketing/campaigns/${id}`)).data,
  });

  const { data: segments = [] } = useQuery<Segment[]>({
    queryKey: ["marketing", "segments"],
    queryFn: async () => (await api.get(`/marketing/segments`)).data,
  });

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ["marketing", "email-templates"],
    queryFn: async () => (await api.get(`/marketing/email-templates`)).data,
  });

  const toast = useToast();

  const update = useMutation({
    mutationFn: async (patch: Partial<Campaign>) =>
      (await api.patch(`/marketing/campaigns/${id}`, patch)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "campaign", id] });
      toast.success("저장되었습니다.");
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      toast.error(err.response?.data?.detail || "저장에 실패했습니다.");
    },
  });

  const del = useMutation({
    mutationFn: async () => api.delete(`/marketing/campaigns/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
      router.push("/marketing/campaigns");
    },
  });

  if (isLoading || !campaign) {
    return (
      <>
        <DashboardHeader title="캠페인" />
        <div className="p-4 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              href="/marketing/campaigns"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 inline" />
            </Link>
            {campaign.name}
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {campaign.channel === "EMAIL" ? (
                <Mail className="h-3 w-3" />
              ) : (
                <BarChart3 className="h-3 w-3" />
              )}
              {campaign.channel === "EMAIL" ? "이메일" : "Google Ads"}
            </span>
          </span>
        }
        actions={
          <button
            type="button"
            onClick={() => {
              if (confirm(`"${campaign.name}" 캠페인을 삭제하시겠어요?`)) del.mutate();
            }}
            className="text-sm text-red-600 hover:bg-red-50 px-2 py-1 rounded-md inline-flex items-center gap-1"
          >
            <Trash2 className="h-3.5 w-3.5" /> 삭제
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-6 max-w-5xl">
          <SettingsCard
            campaign={campaign}
            segments={segments}
            templates={templates}
            onSave={(patch) => update.mutate(patch)}
          />

          {campaign.channel === "EMAIL" && <EmailSection campaign={campaign} />}
          {campaign.channel === "GOOGLE_ADS" && <GoogleAdsSection campaign={campaign} />}
        </div>
      </div>
    </>
  );
}

function SettingsCard({
  campaign,
  segments,
  templates,
  onSave,
}: {
  campaign: Campaign;
  segments: Segment[];
  templates: Template[];
  onSave: (patch: Partial<Campaign>) => void;
}) {
  const [status, setStatus] = useState(campaign.status);
  const [segmentId, setSegmentId] = useState(campaign.segment_id || "");
  const [templateId, setTemplateId] = useState(campaign.email_template_id || "");
  const [budget, setBudget] = useState(campaign.budget);
  const [notes, setNotes] = useState(campaign.notes || "");
  const [utmCampaign, setUtmCampaign] = useState(campaign.utm_campaign || "");

  // GA fields
  const [gaCustomerId, setGaCustomerId] = useState(campaign.ga_customer_id || "");
  const [gaExternalId, setGaExternalId] = useState(campaign.ga_external_id || "");
  const [gaCampaignType, setGaCampaignType] = useState(campaign.ga_campaign_type || "");
  const [gaDailyBudget, setGaDailyBudget] = useState(campaign.ga_daily_budget || "");

  function save() {
    const patch: Partial<Campaign> = {
      status,
      segment_id: segmentId || null,
      budget,
      notes,
      utm_campaign: utmCampaign || null,
    };
    if (campaign.channel === "EMAIL") {
      patch.email_template_id = templateId || null;
    } else {
      patch.ga_customer_id = gaCustomerId || null;
      patch.ga_external_id = gaExternalId || null;
      patch.ga_campaign_type = (gaCampaignType || null) as Campaign["ga_campaign_type"];
      patch.ga_daily_budget = gaDailyBudget || null;
    }
    onSave(patch);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">설정</h2>
        <button
          type="button"
          onClick={save}
          className="text-sm inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-1.5 hover:bg-primary/90"
        >
          <Save className="h-3.5 w-3.5" /> 저장
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <Field label="상태">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          >
            <option value="PLANNED">계획</option>
            <option value="RUNNING">진행 중</option>
            <option value="PAUSED">일시정지</option>
            <option value="COMPLETED">완료</option>
            <option value="ARCHIVED">보관</option>
          </select>
        </Field>
        <Field label="예산 (KRW)">
          <input
            type="number"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          />
        </Field>
        <Field label="세그먼트 (수신자)">
          <select
            value={segmentId}
            onChange={(e) => setSegmentId(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          >
            <option value="">— 선택 —</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.recipient_count ?? 0}명)
              </option>
            ))}
          </select>
        </Field>
        <Field label="UTM 캠페인 키">
          <input
            type="text"
            value={utmCampaign}
            onChange={(e) => setUtmCampaign(e.target.value)}
            placeholder="2026q2_renewal"
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          />
        </Field>

        {campaign.channel === "EMAIL" && (
          <Field label="이메일 템플릿">
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-background px-2"
            >
              <option value="">— 선택 —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {campaign.channel === "GOOGLE_ADS" && (
          <>
            <Field label="Google Ads 계정 ID">
              <input
                type="text"
                value={gaCustomerId}
                onChange={(e) => setGaCustomerId(e.target.value)}
                placeholder="123-456-7890"
                className="w-full h-9 rounded-md border border-border bg-background px-2"
              />
            </Field>
            <Field label="외부 캠페인 ID">
              <input
                type="text"
                value={gaExternalId}
                onChange={(e) => setGaExternalId(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-background px-2"
              />
            </Field>
            <Field label="캠페인 유형">
              <select
                value={gaCampaignType}
                onChange={(e) => setGaCampaignType(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-background px-2"
              >
                <option value="">— 선택 —</option>
                <option value="SEARCH">검색</option>
                <option value="DISPLAY">디스플레이</option>
                <option value="VIDEO">동영상</option>
                <option value="PMAX">실적 최대화</option>
              </select>
            </Field>
            <Field label="일일 예산 (KRW)">
              <input
                type="number"
                value={gaDailyBudget}
                onChange={(e) => setGaDailyBudget(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-background px-2"
              />
            </Field>
          </>
        )}

        <Field label="메모" className="md:col-span-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5"
          />
        </Field>
      </div>
    </section>
  );
}

function EmailSection({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data: sends = [] } = useQuery<EmailSend[]>({
    queryKey: ["marketing", "campaign", campaign.id, "sends"],
    queryFn: async () =>
      (await api.get(`/marketing/campaigns/${campaign.id}/sends`)).data,
  });

  const send = useMutation({
    mutationFn: async () => (await api.post(`/marketing/campaigns/${campaign.id}/send`)).data,
    onSuccess: (counts: { sent: number; skipped: number; failed: number; total: number }) => {
      qc.invalidateQueries({ queryKey: ["marketing", "campaign", campaign.id] });
      qc.invalidateQueries({ queryKey: ["marketing", "campaign", campaign.id, "sends"] });
      alert(
        `발송 완료\n총 ${counts.total}건\n발송 성공 ${counts.sent}\n수신거부 제외 ${counts.skipped}\n실패 ${counts.failed}`,
      );
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      alert(err.response?.data?.detail || "발송 실패");
    },
  });

  const canSend = !!campaign.segment_id && !!campaign.email_template_id;

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">이메일 발송</h2>
        <button
          type="button"
          disabled={!canSend || send.isPending || campaign.status === "RUNNING"}
          onClick={() => setConfirmOpen(true)}
          className="text-sm inline-flex items-center gap-1 rounded-md bg-emerald-600 text-white px-3 py-1.5 hover:bg-emerald-700 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" /> 지금 발송
        </button>
      </div>

      {!canSend && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>발송 전에 세그먼트와 이메일 템플릿을 모두 지정해야 합니다.</span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <KpiTile label="발송" value={campaign.sent_count ?? 0} />
        <KpiTile label="오픈" value={campaign.opened_count ?? 0} color="text-emerald-600" />
        <KpiTile label="클릭" value={campaign.clicked_count ?? 0} color="text-sky-600" />
        <KpiTile label="실패" value={campaign.bounced_count ?? 0} color="text-red-600" />
      </div>

      {sends.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">수신자</th>
                <th className="text-left px-2 py-1.5 font-medium">고객사</th>
                <th className="text-left px-2 py-1.5 font-medium">이메일</th>
                <th className="text-left px-2 py-1.5 font-medium">상태</th>
                <th className="text-right px-2 py-1.5 font-medium">오픈</th>
                <th className="text-right px-2 py-1.5 font-medium">클릭</th>
                <th className="text-left px-2 py-1.5 font-medium">발송시각</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-2 py-1.5">{s.contact_name || "-"}</td>
                  <td className="px-2 py-1.5">{s.customer_name || "-"}</td>
                  <td className="px-2 py-1.5 font-mono">{s.to_address}</td>
                  <td className="px-2 py-1.5">
                    <SendStatusBadge status={s.status} />
                  </td>
                  <td className="px-2 py-1.5 text-right">{s.open_count}</td>
                  <td className="px-2 py-1.5 text-right">{s.click_count}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {s.sent_at ? new Date(s.sent_at).toLocaleString("ko-KR") : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="이메일 발송 확인"
        footer={
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                send.mutate();
              }}
              className="text-sm px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700"
            >
              발송
            </button>
          </div>
        }
      >
        <p className="text-sm">
          세그먼트 "<b>{campaign.segment_name}</b>" 의 모든 수신자에게 즉시 발송합니다.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          수신거부 등록된 주소는 자동으로 제외됩니다. 발송 후에는 취소할 수 없습니다.
        </p>
      </Dialog>
    </section>
  );
}

function GoogleAdsSection({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [metricDate, setMetricDate] = useState(new Date().toISOString().slice(0, 10));
  const [impressions, setImpressions] = useState("0");
  const [clicks, setClicks] = useState("0");
  const [costKrw, setCostKrw] = useState("0");
  const [conversions, setConversions] = useState("0");

  const { data: metrics = [] } = useQuery<GaMetric[]>({
    queryKey: ["marketing", "campaign", campaign.id, "ga-metrics"],
    queryFn: async () =>
      (await api.get(`/marketing/google-ads/campaigns/${campaign.id}/metrics`)).data,
  });

  const upsert = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/marketing/google-ads/campaigns/${campaign.id}/metrics`, {
          metric_date: metricDate,
          impressions: Number(impressions) || 0,
          clicks: Number(clicks) || 0,
          cost_micros: Math.round((Number(costKrw) || 0) * 1_000_000),
          conversions: Number(conversions) || 0,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["marketing", "campaign", campaign.id, "ga-metrics"],
      });
      qc.invalidateQueries({ queryKey: ["marketing", "campaign", campaign.id] });
      toast.success("저장되었습니다.");
    },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      toast.error(err.response?.data?.detail || "저장에 실패했습니다.");
    },
  });

  const sync = useMutation({
    mutationFn: async () =>
      (await api.post(`/marketing/google-ads/campaigns/${campaign.id}/sync`, {})).data,
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      toast.error(err.response?.data?.detail || "동기화에 실패했습니다."),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["marketing", "campaign", campaign.id, "ga-metrics"],
      });
      toast.success("동기화되었습니다.");
    },
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Google Ads KPI</h2>
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="text-sm inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />
          API 동기화
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <KpiTile label="노출" value={(campaign.ga_impressions ?? 0).toLocaleString("ko-KR")} />
        <KpiTile
          label="클릭"
          value={(campaign.ga_clicks ?? 0).toLocaleString("ko-KR")}
          color="text-sky-600"
        />
        <KpiTile
          label="비용 (KRW)"
          value={Number(campaign.ga_cost ?? 0).toLocaleString("ko-KR")}
        />
        <KpiTile
          label="전환"
          value={Number(campaign.ga_conversions ?? 0).toLocaleString("ko-KR")}
          color="text-emerald-600"
        />
      </div>

      <div className="rounded-md border border-border p-3 space-y-2">
        <div className="text-xs font-semibold text-muted-foreground">일별 KPI 수동 입력</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
          <Field label="날짜">
            <input
              type="date"
              value={metricDate}
              onChange={(e) => setMetricDate(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-background px-2"
            />
          </Field>
          <Field label="노출">
            <input
              type="number"
              value={impressions}
              onChange={(e) => setImpressions(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-background px-2"
            />
          </Field>
          <Field label="클릭">
            <input
              type="number"
              value={clicks}
              onChange={(e) => setClicks(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-background px-2"
            />
          </Field>
          <Field label="비용 (KRW)">
            <input
              type="number"
              value={costKrw}
              onChange={(e) => setCostKrw(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-background px-2"
            />
          </Field>
          <Field label="전환">
            <input
              type="number"
              step="0.01"
              value={conversions}
              onChange={(e) => setConversions(e.target.value)}
              className="w-full h-8 rounded-md border border-border bg-background px-2"
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => upsert.mutate()}
            disabled={upsert.isPending}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            저장
          </button>
        </div>
      </div>

      {metrics.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">날짜</th>
                <th className="text-right px-2 py-1.5 font-medium">노출</th>
                <th className="text-right px-2 py-1.5 font-medium">클릭</th>
                <th className="text-right px-2 py-1.5 font-medium">비용 (KRW)</th>
                <th className="text-right px-2 py-1.5 font-medium">전환</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.metric_date} className="border-t border-border">
                  <td className="px-2 py-1.5">{m.metric_date}</td>
                  <td className="px-2 py-1.5 text-right">
                    {m.impressions.toLocaleString("ko-KR")}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {m.clicks.toLocaleString("ko-KR")}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {Math.round(m.cost_micros / 1_000_000).toLocaleString("ko-KR")}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {Number(m.conversions).toLocaleString("ko-KR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function KpiTile({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-md border border-border p-2 text-center">
      <div className="text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${color || ""}`}>{value}</div>
    </div>
  );
}

function SendStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    QUEUED: "bg-slate-100 text-slate-700",
    SENT: "bg-emerald-100 text-emerald-700",
    BOUNCED: "bg-red-100 text-red-700",
    FAILED: "bg-red-100 text-red-700",
    SKIPPED_UNSUBSCRIBED: "bg-amber-100 text-amber-700",
  };
  const labels: Record<string, string> = {
    QUEUED: "대기",
    SENT: "발송됨",
    BOUNCED: "반송",
    FAILED: "실패",
    SKIPPED_UNSUBSCRIBED: "수신거부 제외",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] ${map[status] || ""}`}>
      {labels[status] || status}
    </span>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className || ""}`}>
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}
