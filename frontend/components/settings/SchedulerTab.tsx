"use client";

/**
 * Tier 1 — 알림·스케줄 설정 (tenant ADMIN).
 *
 * scheduler + notify(provider 무관 정책) + mail notifications 3 섹션.
 * 저장은 섹션별 독립 PUT.
 *
 * 백업 스케줄은 시스템 전역 — `/admin/db-backups` (SUPER_ADMIN) 에서 관리.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";

type SchedulerSection = {
  enabled: boolean;
  daily_alert_hour: number;
  daily_alert_minute: number;
  project_alert_days: number[];
  assignment_alert_days: number[];
  license_alert_days: number[];
};

// notify 섹션은 provider 무관 정책만 노출. provider 별 자격증명/대상은
// "외부 연동" 탭에서 관리.
type NotifyPolicySection = {
  enabled?: boolean;
  provider?: string;
  notifications: {
    license_expiry_days_before: number[];
    license_renewal_prep: boolean;
  };
};

type MailNotif = {
  notifications: {
    license_expiry_days_before: number[];
    license_renewal_prep: boolean;
    subject_prefix: string;
  };
};

function parseIntList(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n) && n >= 0);
}

export function SchedulerTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: sch } = useQuery<SchedulerSection>({
    queryKey: ["settings", "scheduler"],
    queryFn: () => fetchSection<SchedulerSection>("scheduler"),
  });
  const { data: nty } = useQuery<NotifyPolicySection>({
    queryKey: ["settings", "notify"],
    queryFn: () => fetchSection<NotifyPolicySection>("notify"),
  });
  const { data: mlk } = useQuery<MailNotif>({
    queryKey: ["settings", "mail"],
    queryFn: () => fetchSection<MailNotif>("mail"),
  });

  const [schForm, setSchForm] = useState<SchedulerSection | null>(null);
  const [ntyForm, setNtyForm] = useState<NotifyPolicySection["notifications"] | null>(null);
  const [mlkForm, setMlkForm] = useState<MailNotif["notifications"] | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (sch) setSchForm(sch); }, [sch]);
  useEffect(() => {
    if (nty?.notifications) setNtyForm(nty.notifications);
  }, [nty]);
  useEffect(() => {
    if (mlk?.notifications) setMlkForm(mlk.notifications);
  }, [mlk]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (schForm) await saveSection("scheduler", schForm);
      if (ntyForm && nty) await saveSection("notify", { ...nty, notifications: ntyForm });
      if (mlkForm && mlk) await saveSection("mail", { ...mlk, notifications: mlkForm });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" });
    },
  });

  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const ready = schForm && ntyForm && mlkForm;

  if (!ready) return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;

  return (
    <div className="space-y-4">
      {/* ─── Scheduler ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">스케줄러 (일일 알림)</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={schForm!.enabled}
              onChange={(e) => setSchForm({ ...schForm!, enabled: e.target.checked })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="알림 시각 — 시 (0~23)">
            <input
              type="number" min={0} max={23}
              value={schForm!.daily_alert_hour}
              onChange={(e) => setSchForm({ ...schForm!, daily_alert_hour: Number(e.target.value) })}
              className={input}
            />
          </Field>
          <Field label="알림 시각 — 분 (0~59)">
            <input
              type="number" min={0} max={59}
              value={schForm!.daily_alert_minute}
              onChange={(e) => setSchForm({ ...schForm!, daily_alert_minute: Number(e.target.value) })}
              className={input}
            />
          </Field>
          <Field label="프로젝트 D-day 알림 (쉼표 구분)" colSpan={2}>
            <input
              value={schForm!.project_alert_days.join(",")}
              onChange={(e) => setSchForm({ ...schForm!, project_alert_days: parseIntList(e.target.value) })}
              placeholder="예: 30, 14, 7"
              className={input}
            />
          </Field>
          <Field label="투입 D-day 알림">
            <input
              value={schForm!.assignment_alert_days.join(",")}
              onChange={(e) => setSchForm({ ...schForm!, assignment_alert_days: parseIntList(e.target.value) })}
              className={input}
            />
          </Field>
          <Field label="라이센스 D-day 알림">
            <input
              value={schForm!.license_alert_days.join(",")}
              onChange={(e) => setSchForm({ ...schForm!, license_alert_days: parseIntList(e.target.value) })}
              className={input}
            />
          </Field>
        </div>
      </section>

      {/* ─── 알람 시스템 정책 (provider 무관) ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">알람 발송 정책</h3>
        <p className="-mt-1 text-[11px] text-muted-foreground">
          Provider(Slack/Mattermost) 선택과 자격증명은 "외부 연동" 탭에서.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="라이센스 만료 알림 일수 (쉼표)" colSpan={2}>
            <input
              value={ntyForm!.license_expiry_days_before.join(",")}
              onChange={(e) => setNtyForm({ ...ntyForm!, license_expiry_days_before: parseIntList(e.target.value) })}
              className={input}
            />
          </Field>
          <Field label="갱신 준비 알림">
            <label className="inline-flex items-center gap-1 text-sm h-9">
              <input
                type="checkbox"
                checked={ntyForm!.license_renewal_prep}
                onChange={(e) => setNtyForm({ ...ntyForm!, license_renewal_prep: e.target.checked })}
              />
              활성
            </label>
          </Field>
        </div>
      </section>

      {/* ─── Mail notifications ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Mail 알림 정책</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="라이센스 만료 알림 일수">
            <input
              value={mlkForm!.license_expiry_days_before.join(",")}
              onChange={(e) => setMlkForm({ ...mlkForm!, license_expiry_days_before: parseIntList(e.target.value) })}
              className={input}
            />
          </Field>
          <Field label="갱신 준비 알림">
            <label className="inline-flex items-center gap-1 text-sm h-9">
              <input
                type="checkbox"
                checked={mlkForm!.license_renewal_prep}
                onChange={(e) => setMlkForm({ ...mlkForm!, license_renewal_prep: e.target.checked })}
              />
              활성
            </label>
          </Field>
          <Field label="메일 제목 prefix" colSpan={2}>
            <input
              value={mlkForm!.subject_prefix}
              onChange={(e) => setMlkForm({ ...mlkForm!, subject_prefix: e.target.value })}
              placeholder="[Orbit Works]"
              className={input}
            />
          </Field>
        </div>
      </section>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={saveM.isPending}
          className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saveM.isPending ? "저장 중..." : "모두 저장"}
        </button>
        {saved && <span className="text-xs text-emerald-600">저장되었습니다.</span>}
      </div>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3 | 4;
  children: React.ReactNode;
}) {
  const cls = colSpan === 4 ? "col-span-4" : colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
