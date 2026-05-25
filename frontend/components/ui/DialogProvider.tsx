"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog } from "./Dialog";

type ConfirmOptions = {
  title?: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  // "destructive" tints the primary button red for irreversible actions
  // (delete, reset, etc). Defaults to false.
  destructive?: boolean;
};

type AlertOptions = {
  title?: string;
  message?: ReactNode;
  confirmText?: string;
};

type PromptOptions = {
  title?: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
};

type DialogApi = {
  confirm: (msg: ReactNode, opts?: ConfirmOptions) => Promise<boolean>;
  alert: (msg: ReactNode, opts?: AlertOptions) => Promise<void>;
  prompt: (msg: ReactNode, opts?: PromptOptions) => Promise<string | null>;
};

const DialogContext = createContext<DialogApi | null>(null);

type Kind = "confirm" | "alert" | "prompt";

type Request = {
  id: number;
  kind: Kind;
  title: string;
  message: ReactNode;
  confirmText: string;
  cancelText?: string;
  destructive: boolean;
  defaultValue?: string;
  placeholder?: string;
  resolve: (value: boolean | string | null) => void;
};

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);
  const idRef = useRef(0);
  const current = queue[0];
  const [promptValue, setPromptValue] = useState("");

  // Reset prompt value whenever a new request becomes current.
  useEffect(() => {
    if (current?.kind === "prompt") {
      setPromptValue(current.defaultValue ?? "");
    }
  }, [current?.id, current?.kind, current?.defaultValue]);

  const push = useCallback(
    (req: Omit<Request, "id" | "resolve">): Promise<boolean | string | null> => {
      return new Promise((resolve) => {
        const id = ++idRef.current;
        setQueue((q) => [...q, { ...req, id, resolve }]);
      });
    },
    [],
  );

  const settle = useCallback(
    (value: boolean | string | null) => {
      setQueue((q) => {
        if (q.length === 0) return q;
        const [head, ...rest] = q;
        head.resolve(value);
        return rest;
      });
    },
    [],
  );

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (msg, opts) =>
        push({
          kind: "confirm",
          title: opts?.title ?? "확인",
          message: opts?.message ?? msg,
          confirmText: opts?.confirmText ?? "확인",
          cancelText: opts?.cancelText ?? "취소",
          destructive: opts?.destructive ?? false,
        }) as Promise<boolean>,
      alert: (msg, opts) =>
        push({
          kind: "alert",
          title: opts?.title ?? "안내",
          message: opts?.message ?? msg,
          confirmText: opts?.confirmText ?? "확인",
          destructive: false,
        }).then(() => undefined) as Promise<void>,
      prompt: (msg, opts) =>
        push({
          kind: "prompt",
          title: opts?.title ?? "입력",
          message: opts?.message ?? msg,
          confirmText: opts?.confirmText ?? "확인",
          cancelText: opts?.cancelText ?? "취소",
          destructive: false,
          defaultValue: opts?.defaultValue ?? "",
          placeholder: opts?.placeholder,
        }) as Promise<string | null>,
    }),
    [push],
  );

  const primaryClass = current?.destructive
    ? "h-9 rounded-md bg-destructive px-3 text-sm text-destructive-foreground hover:opacity-90"
    : "h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark";

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current ? (
        <Dialog
          open
          onClose={() =>
            settle(
              current.kind === "prompt"
                ? null
                : current.kind === "confirm"
                  ? false
                  : true, // alert: treat close as dismiss with resolved void
            )
          }
          title={current.title}
          width="max-w-md"
          footer={
            <>
              {current.kind !== "alert" && (
                <button
                  type="button"
                  onClick={() =>
                    settle(current.kind === "prompt" ? null : false)
                  }
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                >
                  {current.cancelText}
                </button>
              )}
              <button
                type="button"
                autoFocus={current.kind !== "prompt"}
                onClick={() =>
                  settle(
                    current.kind === "prompt"
                      ? promptValue
                      : current.kind === "confirm"
                        ? true
                        : true,
                  )
                }
                className={primaryClass}
              >
                {current.confirmText}
              </button>
            </>
          }
        >
          {current.message && (
            <div className="text-sm whitespace-pre-wrap">{current.message}</div>
          )}
          {current.kind === "prompt" && (
            <input
              type="text"
              autoFocus
              value={promptValue}
              placeholder={current.placeholder}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  settle(promptValue);
                }
              }}
              className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            />
          )}
        </Dialog>
      ) : null}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog must be used inside <DialogProvider>");
  }
  return ctx;
}
