"use client";

/**
 * 계산기 드로어 — 메모장 드로어와 동일한 우측 슬라이드 패턴.
 *
 * 두 개 탭:
 *   1) 계산기 (BasicCalculator) — macOS 스타일 일반 계산기 + 키보드.
 *   2) 환율   (FxConverter)     — KRW/USD/EUR/CNY/JPY/THB 양방향.
 *
 * 키 입력은 BasicCalculator 가 직접 글로벌 listener 로 처리하되, 환율 탭이
 * 활성일 때는 비활성 (input 자체 입력에 맡김). 탭 전환 시 active prop 으로 토글.
 */

import { useEffect } from "react";
import { Calculator as CalcIcon, X } from "lucide-react";
import { useCalculator } from "./CalculatorProvider";
import { BasicCalculator } from "./BasicCalculator";
import { FxConverter } from "./FxConverter";

export function CalculatorDrawer() {
  const { isOpen, close, tab, setTab } = useCalculator();

  // ESC 닫기. input/textarea focus 중에도 닫힘 (사용자가 명시적 닫기 의도).
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  return (
    <div
      className={
        "fixed top-0 right-0 h-full z-40 transition-transform duration-200 ease-out " +
        (isOpen ? "translate-x-0" : "translate-x-full pointer-events-none")
      }
      aria-hidden={!isOpen}
      style={{ width: 360 }}
    >
      <div className="h-full flex flex-col bg-card border-l border-border shadow-xl">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <CalcIcon className="h-4 w-4" />
            <h2 className="text-sm font-semibold">계산기</h2>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="닫기"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 탭 */}
        <div className="flex border-b border-border shrink-0">
          <TabButton active={tab === "calc"} onClick={() => setTab("calc")}>
            계산기
          </TabButton>
          <TabButton active={tab === "fx"} onClick={() => setTab("fx")}>
            환율
          </TabButton>
        </div>

        {/* 본체 — 탭 별 컴포넌트 둘 다 mount 유지하고 visibility 만 토글하면 상태 보존
            가능하지만 환율은 항상 fresh 로 두는 게 단순. 계산기 상태도 드로어가 닫히면
            unmount 되니 사용자가 "메모처럼 유지" 기대하지 않음. */}
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {tab === "calc" ? (
            <BasicCalculator active={isOpen && tab === "calc"} />
          ) : (
            <FxConverter />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex-1 h-9 text-xs transition-colors " +
        (active
          ? "border-b-2 border-primary font-semibold text-foreground"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
