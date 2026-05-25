import raw from "./airports-data.json";

export type Airport = {
  iata: string;
  name: string;
  city: string;
  country: string;
  tz: string; // IANA TZ (예: America/Los_Angeles)
};

export const AIRPORTS: Airport[] = raw as Airport[];

const BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));

export function findAirport(iata: string | null | undefined): Airport | null {
  if (!iata) return null;
  return BY_IATA.get(iata.toUpperCase()) ?? null;
}

/** "SFO – San Francisco (San Francisco International Airport)" 형태 라벨. */
export function airportLabel(a: Airport): string {
  return `${a.iata} – ${a.city} (${a.name})`;
}

/** 검색 — IATA 우선 매칭, 그 다음 도시/이름 부분일치. 최대 limit 개. */
export function searchAirports(q: string, limit = 12): Airport[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const exact = BY_IATA.get(term.toUpperCase());
  const out: Airport[] = exact ? [exact] : [];
  for (const a of AIRPORTS) {
    if (out.length >= limit) break;
    if (exact && a.iata === exact.iata) continue;
    const hay = `${a.iata} ${a.city} ${a.name} ${a.country}`.toLowerCase();
    if (hay.includes(term)) out.push(a);
  }
  return out;
}
