"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const STORAGE_KEY = "sidebar-collapsed";
const MOBILE_BREAKPOINT = 1024; // Tailwind `lg`

type Ctx = {
  isCollapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
};

const SidebarCtx = createContext<Ctx | null>(null);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  // 기본 펼침. 모바일(< 1024px) 에서는 자동 접힘. 사용자가 명시적으로 선택한 값이
  // localStorage 에 있으면 그것을 우선.
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);

  // 최초 마운트 시에 저장값 + viewport 기반으로 기본값 결정.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "1") {
      setIsCollapsed(true);
    } else if (saved === "0") {
      setIsCollapsed(false);
    } else if (window.innerWidth < MOBILE_BREAKPOINT) {
      setIsCollapsed(true);
    }
  }, []);

  const setCollapsed = useCallback((v: boolean) => {
    setIsCollapsed(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => {
    setIsCollapsed((cur) => {
      const next = !cur;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <SidebarCtx.Provider value={{ isCollapsed, toggle, setCollapsed }}>
      {children}
    </SidebarCtx.Provider>
  );
}

export function useSidebar(): Ctx {
  const v = useContext(SidebarCtx);
  if (!v) throw new Error("useSidebar must be used within SidebarProvider");
  return v;
}
