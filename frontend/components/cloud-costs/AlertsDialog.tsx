"use client";

/**
 * 클라우드 비용 알람 — 규칙 관리 + 발송 이력.
 *
 * 다이얼로그 안에서 두 탭:
 *   1. 규칙 — CRUD + enable 토글 + "지금 평가" 버튼
 *   2. 이력 — 최근 발송 이벤트 100건 (rule 별 필터)
 *
 * 발송 채널은 글로벌 notify (Slack 또는 Mattermost) — 설정 > 외부 연동에서 결정.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Pencil, Plus, Send, Trash2, X, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { TabBar, TabItem } from "@/components/ui/TabBar";

type RuleType =
  | "DAILY_THRESHOLD"
  | "MONTHLY_FORECAST"
  | "FETCH_FAILED"
  | "DAY_OVER_DAY_PERCENT"
  | "NEW_SERVICE";

type Provider = "AWS" | "AZURE" | "GCP";

const RULE_TYPE_LABEL: Record<RuleType, string> = {
  DAILY_THRESHOLD: "일별 임계값",
  MONTHLY_FORECAST: "월말 예측",
  FETCH_FAILED: "수집 실패",
  DAY_OVER_DAY_PERCENT: "전일 대비 급증",
  NEW_SERVICE: "신규 서비스 등장",
};

const RULE_TYPE_DESC: Record<RuleType, string> = {
  DAILY_THRESHOLD: "어제 합계가 임계 KRW 초과 시",
  MONTHLY_FORECAST: "이번 달 추정 합계가 예산 초과 예상 시",
  FETCH_FAILED: "어제 수집 작업 중 FAILED 발생 시",
  DAY_OVER_DAY_PERCENT: "어제가 그저께 대비 N% 이상 증가 시",
  NEW_SERVICE: "최근 7일 평균에 없던 service 가 새로 청구 시",
};

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  rule_type: RuleType;
  provider: Provider | null;
  account_id: string | null;
  threshold_krw: number | null;
  threshold_percent: number | null;
  notify_channels: string[] | null;
  notify_user_emails: string[] | null;
  notify_user_ids: string[] | null;
  last_fired_at: string | null;
};

type Event = {
  id: string;
  rule_id: string;
  dedup_key: string;
  fired_at: string;
  message: string;
  delivered: boolean;
  error_message: string | null;
};

type Form = {
  id?: string;
  name: string;
  enabled: boolean;
  rule_type: RuleType;
  provider: "" | Provider;
  account_id: string;
  threshold_krw: string;
  threshold_percent: string;
  // 발송 대상 — raw text (콤마/공백 허용), 저장 시 parseCsv 로 배열 변환.
  notify_channels_text: string;
  notify_user_emails_text: string;
  notify_user_ids_text: string;
};

const BLANK: Form = {
  name: "",
  enabled: true,
  rule_type: "DAILY_THRESHOLD",
  provider: "",
  account_id: "",
  threshold_krw: "",
  threshold_percent: "",
  notify_channels_text: "",
  notify_user_emails_text: "",
  notify_user_ids_text: "",
};

function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function CloudCostAlertsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [tab, setTab] = useState<"rules" | "events">("rules");
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);

  const { data: rules = [] } = useQuery<Rule[]>({
    queryKey: ["cloud-cost-alerts"],
    queryFn: async () => (await api.get("/cloud-costs/alerts")).data,
    enabled: open,
  });

  const { data: events = [] } = useQuery<Event[]>({
    queryKey: ["cloud-cost-alert-events"],
    queryFn: async () => (await api.get("/cloud-costs/alert-events")).data,
    enabled: open && tab === "events",
  });

  const saveM = useMutation({
    mutationFn: async () => {
      const channels = parseCsv(form.notify_channels_text);
      const userEmails = parseCsv(form.notify_user_emails_text);
      const userIds = parseCsv(form.notify_user_ids_text);
      const body = {
        name: form.name,
        enabled: form.enabled,
        rule_type: form.rule_type,
        provider: form.provider || null,
        account_id: form.account_id || null,
        threshold_krw: form.threshold_krw ? Number(form.threshold_krw) : null,
        threshold_percent: form.threshold_percent ? Number(form.threshold_percent) : null,
        notify_channels: channels.length ? channels : null,
        notify_user_emails: userEmails.length ? userEmails : null,
        notify_user_ids: userIds.length ? userIds : null,
      };
      if (form.id) {
        await api.patch(`/cloud-costs/alerts/${form.id}`, body);
      } else {
        await api.post("/cloud-costs/alerts", body);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cloud-cost-alerts"] });
      setEditorOpen(false);
      setForm(BLANK);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" });
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/cloud-costs/alerts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cloud-cost-alerts"] }),
  });

  const evalM = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/cloud-costs/alerts/${id}/evaluate`)).data,
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["cloud-cost-alerts"] });
      qc.invalidateQueries({ queryKey: ["cloud-cost-alert-events"] });
      await dialog.alert("평가 완료. 조건 충족 시 알림이 발송되었습니다.");
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "평가 실패", { title: "오류" });
    },
  });

  function startEdit(r: Rule) {
    setForm({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      rule_type: r.rule_type,
      provider: (r.provider ?? "") as "" | Provider,
      account_id: r.account_id ?? "",
      threshold_krw: r.threshold_krw?.toString() ?? "",
      threshold_percent: r.threshold_percent?.toString() ?? "",
      notify_channels_text: (r.notify_channels ?? []).join(","),
      notify_user_emails_text: (r.notify_user_emails ?? []).join(","),
      notify_user_ids_text: (r.notify_user_ids ?? []).join(","),
    });
    setEditorOpen(true);
  }

  const ruleNameById = new Map(rules.map((r) => [r.id, r.name] as const));

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width="max-w-3xl"
        title="클라우드 비용 알람"
        footer={
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
        }
      >
        <TabBar className="mb-3 -mt-2">
          <TabItem active={tab === "rules"} onClick={() => setTab("rules")}>
            규칙 ({rules.length})
          </TabItem>
          <TabItem active={tab === "events"} onClick={() => setTab("events")}>
            발송 이력
          </TabItem>
        </TabBar>

        {tab === "rules" ? (
          <div className="space-y-2">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => { setForm(BLANK); setEditorOpen(true); }}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
              >
                <Plus className="h-3 w-3" /> 규칙 추가
              </button>
            </div>
            {rules.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                등록된 규칙이 없습니다.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left py-1 px-1">활성</th>
                    <th className="text-left py-1 px-1">이름</th>
                    <th className="text-left py-1 px-1">타입</th>
                    <th className="text-left py-1 px-1">필터</th>
                    <th className="text-right py-1 px-1">임계</th>
                    <th className="text-left py-1 px-1">최근 발송</th>
                    <th className="text-right py-1 px-1">동작</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-t border-border/50">
                      <td className="py-1 px-1">
                        {r.enabled ? (
                          <span className="inline-block rounded bg-emerald-100 text-emerald-700 px-1.5 py-0.5 text-[10px]">ON</span>
                        ) : (
                          <span className="inline-block rounded bg-gray-200 text-gray-600 px-1.5 py-0.5 text-[10px]">OFF</span>
                        )}
                      </td>
                      <td className="py-1 px-1 font-medium">{r.name}</td>
                      <td className="py-1 px-1 text-xs">
                        <div>{RULE_TYPE_LABEL[r.rule_type]}</div>
                        <div className="text-[10px] text-muted-foreground leading-tight">{RULE_TYPE_DESC[r.rule_type]}</div>
                      </td>
                      <td className="py-1 px-1 text-xs">
                        {r.provider ? <span className="rounded border border-border px-1.5 py-0.5 mr-1">{r.provider}</span> : null}
                        {r.account_id ? <span className="text-muted-foreground">{r.account_id}</span> : (r.provider ? "" : <span className="text-muted-foreground">전체</span>)}
                      </td>
                      <td className="py-1 px-1 text-xs text-right tabular-nums">
                        {r.threshold_krw ? `${r.threshold_krw.toLocaleString("ko-KR")}원` : ""}
                        {r.threshold_percent ? `${r.threshold_percent}%` : ""}
                      </td>
                      <td className="py-1 px-1 text-xs text-muted-foreground">
                        {r.last_fired_at ? r.last_fired_at.replace("T", " ").slice(0, 16) : "—"}
                      </td>
                      <td className="py-1 px-1 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => evalM.mutate(r.id)}
                          disabled={evalM.isPending}
                          className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline mr-2"
                          title="지금 평가 (어제 데이터 기준)"
                        >
                          <Send className="h-3 w-3" /> 평가
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(r)}
                          className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline mr-2"
                        >
                          <Pencil className="h-3 w-3" /> 편집
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (await dialog.confirm("이 규칙을 삭제하시겠습니까?", { destructive: true })) {
                              deleteM.mutate(r.id);
                            }
                          }}
                          className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
                        >
                          <Trash2 className="h-3 w-3" /> 삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                발송 이력이 없습니다.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1 px-1">발송 시각</th>
                    <th className="text-left py-1 px-1">규칙</th>
                    <th className="text-left py-1 px-1">메시지</th>
                    <th className="text-left py-1 px-1">전송</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id} className="border-t border-border/50 align-top">
                      <td className="py-1 px-1 tabular-nums whitespace-nowrap">
                        {ev.fired_at.replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="py-1 px-1 whitespace-nowrap">
                        {ruleNameById.get(ev.rule_id) ?? <span className="text-muted-foreground">(삭제됨)</span>}
                      </td>
                      <td className="py-1 px-1">{ev.message}</td>
                      <td className="py-1 px-1">
                        {ev.delivered ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3 w-3" /> 성공
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-destructive"
                            title={ev.error_message ?? ""}
                          >
                            <XCircle className="h-3 w-3" /> 실패
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Dialog>

      {/* 규칙 추가/편집 sub-dialog */}
      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        width="max-w-xl"
        title={form.id ? "규칙 편집" : "새 규칙"}
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => saveM.mutate()}
              disabled={saveM.isPending || !form.name.trim()}
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="이름 *" colSpan={2}>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="예: AWS 일일 100만원 초과"
              className={input}
            />
          </Field>
          <Field label="규칙 타입 *" colSpan={2}>
            <select
              value={form.rule_type}
              onChange={(e) => setForm({ ...form, rule_type: e.target.value as RuleType })}
              className={input}
            >
              {(Object.keys(RULE_TYPE_LABEL) as RuleType[]).map((t) => (
                <option key={t} value={t}>{RULE_TYPE_LABEL[t]} — {RULE_TYPE_DESC[t]}</option>
              ))}
            </select>
          </Field>
          <Field label="Provider 필터">
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value as "" | Provider })}
              className={input}
            >
              <option value="">전체</option>
              <option value="AWS">AWS</option>
              <option value="AZURE">Azure</option>
              <option value="GCP">GCP</option>
            </select>
          </Field>
          <Field label="Account ID 필터 (선택)">
            <input
              value={form.account_id}
              onChange={(e) => setForm({ ...form, account_id: e.target.value })}
              placeholder="비워두면 전체"
              className={input}
            />
          </Field>
          {needsThresholdKrw(form.rule_type) && (
            <Field label="임계 (KRW)">
              <input
                type="number"
                value={form.threshold_krw}
                onChange={(e) => setForm({ ...form, threshold_krw: e.target.value })}
                placeholder="예: 1000000"
                className={input}
              />
            </Field>
          )}
          {needsThresholdPercent(form.rule_type) && (
            <Field label="임계 (%)">
              <input
                type="number"
                value={form.threshold_percent}
                onChange={(e) => setForm({ ...form, threshold_percent: e.target.value })}
                placeholder="예: 30"
                className={input}
              />
            </Field>
          )}
          <Field label="활성" colSpan={2}>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              활성화 (스케줄러가 매일 평가)
            </label>
          </Field>

          {/* 발송 대상 override — 비워두면 tenant default 사용 */}
          <div className="col-span-2 mt-2 pt-3 border-t border-border space-y-3">
            <div className="text-xs font-semibold text-muted-foreground">
              발송 대상 (이 규칙 전용 — 비워두면 외부 연동의 default 사용)
            </div>
            <Field label="채널 (#name 또는 channel-id, 쉼표)">
              <input
                value={form.notify_channels_text}
                onChange={(e) => setForm({ ...form, notify_channels_text: e.target.value })}
                placeholder="예: #cost-alerts, #devops"
                className={input}
              />
            </Field>
            <Field label="수신자 이메일 (Slack/Mattermost 공통, 쉼표)">
              <input
                value={form.notify_user_emails_text}
                onChange={(e) => setForm({ ...form, notify_user_emails_text: e.target.value })}
                placeholder="예: alice@company.com, bob@company.com"
                className={input}
              />
            </Field>
            <Field label="Slack 사용자 ID (Slack 전용, 쉼표 — 선택)">
              <input
                value={form.notify_user_ids_text}
                onChange={(e) => setForm({ ...form, notify_user_ids_text: e.target.value })}
                placeholder="예: U01ABC..., U02DEF..."
                className={input + " font-mono text-xs"}
              />
            </Field>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-3">
          알림은 설정 &gt; 외부 연동의 활성 provider (Slack 또는 Mattermost) 로 발송됩니다.
          위 발송 대상이 채워져 있으면 그 대상으로, 비어 있으면 provider 의 default 대상으로 갑니다.
        </p>
      </Dialog>
    </>
  );
}

const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

function needsThresholdKrw(t: RuleType): boolean {
  return t === "DAILY_THRESHOLD" || t === "MONTHLY_FORECAST";
}
function needsThresholdPercent(t: RuleType): boolean {
  return t === "DAY_OVER_DAY_PERCENT";
}

function Field({ label, colSpan, children }: { label: string; colSpan?: 1 | 2; children: React.ReactNode }) {
  return (
    <label className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
