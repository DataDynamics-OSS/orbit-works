"use client";

/**
 * 외부 연동 — AI 어시스턴트 (Gemini / Claude / OpenAI).
 *
 * provider 별 API key + 기본 모델을 저장. 키는 백엔드에서 Fernet 암호화되어
 * DB 에 저장되고, 응답에는 항상 `***ENCRYPTED` 마스킹값으로 돌아온다. 평문
 * 표시는 reveal API 로만. 패턴은 CloudCostTab 과 동일.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Save } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";
import { api } from "@/lib/api";

type Provider = { enabled: boolean; api_key: string; model: string; base_url?: string };
type AssistantFull = {
  enabled: boolean;
  default_provider: "gemini" | "claude" | "openai";
  max_turns: number;
  rate_limit_per_minute: number;
  persist_conversations: boolean;
  gemini: Provider;
  claude: Provider;
  openai: Provider;
};

export function AssistantTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: cfg } = useQuery<AssistantFull>({
    queryKey: ["settings", "assistant"],
    queryFn: () => fetchSection("assistant"),
  });

  const [form, setForm] = useState<AssistantFull | null>(null);
  const [saved, setSaved] = useState(false);
  const [show, setShow] = useState<{ gemini: boolean; claude: boolean; openai: boolean }>({
    gemini: false,
    claude: false,
    openai: false,
  });

  useEffect(() => {
    if (cfg) setForm(cfg);
  }, [cfg]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form) return;
      await saveSection("assistant", form);
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

  async function reveal(prov: "gemini" | "claude" | "openai") {
    try {
      const { data } = await api.get(`/settings/assistant/reveal/${prov}.api_key`);
      setForm((f) => (f ? { ...f, [prov]: { ...f[prov], api_key: data.value } } as AssistantFull : f));
      setShow((s) => ({ ...s, [prov]: true }));
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
          <h3 className="text-sm font-semibold">AI 어시스턴트 — 공통</h3>
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
          활성화하면 모든 페이지 우하단에 floating chat 이 표시됩니다. 어시스턴트는
          미리 정의된 도구(클라우드 비용 요약·예측 등)만 호출하므로 SQL 직접 실행이나
          데이터 조작은 일어나지 않습니다.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="기본 provider">
            <select
              value={form.default_provider}
              onChange={(e) => setForm({ ...form, default_provider: e.target.value as any })}
              className={input}
            >
              <option value="gemini">Gemini</option>
              <option value="claude">Claude</option>
              <option value="openai">OpenAI</option>
            </select>
          </Field>
          <Field label="최대 turn 수 (1~15)">
            <input
              type="number" min={1} max={15}
              value={form.max_turns}
              onChange={(e) => setForm({ ...form, max_turns: Number(e.target.value) || 5 })}
              className={input}
            />
          </Field>
          <Field label="분당 호출 한도 (0=무제한)">
            <input
              type="number" min={0} max={1000}
              value={form.rate_limit_per_minute}
              onChange={(e) => setForm({ ...form, rate_limit_per_minute: Number(e.target.value) || 0 })}
              className={input}
            />
          </Field>
          <Field label="대화 영속화">
            <label className="inline-flex items-center gap-2 text-xs h-9">
              <input
                type="checkbox"
                checked={form.persist_conversations}
                onChange={(e) => setForm({ ...form, persist_conversations: e.target.checked })}
              />
              DB 에 대화 기록 저장 (해제 시 휘발 메모리)
            </label>
          </Field>
        </div>
      </section>

      <ProviderCard
        title="Gemini — Google"
        sub="기본 모델 예: gemini-2.5-flash, gemini-2.5-pro"
        getKeyHelp={
          <>
            키 발급:{" "}
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline text-primary">
              aistudio.google.com
            </a>
          </>
        }
        prov={form.gemini}
        onChange={(v) => setForm({ ...form, gemini: v })}
        shown={show.gemini}
        onReveal={() => reveal("gemini")}
        onHide={() => setShow((s) => ({ ...s, gemini: false }))}
        input={input}
      />

      <ProviderCard
        title="Claude — Anthropic"
        sub="기본 모델 예: claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5"
        getKeyHelp={
          <>
            키 발급:{" "}
            <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer" className="underline text-primary">
              console.anthropic.com
            </a>{" "}
            (prompt caching 자동 적용)
          </>
        }
        prov={form.claude}
        onChange={(v) => setForm({ ...form, claude: v })}
        shown={show.claude}
        onReveal={() => reveal("claude")}
        onHide={() => setShow((s) => ({ ...s, claude: false }))}
        input={input}
      />

      <ProviderCard
        title="OpenAI / OpenAI 호환 (Ollama · vLLM · LM Studio)"
        sub="기본 모델 예: gpt-4o-mini, gpt-4o · 또는 사내 LLM 서버의 모델 ID"
        getKeyHelp={
          <>
            OpenAI 키 발급:{" "}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline text-primary">
              platform.openai.com
            </a>
            {" · "}Base URL 비워두면 OpenAI 공식 API
          </>
        }
        prov={form.openai}
        onChange={(v) => setForm({ ...form, openai: v })}
        shown={show.openai}
        onReveal={() => reveal("openai")}
        onHide={() => setShow((s) => ({ ...s, openai: false }))}
        input={input}
        showBaseUrl
        extraHelp={<OpenAICompatHelp />}
      />

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

function ProviderCard({
  title, sub, getKeyHelp, prov, onChange, shown, onReveal, onHide, input,
  showBaseUrl, extraHelp,
}: {
  title: string;
  sub: string;
  getKeyHelp: React.ReactNode;
  prov: Provider;
  onChange: (v: Provider) => void;
  shown: boolean;
  onReveal: () => void;
  onHide: () => void;
  input: string;
  showBaseUrl?: boolean;
  extraHelp?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <label className="inline-flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={prov.enabled}
            onChange={(e) => onChange({ ...prov, enabled: e.target.checked })}
          />
          활성
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {sub} · {getKeyHelp}
      </p>
      {showBaseUrl && (
        <Field label="Base URL (선택 — 비우면 OpenAI 공식)" colSpan={2}>
          <input
            value={prov.base_url ?? ""}
            placeholder="예: http://host.docker.internal:11434/v1 (Ollama)"
            onChange={(e) => onChange({ ...prov, base_url: e.target.value })}
            className={input + " font-mono"}
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="API Key">
          <div className="flex gap-1">
            <input
              value={prov.api_key}
              onChange={(e) => onChange({ ...prov, api_key: e.target.value })}
              className={input + " font-mono"}
            />
            <button
              type="button"
              onClick={shown ? onHide : onReveal}
              title={shown ? "다시 마스킹" : "평문 표시"}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted shrink-0"
            >
              {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </Field>
        <Field label="Model">
          <input
            value={prov.model}
            onChange={(e) => onChange({ ...prov, model: e.target.value })}
            className={input + " font-mono"}
          />
        </Field>
      </div>
      {extraHelp}
    </section>
  );
}

function OpenAICompatHelp() {
  return (
    <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px]">
      <summary className="cursor-pointer text-xs font-semibold text-foreground">
        OpenAI 호환 endpoint 사용법 (Ollama · vLLM · LM Studio)
      </summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <p>
          Base URL 을 비우면 OpenAI 공식 API 를 그대로 사용. 사내 LLM 서버를 쓰려면 아래
          예시처럼 OpenAI 호환 endpoint 를 입력하세요.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border text-foreground">
                <th className="text-left py-1 pr-3 font-semibold">서버</th>
                <th className="text-left py-1 pr-3 font-semibold">Base URL 예시</th>
                <th className="text-left py-1 pr-3 font-semibold">API Key</th>
                <th className="text-left py-1 font-semibold">Model 예시</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              <tr className="border-b border-border/50">
                <td className="py-1 pr-3">Ollama</td>
                <td className="py-1 pr-3">http://host.docker.internal:11434/v1</td>
                <td className="py-1 pr-3">ollama (임의 문자열)</td>
                <td className="py-1">llama3.1:8b, qwen2.5:14b</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-1 pr-3">vLLM</td>
                <td className="py-1 pr-3">http://&lt;vllm-host&gt;:8000/v1</td>
                <td className="py-1 pr-3">--api-key 값 (없으면 EMPTY)</td>
                <td className="py-1">서빙 중인 모델 ID</td>
              </tr>
              <tr>
                <td className="py-1 pr-3">LM Studio</td>
                <td className="py-1 pr-3">http://&lt;lmstudio-host&gt;:1234/v1</td>
                <td className="py-1 pr-3">lm-studio (임의 문자열)</td>
                <td className="py-1">로드된 모델 식별자</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>
            백엔드 컨테이너에서 <span className="font-mono">닿을 수 있는</span> 주소여야 합니다.
            호스트의 Ollama 를 쓰려면 docker-compose 의 backend 에
            {" "}<span className="font-mono">extra_hosts: ["host.docker.internal:host-gateway"]</span>{" "}
            추가가 필요할 수 있습니다.
          </li>
          <li>
            Tool calling 품질은 모델별 편차가 큽니다. 클라우드 비용 도구를 안정적으로 호출하려면
            {" "}<strong>Llama 3.1+ / Qwen2.5+</strong> 권장. 7B 미만 모델은 도구 호출 실패율이 높습니다.
          </li>
          <li>
            Streaming · usage(token) 정보는 서버가 OpenAI 스펙을 얼마나 충실히 구현하느냐에 달려 있습니다.
            일부 서버는 <span className="font-mono">cached_tokens</span> 가 항상 0 으로 보고됩니다.
          </li>
          <li>
            API Key 가 빈 값이고 Base URL 이 설정되어 있으면 백엔드가 자동으로
            {" "}<span className="font-mono">"ollama"</span>{" "}placeholder 를 사용합니다.
          </li>
        </ul>
      </div>
    </details>
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
