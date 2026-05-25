"use client";

import clsx from "clsx";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type Side = "right" | "top" | "bottom" | "left";

type Props = {
  /** 툴팁 내용. 줄바꿈(\n) 자동 보존. */
  label: ReactNode;
  /** 툴팁이 나타날 방향 (기본: top). */
  side?: Side;
  /** 부모에 직접 `group/tt relative` 를 붙이고 자식을 감싸지 않는 용도.
   *  이 경우 hover 트리거는 Tooltip 의 부모 element 가 된다. */
  inline?: boolean;
  /** inline=false 일 때 hover 대상 컨텐츠. */
  children?: ReactNode;
  className?: string;
};

/**
 * Portal 기반 툴팁 — `document.body` 에 렌더되어 조상 `overflow: hidden`
 * 이나 다른 z-index stacking 컨텍스트에 영향받지 않음.
 *
 * 동작 원리:
 *   - hover/focus 시 트리거 element 의 getBoundingClientRect() 로 위치 계산
 *   - position: fixed + z-index 9999 로 화면 위에 표시
 *   - 줄바꿈(\n) 보존 (whitespace-pre-line)
 *
 * 사용법 1 — 컨텐츠를 감싸서 사용 (가장 흔함):
 *   <Tooltip label="도움말">
 *     <button>?</button>
 *   </Tooltip>
 *
 * 사용법 2 — 부모를 직접 트리거로 사용 (`absolute` 포지션 자식에 wrapper 못 씌울 때):
 *   <button className="...">
 *     <Icon />
 *     <Tooltip label="도움말" inline />
 *   </button>
 */
export function Tooltip({
  label,
  side = "top",
  inline,
  children,
  className,
}: Props) {
  // anchorRef 는 inline 모드일 때 hidden 마커 역할 — parentElement 로 트리거 접근.
  // wrap 모드일 때는 그 자체가 hover 트리거.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<
    | { top: number; left: number; transform: string }
    | null
  >(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  function computePosition(): { top: number; left: number; transform: string } | null {
    const node = anchorRef.current;
    if (!node) return null;
    const trigger = inline ? node.parentElement : node;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const gap = 6; // 트리거와 버블 사이 간격(px)
    if (side === "top") {
      return {
        top: rect.top - gap,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, -100%)",
      };
    }
    if (side === "bottom") {
      return {
        top: rect.bottom + gap,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, 0)",
      };
    }
    if (side === "left") {
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - gap,
        transform: "translate(-100%, -50%)",
      };
    }
    return {
      top: rect.top + rect.height / 2,
      left: rect.right + gap,
      transform: "translate(0, -50%)",
    };
  }

  function show() {
    setPos(computePosition());
  }
  function hide() {
    setPos(null);
  }

  // inline 모드: parent element 에 hover/focus 리스너 직접 부착.
  useEffect(() => {
    if (!inline) return;
    const trigger = anchorRef.current?.parentElement;
    if (!trigger) return;
    trigger.addEventListener("mouseenter", show);
    trigger.addEventListener("mouseleave", hide);
    trigger.addEventListener("focusin", show);
    trigger.addEventListener("focusout", hide);
    return () => {
      trigger.removeEventListener("mouseenter", show);
      trigger.removeEventListener("mouseleave", hide);
      trigger.removeEventListener("focusin", show);
      trigger.removeEventListener("focusout", hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, side]);

  // 표시 중 동작:
  //  - 스크롤 → 즉시 hide. 이전에는 재계산을 시도했으나, 스크롤 중 인접 트리거에
  //    mouseenter 가 연속 발화해 여러 툴팁이 portal 에 동시에 마운트되는 ghost
  //    현상이 있었음 (특히 인력 투입 타임라인처럼 트리거가 촘촘한 경우).
  //  - 리사이즈 → 위치 재계산 (사용자 의도는 같은 트리거에 대한 위치 보정).
  useLayoutEffect(() => {
    if (!pos) return;
    function onScroll() {
      hide();
    }
    function onResize() {
      const next = computePosition();
      if (next) setPos(next);
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos !== null, side, inline]);

  const bubble =
    pos && mounted
      ? createPortal(
          <span
            role="tooltip"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              transform: pos.transform,
              zIndex: 9999,
              maxWidth: "min(40rem, 90vw)",
            }}
            className={clsx(
              "pointer-events-none whitespace-pre-line",
              "px-2.5 py-1 rounded-md text-xs leading-snug",
              "bg-popover text-popover-foreground",
              "border border-border shadow-md",
              className,
            )}
          >
            {label}
          </span>,
          document.body,
        )
      : null;

  if (inline) {
    // hidden 마커 — DOM 위치 (parentElement 참조) 만 필요.
    return (
      <>
        <span ref={anchorRef} className="hidden" aria-hidden />
        {bubble}
      </>
    );
  }

  return (
    <span
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="inline-flex"
    >
      {children}
      {bubble}
    </span>
  );
}
