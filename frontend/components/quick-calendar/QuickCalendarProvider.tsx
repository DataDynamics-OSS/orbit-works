"use client";

/**
 * 보기용 달력 드로어 — 전역 open/close Context.
 *
 * 메모장 / 계산기 와 동일 패턴. 단축키는 부여하지 않음 (브라우저·OS 의
 * 다른 기능과 키 충돌 회피, 향후 필요 시 추가).
 */

import { createContext, useCallback, useContext, useState } from "react";

type Ctx = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

const QuickCalendarCtx = createContext<Ctx | null>(null);

export function QuickCalendarProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  return (
    <QuickCalendarCtx.Provider value={{ isOpen, open, close, toggle }}>
      {children}
    </QuickCalendarCtx.Provider>
  );
}

export function useQuickCalendar() {
  const v = useContext(QuickCalendarCtx);
  if (!v) {
    throw new Error(
      "useQuickCalendar must be used within QuickCalendarProvider",
    );
  }
  return v;
}
