/**
 * 기능 권한 레지스트리 — 페이지 내부 버튼·필드·탭 통제.
 *
 * `menu-registry` 가 사이드바 노출(페이지 단위) 을 정의한다면, 이 레지스트리는
 * 그 페이지 안에서 사용자가 무엇을 할 수 있는지 더 잘게 통제한다.
 *
 * - `key`     : `feature_permissions.feature_key` 와 1:1. **절대 변경 금지** —
 *               DB 의 권한 row 가 끊긴다. 키 추가는 백엔드
 *               `DEFAULT_FEATURE_PERMISSIONS` 에도 동기화.
 * - `label`   : Settings UI 표시.
 * - `menuKey` : 어느 메뉴 페이지에 속한 기능인지. Settings UI 의 그룹핑.
 * - `description` : Settings UI 의 보조 설명 (옵션).
 *
 * 권한 판정:
 * - ADMIN 은 항상 모든 기능 허용 (`hasFeature` 하드코딩).
 * - 그 외 역할은 `permissions[featureKey]` 에 role 이 포함될 때만 허용.
 * - 본인 예외(자기 자신 데이터) 는 페이지 코드에서 별도 처리 — 설정으로 못 풀게.
 */

export type FeatureEntry = {
  key: string;
  label: string;
  menuKey: string;
  description?: string;
};

export const FEATURE_REGISTRY: FeatureEntry[] = [
  {
    key: "employees.create",
    label: "신규 임직원 등록",
    menuKey: "developers",
    description: "임직원 페이지의 '신규 등록' 버튼 노출 및 POST 허용.",
  },
  {
    key: "employees.salary.view",
    label: "급여 정보 조회",
    menuKey: "developers",
    description: "임직원 목록의 연봉 컬럼·분포 차트 표시.",
  },
  {
    key: "employees.salary.edit",
    label: "급여 입력·수정",
    menuKey: "developers",
    description: "연봉 이력 등록·수정·삭제.",
  },
  {
    key: "employees.role.edit",
    label: "보안 역할 변경",
    menuKey: "developers",
    description: "security_role 변경. HR→ADMIN 부여는 코드 invariant 로 별도 차단.",
  },
  {
    key: "employees.password.reset",
    label: "비밀번호 재설정",
    menuKey: "developers",
    description: "임직원 비밀번호를 생년월일/랜덤으로 강제 초기화.",
  },
  {
    key: "employees.tab.passport",
    label: "여권 정보 탭",
    menuKey: "developers",
    description: "여권번호 등 PII. 본인은 항상 자기 여권 열람 가능.",
  },
  {
    key: "employees.tab.emergency",
    label: "비상연락처 탭",
    menuKey: "developers",
    description: "비상연락처. 본인은 항상 자기 연락처 열람 가능.",
  },
  {
    key: "employees.tab.interview",
    label: "면담 탭 (HR 평가)",
    menuKey: "developers",
    description: "HR 면담 기록. 본인 예외 없음 (평가 비공개 의도).",
  },
  {
    key: "employees.approvers.edit",
    label: "결재선 변경",
    menuKey: "developers",
    description: "임직원의 승인자 목록 편집. 기본 ADMIN 만.",
  },
  {
    key: "kb.write",
    label: "지식 베이스 작성·편집",
    menuKey: "kb",
    description: "KB 항목 등록·수정 및 첨부 관리. 조회는 메뉴 권한으로 별도 제어. 삭제는 kb.delete.",
  },
  {
    key: "kb.delete",
    label: "지식 베이스 삭제",
    menuKey: "kb",
    description: "KB 항목 삭제. write 와 분리해 오삭제 방지. 작성자 본인은 항상 가능.",
  },
  {
    key: "kb.publish_admin",
    label: "지식 베이스 가시성 승격",
    menuKey: "kb",
    description: "visibility = 매니저/관리자 글 작성·승격. 전사 공개 차단용.",
  },
  {
    key: "customer-status.write",
    label: "라이센스 현황 카드 작성·편집",
    menuKey: "customer-status",
    description: "라이센스 현황 카드 등록·수정 및 첨부 관리. 삭제는 customer-status.delete.",
  },
  {
    key: "customer-status.delete",
    label: "라이센스 현황 카드 삭제",
    menuKey: "customer-status",
    description: "라이센스 현황 카드 삭제. write 와 분리. 작성자 본인은 항상 가능.",
  },
  {
    key: "support_cases.write",
    label: "기술지원 케이스 작성·편집",
    menuKey: "support_cases",
    description: "케이스 등록·수정·첨부·코멘트. 삭제·종료는 별도 권한.",
  },
  {
    key: "support_cases.delete",
    label: "기술지원 케이스 삭제",
    menuKey: "support_cases",
    description: "케이스 삭제. 첨부·코멘트까지 CASCADE 로 사라지므로 매우 신중.",
  },
  {
    key: "support_cases.close",
    label: "기술지원 케이스 종료",
    menuKey: "support_cases",
    description: "케이스 상태를 CLOSED 로 전환. 1차 처리는 누구나, 종료만 분리.",
  },
  {
    key: "support_logs.write",
    label: "기술지원 활동 로그 작성·편집",
    menuKey: "support_logs",
    description: "활동 로그 등록·수정·첨부·코멘트. 삭제는 별도 권한.",
  },
  {
    key: "support_logs.delete",
    label: "기술지원 활동 로그 삭제",
    menuKey: "support_logs",
    description: "활동 로그 삭제. 코멘트·첨부까지 CASCADE.",
  },
];

/**
 * 기능 허용 여부 판정.
 * - role 미정 → false.
 * - ADMIN/SUPER_ADMIN → 항상 true.
 * - 그 외 → permissions[featureKey] 에 role 이 포함되면 true.
 *
 * 키가 맵에 없으면 false (안전 기본값).
 */
export function hasFeature(
  permissions: Record<string, string[]>,
  featureKey: string,
  role: string | undefined,
): boolean {
  if (!role) return false;
  if (role === "ADMIN" || role === "SUPER_ADMIN") return true;
  const allowed = permissions[featureKey];
  if (!allowed) return false;
  return allowed.includes(role);
}
