"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Settings } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Tooltip } from "@/components/ui/Tooltip";
import { ReservationDialog } from "@/components/meetings/ReservationDialog";
import { RoomManageDialog } from "@/components/meetings/RoomManageDialog";
import { WeekGrid } from "@/components/meetings/WeekGrid";
import {
  addDays,
  isoWeekNumber,
  startOfWeek,
  ymd,
} from "@/components/meetings/time";
import type {
  DirectoryMember,
  MeetingReservation,
  MeetingRoom,
} from "@/components/meetings/types";

// /calendar 응답 — 휴일 3종 + 일정 2종.
//   STATUTORY/TEMPORARY/COMPANY = 휴일
//   EVENT_PUBLIC                = 공개 일정
//   EVENT_PRIVATE               = 비공개 일정 (HR/ADMIN/SUPER_ADMIN 만 보기)
type HolidayType =
  | "STATUTORY"
  | "TEMPORARY"
  | "COMPANY"
  | "EVENT_PUBLIC"
  | "EVENT_PRIVATE";

type Holiday = {
  id: string;
  date: string;
  name: string;
  type: HolidayType;
};

// /events 응답 — 워크샵 / 컨퍼런스 / 출장.
type EventKind = "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";

type EventItem = {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  kind: EventKind;
};

export default function MeetingsPage() {
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [roomId, setRoomId] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<MeetingReservation | null>(
    null,
  );
  const [dialogDefaultStart, setDialogDefaultStart] = useState<Date | undefined>();
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [roomMgmtOpen, setRoomMgmtOpen] = useState(false);

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

  const { data: me } = useQuery<{ id: string; email: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const isAdmin = me?.role === "ADMIN";
  const currentUserId = me?.id ?? null;
  // 비공개 일정(EVENT_PRIVATE) 노출 — HR/ADMIN/SUPER_ADMIN.
  // 백엔드도 권한 체크하지만 클라이언트에서도 한 번 더 필터해 안전망.
  const canSeePrivate =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  const { data: rooms = [] } = useQuery<MeetingRoom[]>({
    queryKey: ["meeting-rooms"],
    queryFn: async () => (await api.get("/meeting-rooms")).data,
  });

  // 기본 선택 회의실 = 첫 활성 회의실.
  const effectiveRoomId = useMemo(() => {
    if (roomId) return roomId;
    return rooms.find((r) => r.is_active)?.id ?? "";
  }, [roomId, rooms]);

  // 참석자 후보는 '정규직' 임직원 (developers 기준).
  const { data: members = [] } = useQuery<DirectoryMember[]>({
    queryKey: ["developers-directory", "FULL_TIME"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 5 * 60 * 1000,
  });

  // 로그인한 사용자 이메일이 developers 의 어떤 row 와 매칭되는지 찾아서
  // 현재 사용자가 '참석자'인 예약을 강조할 때 사용.
  const currentDeveloperId = useMemo(() => {
    if (!me?.email) return null;
    return members.find((m) => m.email === me.email)?.id ?? null;
  }, [me?.email, members]);

  const { data: reservations = [] } = useQuery<MeetingReservation[]>({
    queryKey: [
      "meeting-reservations",
      effectiveRoomId,
      ymd(weekStart),
      ymd(weekEnd),
    ],
    queryFn: async () => {
      if (!effectiveRoomId) return [];
      const params = {
        room_id: effectiveRoomId,
        from: weekStart.toISOString(),
        to: weekEnd.toISOString(),
      };
      return (await api.get("/meeting-reservations", { params })).data;
    },
    enabled: !!effectiveRoomId,
  });

  const { data: holidaysRaw = [] } = useQuery<Holiday[]>({
    queryKey: ["calendar", weekStart.getFullYear()],
    queryFn: async () =>
      (await api.get("/calendar", { params: { year: weekStart.getFullYear() } }))
        .data,
    staleTime: 60 * 60 * 1000,
  });
  // 비공개 일정은 HR/ADMIN/SUPER_ADMIN 만 — 그 외 역할은 클라이언트에서도 제거.
  const holidays = useMemo(
    () =>
      canSeePrivate
        ? holidaysRaw
        : holidaysRaw.filter((h) => h.type !== "EVENT_PRIVATE"),
    [holidaysRaw, canSeePrivate],
  );
  // 주말/휴일 음영용 — 휴일 3종 + 공휴일 성격. EVENT_* 는 영업일이라 음영 X.
  const holidayDates = useMemo(
    () =>
      new Set(
        holidays
          .filter(
            (h) =>
              h.type === "STATUTORY" ||
              h.type === "TEMPORARY" ||
              h.type === "COMPANY",
          )
          .map((h) => h.date),
      ),
    [holidays],
  );

  const { data: events = [] } = useQuery<EventItem[]>({
    queryKey: ["events-all", weekStart.getFullYear()],
    queryFn: async () =>
      (
        await api.get("/events", {
          params: { year: weekStart.getFullYear() },
        })
      ).data,
    staleTime: 60 * 60 * 1000,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["meeting-reservations"] });

  const createOrUpdateM = useMutation({
    mutationFn: async (payload: {
      id?: string;
      room_id: string;
      title: string;
      description: string | null;
      start_at: string;
      end_at: string;
      participant_developer_ids: string[];
    }) => {
      if (payload.id) {
        const { id, room_id: _unused, ...rest } = payload;
        return (await api.patch(`/meeting-reservations/${id}`, rest)).data;
      }
      return (await api.post("/meeting-reservations", payload)).data;
    },
  });

  const cancelM = useMutation({
    mutationFn: async (id: string) => api.delete(`/meeting-reservations/${id}`),
  });

  function openNew(start?: Date) {
    setDialogTarget(null);
    setDialogDefaultStart(start);
    setDialogError(null);
    setDialogOpen(true);
  }

  function openExisting(res: MeetingReservation) {
    setDialogTarget(res);
    setDialogDefaultStart(undefined);
    setDialogError(null);
    setDialogOpen(true);
  }

  async function handleSubmit(form: {
    room_id: string;
    title: string;
    description: string | null;
    start_at: string;
    end_at: string;
    participant_developer_ids: string[];
  }) {
    try {
      await createOrUpdateM.mutateAsync({
        id: dialogTarget?.id,
        ...form,
      });
      await invalidate();
      setDialogOpen(false);
      return dialogTarget ? "updated" : "created";
    } catch (e: any) {
      setDialogError(e?.response?.data?.detail ?? e?.message ?? "저장 실패");
      throw e;
    }
  }

  async function handleCancel(id: string) {
    try {
      await cancelM.mutateAsync(id);
      await invalidate();
      setDialogOpen(false);
    } catch (e: any) {
      setDialogError(e?.response?.data?.detail ?? e?.message ?? "취소 실패");
    }
  }

  const weekLabel = `${ymd(weekStart)} ~ ${ymd(addDays(weekStart, 6))} · W${isoWeekNumber(
    weekStart,
  )}`;

  return (
    <>
      <DashboardHeader
        title="회의실 예약"
        actions={
          <div className="flex items-center gap-2">
            <Tooltip label="이전 주" side="bottom">
              <button
                type="button"
                onClick={() => setWeekStart((w) => addDays(w, -7))}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted"
                aria-label="이전 주"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={() => setWeekStart(startOfWeek(new Date()))}
              className="h-8 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
            >
              이번 주
            </button>
            <Tooltip label="다음 주" side="bottom">
              <button
                type="button"
                onClick={() => setWeekStart((w) => addDays(w, 7))}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card hover:bg-muted"
                aria-label="다음 주"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </Tooltip>
            <span className="h-8 inline-flex items-center rounded-md border border-border bg-card px-3 text-xs">
              {weekLabel}
            </span>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            {isAdmin && (
              <button
                type="button"
                onClick={() => setRoomMgmtOpen(true)}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
              >
                <Settings className="h-3.5 w-3.5" />
                회의실 관리
              </button>
            )}
            <button
              type="button"
              onClick={() => openNew()}
              disabled={!effectiveRoomId}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />새 예약
            </button>
          </div>
        }
      />

      <div className="flex flex-col gap-3 p-4 min-h-0 flex-1 overflow-hidden">
        {/* 회의실 탭 */}
        {rooms.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
            등록된 회의실이 없습니다.
            {isAdmin && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setRoomMgmtOpen(true)}
                  className="underline text-primary"
                >
                  회의실 추가하기
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1 items-center">
              {rooms
                .filter((r) => r.is_active)
                .map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRoomId(r.id)}
                    className={
                      "h-8 rounded-md border px-3 text-xs " +
                      (effectiveRoomId === r.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-muted")
                    }
                  >
                    {r.name}
                    {r.capacity != null && (
                      <span className="ml-1 opacity-70">({r.capacity}명)</span>
                    )}
                  </button>
                ))}
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              <WeekGrid
                weekStart={weekStart}
                reservations={reservations}
                holidayDates={holidayDates}
                holidays={holidays}
                events={events}
                currentUserId={currentUserId}
                currentDeveloperId={currentDeveloperId}
                onSlotClick={openNew}
                onReservationClick={openExisting}
              />
            </div>

            {/* 범례 */}
            <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              <LegendSwatch className="bg-primary" label="내가 주최" />
              <LegendSwatch
                className="bg-primary/10 border border-primary/40"
                label="내가 참석"
              />
              <LegendSwatch className="bg-slate-400" label="타인 예약" />
              <LegendSwatch className="bg-slate-300/70" label="취소됨" />
              <LegendSwatch className="bg-slate-100 border border-border" label="주말/휴일" />
            </div>
          </>
        )}
      </div>

      <ReservationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        rooms={rooms}
        members={members}
        currentUserId={currentUserId}
        isAdmin={!!isAdmin}
        defaultStart={dialogDefaultStart}
        defaultRoomId={effectiveRoomId}
        target={dialogTarget}
        onSubmit={async (f) => {
          await handleSubmit(f);
          return dialogTarget ? "updated" : "created";
        }}
        onCancel={handleCancel}
        errorText={dialogError}
      />

      {isAdmin && (
        <RoomManageDialog
          open={roomMgmtOpen}
          onClose={() => setRoomMgmtOpen(false)}
        />
      )}
    </>
  );
}

function LegendSwatch({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-3 h-3 rounded ${className}`} />
      {label}
    </span>
  );
}
