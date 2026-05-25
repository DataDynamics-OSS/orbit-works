"use client";

/**
 * 우하단 floating chat — 모든 dashboard 페이지에서 노출.
 *
 * 1. assistant.enabled=false 면 자체 비표시.
 * 2. 버튼 클릭으로 패널 토글. 패널은 absolute, viewport 안 480x640.
 * 3. SSE 스트리밍은 useAssistantStream 훅. 메시지 / 도구 호출 카드 / 에러 셀
 *    렌더링은 ChatPanel 에 위임.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, X, Sparkles } from "lucide-react";
import { fetchSection } from "@/components/settings/settings-api";
import { ChatPanel } from "./ChatPanel";

const PROVIDER_DOT: Record<string, string> = {
  gemini: "bg-sky-500",
  claude: "bg-amber-500",
  openai: "bg-emerald-500",
};
const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  claude: "Claude",
  openai: "OpenAI",
};

type AssistantSettings = {
  enabled: boolean;
  default_provider: string;
};

export function FloatingChat() {
  const [open, setOpen] = useState(false);

  // settings 는 ADMIN 만 GET 가능 — 일반 사용자에겐 별도 minimal endpoint 필요할 수 있으나
  // 1차 출시에서는 GET 실패 시 floating chat 비표시로 처리 (즉 ADMIN 만 사용).
  const { data: cfg } = useQuery<AssistantSettings | null>({
    queryKey: ["settings", "assistant", "floating"],
    queryFn: async () => {
      try {
        return await fetchSection<AssistantSettings>("assistant");
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ESC 로 닫기.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!cfg?.enabled) return null;

  const providerKey = (cfg.default_provider ?? "gemini").toLowerCase();
  const providerDot = PROVIDER_DOT[providerKey] ?? "bg-slate-400";
  const providerLabel = PROVIDER_LABEL[providerKey] ?? cfg.default_provider;

  return (
    <>
      {open && (
        <div
          className="fixed bottom-20 right-4 z-50 w-[480px] max-w-[calc(100vw-2rem)] h-[720px] max-h-[calc(100vh-6rem)] rounded-xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden
            motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
        >
          <div className="flex items-center justify-between px-3 h-12 border-b border-border bg-gradient-to-r from-sky-50 to-violet-50 dark:from-sky-950/30 dark:to-violet-950/30">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-7 w-7 shrink-0 rounded-lg bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center text-white shadow-sm">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold leading-tight truncate">AI 어시스턴트</span>
                <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                  <span className={"h-1.5 w-1.5 rounded-full " + providerDot} />
                  <span>{providerLabel}</span>
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted/60"
              aria-label="close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <ChatPanel />
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="AI 어시스턴트"
        className="fixed bottom-4 right-4 z-50 h-12 w-12 inline-flex items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-violet-600 text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all"
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </button>
    </>
  );
}
