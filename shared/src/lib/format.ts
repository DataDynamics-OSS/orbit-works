export function formatKRW(v: string | number | null | undefined): string {
  if (v == null || v === "") return "-";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "-";
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

export function formatYearMonth(year: number, month: number): string {
  return `${year}년 ${String(month).padStart(2, "0")}월`;
}
