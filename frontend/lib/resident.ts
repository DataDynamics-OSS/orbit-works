/**
 * 주민등록번호 (KR resident registration number) 파생 유틸.
 *
 * 7번째 자리(하이픈 다음 첫 자리) 코드:
 *   1·2 → 19xx (한국),  3·4 → 20xx
 *   5·6 → 19xx (외국인), 7·8 → 20xx (외국인)
 *   9·0 → 18xx (드묾)
 *   홀수 = 남자(M), 짝수·0 = 여자(F)
 */

/** "YYYY-MM-DD" 또는 null. */
export function birthDateFromRRN(rrn: string | null | undefined): string | null {
  if (!rrn) return null;
  const s = rrn.replace("-", "");
  if (s.length < 7 || !/^\d{7}/.test(s)) return null;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  const code = s[6];
  let year: number;
  if ("12".includes(code)) year = 1900 + yy;
  else if ("34".includes(code)) year = 2000 + yy;
  else if ("56".includes(code)) year = 1900 + yy;
  else if ("78".includes(code)) year = 2000 + yy;
  else if ("90".includes(code)) year = 1800 + yy;
  else return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

export function genderFromRRN(rrn: string | null | undefined): "M" | "F" | null {
  if (!rrn) return null;
  const s = rrn.replace("-", "");
  if (s.length < 7) return null;
  const code = s[6];
  if ("13579".includes(code)) return "M";
  if ("24680".includes(code)) return "F";
  return null;
}

export const GENDER_LABEL: Record<"M" | "F", string> = { M: "남자", F: "여자" };

/** 생년월일(YYYY-MM-DD) → 만 나이. RRN 파생값 그대로 받아서 처리.
 * 생일 도래 여부를 반영해 만 나이로 계산. 잘못된 입력은 null. */
export function ageFromBirthDate(
  birthDateIso: string | null | undefined,
  asOf: Date = new Date(),
): number | null {
  if (!birthDateIso) return null;
  const m = birthDateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const bd = Number(m[3]);
  let age = asOf.getFullYear() - by;
  const month = asOf.getMonth() + 1;
  const day = asOf.getDate();
  if (month < bm || (month === bm && day < bd)) age -= 1;
  return age >= 0 && age < 200 ? age : null;
}

export function ageFromRRN(rrn: string | null | undefined): number | null {
  return ageFromBirthDate(birthDateFromRRN(rrn));
}

/** 생년월일이 현재 달과 일치하는지 (이번 달 생일자). */
export function isBirthdayThisMonth(birthDateIso: string | null | undefined): boolean {
  if (!birthDateIso) return false;
  const m = birthDateIso.match(/^\d{4}-(\d{2})-\d{2}$/);
  if (!m) return false;
  const month = Number(m[1]);
  return month === new Date().getMonth() + 1;
}
