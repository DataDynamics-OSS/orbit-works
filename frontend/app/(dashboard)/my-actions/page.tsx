"use client";

/**
 * 내 액션 / 팀 액션 / 전체 액션 — 탭 분리.
 *
 * 탭:
 *   - 내 액션 (모든 사용자) : 본인 mapped_developer 가 assignee.
 *   - 팀 액션 (매니저 자동) : 직속 부하 chain 의 액션 (본인 제외).
 *   - 전체 액션 (HR/ADMIN) : tenant 의 모든 액션.
 *
 * 마감일 기준 그룹핑(지남·오늘·이번주·이후·없음). 행 우측 체크박스로 즉시
 * DONE 처리. 행 클릭:
 *   - 회의록 attached → 출처 회의록 점프
 *   - standalone     → 편집 다이얼로그
 *
 * 헤더 우측 "+ 액션 추가" 버튼으로 회의록 없이 본인 명의 standalone 액션
 * 등록. 다이얼로그는 제목 / 설명 / 마감일 / 고객사 / 프로젝트 picker.
 *
 * 모든 수정·삭제는 `/meeting-notes/action-items/{id}` 통합 endpoint 사용
 * (standalone 과 회의록 attached 동일). 권한 체크는 백엔드 _can_edit_action_item
 * (작성자 OR assignee OR ADMIN/HR) 가 담당.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Building2,
  ExternalLink,
  FolderKanban,
  Globe,
  ListChecks,
  MessageSquare,
  Plus,
  Trash2,
  User as UserIcon,
  Users,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type ActionItemStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED";
type ActionItem = {
  id: string;
  meeting_note_id: string | null;
  title: string;
  assignee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  status: ActionItemStatus;
  note_text: string | null;
  completion_comment: string | null;
  note_title: string | null;
  customer_id: string | null;
  project_id: string | null;
  customer_name: string | null;
  project_name: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type CustomerLite = { id: string; name: string };
type ProjectLite = { id: string; name: string; customer_id: string | null };
type MeetingNoteLite = {
  id: string;
  title: string;
  customer_id: string | null;
  customer_name: string | null;
  project_id: string | null;
  project_name: string | null;
  created_at: string;
};

const STATUS_LABELS: Record<ActionItemStatus, string> = {
  TODO: "할 일",
  IN_PROGRESS: "진행",
  DONE: "완료",
  BLOCKED: "막힘",
};
const STATUS_COLORS: Record<ActionItemStatus, string> = {
  TODO: "bg-slate-100 text-slate-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  DONE: "bg-emerald-100 text-emerald-700",
  BLOCKED: "bg-rose-100 text-rose-700",
};

function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function dueGroup(iso: string | null): "overdue" | "today" | "week" | "later" | "none" {
  if (!iso) return "none";
  const today = startOfDay();
  const d = new Date(iso + "T00:00:00");
  if (d.getTime() < today.getTime()) return "overdue";
  if (d.getTime() === today.getTime()) return "today";
  const week = new Date(today);
  week.setDate(week.getDate() + 7);
  if (d.getTime() <= week.getTime()) return "week";
  return "later";
}
const GROUP_LABELS = {
  overdue: "지난 마감",
  today: "오늘",
  week: "이번 주",
  later: "이후",
  none: "기한 없음",
} as const;
const GROUP_COLORS = {
  overdue: "text-rose-600",
  today: "text-amber-700",
  week: "text-foreground",
  later: "text-muted-foreground",
  none: "text-muted-foreground",
} as const;

type DoneBucket = "today" | "thisWeek" | "thisMonth" | "older";

// 완료(DONE) 항목의 completed_at 기준 그룹핑. 주 시작은 월요일.
function completedGroup(at: string | null | undefined): DoneBucket {
  if (!at) return "older";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "older";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const completedDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (completedDay.getTime() === today.getTime()) return "today";
  // Mon=0..Sun=6 로 정규화한 day-of-week.
  const dow = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - dow);
  if (completedDay.getTime() >= weekStart.getTime()) return "thisWeek";
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (completedDay.getTime() >= monthStart.getTime()) return "thisMonth";
  return "older";
}

const DONE_GROUP_LABELS: Record<DoneBucket, string> = {
  today: "오늘",
  thisWeek: "이번 주",
  thisMonth: "이번 달",
  older: "이전",
};

type Scope = "me" | "team" | "all";
type Role = "ADMIN" | "HR" | "SALES" | "SUPPORT" | "ETC" | "SUPER_ADMIN";

export default function MyActionsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();
  // open(진행중: TODO/IN_PROGRESS/BLOCKED) | done(완료: cursor 페이지네이션)
  const [statusTab, setStatusTab] = useState<"open" | "done">("open");
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ActionItem | null>(null);
  const [scope, setScope] = useState<Scope>("me");

  // role / 매니저 여부 — 탭 노출 결정.
  const { data: me } = useQuery<{
    role: Role;
    mapped_developer_id: string | null;
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const isHrAdmin =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  // 매니저 여부 — team scope 호출이 1건이라도 반환하면 매니저로 본다.
  // staleTime 길게 — 페이지 진입 시 1번 fetch.
  const { data: teamProbe = [] } = useQuery<ActionItem[]>({
    queryKey: ["my-action-items", "team-probe"],
    queryFn: async () =>
      (
        await api.get(
          `/meeting-notes/action-items?scope=team&include_done=true`,
        )
      ).data,
    enabled: !!me?.mapped_developer_id,
    staleTime: 60_000,
  });
  const isManager = teamProbe.length > 0;

  // scope 가 disabled 된 탭이면 me 로 fallback.
  useEffect(() => {
    if (scope === "team" && !isManager && me) setScope("me");
    if (scope === "all" && !isHrAdmin && me) setScope("me");
  }, [scope, isManager, isHrAdmin, me]);

  // 진행중(open) 탭 — 기존 endpoint. include_done=false 고정 (DONE 은 별도 탭).
  const { data: items = [], isLoading } = useQuery<ActionItem[]>({
    queryKey: ["my-action-items", scope, "open"],
    queryFn: async () =>
      (
        await api.get(
          `/meeting-notes/action-items?scope=${scope}&include_done=false`,
        )
      ).data,
    enabled: statusTab === "open",
  });

  // 완료(done) 탭 — cursor 페이지네이션. 50건씩 fetch, 스크롤 sentinel 로 next.
  type DonePage = {
    items: ActionItem[];
    next_cursor: { completed_at: string; id: string } | null;
  };
  const doneQuery = useInfiniteQuery<DonePage>({
    queryKey: ["my-action-items", scope, "done"],
    enabled: statusTab === "done",
    initialPageParam: null as { completed_at: string; id: string } | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ scope, limit: "50" });
      const c = pageParam as { completed_at: string; id: string } | null;
      if (c) {
        params.set("cursor_completed_at", c.completed_at);
        params.set("cursor_id", c.id);
      }
      return (
        await api.get(`/meeting-notes/action-items/done?${params.toString()}`)
      ).data;
    },
    getNextPageParam: (last) => last.next_cursor,
  });
  const doneItems: ActionItem[] = useMemo(
    () => doneQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [doneQuery.data],
  );

  // 통합 endpoint — note_id 무관. standalone 도 회의록 attached 도 동일.
  const updateM = useMutation({
    mutationFn: async ({
      itemId,
      ...rest
    }: {
      itemId: string;
      status?: ActionItemStatus;
      completion_comment?: string | null;
      title?: string;
      note_text?: string | null;
      due_date?: string | null;
      customer_id?: string | null;
      project_id?: string | null;
    }) =>
      api.patch(`/meeting-notes/action-items/${itemId}`, rest),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["my-action-items"] }),
  });

  const deleteM = useMutation({
    mutationFn: async (itemId: string) =>
      api.delete(`/meeting-notes/action-items/${itemId}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["my-action-items"] }),
  });

  // 체크박스로 DONE 전이 시 코멘트 prompt → 취소면 변경 안 함, 빈 문자열도 허용.
  const completeWithComment = async (it: ActionItem) => {
    const comment = await dialog.prompt(
      <>
        <b>{it.title}</b>
        <div className="text-xs text-muted-foreground mt-1">
          완료 코멘트를 남기시겠어요? (선택)
        </div>
      </>,
      {
        title: "액션 완료",
        placeholder: "예: PR 머지 완료 / 고객 송부 / 보류 사유",
        confirmText: "완료 처리",
        cancelText: "취소",
      },
    );
    if (comment === null) return;
    updateM.mutate({
      itemId: it.id,
      status: "DONE",
      completion_comment: comment.trim() || null,
    });
  };
  const uncomplete = (it: ActionItem) => {
    updateM.mutate({ itemId: it.id, status: "TODO" });
  };

  const grouped = useMemo(() => {
    const buckets: Record<string, ActionItem[]> = {
      overdue: [], today: [], week: [], later: [], none: [],
    };
    for (const it of items) {
      buckets[dueGroup(it.due_date)].push(it);
    }
    return buckets;
  }, [items]);

  const totalOpen = items.filter((it) => it.status !== "DONE").length;
  const overdueCount = grouped.overdue.filter((it) => it.status !== "DONE").length;

  // 헤더 제목 — 탭 따라 자동 전환. 메뉴 라벨은 '내 액션' 으로 유지.
  const headerTitle =
    scope === "me" ? "내 액션"
    : scope === "team" ? "팀 액션"
    : "전체 액션";

  return (
    <>
      <DashboardHeader
        title={headerTitle}
        actions={
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-4 w-4" />
            액션 추가
          </button>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-auto">
        {/* 탭 — me 는 항상, team 은 매니저, all 은 HR/ADMIN 만. */}
        <div className="flex items-center gap-0 border-b border-border">
          <ScopeTab
            active={scope === "me"}
            onClick={() => setScope("me")}
            icon={<UserIcon className="h-3.5 w-3.5" />}
          >
            내 액션
          </ScopeTab>
          {isManager && (
            <ScopeTab
              active={scope === "team"}
              onClick={() => setScope("team")}
              icon={<Users className="h-3.5 w-3.5" />}
            >
              팀 액션
            </ScopeTab>
          )}
          {isHrAdmin && (
            <ScopeTab
              active={scope === "all"}
              onClick={() => setScope("all")}
              icon={<Globe className="h-3.5 w-3.5" />}
            >
              전체 액션
            </ScopeTab>
          )}
        </div>

        {/* 2차 탭 — segmented control. 완료는 cursor 무한 스크롤. */}
        <div className="inline-flex self-start rounded-md border border-border bg-background p-0.5">
          <StatusTab
            active={statusTab === "open"}
            onClick={() => setStatusTab("open")}
          >
            진행중
          </StatusTab>
          <StatusTab
            active={statusTab === "done"}
            onClick={() => setStatusTab("done")}
          >
            완료
          </StatusTab>
        </div>

        {statusTab === "open" && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-sm">
              <span className="text-muted-foreground">미완료</span>{" "}
              <b className="tabular-nums">{totalOpen}</b>건
              {overdueCount > 0 && (
                <span className="ml-2 text-rose-600 font-semibold">
                  · 지남 {overdueCount}건
                </span>
              )}
            </div>
          </div>
        )}

        {statusTab === "open" && (isLoading ? (
          <div className="text-sm text-muted-foreground">로딩 중…</div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <ListChecks className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <div className="text-sm">
              {scope === "me"
                ? "담당 액션 아이템이 없습니다."
                : scope === "team"
                  ? "부하의 액션이 없습니다."
                  : "tenant 의 액션이 없습니다."}
            </div>
            {scope === "me" && (
              <div className="text-xs mt-2">
                우상단 <b>+ 액션 추가</b> 로 본인 액션을 직접 등록하거나, 회의록의
                액션 탭에서 등록하세요.
              </div>
            )}
          </div>
        ) : (
          (["overdue", "today", "week", "later", "none"] as const).map(
            (g) =>
              grouped[g].length > 0 && (
                <section key={g} className="space-y-1">
                  <div className={"text-xs font-semibold " + GROUP_COLORS[g]}>
                    {GROUP_LABELS[g]} ({grouped[g].length})
                  </div>
                  <ul className="divide-y divide-border border border-border rounded-md bg-card">
                    {grouped[g].map((it) => (
                      <li
                        key={it.id}
                        className={
                          "flex items-start gap-3 p-3 hover:bg-muted/30 " +
                          (it.status === "DONE" ? "opacity-60" : "")
                        }
                      >
                        <input
                          type="checkbox"
                          checked={it.status === "DONE"}
                          onChange={(e) => {
                            if (e.target.checked) completeWithComment(it);
                            else uncomplete(it);
                          }}
                          className="mt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            // standalone → 편집 다이얼로그, attached → 회의록 점프
                            if (it.meeting_note_id) {
                              router.push(`/meeting-notes/${it.meeting_note_id}`);
                            } else {
                              setEditTarget(it);
                            }
                          }}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div
                            className={
                              "text-sm " +
                              (it.status === "DONE" ? "line-through" : "")
                            }
                          >
                            {it.title}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                            <span
                              className={
                                "inline-block px-1.5 py-0.5 rounded " +
                                STATUS_COLORS[it.status]
                              }
                            >
                              {STATUS_LABELS[it.status]}
                            </span>
                            {/* 본인이 아닌 액션은 담당자 표시 (team / all 탭). */}
                            {scope !== "me" && it.assignee_name && (
                              <span className="inline-flex items-center gap-1 text-foreground font-medium">
                                <UserIcon className="h-3 w-3" />
                                {it.assignee_name}
                              </span>
                            )}
                            {it.due_date && (
                              <span
                                className={
                                  g === "overdue"
                                    ? "text-rose-600 font-semibold"
                                    : g === "today"
                                      ? "text-amber-700 font-semibold"
                                      : "text-muted-foreground"
                                }
                              >
                                📅 {it.due_date}
                              </span>
                            )}
                            {it.meeting_note_id && it.note_title && (
                              <span className="text-muted-foreground inline-flex items-center gap-1">
                                <ExternalLink className="h-3 w-3" />
                                {it.note_title}
                              </span>
                            )}
                            {!it.meeting_note_id && (
                              <span className="text-muted-foreground inline-flex items-center gap-1 italic">
                                (개인 액션)
                              </span>
                            )}
                            {it.customer_name && (
                              <span className="text-muted-foreground inline-flex items-center gap-1">
                                <Building2 className="h-3 w-3" />
                                {it.customer_name}
                              </span>
                            )}
                            {it.project_name && (
                              <span className="text-muted-foreground inline-flex items-center gap-1">
                                <FolderKanban className="h-3 w-3" />
                                {it.project_name}
                              </span>
                            )}
                            {it.note_text && (
                              <span className="text-muted-foreground italic">
                                · {it.note_text}
                              </span>
                            )}
                            {it.completion_comment && (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <MessageSquare className="h-3 w-3" />
                                {it.completion_comment}
                              </span>
                            )}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )
        ))}

        {statusTab === "done" && (
          <DoneList
            scope={scope}
            items={doneItems}
            isLoading={doneQuery.isLoading}
            hasMore={!!doneQuery.hasNextPage}
            isFetchingMore={doneQuery.isFetchingNextPage}
            onLoadMore={() => doneQuery.fetchNextPage()}
            onUncomplete={uncomplete}
            onClickItem={(it) => {
              if (it.meeting_note_id) {
                router.push(`/meeting-notes/${it.meeting_note_id}`);
              } else {
                setEditTarget(it);
              }
            }}
          />
        )}
      </div>

      <ActionItemDialog
        open={addOpen || !!editTarget}
        mode={editTarget ? "edit" : "create"}
        initial={editTarget}
        onClose={() => {
          setAddOpen(false);
          setEditTarget(null);
        }}
        onDelete={
          editTarget
            ? async () => {
                const ok = await dialog.confirm(
                  "이 액션을 삭제하시겠습니까?",
                  { title: "삭제 확인", confirmText: "삭제" },
                );
                if (!ok) return;
                await deleteM.mutateAsync(editTarget.id);
                setEditTarget(null);
              }
            : undefined
        }
        onSubmit={async (form) => {
          if (editTarget) {
            await updateM.mutateAsync({ itemId: editTarget.id, ...form });
            setEditTarget(null);
          } else {
            await api.post("/meeting-notes/action-items", form);
            await qc.invalidateQueries({ queryKey: ["my-action-items"] });
            setAddOpen(false);
          }
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 다이얼로그
// ---------------------------------------------------------------------------

type FormPayload = {
  title: string;
  note_text: string | null;
  due_date: string | null;
  customer_id: string | null;
  project_id: string | null;
  /** create 모드에서만 보냄 — edit 모드는 변경 안 함. */
  meeting_note_id?: string | null;
};

function ActionItemDialog({
  open,
  mode,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: {
  open: boolean;
  mode: "create" | "edit";
  initial: ActionItem | null;
  onClose: () => void;
  onSubmit: (form: FormPayload) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [customerId, setCustomerId] = useState<string>("");
  const [projectId, setProjectId] = useState<string>("");
  // 회의록 첨부 — create 모드에서만 노출. edit 모드는 기존 첨부 표시만.
  const [meetingNoteId, setMeetingNoteId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const dialog = useDialog();

  // 다이얼로그가 열릴 때 폼 초기화 (edit 모드는 기존 값 채움).
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setTitle(initial.title);
      setNoteText(initial.note_text ?? "");
      setDueDate(initial.due_date ?? "");
      setCustomerId(initial.customer_id ?? "");
      setProjectId(initial.project_id ?? "");
      setMeetingNoteId(initial.meeting_note_id ?? "");
    } else {
      setTitle("");
      setNoteText("");
      setDueDate("");
      setCustomerId("");
      setProjectId("");
      setMeetingNoteId("");
    }
  }, [open, initial]);

  // 모든 role 사용 — 메뉴 권한과 별개의 공용 picker.
  const { data: customers = [] } = useQuery<CustomerLite[]>({
    queryKey: ["pickers", "customers"],
    queryFn: async () => (await api.get("/pickers/customers")).data,
    staleTime: 5 * 60_000,
    enabled: open,
  });
  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ["pickers", "projects"],
    queryFn: async () => (await api.get("/pickers/projects")).data,
    staleTime: 5 * 60_000,
    enabled: open,
  });
  // 본인이 접근 가능한 회의록 — 작성자 또는 공유받은 회의록 (백엔드 _can_read).
  // create 모드에서만 fetch (edit 모드는 회의록 변경 불가).
  const { data: meetingNotes = [] } = useQuery<MeetingNoteLite[]>({
    queryKey: ["meeting-notes", "all"],
    queryFn: async () => (await api.get("/meeting-notes?scope=all")).data,
    staleTime: 60_000,
    enabled: open && mode === "create",
  });

  // 정렬 — 최신 회의록 먼저 (created_at desc).
  const sortedNotes = useMemo(
    () =>
      meetingNotes.slice().sort(
        (a, b) => b.created_at.localeCompare(a.created_at),
      ),
    [meetingNotes],
  );

  // 회의록 선택 시 그 회의록의 customer/project 를 액션에도 자동 적용
  // (사용자가 비워둔 경우에만). 이미 입력했으면 덮어쓰지 않음.
  useEffect(() => {
    if (!meetingNoteId) return;
    const note = meetingNotes.find((n) => n.id === meetingNoteId);
    if (!note) return;
    if (!customerId && note.customer_id) setCustomerId(note.customer_id);
    if (!projectId && note.project_id) setProjectId(note.project_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingNoteId, meetingNotes]);

  const sortedCustomers = useMemo(
    () => customers.slice().sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [customers],
  );
  const filteredProjects = useMemo(() => {
    const list = customerId
      ? projects.filter((p) => p.customer_id === customerId)
      : projects;
    return list.slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [projects, customerId]);

  // 고객사 변경 시 현재 프로젝트가 그 고객 소속이 아니면 초기화.
  useEffect(() => {
    if (!projectId) return;
    if (!customerId) return;
    const p = projects.find((x) => x.id === projectId);
    if (p && p.customer_id !== customerId) setProjectId("");
  }, [customerId, projectId, projects]);

  const submit = async () => {
    const t = title.trim();
    if (!t) {
      await dialog.alert("제목을 입력하세요.", { title: "확인" });
      return;
    }
    setBusy(true);
    try {
      const payload: FormPayload = {
        title: t,
        note_text: noteText.trim() || null,
        due_date: dueDate || null,
        customer_id: customerId || null,
        project_id: projectId || null,
      };
      // 회의록 attach 는 create 모드에서만 적용. edit 은 기존 첨부 유지.
      if (mode === "create") {
        payload.meeting_note_id = meetingNoteId || null;
      }
      await onSubmit(payload);
    } catch (e: any) {
      await dialog.alert(
        e?.response?.data?.detail ?? "저장에 실패했습니다.",
        { title: "오류" },
      );
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "edit" ? "액션 수정" : "액션 추가"}
      width="max-w-lg"
      footer={
        <>
          {mode === "edit" && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="h-9 mr-auto inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              삭제
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {busy ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="제목" colSpan={2}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="할 일을 한 줄로"
            className={inputCls}
            autoFocus
          />
        </Field>
        <Field label="설명 (선택)" colSpan={2}>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={2}
            placeholder="배경·맥락·세부 사항"
            className={inputCls + " resize-none"}
          />
        </Field>
        {/* 회의록 picker — create 모드에서만 변경 가능. edit 은 read-only 표시. */}
        {mode === "create" ? (
          <Field label="회의록 (선택)" colSpan={2}>
            <select
              value={meetingNoteId}
              onChange={(e) => setMeetingNoteId(e.target.value)}
              className={inputCls}
            >
              <option value="">미지정 (개인 액션)</option>
              {sortedNotes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                  {n.customer_name ? ` — ${n.customer_name}` : ""}
                  {n.project_name ? ` / ${n.project_name}` : ""}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground">
              회의록 선택 시 해당 회의록의 고객사·프로젝트를 자동 채웁니다 (수정 가능).
            </span>
          </Field>
        ) : initial?.meeting_note_id ? (
          <Field label="회의록" colSpan={2}>
            <div className="text-sm py-1">
              {initial.note_title ?? "(제목 없음)"}
              <span className="ml-2 text-[11px] text-muted-foreground">
                — 회의록 변경은 삭제 후 재등록으로 진행하세요
              </span>
            </div>
          </Field>
        ) : null}
        <Field label="마감일 (선택)" colSpan={2}>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={inputCls + " w-44"}
          />
        </Field>
        <Field label="고객사 (선택)">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={inputCls}
          >
            <option value="">미지정</option>
            {sortedCustomers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="프로젝트 (선택)">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={inputCls}
          >
            <option value="">미지정</option>
            {filteredProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

function ScopeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-9 inline-flex items-center gap-1.5 px-3 text-sm border-b-2 -mb-px " +
        (active
          ? "border-primary text-foreground font-semibold"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}

// 2차 탭 — segmented control 안의 버튼 (부모 컨테이너가 border + bg 제공).
// 활성일 때 채워진 배경 + 굵은 텍스트, 비활성은 muted hover.
function StatusTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-7 inline-flex items-center px-3 text-xs rounded transition-colors " +
        (active
          ? "bg-primary text-primary-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-muted")
      }
    >
      {children}
    </button>
  );
}

// 완료(DONE) 리스트 — completed_at 기반 4 그룹 + IntersectionObserver sentinel
// 로 무한 스크롤. items 는 부모가 useInfiniteQuery 로 모든 페이지 누적.
function DoneList({
  scope,
  items,
  isLoading,
  hasMore,
  isFetchingMore,
  onLoadMore,
  onUncomplete,
  onClickItem,
}: {
  scope: Scope;
  items: ActionItem[];
  isLoading: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
  onUncomplete: (it: ActionItem) => void;
  onClickItem: (it: ActionItem) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingMore) {
          onLoadMore();
        }
      },
      // root: viewport. 도달 직전에 미리 페치 (rootMargin 200px).
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, onLoadMore]);

  const groups = useMemo(() => {
    const buckets: Record<DoneBucket, ActionItem[]> = {
      today: [], thisWeek: [], thisMonth: [], older: [],
    };
    for (const it of items) {
      buckets[completedGroup(it.completed_at)].push(it);
    }
    return buckets;
  }, [items]);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">로딩 중…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <ListChecks className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <div className="text-sm">완료된 액션이 없습니다.</div>
      </div>
    );
  }
  return (
    <>
      {(["today", "thisWeek", "thisMonth", "older"] as const).map(
        (g) =>
          groups[g].length > 0 && (
            <section key={g} className="space-y-1">
              <div className="text-xs font-semibold text-muted-foreground">
                {DONE_GROUP_LABELS[g]} ({groups[g].length})
              </div>
              <ul className="divide-y divide-border border border-border rounded-md bg-card">
                {groups[g].map((it) => (
                  <li
                    key={it.id}
                    className="flex items-start gap-3 p-3 hover:bg-muted/30 opacity-70"
                  >
                    <input
                      type="checkbox"
                      checked
                      onChange={(e) => {
                        if (!e.target.checked) onUncomplete(it);
                      }}
                      className="mt-0.5"
                      onClick={(e) => e.stopPropagation()}
                      title="체크 해제 시 진행중(TODO) 으로 되돌림"
                    />
                    <button
                      type="button"
                      onClick={() => onClickItem(it)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="text-sm line-through">{it.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        {scope !== "me" && it.assignee_name && (
                          <span className="inline-flex items-center gap-1 text-foreground font-medium">
                            <UserIcon className="h-3 w-3" />
                            {it.assignee_name}
                          </span>
                        )}
                        {it.completed_at && (
                          <span className="text-muted-foreground">
                            ✓ {fmtCompletedAt(it.completed_at)}
                          </span>
                        )}
                        {it.meeting_note_id && it.note_title && (
                          <span className="text-muted-foreground inline-flex items-center gap-1">
                            <ExternalLink className="h-3 w-3" />
                            {it.note_title}
                          </span>
                        )}
                        {it.customer_name && (
                          <span className="text-muted-foreground inline-flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {it.customer_name}
                          </span>
                        )}
                        {it.project_name && (
                          <span className="text-muted-foreground inline-flex items-center gap-1">
                            <FolderKanban className="h-3 w-3" />
                            {it.project_name}
                          </span>
                        )}
                        {it.completion_comment && (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <MessageSquare className="h-3 w-3" />
                            {it.completion_comment}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
      {/* sentinel — viewport 도달 시 다음 페이지 fetch. */}
      <div
        ref={sentinelRef}
        className="h-8 flex items-center justify-center text-xs text-muted-foreground"
      >
        {isFetchingMore
          ? "불러오는 중…"
          : hasMore
            ? "스크롤하여 더 보기"
            : `전부 표시됨 (${items.length}건)`}
      </div>
    </>
  );
}

// 완료일자를 짧게 — 같은 날이면 시:분, 같은 해면 MM/DD, 다른 해면 YYYY/MM/DD.
function fmtCompletedAt(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const sameYear = d.getFullYear() === now.getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameYear) return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children?: React.ReactNode;
}) {
  return (
    <label className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
