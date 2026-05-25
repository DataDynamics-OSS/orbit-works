/**
 * 기술지원 케이스 심각도 — AWS-style 5단계 (S1~S5).
 *
 * 정렬 친화적인 코드 저장 + UI 에서 라벨/색 매핑.
 */

export type SupportSeverity = "S1" | "S2" | "S3" | "S4" | "S5";

export const SUPPORT_SEVERITY_OPTIONS: SupportSeverity[] = [
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
];

export const SUPPORT_SEVERITY_LABEL: Record<SupportSeverity, string> = {
  S1: "긴급",
  S2: "높음",
  S3: "보통",
  S4: "낮음",
  S5: "정보",
};

export const SUPPORT_SEVERITY_DESCRIPTION: Record<SupportSeverity, string> = {
  S1: "운영 전면 중단, 데이터 손실 위험, 우회 불가",
  S2: "핵심 기능 장애, 비즈니스 영향 큼, 우회 어려움",
  S3: "부분 기능 장애, 우회 존재",
  S4: "일반 질문, 비-운영 환경, How-to",
  S5: "개선 요청, 문서·기능 요청, FAQ",
};

/** chip 또는 dot 표시용 Tailwind 클래스. */
export const SUPPORT_SEVERITY_CHIP_CLASS: Record<SupportSeverity, string> = {
  S1: "bg-red-100 text-red-800 border-red-200",
  S2: "bg-orange-100 text-orange-800 border-orange-200",
  S3: "bg-amber-100 text-amber-800 border-amber-200",
  S4: "bg-sky-100 text-sky-800 border-sky-200",
  S5: "bg-slate-100 text-slate-700 border-slate-200",
};

/** dot 색만 (옅은 chip 없이 코드만 표시할 때). */
export const SUPPORT_SEVERITY_DOT_CLASS: Record<SupportSeverity, string> = {
  S1: "bg-red-500",
  S2: "bg-orange-500",
  S3: "bg-amber-500",
  S4: "bg-sky-500",
  S5: "bg-slate-400",
};
