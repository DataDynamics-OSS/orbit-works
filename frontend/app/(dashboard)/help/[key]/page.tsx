"use client";

/**
 * 도움말 상세 — DB 우선, 정적 코드(`HELP_SECTIONS`) fallback.
 *
 * - DB row 가 있으면 그 body_html 을 렌더 (운영자가 편집한 컨텐츠).
 * - 없으면 코드의 section.content (TSX) 를 렌더.
 * - ADMIN/HR/SUPER_ADMIN 에게 "편집" / "이력" 버튼 노출.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, History, ListOrdered, Pencil } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { HELP_SECTIONS } from "@/lib/help-content";
import { KbToc, applyHeadingIds, extractKbHeadings } from "@/components/kb/KbToc";

type ArticleOut = {
  id: string;
  menu_key: string;
  title: string;
  group: string | null;
  sort_order: number;
  summary: string | null;
  body_html: string;
  body_text: string | null;
  updated_at: string | null;
};

export default function HelpDetailPage() {
  const params = useParams();
  const key = (params?.key as string | undefined) ?? "";
  const codeSection = HELP_SECTIONS.find((s) => s.key === key) ?? null;

  // TOC 패널 — KB 패턴. localStorage 키는 도움말 전용으로 분리.
  const [tocOpen, setTocOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("helpTocOpen") !== "0";
    } catch {
      return true;
    }
  });
  const [tocWidth, setTocWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 240;
    try {
      const v = Number(localStorage.getItem("helpTocWidth"));
      return Number.isFinite(v) && v >= 160 && v <= 720 ? v : 240;
    } catch {
      return 240;
    }
  });

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canEdit =
    me?.role === "ADMIN" || me?.role === "SUPER_ADMIN" || me?.role === "HR";

  // DB row — 404 면 throwOnError 비활성으로 fallback.
  const { data: dbArticle, isLoading } = useQuery<ArticleOut | null>({
    queryKey: ["help-article", key],
    queryFn: async () => {
      try {
        return (await api.get(`/help-articles/${key}`)).data as ArticleOut;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
    enabled: !!key,
    staleTime: 60_000,
  });

  const title = dbArticle?.title ?? codeSection?.title;
  const group = dbArticle?.group ?? codeSection?.group;
  const summary = dbArticle?.summary ?? codeSection?.summary;

  // TOC 입력 — DB 본문은 HTML 문자열에서 직접, 코드 TSX 본문은 ref 의 DOM 에서.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [domHeadings, setDomHeadings] = useState<
    Array<{ id: string; level: number; text: string }>
  >([]);
  const htmlHeadings = useMemo(
    () => (dbArticle ? extractKbHeadings(dbArticle.body_html) : []),
    [dbArticle],
  );
  useEffect(() => {
    // 본문이 렌더된 다음 heading 들에 id 부여 + 목록 추출.
    if (!bodyRef.current) return;
    applyHeadingIds(bodyRef.current);
    if (!dbArticle && codeSection) {
      const nodes = bodyRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
      setDomHeadings(
        Array.from(nodes).map((n) => ({
          id: (n as HTMLElement).id,
          level: parseInt(n.tagName.slice(1), 10) || 2,
          text: (n.textContent || "").trim(),
        })),
      );
    } else {
      setDomHeadings([]);
    }
  }, [dbArticle, codeSection]);
  const headings = dbArticle ? htmlHeadings : domHeadings;

  return (
    <>
      <DashboardHeader
        title={title || "도움말"}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !tocOpen;
                setTocOpen(next);
                try { localStorage.setItem("helpTocOpen", next ? "1" : "0"); } catch { /* ignore */ }
              }}
              className={
                "h-8 inline-flex items-center gap-1 rounded-md border px-3 text-sm " +
                (tocOpen
                  ? "border-primary text-primary bg-primary/5 hover:bg-primary/10"
                  : "border-border bg-background hover:bg-muted")
              }
              title="목차 패널 토글"
            >
              <ListOrdered className="h-3.5 w-3.5" /> 목차
            </button>
            {canEdit && key && (
              <>
                <Link
                  href={`/help/${key}/revisions`}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
                >
                  <History className="h-3.5 w-3.5" /> 이력
                </Link>
                <Link
                  href={`/help/${key}/edit`}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-primary text-primary bg-background px-3 text-sm hover:bg-primary/10"
                >
                  <Pencil className="h-3.5 w-3.5" /> 편집
                </Link>
              </>
            )}
            <Link
              href="/help"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 인덱스
            </Link>
          </div>
        }
      />
      {/* HelpTocSidebar 는 layout 으로 옮김 — 라우팅 간 mount 보존. */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* 외부 wrapper 는 스크롤하지 않음 — separator/TOC 가 viewport 높이만큼
            stretch 되어 잘리지 않도록. 본문(<section>) 자체가 내부 스크롤 + 자체 padding. */}
        <div className="flex flex-1 flex-col overflow-hidden min-h-0">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">불러오는 중…</div>
          ) : !dbArticle && !codeSection ? (
            <div className="rounded-lg border border-border bg-card p-6 max-w-2xl">
              <h2 className="text-lg font-semibold mb-2">
                도움말을 찾을 수 없습니다
              </h2>
              <p className="text-sm text-muted-foreground">
                요청하신 도움말 항목(<code className="font-mono">{key}</code>)이
                아직 작성되지 않았거나 다른 메뉴와 키가 다릅니다.{" "}
                {canEdit && (
                  <Link
                    href={`/help/${key}/edit`}
                    className="text-primary underline"
                  >
                    여기서 새로 작성
                  </Link>
                )}{" "}
                또는{" "}
                <Link href="/help" className="text-primary underline">
                  인덱스로 돌아가기
                </Link>
                .
              </p>
            </div>
          ) : (
            <div className="flex flex-1 min-h-0 gap-0">
              {/* article 자체가 overflow-auto — KB 와 동일 패턴. 본문이 길어도
                  separator 와 TOC 는 viewport 높이만큼 보임. */}
              <section className="flex-1 min-w-0 border-r border-border bg-card p-6 overflow-auto prose prose-sm prose-h3:mt-4 prose-h3:mb-1 prose-ul:my-1 prose-ol:my-1 prose-p:my-1">
                <div className="not-prose mb-3">
                  {/* title 은 DashboardHeader 가 이미 표시 — 본문 안 중복 제거. */}
                  {summary && (
                    <p className="text-sm text-muted-foreground">
                      {summary}
                    </p>
                  )}
                  {dbArticle?.updated_at && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      마지막 수정: {dbArticle.updated_at.slice(0, 10)}
                    </p>
                  )}
                </div>
                <div ref={bodyRef}>
                  {dbArticle ? (
                    <div
                      className="tiptap-content"
                      dangerouslySetInnerHTML={{ __html: dbArticle.body_html }}
                    />
                  ) : (
                    codeSection?.content
                  )}
                </div>
              </section>
              {tocOpen && (
                <>
                  <TocSeparator
                    width={tocWidth}
                    onChange={(w) => {
                      setTocWidth(w);
                      try { localStorage.setItem("helpTocWidth", String(w)); } catch { /* ignore */ }
                    }}
                  />
                  <KbToc
                    headings={headings}
                    width={tocWidth}
                    onClose={() => {
                      setTocOpen(false);
                      try { localStorage.setItem("helpTocOpen", "0"); } catch { /* ignore */ }
                    }}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** 본문 ↔ TOC 사이 드래그 separator. KB 와 동일 패턴 (160~720 clamp, 더블클릭 240). */
function TocSeparator({
  width,
  onChange,
}: {
  width: number;
  onChange: (w: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="목차 패널 폭 조절"
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let latest = startWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const onMove = (ev: MouseEvent) => {
          const delta = startX - ev.clientX;
          latest = Math.max(160, Math.min(720, startWidth + delta));
          onChange(latest);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }}
      onDoubleClick={() => onChange(240)}
      className="shrink-0 w-1 cursor-col-resize bg-border hover:bg-primary/40 transition-colors"
      title="드래그하여 폭 조절 · 더블클릭으로 기본값(240px) 복원"
    />
  );
}
