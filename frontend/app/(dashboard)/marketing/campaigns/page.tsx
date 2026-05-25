"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Plus, BarChart3 } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";

type Channel = "EMAIL" | "GOOGLE_ADS";
type Status = "PLANNED" | "RUNNING" | "PAUSED" | "COMPLETED" | "ARCHIVED";

const CHANNEL_LABEL: Record<Channel, string> = {
  EMAIL: "이메일",
  GOOGLE_ADS: "Google Ads",
};
const STATUS_LABEL: Record<Status, string> = {
  PLANNED: "계획",
  RUNNING: "진행 중",
  PAUSED: "일시정지",
  COMPLETED: "완료",
  ARCHIVED: "보관",
};
const STATUS_BADGE: Record<Status, string> = {
  PLANNED: "bg-slate-100 text-slate-700 border-slate-200",
  RUNNING: "bg-emerald-100 text-emerald-700 border-emerald-200",
  PAUSED: "bg-amber-100 text-amber-700 border-amber-200",
  COMPLETED: "bg-sky-100 text-sky-700 border-sky-200",
  ARCHIVED: "bg-gray-100 text-gray-500 border-gray-200",
};

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
  owner_name: string | null;
  segment_name: string | null;
  email_template_name: string | null;
  sent_count: number | null;
  opened_count: number | null;
  clicked_count: number | null;
  bounced_count: number | null;
  ga_impressions: number | null;
  ga_clicks: number | null;
  ga_cost: string | null;
  ga_conversions: string | null;
  created_at: string;
};

const OBJECTIVES = [
  { value: "CROSS_SELL", label: "교차판매" },
  { value: "UPSELL", label: "업셀" },
  { value: "NURTURE", label: "고객유지" },
  { value: "RETENTION", label: "리텐션" },
  { value: "WIN_BACK", label: "재유치" },
  { value: "EVENT_INVITE", label: "이벤트 안내" },
  { value: "OTHER", label: "기타" },
];

export default function CampaignsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const channelFilter = params.get("channel") || "";
  const statusFilter = params.get("status") || "";
  const qc = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["marketing", "campaigns", { channel: channelFilter, status: statusFilter }],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (channelFilter) qs.set("channel", channelFilter);
      if (statusFilter) qs.set("status_", statusFilter);
      return (await api.get(`/marketing/campaigns?${qs.toString()}`)).data;
    },
  });

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/marketing/campaigns?${next.toString()}`);
  }

  return (
    <>
      <DashboardHeader
        title="마케팅 캠페인"
        actions={
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> 새 캠페인
          </button>
        }
      />
      <div className="p-4 space-y-4">
        <div className="flex gap-2 items-center text-sm">
          <span className="text-muted-foreground">필터:</span>
          <select
            value={channelFilter}
            onChange={(e) => setFilter("channel", e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">전체 채널</option>
            <option value="EMAIL">이메일</option>
            <option value="GOOGLE_ADS">Google Ads</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setFilter("status", e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">전체 상태</option>
            {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">이름</th>
                <th className="text-left px-3 py-2 font-medium">채널</th>
                <th className="text-left px-3 py-2 font-medium">상태</th>
                <th className="text-left px-3 py-2 font-medium">담당자</th>
                <th className="text-left px-3 py-2 font-medium">세그먼트</th>
                <th className="text-right px-3 py-2 font-medium">예산</th>
                <th className="text-right px-3 py-2 font-medium">KPI</th>
                <th className="text-left px-3 py-2 font-medium">기간</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted-foreground p-8">
                    등록된 캠페인이 없습니다.
                  </td>
                </tr>
              )}
              {campaigns.map((c) => (
                <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link
                      href={`/marketing/campaigns/${c.id}`}
                      className="text-primary hover:underline font-medium"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {OBJECTIVES.find((o) => o.value === c.objective)?.label}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 text-xs">
                      {c.channel === "EMAIL" ? (
                        <Mail className="h-3 w-3" />
                      ) : (
                        <BarChart3 className="h-3 w-3" />
                      )}
                      {CHANNEL_LABEL[c.channel]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${STATUS_BADGE[c.status]}`}
                    >
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2">{c.owner_name || "-"}</td>
                  <td className="px-3 py-2">{c.segment_name || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {Number(c.budget).toLocaleString("ko-KR")}원
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {c.channel === "EMAIL" ? (
                      <>
                        발송 {c.sent_count ?? 0} ·{" "}
                        <span className="text-emerald-600">오픈 {c.opened_count ?? 0}</span> ·{" "}
                        <span className="text-sky-600">클릭 {c.clicked_count ?? 0}</span>
                      </>
                    ) : (
                      <>
                        노출 {(c.ga_impressions ?? 0).toLocaleString("ko-KR")} ·{" "}
                        <span className="text-sky-600">
                          클릭 {(c.ga_clicks ?? 0).toLocaleString("ko-KR")}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {c.start_date || "-"}
                    {c.end_date && ` ~ ${c.end_date}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <NewCampaignDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(id) => {
          qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
          setDialogOpen(false);
          router.push(`/marketing/campaigns/${id}`);
        }}
      />
    </>
  );
}

function NewCampaignDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<Channel>("EMAIL");
  const [objective, setObjective] = useState("NURTURE");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budget, setBudget] = useState("0");
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        channel,
        objective,
        status: "PLANNED" as const,
        start_date: startDate || null,
        end_date: endDate || null,
        budget: Number(budget) || 0,
      };
      return (await api.post("/marketing/campaigns", payload)).data;
    },
    onSuccess: (data: { id: string }) => onCreated(data.id),
  });

  function submit() {
    if (!name.trim()) {
      alert("캠페인 이름을 입력하세요.");
      return;
    }
    mut.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="새 캠페인"
      footer={
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mut.isPending}
            className="text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            생성
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="캠페인 이름">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
            autoFocus
          />
        </Field>
        <Field label="채널">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          >
            <option value="EMAIL">이메일</option>
            <option value="GOOGLE_ADS">Google Ads</option>
          </select>
        </Field>
        <Field label="목적">
          <select
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          >
            {OBJECTIVES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="시작일">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-background px-2"
            />
          </Field>
          <Field label="종료일">
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-background px-2"
            />
          </Field>
        </div>
        <Field label="예산 (KRW)">
          <input
            type="number"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-background px-2"
          />
        </Field>
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}
