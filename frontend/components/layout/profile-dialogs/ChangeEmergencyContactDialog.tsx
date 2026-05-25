"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { SavedAtLabel } from "@/components/ui/SavedAtLabel";

type Item = {
  name: string;
  relation: string;
  phone: string;
};

const EMPTY: Item = { name: "", relation: "", phone: "" };

export function ChangeEmergencyContactDialog({
  open,
  onClose,
  developerId,
}: {
  open: boolean;
  onClose: () => void;
  developerId: string;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [items, setItems] = useState<Item[]>([EMPTY]);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) setSavedAt(null);
  }, [open]);

  const { data, isLoading } = useQuery<
    { name: string | null; relation: string | null; phone: string | null }[]
  >({
    queryKey: ["my-emergency-contacts", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/emergency-contacts`)).data,
    enabled: open,
  });

  useEffect(() => {
    if (!data) return;
    if (data.length === 0) {
      setItems([{ ...EMPTY }]);
    } else {
      setItems(
        data.map((d) => ({
          name: d.name || "",
          relation: d.relation || "",
          phone: d.phone || "",
        })),
      );
    }
  }, [data]);

  const mut = useMutation({
    mutationFn: async () => {
      const payload = items
        .filter((it) => it.name || it.relation || it.phone)
        .map((it) => ({
          name: it.name || null,
          relation: it.relation || null,
          phone: it.phone || null,
        }));
      return (
        await api.put(`/developers/${developerId}/emergency-contacts`, {
          items: payload,
        })
      ).data;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: ["my-emergency-contacts", developerId],
      });
      setSavedAt(new Date());
    },
    onError: async (e: unknown) => {
      const msg =
        (e as AxiosError<{ detail?: string }>)?.response?.data?.detail ||
        "비상연락처 저장 실패";
      await dialog.alert(msg);
    },
  });

  function update(i: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  function add() {
    setItems((prev) => [...prev, { ...EMPTY }]);
  }

  function remove(i: number) {
    setItems((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length === 0 ? [{ ...EMPTY }] : next;
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="비상연락처 변경"
      width="max-w-xl"
      footer={
        <>
          <SavedAtLabel at={savedAt} autoHideMs={4000} />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {savedAt ? "닫기" : "취소"}
          </button>
          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || isLoading}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mut.isPending ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="grid grid-cols-12 gap-2 text-[11px] text-muted-foreground px-1">
          <div className="col-span-4">이름</div>
          <div className="col-span-3">관계</div>
          <div className="col-span-4">전화</div>
          <div className="col-span-1" />
        </div>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <input
              type="text"
              value={it.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="홍길동"
              className="col-span-4 h-9 rounded-md border border-border bg-background px-2 text-sm"
            />
            <input
              type="text"
              value={it.relation}
              onChange={(e) => update(i, { relation: e.target.value })}
              placeholder="부/모/배우자 …"
              className="col-span-3 h-9 rounded-md border border-border bg-background px-2 text-sm"
            />
            <input
              type="text"
              value={it.phone}
              onChange={(e) => update(i, { phone: e.target.value })}
              placeholder="010-0000-0000"
              className="col-span-4 h-9 rounded-md border border-border bg-background px-2 text-sm"
            />
            <button
              type="button"
              onClick={() => remove(i)}
              className="col-span-1 h-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-muted"
              aria-label="삭제"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> 행 추가
        </button>
      </div>
    </Dialog>
  );
}
