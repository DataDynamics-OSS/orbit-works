"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "@/components/layout/Sidebar";
import { SidebarProvider } from "@/components/layout/SidebarContext";
import { MemoDrawer } from "@/components/memo/MemoDrawer";
import { MemoProvider } from "@/components/memo/MemoProvider";
import { CalculatorDrawer } from "@/components/calculator/CalculatorDrawer";
import { CalculatorProvider } from "@/components/calculator/CalculatorProvider";
import { QuickCalendarDrawer } from "@/components/quick-calendar/QuickCalendarDrawer";
import { QuickCalendarProvider } from "@/components/quick-calendar/QuickCalendarProvider";
import { BookmarkDrawer } from "@/components/bookmarks/BookmarkDrawer";
import { BookmarkProvider } from "@/components/bookmarks/BookmarkProvider";
import { KakaoMapLoader } from "@/components/integrations/KakaoMapLoader";
import { FloatingChat } from "@/components/assistant/FloatingChat";
import {
  isMenuVisible,
  resolveMenuKeyFromPath,
} from "@/components/layout/menu-registry";
import { api, getToken } from "@/lib/api";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  const { data: me } = useQuery<{
    role?: string;
    must_change_password?: boolean;
    is_super_admin?: boolean;
    // 사용자별 추가 메뉴 부여 — Sidebar 와 동일한 OR 처리를 route guard 에도 적용.
    menu_grants?: string[];
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    enabled: ready,
    staleTime: 5 * 60 * 1000,
  });

  // Sidebar 와 동일한 queryKey — 캐시 공유라 추가 요청 없음.
  const { data: menuPerms } = useQuery<Record<string, string[]>>({
    queryKey: ["menu-permissions"],
    queryFn: async () => (await api.get("/menu-permissions")).data,
    enabled: !!me && !me.is_super_admin,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!me) return;
    // SUPER_ADMIN 은 도메인 데이터 비노출 — /admin 영역으로 강제 이동.
    if (me.is_super_admin) {
      router.replace("/admin/tenants");
      return;
    }
    // 생년월일 = 현재 비번 OR 관리자 재설정 직후 → /password-change 강제 이동.
    if (me.must_change_password) {
      router.replace("/password-change");
    }
  }, [me, pathname, router]);

  // URL 기반 메뉴 권한 가드.
  // 사이드바를 통하지 않고 URL 을 직접 입력해도 권한 없는 메뉴는 차단.
  // - menu_key 매칭 안 되는 경로(루트, /password-change, /help 등)는 통과
  // - ADMIN/SUPER_ADMIN 은 통과 (isMenuVisible 내부 처리)
  // - 권한 없으면 루트('/')로 redirect
  const menuKey = resolveMenuKeyFromPath(pathname);
  const blocked =
    !!me &&
    !me.is_super_admin &&
    !!menuPerms &&
    menuKey !== null &&
    !isMenuVisible(menuPerms, menuKey, me.role, me.menu_grants);

  useEffect(() => {
    if (!blocked) return;
    router.replace("/");
  }, [blocked, router]);

  if (!ready) return null;
  // 권한 데이터 로딩 중인데 menu_key 가 매칭되는 경로면 children 렌더 보류.
  // 사이드바와 동시 로드되므로 보통 즉시 통과되며, 권한 부족이면 위 useEffect 가 redirect.
  if (me && !me.is_super_admin && menuKey !== null && !menuPerms) return null;
  if (blocked) return null;

  return (
    <SidebarProvider>
      <MemoProvider>
        <CalculatorProvider>
          <QuickCalendarProvider>
            <BookmarkProvider>
              <div className="flex h-screen overflow-hidden">
                <Sidebar />
                <main className="flex flex-1 flex-col min-w-0 min-h-0 bg-muted/30">{children}</main>
              </div>
              <MemoDrawer />
              <CalculatorDrawer />
              <QuickCalendarDrawer />
              <BookmarkDrawer />
              {/* Kakao Map SDK — Settings > 외부 연동 > Kakao Map API 활성 시 자동 주입. */}
              <KakaoMapLoader />
              {/* AI 어시스턴트 floating chat — assistant.enabled 일 때만 표시. */}
              <FloatingChat />
            </BookmarkProvider>
          </QuickCalendarProvider>
        </CalculatorProvider>
      </MemoProvider>
    </SidebarProvider>
  );
}
