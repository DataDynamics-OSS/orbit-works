"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  Download,
  FileText,
  Forward,
  Inbox,
  Mail,
  Paperclip,
  PenSquare,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Settings,
  Star,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { EmailAccountManager } from "@/components/email/EmailAccountManager";
import { InlineReply, ReplyMode } from "@/components/email/InlineReply";
import {
  Label,
  LabelBadge,
  LabelApplyMenu,
  LabelManageDialog,
  useLabels,
} from "@/components/email/labels";
import { TocResizer } from "@/components/ui/TocResizer";

type Account = {
  id: string;
  display_name: string;
  email_addr: string;
  kind: string;
  last_sync_at: string | null;
  last_error: string | null;
  can_manage?: boolean;
};

type Folder = {
  id: string;
  name: string;
  role: string | null;
  total_count: number;
  unseen_count: number;
};

type MessageItem = {
  id: string;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  snippet: string | null;
  received_at: string | null;
  has_attachments: boolean;
  is_seen: boolean;
  is_flagged: boolean;
  is_archived: boolean;
  label_ids: string[];
};

type Page<T> = { items: T[]; total: number; limit: number; offset: number };

type Outbox = {
  id: string;
  to_addrs: string[];
  cc_addrs: string[] | null;
  bcc_addrs: string[] | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: { filename: string; file_path: string; content_type: string | null }[] | null;
  status: string;
  sender_name: string | null;
  created_at: string;
  sent_at: string | null;
};

type Attachment = {
  id: string;
  filename: string;
  content_type: string | null;
  is_inline: boolean;
  size_bytes: number | null;
  cached: boolean;
};

type MessageDetail = MessageItem & {
  to_addrs: string[] | null;
  cc_addrs: string[] | null;
  reply_to: string | null;
  sent_at: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: Attachment[];
};

const PAGE_SIZE = 50;

function fmtDate(v: string | null): string {
  return v ? new Date(v).toLocaleString("ko-KR") : "—";
}

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function blobDownload(url: string, filename: string, onError: (m: string) => void) {
  try {
    const res = await api.get(url, { responseType: "blob" });
    const objUrl = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
  } catch (e: any) {
    onError(e?.response?.data?.detail ?? "다운로드 실패");
  }
}

// 계정 선택 드롭다운 — 닫힌 상태엔 표시 이름만, 펼치면 이름 아래 메일 주소 표시.
// 네이티브 <select> 는 옵션을 2줄(부제)로 못 그리므로 커스텀 드롭다운.
function AccountSelect({
  accounts,
  value,
  onChange,
}: {
  accounts: Account[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = accounts.find((a) => a.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => accounts.length > 0 && setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-1 rounded-md border border-input bg-background px-2 text-sm"
      >
        <span className="truncate">
          {selected ? selected.display_name : "계정 없음"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {open && accounts.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-card shadow-md">
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                onChange(a.id);
                setOpen(false);
              }}
              className={`block w-full px-2 py-1.5 text-left hover:bg-muted ${
                a.id === value ? "bg-muted/60" : ""
              }`}
            >
              <div className="truncate text-sm font-medium">{a.display_name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {a.email_addr}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EmailPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 일괄 작업용 다중 선택(체크박스).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [managerOpen, setManagerOpen] = useState(false);
  // 본문 인라인 편집 모드. 새 메일("작성")은 composing, 답장 계열은 replyMode.
  const [composing, setComposing] = useState(false);
  const [replyMode, setReplyMode] = useState<ReplyMode | null>(null);
  useEffect(() => {
    setReplyMode(null);
  }, [selectedId]);
  // 좌측 뷰 — 일반 메일 vs 임시보관함.
  const [view, setView] = useState<"mail" | "drafts">("mail");
  // 임시보관 편집 중인 항목(우측에 편집기로 표시).
  const [editingDraft, setEditingDraft] = useState<Outbox | null>(null);
  // 라벨 필터(사이드바에서 선택한 라벨). null = 전체.
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  // 라벨 적용 드롭다운 열림(목록 선택 / 상세 단건).
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [detailLabelMenuOpen, setDetailLabelMenuOpen] = useState(false);
  // 라벨 관리 다이얼로그.
  const [labelManageOpen, setLabelManageOpen] = useState(false);
  // 메일 목록 폭 — 드래그 separator 로 조정, localStorage 영속.
  const [listWidth, setListWidth] = useState<number>(380);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = Number(window.localStorage.getItem("email-list-width"));
    if (Number.isFinite(w) && w >= 280 && w <= 640) setListWidth(w);
  }, []);

  // 계정 목록 — 진입 시 첫 계정 자동 선택.
  const { data: accounts } = useQuery<Account[]>({
    queryKey: ["email-accounts"],
    queryFn: async () => (await api.get("/email/accounts")).data,
  });
  useEffect(() => {
    if (accountId === null && accounts && accounts.length > 0) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  // 폴더 목록.
  const { data: folders } = useQuery<Folder[]>({
    queryKey: ["email-folders", accountId],
    queryFn: async () =>
      (await api.get(`/email/accounts/${accountId}/folders`)).data,
    enabled: !!accountId,
  });

  // 메시지 목록.
  const { data: page, isFetching } = useQuery<Page<MessageItem>>({
    queryKey: ["email-messages", accountId, folderId, labelFilter, q, offset],
    queryFn: async () =>
      (
        await api.get("/email/messages", {
          params: {
            account_id: accountId,
            folder_id: folderId || undefined,
            label_id: labelFilter || undefined,
            q: q || undefined,
            limit: PAGE_SIZE,
            offset,
          },
        })
      ).data,
    enabled: !!accountId,
    placeholderData: (prev) => prev,
  });

  // 라벨 목록 + id→라벨 맵(배지 렌더용).
  const { data: labels } = useLabels(accountId);
  const labelList: Label[] = labels ?? [];
  const labelMap = useMemo(
    () => new Map(labelList.map((l) => [l.id, l])),
    [labelList],
  );

  // 선택 메시지 상세.
  const { data: detail } = useQuery<MessageDetail>({
    queryKey: ["email-message", selectedId],
    queryFn: async () => (await api.get(`/email/messages/${selectedId}`)).data,
    enabled: !!selectedId,
  });

  // 임시보관함 목록.
  const { data: drafts } = useQuery<Outbox[]>({
    queryKey: ["email-outbox", accountId, "DRAFT"],
    queryFn: async () =>
      (
        await api.get("/email/outbox", {
          params: { account_id: accountId, status: "DRAFT" },
        })
      ).data,
    enabled: !!accountId && view === "drafts",
  });

  const deleteDraftM = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/email/outbox/${id}`)).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["email-outbox", accountId, "DRAFT"] }),
  });

  const syncM = useMutation({
    mutationFn: async () =>
      (await api.post(`/email/accounts/${accountId}/sync`)).data,
    onSuccess: async (data: any) => {
      qc.invalidateQueries({ queryKey: ["email-folders", accountId] });
      qc.invalidateQueries({ queryKey: ["email-messages"] });
      if (data?.status === "OK") {
        await dialog.alert(
          `동기화 완료 — 새 메일 ${data.inserted}건 (조회 ${data.fetched}건)`,
        );
      } else {
        await dialog.alert(data?.error ?? "동기화 실패", { title: "동기화" });
      }
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "동기화 실패", { title: "오류" }),
  });

  const refreshLists = () => {
    qc.invalidateQueries({ queryKey: ["email-messages"] });
    qc.invalidateQueries({ queryKey: ["email-folders", accountId] });
  };

  const patchM = useMutation({
    mutationFn: async (v: { id: string; body: Record<string, boolean> }) =>
      (await api.patch(`/email/messages/${v.id}`, v.body)).data,
    onSuccess: (_d, v) => {
      refreshLists();
      qc.invalidateQueries({ queryKey: ["email-message", v.id] });
    },
  });

  const moveM = useMutation({
    mutationFn: async (v: { id: string; kind: "archive" | "trash" }) =>
      (await api.post(`/email/messages/${v.id}/${v.kind}`)).data,
    onSuccess: () => {
      refreshLists();
      setSelectedId(null);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "처리 실패", { title: "오류" }),
  });

  // 선택 메일 일괄 삭제(휴지통). 기존 /messages/bulk(action=TRASH) 재사용.
  const bulkDeleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      (await api.post("/email/messages/bulk", { email_ids: ids, action: "TRASH" }))
        .data,
    onSuccess: (_d, ids) => {
      refreshLists();
      setSelectedIds(new Set());
      if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await dialog.confirm(`선택한 ${ids.length}개 메일을 삭제할까요?`, {
      destructive: true,
    });
    if (ok) bulkDeleteM.mutate(ids);
  }

  function openMessage(m: MessageItem) {
    setSelectedId(m.id);
    if (!m.is_seen) patchM.mutate({ id: m.id, body: { is_seen: true } });
  }

  const rows = page?.items ?? [];
  const total = page?.total ?? 0;
  const selectedAccount = useMemo(
    () => accounts?.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );

  function selectFolder(id: string | null) {
    setView("mail");
    setFolderId(id);
    setLabelFilter(null);
    setOffset(0);
    setSelectedId(null);
    setSelectedIds(new Set());
    setComposing(false);
    setEditingDraft(null);
  }

  function selectLabel(id: string) {
    setView("mail");
    setFolderId(null);
    setLabelFilter(id);
    setOffset(0);
    setSelectedId(null);
    setSelectedIds(new Set());
    setComposing(false);
    setEditingDraft(null);
  }

  function openDrafts() {
    setView("drafts");
    setLabelFilter(null);
    setSelectedId(null);
    setSelectedIds(new Set());
    setComposing(false);
    setEditingDraft(null);
  }

  function openDraft(d: Outbox) {
    setComposing(false);
    setEditingDraft(d);
  }

  function runSearch() {
    setQ(qInput.trim());
    setOffset(0);
    setSelectedId(null);
    setSelectedIds(new Set());
  }

  // 현재 페이지 메일 전체 선택 여부 + 토글.
  const allSelected = rows.length > 0 && rows.every((m) => selectedIds.has(m.id));
  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (rows.every((m) => prev.has(m.id))) {
        rows.forEach((m) => next.delete(m.id));
      } else {
        rows.forEach((m) => next.add(m.id));
      }
      return next;
    });
  }

  return (
    <>
      <DashboardHeader
        title="메일"
        actions={
          <>
            <button
              type="button"
              onClick={() => {
                setReplyMode(null);
                setEditingDraft(null);
                setComposing(true);
              }}
              disabled={!accountId}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <PenSquare className="h-4 w-4" />
              작성
            </button>
            <button
              type="button"
              onClick={() => syncM.mutate()}
              disabled={!accountId || syncM.isPending}
              className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${syncM.isPending ? "animate-spin" : ""}`}
              />
              동기화
            </button>
            <button
              type="button"
              onClick={() => setManagerOpen(true)}
              className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <Settings className="h-4 w-4" />
              계정 관리
            </button>
          </>
        }
      />

      <div className="flex flex-1 min-h-0">
        {/* 좌: 계정 + 폴더 */}
        <aside className="w-60 shrink-0 border-r border-border bg-card flex flex-col">
          <div className="p-3 border-b border-border">
            <AccountSelect
              accounts={accounts ?? []}
              value={accountId}
              onChange={(id) => {
                setAccountId(id);
                selectFolder(null);
              }}
            />
          </div>
          <nav className="flex-1 overflow-auto p-2 space-y-0.5">
            <button
              type="button"
              onClick={() => selectFolder(null)}
              className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
                view === "mail" && folderId === null && !labelFilter
                  ? "bg-muted font-medium"
                  : ""
              }`}
            >
              <Mail className="h-4 w-4" /> 전체
            </button>
            {(folders ?? []).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFolder(f.id)}
                className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
                  view === "mail" && folderId === f.id ? "bg-muted font-medium" : ""
                }`}
              >
                {f.role === "INBOX" ? (
                  <Inbox className="h-4 w-4" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                <span className="flex-1 truncate text-left">{f.name}</span>
                {f.unseen_count > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">
                    {f.unseen_count}
                  </span>
                )}
              </button>
            ))}
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              onClick={openDrafts}
              className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
                view === "drafts" ? "bg-muted font-medium" : ""
              }`}
            >
              <FileText className="h-4 w-4" /> 임시보관함
              {(drafts?.length ?? 0) > 0 && (
                <span className="ml-auto rounded-full bg-muted-foreground/15 px-1.5 text-[11px]">
                  {drafts!.length}
                </span>
              )}
            </button>

            {/* 라벨 필터 */}
            <div className="mt-2 flex items-center justify-between px-2 pt-2 text-[11px] text-muted-foreground">
              <span>라벨</span>
              <button
                type="button"
                onClick={() => setLabelManageOpen(true)}
                className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                title="라벨 관리"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {labelList.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => selectLabel(l.id)}
                className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
                  view === "mail" && labelFilter === l.id ? "bg-muted font-medium" : ""
                }`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: l.color || "#64748b" }}
                />
                <span className="flex-1 truncate text-left">{l.name}</span>
              </button>
            ))}

            {selectedAccount?.last_error && (
              <div className="mt-2 rounded-md border border-rose-300 bg-rose-50 p-2 text-[11px] text-rose-700">
                마지막 동기화 오류: {selectedAccount.last_error}
              </div>
            )}
          </nav>
        </aside>

        {/* 중: 메시지 목록 */}
        <section
          style={{ width: listWidth }}
          className="shrink-0 border-r border-border flex flex-col min-h-0"
        >
          {view === "mail" ? (
            <div className="p-2 border-b border-border flex items-center gap-1">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSearch()}
                  placeholder="제목·발신·본문 검색"
                  className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm"
                />
              </div>
            </div>
          ) : (
            <div className="border-b border-border p-2 text-sm font-medium">
              임시보관함
            </div>
          )}
          {view === "drafts" ? (
            <div className="flex-1 overflow-auto">
              {(drafts ?? []).length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  임시보관한 메일이 없습니다.
                </div>
              )}
              {(drafts ?? []).map((d) => (
                <div
                  key={d.id}
                  className={`group flex items-start gap-1 border-b border-border px-3 py-2 hover:bg-muted ${
                    editingDraft?.id === d.id ? "bg-muted" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => openDraft(d)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-1">
                      <span className="flex-1 truncate text-sm">
                        {d.to_addrs.join(", ") || "(받는사람 없음)"}
                      </span>
                      {d.attachments && d.attachments.length > 0 && (
                        <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {new Date(d.created_at).toLocaleDateString("ko-KR")}
                      </span>
                    </div>
                    <div className="truncate text-sm font-medium">
                      {d.subject || "(제목 없음)"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {d.body_text || ""}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await dialog.confirm("이 임시보관 메일을 삭제할까요?", {
                        destructive: true,
                      });
                      if (ok) {
                        if (editingDraft?.id === d.id) setEditingDraft(null);
                        deleteDraftM.mutate(d.id);
                      }
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-rose-600 group-hover:opacity-100"
                    aria-label="임시보관 삭제"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
          <div className="flex-1 overflow-auto">
            {rows.length > 0 && (
              <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-border bg-card px-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="전체 선택"
                />
                {selectedIds.size > 0 ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {selectedIds.size}개 선택
                    </span>
                    <div className="relative ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setLabelMenuOpen((v) => !v)}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                      >
                        <TagIcon className="h-3.5 w-3.5" /> 라벨
                      </button>
                      {labelMenuOpen && accountId && (
                        <LabelApplyMenu
                          accountId={accountId}
                          labels={labelList}
                          emailIds={[...selectedIds]}
                          onClose={() => setLabelMenuOpen(false)}
                          onManage={() => {
                            setLabelMenuOpen(false);
                            setLabelManageOpen(true);
                          }}
                        />
                      )}
                      <button
                        type="button"
                        onClick={bulkDelete}
                        disabled={bulkDeleteM.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted hover:text-rose-600 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> 삭제
                      </button>
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">전체 선택</span>
                )}
              </div>
            )}
            {rows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {isFetching ? "불러오는 중…" : "메일이 없습니다. 동기화를 실행하세요."}
              </div>
            )}
            {rows.map((m) => (
              <div
                key={m.id}
                className={`flex items-start gap-2 border-b border-border px-3 py-2 hover:bg-muted ${
                  selectedId === m.id ? "bg-muted" : ""
                } ${m.is_seen ? "" : "bg-primary/[0.03]"}`}
              >
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={selectedIds.has(m.id)}
                  onChange={() => toggleSelect(m.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="메일 선택"
                />
                <button
                  type="button"
                  onClick={() => openMessage(m)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1">
                    {m.is_flagged && (
                      <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                    )}
                    <span
                      className={`flex-1 truncate text-sm ${
                        m.is_seen ? "" : "font-semibold"
                      }`}
                    >
                      {m.from_name || m.from_addr || "(발신자 없음)"}
                    </span>
                    {m.has_attachments && (
                      <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {m.received_at
                        ? new Date(m.received_at).toLocaleDateString("ko-KR")
                        : ""}
                    </span>
                  </div>
                  <div
                    className={`truncate text-sm ${
                      m.is_seen ? "text-foreground/80" : "font-medium"
                    }`}
                  >
                    {m.subject || "(제목 없음)"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {m.snippet}
                  </div>
                  {m.label_ids.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.label_ids
                        .map((id) => labelMap.get(id))
                        .filter((l): l is Label => !!l)
                        .map((l) => (
                          <LabelBadge key={l.id} label={l} />
                        ))}
                    </div>
                  )}
                </button>
              </div>
            ))}
          </div>
          )}
          {view === "mail" && total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-border p-2 text-sm">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="h-8 rounded-md border border-border px-3 hover:bg-muted disabled:opacity-40"
              >
                이전
              </button>
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="h-8 rounded-md border border-border px-3 hover:bg-muted disabled:opacity-40"
              >
                다음
              </button>
            </div>
          )}
        </section>

        {/* 목록 ↔ 본문 사이 드래그 separator (목록이 왼쪽이므로 invert). */}
        <TocResizer
          invert
          width={listWidth}
          onChange={setListWidth}
          storageKey="email-list-width"
          defaultWidth={380}
          min={280}
          max={640}
          ariaLabel="메일 목록 폭 조절"
        />

        {/* 우: 본문 — 헤더 고정 + 본문이 남은 높이를 채우고 자체 스크롤 */}
        <section className="flex-1 min-w-0 flex flex-col min-h-0">
          {editingDraft && accountId ? (
            <InlineReply
              key={`draft-${editingDraft.id}`}
              accountId={accountId}
              original={null}
              mode="new"
              selfAddr={selectedAccount?.email_addr ?? ""}
              draftId={editingDraft.id}
              initial={{
                to: editingDraft.to_addrs.join(", "),
                cc: (editingDraft.cc_addrs ?? []).join(", "),
                bcc: (editingDraft.bcc_addrs ?? []).join(", "),
                subject: editingDraft.subject ?? "",
                bodyHtml: editingDraft.body_html ?? "",
                existingAttachments: (editingDraft.attachments ?? []).map((a) => ({
                  filename: a.filename,
                })),
              }}
              onClose={() => setEditingDraft(null)}
            />
          ) : composing && accountId ? (
            <InlineReply
              key="new-compose"
              accountId={accountId}
              original={null}
              mode="new"
              selfAddr={selectedAccount?.email_addr ?? ""}
              onClose={() => setComposing(false)}
            />
          ) : view === "drafts" ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              임시보관 메일을 선택하세요
            </div>
          ) : !selectedId || !detail ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {selectedId ? "불러오는 중…" : "메일을 선택하세요"}
            </div>
          ) : replyMode && accountId ? (
            <InlineReply
              key={`${selectedId}-${replyMode}`}
              accountId={accountId}
              original={detail}
              mode={replyMode}
              selfAddr={selectedAccount?.email_addr ?? ""}
              onClose={() => setReplyMode(null)}
            />
          ) : (
            <article className="flex flex-1 min-h-0 flex-col">
              {/* 헤더(제목·발신·첨부) — 상단 고정 */}
              <div className="shrink-0 space-y-4 p-5 pb-4">
              <div className="space-y-1">
                <h1 className="text-lg font-semibold leading-snug">
                  {detail.subject || "(제목 없음)"}
                </h1>
                {detail.label_ids.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {detail.label_ids
                      .map((id) => labelMap.get(id))
                      .filter((l): l is Label => !!l)
                      .map((l) => (
                        <LabelBadge key={l.id} label={l} />
                      ))}
                  </div>
                )}
                <div className="text-sm">
                  <span className="font-medium">
                    {detail.from_name || detail.from_addr}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {detail.from_name ? `<${detail.from_addr}>` : ""}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  받는사람: {(detail.to_addrs ?? []).join(", ") || "—"}
                  {detail.cc_addrs && detail.cc_addrs.length > 0
                    ? ` · 참조: ${detail.cc_addrs.join(", ")}`
                    : ""}
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{fmtDate(detail.received_at || detail.sent_at)}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setReplyMode("reply")}
                      title="답장"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                    >
                      <Reply className="h-3 w-3" /> 답장
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplyMode("reply_all")}
                      title="전체답장"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                    >
                      <ReplyAll className="h-3 w-3" /> 전체답장
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplyMode("forward")}
                      title="전달"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                    >
                      <Forward className="h-3 w-3" /> 전달
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setDetailLabelMenuOpen((v) => !v)}
                        title="라벨"
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                      >
                        <TagIcon className="h-3 w-3" /> 라벨
                      </button>
                      {detailLabelMenuOpen && accountId && (
                        <LabelApplyMenu
                          accountId={accountId}
                          labels={labelList}
                          emailIds={[detail.id]}
                          currentLabelIds={detail.label_ids}
                          onClose={() => setDetailLabelMenuOpen(false)}
                          onManage={() => {
                            setDetailLabelMenuOpen(false);
                            setLabelManageOpen(true);
                          }}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        patchM.mutate({
                          id: detail.id,
                          body: { is_flagged: !detail.is_flagged },
                        })
                      }
                      title={detail.is_flagged ? "별표 해제" : "별표"}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                    >
                      <Star
                        className={`h-3 w-3 ${
                          detail.is_flagged ? "fill-amber-400 text-amber-400" : ""
                        }`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveM.mutate({ id: detail.id, kind: "archive" })}
                      title="보관함으로"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                    >
                      <Archive className="h-3 w-3" /> 보관
                    </button>
                    <button
                      type="button"
                      onClick={() => moveM.mutate({ id: detail.id, kind: "trash" })}
                      title="휴지통으로"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted hover:text-rose-600"
                    >
                      <Trash2 className="h-3 w-3" /> 삭제
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        blobDownload(
                          `/email/messages/${detail.id}/raw`,
                          `${(detail.subject || "message").slice(0, 60)}.eml`,
                          (m) => dialog.alert(m),
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                    >
                      <Download className="h-3 w-3" /> 원본(.eml)
                    </button>
                  </div>
                </div>
              </div>

              {detail.attachments.length > 0 && (
                <div className="space-y-1 rounded-md border border-border p-3">
                  <div className="text-[11px] text-muted-foreground">
                    첨부 {detail.attachments.length}개
                  </div>
                  {detail.attachments
                    .filter((a) => !a.is_inline)
                    .map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="flex items-center gap-1 truncate">
                          <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="truncate">{a.filename}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {fmtSize(a.size_bytes)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            blobDownload(
                              `/email/messages/${detail.id}/attachments/${a.id}/download`,
                              a.filename,
                              (m) => dialog.alert(m),
                            )
                          }
                          className="shrink-0 text-primary hover:text-primary/80"
                          aria-label="첨부 다운로드"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                </div>
              )}
              </div>

              {/* 본문 — 남은 높이를 모두 채우고(bottom 을 페이지 하단에 고정) 자체 스크롤.
                  HTML 은 sandbox iframe(스크립트 차단)으로 XSS 안전 렌더. */}
              <div className="min-h-0 flex-1 px-5 pb-5">
                {detail.body_html ? (
                  <iframe
                    title="메일 본문"
                    sandbox=""
                    className="h-full w-full rounded-md border border-border bg-white"
                    srcDoc={detail.body_html}
                  />
                ) : (
                  <div className="h-full overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 text-sm">
                    {detail.body_text || "(본문 없음)"}
                  </div>
                )}
              </div>
            </article>
          )}
        </section>
      </div>

      {managerOpen && (
        <EmailAccountManager onClose={() => setManagerOpen(false)} />
      )}
      {labelManageOpen && accountId && (
        <LabelManageDialog
          accountId={accountId}
          labels={labelList}
          onClose={() => setLabelManageOpen(false)}
        />
      )}
    </>
  );
}
