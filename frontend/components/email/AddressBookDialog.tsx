"use client";

/** 주소록 피커 — 검색 + 다중 선택해 수신자에 추가. */

import { useMemo, useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import type { AddressEntry } from "./RecipientInput";

const SOURCE_LABEL: Record<string, string> = {
  user: "직원",
  contact: "고객",
  history: "이전",
};

export function AddressBookDialog({
  entries,
  onClose,
  onConfirm,
}: {
  entries: AddressEntry[];
  onClose: () => void;
  onConfirm: (emails: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return entries;
    return entries.filter(
      (e) =>
        e.email.toLowerCase().includes(t) || e.name.toLowerCase().includes(t),
    );
  }, [q, entries]);

  function toggle(email: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="주소록"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {picked.size}명 선택
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted"
            >
              취소
            </button>
            <button
              type="button"
              disabled={picked.size === 0}
              onClick={() => onConfirm([...picked])}
              className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              추가
            </button>
          </div>
        </div>
      }
    >
      <div className="flex h-[420px] w-[520px] max-w-full flex-col">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="이름·이메일 검색"
          className="mb-2 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        />
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          {filtered.length === 0 && (
            <div className="p-4 text-center text-sm text-muted-foreground">
              결과 없음
            </div>
          )}
          {filtered.map((e) => (
            <label
              key={e.email}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-2 py-1.5 text-sm last:border-b-0 hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={picked.has(e.email)}
                onChange={() => toggle(e.email)}
              />
              <span className="min-w-0 flex-1 truncate">
                {e.name ? (
                  <>
                    <span className="font-medium">{e.name}</span>{" "}
                    <span className="text-muted-foreground">{e.email}</span>
                  </>
                ) : (
                  e.email
                )}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {SOURCE_LABEL[e.source] ?? e.source}
              </span>
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
