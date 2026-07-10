"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import localFont from "next/font/local";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Activity,
  Award,
  BarChart3,
  Banknote,
  BellRing,
  Bookmark as BookmarkIcon,
  BookOpen,
  Boxes,
  Building2,
  Calculator,
  Calendar,
  CalendarClock,
  CalendarDays,
  Car,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  ClipboardSignature,
  Clock,
  Cloud,
  Contact,
  FileBarChart,
  FileCheck,
  FileText,
  Filter,
  FlaskConical,
  FolderKanban,
  GitBranch,
  Globe,
  HandCoins,
  HelpCircle,
  History,
  Key,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  Lightbulb,
  Link2,
  Inbox,
  ListChecks,
  LogOut,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  Newspaper,
  NotebookPen,
  Package,
  PartyPopper,
  PieChart,
  PiggyBank,
  Plane,
  Receipt,
  ReceiptText,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Tag,
  Target,
  TreePalm,
  TrendingUp,
  UserCog,
  Users,
} from "lucide-react";
import { api, clearToken } from "@/lib/api";
import { UserMenu } from "@/components/layout/UserMenu";
import { Tooltip } from "@/components/ui/Tooltip";
import { useSidebar } from "./SidebarContext";
import {
  MENU_GROUP_ORDER,
  MENU_REGISTRY,
  isMenuVisible,
} from "./menu-registry";

// 사이드바 헤더 브랜드 텍스트("Orbit Works") 전용 폰트.
// app/fonts/ 의 RobotoCondensed-Variable.woff2 를 self-host. layout.tsx 와 동일
// 자산을 클라이언트 컴포넌트에서 별도 로드 (next/font 는 호출 지점별 인스턴스).
const brandFont = localFont({
  src: "../../app/fonts/RobotoCondensed-Variable.woff2",
  weight: "100 900",
  display: "swap",
});

// 접힌 그룹 상태 persistence. 저장 형태: string[] (접힌 그룹 라벨 목록).
// 스키마 변경 시 버전 번호를 올려 기존 값을 무효화.
const COLLAPSED_GROUPS_KEY = "orbit-sidebar-collapsed-groups-v1";

function loadCollapsedGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(set: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    /* localStorage 비허용/가득참 환경은 무시 */
  }
}

// 메뉴 키 → 아이콘 매핑 (표시 전용, 동작에는 영향 없음). 모두 lucide-react.
// 모든 아이콘은 h-4 w-4 (16px) — 사이드바 row 높이와 맞춤.
const ICON_CLS = "h-4 w-4";
const MENU_ICONS: Record<string, React.ReactNode> = {
  // 홈 / 개요
  dashboard: <LayoutDashboard className={ICON_CLS} />,
  notice: <Newspaper className={ICON_CLS} />,
  board: <MessageSquare className={ICON_CLS} />,
  meetings: <CalendarClock className={ICON_CLS} />,
  meeting_notes: <NotebookPen className={ICON_CLS} />,
  weekly_reports: <FileBarChart className={ICON_CLS} />,
  my_actions: <ListChecks className={ICON_CLS} />,
  emails: <Inbox className={ICON_CLS} />,
  goals: <TrendingUp className={ICON_CLS} />,
  calendar: <CalendarDays className={ICON_CLS} />,
  org_chart: <GitBranch className={ICON_CLS} />,
  books: <BookOpen className={ICON_CLS} />,
  trips: <Plane className={ICON_CLS} />,
  // 영업
  "tax_invoices.dashboard": <PieChart className={ICON_CLS} />,
  opportunities: <Target className={ICON_CLS} />,
  announcements: <Megaphone className={ICON_CLS} />,
  quotes: <FileText className={ICON_CLS} />,
  invoices: <Receipt className={ICON_CLS} />,
  vendor_bills: <ReceiptText className={ICON_CLS} />,
  projects: <FolderKanban className={ICON_CLS} />,
  assignments: <Link2 className={ICON_CLS} />,
  // 마케팅
  "marketing.dashboard": <LayoutDashboard className={ICON_CLS} />,
  "marketing.campaigns": <Send className={ICON_CLS} />,
  "marketing.emails": <Mail className={ICON_CLS} />,
  "marketing.segments": <Filter className={ICON_CLS} />,
  "marketing.google_ads": <BarChart3 className={ICON_CLS} />,
  // 기술지원
  support_cases: <LifeBuoy className={ICON_CLS} />,
  support_logs: <Activity className={ICON_CLS} />,
  "customer-status": <ClipboardList className={ICON_CLS} />,
  kb: <Lightbulb className={ICON_CLS} />,
  // 라이센스
  licenses: <Key className={ICON_CLS} />,
  "licenses.calendar": <Calendar className={ICON_CLS} />,
  // 자원
  developers: <Users className={ICON_CLS} />,
  tax_invoices: <Receipt className={ICON_CLS} />,
  cloud_costs: <Cloud className={ICON_CLS} />,
  domains: <Globe className={ICON_CLS} />,
  server_hostings: <Server className={ICON_CLS} />,
  assets: <Package className={ICON_CLS} />,
  cars: <Car className={ICON_CLS} />,
  insurances: <ShieldCheck className={ICON_CLS} />,
  customers: <Building2 className={ICON_CLS} />,
  contacts: <Contact className={ICON_CLS} />,
  bank_accounts: <Landmark className={ICON_CLS} />,
  loans: <HandCoins className={ICON_CLS} />,
  patents: <Award className={ICON_CLS} />,
  // 인사
  payroll: <Banknote className={ICON_CLS} />,
  utilization: <Activity className={ICON_CLS} />,
  leaves: <TreePalm className={ICON_CLS} />,
  approvals: <FileCheck className={ICON_CLS} />,
  evaluations: <ClipboardSignature className={ICON_CLS} />,
  events: <PartyPopper className={ICON_CLS} />,
  // 근태
  worksites: <MapPin className={ICON_CLS} />,
  leave_types: <Tag className={ICON_CLS} />,
  "attendance.me": <Clock className={ICON_CLS} />,
  "attendance.admin": <ClipboardCheck className={ICON_CLS} />,
  // 관리
  "catalog.products": <Boxes className={ICON_CLS} />,
  users: <UserCog className={ICON_CLS} />,
  alarms: <BellRing className={ICON_CLS} />,
  "settings.bookmarks": <BookmarkIcon className={ICON_CLS} />,
  "settings.accounts": <Calculator className={ICON_CLS} />,
  permissions: <KeyRound className={ICON_CLS} />,
  job_runs: <History className={ICON_CLS} />,
  settings: <Settings className={ICON_CLS} />,
  // 예산
  "budget.calc": <PiggyBank className={ICON_CLS} />,
  "budget.rnd": <FlaskConical className={ICON_CLS} />,
  // 도움말
  help: <HelpCircle className={ICON_CLS} />,
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const { isCollapsed, toggle } = useSidebar();

  // 그룹별 접힘 상태 — 초기엔 빈 Set (모두 펼침). useEffect 로 localStorage 로드.
  // SSR 에서는 항상 빈 Set 이라 hydration mismatch 없이 안전.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsedGroups(loadCollapsedGroups());
  }, []);

  // 메뉴 검색. query 가 비어있지 않으면 라벨 부분일치 항목만 보이고, 매칭이
  // 0건인 그룹은 통째로 숨겨진다. 사용자가 접어둔 그룹도 검색 중에는 강제 펼침
  // (검색 결과를 가리지 않도록).
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 전역 단축키: Ctrl/Cmd + / 로 검색 input 포커스. modifier 조합이라 일반
  // 입력 필드 안에서도 안전하게 가로챌 수 있음.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function toggleGroup(label: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      saveCollapsedGroups(next);
      return next;
    });
  }

  const { data: me } = useQuery<{
    email: string;
    name?: string;
    role: string;
    permissions?: string[];
    tenant_id?: string | null;
    mapped_developer_id?: string | null;
    // 사용자별 추가 메뉴 부여 — Sidebar 필터가 role 매트릭스와 OR.
    menu_grants?: string[];
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60 * 1000,
  });

  // 사이드바 영문 회사명은 현재 사용자 tenant 의 name_en. 비어 있으면 빈 문자열.
  const { data: tenantInfo } = useQuery<{ name_en: string | null }>({
    queryKey: ["my-tenant-brand"],
    queryFn: async () => (await api.get("/tenants/me")).data,
    staleTime: 5 * 60 * 1000,
    enabled: !!me?.tenant_id,
  });
  const tenantNameEn = tenantInfo?.name_en?.trim() || "";

  // 메뉴 권한 맵. 5분 캐시 — 저장 시 `settings > 메뉴 권한` 에서 invalidate.
  const { data: menuPerms } = useQuery<Record<string, string[]>>({
    queryKey: ["menu-permissions"],
    queryFn: async () => (await api.get("/menu-permissions")).data,
    staleTime: 5 * 60 * 1000,
    enabled: !!me,
  });

  const visibleGroups = useMemo(() => {
    if (!me) return [];
    const perms = menuPerms ?? {};
    const q = query.trim().toLowerCase();
    const byGroup = new Map<string, { href: string; label: string; icon: React.ReactNode }[]>();
    // MENU_REGISTRY 순서 유지를 위해 그룹별 버킷에 append. 결과 순서는 아래에서 MENU_GROUP_ORDER 기준.
    for (const entry of MENU_REGISTRY) {
      if (!isMenuVisible(perms, entry.key, me.role, me.menu_grants)) continue;
      // 검색어가 있으면 라벨 부분일치만 통과.
      if (q && !entry.label.toLowerCase().includes(q)) continue;
      const arr = byGroup.get(entry.group) ?? [];
      arr.push({
        href: entry.href,
        label: entry.label,
        icon: MENU_ICONS[entry.key] ?? <LayoutDashboard className={ICON_CLS} />,
      });
      byGroup.set(entry.group, arr);
    }
    return MENU_GROUP_ORDER
      .filter((g) => (byGroup.get(g)?.length ?? 0) > 0)
      .map((label) => ({ label, items: byGroup.get(label)! }));
  }, [me, menuPerms, query]);

  const isSearching = query.trim().length > 0;

  // 현재 경로가 속한 그룹은 접힘 상태여도 강제로 펼친다 — 현재 페이지의
  // 네비게이션 맥락을 잃지 않기 위해서. (dashboard 는 prefix 매칭 제외.)
  const activeGroupLabel = visibleGroups.find((g) =>
    g.items.some(
      (it) =>
        pathname === it.href ||
        (it.href !== "/dashboard" && pathname?.startsWith(it.href + "/")),
    ),
  )?.label;

  function logout() {
    // 1) 쿠키에서 JWT 제거 — 이후 API 호출에 구 토큰 실리지 않게.
    clearToken();
    // 2) React Query 전체 캐시 초기화 — ["me"], ["menu-permissions"], 각
    //    도메인 쿼리가 이전 사용자 데이터를 staleTime 내에 보여주지 않도록.
    qc.clear();
    router.replace("/login");
  }

  const initial = (me?.name || me?.email || "?").slice(0, 1).toUpperCase();

  return (
    <aside
      className={clsx(
        "relative shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border min-h-screen flex flex-col transition-[width] duration-200 ease-out",
        isCollapsed ? "w-14 overflow-visible" : "w-48",
      )}
    >
      <div className="flex items-center h-16 border-b border-sidebar-border">
        <Link
          href="/dashboard"
          className={clsx(
            "group/item relative flex flex-col justify-center flex-1 min-w-0 h-full",
            isCollapsed ? "items-center px-0" : "px-4",
          )}
        >
          {isCollapsed ? (
            // 접힌 상태에서는 텍스트 대신 앱 favicon 을 헤더 중앙에 표시.
            // 클릭 시 /dashboard, hover 시 tooltip 으로 'Orbit Works' 노출.
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icon.svg"
                alt="Orbit Works"
                className="h-7 w-7"
              />
              <TooltipBubble
                label={
                  tenantNameEn ? `Orbit Works · ${tenantNameEn}` : "Orbit Works"
                }
              />
            </>
          ) : (
            <>
              <div
                className={
                  brandFont.className +
                  " text-xl font-semibold text-sidebar-accent-foreground leading-none tracking-wide"
                }
              >
                Orbit Works
              </div>
              {tenantNameEn && (
                <div className="text-xs text-sidebar-muted mt-1">
                  {tenantNameEn}
                </div>
              )}
            </>
          )}
        </Link>
        {!isCollapsed && (
          <Tooltip label="사이드바 접기" side="bottom">
            <button
              type="button"
              onClick={toggle}
              className="h-8 w-8 mr-2 rounded-md inline-flex items-center justify-center text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              aria-label="사이드바 접기"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>

      {isCollapsed && (
        <button
          type="button"
          onClick={toggle}
          className="group/item relative mx-2 mt-2 h-8 rounded-md inline-flex items-center justify-center text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          aria-label="사이드바 펼치기"
        >
          <ChevronRight className="h-4 w-4" />
          <TooltipBubble label="사이드바 펼치기" />
        </button>
      )}

      {/* 메뉴 검색 — 헤더 바로 아래에 고정. nav 의 스크롤과 무관하게 항상 노출.
          접힌 상태(아이콘만)에서는 숨김. */}
      {!isCollapsed && (
        <div className="px-2 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-sidebar-muted" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  searchInputRef.current?.blur();
                }
              }}
              placeholder="메뉴 검색"
              aria-label="메뉴 검색"
              className="w-full h-8 rounded-md bg-sidebar-accent/40 border border-transparent focus:border-sidebar-border focus:bg-sidebar-accent/60 pl-7 pr-7 text-sm text-sidebar-accent-foreground placeholder:text-sidebar-muted outline-none transition-colors"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="검색 지우기"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded text-sidebar-muted hover:text-sidebar-accent-foreground hover:bg-sidebar-accent/60"
              >
                <span className="text-xs leading-none">×</span>
              </button>
            ) : (
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-sidebar-muted border border-sidebar-border rounded px-1 leading-none py-0.5">
                Ctrl /
              </span>
            )}
          </div>
        </div>
      )}

      <nav
        className={clsx(
          // 접힘 상태에서도 메뉴가 viewport 보다 길면 잘려서 안 보이므로
          // overflow-y-auto. tooltip 은 더 이상 nav 안의 absolute 가 아니라
          // body portal + fixed positioning 으로 띄우므로 nav 의 overflow 와
          // 무관하게 잘 보인다. 검색창은 nav 외부 (sticky 영역) 로 분리.
          "flex-1 pb-3 overflow-y-auto overflow-x-hidden sidebar-scroll",
          !isCollapsed ? "pt-1" : "pt-3",
        )}
      >
        {!isCollapsed && isSearching && visibleGroups.length === 0 && (
          <div className="px-4 text-xs text-sidebar-muted">
            "{query}" 와 일치하는 메뉴 없음
          </div>
        )}
        {visibleGroups.map((group, gi) => {
          // 아이콘 사이드바 모드에서는 그룹 접기 UI 를 쓰지 않는다 (그룹 라벨 자체가 숨겨져 있음).
          // 현재 경로가 속한 그룹은 사용자가 접은 상태여도 강제로 펼친다.
          // 검색 중에는 접힘 상태를 무시 — 매칭 결과를 가리지 않도록.
          const isGroupCollapsed =
            !isCollapsed &&
            !isSearching &&
            collapsedGroups.has(group.label) &&
            group.label !== activeGroupLabel;
          return (
            <div key={group.label} className="px-2 mb-3">
              {isCollapsed ? (
                gi > 0 && <div className="mx-1 mb-2 h-px bg-sidebar-border" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={!isGroupCollapsed}
                  className="w-full flex items-center justify-between px-2 pb-1 text-[11px] uppercase tracking-wide text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors"
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    className={clsx(
                      "h-3 w-3 transition-transform duration-150",
                      isGroupCollapsed && "-rotate-90",
                    )}
                  />
                </button>
              )}
              {!isGroupCollapsed && (
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      (item.href !== "/dashboard" && pathname?.startsWith(item.href + "/"));
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={clsx(
                          "group/item relative flex items-center rounded-md text-sm transition-colors",
                          isCollapsed
                            ? "justify-center h-9 w-9 mx-auto"
                            : "gap-2 px-2 py-1.5",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "hover:bg-sidebar-accent/60",
                        )}
                      >
                        <span className="text-sidebar-muted">{item.icon}</span>
                        {!isCollapsed && <span>{item.label}</span>}
                        {isCollapsed && <TooltipBubble label={item.label} />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-2">
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-2">
            <UserMenu
              collapsed
              initial={initial}
              name={me?.name || me?.email || "-"}
              role={me?.role || ""}
              developerId={me?.mapped_developer_id ?? null}
            />
            <button
              onClick={logout}
              aria-label="Logout"
              className="group/item relative h-8 w-8 rounded-md inline-flex items-center justify-center text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <LogOut className="h-4 w-4" />
              <TooltipBubble label="Logout" />
            </button>
          </div>
        ) : (
          <div className="p-1">
            <div className="mb-2">
              <UserMenu
                collapsed={false}
                initial={initial}
                name={me?.name || me?.email || "-"}
                role={me?.role || ""}
                developerId={me?.mapped_developer_id ?? null}
              />
            </div>
            <button
              onClick={logout}
              className="w-full rounded-md bg-sidebar-accent/60 hover:bg-sidebar-accent px-3 py-1.5 text-xs"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 접힌 사이드바용 커스텀 툴팁.
 *
 * 이전 버전은 `position: absolute` + group-hover CSS 로 nav 안에 mount 했는데,
 * nav 가 메뉴 길이 때문에 `overflow-y: auto` 가 되면서 가로 방향도 같이
 * clip 되어 tooltip 이 잘렸다. 그래서 React portal 로 `document.body` 에
 * 직접 mount 하고 `position: fixed` 좌표로 띄운다 — nav 의 overflow 와 무관.
 *
 * 부모 (anchor: Link / button) 가 마운트되면 placeholder span 의 parentElement
 * 를 통해 anchor 를 찾아 mouseenter/leave/focusin/focusout 리스너 등록.
 */
function TooltipBubble({ label }: { label: string }) {
  const anchorMarkerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const marker = anchorMarkerRef.current;
    const anchor = marker?.parentElement;
    if (!anchor) return;
    const compute = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ top: r.top + r.height / 2, left: r.right + 8 });
    };
    const onLeave = () => setPos(null);
    anchor.addEventListener("mouseenter", compute);
    anchor.addEventListener("mouseleave", onLeave);
    anchor.addEventListener("focusin", compute);
    anchor.addEventListener("focusout", onLeave);
    return () => {
      anchor.removeEventListener("mouseenter", compute);
      anchor.removeEventListener("mouseleave", onLeave);
      anchor.removeEventListener("focusin", compute);
      anchor.removeEventListener("focusout", onLeave);
    };
  }, []);

  // anchor 위치 추적용 0×0 placeholder (DOM tree 안에 있어야 parentElement 잡힘).
  const marker = (
    <span ref={anchorMarkerRef} aria-hidden="true" className="hidden" />
  );

  if (typeof document === "undefined" || !pos) return marker;
  return (
    <>
      {marker}
      {createPortal(
        <span
          role="tooltip"
          className={clsx(
            "pointer-events-none",
            "px-2.5 py-1 rounded-md whitespace-nowrap",
            "bg-popover text-popover-foreground",
            "text-sm font-medium",
            "border border-border shadow-md",
            "z-[60]",
          )}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            transform: "translateY(-50%)",
          }}
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}
