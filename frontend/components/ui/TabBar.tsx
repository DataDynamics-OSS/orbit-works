"use client";

/**
 * 공용 탭 UI — 9곳에 흩어져 있던 자체 정의(TabBtn/TabButton/inline)를 통일.
 *
 * 동작:
 * - 13px, `font-semibold` active, `border-b-2` underline
 * - 컨테이너는 가로 스크롤(`overflow-x-auto`) — 탭이 폭을 넘으면 줄바꿈 대신 스크롤.
 * - 스크롤바 자체는 시각적으로 숨김 (`scrollbar-width:none` + webkit hide).
 * - 좌/우 chevron 버튼이 자동으로 표시·숨김 — 스크롤 가능한 방향만 보임.
 *   ResizeObserver / scroll 이벤트 / MutationObserver(자식 추가/제거) 로 추적.
 * - 모바일은 chevron 그대로 + 손가락 스와이프(overflow-x-auto) 양쪽 다 작동.
 *
 * 사용:
 *   <TabBar>
 *     <TabItem active={tab === "a"} onClick={() => setTab("a")}>A</TabItem>
 *     <TabItem active={tab === "b"} onClick={() => setTab("b")}>B</TabItem>
 *   </TabBar>
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function TabBar({
  children,
  className,
}: {
  children: ReactNode;
  /** 외부 컨테이너에 추가 클래스 — 보통 불필요. */
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // canL/canR: 좌/우 chevron 표시 여부 (스크롤 가능 방향만 노출).
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(false);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    // 1px 여유 — 일부 브라우저가 sub-pixel 반올림으로 끝까지 못 갈 때 대비.
    setCanL(scrollLeft > 0);
    setCanR(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    // 컨테이너 크기 변화 감지 — 사이드바 토글, 윈도우 리사이즈.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // 자식 추가/제거 감지 — ADMIN 권한에 따라 탭이 늘어나는 settings 같은 케이스.
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [update]);

  const scrollByDir = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    // 컨테이너 폭의 75% 만큼 이동 — 한 번 클릭에 화면 한 페이지에 가깝게.
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: "smooth" });
  }, []);

  return (
    <div className={clsx("relative border-b border-border", className)}>
      <div
        ref={scrollRef}
        className="flex overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>

      {canL && (
        <button
          type="button"
          aria-label="이전 탭"
          onClick={() => scrollByDir(-1)}
          className="absolute inset-y-0 left-0 z-10 flex items-center justify-center w-8 bg-gradient-to-r from-background via-background to-transparent text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {canR && (
        <button
          type="button"
          aria-label="다음 탭"
          onClick={() => scrollByDir(1)}
          className="absolute inset-y-0 right-0 z-10 flex items-center justify-center w-8 bg-gradient-to-l from-background via-background to-transparent text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function TabItem({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "h-9 px-4 text-[13px] whitespace-nowrap border-b-2 -mb-px transition-colors",
        active
          ? "border-primary text-primary font-semibold"
          : "border-transparent text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
