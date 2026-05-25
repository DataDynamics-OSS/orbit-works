"use client";

import { FormEvent, KeyboardEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, setToken, clearToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // 입력 필드에서 Enter 누르면 폼 제출. (HTML 기본 동작이지만 일부 브라우저
  // 확장이 가로채는 경우가 있어 명시적으로 한 번 더 보장.)
  function onEnterSubmit(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // 이전 세션 잔재 제거 — 로그인 요청에 구 JWT 가 Authorization 헤더로 붙지
      // 않도록 쿠키 초기화. React Query 의 전 세션 캐시도 제거해 ["me"] 등
      // staleTime 안에 있는 데이터가 새 사용자 UI 에 섞이지 않도록.
      clearToken();
      qc.clear();
      const { data } = await api.post<{ access_token: string }>("/auth/login", {
        email: username,
        password,
      });
      setToken(data.access_token);
      // 비번 빈 칸 = 생년월일 자동 대체 → /me 가 must_change_password=true 반환.
      // 강제 변경 화면으로 보내고, 평소엔 dashboard.
      try {
        const { data: me } = await api.get<{
          must_change_password?: boolean;
          is_super_admin?: boolean;
        }>("/auth/me");
        if (me.must_change_password) {
          router.replace("/password-change");
          return;
        }
        if (me.is_super_admin) {
          router.replace("/admin/tenants");
          return;
        }
      } catch {
        /* /me 실패하면 그냥 dashboard 시도 — 거기서도 가드가 한 번 더 잡음 */
      }
      router.replace("/dashboard");
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? "로그인 실패");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card text-card-foreground shadow-sm">
        <div className="flex flex-col space-y-1.5 p-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Orbit Works</h1>
          <p className="text-sm text-muted-foreground">Sign in to your account</p>
        </div>
        <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4 p-6 pt-0">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="username"
              className="text-sm font-medium leading-none"
            >
              Email
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onEnterSubmit}
              placeholder="회사 이메일 또는 admin"
              autoComplete="username"
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="password"
              className="text-sm font-medium leading-none"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onEnterSubmit}
              placeholder="첫 로그인은 생년월일(주민번호 앞 6자리)"
              autoComplete="current-password"
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <div className="border-t border-border px-6 py-4">
          <p className="text-center text-xs text-muted-foreground">
            Copyright © {new Date().getFullYear()} Orbit Works. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
