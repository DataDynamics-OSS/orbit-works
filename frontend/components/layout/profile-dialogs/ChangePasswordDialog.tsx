"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { SavedAtLabel } from "@/components/ui/SavedAtLabel";

export function ChangePasswordDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useDialog();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setSavedAt(null);
  }

  const mut = useMutation({
    mutationFn: async () => {
      await api.post("/auth/change-password", {
        current_password: current,
        new_password: next,
      });
    },
    onSuccess: () => {
      setSavedAt(new Date());
      // 비밀번호 필드는 비워둠 — 같은 비번 재입력하지 않도록.
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: async (e: unknown) => {
      const msg =
        (e as AxiosError<{ detail?: string }>)?.response?.data?.detail ||
        "비밀번호 변경 실패";
      await dialog.alert(msg);
    },
  });

  function submit() {
    if (!current || !next) return;
    if (next !== confirm) {
      dialog.alert("새 비밀번호와 확인이 일치하지 않습니다.");
      return;
    }
    mut.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="비밀번호 변경"
      footer={
        <>
          <SavedAtLabel at={savedAt} prefix="변경됨" autoHideMs={4000} />
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {savedAt ? "닫기" : "취소"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mut.isPending || !current || !next || !confirm}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mut.isPending ? "변경 중..." : "변경"}
          </button>
        </>
      }
    >
      <Field label="현재 비밀번호">
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        />
      </Field>
      <Field label="새 비밀번호">
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        />
      </Field>
      <Field label="새 비밀번호 확인">
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        />
      </Field>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}
