"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

type ToastKind = "ok" | "err" | "info";

type ToastItem = { id: number; message: ReactNode; kind: ToastKind };

type ToastOptions = {
  // 자동 사라짐까지 ms. 0 이면 클릭 전까지 유지. 생략 시 kind 별 기본값.
  duration?: number;
};

type ToastApi = {
  // 성공(초록): 저장됨 등. 실패(빨강): 에러 메시지. info(중립): 일반 안내.
  success: (message: ReactNode, opts?: ToastOptions) => void;
  error: (message: ReactNode, opts?: ToastOptions) => void;
  info: (message: ReactNode, opts?: ToastOptions) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

// 실패는 읽을 시간을 더 주고, 성공/안내는 짧게.
const DEFAULT_DURATION: Record<ToastKind, number> = { ok: 2000, info: 2500, err: 4000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: ReactNode, kind: ToastKind, opts?: ToastOptions) => {
      const id = ++idRef.current;
      setItems((list) => [...list, { id, message, kind }]);
      const duration = opts?.duration ?? DEFAULT_DURATION[kind];
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, opts) => show(message, "ok", opts),
      error: (message, opts) => show(message, "err", opts),
      info: (message, opts) => show(message, "info", opts),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            aria-live="polite"
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto max-w-sm rounded-md px-4 py-2.5 text-sm shadow-lg cursor-pointer ${
              t.kind === "ok"
                ? "bg-emerald-600 text-white"
                : t.kind === "err"
                  ? "bg-red-600 text-white"
                  : "bg-foreground text-background"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
