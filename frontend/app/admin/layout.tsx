"use client";

/**
 * SUPER_ADMIN 전용 레이아웃.
 *
 * 일반 사용자(role !== SUPER_ADMIN)가 진입하면 /dashboard 로 리다이렉트.
 * SUPER_ADMIN 은 도메인 데이터(직원·고객·게시판 등) 비노출 — 사이드바엔
 * "Tenant 관리" 만 표시.
 *
 * 시각: tenant Sidebar 와 동일한 색·타이포·로고 블록·푸터 사용해 일관성 유지.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, Building2, Database, HardDrive, History, KeyRound, Megaphone, Settings as SettingsIcon } from "lucide-react";
import { api, clearToken, getToken } from "@/lib/api";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  const { data: me } = useQuery<{
    is_super_admin?: boolean;
    name?: string;
    email?: string;
    role?: string;
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    enabled: ready,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!me) return;
    if (!me.is_super_admin) {
      router.replace("/dashboard");
    }
  }, [me, router]);

  if (!ready || !me) return null;
  if (!me.is_super_admin) return null;

  function logout() {
    clearToken();
    qc.clear();
    router.replace("/login");
  }

  const initial = (me.name || me.email || "?").slice(0, 1).toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="relative shrink-0 w-48 bg-sidebar text-sidebar-foreground border-r border-sidebar-border min-h-screen flex flex-col">
        <div className="flex items-center h-16 border-b border-sidebar-border">
          <Link
            href="/admin/tenants"
            className="group/item relative flex flex-col justify-center flex-1 min-w-0 h-full px-4"
          >
            <div className="text-xl font-semibold text-sidebar-accent-foreground leading-none">
              Orbit Works
            </div>
            <div className="text-xs text-sidebar-muted mt-1">Super Admin</div>
          </Link>
        </div>

        <nav className="flex-1 py-3 overflow-auto">
          <div className="px-2 mb-3">
            <div className="w-full flex items-center justify-between px-2 pb-1 text-[11px] uppercase tracking-wide text-sidebar-muted">
              <span>관리</span>
            </div>
            <div className="space-y-0.5">
              <NavLink
                href="/admin/tenants"
                pathname={pathname}
                icon={<Building2 className="h-4 w-4" />}
                label="Tenant 관리"
              />
              <NavLink
                href="/admin/system-info"
                pathname={pathname}
                icon={<Activity className="h-4 w-4" />}
                label="시스템 정보"
              />
              <NavLink
                href="/admin/db-backups"
                pathname={pathname}
                icon={<HardDrive className="h-4 w-4" />}
                label="백업"
              />
              <NavLink
                href="/admin/announcements"
                pathname={pathname}
                icon={<Megaphone className="h-4 w-4" />}
                label="공공 사업공고 Source"
              />
              <NavLink
                href="/admin/data-sources"
                pathname={pathname}
                icon={<Database className="h-4 w-4" />}
                label="외부 데이터 연동"
              />
              <NavLink
                href="/admin/system-settings"
                pathname={pathname}
                icon={<SettingsIcon className="h-4 w-4" />}
                label="시스템 설정"
              />
              <NavLink
                href="/admin/job-runs"
                pathname={pathname}
                icon={<History className="h-4 w-4" />}
                label="작업 이력"
              />
              <NavLink
                href="/admin/password-change"
                pathname={pathname}
                icon={<KeyRound className="h-4 w-4" />}
                label="패스워드 변경"
              />
            </div>
          </div>
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <div className="p-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-7 w-7 rounded-full bg-sidebar-accent grid place-items-center text-xs font-semibold">
                {initial}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm text-sidebar-accent-foreground">
                  {me.name || me.email || "-"}
                </div>
                <div className="truncate text-[11px] text-sidebar-muted">
                  {me.role || ""}
                </div>
              </div>
            </div>
            <button
              onClick={logout}
              className="w-full rounded-md bg-sidebar-accent/60 hover:bg-sidebar-accent px-3 py-1.5 text-xs"
            >
              Logout
            </button>
          </div>
        </div>
      </aside>
      <main className="flex flex-1 flex-col min-w-0 min-h-0 bg-muted/30">
        {children}
      </main>
    </div>
  );
}

function NavLink({
  href,
  pathname,
  icon,
  label,
}: {
  href: string;
  pathname: string;
  icon: React.ReactNode;
  label: string;
}) {
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={clsx(
        "group/item relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/60",
      )}
    >
      <span className="text-sidebar-muted">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}
