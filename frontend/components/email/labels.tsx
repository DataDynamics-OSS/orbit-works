"use client";

/**
 * 이메일 라벨 — 타입/배지/적용 드롭다운/관리 다이얼로그.
 * 계정 단위 공유 라벨(로컬 전용). page.tsx 에서 재사용.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2, X } from "lucide-react";

import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

export type Label = {
  id: string;
  account_id: string;
  name: string;
  color: string | null;
};

// 라벨 색 팔레트(생성/편집 picker).
export const LABEL_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  "#64748b",
];
const DEFAULT_COLOR = "#64748b";

export function useLabels(accountId: string | null) {
  return useQuery<Label[]>({
    queryKey: ["email-labels", accountId],
    queryFn: async () =>
      (await api.get(`/email/accounts/${accountId}/labels`)).data,
    enabled: !!accountId,
    staleTime: 60_000,
  });
}

/** 작은 라벨 배지(목록/상세). */
export function LabelBadge({ label }: { label: Label }) {
  const color = label.color || DEFAULT_COLOR;
  return (
    <span
      title={label.name}
      className="inline-flex max-w-[120px] items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
      style={{ backgroundColor: color }}
    >
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** 선택 메일들에 라벨 적용/해제 드롭다운.
 *  currentLabelIds: 단건 선택 시 현재 라벨(체크 표시용). 다건이면 비워도 됨. */
export function LabelApplyMenu({
  accountId,
  labels,
  emailIds,
  currentLabelIds = [],
  onClose,
  onManage,
}: {
  accountId: string;
  labels: Label[];
  emailIds: string[];
  currentLabelIds?: string[];
  onClose: () => void;
  onManage: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [checked, setChecked] = useState<Set<string>>(new Set(currentLabelIds));

  const applyM = useMutation({
    mutationFn: async (v: { labelId: string; attach: boolean }) =>
      (
        await api.post("/email/labels/apply", {
          email_ids: emailIds,
          label_id: v.labelId,
          attach: v.attach,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-messages"] });
      qc.invalidateQueries({ queryKey: ["email-message"] });
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "라벨 적용 실패", { title: "오류" }),
  });

  function toggle(labelId: string) {
    const attach = !checked.has(labelId);
    setChecked((prev) => {
      const next = new Set(prev);
      if (attach) next.add(labelId);
      else next.delete(labelId);
      return next;
    });
    applyM.mutate({ labelId, attach });
  }

  return (
    <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border border-border bg-card shadow-md">
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        라벨 {emailIds.length > 1 ? `(${emailIds.length}개 메일)` : ""}
      </div>
      <div className="max-h-60 overflow-auto">
        {labels.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            라벨이 없습니다.
          </div>
        )}
        {labels.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => toggle(l.id)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: l.color || DEFAULT_COLOR }}
            />
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
            {checked.has(l.id) && <Check className="h-3.5 w-3.5 text-primary" />}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onManage}
        className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-primary hover:bg-muted"
      >
        <Plus className="h-3.5 w-3.5" /> 라벨 만들기·관리
      </button>
    </div>
  );
}

/** 라벨 관리 다이얼로그 — 생성/이름·색 편집/삭제. */
export function LabelManageDialog({
  accountId,
  labels,
  onClose,
}: {
  accountId: string;
  labels: Label[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_COLORS[5]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["email-labels", accountId] });

  const createM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/email/labels", {
          account_id: accountId,
          name: newName.trim(),
          color: newColor,
        })
      ).data,
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "생성 실패", { title: "오류" }),
  });

  const updateM = useMutation({
    mutationFn: async (v: { id: string; name?: string; color?: string }) =>
      (await api.patch(`/email/labels/${v.id}`, { name: v.name, color: v.color }))
        .data,
    onSuccess: invalidate,
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "수정 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/email/labels/${id}`)).data,
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["email-messages"] });
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  return (
    <Dialog open onClose={onClose} title="라벨 관리" width="max-w-[420px]">
      <div className="w-full space-y-3">
        {/* 새 라벨 */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="text-[11px] text-muted-foreground">새 라벨</div>
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) createM.mutate();
              }}
              placeholder="라벨 이름"
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            />
            <button
              type="button"
              disabled={!newName.trim() || createM.isPending}
              onClick={() => createM.mutate()}
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              추가
            </button>
          </div>
          <ColorPicker value={newColor} onChange={setNewColor} />
        </div>

        {/* 기존 라벨 목록 */}
        <div className="space-y-1">
          {labels.length === 0 && (
            <div className="py-2 text-center text-sm text-muted-foreground">
              아직 라벨이 없습니다.
            </div>
          )}
          {labels.map((l) => (
            <LabelRow
              key={l.id}
              label={l}
              onRename={(name) => updateM.mutate({ id: l.id, name })}
              onRecolor={(color) => updateM.mutate({ id: l.id, color })}
              onDelete={async () => {
                const ok = await dialog.confirm(
                  `'${l.name}' 라벨을 삭제할까요? 메일에서도 제거됩니다.`,
                  { destructive: true },
                );
                if (ok) deleteM.mutate(l.id);
              }}
            />
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full ${
            value === c ? "ring-2 ring-offset-1 ring-foreground" : ""
          }`}
          style={{ backgroundColor: c }}
          aria-label={`색 ${c}`}
        />
      ))}
    </div>
  );
}

function LabelRow({
  label,
  onRename,
  onRecolor,
  onDelete,
}: {
  label: Label;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);

  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-2">
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          style={{ backgroundColor: label.color || DEFAULT_COLOR }}
        />
        {editing ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            autoFocus
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{label.name}</span>
        )}
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => {
                if (name.trim() && name.trim() !== label.name) onRename(name.trim());
                setEditing(false);
              }}
              className="rounded p-1 text-muted-foreground hover:text-primary"
              aria-label="저장"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setName(label.name);
                setEditing(false);
              }}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="취소"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
            >
              이름
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded p-1 text-muted-foreground hover:text-rose-600"
              aria-label="삭제"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      <div className="mt-2 pl-5">
        <ColorPicker value={label.color || DEFAULT_COLOR} onChange={onRecolor} />
      </div>
    </div>
  );
}
