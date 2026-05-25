/**
 * 어시스턴트 도구 카드용 포매터.
 *
 * 백엔드는 항상 raw 정수(KRW)·ISO 날짜로 반환하고, UI 렌더링 시점에만
 * 한국 사용자 가독 형식으로 변환. 모델 prompt 토큰을 아끼는 동시에
 * locale 변경에도 한 곳만 손대면 됨.
 */

export function fmtKRW(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return "₩" + Math.round(n).toLocaleString("ko-KR");
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR");
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/** "방금 전", "5분 전", "3시간 전", "2일 전" 형태 (대략적). */
export function relativeTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const diffSec = (Date.now() - d.getTime()) / 1000;
  if (diffSec < 0) return fmtDate(s);
  if (diffSec < 60) return "방금 전";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}일 전`;
  return fmtDate(s);
}
