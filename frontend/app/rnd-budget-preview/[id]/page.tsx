"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  BudgetReport,
  type PlanDetail,
} from "@/components/rnd-budget/BudgetReport";

export default function RndBudgetPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const { data: plan, isLoading, error } = useQuery<PlanDetail>({
    queryKey: ["rnd-budget-preview", id],
    queryFn: async () => (await api.get(`/rnd-budgets/${id}`)).data,
    enabled: !!id,
  });

  if (isLoading)
    return (
      <div className="p-8 text-sm text-muted-foreground">로딩 중…</div>
    );
  if (error)
    return (
      <div className="p-8 text-sm text-rose-600">
        예산서를 불러오지 못했습니다.
      </div>
    );
  if (!plan) return null;

  // 분모 — 저장된 총 연구개발비 우선, 미설정이면 grand total fallback.
  const grand = plan.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const pctDenom = Number(plan.total_rnd_budget ?? 0) || grand;

  return (
    <BudgetReport
      plan={plan}
      pctDenom={pctDenom}
      onClose={() => window.close()}
      embedded
    />
  );
}
