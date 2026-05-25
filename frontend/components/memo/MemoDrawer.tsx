"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Save, X } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useMemoDrawer } from "./MemoProvider";

type MemoOut = { memo: string; updated_at: string | null };

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function MemoDrawer() {
  const { isOpen, close } = useMemoDrawer();
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data, isFetching } = useQuery<MemoOut>({
    queryKey: ["me-memo"],
    queryFn: async () => (await api.get("/auth/me/memo")).data,
    enabled: isOpen,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  // drawer 를 열 때마다 서버 값을 로컬 state 로 대체 (last-writer-wins).
  useEffect(() => {
    if (data) {
      setContent(data.memo ?? "");
      setLastSavedAt(data.updated_at ?? null);
      setDirty(false);
    }
  }, [data]);

  const saveM = useMutation({
    mutationFn: async (memo: string) =>
      (await api.patch("/auth/me/memo", { memo })).data as MemoOut,
    onSuccess: (res) => {
      setLastSavedAt(res.updated_at ?? null);
      setDirty(false);
      qc.setQueryData(["me-memo"], res);
    },
  });

  // dirty/content 의 최신값을 effect 의 cleanup·이벤트 핸들러에서 읽으려면 ref 필요.
  // (state 직접 참조하면 effect 가 등록한 시점의 stale 값이 잡힘.)
  const dirtyRef = useRef(false);
  const contentRef = useRef("");
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { contentRef.current = content; }, [content]);

  // 일반 flush — Ctrl+S, 닫기 버튼 등 정상 흐름. dirty 가 아니면 noop.
  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    try {
      await saveM.mutateAsync(contentRef.current);
    } catch {
      // 에러는 saveM 상태로 표시. 호출자가 await 했어도 throw 안 함 (UX 부드럽게).
    }
  }, [saveM]);

  // 페이지 unload 흐름 전용 — fetch keepalive 로 백그라운드 전송.
  // 브라우저 탭 닫힘·새로고침·다른 사이트로 이동 등 unload 직전에도 요청이 끊기지 않게.
  const flushKeepalive = useCallback(() => {
    if (!dirtyRef.current) return;
    const token = getToken();
    if (!token) return;
    try {
      fetch("/api/v1/auth/me/memo", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ memo: contentRef.current }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // unload 컨텍스트라 거의 검출 안 됨 — 무시.
    }
  }, []);

  // Esc 로 닫기 직전, 외부에서 close() 가 불려도 동일하게 flush 가 동작하도록
  // isOpen transition 감지로 처리. (Esc / X 클릭 / Ctrl+M 토글 모두 커버.)
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      // 방금 닫힘 — 마지막 변경분 flush.
      flush();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, flush]);

  // 키보드 — Esc 닫기, Ctrl/Cmd+S 즉시 저장.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // close() 호출 → 위 transition effect 가 flush 수행.
        close();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush();
      }
    };
    window.addEventListener("keydown", onKey);
    // 다음 프레임에 포커스 (드로워 애니메이션과 겹치지 않게).
    const t = setTimeout(() => textareaRef.current?.focus(), 220);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [isOpen, close, flush]);

  // 페이지 이탈/탭 숨김 시 저장 (드로워가 열려 있는 동안만 등록).
  // - visibilitychange: 탭 백그라운드로 전환 시 (가장 흔한 케이스).
  // - pagehide: BFCache 진입 / iOS Safari 등.
  // - beforeunload: 새로고침·창 닫기. dirty 면 추가로 사용자 확인 prompt.
  useEffect(() => {
    if (!isOpen) return;
    const onVisibility = () => {
      if (document.hidden) flushKeepalive();
    };
    const onPageHide = () => flushKeepalive();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        flushKeepalive();
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isOpen, flushKeepalive]);

  const statusLabel = saveM.isPending
    ? "저장 중..."
    : dirty
      ? "수정됨"
      : lastSavedAt
        ? `저장됨 ${fmtTime(lastSavedAt)}`
        : isFetching
          ? "불러오는 중..."
          : "";

  function insertTimestamp() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    // 로컬 타임존 기준 [YYYY-MM-DD hh:mm:ss] — toISOString 은 UTC 라 의도와 다름.
    const stamp =
      `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] `;
    const ta = textareaRef.current;
    if (!ta) {
      setContent((c) => stamp + c);
      setDirty(true);
      return;
    }
    const start = ta.selectionStart ?? content.length;
    const end = ta.selectionEnd ?? content.length;
    const next = content.slice(0, start) + stamp + content.slice(end);
    setContent(next);
    setDirty(true);
    // 커서를 삽입 뒤로 이동.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + stamp.length, start + stamp.length);
    });
  }

  return (
    <div
      className={
        "fixed top-0 right-0 h-full z-40 transition-transform duration-200 ease-out " +
        (isOpen ? "translate-x-0" : "translate-x-full pointer-events-none")
      }
      aria-hidden={!isOpen}
      style={{ width: 380 }}
    >
      <div className="h-full flex flex-col bg-card border-l border-border shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">메모장</h2>
            <span className="text-[11px] text-muted-foreground">
              {statusLabel}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => flush()}
              disabled={!dirty || saveM.isPending}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              저장
            </button>
            <button
              type="button"
              onClick={insertTimestamp}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted"
            >
              <Clock className="h-3.5 w-3.5" />
              현재 시간 삽입
            </button>
            <button
              type="button"
              onClick={close}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
              aria-label="닫기"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          placeholder="여기에 메모를 작성하세요. 메모작성후 저장 버튼을 누르세요."
          className="flex-1 w-full resize-none bg-transparent p-4 text-sm leading-relaxed outline-none font-[family-name:var(--font-roboto-condensed)]"
          spellCheck={false}
        />
        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
          <span>{content.length.toLocaleString("ko-KR")}자</span>
          <span>Ctrl+S 저장 · Ctrl+M 토글 · Esc 닫기</span>
        </div>
      </div>
    </div>
  );
}
