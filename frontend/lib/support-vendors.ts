/**
 * 기술지원 — 벤더 / 제품 매핑 + duration 파서.
 *
 * 백엔드 vendor 컬럼은 단순 enum (CLOUDERA / DATABRICKS / INTERNAL).
 * product 는 varchar(60) — 벤더가 Cloudera 면 dropdown, 그 외는 자유 입력.
 * 향후 옵션 추가는 여기 객체에만 반영하면 끝 (백엔드는 unaffected).
 */

export type SupportVendor = "CLOUDERA" | "DATABRICKS" | "INTERNAL";

export const SUPPORT_VENDOR_LABEL: Record<SupportVendor, string> = {
  CLOUDERA: "Cloudera",
  DATABRICKS: "Databricks",
  INTERNAL: "자체",
};

export const SUPPORT_VENDOR_OPTIONS: SupportVendor[] = [
  "CLOUDERA",
  "DATABRICKS",
  "INTERNAL",
];

/**
 * 벤더별 제품 옵션. 빈 배열이면 "자유 입력" 모드 (UI 가 dropdown 대신 text input).
 */
export const SUPPORT_PRODUCT_OPTIONS: Record<SupportVendor, string[]> = {
  CLOUDERA: ["CDP", "CFM", "PVC-DS", "AI", "CDE", "OTHER"],
  DATABRICKS: [],
  INTERNAL: [],
};

export type SupportCaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED";

export const SUPPORT_CASE_STATUS_LABEL: Record<SupportCaseStatus, string> = {
  OPEN: "등록",
  IN_PROGRESS: "처리중",
  CLOSED: "종료",
};

/**
 * "2시간 30분" / "2시간" / "30분" / "150" 등을 분 단위 정수로 파싱.
 * 빈 입력은 0. 부호·소수점은 무시.
 */
export function parseDurationMinutes(raw: string): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (!s) return 0;
  // 한국어 표기 우선 매칭.
  const h = s.match(/(\d+)\s*시간/);
  const m = s.match(/(\d+)\s*분/);
  if (h || m) {
    return (h ? parseInt(h[1], 10) : 0) * 60 + (m ? parseInt(m[1], 10) : 0);
  }
  // 숫자만 입력했으면 분으로 간주.
  const n = parseInt(s.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 분 → "2시간 30분" / "2시간" / "30분". 0 이면 빈 문자열.
 */
export function formatDurationMinutes(min: number | null | undefined): string {
  const n = Number(min) || 0;
  if (n <= 0) return "";
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h && m) return `${h}시간 ${m}분`;
  if (h) return `${h}시간`;
  return `${m}분`;
}
