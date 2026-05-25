"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import type { MeetingRoom } from "./types";

type Props = { open: boolean; onClose: () => void };

type FormState = {
  id: string | null;
  name: string;
  location: string;
  capacity: string;
  description: string;
  is_active: boolean;
};

const EMPTY: FormState = {
  id: null,
  name: "",
  location: "",
  capacity: "",
  description: "",
  is_active: true,
};

export function RoomManageDialog({ open, onClose }: Props) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const { data: rooms = [] } = useQuery<MeetingRoom[]>({
    queryKey: ["meeting-rooms"],
    queryFn: async () => (await api.get("/meeting-rooms")).data,
    enabled: open,
  });

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name,
        location: form.location || null,
        capacity: form.capacity ? Number(form.capacity) : null,
        description: form.description || null,
        is_active: form.is_active,
      };
      if (form.id) {
        return (await api.patch(`/meeting-rooms/${form.id}`, payload)).data;
      }
      return (await api.post("/meeting-rooms", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meeting-rooms"] });
      setForm(EMPTY);
      setError(null);
    },
    onError: (e: any) =>
      setError(e?.response?.data?.detail ?? e?.message ?? "저장 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/meeting-rooms/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meeting-rooms"] });
      if (form.id) setForm(EMPTY);
    },
    onError: (e: any) =>
      setError(e?.response?.data?.detail ?? e?.message ?? "삭제 실패"),
  });

  function openEdit(r: MeetingRoom) {
    setForm({
      id: r.id,
      name: r.name,
      location: r.location ?? "",
      capacity: r.capacity != null ? String(r.capacity) : "",
      description: r.description ?? "",
      is_active: r.is_active,
    });
    setError(null);
  }

  function openNew() {
    setForm(EMPTY);
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="회의실 관리"
      width="max-w-2xl"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          닫기
        </button>
      }
    >
      <div className="grid grid-cols-[1fr_1fr] gap-4">
        <div className="flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-muted-foreground">
              회의실 목록 ({rooms.length})
            </div>
            <button
              type="button"
              onClick={openNew}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 text-xs hover:bg-muted"
            >
              <Plus className="h-3 w-3" /> 새로
            </button>
          </div>
          <ul className="max-h-80 overflow-y-auto divide-y divide-border rounded-md border border-border">
            {rooms.length === 0 && (
              <li className="px-3 py-4 text-xs text-muted-foreground text-center">
                등록된 회의실이 없습니다.
              </li>
            )}
            {rooms.map((r) => (
              <li
                key={r.id}
                className={
                  "px-3 py-2 cursor-pointer hover:bg-muted/40 " +
                  (form.id === r.id ? "bg-primary/10" : "")
                }
                onClick={() => openEdit(r)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name}</span>
                  {!r.is_active && (
                    <span className="text-[10px] rounded border border-border bg-muted px-1">
                      비활성
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {r.location ?? "—"}
                  {r.capacity != null ? ` · ${r.capacity}명` : ""}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            {form.id ? "회의실 편집" : "새 회의실"}
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">이름 *</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((p) => ({ ...p, name: e.target.value }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              maxLength={100}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">위치</span>
            <input
              type="text"
              value={form.location}
              onChange={(e) =>
                setForm((p) => ({ ...p, location: e.target.value }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              maxLength={200}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">수용 인원</span>
            <input
              type="number"
              min={0}
              value={form.capacity}
              onChange={(e) =>
                setForm((p) => ({ ...p, capacity: e.target.value }))
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">설명</span>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) =>
                setForm((p) => ({ ...p, is_active: e.target.checked }))
              }
            />
            활성
          </label>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={!form.name.trim() || saveM.isPending}
              onClick={() => saveM.mutate()}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {form.id ? "수정" : "추가"}
            </button>
            {form.id && (
              <button
                type="button"
                onClick={async () => {
                  if (
                    await dialog.confirm(`'${form.name}' 회의실을 삭제하시겠습니까?`, {
                      destructive: true,
                    })
                  ) {
                    deleteM.mutate(form.id!);
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
                삭제
              </button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
