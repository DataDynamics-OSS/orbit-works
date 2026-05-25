/**
 * UTC ISO 문자열 → 사용자 로컬 TZ 의 'YYYY-MM-DD HH:mm' 으로 포맷.
 *
 * 흔한 안티패턴 (`iso.slice(0, 16).replace("T", " ")`) 은 UTC 값을 그대로
 * 잘라 표시하므로 KST 사용자에게 9시간 이전으로 보인다. 본 헬퍼는
 * `new Date(iso)` 로 파싱한 뒤 getFullYear/getHours 등으로 로컬 TZ 기준
 * 컴포넌트를 가져와 안전하게 포맷한다. 빈 값이나 파싱 실패 시 '-' 반환.
 */
export function fmtLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** 입사일(ISO) → "Y년 M개월". 미래 입사 / 빈 값은 null.
 * 일자 차이가 음수면 month 에서 1 빌려옴. 0년 0개월도 표기 유지. */
export function tenureFromHireDate(
  hireDate: string | null | undefined,
  asOf: Date = new Date(),
): string | null {
  if (!hireDate) return null;
  const hire = new Date(hireDate);
  if (isNaN(hire.getTime())) return null;
  let years = asOf.getFullYear() - hire.getFullYear();
  let months = asOf.getMonth() - hire.getMonth();
  if (asOf.getDate() < hire.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return null;
  return `${years}년 ${months}개월`;
}

export function formatKRW(value: number | string | null | undefined): string {
  if (value == null || value === "") return "-";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "-";
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW" }).format(n);
}

export function formatMoney(value: number | string | null | undefined, currency = "KRW"): string {
  if (value == null || value === "") return "-";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "-";
  // ko-KR 로케일의 기본 통화 포맷은 USD 를 "US$" 로, KRW 를 "₩" 로 NBSP 를 섞어
  // 표기한다. 표현을 `$` 와 `₩` 로 간결화하고 기호 뒤에 일반 공백 1개만 붙인다.
  const symbol = currency === "USD" ? "$" : currency === "KRW" ? "₩" : currency;
  const digits = currency === "USD" ? 2 : 0;
  const formatted = n.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${symbol} ${formatted}`;
}

const DEV_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#059669",
  "#9333ea",
  "#ea580c",
];

export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return DEV_COLORS[Math.abs(hash) % DEV_COLORS.length];
}
