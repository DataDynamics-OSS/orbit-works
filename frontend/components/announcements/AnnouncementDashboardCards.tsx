"use client";

/**
 * 대시보드용 사업공고 카드 2종.
 *
 * 1) 오늘 신규 공고 — 소스별 breakdown + 총건수. `/announcements` 로 이동.
 * 2) 북마크 임박 마감 — D-day 오름차순 5건. 바로 상세/원문 링크.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, Megaphone } from "lucide-react";

import { api } from "@/lib/api";

type Summary = {
  total: number;
  new_today: number;
  closing_within_7d: number;
  by_source: Record<string, number>;
  by_business_type: Record<string, number>;
};

type Announcement = {
  id: string;
  title: string;
  agency: string | null;
  source_name: string | null;
  deadline_at: string | null;
  days_to_deadline: number | null;
  detail_url: string | null;
};

type Page = { items: Announcement[]; total: number };

function ddayBadge(d: number | null) {
  if (d == null) return <span className="text-muted-foreground">—</span>;
  if (d < 0) return <span className="text-gray-400">마감</span>;
  if (d <= 3) return <span className="text-rose-600 font-semibold">D-{d}</span>;
  if (d <= 7) return <span className="text-amber-600 font-semibold">D-{d}</span>;
  return <span>D-{d}</span>;
}

export function AnnouncementDashboardCards() {
  const { data: summary } = useQuery<Summary>({
    queryKey: ["announcement-summary"],
    queryFn: async () => (await api.get("/announcements/summary")).data,
  });

  const { data: bookmarks } = useQuery<Page>({
    queryKey: ["announcement-bookmarks-upcoming"],
    queryFn: async () =>
      (
        await api.get("/announcements", {
          params: {
            bookmarked_only: true,
            sort: "deadline_asc",
            page: 1,
            page_size: 5,
          },
        })
      ).data,
  });

  return (
    <>
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">오늘 신규 사업공고</h3>
          </div>
          <Link
            href="/announcements"
            className="text-xs text-primary hover:underline"
          >
            전체보기
          </Link>
        </div>
        {!summary ? (
          <div className="mt-3 text-sm text-muted-foreground">로딩 중…</div>
        ) : (
          <>
            <div className="mt-2 text-3xl font-semibold tabular-nums">
              {summary.new_today}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                건 / 전체 {summary.total}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.entries(summary.by_source)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([src, n]) => (
                  <span
                    key={src}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
                  >
                    <span className="font-medium">{src}</span>
                    <span className="text-muted-foreground">{n}</span>
                  </span>
                ))}
            </div>
            <div className="mt-3 text-[11px] text-muted-foreground">
              7일 내 마감: <strong>{summary.closing_within_7d}</strong> 건
            </div>
          </>
        )}
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bookmark className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold">북마크 임박 마감</h3>
          </div>
          <Link
            href="/announcements?bookmarked_only=1&sort=deadline_asc"
            className="text-xs text-primary hover:underline"
          >
            전체보기
          </Link>
        </div>
        <ul className="mt-2 divide-y divide-border text-sm">
          {bookmarks?.items?.length ? (
            bookmarks.items.map((a) => (
              <li key={a.id} className="flex items-center gap-2 py-2">
                <div className="w-12 text-right text-xs">
                  {ddayBadge(a.days_to_deadline)}
                </div>
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/announcements?focus=${a.id}`}
                    className="block truncate text-primary hover:underline"
                  >
                    {a.title}
                  </Link>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {a.agency ?? "—"} · {a.source_name ?? ""}
                  </div>
                </div>
              </li>
            ))
          ) : (
            <li className="py-4 text-center text-muted-foreground text-xs">
              북마크된 공고가 없습니다.
            </li>
          )}
        </ul>
      </div>
    </>
  );
}
