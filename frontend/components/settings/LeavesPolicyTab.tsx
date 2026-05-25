"use client";

/**
 * 외부 연동 — 연차 정책.
 *
 * 1~21년차 총 부여 일수를 회사 정책으로 입력. 22년+ 는 21년 행 값 적용.
 * 법정 최저(근로기준법 60조) 미만 입력 시 빨간 경고 + 저장 차단.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { fetchSection, saveSection } from "./settings-api";
import { useDialog } from "@/components/ui/DialogProvider";

type LeavesCfg = {
  // 1~21년차 총 부여 일수. 길이 21 보장. 누락 시 법정 최저로 채움.
  annual_days_by_year: number[];
};

// 근로기준법 60조 — 1년차부터 21년차까지 총 부여 일수.
// 1~2년차: 15, 3년차+: 매 2년 +1, 21년차: 25 상한.
const LEGAL_MIN: number[] = [
  15, 15, 16, 16, 17, 17, 18, 18, 19, 19,
  20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25,
];

export function LeavesPolicyTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: cfg } = useQuery<LeavesCfg>({
    queryKey: ["settings", "leaves"],
    queryFn: () => fetchSection("leaves"),
  });

  const [days, setDays] = useState<number[]>(LEGAL_MIN);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const arr = cfg?.annual_days_by_year;
    if (Array.isArray(arr) && arr.length === 21) {
      setDays(arr.map((v) => Number(v) || 0));
    } else {
      // 미설정 → 법정 최저 시드
      setDays([...LEGAL_MIN]);
    }
  }, [cfg]);

  const violations = days
    .map((v, i) => (v < LEGAL_MIN[i] ? i + 1 : null))
    .filter((x): x is number => x !== null);
  const hasViolation = violations.length > 0;

  const saveM = useMutation({
    mutationFn: async () => {
      if (hasViolation) {
        throw new Error(
          `${violations.join(", ")}년차가 법정 최저(${violations
            .map((y) => LEGAL_MIN[y - 1])
            .join(", ")}일) 보다 적습니다.`,
        );
      }
      await saveSection("leaves", { annual_days_by_year: days });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.message ?? "저장 실패", { title: "오류" });
    },
  });

  function setYear(idx: number, value: number) {
    setDays((prev) => prev.map((v, i) => (i === idx ? value : v)));
  }

  function resetToLegal() {
    setDays([...LEGAL_MIN]);
  }

  const inputCls =
    "w-20 rounded-md border bg-background px-2 py-1 text-sm text-right tabular-nums";

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">연차 정책 — 총 부여 일수</h3>
          <p className="text-[11px] text-muted-foreground mt-1">
            근속 1~21년차의 1년 동안 부여할 총 연차 일수. 회사 정책이 법정보다
            후하면 그 값 입력. 22년 이상은 21년 행 값을 그대로 적용. 법정 최저
            (근로기준법 60조) 미만 입력 시 저장 불가.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2">
          {days.map((v, i) => {
            const year = i + 1;
            const min = LEGAL_MIN[i];
            const violation = v < min;
            return (
              <label key={i} className="flex items-center gap-2 text-xs">
                <span className="w-12 shrink-0 text-muted-foreground tabular-nums">
                  {year}년차
                </span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={v}
                  onChange={(e) =>
                    setYear(i, Math.max(0, Number(e.target.value) || 0))
                  }
                  className={
                    inputCls +
                    (violation
                      ? " border-rose-300 text-rose-700"
                      : " border-input")
                  }
                  title={`법정 최저: ${min}일`}
                />
              </label>
            );
          })}
        </div>

        {hasViolation && (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            법정 최저보다 적게 입력한 행: {violations.join(", ")}년차. 근로기준법
            60조 위반 — 저장 불가.
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={saveM.isPending || hasViolation}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saveM.isPending ? "저장 중..." : "저장"}
          </button>
          <button
            type="button"
            onClick={resetToLegal}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            법정 최저로 초기화
          </button>
          {saved && (
            <span className="text-xs text-emerald-600">저장되었습니다.</span>
          )}
        </div>
      </section>
    </div>
  );
}
