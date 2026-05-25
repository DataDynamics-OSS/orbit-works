"use client";

/**
 * 북마크 드로어 — 우측 슬라이드, 폭 360 (메모/계산기/달력 동일).
 *
 * 두 탭:
 * - 내 북마크 (PERSONAL) — 본인이 추가·수정·삭제. category 자유 입력.
 * - 공용 북마크 (COMPANY) — ADMIN/HR 가 Settings 에서 관리. 본 탭에서는 조회만.
 *
 * 표시 정책: URL 은 노출 X, 표시명 클릭 → window.open(_blank). info 가 있으면
 * ⓘ 버튼 → 인라인 펼침 (기본 마스킹) + 표시 토글 + 복사 버튼. 카테고리별 그룹.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark as BookmarkIcon,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { useBookmark } from "./BookmarkProvider";
import { TabBar, TabItem } from "@/components/ui/TabBar";

type BookmarkScope = "PERSONAL" | "COMPANY";

type Bookmark = {
  id: string;
  scope: BookmarkScope;
  owner_user_id: string | null;
  category: string | null;
  label: string;
  url: string;
  // 백엔드가 권한 없는 사용자에게는 null 로 sanitize 후 응답 — 프론트는 그대로 사용.
  info: string | null;
  visible_roles: string[] | null;
  info_visible_roles: string[] | null;
  sort_order: number;
  can_edit: boolean;
};

type DraftForm = {
  label: string;
  url: string;
  category: string;
  info: string;
};

const EMPTY_DRAFT: DraftForm = {
  label: "",
  url: "",
  category: "",
  info: "",
};

function normalizeUrl(s: string): string {
  const t = s.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return "https://" + t;
}

// 카테고리 헤더 — indigo 단일 톤. "기타" 는 slate 로 고정 (미지정 fallback
// 그룹임을 시각적으로 구분).
const DEFAULT_TONE = { bg: "bg-indigo-100", text: "text-indigo-700" };
const ETC_TONE = { bg: "bg-slate-100", text: "text-slate-700" };

function categoryTone(name: string): { bg: string; text: string } {
  return name === "기타" ? ETC_TONE : DEFAULT_TONE;
}

export function BookmarkDrawer() {
  const { isOpen, close } = useBookmark();
  const [tab, setTab] = useState<BookmarkScope>("PERSONAL");

  // ESC 닫기.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  return (
    <div
      className={
        "fixed top-0 right-0 h-full z-40 transition-transform duration-200 ease-out " +
        (isOpen ? "translate-x-0" : "translate-x-full pointer-events-none")
      }
      aria-hidden={!isOpen}
      style={{ width: 360 }}
    >
      <div className="h-full flex flex-col bg-card border-l border-border shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <BookmarkIcon className="h-4 w-4" />
            <h2 className="text-sm font-semibold">북마크</h2>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="닫기"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 pt-2 shrink-0">
          <TabBar>
            <TabItem
              active={tab === "PERSONAL"}
              onClick={() => setTab("PERSONAL")}
            >
              내 북마크
            </TabItem>
            <TabItem
              active={tab === "COMPANY"}
              onClick={() => setTab("COMPANY")}
            >
              공용 북마크
            </TabItem>
          </TabBar>
        </div>

        <BookmarkPane scope={tab} active={isOpen} />
      </div>
    </div>
  );
}

function BookmarkPane({
  scope,
  active,
}: {
  scope: BookmarkScope;
  active: boolean;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 처음 COMPANY 탭 진입 시 모든 카테고리 접힘 — 카테고리 목록만 한눈에.
  // PERSONAL 은 펼침 default 유지. 사용자가 토글하면 그 상태 유지.
  // scope 가 다른 값으로 바뀌었다 다시 돌아오면 다시 default 로 리셋.
  const initializedScopeRef = useRef<BookmarkScope | null>(null);

  const { data: rows = [] } = useQuery<Bookmark[]>({
    queryKey: ["bookmarks", scope.toLowerCase()],
    queryFn: async () =>
      (
        await api.get("/bookmarks", {
          params: { scope: scope.toLowerCase() },
        })
      ).data,
    enabled: active,
    staleTime: 30_000,
  });

  // scope 별 default 펼침/접힘 상태 — 데이터 로드 후 1회만 적용.
  // ref 가 현재 scope 와 같으면 사용자가 이미 토글한 상태이므로 건드리지 않음.
  useEffect(() => {
    if (initializedScopeRef.current === scope) return;
    if (rows.length === 0) return;
    if (scope === "COMPANY") {
      setCollapsed(
        new Set(rows.map((r) => r.category?.trim() || "기타")),
      );
    } else {
      setCollapsed(new Set());
    }
    initializedScopeRef.current = scope;
  }, [scope, rows]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (b) =>
            b.label.toLowerCase().includes(q) ||
            (b.category ?? "").toLowerCase().includes(q),
        )
      : rows;
    const m = new Map<string, Bookmark[]>();
    for (const b of filtered) {
      const key = b.category?.trim() || "기타";
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    }
    return [...m.entries()].sort((a, b) => {
      // "기타" 그룹은 마지막으로.
      if (a[0] === "기타" && b[0] !== "기타") return 1;
      if (b[0] === "기타" && a[0] !== "기타") return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [rows, search]);

  function buildPayload() {
    return {
      label: draft.label.trim(),
      url: normalizeUrl(draft.url),
      info: draft.info.trim() || null,
      category: draft.category.trim() || null,
    };
  }

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post("/bookmarks", { scope, ...buildPayload() })).data,
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["bookmarks", scope.toLowerCase()] });
    },
  });

  const updateM = useMutation({
    mutationFn: async (id: string) =>
      (await api.patch(`/bookmarks/${id}`, buildPayload())).data,
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["bookmarks", scope.toLowerCase()] });
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/bookmarks/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["bookmarks", scope.toLowerCase()] }),
  });

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function startEdit(b: Bookmark) {
    setAdding(false);
    setEditingId(b.id);
    setDraft({
      label: b.label,
      url: b.url,
      category: b.category ?? "",
      info: b.info ?? "",
    });
  }

  function cancelForm() {
    setAdding(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  const inputCls =
    "w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
      <div className="flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="검색"
          className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          {search ? "검색 결과 없음" : "등록된 북마크가 없습니다."}
        </div>
      ) : (
        grouped.map(([name, items]) => {
          const tone = categoryTone(name);
          return (
          <section key={name} className="rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => toggleGroup(name)}
              className={
                "flex w-full items-center justify-between gap-2 px-2 py-1.5 text-xs font-semibold transition-[filter] hover:brightness-95 " +
                tone.bg +
                " " +
                tone.text
              }
            >
              <span className="inline-flex items-center gap-1">
                {collapsed.has(name) ? (
                  <ChevronRight className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {name}
              </span>
              <span className="tabular-nums opacity-70">
                {items.length}
              </span>
            </button>
            {!collapsed.has(name) && (
              <ul className="divide-y divide-border border-t border-border">
                {items.map((b) =>
                  editingId === b.id ? (
                    <li key={b.id} className="p-2 space-y-1.5">
                      <BookmarkForm
                        draft={draft}
                        setDraft={setDraft}
                        inputCls={inputCls}
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={cancelForm}
                          className="h-6 rounded border border-border bg-background px-2 text-[11px] hover:bg-muted"
                        >
                          취소
                        </button>
                        <button
                          type="button"
                          disabled={
                            updateM.isPending || !draft.label.trim() || !draft.url.trim()
                          }
                          onClick={() => updateM.mutate(b.id)}
                          className="h-6 inline-flex items-center gap-1 rounded bg-primary px-2 text-[11px] text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                        >
                          <Save className="h-3 w-3" /> 저장
                        </button>
                      </div>
                    </li>
                  ) : (
                    <BookmarkRow
                      key={b.id}
                      b={b}
                      onEdit={startEdit}
                      onDelete={(id) => {
                        if (window.confirm("삭제하시겠습니까?"))
                          deleteM.mutate(id);
                      }}
                    />
                  ),
                )}
              </ul>
            )}
          </section>
          );
        })
      )}

      {/* 내 북마크 탭에서만 추가 가능 — 공용 북마크는 Settings 에서 관리. */}
      {scope === "PERSONAL" && (
        <div>
          {adding ? (
            <div className="rounded-md border border-border bg-background p-2 space-y-1.5">
              <BookmarkForm
                draft={draft}
                setDraft={setDraft}
                inputCls={inputCls}
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={cancelForm}
                  className="h-6 rounded border border-border bg-background px-2 text-[11px] hover:bg-muted"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={
                    createM.isPending || !draft.label.trim() || !draft.url.trim()
                  }
                  onClick={() => createM.mutate()}
                  className="h-6 inline-flex items-center gap-1 rounded bg-primary px-2 text-[11px] text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                >
                  <Save className="h-3 w-3" /> 저장
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(EMPTY_DRAFT);
                setAdding(true);
              }}
              className="w-full h-8 inline-flex items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              북마크 추가
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BookmarkForm({
  draft,
  setDraft,
  inputCls,
}: {
  draft: DraftForm;
  setDraft: (next: DraftForm) => void;
  inputCls: string;
}) {
  return (
    <>
      <input
        autoFocus
        value={draft.label}
        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        placeholder="표시명 *"
        className={inputCls}
      />
      <input
        value={draft.url}
        onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        placeholder="URL * (예: example.com)"
        className={inputCls}
      />
      <input
        value={draft.category}
        onChange={(e) => setDraft({ ...draft, category: e.target.value })}
        placeholder="카테고리 (옵션)"
        className={inputCls}
      />
      <textarea
        value={draft.info}
        onChange={(e) => setDraft({ ...draft, info: e.target.value })}
        placeholder="정보 (옵션, 로그인 정보 등)"
        rows={3}
        className={inputCls + " font-mono"}
      />
    </>
  );
}

function BookmarkRow({
  b,
  onEdit,
  onDelete,
}: {
  b: Bookmark;
  onEdit: (b: Bookmark) => void;
  onDelete: (id: string) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  // 백엔드가 권한 없는 사용자에게 info=null 로 sanitize 후 응답하므로 프론트는
  // 단순히 값 유무만 검사. info_visible_roles 룰은 서버 단계에서 적용됨.
  const hasInfo = !!b.info && b.info.length > 0;

  function open() {
    window.open(b.url, "_blank", "noopener,noreferrer");
  }

  async function copy() {
    if (!b.info) return;
    try {
      await navigator.clipboard.writeText(b.info);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 클립보드 권한 없음 — 무시 */
    }
  }

  return (
    <li className="px-2 py-2">
      <div className="flex items-start justify-between gap-1.5">
        <button
          type="button"
          onClick={open}
          className="inline-flex items-start gap-1 text-left text-xs text-foreground hover:text-primary"
          title={b.url}
        >
          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words font-medium">{b.label}</span>
        </button>
        <div className="flex items-center gap-1 text-muted-foreground">
          {hasInfo && (
            <button
              type="button"
              onClick={() => setShowInfo((v) => !v)}
              title={showInfo ? "정보 접기" : "정보 펼침"}
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted hover:text-foreground"
            >
              <Info className="h-3 w-3" />
            </button>
          )}
          {b.can_edit && (
            <>
              <button
                type="button"
                onClick={() => onEdit(b)}
                title="편집"
                className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => onDelete(b.id)}
                title="삭제"
                className="h-6 w-6 inline-flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {hasInfo && showInfo && (
        <div className="mt-1.5 rounded-md border border-border bg-muted/40 p-2">
          <div className="mb-1 flex items-center justify-between gap-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              정보
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                title={reveal ? "마스킹" : "표시"}
                className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              >
                {reveal ? (
                  <EyeOff className="h-3 w-3" />
                ) : (
                  <Eye className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                onClick={copy}
                title="복사"
                className="h-5 inline-flex items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <Copy className="h-3 w-3" />
                {copied ? "복사됨" : "복사"}
              </button>
            </div>
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
            {reveal ? b.info : (b.info ?? "").replace(/[^\s]/g, "•")}
          </pre>
        </div>
      )}
    </li>
  );
}
