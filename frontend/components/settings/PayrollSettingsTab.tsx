"use client";

/**
 * Settings → 급여 — 회사별 급여일 / 휴일 보정 정책.
 *
 * 저장 위치: `app_settings.payroll` (tenant-scoped).
 * 사용처: 대시보드 KPI 타일 '다음 급여일' 의 D-카운트 계산.
 *
 * 휴일 보정:
 *   - rollback_strategy = "previous"  직전 영업일로 (예: 22일 토 → 21일 금).
 *   - rollback_strategy = "next"      다음 영업일로 (예: 22일 토 → 24일 월).
 *   - include_holidays = true 면 토/일 + 공휴일 모두 영업일 외, false 면 토/일만.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { fetchSection, saveSection } from "./settings-api";

type PayrollConfig = {
  payday_of_month: number;
  rollback_strategy: "previous" | "next";
  include_holidays: boolean;
};

type Preview = {
  scheduled_date: string;
  actual_date: string;
  days_until: number;
  is_today: boolean;
  rolled_back: boolean;
  label: string;
};

export function PayrollSettingsTab() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: cfg } = useQuery<PayrollConfig>({
    queryKey: ["settings", "payroll"],
    queryFn: async () => {
      const raw = await fetchSection<Partial<PayrollConfig>>("payroll");
      // 미설정·부분 값에 대비한 default merge.
      return {
        payday_of_month: raw?.payday_of_month ?? 25,
        rollback_strategy: raw?.rollback_strategy ?? "previous",
        include_holidays: raw?.include_holidays ?? true,
      };
    },
  });

  const [form, setForm] = useState<PayrollConfig | null>(null);
  useEffect(() => {
    if (cfg) setForm(cfg);
  }, [cfg]);

  // 미리보기 — 현재 저장된 설정 기준의 다음 급여일 (form 변경은 저장 후 반영).
  const { data: preview } = useQuery<Preview>({
    queryKey: ["next-payday"],
    queryFn: async () => (await api.get("/dashboard/next-payday")).data,
    staleTime: 60_000,
  });

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form) return;
      await saveSection("payroll", form);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "payroll"] });
      qc.invalidateQueries({ queryKey: ["next-payday"] });
      dialog.alert("저장되었습니다.", { title: "급여 설정" });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  if (!form)
    return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;

  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">급여 설정</h3>
          <p className="text-xs text-muted-foreground">
            대시보드의 <b>다음 급여일</b> 카운트와 향후 급여 산정에 사용됩니다.
            휴일·주말 자동 보정.
          </p>
        </div>

        {/* 급여일 */}
        <label className="flex flex-col gap-1 max-w-xs">
          <span className="text-xs text-muted-foreground">급여일 (매월 N일)</span>
          <input
            type="number"
            min={1}
            max={31}
            value={form.payday_of_month}
            onChange={(e) =>
              setForm({ ...form, payday_of_month: Number(e.target.value) || 1 })
            }
            className={input + " w-24"}
          />
          <span className="text-[11px] text-muted-foreground">
            31일 설정 시 그 달 마지막 날로 자동 보정 (예: 2월 = 28/29일).
          </span>
        </label>

        {/* 휴일 처리 */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs text-muted-foreground mb-1">
            휴일·주말일 때 처리
          </legend>
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="rollback"
              checked={form.rollback_strategy === "previous"}
              onChange={() => setForm({ ...form, rollback_strategy: "previous" })}
            />
            직전 영업일로 (기본 — 토 → 금)
          </label>
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="rollback"
              checked={form.rollback_strategy === "next"}
              onChange={() => setForm({ ...form, rollback_strategy: "next" })}
            />
            다음 영업일로 (토 → 월)
          </label>
        </fieldset>

        {/* 공휴일 포함 */}
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.include_holidays}
            onChange={(e) =>
              setForm({ ...form, include_holidays: e.target.checked })
            }
          />
          공휴일 (법정·임시·회사 휴일) 도 영업일 외로 간주
        </label>

        {/* 저장 */}
        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={saveM.isPending}
            className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            저장
          </button>
        </div>
      </section>

      {/* 미리보기 — 현재 *저장된* 설정 기준. form 미반영 변경분은 저장 후 갱신. */}
      <section className="rounded-lg border border-border bg-muted/30 p-4">
        <h4 className="text-xs font-semibold text-muted-foreground mb-2">
          현재 적용된 다음 급여일
        </h4>
        {preview ? (
          <div className="text-sm">
            <span className="font-semibold tabular-nums">
              {preview.actual_date}
            </span>
            <span className="text-muted-foreground ml-2">
              ({preview.is_today ? "오늘" : `D-${preview.days_until}`}, {preview.label})
            </span>
            {preview.rolled_back && (
              <span className="ml-2 text-amber-600 text-xs">
                * 휴일 보정: {preview.scheduled_date} → {preview.actual_date}
              </span>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">불러오는 중…</div>
        )}
      </section>
    </div>
  );
}
