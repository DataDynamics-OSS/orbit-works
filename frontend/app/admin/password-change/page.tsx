"use client";

/**
 * SUPER_ADMIN 본인 비밀번호 변경.
 *
 * 일반 사용자(developer)의 강제 변경 페이지(`/password-change`)와 달리, 여기는
 * 정상 로그인 상태에서 자발적으로 변경하는 화면. `/auth/change-password` 가
 * current_password 검증을 강제하므로 현재 비번 입력 필수.
 */

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export default function AdminPasswordChangePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPw.length < 4) {
      setError("새 비밀번호는 4자 이상이어야 합니다.");
      return;
    }
    if (newPw !== confirmPw) {
      setError("새 비밀번호와 확인이 일치하지 않습니다.");
      return;
    }
    if (newPw === currentPw) {
      setError("새 비밀번호가 현재 비밀번호와 같습니다.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/auth/change-password", {
        current_password: currentPw,
        new_password: newPw,
      });
      await qc.invalidateQueries({ queryKey: ["me"] });
      setSuccess(true);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? "비밀번호 변경에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  const input =
    "h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <>
      <div className="flex h-14 items-center border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">패스워드 변경</h1>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <form
          onSubmit={onSubmit}
          className="max-w-md space-y-4 rounded-lg border border-border bg-card p-5"
        >
          <p className="text-xs text-muted-foreground">
            본인 계정 비밀번호 변경. 현재 비밀번호 확인 후 새 비밀번호로 교체합니다.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="cur" className="text-xs font-medium text-muted-foreground">
              현재 비밀번호
            </label>
            <input
              id="cur"
              type="password"
              autoComplete="current-password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              required
              className={input}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="newpw" className="text-xs font-medium text-muted-foreground">
              새 비밀번호
            </label>
            <input
              id="newpw"
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              minLength={4}
              required
              className={input}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="confirm" className="text-xs font-medium text-muted-foreground">
              새 비밀번호 확인
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              minLength={4}
              required
              className={input}
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              비밀번호가 변경되었습니다.
            </div>
          )}

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {submitting ? "변경 중..." : "비밀번호 변경"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
