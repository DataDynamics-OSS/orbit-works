"use client";

/**
 * 본문과 우측 TOC 패널 사이에 끼우는 세로 separator.
 *
 * 마우스 드래그로 폭 조절 (`min..max` 범위 clamp), 더블클릭으로 `defaultWidth`
 * 복원, 변경된 폭은 호출자가 넘긴 `storageKey` 에 localStorage 영속.
 *
 * 회의록 상세 페이지의 같은 패턴을 공통 컴포넌트로 추출 — 공지·게시판도
 * 같은 사용 경험을 보장. 회의록은 BlockNote 마운트 특성상 기존 inline
 * 구현을 유지.
 */

import { useCallback } from "react";

export function TocResizer({
  width,
  onChange,
  storageKey,
  defaultWidth = 240,
  min = 160,
  max = 720,
  ariaLabel = "목차 패널 폭 조절",
}: {
  width: number;
  onChange: (w: number) => void;
  /** localStorage 키 — 변경된 폭을 자동 저장. 미지정 시 영속 skip. */
  storageKey?: string;
  /** 더블클릭 시 복원할 기본값. */
  defaultWidth?: number;
  min?: number;
  max?: number;
  ariaLabel?: string;
}) {
  const persist = useCallback(
    (w: number) => {
      if (!storageKey) return;
      try {
        localStorage.setItem(storageKey, String(w));
      } catch {
        /* 사파리 사생활/저장공간 부족 등은 무시 */
      }
    },
    [storageKey],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      title="드래그하여 폭 조절 · 더블클릭으로 기본값 복원"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let latest = startWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const onMove = (ev: MouseEvent) => {
          // 마우스 ← : width 증가 (TOC 가 오른쪽 끝). → : width 감소.
          const delta = startX - ev.clientX;
          latest = Math.max(min, Math.min(max, startWidth + delta));
          onChange(latest);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          persist(latest);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }}
      onDoubleClick={() => {
        onChange(defaultWidth);
        persist(defaultWidth);
      }}
      className="shrink-0 w-1 cursor-col-resize bg-border hover:bg-primary/40 transition-colors"
    />
  );
}
