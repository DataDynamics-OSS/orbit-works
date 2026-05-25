"use client";

/**
 * 도움말 인덱스. 본문은 그룹별 섹션 카드 (title + summary + 진입 링크) 만.
 *
 * 실제 본문(이미지 포함 긴 콘텐츠) 은 `/help/[key]` 별도 route 가 담당 —
 * 트래픽 분산. 사이드바 도움말 메뉴 / DashboardHeader 의 `?` 아이콘이
 * `/help/<key>` 로 직접 deep link 하므로 인덱스를 거치지 않아도 됨.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Database, Download, Pencil } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { MENU_GROUP_ORDER } from "@/components/layout/menu-registry";
import { HELP_SECTIONS, type HelpSection } from "@/lib/help-content";

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
  source: "db" | "code";
};

export default function HelpIndexPage() {
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canEdit =
    me?.role === "ADMIN" || me?.role === "SUPER_ADMIN" || me?.role === "HR";

  const { data: dbArticles = [] } = useQuery<ArticleListOut[]>({
    queryKey: ["help-articles", "list"],
    queryFn: async () => (await api.get("/help-articles")).data,
    staleTime: 60_000,
  });

  // 코드 default 와 DB row merge — 같은 key 면 DB 가 title/summary/group 우선.
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
        source: db ? "db" : "code",
      });
      seen.add(s.key);
    }
    // DB only — 코드에 없는 key.
    for (const a of dbArticles) {
      if (seen.has(a.menu_key)) continue;
      out.push({
        key: a.menu_key,
        title: a.title,
        group: a.group ?? "기타",
        summary: a.summary ?? undefined,
        source: "db",
      });
    }
    return out;
  }, [dbArticles]);

  const grouped = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const s of merged) {
      const arr = m.get(s.group) ?? [];
      arr.push(s);
      m.set(s.group, arr);
    }
    // MENU_GROUP_ORDER 우선 + DB only 의 신규 group 은 뒤에 append.
    const ordered = MENU_GROUP_ORDER.filter(
      (g) => (m.get(g)?.length ?? 0) > 0,
    ).map((g) => ({ group: g, items: m.get(g)! }));
    for (const [g, items] of m.entries()) {
      if (!MENU_GROUP_ORDER.includes(g))
        ordered.push({ group: g, items });
    }
    return ordered;
  }, [merged]);

  return (
    <>
      <DashboardHeader
        title="인덱스"
        actions={
          canEdit && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  // 현재 DB 컨텐츠를 default seed format JSON 으로 다운로드.
                  // 결과 파일은 backend/app/data/help_seed.json 에 commit 해두면
                  // 신규 tenant 가입 시 자동 시드. 다음 Orbit Works 배포에 포함.
                  try {
                    const res = await api.get("/help-articles/export");
                    const blob = new Blob([JSON.stringify(res.data, null, 2)], {
                      type: "application/json",
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "help_seed.json";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 0);
                  } catch (e: any) {
                    alert(e?.response?.data?.detail ?? "export 실패");
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
                title="이 기능은 개발자용 기능입니다. 일반 사용자는 사용할 필요가 없는 기능입니다."
              >
                <Download className="h-3.5 w-3.5" />
                도움말 시드 데이터 내보내기
              </button>
            </div>
          )
        }
      />
      {/* HelpTocSidebar 는 layout 으로 옮김 — 라우팅 간 mount 보존 (스크롤 위치 유지). */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-1 flex-col gap-6 p-6 overflow-auto">
          <p className="text-sm text-muted-foreground max-w-2xl">
            각 메뉴의 사용 방법을 모았습니다. 좌측 목차 또는 아래 카드에서
            원하는 항목을 선택하세요. 각 메뉴 페이지 상단의{" "}
            <span className="font-semibold">? 아이콘</span> 을 누르면 해당
            도움말로 바로 이동합니다.
            {canEdit && (
              <>
                {" "}<Database className="inline h-3 w-3" /> 표시는 DB 에 운영자가
                편집한 항목이고, 표시가 없으면 코드 default 입니다.
              </>
            )}
          </p>

          {grouped.map((g) => (
            // group panel — 옅은 배경 + border 로 같은 그룹을 한 묶음으로 감싼다.
            // 헤더는 본문 base 사이즈 + bold, 우측에 항목 수 chip.
            <section
              key={g.group}
              className="max-w-3xl rounded-lg border border-border/60 bg-muted/30 p-4"
            >
              <header className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-foreground">
                  {g.group}
                </h2>
                <span className="inline-flex items-center rounded-full bg-background border border-border px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                  {g.items.length}
                </span>
              </header>
              {/* 카드 ul 좌측 들여쓰기 + 좌측 border accent — sub-item 임을 시각적으로 강조. */}
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-4 border-l-2 border-border/40">
                {g.items.map((s) => (
                  <li key={s.key}>
                    <Link
                      href={`/help/${s.key}`}
                      className="block rounded-lg border border-border bg-card p-4 hover:border-primary hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-base font-semibold text-foreground inline-flex items-center gap-1">
                          {s.title}
                          {s.source === "db" && (
                            <Database
                              className="h-3 w-3 text-primary"
                              aria-label="DB 편집본"
                            />
                          )}
                        </h3>
                        <div className="flex items-center gap-1">
                          {canEdit && (
                            <Link
                              href={`/help/${s.key}/edit`}
                              onClick={(e) => e.stopPropagation()}
                              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted"
                              aria-label="편집"
                              title="편집"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Link>
                          )}
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                      {s.summary && (
                        <p className="mt-1 text-sm text-muted-foreground line-clamp-3">
                          {s.summary}
                        </p>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {grouped.length === 0 && (
            <div className="text-sm text-muted-foreground">
              아직 작성된 도움말이 없습니다.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
