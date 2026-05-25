"use client";

/**
 * 어시스턴트 chat 패널 — FloatingChat 안에 마운트.
 *
 * 시각 정책:
 * - user 메시지: 우측 정렬, primary 색 버블 + User 아이콘
 * - assistant: 좌측, Sparkles 아이콘 + markdown 본문 + 도구 카드(ToolResultCard)
 * - error    : 좌측, 빨강 박스
 * - 스트리밍 중인 마지막 assistant 메시지는 끝에 깜빡이는 caret 표시
 * - 신규 turn 진입 시 fade+slide 애니메이션 (motion-safe)
 *
 * 도구 결과는 항상 ToolResultCard 가 처리 — 등록된 도구는 전용 카드, 그 외는
 * raw JSON fallback. 모든 도구가 성공/진행/실패 3 상태를 통일된 좌측 보더 색으로 표시.
 */

import { useEffect, useRef, useState } from "react";
import { Send, RotateCcw, Square, Sparkles, User as UserIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { useAssistantStream, type ChatTurn } from "./useAssistantStream";
import { ToolResultCard } from "./cards/ToolResultCard";

const SUGGESTIONS = [
  "이번달 클라우드 비용의 예상 금액을 알려줘",
  "지난 30일 AWS 비용 상위 5개 서비스",
  "최근 30일 비용 알림 이벤트",
  "GCP 비용 수집이 정상이야?",
  "지난달 대비 이번달 비용 추이는?",
];

export function ChatPanel() {
  const { turns, streaming, send, abort, reset } = useAssistantStream();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns]);

  function submit() {
    const v = input.trim();
    if (!v || streaming) return;
    setInput("");
    void send(v);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-3 space-y-3">
        {turns.length === 0 && <EmptyState onPick={(s) => setInput(s)} />}
        {turns.map((t, i) => (
          <Turn
            key={i}
            turn={t}
            streaming={streaming && i === turns.length - 1}
          />
        ))}
      </div>

      {/* follow-up 추천 — 첫 응답 이후에도 자주 쓰는 후속 질문을 가로 스크롤로. */}
      {turns.length > 0 && !streaming && (
        <div className="px-2 pt-1.5 pb-0.5 border-t border-border/60 bg-muted/20">
          <div className="flex gap-1 overflow-x-auto scrollbar-thin no-scrollbar">
            {["자세히 설명해줘", "다른 달은 어때?", "표로 정리해줘", "차트로 보여줘"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { setInput(s); }}
                className="shrink-0 rounded-full border border-border bg-background px-2.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border bg-muted/30 px-2 py-2 flex items-end gap-1.5">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="메시지를 입력 (Shift+Enter 줄바꿈)"
          className="flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          disabled={streaming}
        />
        <div className="flex flex-col gap-1">
          {streaming ? (
            <button
              type="button"
              onClick={abort}
              title="중단"
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              title="전송"
              disabled={!input.trim()}
              className="h-8 w-8 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={reset}
            title="새 대화"
            disabled={streaming}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Turn 렌더링
 * -------------------------------------------------------------------------- */

function Turn({ turn, streaming }: { turn: ChatTurn; streaming: boolean }) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
        <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3 py-1.5 text-sm max-w-[85%] whitespace-pre-wrap break-words">
          {turn.text}
        </div>
        <Avatar role="user" />
      </div>
    );
  }

  if (turn.kind === "error") {
    return (
      <div className="flex gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
        <Avatar role="assistant" />
        <div className="rounded-md border border-rose-300 dark:border-rose-700 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {turn.text}
        </div>
      </div>
    );
  }

  // assistant
  const hasTools = (turn.tool_calls ?? []).length > 0;
  const hasText = !!turn.text;

  return (
    <div className="flex gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
      <Avatar role="assistant" />
      <div className="flex-1 min-w-0 space-y-1.5">
        {(turn.tool_calls ?? []).map((tc) => (
          <ToolResultCard
            key={tc.id}
            name={tc.name}
            args={tc.args}
            result={tc.result}
          />
        ))}

        {hasText && (
          <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none break-words
            prose-p:my-1 prose-headings:my-1.5 prose-li:my-0
            prose-table:text-[11px] prose-table:my-1 prose-th:py-1 prose-td:py-0.5
            prose-code:text-[11px] prose-code:bg-background/60 prose-code:px-1 prose-code:rounded
            prose-pre:bg-background/60 prose-pre:text-[11px] prose-pre:my-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {turn.text + (streaming ? "▍" : "")}
            </ReactMarkdown>
          </div>
        )}

        {!hasText && !hasTools && streaming && (
          <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2 text-xs text-muted-foreground inline-flex items-center gap-1">
            <DotsLoading />
            <span>생각 중</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * 보조 컴포넌트
 * -------------------------------------------------------------------------- */

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "user") {
    return (
      <div className="h-7 w-7 shrink-0 rounded-full bg-muted flex items-center justify-center text-muted-foreground border border-border">
        <UserIcon className="h-3.5 w-3.5" />
      </div>
    );
  }
  return (
    <div className="h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center text-white shadow-sm">
      <Sparkles className="h-3.5 w-3.5" />
    </div>
  );
}

function DotsLoading() {
  return (
    <span className="inline-flex gap-0.5 items-center">
      <span className="h-1 w-1 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce [animation-delay:-0.3s]" />
      <span className="h-1 w-1 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce [animation-delay:-0.15s]" />
      <span className="h-1 w-1 rounded-full bg-muted-foreground/60 motion-safe:animate-bounce" />
    </span>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-2 py-6 space-y-3">
      <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center text-white shadow-md">
        <Sparkles className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-semibold">무엇을 도와드릴까요?</div>
        <div className="text-[11px] text-muted-foreground max-w-[280px]">
          자연어로 질문하세요. 클라우드 비용·예측·알림은 도구로 정확한 데이터를 가져옵니다.
        </div>
      </div>
      <div className="grid gap-1.5 w-full pt-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="text-left text-xs rounded-lg border border-border bg-background px-3 py-2 hover:bg-muted hover:border-foreground/20 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
