"use client";

/**
 * Tier 2 — 외부 연동 (알람 시스템 · Mail · 전자세금계산서 · 카카오맵).
 *
 * 알람 시스템: provider 선택 (slack | mattermost) + 활성 토글 + 선택된 provider 의
 * 자격증명/대상 입력. provider 별 데이터는 분리 보관해 전환 시 데이터 손실 없음.
 *
 * 각 섹션 "테스트 전송" 은 활성 상태에서만 동작 — 비활성 시 backend 가 400 반환.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Send } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";
import { api } from "@/lib/api";

type NotifyProvider = "slack" | "mattermost";

type NotifyFull = {
  enabled: boolean;
  provider: NotifyProvider;
  slack: {
    bot_token: string;
    default_webhook_url: string;
    default_channels: string[];
    default_user_emails: string[];
    default_user_ids: string[];
    emoji_prefix: string;
  };
  mattermost: {
    base_url: string;
    bot_token: string;
    default_team: string;
    default_channels: string[];
    default_user_emails: string[];
  };
  notifications: {
    license_expiry_days_before: number[];
    license_renewal_prep: boolean;
  };
};

type MailFull = {
  enabled: boolean;
  default_recipients: string[];
  smtp: {
    host: string;
    port: number;
    use_tls: boolean;
    use_ssl: boolean;
    timeout_seconds: number;
  };
  sender: { email: string; name: string; app_password: string };
  notifications: {
    license_expiry_days_before: number[];
    license_renewal_prep: boolean;
    subject_prefix: string;
  };
};

type TaxInvoiceFull = {
  enabled: boolean;
  provider: string;
  certkey: string;
  corpnum: string;
  user_id: string;
  environment: string;
  download_pdf: boolean;
  auto_fetch: {
    enabled: boolean;
    hour: number;
    minute: number;
    catchup_days: number;
  };
};

type KakaoMapFull = {
  enabled: boolean;
  javascript_key: string;
  sdk_version: string;
  integrity: string;
};

type GoogleMapFull = {
  enabled: boolean;
  javascript_key: string;
};

type NhnCloudSmsFull = {
  enabled: boolean;
  url: string;
  app_key: string;
  secret_key: string;
};

function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function IntegrationsTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: nt } = useQuery<NotifyFull>({ queryKey: ["settings", "notify"], queryFn: () => fetchSection("notify") });
  const { data: mf } = useQuery<MailFull>({ queryKey: ["settings", "mail"], queryFn: () => fetchSection("mail") });
  const { data: tx } = useQuery<TaxInvoiceFull>({ queryKey: ["settings", "tax_invoice"], queryFn: () => fetchSection("tax_invoice") });
  const { data: km } = useQuery<KakaoMapFull>({ queryKey: ["settings", "kakao_map"], queryFn: () => fetchSection("kakao_map") });
  const { data: gm } = useQuery<GoogleMapFull>({ queryKey: ["settings", "google_map"], queryFn: () => fetchSection("google_map") });
  const { data: np } = useQuery<NhnCloudSmsFull>({ queryKey: ["settings", "nhn_cloud_sms"], queryFn: () => fetchSection("nhn_cloud_sms") });

  const [ntForm, setNtForm] = useState<NotifyFull | null>(null);
  const [mfForm, setMfForm] = useState<MailFull | null>(null);
  const [txForm, setTxForm] = useState<TaxInvoiceFull | null>(null);
  const [kmForm, setKmForm] = useState<KakaoMapFull | null>(null);
  const [gmForm, setGmForm] = useState<GoogleMapFull | null>(null);
  const [npForm, setNpForm] = useState<NhnCloudSmsFull | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (nt) setNtForm(nt); }, [nt]);
  useEffect(() => { if (mf) setMfForm(mf); }, [mf]);
  useEffect(() => { if (tx) setTxForm(tx); }, [tx]);
  useEffect(() => { if (km) setKmForm(km); }, [km]);
  useEffect(() => { if (gm) setGmForm(gm); }, [gm]);
  useEffect(() => { if (np) setNpForm(np); }, [np]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (ntForm) await saveSection("notify", ntForm);
      if (mfForm) await saveSection("mail", mfForm);
      if (txForm) await saveSection("tax_invoice", txForm);
      if (kmForm) await saveSection("kakao_map", kmForm);
      if (gmForm) await saveSection("google_map", gmForm);
      if (npForm) await saveSection("nhn_cloud_sms", npForm);
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

  const notifyTestM = useMutation({
    mutationFn: async () =>
      (await api.post("/notifications/notify/test", { text: "알람 시스템 테스트 (Orbit Works)" })).data as { delivered: boolean; provider: string },
    onSuccess: async (data) => {
      if (data.delivered) {
        await dialog.alert(`${data.provider} 테스트 전송 완료. 채널을 확인하세요.`);
      } else {
        await dialog.alert(
          `${data.provider} 서버는 200 을 돌려줬지만 실제 전송은 실패했습니다 (delivered=false).\n` +
            "가능한 원인: 빈 bot_token, 기본 채널/사용자 없음, 봇이 채널에 초대되지 않음, 토큰 만료 등.\n" +
            "저장 후 반영됐는지 backend 로그에서 'notify' / 'Slack' / 'Mattermost' 항목을 확인해 주세요.",
          { title: "알람 미전송" },
        );
      }
    },
    onError: async (e: any) => { await dialog.alert(e?.response?.data?.detail ?? "알람 테스트 실패"); },
  });

  const mailTestM = useMutation({
    mutationFn: async () =>
      (await api.post("/notifications/mail/test", {
        subject: "Orbit Works mail 설정 테스트",
        body: "이 메일은 Orbit Works 설정 페이지에서 발송한 테스트입니다.",
      })).data as { delivered: boolean },
    onSuccess: async (data) => {
      if (data.delivered) {
        await dialog.alert("Mail 테스트 전송 완료. 수신함을 확인하세요.");
      } else {
        await dialog.alert(
          "서버는 200 을 돌려줬지만 실제 발송은 실패했습니다 (delivered=false).\n" +
            "가능한 원인: Mail 비활성, 발신자 이메일/비밀번호 미설정, 기본 수신자 없음, SMTP 연결 실패.\n" +
            "backend 로그의 'mail' 항목을 확인해 주세요.",
          { title: "Mail 미전송" },
        );
      }
    },
    onError: async (e: any) => { await dialog.alert(e?.response?.data?.detail ?? "Mail 테스트 실패"); },
  });

  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const ready =
    ntForm && mfForm && txForm && kmForm && gmForm && npForm;

  if (!ready) return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;

  return (
    <div className="space-y-4">
      {/* ─── 알람 시스템 (Slack / Mattermost) ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">알람 시스템</h3>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">Provider</span>
              <select
                value={ntForm!.provider}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, provider: e.target.value as NotifyProvider })
                }
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="slack">Slack</option>
                <option value="mattermost">Mattermost</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={ntForm!.enabled}
                onChange={(e) => setNtForm({ ...ntForm!, enabled: e.target.checked })}
              />
              활성
            </label>
            <button
              type="button"
              onClick={() => notifyTestM.mutate()}
              disabled={notifyTestM.isPending || !ntForm!.enabled}
              title={!ntForm!.enabled ? "활성 후 저장하면 사용 가능" : ""}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              테스트 전송
            </button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          선택한 provider 의 자격증명·기본 대상으로 알람을 발송합니다. 두 provider
          데이터는 서로 분리 보관되어 전환해도 사라지지 않습니다.
        </p>

        {ntForm!.provider === "slack" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bot Token (xoxb-…)" colSpan={2}>
              <input
                type="text"
                value={ntForm!.slack.bot_token}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, slack: { ...ntForm!.slack, bot_token: e.target.value } })
                }
                placeholder="xoxb-..."
                className={input + " font-mono"}
              />
              <HelperText>저장된 토큰이 평문 그대로 표시됩니다. 노출에 유의.</HelperText>
            </Field>
            <Field label="Webhook URL (선택)" colSpan={2}>
              <input
                value={ntForm!.slack.default_webhook_url}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, slack: { ...ntForm!.slack, default_webhook_url: e.target.value } })
                }
                className={input}
              />
            </Field>
            <Field label="기본 채널 (쉼표)">
              <input
                value={ntForm!.slack.default_channels.join(",")}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, slack: { ...ntForm!.slack, default_channels: parseCsv(e.target.value) } })
                }
                placeholder="#alert"
                className={input}
              />
            </Field>
            <Field label="기본 사용자 이메일 (쉼표)">
              <input
                value={ntForm!.slack.default_user_emails.join(",")}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, slack: { ...ntForm!.slack, default_user_emails: parseCsv(e.target.value) } })
                }
                className={input}
              />
            </Field>
            <Field label="이모지 prefix">
              <input
                value={ntForm!.slack.emoji_prefix}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, slack: { ...ntForm!.slack, emoji_prefix: e.target.value } })
                }
                placeholder=":bell:"
                className={input}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base URL" colSpan={2}>
              <input
                value={ntForm!.mattermost.base_url}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, mattermost: { ...ntForm!.mattermost, base_url: e.target.value } })
                }
                placeholder="https://mm.example.com"
                className={input}
              />
              <HelperText>Mattermost 서버 URL. 끝의 / 는 자동 제거.</HelperText>
            </Field>
            <Field label="Bot Account Token" colSpan={2}>
              <input
                type="text"
                value={ntForm!.mattermost.bot_token}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, mattermost: { ...ntForm!.mattermost, bot_token: e.target.value } })
                }
                placeholder="bot account 또는 personal access token"
                className={input + " font-mono"}
              />
            </Field>
            <Field label="기본 Team (이름 또는 id)">
              <input
                value={ntForm!.mattermost.default_team}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, mattermost: { ...ntForm!.mattermost, default_team: e.target.value } })
                }
                placeholder="orbit"
                className={input}
              />
              <HelperText>채널명 → id 해석에 사용. 채널 id 를 직접 적으면 무관.</HelperText>
            </Field>
            <Field label="기본 채널 (쉼표)">
              <input
                value={ntForm!.mattermost.default_channels.join(",")}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, mattermost: { ...ntForm!.mattermost, default_channels: parseCsv(e.target.value) } })
                }
                placeholder="town-square"
                className={input}
              />
            </Field>
            <Field label="기본 사용자 이메일 (쉼표)" colSpan={2}>
              <input
                value={ntForm!.mattermost.default_user_emails.join(",")}
                onChange={(e) =>
                  setNtForm({ ...ntForm!, mattermost: { ...ntForm!.mattermost, default_user_emails: parseCsv(e.target.value) } })
                }
                className={input}
              />
            </Field>
          </div>
        )}
      </section>

      {/* ─── Mail ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Mail (SMTP)</h3>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={mfForm!.enabled}
                onChange={(e) => setMfForm({ ...mfForm!, enabled: e.target.checked })}
              />
              활성
            </label>
            <button
              type="button"
              onClick={() => mailTestM.mutate()}
              disabled={mailTestM.isPending}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              테스트 발송
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Field label="SMTP Host" colSpan={2}>
            <input
              value={mfForm!.smtp.host}
              onChange={(e) => setMfForm({ ...mfForm!, smtp: { ...mfForm!.smtp, host: e.target.value } })}
              className={input}
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              value={mfForm!.smtp.port}
              onChange={(e) => setMfForm({ ...mfForm!, smtp: { ...mfForm!.smtp, port: Number(e.target.value) } })}
              className={input}
            />
          </Field>
          <Field label="Timeout (초)">
            <input
              type="number"
              value={mfForm!.smtp.timeout_seconds}
              onChange={(e) => setMfForm({ ...mfForm!, smtp: { ...mfForm!.smtp, timeout_seconds: Number(e.target.value) } })}
              className={input}
            />
          </Field>
          <Field label="STARTTLS">
            <label className="inline-flex items-center gap-1 text-sm h-9">
              <input
                type="checkbox"
                checked={mfForm!.smtp.use_tls}
                onChange={(e) => setMfForm({ ...mfForm!, smtp: { ...mfForm!.smtp, use_tls: e.target.checked } })}
              />
              활성
            </label>
          </Field>
          <Field label="Implicit SSL (465)">
            <label className="inline-flex items-center gap-1 text-sm h-9">
              <input
                type="checkbox"
                checked={mfForm!.smtp.use_ssl}
                onChange={(e) => setMfForm({ ...mfForm!, smtp: { ...mfForm!.smtp, use_ssl: e.target.checked } })}
              />
              활성
            </label>
          </Field>
          <Field label="발신자 이메일" colSpan={2}>
            <input
              type="email"
              value={mfForm!.sender.email}
              onChange={(e) => setMfForm({ ...mfForm!, sender: { ...mfForm!.sender, email: e.target.value } })}
              className={input}
            />
          </Field>
          <Field label="발신자 이름" colSpan={2}>
            <input
              value={mfForm!.sender.name}
              onChange={(e) => setMfForm({ ...mfForm!, sender: { ...mfForm!.sender, name: e.target.value } })}
              className={input}
            />
          </Field>
          <Field label="발신자 이메일 비밀번호" colSpan={4}>
            <input
              type="text"
              value={mfForm!.sender.app_password}
              onChange={(e) => setMfForm({ ...mfForm!, sender: { ...mfForm!.sender, app_password: e.target.value } })}
              className={input + " font-mono"}
            />
            <HelperText>저장된 비밀번호는 평문으로 표시됩니다. Gmail 사용 시 2단계 인증 후 발급받은 "앱 비밀번호" 를 입력하세요.</HelperText>
          </Field>
          <Field label="기본 수신자 (쉼표)" colSpan={4}>
            <input
              value={mfForm!.default_recipients.join(",")}
              onChange={(e) => setMfForm({ ...mfForm!, default_recipients: parseCsv(e.target.value) })}
              className={input}
            />
          </Field>
        </div>
      </section>

      {/* ─── 전자세금계산서 (바로빌) ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">전자세금계산서 (바로빌)</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={txForm!.enabled}
              onChange={(e) => setTxForm({ ...txForm!, enabled: e.target.checked })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="CERTKEY (바로빌 API 인증키)" colSpan={2}>
            <input
              type="text"
              value={txForm!.certkey}
              onChange={(e) => setTxForm({ ...txForm!, certkey: e.target.value })}
              className={input + " font-mono"}
            />
          </Field>
          <Field label="CORPNUM (자사 사업자번호)">
            <input
              value={txForm!.corpnum}
              onChange={(e) => setTxForm({ ...txForm!, corpnum: e.target.value.replace(/[^0-9-]/g, "") })}
              placeholder="1234567890"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="UserID (바로빌 가입 ID)">
            <input
              value={txForm!.user_id}
              onChange={(e) => setTxForm({ ...txForm!, user_id: e.target.value })}
              className={input + " font-mono"}
            />
          </Field>
          <Field label="환경">
            <select
              value={txForm!.environment}
              onChange={(e) => setTxForm({ ...txForm!, environment: e.target.value })}
              className={input}
            >
              <option value="production">운영</option>
              <option value="test">테스트</option>
            </select>
          </Field>
          <Field label="PDF 자동 다운로드">
            <label className="inline-flex items-center gap-1 text-sm h-9">
              <input
                type="checkbox"
                checked={txForm!.download_pdf}
                onChange={(e) => setTxForm({ ...txForm!, download_pdf: e.target.checked })}
              />
              활성
            </label>
          </Field>
          <Field label="자동 수집" colSpan={2}>
            <div className="flex items-center gap-2 text-sm">
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={txForm!.auto_fetch.enabled}
                  onChange={(e) => setTxForm({ ...txForm!, auto_fetch: { ...txForm!.auto_fetch, enabled: e.target.checked } })}
                />
                매일
              </label>
              <input
                type="number" min={0} max={23}
                value={txForm!.auto_fetch.hour}
                onChange={(e) => setTxForm({ ...txForm!, auto_fetch: { ...txForm!.auto_fetch, hour: Number(e.target.value) } })}
                className="h-9 w-16 rounded-md border border-input bg-background px-2"
              />
              <span>:</span>
              <input
                type="number" min={0} max={59}
                value={txForm!.auto_fetch.minute}
                onChange={(e) => setTxForm({ ...txForm!, auto_fetch: { ...txForm!.auto_fetch, minute: Number(e.target.value) } })}
                className="h-9 w-16 rounded-md border border-input bg-background px-2"
              />
              <span className="text-muted-foreground">새벽에 지난</span>
              <input
                type="number" min={1} max={30}
                value={txForm!.auto_fetch.catchup_days}
                onChange={(e) => setTxForm({ ...txForm!, auto_fetch: { ...txForm!.auto_fetch, catchup_days: Number(e.target.value) } })}
                className="h-9 w-16 rounded-md border border-input bg-background px-2"
              />
              <span className="text-muted-foreground">일치 재조회 (지연 등록 대응)</span>
            </div>
          </Field>
        </div>
      </section>

      {/* ECOS / FRED 는 SUPER_ADMIN 영역으로 이동 (시스템 공통). */}

      {/* ─── Kakao Map API ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Kakao Map API</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={kmForm!.enabled}
              onChange={(e) => setKmForm({ ...kmForm!, enabled: e.target.checked })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Field label="JavaScript Key">
            <input
              type="text"
              value={kmForm!.javascript_key}
              onChange={(e) => setKmForm({ ...kmForm!, javascript_key: e.target.value })}
              placeholder="카카오 JavaScript Key"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="Kakao SDK 버전">
            <input
              type="text"
              value={kmForm!.sdk_version}
              onChange={(e) =>
                setKmForm({ ...kmForm!, sdk_version: e.target.value })
              }
              placeholder="2.8.1"
              pattern="^\d+\.\d+\.\d+$"
              className={input + " font-mono"}
            />
            <span className="text-[11px] text-muted-foreground">
              X.X.X 형식. 비우거나 형식이 맞지 않으면 저장이 거부됩니다.
            </span>
          </Field>
          <Field label="Kakao SDK Integrity">
            <input
              type="text"
              value={kmForm!.integrity}
              onChange={(e) =>
                setKmForm({ ...kmForm!, integrity: e.target.value })
              }
              placeholder="sha384-..."
              className={input + " font-mono"}
            />
            <span className="text-[11px] text-muted-foreground">
              SDK 버전마다 값이 다른 SRI 해시 (예: sha384-…). 활성화 시 필수.
              버전을 바꾸면 반드시 같이 갱신하세요. Kakao Developers 의 SDK
              가이드 페이지에서 버전과 함께 제공됩니다.
            </span>
          </Field>
          <Field label="안내">
            <div className="text-[11px] text-muted-foreground space-y-1">
              <div>저장된 키가 평문 그대로 표시됩니다. 노출에 유의.</div>
              <div>
                활용: 근무지 등록 시 주소 → 좌표 지오코딩 + 미니 지도 미리보기.
              </div>
              <div className="font-medium pt-1">생성 방법</div>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>
                  카카오 개발자사이트 (
                  <a
                    href="https://developers.kakao.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    https://developers.kakao.com
                  </a>
                  ) 접속
                </li>
                <li>개발자 등록 및 앱 생성</li>
                <li>
                  [앱] {">"} [앱 설정] {">"} [앱] {">"} [플랫폼 키] 에서 이용할
                  JavaScript Key를 선택 합니다.
                </li>
              </ol>
            </div>
          </Field>
        </div>
      </section>

      {/* ─── Google Map JavaScript API ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Google Map JavaScript API</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={gmForm!.enabled}
              onChange={(e) => setGmForm({ ...gmForm!, enabled: e.target.checked })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Field label="JavaScript API Key">
            <input
              type="text"
              value={gmForm!.javascript_key}
              onChange={(e) => setGmForm({ ...gmForm!, javascript_key: e.target.value })}
              placeholder="AIzaSy..."
              className={input + " font-mono"}
            />
          </Field>
          <Field label="안내">
            <div className="text-[11px] text-muted-foreground space-y-1">
              <div>저장된 키는 평문 그대로 표시됩니다 (요청에 따라 마스킹 X).</div>
              <div>
                활용: 워크샵·컨퍼런스 등록 시 주소 → 좌표 지오코딩 + 미니 지도
                미리보기 (Kakao Map 과 병렬 운영, 다이얼로그에서 토글).
              </div>
              <div className="font-medium pt-1">생성 방법</div>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>
                  Google Cloud Console (
                  <a
                    href="https://console.cloud.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    https://console.cloud.google.com
                  </a>
                  ) 접속
                </li>
                <li>프로젝트 생성 → APIs & Services → Library</li>
                <li>"Maps JavaScript API" 활성화</li>
                <li>Credentials → Create credentials → API key</li>
                <li>도메인 제한(권장) 설정</li>
              </ol>
            </div>
          </Field>
        </div>
      </section>

      {/* ─── NHN Cloud SMS ─── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">NHN Cloud SMS</h3>
          <label className="inline-flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={npForm!.enabled}
              onChange={(e) => setNpForm({ ...npForm!, enabled: e.target.checked })}
            />
            활성
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Field label="URL (NHN Cloud SMS 엔드포인트)">
            <input
              type="text"
              value={npForm!.url}
              onChange={(e) => setNpForm({ ...npForm!, url: e.target.value })}
              placeholder="https://sms.api.nhncloudservice.com"
              className={input + " font-mono"}
            />
            <HelperText>기본값: https://sms.api.nhncloudservice.com</HelperText>
          </Field>
          <Field label="AppKey">
            <input
              type="text"
              value={npForm!.app_key}
              onChange={(e) => setNpForm({ ...npForm!, app_key: e.target.value })}
              placeholder="NHN Cloud SMS 콘솔의 AppKey"
              className={input + " font-mono"}
            />
          </Field>
          <Field label="SecretKey">
            <input
              type="text"
              value={npForm!.secret_key}
              onChange={(e) => setNpForm({ ...npForm!, secret_key: e.target.value })}
              placeholder="NHN Cloud SMS 콘솔의 SecretKey"
              className={input + " font-mono"}
            />
          </Field>
          <HelperText>
            저장된 값은 평문으로 표시됩니다 (요청에 따라 마스킹 없음). NHN Cloud
            콘솔 → Notification → SMS → AppKey/SecretKey 발급 후 입력하세요.
          </HelperText>
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

function HelperText({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-muted-foreground">{children}</span>;
}
