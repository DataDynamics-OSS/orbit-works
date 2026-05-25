"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  LayoutGrid,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DateInput } from "@/components/ui/DateInput";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";

// 휴일 3종 + 일정 2종.
//   STATUTORY/TEMPORARY/COMPANY = 휴일 (근무일수 차감, 모두 공개)
//   EVENT_PUBLIC                = 일정 (근무일수 비차감, 모두 공개)
//   EVENT_PRIVATE               = 일정 (근무일수 비차감, HR/ADMIN/SUPER_ADMIN 만 보기)
// 공유 dot/legend 정의 — 빠른 달력 드로어와 같은 모듈을 사용.
import {
  ACTION_DOT,
  EVENT_KIND_DOT,
  EVENT_KIND_ICON,
  EVENT_KIND_LABEL,
  HOLIDAY_TYPE_DOT,
  MULTI_DOT,
  REAL_HOLIDAY_TYPES,
  TYPE_LABEL,
  type EventKind,
  type HolidayType,
} from "@/components/calendar-shared/dots";
import { CalendarLegend } from "@/components/calendar-shared/Legend";

type AlarmRecipient = {
  developer_id: string;
  developer_name: string | null;
  notified_at: string | null;
};

type Holiday = {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  type: HolidayType;
  description: string | null;
  created_by: string | null;
  created_at: string | null;
  alarm_recipients?: AlarmRecipient[];
};

// TYPE_LABEL / EVENT_KIND_LABEL / EVENT_KIND_ICON / HOLIDAY_TYPE_DOT /
// EVENT_KIND_DOT / ACTION_DOT / MULTI_DOT / REAL_HOLIDAY_TYPES / EventKind 는
// 빠른 달력 드로어와 공유 (`@/components/calendar-shared/dots`).
const TYPE_BADGE: Record<HolidayType, string> = {
  STATUTORY: "bg-red-100 text-red-700 border-red-200",
  TEMPORARY: "bg-amber-100 text-amber-700 border-amber-200",
  COMPANY: "bg-sky-100 text-sky-700 border-sky-200",
  EVENT_PUBLIC: "bg-emerald-100 text-emerald-700 border-emerald-200",
  EVENT_PRIVATE: "bg-violet-100 text-violet-700 border-violet-200",
  EVENT_PERSONAL: "bg-pink-100 text-pink-700 border-pink-200",
  EVENT_PAYDAY: "bg-yellow-100 text-yellow-800 border-yellow-300",
};

// MonthView 셀 안 컬러 배지(텍스트 포함) — 셀 dot 과 별개.
const EVENT_KIND_BADGE: Record<EventKind, string> = {
  WORKSHOP: "bg-emerald-100 text-emerald-700 border-emerald-200",
  CONFERENCE: "bg-violet-100 text-violet-700 border-violet-200",
  BUSINESS_TRIP: "bg-orange-100 text-orange-700 border-orange-200",
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// 월별 근무일수 = 해당 월의 평일(월~금) 중 공휴일 제외.
// EVENT_PUBLIC / EVENT_PRIVATE 는 휴일이 아니므로 차감하지 않는다.
function countWorkingDays(
  year: number,
  month0: number,
  holidayMap: Map<string, { type: HolidayType }[]>,
): number {
  const lastDay = new Date(year, month0 + 1, 0).getDate();
  let count = 0;
  for (let i = 1; i <= lastDay; i += 1) {
    const d = new Date(year, month0, i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    // 그 날에 휴일 종류(STATUTORY/TEMPORARY/COMPANY) 가 1개라도 있으면 차감.
    const list = holidayMap.get(ymd(d));
    if (list && list.some((h) => REAL_HOLIDAY_TYPES.includes(h.type))) continue;
    count += 1;
  }
  return count;
}

// 월간 그리드 42일 (6주 × 7일). 이전/다음 달 포함.
function monthDays(year: number, month0: number): Date[] {
  const first = new Date(year, month0, 1);
  const startDay = first.getDay(); // 0=Sun
  const gridStart = new Date(year, month0, 1 - startDay);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

export default function HolidaysPage() {
  const today = new Date();
  const [view, setView] = useState<"month" | "year">("month");
  const [year, setYear] = useState<number>(today.getFullYear());
  const [month0, setMonth0] = useState<number>(today.getMonth());
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: me } = useQuery<{ id: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  // 휴일·일정 등록·편집 권한 — ADMIN 또는 HR (백엔드 holidays.manage 와 동기).
  const canManage = me?.role === "ADMIN" || me?.role === "HR";
  // 비공개 일정 보기 권한 — HR/ADMIN/SUPER_ADMIN.
  const canSeePrivate =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  const { data: holidays = [] } = useQuery<Holiday[]>({
    queryKey: ["calendar", year],
    queryFn: async () =>
      (await api.get("/calendar", { params: { year } })).data,
    staleTime: 60_000,
  });

  // 같은 연도의 모든 이벤트 — 워크샵 / 컨퍼런스 / 출장. 캘린더 셀에 함께 표시.
  // events.manage 권한이 없는 일반 임직원도 일정 자체는 보이도록 라이트
  // endpoint 사용. 상세 보기 / 편집은 여전히 events.manage (HR/ADMIN).
  const { data: events = [] } = useQuery<
    { id: string; title: string; start_date: string; end_date: string; kind: EventKind }[]
  >({
    queryKey: ["events-calendar", year],
    queryFn: async () =>
      (await api.get("/events/calendar", { params: { year } })).data,
    staleTime: 60_000,
  });

  // 날짜별 다중 등록 가능 — Map<date, Holiday[]>. 같은 날 휴일 + 일정 + 일정 등.
  const holidayMap = useMemo(() => {
    const m = new Map<string, Holiday[]>();
    for (const h of holidays) {
      const list = m.get(h.date);
      if (list) list.push(h);
      else m.set(h.date, [h]);
    }
    // 정렬: 휴일(REAL_HOLIDAY_TYPES) 먼저, 그 외(이벤트) 나중. 같은 카테고리 안에선 type 순.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ah = REAL_HOLIDAY_TYPES.includes(a.type) ? 0 : 1;
        const bh = REAL_HOLIDAY_TYPES.includes(b.type) ? 0 : 1;
        if (ah !== bh) return ah - bh;
        return a.type.localeCompare(b.type);
      });
    }
    return m;
  }, [holidays]);

  // start_date ~ end_date (양끝 포함) 범위를 일자별로 펼쳐 이벤트 리스트로.
  const eventMap = useMemo(() => {
    const m = new Map<string, { id: string; title: string; kind: EventKind }[]>();
    for (const e of events) {
      const start = new Date(e.start_date);
      const end = new Date(e.end_date);
      const cur = new Date(start);
      while (cur <= end) {
        const key = ymd(cur);
        const arr = m.get(key) ?? [];
        arr.push({ id: e.id, title: e.title, kind: e.kind });
        m.set(key, arr);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return m;
  }, [events]);

  // 본인 미완료 액션 — due_date 가 있는 항목만 캘린더에 마감일 표시.
  // 표시 전용 — 클릭/등록/수정/삭제 X. 편집은 /my-actions 페이지에서.
  const { data: actionItems = [] } = useQuery<
    {
      id: string;
      title: string;
      due_date: string | null;
      status: string;
      meeting_note_id: string | null;
    }[]
  >({
    queryKey: ["my-action-items", false],
    queryFn: async () =>
      (
        await api.get("/meeting-notes/action-items/mine", {
          params: { include_done: false },
        })
      ).data,
    staleTime: 60_000,
  });

  const actionMap = useMemo(() => {
    const m = new Map<string, { id: string; title: string }[]>();
    for (const it of actionItems) {
      if (!it.due_date) continue;
      const arr = m.get(it.due_date) ?? [];
      arr.push({ id: it.id, title: it.title });
      m.set(it.due_date, arr);
    }
    return m;
  }, [actionItems]);

  // 편집 상태
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Holiday | null>(null);
  const [editForm, setEditForm] = useState<{
    date: string;
    name: string;
    type: HolidayType;
    description: string;
    alarm_recipients: { developer_id: string; developer_name?: string | null; notified_at?: string | null }[];
  }>({ date: "", name: "", type: "TEMPORARY", description: "", alarm_recipients: [] });
  const [editError, setEditError] = useState<string | null>(null);

  const saveM = useMutation({
    mutationFn: async () => {
      // EVENT_PRIVATE 일 때만 alarm_recipients 전송. 그 외 type 은 빈 list (서버가 무시).
      const payload: Record<string, unknown> = {
        date: editForm.date,
        name: editForm.name,
        type: editForm.type,
        description: editForm.description || null,
        alarm_recipients:
          editForm.type === "EVENT_PRIVATE"
            ? editForm.alarm_recipients.map((r) => r.developer_id)
            : [],
      };
      if (editTarget) {
        return (await api.patch(`/calendar/${editTarget.id}`, payload)).data;
      }
      return (await api.post("/calendar", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calendar"] });
      setEditOpen(false);
      setEditTarget(null);
      setEditError(null);
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail;
      if (Array.isArray(d)) {
        setEditError(
          d
            .map((it: any) =>
              it.loc ? `${it.loc.slice(1).join(".")}: ${it.msg}` : it.msg,
            )
            .join(" / "),
        );
      } else {
        setEditError(d ?? e?.message ?? "저장 실패");
      }
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/calendar/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calendar"] });
      setEditOpen(false);
      setEditTarget(null);
    },
  });

  function openNew(d: Date, type: HolidayType = "EVENT_PERSONAL") {
    // 일반 사용자도 EVENT_PUBLIC / EVENT_PERSONAL 은 등록 가능. 휴일/비공개
    // 일정 (other types) 은 canManage / canSeePrivate 가드가 dropdown 단에서
    // 이미 옵션을 가린다.
    setEditTarget(null);
    setEditForm({
      date: ymd(d),
      name: "",
      type,
      description: "",
      alarm_recipients: [],
    });
    setEditError(null);
    setEditOpen(true);
  }

  // 단일 항목 편집·삭제 권한.
  //   - canManage (HR/ADMIN/SUPER_ADMIN) → 모든 type 가능.
  //   - 일반 사용자 → 본인이 등록한 EVENT_PUBLIC / EVENT_PERSONAL 만.
  function canEditHoliday(h: Holiday): boolean {
    // EVENT_PAYDAY 는 백엔드 합성 row — 항상 read-only.
    if (h.type === "EVENT_PAYDAY") return false;
    if (canManage) return true;
    const isUserEvent = h.type === "EVENT_PUBLIC" || h.type === "EVENT_PERSONAL";
    const isMine = !!me?.id && h.created_by === me.id;
    return isUserEvent && isMine;
  }

  function openEdit(h: Holiday) {
    if (!canEditHoliday(h)) return;
    setEditTarget(h);
    setEditForm({
      date: h.date,
      name: h.name,
      type: h.type,
      description: h.description ?? "",
      alarm_recipients: (h.alarm_recipients ?? []).map((r) => ({
        developer_id: r.developer_id,
        developer_name: r.developer_name ?? null,
        notified_at: r.notified_at ?? null,
      })),
    });
    setEditError(null);
    setEditOpen(true);
  }

  const monthLabel = `${year}년 ${String(month0 + 1).padStart(2, "0")}월`;

  return (
    <>
      <DashboardHeader
        title="일정"
        actions={
          <div className="flex gap-2 items-center">
            {/* 연도 네비게이션 */}
            <Tooltip label="이전 연도" side="bottom">
              <button
                type="button"
                onClick={() => setYear((y) => y - 1)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
                aria-label="이전 연도"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </Tooltip>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <Tooltip label="다음 연도" side="bottom">
              <button
                type="button"
                onClick={() => setYear((y) => y + 1)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
                aria-label="다음 연도"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </Tooltip>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            {/* 뷰 토글 */}
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setView("month")}
                className={
                  "h-8 px-3 text-xs inline-flex items-center gap-1 " +
                  (view === "month"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card hover:bg-muted")
                }
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                월간
              </button>
              <button
                type="button"
                onClick={() => setView("year")}
                className={
                  "h-8 px-3 text-xs inline-flex items-center gap-1 " +
                  (view === "year"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card hover:bg-muted")
                }
              >
                <Layers className="h-3.5 w-3.5" />
                연간
              </button>
            </div>

            {/* 모든 인증 사용자가 일정 추가 가능. 권한별 노출 항목은
                AddCalendarMenu 안에서 분기. */}
            <AddCalendarMenu
              onPickType={(t) => openNew(today, t)}
              canManage={!!canManage}
              canSeePrivate={canSeePrivate}
            />
          </div>
        }
      />

      <SplitLayout
        left={
          <>
            <div className="flex-1 min-h-0 flex flex-col">
              {view === "month" ? (
                <MonthView
                  year={year}
                  month0={month0}
                  setMonth0={(m) => {
                    if (m < 0) {
                      setYear((y) => y - 1);
                      setMonth0(11);
                    } else if (m > 11) {
                      setYear((y) => y + 1);
                      setMonth0(0);
                    } else {
                      setMonth0(m);
                    }
                  }}
                  today={today}
                  holidayMap={holidayMap}
                  eventMap={eventMap}
                  actionMap={actionMap}
                  monthLabel={monthLabel}
                  // 셀의 빈 영역 클릭 → 새 등록. 셀 안의 개별 배지는
                  // 자체 클릭 핸들러(onSelectHoliday) 로 편집/삭제.
                  // canEditHoliday = HR/ADMIN 은 전체, 그 외는 본인 등록만.
                  onSelectDate={(d) => openNew(d)}
                  onSelectHoliday={(h) => openEdit(h)}
                  canEditHoliday={canEditHoliday}
                />
              ) : (
                <YearView
                  year={year}
                  today={today}
                  holidayMap={holidayMap}
                  eventMap={eventMap}
                  actionMap={actionMap}
                  onSelectMonth={(m) => {
                    setMonth0(m);
                    setView("month");
                  }}
                  onSelectDate={(d) => {
                    const key = ymd(d);
                    const list = holidayMap.get(key) ?? [];
                    // 단일이면 그 항목 편집, 여러 개거나 없으면 새 등록 (다중 편집은 일별 패널 등 별도 UX 필요).
                    if (list.length === 1) openEdit(list[0]);
                    else openNew(d);
                  }}
                />
              )}
            </div>
            <CalendarLegend canSeePrivate={canSeePrivate} />
          </>
        }
        right={
          <HolidayList
            holidays={holidays}
            isAdmin={!!canManage}
            onEdit={openEdit}
            onDelete={async (h) => {
              if (
                await dialog.confirm(
                  `${h.date} · ${h.name} 을(를) 삭제하시겠습니까?`,
                  { destructive: true },
                )
              ) {
                deleteM.mutate(h.id);
              }
            }}
          />
        }
      />

      {/* 편집 모달 */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editTarget ? "공휴일 편집" : "공휴일 등록"}
        width="max-w-md"
        footer={
          <>
            <div className="mr-auto">
              {editTarget && (
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm(
                        `${editTarget.date} · ${editTarget.name} 을(를) 삭제하시겠습니까?`,
                        { destructive: true },
                      )
                    ) {
                      deleteM.mutate(editTarget.id);
                    }
                  }}
                  className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  삭제
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!editForm.name.trim() || saveM.isPending}
              onClick={() => saveM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {editError && (
            <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
              {editError}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">날짜</span>
            <DateInput
              value={editForm.date}
              onChange={(v) => setEditForm((p) => ({ ...p, date: v }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">이름</span>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) =>
                setEditForm((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="예) 창립기념일"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              maxLength={100}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">유형</span>
            <select
              value={editForm.type}
              onChange={(e) =>
                setEditForm((p) => ({
                  ...p,
                  type: e.target.value as HolidayType,
                }))
              }
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {canManage && (
                <>
                  <option value="STATUTORY">법정 공휴일</option>
                  <option value="TEMPORARY">임시 공휴일</option>
                  <option value="COMPANY">회사 휴일</option>
                </>
              )}
              <option value="EVENT_PUBLIC">공개 일정</option>
              {canSeePrivate && (
                <option value="EVENT_PRIVATE">비공개 일정 (HR/ADMIN 전용)</option>
              )}
              <option value="EVENT_PERSONAL">개인 일정 (본인만)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">설명 (선택)</span>
            <textarea
              value={editForm.description}
              onChange={(e) =>
                setEditForm((p) => ({ ...p, description: e.target.value }))
              }
              rows={2}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          {editForm.type === "EVENT_PRIVATE" && (
            <AlarmRecipientsSection
              recipients={editForm.alarm_recipients}
              onChange={(rs) =>
                setEditForm((p) => ({ ...p, alarm_recipients: rs }))
              }
            />
          )}
        </div>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// "+ 일정 추가" 드롭다운 — 임시 휴일 / 공개 일정 / 비공개 일정 선택.
// ---------------------------------------------------------------------------

function AddCalendarMenu({
  onPickType,
  canManage,
  canSeePrivate,
}: {
  onPickType: (t: HolidayType) => void;
  /** HR/ADMIN — 임시 휴일 등록 가능. */
  canManage: boolean;
  /** HR/ADMIN/SUPER_ADMIN — 비공개 일정 (HR 내부) 보기·등록. */
  canSeePrivate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // ETC/SALES/SUPPORT: [개인 일정, 공개 일정]
  // HR/ADMIN/SUPER_ADMIN: [임시 휴일, 공개 일정, 비공개 일정, 개인 일정]
  const items: { type: HolidayType; label: string; desc: string }[] = [];
  if (canManage) {
    items.push({
      type: "TEMPORARY",
      label: "임시 휴일",
      desc: "근무일에서 차감되는 임시 공휴일",
    });
  }
  items.push({
    type: "EVENT_PUBLIC",
    label: "공개 일정",
    desc: "휴일은 아니지만 모두에게 공개",
  });
  if (canSeePrivate) {
    items.push({
      type: "EVENT_PRIVATE",
      label: "비공개 일정",
      desc: "HR / ADMIN 만 보기",
    });
  }
  items.push({
    type: "EVENT_PERSONAL",
    label: "개인 일정",
    desc: "본인만 보기 (다른 임직원에게는 보이지 않음)",
  });

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
      >
        <Plus className="h-3.5 w-3.5" />
        일정 추가
        <span className="text-primary-foreground/80">▾</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onMouseDown={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border border-border bg-card shadow-md">
            {items.map((it) => (
              <button
                key={it.type}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPickType(it.type);
                }}
                className="w-full px-3 py-2 text-left text-xs hover:bg-muted"
              >
                <div className="font-medium">{it.label}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {it.desc}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 비공개 일정 — 알람 수신자 picker (이벤트 페이지의 ParticipantsSection 패턴).
// 사내 정규직 active 만 노출. 09:00 cron 이 등록된 수신자에게 일괄 발송.
// ---------------------------------------------------------------------------

type DirectoryDev = {
  id: string;
  name: string;
  employment_type: string;
  status?: string | null;
};

function AlarmRecipientsSection({
  recipients,
  onChange,
}: {
  recipients: { developer_id: string; developer_name?: string | null; notified_at?: string | null }[];
  onChange: (rs: typeof recipients) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const { data: developers = [] } = useQuery<DirectoryDev[]>({
    queryKey: ["developers-directory", "FULL_TIME"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 60_000,
  });

  function add(dev: DirectoryDev) {
    if (recipients.some((r) => r.developer_id === dev.id)) return;
    onChange([
      ...recipients,
      { developer_id: dev.id, developer_name: dev.name, notified_at: null },
    ]);
  }

  function remove(idx: number) {
    onChange(recipients.filter((_, i) => i !== idx));
  }

  const filtered = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return developers
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .filter((d) => !recipients.some((r) => r.developer_id === d.id))
      .slice(0, 30);
  }, [developers, pickerQuery, recipients]);

  return (
    <div className="flex flex-col gap-2 pt-2 border-t border-border">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          알람 수신자 ({recipients.length}) · 당일 09:00 Direct Message
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
        >
          <Plus className="h-3 w-3" /> 사내 직원 추가
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {recipients.map((r, i) => {
          const sent = !!r.notified_at;
          return (
            <span
              key={r.developer_id}
              className={
                "inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs " +
                (sent
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-primary/30 bg-primary/5")
              }
              title={
                sent
                  ? `발송 완료: ${r.notified_at}`
                  : "당일 09:00 발송 예정"
              }
            >
              {sent ? "✓ " : ""}
              {r.developer_name ?? "(직원)"}
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-destructive"
              >
                ×
              </button>
            </span>
          );
        })}
        {recipients.length === 0 && (
          <span className="text-[11px] text-muted-foreground">수신자 없음</span>
        )}
      </div>
      {pickerOpen && (
        <div className="rounded-md border border-border p-3 bg-muted/10 space-y-2">
          <input
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="사내 직원 검색..."
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            autoFocus
          />
          <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
            {filtered.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  add(d);
                  setPickerQuery("");
                }}
                className="px-2 py-1 rounded border border-border bg-background hover:bg-muted text-xs"
              >
                {d.name}
              </button>
            ))}
            {filtered.length === 0 && (
              <span className="text-[11px] text-muted-foreground">
                검색 결과 없음
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// CalendarLegend 는 공유 모듈에서 import (`@/components/calendar-shared/Legend`).

// ---------------------------------------------------------------------------
// Monthly view — 대형 그리드 한 달.
// ---------------------------------------------------------------------------

function MonthView({
  year,
  month0,
  setMonth0,
  today,
  holidayMap,
  eventMap,
  actionMap,
  monthLabel,
  onSelectDate,
  onSelectHoliday,
  canEditHoliday,
}: {
  year: number;
  month0: number;
  setMonth0: (m: number) => void;
  today: Date;
  holidayMap: Map<string, Holiday[]>;
  eventMap: Map<string, { id: string; title: string; kind: EventKind }[]>;
  /** 본인 미완료 액션 — 마감일에 표시 (read-only). */
  actionMap: Map<string, { id: string; title: string }[]>;
  monthLabel: string;
  onSelectDate: (d: Date) => void;
  /** 셀 안의 특정 항목 클릭 시 호출 (편집/삭제 다이얼로그). */
  onSelectHoliday: (h: Holiday) => void;
  /** 그 항목을 현재 사용자가 편집/삭제 가능한지 판정. false 면 클릭 비활성. */
  canEditHoliday: (h: Holiday) => boolean;
}) {
  const days = useMemo(() => monthDays(year, month0), [year, month0]);

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border">
        <Tooltip label="이전 달" side="bottom">
          <button
            type="button"
            onClick={() => setMonth0(month0 - 1)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted"
            aria-label="이전 달"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <div className="text-base font-semibold">
          {monthLabel}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            (근무일수: {countWorkingDays(year, month0, holidayMap)}일)
          </span>
        </div>
        <Tooltip label="다음 달" side="bottom">
          <button
            type="button"
            onClick={() => setMonth0(month0 + 1)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted"
            aria-label="다음 달"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <div
        className="shrink-0 text-xs text-muted-foreground"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          backgroundColor: "rgba(100,116,139,0.08)",
        }}
      >
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="px-2 py-1.5 text-center font-semibold border-b border-border"
          >
            {w}
          </div>
        ))}
      </div>
      <div
        className="flex-1 min-h-0"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gridTemplateRows: "repeat(6, minmax(0, 1fr))",
        }}
      >
        {days.map((d, i) => {
          const inMonth = d.getMonth() === month0;
          const isSat = d.getDay() === 6;
          const isSun = d.getDay() === 0;
          const isToday = isSameDay(d, today);
          const list = holidayMap.get(ymd(d)) ?? [];
          const hasRealHoliday = list.some((x) => REAL_HOLIDAY_TYPES.includes(x.type));
          const evs = eventMap.get(ymd(d)) ?? [];
          const acts = actionMap.get(ymd(d)) ?? [];
          // 지난 마감 — 본인 미완료 액션의 due_date 가 오늘보다 이전이면 강조.
          const dKey = ymd(d);
          const todayKey = ymd(today);
          const overduePastKey = dKey < todayKey;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelectDate(d)}
              className={
                "min-h-[64px] p-1.5 border-b border-r border-border text-left flex flex-col gap-1 hover:bg-muted/40 transition-colors overflow-hidden " +
                (!inMonth ? "text-muted-foreground/60 " : "") +
                (isToday ? "ring-2 ring-primary ring-inset " : "")
              }
              style={
                !inMonth
                  ? { backgroundColor: "rgba(100,116,139,0.05)" }
                  : undefined
              }
            >
              <div
                className={
                  "inline-flex items-center justify-center w-6 h-6 text-sm font-medium " +
                  // 휴일(법정/임시/회사) 만 빨간색. EVENT_PUBLIC/EVENT_PRIVATE 는
                  // 단순 일정이라 날짜 숫자 색을 바꾸지 않음.
                  (hasRealHoliday
                    ? "text-red-600"
                    : isSun
                      ? "text-red-600"
                      : isSat
                        ? "text-blue-600"
                        : "")
                }
              >
                {d.getDate()}
              </div>
              {/* 같은 날 등록된 모든 항목을 별도 배지로 표시.
                  편집 가능한 항목만 클릭 가능 (cursor + hover + onClick).
                  편집 불가능한 항목 (다른 사용자 등록 / 권한 없음) 은 read-only.
                  부모 button 의 onSelectDate 발화 차단을 위해 e.stopPropagation. */}
              {list.map((h) => {
                const editable = canEditHoliday(h);
                return (
                  <div
                    key={h.id}
                    role={editable ? "button" : undefined}
                    tabIndex={editable ? 0 : -1}
                    onClick={
                      editable
                        ? (e) => {
                            e.stopPropagation();
                            onSelectHoliday(h);
                          }
                        : (e) => e.stopPropagation()
                    }
                    onKeyDown={
                      editable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
                              e.preventDefault();
                              onSelectHoliday(h);
                            }
                          }
                        : undefined
                    }
                    className={
                      "text-[11px] font-medium px-1.5 py-0.5 rounded border text-center whitespace-normal break-keep leading-tight " +
                      (editable
                        ? "cursor-pointer hover:brightness-95 "
                        : "cursor-default opacity-90 ") +
                      TYPE_BADGE[h.type]
                    }
                    title={
                      editable
                        ? `${TYPE_LABEL[h.type]} · ${h.name} (클릭하여 편집/삭제)`
                        : `${TYPE_LABEL[h.type]} · ${h.name} (편집 권한 없음)`
                    }
                  >
                    {h.name}
                  </div>
                );
              })}
              {evs.map((ev) => (
                <div
                  key={ev.id}
                  title={`${EVENT_KIND_LABEL[ev.kind]} · ${ev.title}`}
                  className={
                    "text-[11px] font-medium px-1.5 py-0.5 rounded border text-center whitespace-normal break-keep leading-tight truncate " +
                    EVENT_KIND_BADGE[ev.kind]
                  }
                >
                  {EVENT_KIND_ICON[ev.kind]} {ev.title}
                </div>
              ))}
              {/* 본인 미완료 액션의 마감일 — 표시 전용 (클릭/편집 X). 회색 바탕.
                  지난 마감 (오늘 이전 due_date) 은 rose 로 강조. */}
              {acts.map((a) => (
                <div
                  key={"a-" + a.id}
                  title={`내 액션 마감 · ${a.title}`}
                  onClick={(e) => e.stopPropagation()}
                  className={
                    "text-[11px] font-medium px-1.5 py-0.5 rounded border text-center whitespace-normal break-keep leading-tight truncate cursor-default " +
                    (overduePastKey
                      ? "bg-rose-100 text-rose-800 border-rose-200"
                      : "bg-slate-100 text-slate-700 border-slate-200")
                  }
                >
                  📋 {a.title}
                </div>
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Yearly view — 12개 mini 달력.
// ---------------------------------------------------------------------------

function YearView({
  year,
  today,
  holidayMap,
  eventMap,
  actionMap,
  onSelectMonth,
  onSelectDate,
}: {
  year: number;
  today: Date;
  holidayMap: Map<string, Holiday[]>;
  eventMap: Map<string, { id: string; title: string; kind: EventKind }[]>;
  actionMap: Map<string, { id: string; title: string }[]>;
  onSelectMonth: (m0: number) => void;
  onSelectDate: (d: Date) => void;
}) {
  return (
    <div
      className="h-full gap-3 grid"
      style={{
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gridTemplateRows: "repeat(3, minmax(0, 1fr))",
      }}
    >
      {Array.from({ length: 12 }, (_, m0) => (
        <MiniMonth
          key={m0}
          year={year}
          month0={m0}
          today={today}
          holidayMap={holidayMap}
          eventMap={eventMap}
          actionMap={actionMap}
          onClickHeader={() => onSelectMonth(m0)}
          onClickDate={onSelectDate}
        />
      ))}
    </div>
  );
}

function MiniMonth({
  year,
  month0,
  today,
  holidayMap,
  eventMap,
  actionMap,
  onClickHeader,
  onClickDate,
}: {
  year: number;
  month0: number;
  today: Date;
  holidayMap: Map<string, Holiday[]>;
  eventMap: Map<string, { id: string; title: string; kind: EventKind }[]>;
  actionMap: Map<string, { id: string; title: string }[]>;
  onClickHeader: () => void;
  onClickDate: (d: Date) => void;
}) {
  const days = useMemo(() => monthDays(year, month0), [year, month0]);
  return (
    <div className="rounded-md border border-border bg-card p-2 shadow-sm flex flex-col min-h-0">
      <button
        type="button"
        onClick={onClickHeader}
        className="shrink-0 w-full text-sm font-semibold mb-1 text-center hover:underline"
      >
        {year}년 {String(month0 + 1).padStart(2, "0")}월
        <span className="ml-1 text-[11px] font-normal text-muted-foreground">
          ({countWorkingDays(year, month0, holidayMap)}일)
        </span>
      </button>
      <div
        className="shrink-0 text-[10px] text-muted-foreground"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
        }}
      >
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={
              "text-center py-0.5 " +
              (i === 0
                ? "text-red-600 font-bold"
                : i === 6
                  ? "text-blue-600 font-bold"
                  : "")
            }
          >
            {w}
          </div>
        ))}
      </div>
      <div
        className="flex-1 min-h-0"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gridTemplateRows: "repeat(6, minmax(0, 1fr))",
        }}
      >
        {days.map((d, i) => {
          const inMonth = d.getMonth() === month0;
          const isSat = d.getDay() === 6;
          const isSun = d.getDay() === 0;
          const isToday = isSameDay(d, today);
          const list = holidayMap.get(ymd(d)) ?? [];
          const hasRealHoliday = list.some((x) => REAL_HOLIDAY_TYPES.includes(x.type));
          const evs = eventMap.get(ymd(d)) ?? [];
          const hasEvent = inMonth && evs.length > 0;
          const acts = actionMap.get(ymd(d)) ?? [];
          const hasAction = inMonth && acts.length > 0;
          // 공휴일/일정 + 이벤트 + 본인 액션 마감 모두 한 줄 tooltip 으로.
          const evLabel = evs
            .map((ev) => `${EVENT_KIND_ICON[ev.kind]} ${ev.title}`)
            .join(", ");
          const holidayLabel = list
            .map((h) => `${h.name} (${TYPE_LABEL[h.type]})`)
            .join(", ");
          const actLabel = acts.map((a) => `📋 ${a.title}`).join(", ");
          const tipLabel = [
            holidayLabel,
            hasEvent ? evLabel : "",
            hasAction ? actLabel : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const hasTip = !!(inMonth && tipLabel);
          // 우상단 dot — 그 날 표시 가능한 항목 (휴일/일정 + 이벤트 + 액션)
          // 의 합계가:
          //   1 개  → 그 항목의 legend 색 (HOLIDAY_TYPE_DOT / EVENT_KIND_DOT / ACTION_DOT)
          //   2 개+ → 진한 회색(MULTI_DOT) — 종류 분간 의미 없으므로 단일 dot + tooltip
          //   0 개  → dot 없음
          // (`list` 는 전부 inMonth 와 무관하게 holidayMap 에서 온 것이라 inMonth 가드.)
          const totalCount =
            (inMonth ? list.length : 0) + evs.length + acts.length;
          let dotCls = "";
          if (totalCount === 1) {
            if (inMonth && list.length === 1) {
              dotCls = HOLIDAY_TYPE_DOT[list[0].type];
            } else if (evs.length === 1) {
              dotCls = EVENT_KIND_DOT[evs[0].kind];
            } else if (acts.length === 1) {
              dotCls = ACTION_DOT;
            }
          } else if (totalCount >= 2) {
            dotCls = MULTI_DOT;
          }
          const showDot = totalCount > 0 && !!dotCls;
          return (
            <button
              key={i}
              type="button"
              onClick={() => inMonth && onClickDate(d)}
              disabled={!inMonth}
              className={
                "group/tt relative w-full h-full text-[11px] rounded flex items-center justify-center min-w-0 min-h-0 hover:bg-muted " +
                (!inMonth
                  ? "text-muted-foreground/30 "
                  : hasRealHoliday
                    ? "text-red-600 font-bold "
                    : isSun
                      ? "text-red-600 font-bold "
                      : isSat
                        ? "text-blue-600 font-bold "
                        : "") +
                (isToday && inMonth ? "ring-1 ring-primary " : "")
              }
            >
              {d.getDate()}
              {/* 이벤트 / 본인 액션 마감 표시 — 우상단 작은 dot. 종류별 색.
                  공휴일과 별개. 액션은 amber, 이벤트가 있으면 이벤트 색 우선. */}
              {showDot && (
                <span className={"absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full " + dotCls} />
              )}
              {hasTip && (
                <Tooltip inline side="top" label={tipLabel} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lower list.
// ---------------------------------------------------------------------------

function HolidayList({
  holidays,
  isAdmin,
  onEdit,
  onDelete,
}: {
  holidays: Holiday[];
  isAdmin: boolean;
  onEdit: (h: Holiday) => void;
  onDelete: (h: Holiday) => void;
}) {
  return (
    <>
      <div className="shrink-0 px-3 py-2 border-b border-border text-sm font-semibold">
        등록한 일정 목록 ({holidays.length}건)
      </div>
      {holidays.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          해당 연도에 등록된 일정이 없습니다.
        </div>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-border/50">
          {holidays.map((h) => {
            const d = parseYmd(h.date);
            const weekday = WEEKDAYS[d.getDay()];
            const isSun = d.getDay() === 0;
            const isSat = d.getDay() === 6;
            return (
              <li
                key={h.id}
                className="px-3 py-2 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-baseline gap-2">
                  <span className="tabular-nums text-sm font-medium">
                    {h.date}
                  </span>
                  <span
                    className={
                      "text-xs " +
                      (isSun
                        ? "text-red-500"
                        : isSat
                          ? "text-blue-500"
                          : "text-muted-foreground")
                    }
                  >
                    ({weekday})
                  </span>
                  <span
                    className={
                      "ml-auto inline-block rounded border px-1.5 py-0.5 text-[10px] shrink-0 " +
                      TYPE_BADGE[h.type]
                    }
                  >
                    {TYPE_LABEL[h.type]}
                  </span>
                </div>
                <div className="mt-1 text-sm font-medium break-keep">
                  {h.name}
                </div>
                {h.description && (
                  <div className="mt-0.5 text-xs text-muted-foreground break-keep">
                    {h.description}
                  </div>
                )}
                {isAdmin && (
                  <div className="mt-1 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(h)}
                      className="text-[11px] text-primary hover:underline"
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(h)}
                      className="text-[11px] text-destructive hover:underline"
                    >
                      삭제
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resizable split layout — 좌(달력) | 드래그 핸들 | 우(등록한 일정 목록).
// 우측 폭을 px 로 관리하고 localStorage 에 저장.
// ---------------------------------------------------------------------------

const SPLIT_KEY = "calendar-right-width";
const MIN_RIGHT = 240;
const MAX_RIGHT = 600;
const DEFAULT_RIGHT = 320;

function SplitLayout({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  const [rightW, setRightW] = useState<number>(DEFAULT_RIGHT);
  const containerRef = useRef<HTMLDivElement>(null);

  // 초기 복원
  useEffect(() => {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved && !Number.isNaN(saved)) {
      setRightW(Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, saved)));
    }
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = rightW;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const next = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, startW - dx));
        setRightW(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // commit to storage
        try {
          localStorage.setItem(SPLIT_KEY, String(rightWRef.current));
        } catch {
          /* ignore */
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [rightW],
  );

  // rightW 의 최신 값을 onUp 내부에서 참조하기 위한 ref.
  const rightWRef = useRef(rightW);
  useEffect(() => {
    rightWRef.current = rightW;
  }, [rightW]);

  return (
    <div
      ref={containerRef}
      className="flex flex-1 min-h-0 overflow-hidden"
    >
      <div className="flex-1 min-w-0 flex flex-col p-4 pr-2 overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col">{left}</div>
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onMouseDown}
        onDoubleClick={() => {
          setRightW(DEFAULT_RIGHT);
          try {
            localStorage.setItem(SPLIT_KEY, String(DEFAULT_RIGHT));
          } catch {
            /* ignore */
          }
        }}
        title="드래그하여 크기 조절 · 더블클릭으로 기본값 복원"
        className="hidden lg:block w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary transition-colors relative group/sp"
      >
        {/* 드래그 hit area 확대 — 양옆 3px */}
        <span className="absolute inset-y-0 -left-1 -right-1" />
      </div>

      <aside
        className="hidden lg:flex shrink-0 flex-col p-4 pl-2 overflow-hidden"
        style={{ width: rightW }}
      >
        <div className="flex-1 min-h-0 rounded-md border border-border bg-card flex flex-col overflow-hidden">
          {right}
        </div>
      </aside>
    </div>
  );
}
