"use client";

/**
 * 북마크 드로어 — 전역 open/close Context. 메모/계산기/달력 과 동일 패턴.
 */

import { createContext, useCallback, useContext, useState } from "react";

type Ctx = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

const BookmarkCtx = createContext<Ctx | null>(null);

export function BookmarkProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  return (
    <BookmarkCtx.Provider value={{ isOpen, open, close, toggle }}>
      {children}
    </BookmarkCtx.Provider>
  );
}

export function useBookmark() {
  const v = useContext(BookmarkCtx);
  if (!v) {
    throw new Error("useBookmark must be used within BookmarkProvider");
  }
  return v;
}
