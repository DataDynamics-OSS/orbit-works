"use client";

/**
 * 대시보드 — 개인 정보 카드 묶음 (모든 임직원 공통, ETC 포함).
 *
 * 13 카드 (모두 본인 정보 중심):
 *   KPI tiles (5):  연차 / 내 액션 / 결재 / 내 목표 점수 / 다음 급여일
 *   List sections:  최근 공지 / 이번 주 일정 / 이번 달 생일자 /
 *                   다가오는 휴일 / 다가오는 이벤트 / 이번 주 출퇴근 /
 *                   최근 회의록 / 지연된 액션 / 나의 목표 진행률
 *
 * 각 카드는 본인 정보만 노출 (server-side owner 게이트). 비대상 사용자는
 * 빈 상태 안내. 카드 클릭 시 해당 메뉴로 이동.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  Building2,
  Cake,
  CalendarClock,
  CalendarDays,
  Clock,
  FileCheck2,
  FileText,
  ListChecks,
  Megaphone,
  Sparkles,
  Target,
  TreePalm,
  Wallet,
} from "lucide-react";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// 외부에서 호출하는 단일 컨테이너
// ---------------------------------------------------------------------------

export function PersonalCards() {
  return (
    <div className="flex flex-col gap-4">
      {/* KPI 5개 — 컴팩트 한 줄 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <LeaveBalanceTile />
        <MyActionsTile />
        <ApprovalInboxTile />
        <MyGoalsTile />
        <NextPaydayTile />
      </div>

      {/* 최근 공지(좌, 1칸) + 이번 주 일정(우, 2칸) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-1 h-full">
          <RecentNoticesCard />
        </div>
        <div className="lg:col-span-2 h-full">
          <ThisWeekScheduleCard />
        </div>
      </div>

      {/* 보조 카드 3개 */}
      {/* 6-col grid — 생일자/출퇴근 은 1칸 (절반), 휴일/이벤트 는 2칸. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
        <div className="lg:col-span-1 h-full">
          <BirthdaysCard />
        </div>
        <div className="lg:col-span-2 h-full">
          <UpcomingHolidaysCard />
        </div>
        <div className="lg:col-span-2 h-full">
          <UpcomingEventsCard />
        </div>
        <div className="lg:col-span-1 h-full">
          <ThisWeekAttendanceCard />
        </div>
      </div>

      {/* 최근 자료 + 지연된 액션 + 내 목표 진행률 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <RecentMeetingNotesCard />
        <OverdueActionsCard />
        <MyGoalsProgressCard />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 공용 styling
// ---------------------------------------------------------------------------

function CardShell({
  title,
  icon,
  href,
  children,
}: {
  title: React.ReactNode;
  icon: React.ReactNode;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </div>
        {href && (
          <Link
            href={href}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
          >
            전체 <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function KpiTile({
  title,
  icon,
  value,
  sub,
  href,
  tone,
}: {
  title: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  href?: string;
  tone?: "default" | "warning" | "success";
}) {
  const valueColor =
    tone === "warning"
      ? "text-amber-700"
      : tone === "success"
        ? "text-emerald-700"
        : "text-foreground";
  const Body = (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm hover:bg-muted/30 transition flex flex-col h-full">
      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className={"mt-1 text-2xl font-bold tabular-nums " + valueColor}>
        {value}
      </div>
      {sub && (
        <div className="mt-auto pt-1 text-[11px] text-muted-foreground tabular-nums">
          {sub}
        </div>
      )}
    </div>
  );
  return href ? <Link href={href}>{Body}</Link> : Body;
}

// ---------------------------------------------------------------------------
// 1. 연차 잔여
// ---------------------------------------------------------------------------

type MyBalance = {
  total_days: string | number;
  used_days: string | number;
  remaining_days: string | number;
  monthly_accrual_remaining?: string | number | null;
};

function LeaveBalanceTile() {
  const { data } = useQuery<MyBalance>({
    queryKey: ["leave-balance-me"],
    queryFn: async () => (await api.get("/leaves/balance/me")).data,
    staleTime: 60_000,
  });
  const remaining = Number(data?.remaining_days ?? 0);
  const used = Number(data?.used_days ?? 0);
  const total = Number(data?.total_days ?? 0);
  return (
    <KpiTile
      title="잔여 연차"
      icon={<TreePalm className="h-3.5 w-3.5 text-emerald-600" />}
      value={`${remaining}일`}
      sub={`총 ${total}일 · 사용 ${used}일`}
      href="/leaves"
      tone={remaining <= 1 ? "warning" : "success"}
    />
  );
}

// ---------------------------------------------------------------------------
// 2. 내 액션
// ---------------------------------------------------------------------------

type ActionItem = {
  id: string;
  due_date: string | null;
  status: string;
};

function MyActionsTile() {
  const { data: items = [] } = useQuery<ActionItem[]>({
    queryKey: ["my-action-items", false],
    queryFn: async () =>
      (await api.get("/meeting-notes/action-items/mine?include_done=false")).data,
    staleTime: 30_000,
  });
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const overdue = items.filter(
    (it) => it.due_date && new Date(it.due_date + "T00:00:00") < now,
  ).length;
  return (
    <KpiTile
      title="내 액션 (미완료)"
      icon={<ListChecks className="h-3.5 w-3.5 text-blue-600" />}
      value={`${items.length}건`}
      sub={overdue > 0 ? `지난 마감 ${overdue}건` : "지난 마감 없음"}
      href="/my-actions"
      tone={overdue > 0 ? "warning" : "default"}
    />
  );
}

// ---------------------------------------------------------------------------
// 3. 결재 inbox
// ---------------------------------------------------------------------------

function ApprovalInboxTile() {
  const { data: inbox = [] } = useQuery<{ id: string }[]>({
    queryKey: ["approvals", "inbox"],
    queryFn: async () => (await api.get("/approvals/inbox")).data,
    staleTime: 30_000,
  });
  const { data: mine = [] } = useQuery<{ id: string; status: string }[]>({
    queryKey: ["approvals", "mine"],
    queryFn: async () => (await api.get("/approvals/mine")).data,
    staleTime: 30_000,
  });
  const inProgressMine = mine.filter(
    (r) => r.status === "SUBMITTED" || r.status === "IN_PROGRESS",
  ).length;
  return (
    <KpiTile
      title="결재"
      icon={<FileCheck2 className="h-3.5 w-3.5 text-violet-600" />}
      value={`${inbox.length}건`}
      sub={`내가 올린 진행중 ${inProgressMine}건`}
      href="/approvals"
      tone={inbox.length > 0 ? "warning" : "default"}
    />
  );
}

// ---------------------------------------------------------------------------
// 4. 내 목표 점수
// ---------------------------------------------------------------------------

type GoalScore = {
  total: number;
  grade: string;
  goal_count: number;
};

function MyGoalsTile() {
  const { data } = useQuery<GoalScore>({
    queryKey: ["goals", "score-summary"],
    queryFn: async () => (await api.get("/goals/score/summary")).data,
    staleTime: 60_000,
  });
  const grade = data?.grade ?? "-";
  const score = data?.total != null ? Math.round(data.total) : null;
  const gradeTone = grade === "S" || grade === "A" ? "success" : "default";
  return (
    <KpiTile
      title="내 목표 점수"
      icon={<Target className="h-3.5 w-3.5 text-rose-600" />}
      value={score != null ? `${score}점` : "—"}
      sub={`등급 ${grade} · 목표 ${data?.goal_count ?? 0}개`}
      href="/goals"
      tone={gradeTone}
    />
  );
}

// ---------------------------------------------------------------------------
// 5. 다음 급여일 D-N — 서버 계산.
// `app_settings.payroll` 의 payday_of_month / rollback_strategy / include_holidays
// + holidays 테이블을 종합해 백엔드 `/dashboard/next-payday` 가 확정된 D-카운트
// 반환. 클라이언트 로컬 계산 제거 (휴일 정의 변경 시 자동 반영).
// ---------------------------------------------------------------------------

type NextPayday = {
  scheduled_date: string;
  actual_date: string;
  days_until: number;
  is_today: boolean;
  rolled_back: boolean;
  label: string;
};

function NextPaydayTile() {
  const { data } = useQuery<NextPayday>({
    queryKey: ["next-payday"],
    queryFn: async () => (await api.get("/dashboard/next-payday")).data,
    staleTime: 5 * 60_000,
  });
  // YYYY-MM-DD → "M/D".
  const dateStr = data
    ? (() => {
        const [_y, m, d] = data.actual_date.split("-");
        return `${Number(m)}/${Number(d)}`;
      })()
    : "—";
  const days = data?.days_until ?? null;
  return (
    <KpiTile
      title="다음 급여일"
      icon={<Wallet className="h-3.5 w-3.5 text-amber-600" />}
      value={
        days == null ? "—"
        : data?.is_today ? "오늘"
        : `D-${days}`
      }
      sub={
        data
          ? `${dateStr} · ${data.label}` +
            (data.rolled_back ? " (휴일 보정)" : "")
          : "—"
      }
      tone={days != null && days <= 1 ? "success" : "default"}
    />
  );
}

function startOfDayLocal(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// ---------------------------------------------------------------------------
// 6. 이번 주 일정
// ---------------------------------------------------------------------------

type Reservation = {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  room_name?: string | null;
};

type EventLite = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  kind: "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";
};

function ThisWeekScheduleCard() {
  const range = useMemo(() => weekRange(), []);
  const { data: meetings = [] } = useQuery<Reservation[]>({
    queryKey: ["my-meetings-this-week", range.from, range.to],
    queryFn: async () =>
      (
        await api.get("/meeting-reservations", {
          params: { from: range.from, to: range.to, mine: true },
        })
      ).data,
    staleTime: 60_000,
  });
  const { data: events = [] } = useQuery<EventLite[]>({
    queryKey: ["events-calendar", new Date().getFullYear()],
    queryFn: async () =>
      (await api.get("/events/calendar", { params: { year: new Date().getFullYear() } })).data,
    staleTime: 60_000,
  });

  const eventsThisWeek = events.filter((e) => {
    const start = e.start_date;
    const end = e.end_date;
    return !(end < range.from || start > range.to);
  });

  const items: { key: string; when: string; title: string; sub?: string }[] = [
    ...meetings.map((m) => ({
      key: "m-" + m.id,
      when: fmtDateTime(m.start_at),
      title: m.title,
      sub: m.room_name ?? "",
    })),
    ...eventsThisWeek.map((e) => ({
      key: "e-" + e.id,
      when: e.start_date,
      title: e.title,
      sub:
        e.kind === "WORKSHOP"
          ? "워크샵"
          : e.kind === "CONFERENCE"
            ? "컨퍼런스"
            : "출장",
    })),
  ];
  items.sort((a, b) => a.when.localeCompare(b.when));

  return (
    <CardShell
      title="이번 주 일정"
      icon={<CalendarClock className="h-4 w-4 text-blue-600" />}
      href="/calendar"
    >
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">
          이번 주 예정된 회의·이벤트가 없습니다.
        </div>
      ) : (
        <ul className="text-sm divide-y divide-border">
          {items.slice(0, 8).map((it) => (
            <li key={it.key} className="py-1.5 flex items-start gap-3">
              <span className="text-xs text-muted-foreground w-28 shrink-0 tabular-nums">
                {it.when}
              </span>
              <span className="flex-1 truncate">
                {it.title}
                {it.sub && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    · {it.sub}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

function weekRange() {
  const d = new Date();
  const dow = d.getDay(); // 0=일
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((dow + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: ymd(monday), to: ymd(sunday) };
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 7. 이번 달 생일자
// ---------------------------------------------------------------------------

type Birthday = { id: string; name: string; month: number; day: number; tag: string | null };

function BirthdaysCard() {
  const { data = [] } = useQuery<Birthday[]>({
    queryKey: ["birthdays", "this-month"],
    queryFn: async () => (await api.get("/developers/birthdays")).data,
    staleTime: 60 * 60_000,
  });
  return (
    <CardShell title="이번 달 생일자" icon={<Cake className="h-4 w-4 text-pink-600" />}>
      {data.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">이번 달 생일자가 없습니다.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {data.slice(0, 6).map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-12 shrink-0 tabular-nums">
                {b.month}/{b.day}
              </span>
              <span className="truncate">{b.name}</span>
              {b.tag && <span className="text-xs text-muted-foreground">· {b.tag}</span>}
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 8. 다가오는 휴일
// ---------------------------------------------------------------------------

type Holiday = {
  id: string;
  date: string;
  name: string;
  type: "STATUTORY" | "TEMPORARY" | "COMPANY" | "EVENT_PUBLIC" | "EVENT_PRIVATE";
};

function UpcomingHolidaysCard() {
  const yr = new Date().getFullYear();
  const { data = [] } = useQuery<Holiday[]>({
    queryKey: ["calendar", yr],
    queryFn: async () => (await api.get("/calendar", { params: { year: yr } })).data,
    staleTime: 60 * 60_000,
  });
  const today = ymd(new Date());
  const upcoming = data
    .filter((h) =>
      h.date >= today &&
      (h.type === "STATUTORY" || h.type === "TEMPORARY" || h.type === "COMPANY"),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);
  return (
    <CardShell title="다가오는 휴일" icon={<CalendarDays className="h-4 w-4 text-rose-600" />}>
      {upcoming.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">남은 공휴일이 없습니다.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {upcoming.map((h) => {
            const days = daysBetween(today, h.date);
            return (
              <li key={h.id} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0 tabular-nums">
                  {h.date.slice(5)}
                </span>
                <span className="truncate flex-1">{h.name}</span>
                <span className="text-xs text-rose-600 font-semibold tabular-nums">
                  {days === 0 ? "오늘" : `D-${days}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

function daysBetween(a: string, b: string): number {
  const aD = new Date(a + "T00:00:00").getTime();
  const bD = new Date(b + "T00:00:00").getTime();
  return Math.round((bD - aD) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// 8b. 다가오는 이벤트 (워크샵·컨퍼런스·출장)
// ---------------------------------------------------------------------------

type UpcomingEvent = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  kind: "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";
};

const EVENT_KIND_ICON: Record<UpcomingEvent["kind"], string> = {
  WORKSHOP: "🎯",
  CONFERENCE: "🎤",
  BUSINESS_TRIP: "✈️",
};
const EVENT_KIND_LABEL: Record<UpcomingEvent["kind"], string> = {
  WORKSHOP: "워크샵",
  CONFERENCE: "컨퍼런스",
  BUSINESS_TRIP: "출장",
};

function UpcomingEventsCard() {
  const yr = new Date().getFullYear();
  const yrNext = yr + 1;
  // 올해 + 내년 이벤트 합쳐서 가져옴 — 연말에 다음 해 이벤트도 노출되게.
  const { data: cur = [] } = useQuery<UpcomingEvent[]>({
    queryKey: ["events-calendar", yr],
    queryFn: async () =>
      (await api.get("/events/calendar", { params: { year: yr } })).data,
    staleTime: 60_000,
  });
  const { data: next = [] } = useQuery<UpcomingEvent[]>({
    queryKey: ["events-calendar", yrNext],
    queryFn: async () =>
      (await api.get("/events/calendar", { params: { year: yrNext } })).data,
    staleTime: 60 * 60_000,
  });
  const today = ymd(new Date());
  const upcoming = [...cur, ...next]
    // 진행 중 이벤트 (start <= today <= end) 도 포함 — end 기준 필터.
    .filter((e) => e.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .slice(0, 3);
  return (
    <CardShell title="다가오는 이벤트" icon={<CalendarDays className="h-4 w-4 text-emerald-600" />}>
      {upcoming.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">예정된 이벤트가 없습니다.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {upcoming.map((e) => {
            const days = daysBetween(today, e.start_date);
            const inProgress = e.start_date <= today;
            return (
              <li key={e.id} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0 tabular-nums">
                  {e.start_date.slice(5)}
                </span>
                <span
                  className="truncate flex-1"
                  title={`${EVENT_KIND_LABEL[e.kind]} · ${e.title}`}
                >
                  {EVENT_KIND_ICON[e.kind]} {e.title}
                </span>
                <span className="text-xs text-emerald-700 font-semibold tabular-nums">
                  {inProgress ? "진행중" : days === 0 ? "오늘" : `D-${days}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 9. 이번 주 출퇴근
// ---------------------------------------------------------------------------

type WeekStats = {
  workdays?: number;
  attended?: number;
  total_minutes?: number;
  avg_check_in?: string | null;
  avg_check_out?: string | null;
};

function ThisWeekAttendanceCard() {
  const { data } = useQuery<WeekStats>({
    queryKey: ["attendance-me-week"],
    queryFn: async () => (await api.get("/attendance/me/week")).data,
    staleTime: 60_000,
  });
  const attended = data?.attended ?? 0;
  const workdays = data?.workdays ?? 0;
  const totalH = ((data?.total_minutes ?? 0) / 60).toFixed(1);
  return (
    <CardShell title="이번 주 출퇴근" icon={<Clock className="h-4 w-4 text-emerald-600" />}>
      <div className="text-sm space-y-1">
        <div>
          출근 <b className="tabular-nums">{attended}</b>일
          <span className="text-muted-foreground"> / {workdays}일</span>
        </div>
        <div>
          누적 근무 <b className="tabular-nums">{totalH}</b>시간
        </div>
        {data?.avg_check_in && (
          <div className="text-xs text-muted-foreground tabular-nums">
            평균 출근 {data.avg_check_in}
            {data.avg_check_out && ` · 퇴근 ${data.avg_check_out}`}
          </div>
        )}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 10. 최근 회의록
// ---------------------------------------------------------------------------

type MeetingNoteRow = {
  id: string;
  title: string;
  customer_name: string | null;
  updated_at: string;
};

function RecentMeetingNotesCard() {
  const { data = [] } = useQuery<MeetingNoteRow[]>({
    queryKey: ["meeting-notes", "all"],
    queryFn: async () => (await api.get("/meeting-notes?scope=all")).data,
    staleTime: 60_000,
  });
  const recent = data.slice(0, 5);
  return (
    <CardShell
      title="최근 회의록"
      icon={<FileText className="h-4 w-4 text-blue-600" />}
      href="/meeting-notes"
    >
      {recent.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">회의록이 없습니다.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {recent.map((n) => (
            <li key={n.id}>
              <Link
                href={`/meeting-notes/${n.id}`}
                className="block hover:bg-muted/30 rounded px-1 py-0.5 truncate"
              >
                {n.title}
                {n.customer_name && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    · {n.customer_name}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 11. 최근 공지
// ---------------------------------------------------------------------------

type NoticePost = {
  id: string;
  title: string;
  created_at: string;
  pinned?: boolean;
};

function RecentNoticesCard() {
  const { data = [] } = useQuery<NoticePost[]>({
    queryKey: ["board", "notice", "recent"],
    queryFn: async () =>
      (
        await api.get("/board/posts", {
          params: { category: "NOTICE", limit: 5 },
        })
      ).data,
    staleTime: 60_000,
  });
  return (
    <CardShell
      title="최근 공지"
      icon={<Megaphone className="h-4 w-4 text-amber-600" />}
      href="/notice"
    >
      {data.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">공지가 없습니다.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {data.slice(0, 5).map((p) => (
            <li key={p.id}>
              <Link
                href={`/notice/${p.id}`}
                className="block hover:bg-muted/30 rounded px-1 py-0.5 truncate"
              >
                {p.pinned && (
                  <span className="text-amber-700 mr-1" title="고정">📌</span>
                )}
                {p.title}
                <span className="ml-2 text-xs text-muted-foreground">
                  · {p.created_at.slice(5, 10)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 12. 나의 목표 진행률
// ---------------------------------------------------------------------------

type MyGoal = {
  id: string;
  title: string;
  progress_pct: string | number;
  status: string;
  difficulty?: string;
  priority?: string;
};

function MyGoalsProgressCard() {
  const yr = new Date().getFullYear();
  // /auth/me 의 mapped_developer_id 가 있어야 PERSONAL 목록 조회 가능 (admin
  // 등 매핑 안 된 사용자는 전체에서 자기 것을 추릴 방법이 없음 → 스킵).
  const { data: me } = useQuery<{ mapped_developer_id: string | null }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const myDevId = me?.mapped_developer_id ?? null;
  const { data = [] } = useQuery<MyGoal[]>({
    queryKey: ["goals", "personal", "me", yr, myDevId],
    queryFn: async () =>
      (
        await api.get("/goals", {
          params: { scope: "PERSONAL", owner_id: myDevId, year: yr },
        })
      ).data,
    staleTime: 60_000,
    enabled: !!myDevId,
  });
  // DROPPED 는 제외, 진행 중·완료만 표시. 완료(DONE) 는 progress 100% 로 정렬 끝쪽.
  const visible = data
    .filter((g) => g.status !== "DROPPED")
    .sort((a, b) => Number(a.progress_pct) - Number(b.progress_pct));
  return (
    <CardShell
      title="나의 목표 진행률"
      icon={<Sparkles className="h-4 w-4 text-violet-600" />}
      href="/goals"
    >
      {!myDevId ? (
        <div className="text-xs text-muted-foreground py-3">
          직원 매핑이 없어 목표를 표시할 수 없습니다.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">
          올해 등록된 내 목표가 없습니다.
        </div>
      ) : (
        <ul className="text-xs space-y-2">
          {visible.slice(0, 5).map((g) => {
            // 진행률은 200%까지 가능 (도약 STRETCH 초과 달성). 막대는 100% 캡,
            // 초과분은 보라 → 자주(영광) 색으로 보강.
            const raw = Number(g.progress_pct ?? 0);
            const capped = Math.min(100, Math.max(0, raw));
            const over = raw > 100;
            return (
              <li key={g.id}>
                <div className="flex items-baseline gap-2">
                  <Link
                    href={`/goals/${g.id}`}
                    className="truncate flex-1 text-sm hover:underline"
                  >
                    {g.title}
                  </Link>
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(raw)}%
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 bg-muted rounded overflow-hidden">
                  <div
                    className={
                      "h-1.5 " +
                      (over ? "bg-fuchsia-500" : "bg-violet-500")
                    }
                    style={{ width: `${capped}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// 13. 지연된 액션 — 본인 미완료 + due_date 지난 항목 list.
// ---------------------------------------------------------------------------

type OverdueItem = {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  meeting_note_id: string | null;
};

function OverdueActionsCard() {
  const { data = [] } = useQuery<OverdueItem[]>({
    queryKey: ["my-action-items", false],
    queryFn: async () =>
      (
        await api.get("/meeting-notes/action-items/mine", {
          params: { include_done: false },
        })
      ).data,
    staleTime: 30_000,
  });
  const today = ymd(new Date());
  const overdue = data
    .filter((it) => it.due_date && it.due_date < today)
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
  return (
    <CardShell
      title="지연된 액션"
      icon={<Bell className="h-4 w-4 text-rose-600" />}
      href="/my-actions"
    >
      {overdue.length === 0 ? (
        <div className="text-xs text-muted-foreground py-3">
          지난 마감 액션이 없습니다.
        </div>
      ) : (
        <ul className="text-sm space-y-1">
          {overdue.slice(0, 5).map((it) => {
            const days =
              it.due_date != null ? daysBetween(it.due_date, today) : 0;
            return (
              <li key={it.id} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0 tabular-nums">
                  {it.due_date?.slice(5) ?? "-"}
                </span>
                <span className="truncate flex-1" title={it.title}>
                  {it.title}
                </span>
                <span className="text-xs text-rose-600 font-semibold tabular-nums">
                  D+{days}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

// 사용 안 되는 import 제거 방지용 — (reserved for future use)
void Building2;
