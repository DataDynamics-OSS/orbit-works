"use client";

/**
 * 계산기 드로어 — 전역 open/close Context.
 *
 * 메모장 (MemoProvider) 와 동일한 패턴.
 * - DashboardHeader 의 CalculatorTriggerButton 이 toggle 로 드로어를 연다.
 * - 단축키 없음 — 헤더 버튼으로만 토글 (Ctrl+B 는 브라우저·OS 의 다른
 *   기능과 충돌 가능성이 있어 비활성화).
 */

import { createContext, useCallback, useContext, useState } from "react";

type Tab = "calc" | "fx";

type CalcCtx = {
  isOpen: boolean;
  tab: Tab;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setTab: (t: Tab) => void;
};

const Ctx = createContext<CalcCtx | null>(null);

export function CalculatorProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("calc");

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  return (
    <Ctx.Provider value={{ isOpen, tab, open, close, toggle, setTab }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCalculator() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCalculator must be used within CalculatorProvider");
  return v;
}
