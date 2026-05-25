/**
 * 임직원 페이지 — 정규직 지표 패널의 집계 유틸.
 *
 * 백엔드 호출 없이 페이지가 이미 받아 둔 Developer 배열에서 직접 가공한다.
 * 모든 입력 배열은 호출자가 미리 "정규직 + 재직중" 으로 필터링했다고 가정.
 *
 * 단위:
 *  - 연봉: 입력은 KRW 정수/문자열, bin 은 만원 단위.
 *  - 경력 / 근무기간: 내부 계산은 개월 (months), bin label 은 사람 친화적.
 */

import { ageFromRRN, genderFromRRN } from "./resident";

// --------------------------------------------------------------------------
// 공통 타입
// --------------------------------------------------------------------------

/** 차트 한 카테고리 = (라벨, 값). 차트 렌더에 그대로 전달. */
export type Bucket = { name: string; value: number };

/** 바 차트는 '정의된 bin 순서' 를 그대로 사용 (사용자 인지 순서 = 작은→큰). */
export type Bin = { name: string; test: (n: number) => boolean };

// --------------------------------------------------------------------------
// 입력에서 다루는 최소 Developer 형태 (페이지 type 의 부분집합).
// --------------------------------------------------------------------------

export type StatsDeveloper = {
  resident_number?: string | null;
  rank_id?: string | null;
  latest_salary?: string | number | null;
  salary?: string | number | null;
  hire_date?: string | null;
  career_months_at_hire?: number | null;
};

// --------------------------------------------------------------------------
// Bin 정의 — 운영팀 요청 시 여기만 조정.
// --------------------------------------------------------------------------

/** 연봉 bin (만원). */
export const SALARY_BINS_MAN: Bin[] = [
  { name: "< 3,000", test: (v) => v < 3000 },
  { name: "3,000–4,000", test: (v) => v >= 3000 && v < 4000 },
  { name: "4,000–5,000", test: (v) => v >= 4000 && v < 5000 },
  { name: "5,000–6,000", test: (v) => v >= 5000 && v < 6000 },
  { name: "6,000–7,000", test: (v) => v >= 6000 && v < 7000 },
  { name: "7,000–8,000", test: (v) => v >= 7000 && v < 8000 },
  { name: "8,000+", test: (v) => v >= 8000 },
];

/** 만 나이 bin. */
export const AGE_BINS: Bin[] = [
  { name: "20대", test: (v) => v >= 20 && v < 30 },
  { name: "30대", test: (v) => v >= 30 && v < 40 },
  { name: "40대", test: (v) => v >= 40 && v < 50 },
  { name: "50대", test: (v) => v >= 50 && v < 60 },
  { name: "60+",  test: (v) => v >= 60 },
];

/** 경력 bin (개월). */
export const CAREER_BINS_MONTHS: Bin[] = [
  { name: "< 1년",   test: (m) => m < 12 },
  { name: "1–3년",   test: (m) => m >= 12 && m < 36 },
  { name: "3–5년",   test: (m) => m >= 36 && m < 60 },
  { name: "5–10년",  test: (m) => m >= 60 && m < 120 },
  { name: "10–15년", test: (m) => m >= 120 && m < 180 },
  { name: "15년+",   test: (m) => m >= 180 },
];

/** 근무 기간 bin (개월). */
export const TENURE_BINS_MONTHS: Bin[] = [
  { name: "< 1년",   test: (m) => m < 12 },
  { name: "1–3년",   test: (m) => m >= 12 && m < 36 },
  { name: "3–5년",   test: (m) => m >= 36 && m < 60 },
  { name: "5–10년",  test: (m) => m >= 60 && m < 120 },
  { name: "10년+",   test: (m) => m >= 120 },
];

// --------------------------------------------------------------------------
// 보조 — 입력값 정규화
// --------------------------------------------------------------------------

/** "12345.67" / 12345 / null 등을 number 로. NaN 또는 ≤0 은 null. */
function toFiniteNumber(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ISO date → 오늘까지 경과 개월. 미래/빈값은 null. */
function monthsBetween(fromIso: string | null | undefined, asOf: Date = new Date()): number | null {
  if (!fromIso) return null;
  const d = new Date(fromIso);
  if (Number.isNaN(d.getTime())) return null;
  let months = (asOf.getFullYear() - d.getFullYear()) * 12 + (asOf.getMonth() - d.getMonth());
  if (asOf.getDate() < d.getDate()) months -= 1;
  return months >= 0 ? months : null;
}

/** bin 배열을 입력값으로 한번 훑어서 (라벨 순서대로) 카운트. */
function bucketize(values: number[], bins: Bin[]): Bucket[] {
  const counts = new Array<number>(bins.length).fill(0);
  for (const v of values) {
    const idx = bins.findIndex((b) => b.test(v));
    if (idx >= 0) counts[idx] += 1;
  }
  return bins.map((b, i) => ({ name: b.name, value: counts[i] }));
}

// --------------------------------------------------------------------------
// 지표별 집계 함수
// --------------------------------------------------------------------------

/** 성별 분포. RRN 미입력자는 "미상" 카테고리로 별도 집계. */
export function genderBuckets(devs: StatsDeveloper[]): Bucket[] {
  let male = 0, female = 0, unknown = 0;
  for (const d of devs) {
    const g = genderFromRRN(d.resident_number ?? null);
    if (g === "M") male += 1;
    else if (g === "F") female += 1;
    else unknown += 1;
  }
  const out: Bucket[] = [
    { name: "남자", value: male },
    { name: "여자", value: female },
  ];
  if (unknown > 0) out.push({ name: "미상", value: unknown });
  return out;
}

/**
 * 직급(직위 = job_rank) 별 인원수.
 *
 * @param rankMap   id → name 매핑 (페이지의 rankMap 그대로 주입).
 * @param rankOrder 직급 표시 순서 (id 배열). undefined 이면 인원수 내림차순으로 자동.
 */
export function rankBuckets(
  devs: StatsDeveloper[],
  rankMap: Map<string, string>,
  rankOrder?: string[],
): Bucket[] {
  const counts = new Map<string, number>();  // key = rank_id ("" = 미지정)
  for (const d of devs) {
    const key = d.rank_id ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries: Bucket[] = [];
  // 표시 순서 — rankOrder 가 있으면 그것을 사용, 없으면 인원 내림차순.
  if (rankOrder?.length) {
    for (const id of rankOrder) {
      const v = counts.get(id) ?? 0;
      if (v > 0) entries.push({ name: rankMap.get(id) ?? "(이름 없음)", value: v });
    }
  } else {
    for (const [id, v] of counts) {
      if (id === "") continue;
      entries.push({ name: rankMap.get(id) ?? "(이름 없음)", value: v });
    }
    entries.sort((a, b) => b.value - a.value);
  }
  // 미지정은 항상 마지막.
  const unset = counts.get("") ?? 0;
  if (unset > 0) entries.push({ name: "미지정", value: unset });
  return entries;
}

/** 연봉 분포 (만원). HR/ADMIN 만 호출 — 그 외에는 latest_salary 가 null 이라 빈 배열. */
export function salaryBuckets(devs: StatsDeveloper[]): Bucket[] {
  const valuesMan: number[] = [];
  for (const d of devs) {
    const krw = toFiniteNumber(d.latest_salary ?? d.salary ?? null);
    if (krw == null) continue;
    valuesMan.push(Math.floor(krw / 10000));
  }
  return bucketize(valuesMan, SALARY_BINS_MAN);
}

/** 만 나이 분포. RRN 미입력자는 집계 제외. */
export function ageBuckets(devs: StatsDeveloper[]): Bucket[] {
  const ages: number[] = [];
  for (const d of devs) {
    const a = ageFromRRN(d.resident_number ?? null);
    if (a != null) ages.push(a);
  }
  return bucketize(ages, AGE_BINS);
}

/**
 * 경력 분포.
 *
 * 총 경력(개월) = career_months_at_hire + (오늘 - hire_date) 개월.
 * 둘 중 하나라도 없으면 집계에서 제외 (의미 있는 경력값이 안 나옴).
 */
export function careerBuckets(devs: StatsDeveloper[]): Bucket[] {
  const months: number[] = [];
  const now = new Date();
  for (const d of devs) {
    const since = monthsBetween(d.hire_date ?? null, now);
    if (since == null) continue;
    const before = d.career_months_at_hire ?? 0;
    months.push(since + before);
  }
  return bucketize(months, CAREER_BINS_MONTHS);
}

/** 근무 기간 분포 (입사일 ~ 오늘, 개월). */
export function tenureBuckets(devs: StatsDeveloper[]): Bucket[] {
  const months: number[] = [];
  const now = new Date();
  for (const d of devs) {
    const m = monthsBetween(d.hire_date ?? null, now);
    if (m != null) months.push(m);
  }
  return bucketize(months, TENURE_BINS_MONTHS);
}
