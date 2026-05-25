"use client";

/**
 * 도움말 좌측 sticky TOC. /help 인덱스와 /help/[key] 상세 페이지가 공유.
 *
 * 현재 활성 섹션(`activeKey`) 은 visual highlight. 메뉴 그룹 라벨은 사이드바
 * `MENU_GROUP_ORDER` 와 같은 순서로 렌더.
 *
 * 상단에 검색 input — title/summary/group 부분일치(case-insensitive).
 * 코드 default(HELP_SECTIONS) + DB articles merge — DB 가 같은 key 면 title/
 * summary/group 우선.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListOrdered, Search } from "lucide-react";

import { api } from "@/lib/api";
import { MENU_GROUP_ORDER } from "@/components/layout/menu-registry";
import { HELP_SECTIONS } from "@/lib/help-content";

type ArticleListOut = {
  id: string;
  menu_key: string;
  title: string;
  group: string | null;
  sort_order: number;
  summary: string | null;
  updated_at: string | null;
};

type Item = {
  key: string;
  title: string;
  group: string;
  summary?: string;
};

export function HelpTocSidebar({ activeKey }: { activeKey?: string | null }) {
  const [q, setQ] = useState("");

  // 같은 query key — index 페이지의 useQuery 와 캐시 공유 (재요청 0).
  const { data: dbArticles = [] } = useQuery<ArticleListOut[]>({
    queryKey: ["help-articles", "list"],
    queryFn: async () => (await api.get("/help-articles")).data,
    staleTime: 60_000,
  });

  // 코드 + DB merge (DB 우선).
  const merged: Item[] = useMemo(() => {
    const dbMap = new Map(dbArticles.map((a) => [a.menu_key, a]));
    const out: Item[] = [];
    const seen = new Set<string>();
    for (const s of HELP_SECTIONS) {
      const db = dbMap.get(s.key);
      out.push({
        key: s.key,
        title: db?.title ?? s.title,
        group: db?.group ?? s.group,
        summary: (db?.summary ?? s.summary) || undefined,
      });
      seen.add(s.key);
    }
    for (const a of dbArticles) {
      if (seen.has(a.menu_key)) continue;
      out.push({
        key: a.menu_key,
        title: a.title,
        group: a.group ?? "기타",
        summary: a.summary ?? undefined,
      });
    }
    return out;
  }, [dbArticles]);

  // 검색어 필터 — title/summary/group/key 부분일치, case-insensitive.
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return merged;
    return merged.filter((s) => {
      return (
        s.title.toLowerCase().includes(term) ||
        s.key.toLowerCase().includes(term) ||
        (s.summary ?? "").toLowerCase().includes(term) ||
        s.group.toLowerCase().includes(term)
      );
    });
  }, [merged, q]);

  // group 별 묶기 + MENU_GROUP_ORDER 우선 + 기타는 뒤로.
  const grouped = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const s of filtered) {
      const arr = m.get(s.group) ?? [];
      arr.push(s);
      m.set(s.group, arr);
    }
    const ordered = MENU_GROUP_ORDER.filter(
      (g) => (m.get(g)?.length ?? 0) > 0,
    ).map((g) => ({ group: g, items: m.get(g)! }));
    for (const [g, items] of m.entries()) {
      if (!MENU_GROUP_ORDER.includes(g)) ordered.push({ group: g, items });
    }
    return ordered;
  }, [filtered]);

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-card overflow-auto">
      <div className="sticky top-0 bg-card z-10 border-b border-border">
        <div className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold">
          <ListOrdered className="h-3.5 w-3.5" />
          도움말 목차
        </div>
        <div className="px-2 pb-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="도움말 검색"
              className="w-full h-7 rounded-md border border-input bg-background pl-7 pr-2 text-xs"
            />
          </div>
        </div>
      </div>
      <nav className="p-2 flex flex-col gap-2">
        <Link
          href="/help"
          className={
            "block px-2 py-1 rounded text-sm hover:bg-muted " +
            (activeKey == null ? "bg-muted font-medium" : "")
          }
        >
          전체 인덱스
        </Link>
        {grouped.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            검색 결과 없음
          </div>
        ) : (
          grouped.map((g) => (
            // group 묶음 — 헤더는 본문 base 보다 살짝 크고 진하게, 항목은
            // 좌측 들여쓰기 + 가이드 border 로 sub 임을 시각적으로 강조.
            <div key={g.group} className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs font-semibold text-foreground">
                  {g.group}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {g.items.length}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5 ml-2 pl-2 border-l border-border/60">
                {g.items.map((s) => (
                  <li key={s.key}>
                    <Link
                      href={`/help/${s.key}`}
                      className={
                        // 좌측 2px border 가 hover/active 시 primary 로 진해져
                        // 시각 반응을 명확히. 들여쓰기는 border-l 의 pl-2 와 합쳐 충분.
                        "block px-2 py-1 rounded text-sm border-l-2 -ml-[10px] pl-2 transition-colors " +
                        (activeKey === s.key
                          ? "bg-muted font-medium text-foreground border-primary"
                          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground hover:border-primary/40")
                      }
                    >
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>
    </aside>
  );
}
