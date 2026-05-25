"use client";

/**
 * 북마크 (공용) — 사이드바 > 관리 > 북마크.
 *
 * 회사 공용 북마크 CRUD. 헤더 빠른 도구의 "공용 북마크" 탭에 노출되는 row 를
 * ADMIN/HR 가 여기서 관리. 메뉴 권한은 settings.bookmarks key — `BookmarksTab`
 * 컴포넌트는 그대로 재사용.
 */

import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { BookmarksTab } from "@/components/settings/BookmarksTab";

export default function BookmarksAdminPage() {
  return (
    <>
      <DashboardHeader title="북마크" />
      <div className="flex flex-1 flex-col gap-4 p-4 min-h-0 max-w-[73rem] overflow-auto">
        <BookmarksTab />
      </div>
    </>
  );
}
