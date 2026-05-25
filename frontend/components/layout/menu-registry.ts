/**
 * 사이드바 메뉴 레지스트리 — 데스크톱 프런트 전용.
 *
 * Sidebar 컴포넌트와 `/settings > 메뉴 권한` 탭이 공통으로 이 목록을 참조한다.
 * 런타임에 불러오는 `GET /menu-permissions` 맵과 교차해 메뉴를 필터링.
 *
 * 필드:
 * - `key`   : `menu_permissions.menu_key` 와 1:1 매칭되는 식별자.
 *             **절대 변경 금지** — DB 에 저장된 권한 row 와 연결이 끊긴다.
 *             새 메뉴 추가는 백엔드 `DEFAULT_MENU_PERMISSIONS` 에도 동일 key 로 기본 역할을 넣어둘 것.
 * - `label` : Sidebar/Settings 공통 표시 (다국어 미지원 — 한국어/영어 혼용은 의도적).
 * - `href`  : Next.js 라우트 경로.
 * - `group` : 사이드바 섹션 그룹 헤더. `MENU_GROUP_ORDER` 에 정의된 순서로 렌더.
 *
 * 권한 판정:
 * - ADMIN 은 항상 모든 메뉴를 본다 (`isMenuVisible` 하드코딩).
 * - 그 외 역할은 `menu_permissions` 에 해당 `(menu_key, role)` row 가 있을 때만 표시.
 * - needs_mapping 상태(admin 부트스트랩 미완료) 에서는 Sidebar 가 전체를 숨긴다.
 */

export type SecurityRole =
  | "ADMIN"
  | "SALES"
  | "MARKETING"
  | "HR"
  | "SUPPORT"
  | "ETC";

export const SECURITY_ROLES: SecurityRole[] = [
  "ADMIN",
  "SALES",
  "MARKETING",
  "HR",
  "SUPPORT",
  "ETC",
];

export const SECURITY_ROLE_LABEL: Record<SecurityRole, string> = {
  ADMIN: "관리자 (ADMIN)",
  SALES: "영업 (SALES)",
  MARKETING: "마케팅 (MARKETING)",
  HR: "HR (관리)",
  SUPPORT: "지원 (SUPPORT)",
  ETC: "기타 (ETC)",
};

export type MenuEntry = {
  key: string;
  label: string;
  href: string;
  group: string;
};

export const MENU_REGISTRY: MenuEntry[] = [
  { key: "dashboard", label: "대시보드", href: "/dashboard", group: "홈" },
  { key: "notice", label: "공지사항", href: "/notice", group: "홈" },
  { key: "board", label: "게시판", href: "/board", group: "홈" },
  { key: "meetings", label: "회의실 예약", href: "/meetings", group: "홈" },
  { key: "meeting_notes", label: "회의록", href: "/meeting-notes", group: "홈" },
  { key: "weekly_reports", label: "주간보고", href: "/weekly-reports", group: "홈" },
  { key: "my_actions", label: "내 액션", href: "/my-actions", group: "홈" },
  { key: "goals", label: "목표", href: "/goals", group: "홈" },
  { key: "org_chart", label: "결재선", href: "/org-chart", group: "홈" },
  { key: "tax_invoices.dashboard", label: "매입/매출 현황", href: "/tax-invoices/dashboard", group: "영업" },
  { key: "opportunities", label: "영업기회", href: "/opportunities", group: "영업" },
  { key: "announcements", label: "사업공고", href: "/announcements", group: "영업" },
  // 마케팅 — 기존 고객 대상 캠페인. 영업 직후, 기술지원 앞에 그룹.
  { key: "marketing.dashboard", label: "마케팅 대시보드", href: "/marketing/dashboard", group: "마케팅" },
  { key: "marketing.campaigns", label: "캠페인", href: "/marketing/campaigns", group: "마케팅" },
  { key: "marketing.emails", label: "이메일 발송", href: "/marketing/emails", group: "마케팅" },
  { key: "marketing.segments", label: "고객 세그먼트", href: "/marketing/segments", group: "마케팅" },
  { key: "marketing.google_ads", label: "Google Ads", href: "/marketing/google-ads", group: "마케팅" },
  { key: "support_cases", label: "케이스", href: "/support-cases", group: "기술지원" },
  { key: "support_logs", label: "기술지원", href: "/support-logs", group: "기술지원" },
  { key: "customer-status", label: "라이센스 현황", href: "/customer-status", group: "기술지원" },
  { key: "kb", label: "지식 베이스", href: "/kb", group: "기술지원" },
  { key: "licenses", label: "SW 라이센스", href: "/licenses", group: "라이센스" },
  { key: "licenses.calendar", label: "연간 캘린더", href: "/licenses/calendar", group: "라이센스" },
  { key: "quotes", label: "견적서", href: "/quotes", group: "영업" },
  { key: "invoices", label: "매출 인보이스", href: "/invoices", group: "영업" },
  { key: "vendor_bills", label: "매입 인보이스", href: "/vendor-bills", group: "영업" },
  { key: "projects", label: "프로젝트", href: "/projects", group: "영업" },
  { key: "assignments", label: "인력 투입", href: "/assignments", group: "영업" },
  { key: "developers", label: "임직원", href: "/employees", group: "자원" },
  { key: "tax_invoices", label: "세금계산서", href: "/tax-invoices", group: "자원" },
  { key: "cloud_costs", label: "클라우드 비용", href: "/cloud-costs", group: "자원" },
  { key: "assets", label: "자산", href: "/assets", group: "자원" },
  { key: "cars", label: "차량", href: "/cars", group: "자원" },
  { key: "insurances", label: "보험", href: "/insurances", group: "자원" },
  { key: "customers", label: "고객사", href: "/customers", group: "자원" },
  { key: "contacts", label: "주소록", href: "/contacts", group: "자원" },
  { key: "bank_accounts", label: "은행계좌", href: "/bank-accounts", group: "자원" },
  { key: "loans", label: "대출", href: "/loans", group: "자원" },
  { key: "patents", label: "특허", href: "/patents", group: "자원" },
  { key: "payroll", label: "급여", href: "/payroll", group: "인사" },
  { key: "leaves", label: "연차", href: "/leaves", group: "인사" },
  { key: "approvals", label: "결재", href: "/approvals", group: "인사" },
  { key: "evaluations", label: "평가", href: "/evaluations", group: "인사" },
  { key: "events", label: "이벤트", href: "/events", group: "인사" },
  { key: "worksites", label: "근무지", href: "/worksites", group: "근태" },
  { key: "leave_types", label: "휴가 유형", href: "/leave-types", group: "근태" },
  { key: "attendance.admin", label: "출퇴근 기록", href: "/attendance", group: "근태" },
  { key: "calendar", label: "일정", href: "/calendar", group: "홈" },
  { key: "books", label: "도서", href: "/books", group: "홈" },
  { key: "trips", label: "해외출장 일정표", href: "/trips", group: "홈" },
  { key: "catalog.products", label: "제품 카탈로그", href: "/catalog", group: "관리" },
  { key: "alarms", label: "알람", href: "/alarms", group: "관리" },
  { key: "settings.bookmarks", label: "북마크", href: "/settings/bookmarks", group: "관리" },
  { key: "settings.accounts", label: "계정과목", href: "/settings/account-codes", group: "관리" },
  { key: "settings", label: "설정", href: "/settings", group: "관리" },
  // 권한 관리 — 역할 매트릭스(메뉴/기능) + 사용자별 grant 4 탭 통합.
  // 기존 Settings > 메뉴 권한 탭 + 임직원 상세 > 추가 메뉴/추가 권한 섹션을 한 곳으로.
  { key: "permissions", label: "권한 관리", href: "/permissions", group: "관리" },
  { key: "budget.calc", label: "예산", href: "/budget-calc", group: "예산" },
  { key: "budget.rnd", label: "정부 R&D", href: "/rnd-budget", group: "예산" },
  // 도움말 — 모든 사용자에게 노출 (권한 게이트 없음).
  { key: "help", label: "도움말", href: "/help", group: "도움말" },
];

export const MENU_GROUP_ORDER = [
  "홈",
  "영업",
  "마케팅",
  "기술지원",
  "라이센스",
  "자원",
  "인사",
  "근태",
  "예산",
  "관리",
  "도움말",
];

/**
 * 메뉴 노출 판정.
 *
 * - `role` 미정(미로그인/로딩 중) → 항상 false.
 * - ADMIN → 맵과 무관하게 true. 백엔드도 ADMIN 을 저장하지 않으므로 이 가드가 유일한 근거.
 * - 그 외 → `permissions[menuKey]` 가 존재하고 `role` 을 포함하면 true.
 *
 * 맵에 키가 아예 없는 메뉴는 '허용되지 않음' 으로 간주 (알 수 없는 새 메뉴에 대한 안전 기본값).
 */
export function isMenuVisible(
  permissions: Record<string, string[]>,
  menuKey: string,
  role: string | undefined,
  /**
   * 사용자별 추가 메뉴 부여. role 매트릭스가 부족할 때 `OR` 조건으로 통과.
   * `/auth/me` 응답의 `menu_grants` 가 들어온다. 부정(빼앗기) 은 미지원.
   */
  userMenuGrants?: readonly string[],
): boolean {
  if (!role) return false;
  if (role === "ADMIN") return true;
  if (ALWAYS_ALLOWED_KEYS.has(menuKey)) return true;
  if (userMenuGrants?.includes(menuKey)) return true;
  const allowed = permissions[menuKey];
  if (!allowed) return false;
  return allowed.includes(role);
}

/**
 * 권한 검사를 건너뛰는 메뉴 키 집합.
 * 도움말 등 모든 임직원에게 항상 노출되어야 하는 메뉴는 여기 등록.
 */
export const ALWAYS_ALLOWED_KEYS: Set<string> = new Set(["help"]);

/**
 * 가드를 적용하지 않는 dashboard 하위 경로 prefix.
 * 로그인 직후 fallback 인 "/" 와 비번 변경, 회사 공통 페이지 등.
 */
const GUARD_BYPASS_PREFIXES: readonly string[] = [
  "/password-change",
  "/admin",
  "/help",
];

/**
 * URL pathname → `MENU_REGISTRY` 의 menu_key 로 역매핑.
 *
 * - `MENU_REGISTRY` 의 `href` 중 pathname 에 매칭되는 가장 긴 prefix 를 선택.
 *   예: `/opportunities/abc/edit` → `opportunities`
 *       `/licenses/calendar` → `licenses.calendar` (`licenses` 보다 더 긴 매칭)
 * - 매칭이 없거나 guard 우회 경로면 `null` (호출자는 가드 통과로 처리).
 * - 루트 `/` 는 메뉴 키가 없으므로 `null`. layout 이 별도로 dashboard 로 보낸다.
 */
export function resolveMenuKeyFromPath(pathname: string): string | null {
  if (!pathname || pathname === "/") return null;
  for (const prefix of GUARD_BYPASS_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return null;
  }
  let best: MenuEntry | null = null;
  for (const m of MENU_REGISTRY) {
    if (pathname === m.href || pathname.startsWith(m.href + "/")) {
      if (!best || m.href.length > best.href.length) best = m;
    }
  }
  return best?.key ?? null;
}
