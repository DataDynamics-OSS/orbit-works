"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type MemoCtx = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

const Ctx = createContext<MemoCtx | null>(null);

export function MemoProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  // Ctrl/Cmd+M 전역 단축키.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Ctx.Provider value={{ isOpen, open, close, toggle }}>{children}</Ctx.Provider>
  );
}

export function useMemoDrawer() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMemoDrawer must be used within MemoProvider");
  return v;
}
