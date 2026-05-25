"use client";

import { ReactNode, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bookmark, Calculator as CalcIcon, CalendarDays, HelpCircle } from "lucide-react";
import { useMemoDrawer } from "@/components/memo/MemoProvider";
import { useCalculator } from "@/components/calculator/CalculatorProvider";
import { useQuickCalendar } from "@/components/quick-calendar/QuickCalendarProvider";
import { useBookmark } from "@/components/bookmarks/BookmarkProvider";
import { MENU_REGISTRY } from "@/components/layout/menu-registry";
import { HELP_KEYS } from "@/lib/help-content";

export function DashboardHeader({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <h1 className="text-xl font-semibold leading-none">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        {actions}
        <HelpTriggerLink />
        <MemoTriggerButton />
        <CalculatorTriggerButton />
        <QuickCalendarTriggerButton />
        <BookmarkTriggerButton />
      </div>
    </header>
  );
}

/**
 * 현재 pathname → menu_key 매핑 후, 해당 key 의 도움말 콘텐츠가 있으면
 * `?` 아이콘 노출 → `/help#<key>` 로 deep link. 매칭/콘텐츠 없는 페이지는
 * 아이콘 숨김 (빈 섹션으로 가는 어색함 방지).
 *
 * /help 페이지 자체에서는 아이콘 숨김.
 */
function HelpTriggerLink() {
  const pathname = usePathname() ?? "";
  const helpKey = useMemo(() => {
    if (pathname.startsWith("/help")) return null;
    // pathname 과 menu entry.href 정확 일치 또는 prefix 매칭 (상세 페이지 포함).
    let best: { key: string; hrefLen: number } | null = null;
    for (const entry of MENU_REGISTRY) {
      if (
        pathname === entry.href ||
        (entry.href !== "/dashboard" && pathname.startsWith(entry.href + "/"))
      ) {
        if (!best || entry.href.length > best.hrefLen) {
          best = { key: entry.key, hrefLen: entry.href.length };
        }
      }
    }
    if (!best) return null;
    return HELP_KEYS.has(best.key) ? best.key : null;
  }, [pathname]);

  if (!helpKey) return null;
  return (
    <Link
      href={`/help/${helpKey}`}
      className="h-8 w-8 rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center"
      aria-label="이 메뉴 도움말 열기"
      title="도움말"
    >
      <HelpCircle className="h-4 w-4" />
    </Link>
  );
}

function CalculatorTriggerButton() {
  const { toggle } = useCalculator();
  return (
    <button
      type="button"
      onClick={toggle}
      className="h-8 w-8 rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center"
      aria-label="계산기 열기"
      title="계산기 / 환율"
    >
      <CalcIcon className="h-4 w-4" />
    </button>
  );
}

function QuickCalendarTriggerButton() {
  const { toggle } = useQuickCalendar();
  return (
    <button
      type="button"
      onClick={toggle}
      className="h-8 w-8 rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center"
      aria-label="달력 열기"
      title="달력"
    >
      <CalendarDays className="h-4 w-4" />
    </button>
  );
}

function BookmarkTriggerButton() {
  const { toggle } = useBookmark();
  return (
    <button
      type="button"
      onClick={toggle}
      className="h-8 w-8 rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center"
      aria-label="북마크 열기"
      title="북마크"
    >
      <Bookmark className="h-4 w-4" />
    </button>
  );
}

function MemoTriggerButton() {
  const { toggle } = useMemoDrawer();
  return (
    <button
      type="button"
      onClick={toggle}
      className="h-8 w-8 rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center"
      aria-label="메모장 열기"
      title="메모장"
    >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 6h4" />
          <path d="M2 10h4" />
          <path d="M2 14h4" />
          <path d="M2 18h4" />
          <rect width="16" height="20" x="4" y="2" rx="2" />
          <path d="M9.5 8h5" />
          <path d="M9.5 12h5" />
          <path d="M9.5 16h3" />
        </svg>
    </button>
  );
}
