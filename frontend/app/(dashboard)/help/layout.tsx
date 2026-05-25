"use client";

/**
 * /help/* 공통 layout — 좌측 도움말 목차(HelpTocSidebar) 를 layout 에 두어
 * 페이지 라우팅 간 sidebar 가 unmount/remount 되지 않도록. 그래서 사용자가
 * 하단으로 스크롤한 상태에서 항목을 클릭해도 스크롤 위치가 보존된다.
 *
 * 현재 활성 키는 pathname 기반 — `/help/[key]` 면 key, `/help` 또는
 * `/help/[key]/edit`, `/help/[key]/revisions` 등도 적절히 추출.
 */

import { usePathname } from "next/navigation";
import { HelpTocSidebar } from "@/components/help/HelpTocSidebar";

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";
  // /help              → activeKey = null
  // /help/{key}        → activeKey = {key}
  // /help/{key}/edit   → activeKey = {key} (편집 중에도 같은 항목 highlight)
  // /help/{key}/revisions → 같음
  const m = pathname.match(/^\/help\/([^/]+)/);
  const activeKey = m ? decodeURIComponent(m[1]) : null;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <HelpTocSidebar activeKey={activeKey} />
      <div className="flex flex-1 flex-col min-w-0 min-h-0">{children}</div>
    </div>
  );
}
