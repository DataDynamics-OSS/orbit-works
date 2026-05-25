"use client";

/**
 * 환율 계산기 — KRW · USD · EUR · CNY · JPY · THB 양방향 변환.
 *
 * 모든 통화 칸이 input. 어느 칸이든 입력하면 그 값을 source 로 잡아
 * 다른 5개 칸을 즉시 갱신. 환율은 백엔드 `/exchange/multi?base=KRW` 가
 * frankfurter.app 에서 가져온 값 (6시간 캐시). 외부 API 실패 시 fallback
 * rate 로 응답되며 캡션에 '참고용' 표시.
 *
 * 표시 정밀도:
 *   KRW, JPY → 정수 + 콤마
 *   USD, EUR, CNY, THB → 소수 2자리 + 콤마
 *
 * 사용자가 타이핑하는 동안 그 칸의 값은 raw 그대로 보여주고 (포맷 적용 X),
 * focus 잃을 때 (blur) 표준 포맷으로 정렬.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

type Currency =
  | "KRW" | "USD" | "EUR" | "CNY" | "JPY" | "THB"
  | "VND" | "TWD" | "HKD" | "SGD";

const CURRENCIES: Currency[] = [
  "KRW", "USD", "EUR", "CNY", "JPY", "THB",
  "VND", "TWD", "HKD", "SGD",
];

const SYMBOL: Record<Currency, string> = {
  KRW: "₩",
  USD: "$",
  EUR: "€",
  CNY: "¥",
  JPY: "¥",
  THB: "฿",
  VND: "₫",
  TWD: "NT$",
  HKD: "HK$",
  SGD: "S$",
};

const NAME: Record<Currency, string> = {
  KRW: "원",
  USD: "달러",
  EUR: "유로",
  CNY: "위안",
  JPY: "엔",
  THB: "바트",
  VND: "동",
  TWD: "대만",
  HKD: "홍콩",
  SGD: "싱가폴",
};

type RatesResp = {
  base: string;
  date: string;
  rates: Record<string, number>;
  source: "open-er-api" | "frankfurter" | "fallback";
};

function fmt(n: number, c: Currency): string {
  if (!isFinite(n) || isNaN(n)) return "";
  // KRW · JPY · VND 는 관행상 소수 미표기 (단위가 작거나 큰 정수 자릿수).
  if (c === "KRW" || c === "JPY" || c === "VND") {
    return Math.round(n).toLocaleString("en-US");
  }
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseLocaleNumber(s: string): number {
  // 콤마/공백 제거, 끝에 . 만 있는 입력도 파싱.
  const cleaned = s.replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === ".") return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

export function FxConverter() {
  const { data: rates, isFetching, refetch, error } = useQuery<RatesResp>({
    queryKey: ["exchange-multi", "KRW"],
    queryFn: async () =>
      (await api.get("/exchange/multi", { params: { base: "KRW" } })).data,
    staleTime: 6 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const [values, setValues] = useState<Record<Currency, string>>(() =>
    Object.fromEntries(CURRENCIES.map((c) => [c, ""])) as Record<Currency, string>,
  );
  // 어느 통화를 마지막으로 입력했는지 — 그 칸은 raw 값 그대로 유지.
  const [editing, setEditing] = useState<Currency | null>(null);
  const focusedRef = useRef<Currency | null>(null);

  // 초기화 — rates 가 처음 들어왔을 때 1,000원 기준으로 채움.
  useEffect(() => {
    if (!rates) return;
    if (editing) return;  // 사용자가 편집 중이면 덮어쓰지 않음.
    const krw = 1000;
    const next: Record<Currency, string> = {} as Record<Currency, string>;
    for (const c of CURRENCIES) {
      if (c === "KRW") {
        next[c] = fmt(krw, c);
      } else {
        const r = rates.rates[c] ?? 0;
        next[c] = fmt(krw * r, c);
      }
    }
    setValues(next);
  }, [rates, editing]);

  const handleChange = (c: Currency, raw: string) => {
    setEditing(c);
    if (!rates) {
      setValues((v) => ({ ...v, [c]: raw }));
      return;
    }
    const v = parseLocaleNumber(raw);
    // c 단위 → KRW 환산. base=KRW 기준이므로 rates[c] = "1 KRW = X c" 이고,
    // 따라서 X c 를 KRW 로 바꾸려면 X / rates[c].
    const krw = c === "KRW" ? v : rates.rates[c] ? v / rates.rates[c] : 0;
    const next: Record<Currency, string> = {} as Record<Currency, string>;
    for (const x of CURRENCIES) {
      if (x === c) {
        next[x] = raw; // 사용자가 친 값 그대로 유지
      } else if (x === "KRW") {
        next[x] = fmt(krw, "KRW");
      } else {
        const r = rates.rates[x] ?? 0;
        next[x] = fmt(krw * r, x);
      }
    }
    setValues(next);
  };

  const handleBlur = (c: Currency) => {
    // focus 빠지면 그 칸도 표준 포맷으로 정리.
    setValues((cur) => {
      const v = parseLocaleNumber(cur[c]);
      return { ...cur, [c]: fmt(v, c) };
    });
    focusedRef.current = null;
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {CURRENCIES.map((c) => (
        <div
          key={c}
          className={
            "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors " +
            (focusedRef.current === c
              ? "border-primary bg-background"
              : "border-border bg-background")
          }
        >
          <div className="w-9 text-[11px] font-semibold tabular-nums">{c}</div>
          <div className="w-9 text-center text-xs text-muted-foreground tabular-nums">
            {SYMBOL[c]}
          </div>
          <input
            type="text"
            inputMode="decimal"
            value={values[c]}
            onChange={(e) => handleChange(c, e.target.value)}
            onFocus={() => {
              focusedRef.current = c;
            }}
            onBlur={() => handleBlur(c)}
            placeholder="0"
            className="flex-1 text-right text-sm font-medium tabular-nums bg-transparent outline-none"
          />
          <div className="w-9 text-[10px] text-muted-foreground text-right">
            {NAME[c]}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between mt-2 px-1">
        {/* fallback 일 때는 amber + 경고 아이콘 — 외부 API 실패해서 하드코딩
            대략값을 쓰고 있다는 신호. 정상이면 회색 캡션. */}
        {rates && rates.source === "fallback" ? (
          <span
            className="text-[10px] text-amber-600 inline-flex items-center gap-1"
            title="외부 환율 API 호출 실패 — 하드코딩된 대략값으로 표시 중. 새로고침 시 재시도."
          >
            <AlertTriangle className="h-3 w-3" />
            참고용 환율 ({rates.date} 기준)
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {error ? "환율 조회 실패" : rates ? `${rates.date} 기준` : "—"}
          </span>
        )}
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className={
            "text-[10px] inline-flex items-center gap-1 disabled:opacity-50 " +
            (rates?.source === "fallback"
              ? "text-amber-600 hover:text-amber-700"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          새로고침
        </button>
      </div>
    </div>
  );
}
