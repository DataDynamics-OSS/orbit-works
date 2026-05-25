"use client";

/**
 * SUPER_ADMIN — 사업공고 source 관리. data.go.kr (G2B/BizInfo/K-Startup) 등
 * 공공 데이터포털 source 별 enabled/priority 토글 및 즉시 fetch 트리거.
 */

import { AnnouncementsTab } from "@/components/settings/AnnouncementsTab";

export default function AdminAnnouncementsPage() {
  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">사업공고 source</h1>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <AnnouncementsTab />
      </div>
    </>
  );
}
