"use client";

import { useEffect, useMemo, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import type {
  DirectoryMember,
  MeetingReservation,
  MeetingRoom,
} from "./types";
import { HOUR_END, HOUR_START, fromLocalInput, toLocalInput } from "./time";

function isWithinBusinessHours(startStr: string, endStr: string): boolean {
  const s = fromLocalInput(startStr);
  const e = fromLocalInput(endStr);
  if (
    s.getFullYear() !== e.getFullYear() ||
    s.getMonth() !== e.getMonth() ||
    s.getDate() !== e.getDate()
  ) {
    return false;
  }
  const startMin = s.getHours() * 60 + s.getMinutes();
  const endMin = e.getHours() * 60 + e.getMinutes();
  return startMin >= HOUR_START * 60 && endMin <= HOUR_END * 60;
}

type FormState = {
  room_id: string;
  title: string;
  description: string;
  start_local: string;
  end_local: string;
  participant_developer_ids: string[];
};

export type SaveResult = "created" | "updated" | "cancelled";

type Props = {
  open: boolean;
  onClose: () => void;
  rooms: MeetingRoom[];
  members: DirectoryMember[];
  currentUserId: string | null;
  isAdmin: boolean;
  // 신규 예약 프리필용
  defaultStart?: Date;
  defaultRoomId?: string;
  // 수정 대상
  target?: MeetingReservation | null;
  onSubmit: (form: {
    room_id: string;
    title: string;
    description: string | null;
    start_at: string;
    end_at: string;
    participant_developer_ids: string[];
  }) => Promise<SaveResult>;
  onCancel?: (id: string) => Promise<void>;
  errorText?: string | null;
};

export function ReservationDialog({
  open,
  onClose,
  rooms,
  members,
  currentUserId,
  isAdmin,
  defaultStart,
  defaultRoomId,
  target,
  onSubmit,
  onCancel,
  errorText,
}: Props) {
  const [form, setForm] = useState<FormState>({
    room_id: "",
    title: "",
    description: "",
    start_local: "",
    end_local: "",
    participant_developer_ids: [],
  });
  const [saving, setSaving] = useState(false);

  const editable =
    !target ||
    isAdmin ||
    (!!currentUserId && target.organizer_id === currentUserId);

  useEffect(() => {
    if (!open) return;
    if (target) {
      setForm({
        room_id: target.room_id,
        title: target.title,
        description: target.description ?? "",
        start_local: toLocalInput(new Date(target.start_at)),
        end_local: toLocalInput(new Date(target.end_at)),
        participant_developer_ids: target.participants.map((p) => p.developer_id),
      });
    } else {
      const start = defaultStart ?? new Date();
      const end = new Date(start.getTime() + 30 * 60_000);
      setForm({
        room_id: defaultRoomId ?? rooms[0]?.id ?? "",
        title: "",
        description: "",
        start_local: toLocalInput(start),
        end_local: toLocalInput(end),
        participant_developer_ids: [],
      });
    }
  }, [open, target, defaultStart, defaultRoomId, rooms]);

  const canSubmit = useMemo(() => {
    if (!editable) return false;
    if (!form.room_id) return false;
    if (!form.title.trim()) return false;
    if (!form.start_local || !form.end_local) return false;
    if (
      fromLocalInput(form.end_local).getTime() <=
      fromLocalInput(form.start_local).getTime()
    )
      return false;
    return isWithinBusinessHours(form.start_local, form.end_local);
  }, [form, editable]);

  const hoursHint = `예약 가능 시간: ${String(HOUR_START).padStart(2, "0")}:00 ~ ${String(HOUR_END).padStart(2, "0")}:00`;
  const showHoursWarning =
    !!form.start_local &&
    !!form.end_local &&
    !isWithinBusinessHours(form.start_local, form.end_local);

  async function handleSave() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onSubmit({
        room_id: form.room_id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        start_at: fromLocalInput(form.start_local).toISOString(),
        end_at: fromLocalInput(form.end_local).toISOString(),
        participant_developer_ids: form.participant_developer_ids,
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (!target || !onCancel) return;
    setSaving(true);
    try {
      await onCancel(target.id);
    } finally {
      setSaving(false);
    }
  }

  function toggleParticipant(did: string) {
    setForm((p) => {
      const has = p.participant_developer_ids.includes(did);
      return {
        ...p,
        participant_developer_ids: has
          ? p.participant_developer_ids.filter((x) => x !== did)
          : [...p.participant_developer_ids, did],
      };
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={target ? "예약 상세" : "회의실 예약"}
      width="max-w-lg"
      footer={
        <>
          <div className="mr-auto">
            {target && editable && onCancel && target.status !== "CANCELLED" && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                예약 취소
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          {editable && (
            <button
              type="button"
              disabled={!canSubmit || saving}
              onClick={handleSave}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "저장 중..." : target ? "수정" : "예약"}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {errorText && (
          <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
            {errorText}
          </div>
        )}
        {target?.status === "CANCELLED" && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            이 예약은 취소되었습니다.
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">회의실</span>
          <select
            value={form.room_id}
            onChange={(e) =>
              setForm((p) => ({ ...p, room_id: e.target.value }))
            }
            disabled={!editable}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:bg-muted"
          >
            <option value="">선택…</option>
            {rooms
              .filter((r) => r.is_active || r.id === form.room_id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.location ? ` · ${r.location}` : ""}
                  {r.capacity != null ? ` (${r.capacity}명)` : ""}
                  {!r.is_active ? " · 비활성" : ""}
                </option>
              ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">제목</span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            disabled={!editable}
            maxLength={200}
            placeholder="예) 주간 운영 회의"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:bg-muted"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">시작</span>
            <input
              type="datetime-local"
              step={30 * 60}
              value={form.start_local}
              onChange={(e) =>
                setForm((p) => ({ ...p, start_local: e.target.value }))
              }
              disabled={!editable}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:bg-muted"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">종료</span>
            <input
              type="datetime-local"
              step={30 * 60}
              value={form.end_local}
              onChange={(e) =>
                setForm((p) => ({ ...p, end_local: e.target.value }))
              }
              disabled={!editable}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:bg-muted"
            />
          </label>
        </div>
        <div
          className={
            "text-[11px] " +
            (showHoursWarning ? "text-destructive" : "text-muted-foreground")
          }
        >
          {showHoursWarning
            ? `${hoursHint} · 현재 입력값은 범위를 벗어납니다.`
            : hoursHint}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">설명 (선택)</span>
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) =>
              setForm((p) => ({ ...p, description: e.target.value }))
            }
            disabled={!editable}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm disabled:bg-muted"
          />
        </label>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">
              참석자 ({form.participant_developer_ids.length}명 선택됨)
            </span>
            <span className="text-[10px] text-muted-foreground">
              정규직 · 알림은 주최자 + 참석자에게 전송
            </span>
          </div>
          {members.length === 0 ? (
            <div className="text-xs text-muted-foreground py-1">
              정규직 임직원 목록 로딩 중…
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 rounded-md border border-input bg-background p-2">
              {members
                .slice()
                .sort((a, b) =>
                  (a.name || a.email || "").localeCompare(
                    b.name || b.email || "",
                    "ko-KR",
                  ),
                )
                .map((m) => {
                  const selected = form.participant_developer_ids.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => editable && toggleParticipant(m.id)}
                      disabled={!editable}
                      className={
                        "h-7 rounded-full border px-3 text-xs font-medium transition-colors " +
                        (selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-muted") +
                        (editable ? "" : " opacity-60 cursor-not-allowed")
                      }
                    >
                      {m.name || m.email}
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        {target && (
          <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
            주최자: {target.organizer_name ?? "—"}
          </div>
        )}
      </div>
    </Dialog>
  );
}
