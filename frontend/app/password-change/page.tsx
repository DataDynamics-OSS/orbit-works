"use client";

/**
 * 강제 비밀번호 변경 — 첫 로그인(생년월일) 또는 관리자 재설정 직후.
 *
 * 진입 경로:
 * - /login 직후 /auth/me 가 must_change_password=true 반환
 * - dashboard layout 의 가드가 모든 인증 페이지에서 redirect
 *
 * 본인은 자기 비번(생년월일)을 다시 입력할 필요 없이 새 비번 + 확인만 입력.
 * 백엔드 `/developers/me/initial-password` 가 must_change_password 여부를 다시
 * 확인하므로 이 화면을 우회해 호출해도 안전.
 */

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, clearToken, getToken } from "@/lib/api";

export default function PasswordChangePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 토큰 없으면 로그인으로.
  useEffect(() => {
    if (!getToken()) router.replace("/login");
  }, [router]);

  // 강제 변경 대상이 아닌 사용자가 우연히 진입하면 dashboard 로 돌려보냄.
  const { data: me } = useQuery<{
    must_change_password?: boolean;
    needs_mapping?: boolean;
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 0,
  });
  useEffect(() => {
    if (!me) return;
    if (!me.must_change_password) {
      router.replace(me.needs_mapping ? "/setup" : "/dashboard");
    }
  }, [me, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPw.length < 4) {
      setError("새 비밀번호는 4자 이상이어야 합니다.");
      return;
    }
    if (newPw !== confirmPw) {
      setError("새 비밀번호와 확인이 일치하지 않습니다.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/developers/me/initial-password", {
        new_password: newPw,
      });
      // /me 캐시 무효화 → must_change_password 갱신.
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/dashboard");
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? "비밀번호 변경에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  function logout() {
    clearToken();
    qc.clear();
    router.replace("/login");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card text-card-foreground shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6 text-center">
          <h1 className="text-xl font-bold tracking-tight">비밀번호 변경</h1>
          <p className="text-sm text-muted-foreground">
            첫 로그인 또는 관리자 재설정 후에는
            <br />
            새 비밀번호를 설정해 주세요.
          </p>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 p-6 pt-0">
          <div className="flex flex-col gap-2">
            <label htmlFor="newpw" className="text-sm font-medium">
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
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="confirm" className="text-sm font-medium">
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
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "저장 중..." : "비밀번호 저장"}
          </button>
          <button
            type="button"
            onClick={logout}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            로그아웃
          </button>
        </form>
      </div>
    </div>
  );
}
