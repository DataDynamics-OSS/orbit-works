"use client";

/**
 * SSE 스트리밍 chat 훅.
 *
 * `/api/v1/assistant/chat` 은 fetch + ReadableStream 으로 소비. EventSource 는
 * POST 와 Authorization 헤더가 안 돼서 사용 불가. 한 줄(`data: {...}`) 이 한 이벤트.
 *
 * 이벤트 타입:
 * - text_delta : assistant 한국어 응답 점진 누적
 * - tool_call  : 모델이 도구 호출 결정 → UI 에 "도구 실행 중" 카드 표시
 * - tool_result: 도구 실행 결과 (요약된 JSON)
 * - usage      : 토큰 사용량 / 또는 conversation_id 메타데이터
 * - done       : 정상 종료
 * - error      : reason 으로 사용자에 표시
 */

import { useCallback, useRef, useState } from "react";
import { getToken } from "@/lib/api";

export type StreamEvent =
  | { type: "text_delta"; data: { text: string } }
  | { type: "tool_call"; data: { id: string; name: string; args: any } }
  | { type: "tool_result"; data: { id: string; name: string; result: any } }
  | { type: "usage"; data: { tokens_in?: number; tokens_out?: number; cached_tokens?: number; conversation_id?: string } }
  | { type: "done"; data: {} }
  | { type: "error"; data: { reason: string } };

export type ChatTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; tool_calls?: { id: string; name: string; args: any; result?: any }[] }
  | { kind: "error"; text: string };

export function useAssistantStream() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (message: string, opts?: { provider?: string }) => {
      if (!message.trim() || streaming) return;
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      setTurns((t) => [
        ...t,
        { kind: "user", text: message },
        { kind: "assistant", text: "", tool_calls: [] },
      ]);

      const token = getToken();
      try {
        const resp = await fetch("/api/v1/assistant/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: token ? `Bearer ${token}` : "",
          },
          body: JSON.stringify({
            message,
            conversation_id: conversationId,
            provider: opts?.provider,
          }),
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) {
          const err = await resp.text().catch(() => "스트림 시작 실패");
          setTurns((t) => replaceLast(t, { kind: "error", text: err.slice(0, 400) }));
          setStreaming(false);
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // SSE 한 메시지 = 빈 줄로 끝남.
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const ev: StreamEvent = JSON.parse(line.slice(6));
              setTurns((prev) => applyEvent(prev, ev));
              if (ev.type === "usage" && ev.data.conversation_id) {
                setConversationId(ev.data.conversation_id);
              }
              if (ev.type === "done" || ev.type === "error") {
                setStreaming(false);
              }
            } catch {
              // ignore malformed line
            }
          }
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          setTurns((t) => replaceLast(t, { kind: "error", text: String(e?.message ?? e) }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [conversationId, streaming],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    setStreaming(false);
    setConversationId(null);
  }, []);

  return { turns, streaming, conversationId, send, abort, reset };
}

function replaceLast(turns: ChatTurn[], replacement: ChatTurn): ChatTurn[] {
  if (!turns.length) return [replacement];
  return [...turns.slice(0, -1), replacement];
}

function applyEvent(prev: ChatTurn[], ev: StreamEvent): ChatTurn[] {
  if (!prev.length) return prev;
  const last = prev[prev.length - 1];
  if (ev.type === "text_delta" && last.kind === "assistant") {
    return [...prev.slice(0, -1), { ...last, text: last.text + ev.data.text }];
  }
  if (ev.type === "tool_call" && last.kind === "assistant") {
    return [
      ...prev.slice(0, -1),
      {
        ...last,
        tool_calls: [...(last.tool_calls ?? []), {
          id: ev.data.id, name: ev.data.name, args: ev.data.args,
        }],
      },
    ];
  }
  if (ev.type === "tool_result" && last.kind === "assistant") {
    const calls = (last.tool_calls ?? []).map((c) =>
      c.id === ev.data.id ? { ...c, result: ev.data.result } : c,
    );
    return [...prev.slice(0, -1), { ...last, tool_calls: calls }];
  }
  if (ev.type === "error") {
    return [...prev.slice(0, -1), { kind: "error", text: ev.data.reason }];
  }
  return prev;
}
