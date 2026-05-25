"use client";

/**
 * 목표 기준 — 연도별 종합 점수 가중치 하한 (min_total_weight).
 *
 * 적게 등록한 사람의 가중평균 부풀림을 차단:
 *   total_score = Σ(goal_score) / max(Σweight, min_total_weight)
 *
 * weight 1개의 의미: priority(상3 / 중2 / 하1) × category(기본 1.0).
 * 예: 정규직 연 5개 (난이도 무관, 평균 우선순위 중) ≈ 5 × 2 = 10.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";
import { Dialog } from "@/components/ui/Dialog";

type Baseline = {
  id: string;
  year: number;
  min_total_weight: string;
  min_goal_count: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export function GoalBaselinesTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [editYear, setEditYear] = useState<number | null>(null);

  const { data: rows = [] } = useQuery<Baseline[]>({
    queryKey: ["goal-score-baselines"],
    queryFn: async () => (await api.get("/goals/score/baselines")).data,
  });

  const deleteM = useMutation({
    mutationFn: async (year: number) =>
      api.delete(`/goals/score/baselines/${year}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["goal-score-baselines"] }),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">목표 기준 (가중치 하한)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            연도별 종합 점수 가중치 합의 하한. 등록된 목표의 Σ가중치가 이 값에 못 미치면
            분모가 하한으로 고정되어 점수가 비례하여 낮아집니다.
            <br />
            가중치 = 우선순위(상 3 / 중 2 / 하 1) × 분류 가중치(기본 1.0).
            예: 표준 우선순위 5개 ≈ 10.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditYear(new Date().getFullYear())}
          className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
        >
          <Plus className="h-3.5 w-3.5" />새 기준 등록
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          등록된 기준이 없습니다. 모든 연도에서 가중치 하한이 적용되지 않습니다.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-left border-b border-border">
              <th className="py-2">연도</th>
              <th>가중치 하한</th>
              <th>권장 최소 목표 수</th>
              <th>비고</th>
              <th className="text-right">작업</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/40">
                <td className="py-2 font-medium tabular-nums">{r.year}</td>
                <td className="tabular-nums">{Number(r.min_total_weight).toFixed(2)}</td>
                <td className="tabular-nums">{r.min_goal_count ?? "-"}</td>
                <td className="text-muted-foreground truncate max-w-[24rem]">
                  {r.note ?? "-"}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    onClick={() => setEditYear(r.year)}
                    className="text-primary hover:underline mr-3"
                  >
                    편집
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        await dialog.confirm(
                          `${r.year}년 기준을 삭제하시겠습니까?\n삭제 후에는 가중치 하한이 적용되지 않습니다.`,
                          { destructive: true },
                        )
                      ) {
                        deleteM.mutate(r.year);
                      }
                    }}
                    className="inline-flex items-center gap-0.5 text-destructive hover:underline"
                  >
                    <Trash2 className="h-3 w-3" />
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editYear !== null && (
        <BaselineEditor
          year={editYear}
          existing={rows.find((r) => r.year === editYear) ?? null}
          onClose={() => setEditYear(null)}
        />
      )}
    </div>
  );
}

function BaselineEditor({
  year,
  existing,
  onClose,
}: {
  year: number;
  existing: Baseline | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    year: String(year),
    min_total_weight: "10",
    min_goal_count: "",
    note: "",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existing) {
      setForm({
        year: String(existing.year),
        min_total_weight: String(existing.min_total_weight),
        min_goal_count:
          existing.min_goal_count != null ? String(existing.min_goal_count) : "",
        note: existing.note ?? "",
      });
    } else {
      setForm({
        year: String(year),
        min_total_weight: "10",
        min_goal_count: "",
        note: "",
      });
    }
    setError(null);
  }, [year, existing]);

  const saveM = useMutation({
    mutationFn: async () => {
      const y = Number(form.year);
      const payload: Record<string, unknown> = {
        year: y,
        min_total_weight: form.min_total_weight,
        min_goal_count: form.min_goal_count
          ? Number(form.min_goal_count)
          : null,
        note: form.note || null,
      };
      return (await api.put(`/goals/score/baselines/${y}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goal-score-baselines"] });
      onClose();
    },
    onError: (e: any) =>
      setError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "저장 실패",
      ),
  });

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? `${existing.year}년 기준 편집` : "새 기준 등록"}
      width="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={saveM.isPending}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            저장
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">연도</span>
          <input
            type="number"
            disabled={!!existing}
            value={form.year}
            onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))}
            className={input + " disabled:opacity-60"}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            가중치 하한 (Σweight floor) *
          </span>
          <input
            type="number"
            step="0.5"
            min="0.5"
            value={form.min_total_weight}
            onChange={(e) =>
              setForm((p) => ({ ...p, min_total_weight: e.target.value }))
            }
            className={input}
          />
          <span className="text-[11px] text-muted-foreground">
            가이드: 표준 우선순위(중) 1개 = 2, (상) 1개 = 3, (하) 1개 = 1.
            정규직 연 5개(평균 중) ≈ 10, 8개 ≈ 16 정도가 일반적입니다.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            권장 최소 목표 수 (안내용)
          </span>
          <input
            type="number"
            min="0"
            value={form.min_goal_count}
            onChange={(e) =>
              setForm((p) => ({ ...p, min_goal_count: e.target.value }))
            }
            className={input}
            placeholder="예: 5"
          />
          <span className="text-[11px] text-muted-foreground">
            점수 페널티는 가중치 하한만 적용. 이 값은 사용자에게 "n개 이상 권장" 안내로만
            노출됩니다.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">비고</span>
          <input
            value={form.note}
            onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
            className={input}
            placeholder="예: 정규직 기준"
          />
        </label>
        {error && (
          <div className="text-xs text-destructive">{error}</div>
        )}
      </div>
    </Dialog>
  );
}
