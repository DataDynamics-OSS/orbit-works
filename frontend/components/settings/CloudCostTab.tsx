"use client";

/**
 * 외부 연동 — 클라우드 비용 (AWS / Azure / GCP).
 *
 * 자격증명은 백엔드에서 Fernet 으로 자동 암호화되어 저장된다 (DB 평문 X).
 * 응답에서는 항상 `***ENCRYPTED` 마스킹값으로 돌아오며, UI 에서 수정하지 않고
 * 저장하면 서버가 마스킹값을 보고 기존값을 유지한다. "표시" 토글은 SUPER/ADMIN
 * 만 허용 — 별도 GET `/settings/cloud_cost/reveal/<field>` 호출.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Save } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";
import { api } from "@/lib/api";

type AWS = {
  enabled: boolean;
  access_key_id: string;
  secret_access_key: string;
  region: string;
  accounts: string[];
};
type Azure = {
  enabled: boolean;
  tenant_id: string;
  client_id: string;
  client_secret: string;
  subscription_ids: string[];
};
type GCP = {
  enabled: boolean;
  service_account_json: string;
  billing_account_id: string;
  bigquery_dataset: string;
  bigquery_table_suffix: string;
};
type CloudCostFull = {
  enabled: boolean;
  fetch_interval_days: number;
  service_top_n: number;
  alert_threshold_krw: number;
  auto_fetch: { enabled: boolean; hour: number; minute: number; catchup_days: number };
  aws: AWS;
  azure: Azure;
  gcp: GCP;
};

function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// dotted-path (예: "aws.access_key_id") 로 중첩값을 읽는다.
function getByPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

// dotted-path 로 중첩값을 immutable 하게 설정한 새 객체를 반환한다.
function setByPath<T>(obj: T, path: string, value: unknown): T {
  const parts = path.split(".");
  const clone: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...cur[parts[i]] };
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
}

export function CloudCostTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: cc } = useQuery<CloudCostFull>({
    queryKey: ["settings", "cloud_cost"],
    queryFn: () => fetchSection("cloud_cost"),
  });

  const [form, setForm] = useState<CloudCostFull | null>(null);
  // CSV 입력 필드는 raw text 로 별도 state — onChange 마다 배열로 변환·재join 하면
  // ',' 입력 직후 빈 토큰이 filter 로 사라져 화면에 comma 가 입력되지 않는다.
  const [awsAccountsText, setAwsAccountsText] = useState("");
  const [azureSubsText, setAzureSubsText] = useState("");
  const [saved, setSaved] = useState(false);
  // 평문 표시 토글 — 토글 ON 시 reveal API 로 받아온 값을 form 에 직접 박는다.
  const [showAwsAk, setShowAwsAk] = useState(false);
  const [showAwsSk, setShowAwsSk] = useState(false);
  const [showAzureSec, setShowAzureSec] = useState(false);
  const [showGcpSa, setShowGcpSa] = useState(false);

  useEffect(() => {
    if (cc) {
      setForm(cc);
      setAwsAccountsText((cc.aws.accounts ?? []).join(","));
      setAzureSubsText((cc.azure.subscription_ids ?? []).join(","));
    }
  }, [cc]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form) return;
      // 저장 시점에만 raw text → 배열로 파싱.
      const payload: CloudCostFull = {
        ...form,
        aws: { ...form.aws, accounts: parseCsv(awsAccountsText) },
        azure: { ...form.azure, subscription_ids: parseCsv(azureSubsText) },
      };
      await saveSection("cloud_cost", payload);
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

  // eye 토글: 숨김→표시 는 reveal API 의 평문을, 표시→숨김 은 서버가 준 마스킹값
  // (cc)으로 되돌린다. 이전엔 숨김 시 아이콘만 바뀌고 평문이 화면에 그대로 남았음.
  // setForm 은 함수형으로 — 여러 필드를 연속 reveal 할 때 stale form 클로저가
  // 앞서 표시한 값을 덮어쓰지 않도록.
  async function toggleReveal(
    path: string,
    shown: boolean,
    setShown: (b: boolean) => void,
  ) {
    if (shown) {
      const masked = (getByPath(cc, path) as string) ?? "";
      setForm((f) => (f ? (setByPath(f, path, masked) as CloudCostFull) : f));
      setShown(false);
      return;
    }
    try {
      const { data } = await api.get(`/settings/cloud_cost/reveal/${path}`);
      setForm((f) =>
        f ? (setByPath(f, path, data.value as string) as CloudCostFull) : f,
      );
      setShown(true);
    } catch (e: any) {
      await dialog.alert(e?.response?.data?.detail ?? "평문 조회 실패", { title: "오류" });
    }
  }

  if (!form) return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;

  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <div className="space-y-4">
      {/* ─── 공통 ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">클라우드 비용 — 공통</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            활성
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          매일 1회 자동 수집. 자격증명은 서버에서 자동 암호화되어 저장됩니다.
          GCP 는 BigQuery billing export 활성화가 선행되어야 합니다 (콘솔 → Billing → BigQuery export).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="수집 주기 (일, 1~7)">
            <input
              type="number" min={1} max={7}
              value={form.fetch_interval_days}
              onChange={(e) => setForm({ ...form, fetch_interval_days: Number(e.target.value) || 1 })}
              className={input}
            />
          </Field>
          <Field label="서비스 Top N (0=전체)">
            <input
              type="number" min={0}
              value={form.service_top_n}
              onChange={(e) => setForm({ ...form, service_top_n: Number(e.target.value) || 0 })}
              className={input}
            />
          </Field>
          <Field label="일일 합계 임계 알림 (KRW, 0=비활성)" colSpan={2}>
            <input
              type="number" min={0}
              value={form.alert_threshold_krw}
              onChange={(e) => setForm({ ...form, alert_threshold_krw: Number(e.target.value) || 0 })}
              className={input}
            />
          </Field>
          <Field label="자동 수집 시각 — 시 (0~23)">
            <input
              type="number" min={0} max={23}
              value={form.auto_fetch.hour}
              onChange={(e) => setForm({ ...form, auto_fetch: { ...form.auto_fetch, hour: Number(e.target.value) || 0 } })}
              className={input}
            />
          </Field>
          <Field label="자동 수집 시각 — 분 (0~59)">
            <input
              type="number" min={0} max={59}
              value={form.auto_fetch.minute}
              onChange={(e) => setForm({ ...form, auto_fetch: { ...form.auto_fetch, minute: Number(e.target.value) || 0 } })}
              className={input}
            />
          </Field>
        </div>
      </section>

      {/* ─── AWS ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">AWS — Cost Explorer</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={form.aws.enabled}
              onChange={(e) => setForm({ ...form, aws: { ...form.aws, enabled: e.target.checked } })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Access Key ID">
            <div className="flex gap-1">
              <input
                value={form.aws.access_key_id}
                onChange={(e) => setForm({ ...form, aws: { ...form.aws, access_key_id: e.target.value } })}
                className={input + " font-mono"}
              />
              <RevealBtn
                shown={showAwsAk}
                onClick={() =>
                  toggleReveal("aws.access_key_id", showAwsAk, setShowAwsAk)
                }
              />
            </div>
          </Field>
          <Field label="Secret Access Key">
            <div className="flex gap-1">
              <input
                value={form.aws.secret_access_key}
                onChange={(e) => setForm({ ...form, aws: { ...form.aws, secret_access_key: e.target.value } })}
                className={input + " font-mono"}
              />
              <RevealBtn
                shown={showAwsSk}
                onClick={() =>
                  toggleReveal("aws.secret_access_key", showAwsSk, setShowAwsSk)
                }
              />
            </div>
          </Field>
          <Field label="Region">
            <input
              value={form.aws.region}
              onChange={(e) => setForm({ ...form, aws: { ...form.aws, region: e.target.value } })}
              placeholder="us-east-1"
              className={input}
            />
          </Field>
          <Field label="Accounts (쉼표)">
            <input
              value={awsAccountsText}
              onChange={(e) => setAwsAccountsText(e.target.value)}
              placeholder="123456789012,234567890123"
              className={input}
            />
          </Field>
        </div>
      </section>

      {/* ─── Azure ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Azure — Cost Management</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={form.azure.enabled}
              onChange={(e) => setForm({ ...form, azure: { ...form.azure, enabled: e.target.checked } })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tenant ID (Directory)">
            <input
              value={form.azure.tenant_id}
              onChange={(e) => setForm({ ...form, azure: { ...form.azure, tenant_id: e.target.value } })}
              className={input + " font-mono"}
            />
          </Field>
          <Field label="Client ID (Application)">
            <input
              value={form.azure.client_id}
              onChange={(e) => setForm({ ...form, azure: { ...form.azure, client_id: e.target.value } })}
              className={input + " font-mono"}
            />
          </Field>
          <Field label="Client Secret" colSpan={2}>
            <div className="flex gap-1">
              <input
                value={form.azure.client_secret}
                onChange={(e) => setForm({ ...form, azure: { ...form.azure, client_secret: e.target.value } })}
                className={input + " font-mono"}
              />
              <RevealBtn
                shown={showAzureSec}
                onClick={() =>
                  toggleReveal("azure.client_secret", showAzureSec, setShowAzureSec)
                }
              />
            </div>
          </Field>
          <Field label="Subscription IDs (쉼표)" colSpan={2}>
            <input
              value={azureSubsText}
              onChange={(e) => setAzureSubsText(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className={input + " font-mono text-xs"}
            />
          </Field>
        </div>
      </section>

      {/* ─── GCP ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">GCP — BigQuery billing export</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={form.gcp.enabled}
              onChange={(e) => setForm({ ...form, gcp: { ...form.gcp, enabled: e.target.checked } })}
            />
            활성
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          GCP 는 cost API 가 없어 BigQuery billing export 가 필수입니다.{" "}
          <a
            href="https://cloud.google.com/billing/docs/how-to/export-data-bigquery"
            target="_blank"
            rel="noreferrer"
            className="underline text-primary"
          >
            export 활성화 가이드
          </a>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Billing Account ID">
            <input
              value={form.gcp.billing_account_id}
              onChange={(e) => setForm({ ...form, gcp: { ...form.gcp, billing_account_id: e.target.value } })}
              placeholder="0123AB-456CDE-789FAB"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="BigQuery Dataset (project.dataset)">
            <input
              value={form.gcp.bigquery_dataset}
              onChange={(e) => setForm({ ...form, gcp: { ...form.gcp, bigquery_dataset: e.target.value } })}
              placeholder="myproj.billing_export"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="Table Suffix (자동 = billing_account_id 의 _ 치환형)" colSpan={2}>
            <input
              value={form.gcp.bigquery_table_suffix}
              onChange={(e) => setForm({ ...form, gcp: { ...form.gcp, bigquery_table_suffix: e.target.value } })}
              placeholder="0123AB_456CDE_789FAB"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="Service Account JSON (전체 붙여넣기)" colSpan={2}>
            <div className="flex gap-1">
              <textarea
                rows={6}
                value={form.gcp.service_account_json}
                onChange={(e) => setForm({ ...form, gcp: { ...form.gcp, service_account_json: e.target.value } })}
                className={input + " font-mono text-[11px]"}
              />
              <RevealBtn
                shown={showGcpSa}
                onClick={() =>
                  toggleReveal("gcp.service_account_json", showGcpSa, setShowGcpSa)
                }
              />
            </div>
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

function RevealBtn({ shown, onClick }: { shown: boolean; onClick: () => void | Promise<void> }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shown ? "다시 마스킹" : "평문 표시"}
      className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted shrink-0"
    >
      {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
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
