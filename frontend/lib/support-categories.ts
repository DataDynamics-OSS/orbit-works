/**
 * 기술지원 케이스 유형 (`support_cases.category`) 라벨·옵션 매핑.
 *
 * 영문 key 는 백엔드 enum (`SupportCaseCategory` Literal) 과 1:1 동기화.
 * 한글 라벨은 UI 표시·드롭다운·차트 범례 전용.
 */

export type SupportCaseCategory =
  | "PERFORMANCE"
  | "MALFUNCTION"
  | "SECURITY"
  | "DATA_LOSS"
  | "TUNING"
  | "JOB_FAILURE"
  | "SERVICE_DOWN"
  | "OTHER";

export const SUPPORT_CASE_CATEGORY_LABEL: Record<SupportCaseCategory, string> = {
  PERFORMANCE: "성능",
  MALFUNCTION: "기능 오동작",
  SECURITY: "보안",
  DATA_LOSS: "데이터 손실",
  TUNING: "튜닝/최적화",
  JOB_FAILURE: "작업 실패",
  SERVICE_DOWN: "서비스 다운",
  OTHER: "기타",
};

// select 옵션 등에서 순서 유지가 필요한 곳에 사용.
export const SUPPORT_CASE_CATEGORY_OPTIONS: SupportCaseCategory[] = [
  "PERFORMANCE",
  "MALFUNCTION",
  "SECURITY",
  "DATA_LOSS",
  "TUNING",
  "JOB_FAILURE",
  "SERVICE_DOWN",
  "OTHER",
];

// 파이 차트 색 — 케이스 통계 5번째 차트(유형별) 에서 사용. 유의미한 색 매핑
// (보안=빨강, 서비스다운=짙은 빨강, 성능=주황, 데이터손실=보라 등) 으로
// 시각적 priority 강조.
export const SUPPORT_CASE_CATEGORY_COLORS: Record<SupportCaseCategory, string> = {
  PERFORMANCE: "#f97316",   // orange-500
  MALFUNCTION: "#f59e0b",   // amber-500
  SECURITY: "#dc2626",      // red-600
  DATA_LOSS: "#9333ea",     // purple-600
  TUNING: "#0ea5e9",        // sky-500
  JOB_FAILURE: "#f59e0b",   // amber-500 (MALFUNCTION 과 유사하지만 운영 컨텍스트)
  SERVICE_DOWN: "#7f1d1d",  // red-900
  OTHER: "#6b7280",         // gray-500
};
