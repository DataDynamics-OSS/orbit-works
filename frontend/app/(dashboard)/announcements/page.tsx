"use client";

/**
 * 사업공고 (Announcements) 목록·상세.
 *
 * 백엔드 스케줄러(매일 03:00 KST) 가 나라장터(G2B)·NTIS·IRIS·BizInfo·K-Startup
 * 등 외부 소스에서 공고를 수집한다. 이 화면은 그 결과를 검색·필터·북마크
 * 하는 뷰. "지금 수집" 버튼으로 수동 트리거도 가능 (admin/sales 권한).
 */

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, ExternalLink, RefreshCw } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { DateInput } from "@/components/ui/DateInput";
import { useDialog } from "@/components/ui/DialogProvider";
import { AnnouncementDetailDrawer } from "@/components/announcements/AnnouncementDetailDrawer";

type BusinessType =
  | "RESEARCH"
  | "PUBLIC_BID"
  | "PRIVATE_BID"
  | "STARTUP"
  | "SUPPORT"
  | "OTHER";

const BIZ_LABEL: Record<BusinessType, string> = {
  RESEARCH: "R&D",
  PUBLIC_BID: "공공입찰",
  PRIVATE_BID: "민간입찰",
  STARTUP: "창업",
  SUPPORT: "기업지원",
  OTHER: "기타",
};

const BIZ_COLOR: Record<BusinessType, string> = {
  RESEARCH: "bg-indigo-100 text-indigo-700",
  PUBLIC_BID: "bg-sky-100 text-sky-700",
  PRIVATE_BID: "bg-emerald-100 text-emerald-700",
  STARTUP: "bg-amber-100 text-amber-700",
  SUPPORT: "bg-violet-100 text-violet-700",
  OTHER: "bg-gray-100 text-gray-700",
};

type Announcement = {
  id: string;
  source_id: string;
  source_code: string | null;
  source_name: string | null;
  external_id: string;
  title: string;
  agency: string | null;
  department: string | null;
  business_type: BusinessType | null;
  category: string | null;
  region: string | null;
  posted_at: string | null;
  deadline_at: string | null;
  days_to_deadline: number | null;
  budget_amount: number | null;
  currency: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  detail_url: string | null;
  attachment_urls: string[] | null;
  summary: string | null;
  is_active: boolean;
  bookmarked: boolean;
  bookmark_memo: string | null;
  converted_opportunity_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

type Page = { items: Announcement[]; total: number; page: number; page_size: number };

type Source = {
  id: string;
  code: string;
  name: string;
  agency: string | null;
  adapter_kind: string;
  enabled: boolean;
  priority: number;
  last_ok_at: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  last_count: number | null;
  needs_api_key: boolean;
  has_api_key: boolean;
  implemented: boolean;
};

type Summary = {
  total: number;
  new_today: number;
  closing_within_7d: number;
  by_source: Record<string, number>;
  by_business_type: Record<string, number>;
};

const KRW = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("ko-KR").format(n);

function ddayLabel(days: number | null) {
  if (days == null) return "—";
  if (days < 0) return "마감";
  if (days === 0) return "D-day";
  return `D-${days}`;
}

function ddayClass(days: number | null) {
  if (days == null) return "text-muted-foreground";
  if (days < 0) return "text-gray-400 line-through";
  if (days <= 3) return "text-rose-600 font-semibold";
  if (days <= 7) return "text-amber-600 font-semibold";
  return "text-foreground";
}

export default function AnnouncementsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [q, setQ] = useState("");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [businessType, setBusinessType] = useState<string>("");
  const [postedFrom, setPostedFrom] = useState<string>("");
  const [postedTo, setPostedTo] = useState<string>("");
  const [deadlineOnly, setDeadlineOnly] = useState<number | null>(null);
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [sort, setSort] = useState<"posted_desc" | "deadline_asc" | "first_seen_desc">(
    "posted_desc",
  );

  const [detailId, setDetailId] = useState<string | null>(null);

  // 서버 페이지네이션 — 필터 변경 시 1페이지로 리셋.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const filterKey = `${q}|${selectedSources.join(",")}|${businessType}|${postedFrom}|${postedTo}|${deadlineOnly}|${bookmarkedOnly}|${sort}`;
  const lastFilterKeyRef = useRef(filterKey);
  if (lastFilterKeyRef.current !== filterKey) {
    lastFilterKeyRef.current = filterKey;
    if (page !== 1) setPage(1);
  }

  const { data: sources = [] } = useQuery<Source[]>({
    queryKey: ["announcement-sources"],
    queryFn: async () => (await api.get("/announcements/sources")).data,
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ["announcement-summary"],
    queryFn: async () => (await api.get("/announcements/summary")).data,
  });

  const { data: pageData } = useQuery<Page>({
    queryKey: [
      "announcements",
      q,
      selectedSources.join(","),
      businessType,
      postedFrom,
      postedTo,
      deadlineOnly,
      bookmarkedOnly,
      sort,
      page,
      pageSize,
    ],
    queryFn: async () =>
      (
        await api.get("/announcements", {
          params: {
            q: q || undefined,
            sources: selectedSources.length ? selectedSources : undefined,
            business_type: businessType || undefined,
            posted_from: postedFrom || undefined,
            posted_to: postedTo || undefined,
            deadline_within_days: deadlineOnly ?? undefined,
            bookmarked_only: bookmarkedOnly || undefined,
            sort,
            page,
            page_size: pageSize,
          },
        })
      ).data,
    placeholderData: (prev) => prev,
  });

  const fetchM = useMutation({
    mutationFn: async () =>
      // 수동 수집은 최근 14일까지 되돌아 보는 쪽이 실용적 — 매일 공고가 올라오지
      // 않는 소스가 많고, 버튼 누른 당일 결과가 0건으로 찍혀 오해를 부른다.
      // 서버는 (source, external_id) UNIQUE 로 upsert 하므로 기존 건은 건너뜀.
      (await api.post("/announcements/fetch", { since_days: 14 })).data,
    onSuccess: async (data: { results: any[] }) => {
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["announcement-sources"] });
      qc.invalidateQueries({ queryKey: ["announcement-summary"] });
      const ok = data.results.filter((r) => r.status === "OK").length;
      const failed = data.results.filter((r) => r.status === "FAILED").length;
      const skipped = data.results.filter((r) => r.status === "SKIPPED").length;
      const inserted = data.results.reduce((a, r) => a + (r.inserted || 0), 0);
      const updated = data.results.reduce((a, r) => a + (r.updated || 0), 0);
      await dialog.alert(
        `수집 완료 — 신규 ${inserted}건, 변경 ${updated}건.\n` +
          `소스: ok ${ok}, failed ${failed}, skipped ${skipped}.`,
      );
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "수집 실패", { title: "오류" }),
  });

  const bookmarkM = useMutation({
    mutationFn: async (vars: { id: string; add: boolean; memo?: string | null }) => {
      if (vars.add) {
        return (
          await api.post(`/announcements/${vars.id}/bookmark`, {
            memo: vars.memo ?? null,
          })
        ).data;
      }
      return (await api.delete(`/announcements/${vars.id}/bookmark`)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["announcement-detail"] });
    },
  });

  const rows = pageData?.items ?? [];

  const sourceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.code, s.name);
    return map;
  }, [sources]);

  // 컬럼 정의는 안정적 identity 필수 — AG Grid re-render 시 "getColDef on null"
  // 예외 방지 + 하위 핸들러가 부모 state(setDetailId/bookmarkM/sourceLabels) 를
  // 참조하므로 의존성에 포함.
  const columnDefs = useMemo<any[]>(
    () => [
      {
        headerName: "북마크",
        colId: "bookmark",
        width: 70,
        minWidth: 70,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        cellRenderer: (p: any) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              bookmarkM.mutate({
                id: p.data.id,
                add: !p.data.bookmarked,
              });
            }}
            className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-amber-500"
            aria-label="북마크"
          >
            {p.data.bookmarked ? (
              <BookmarkCheck className="h-4 w-4 text-amber-500" />
            ) : (
              <Bookmark className="h-4 w-4" />
            )}
          </button>
        ),
      },
      {
        headerName: "제목",
        colId: "title",
        field: "title",
        flex: 2,
        headerClass: "ag-header-center",
        cellRenderer: (p: any) => (
          <button
            type="button"
            onClick={() => setDetailId(p.data.id)}
            className="text-left text-primary hover:underline truncate"
          >
            {p.value}
          </button>
        ),
      },
      {
        headerName: "발주기관",
        colId: "agency",
        field: "agency",
        width: 150,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p: any) => p.value || "—",
      },
      {
        headerName: "소스",
        colId: "source",
        width: 150,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        valueGetter: (p: any) =>
          sourceLabels.get(p.data.source_code || "") || p.data.source_code,
      },
      {
        headerName: "유형",
        colId: "business_type",
        width: 90,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        cellRenderer: (p: any) => {
          const bt = p.data.business_type as BusinessType | null;
          if (!bt) return <span className="text-muted-foreground">—</span>;
          return (
            <span
              className={`inline-block rounded px-2 py-0.5 text-[11px] ${BIZ_COLOR[bt]}`}
            >
              {BIZ_LABEL[bt]}
            </span>
          );
        },
      },
      {
        headerName: "게시일",
        colId: "posted_at",
        field: "posted_at",
        width: 90,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p: any) => p.value || "—",
      },
      {
        headerName: "마감",
        colId: "days_to_deadline",
        field: "days_to_deadline",
        width: 60,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        cellRenderer: (p: any) => (
          <span className={ddayClass(p.value)}>{ddayLabel(p.value)}</span>
        ),
      },
      {
        headerName: "예산",
        colId: "budget_amount",
        field: "budget_amount",
        width: 130,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "flex-end" } as any,
        valueFormatter: (p: any) => KRW(p.value),
      },
      {
        headerName: "링크",
        colId: "external_link",
        width: 60,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { justifyContent: "center" } as any,
        cellRenderer: (p: any) =>
          p.data.detail_url ? (
            <a
              href={p.data.detail_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-primary"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null,
      },
    ],
    [sourceLabels, bookmarkM],
  );

  return (
    <>
      <DashboardHeader title="사업공고" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        {/* 요약 카드 */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <SummaryCard label="공고 총건수" value={String(summary.total)} />
            <SummaryCard label="오늘 신규" value={String(summary.new_today)} />
            <SummaryCard
              label="7일 내 마감"
              value={String(summary.closing_within_7d)}
            />
            <SummaryCard
              label="활성 소스"
              value={`${sources.filter((s) => s.enabled).length} / ${sources.length}`}
              sub="설정 > 사업공고에서 관리"
            />
          </div>
        )}

        {/* 필터 바 */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="제목·발주기관 검색"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[240px]"
          />

          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">전체 유형</option>
            {(Object.keys(BIZ_LABEL) as BusinessType[]).map((k) => (
              <option key={k} value={k}>
                {BIZ_LABEL[k]}
              </option>
            ))}
          </select>

          <details className="relative">
            <summary className="h-9 inline-flex items-center px-3 rounded-md border border-border bg-background text-sm cursor-pointer select-none list-none marker:hidden [&::-webkit-details-marker]:hidden">
              소스{selectedSources.length ? ` (${selectedSources.length})` : ""}
            </summary>
            {/* top-full + left-0: summary 와 겹치지 않도록 아래쪽으로 위치 고정 */}
            <div className="absolute top-full left-0 z-20 mt-1 w-[260px] max-h-[320px] overflow-auto rounded-md border border-border bg-popover p-2 shadow-lg">
              {sources.map((s) => (
                <label
                  key={s.code}
                  className="flex items-center gap-2 py-1 text-sm cursor-pointer hover:bg-muted rounded px-2"
                >
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(s.code)}
                    onChange={(e) =>
                      setSelectedSources((prev) =>
                        e.target.checked
                          ? [...prev, s.code]
                          : prev.filter((c) => c !== s.code),
                      )
                    }
                  />
                  <span className="flex-1">{s.name}</span>
                  {!s.enabled && (
                    <span className="text-[10px] text-muted-foreground">OFF</span>
                  )}
                </label>
              ))}
              {selectedSources.length > 0 && (
                <button
                  type="button"
                  className="mt-1 w-full text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedSources([])}
                >
                  선택 해제
                </button>
              )}
            </div>
          </details>

          <div className="flex items-center gap-1 text-sm">
            <DateInput value={postedFrom} onChange={setPostedFrom} />
            <span className="text-muted-foreground">~</span>
            <DateInput value={postedTo} onChange={setPostedTo} />
          </div>

          <select
            value={deadlineOnly ?? ""}
            onChange={(e) =>
              setDeadlineOnly(e.target.value ? Number(e.target.value) : null)
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">마감 전체</option>
            <option value="3">D-3 이내</option>
            <option value="7">D-7 이내</option>
            <option value="14">D-14 이내</option>
            <option value="30">D-30 이내</option>
          </select>

          <label className="h-9 inline-flex items-center gap-1 text-sm px-2 rounded-md border border-border bg-background cursor-pointer">
            <input
              type="checkbox"
              checked={bookmarkedOnly}
              onChange={(e) => setBookmarkedOnly(e.target.checked)}
            />
            북마크만
          </label>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="posted_desc">최신 게시순</option>
            <option value="deadline_asc">마감 임박순</option>
            <option value="first_seen_desc">최근 수집순</option>
          </select>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => fetchM.mutate()}
            disabled={fetchM.isPending}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <RefreshCw className={"h-4 w-4 " + (fetchM.isPending ? "animate-spin" : "")} />
            {fetchM.isPending ? "수집 중…" : "지금 수집"}
          </button>
        </div>

        {/* 그리드 — 서버 페이지네이션 + compact 폰트 */}
        <DataGrid<Announcement>
          rowData={rows}
          columnDefs={columnDefs}
          hideSearch
          enableCheckbox={false}
          compact
          disableFilters
          getRowId={(r) => r.id}
          onRowDoubleClicked={(r) => setDetailId(r.id)}
          autoSizeStrategy={{
            type: "fitCellContents",
            // 명시적 width 가 있는 컬럼은 제외 — autoSize 가 덮어쓰지 않도록.
            colIds: [],
          }}
          serverPagination={{
            page,
            pageSize,
            totalCount: pageData?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: (n) => {
              setPageSize(n);
              setPage(1);
            },
            pageSizeOptions: [20, 50, 100, 200, 500],
          }}
        />
      </div>

      <AnnouncementDetailDrawer
        announcementId={detailId}
        onClose={() => setDetailId(null)}
        onBookmarkToggle={(id, add, memo) =>
          bookmarkM.mutate({ id, add, memo })
        }
      />
    </>
  );
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  // 대시보드 Kpi 와 동일 스타일 — text-sm 라벨 + text-2xl bold 값.
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm font-display">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}
