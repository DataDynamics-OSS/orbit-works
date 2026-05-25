"use client";

import { Fragment, useMemo } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Printer, X } from "lucide-react";
import { api } from "@/lib/api";

type AccountCode = {
  id: string;
  category: string;
  name: string;
};

type Line = {
  id?: string;
  account_code_id: string | null;
  item_label: string | null;
  m1: number; m2: number; m3: number; m4: number;
  m5: number; m6: number; m7: number; m8: number;
  m9: number; m10: number; m11: number; m12: number;
  note: string | null;
  sort_order: number;
};

type PlanDetail = {
  id: string;
  year: number;
  title: string;
  memo: string | null;
  created_at: string;
  updated_at: string;
  lines: Line[];
};

const MONTHS = [
  "1월", "2월", "3월", "4월", "5월", "6월",
  "7월", "8월", "9월", "10월", "11월", "12월",
];

const fmtMoney = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString("ko-KR") : "-";

const lineTotal = (l: Line): number =>
  Number(l.m1 || 0) + Number(l.m2 || 0) + Number(l.m3 || 0) +
  Number(l.m4 || 0) + Number(l.m5 || 0) + Number(l.m6 || 0) +
  Number(l.m7 || 0) + Number(l.m8 || 0) + Number(l.m9 || 0) +
  Number(l.m10 || 0) + Number(l.m11 || 0) + Number(l.m12 || 0);

export default function BudgetCalcPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const { data: plan } = useQuery<PlanDetail>({
    queryKey: ["budget-calc-preview", id],
    queryFn: async () => (await api.get(`/budget-calc/${id}`)).data,
    enabled: !!id,
  });
  const { data: accountCodes = [] } = useQuery<AccountCode[]>({
    queryKey: ["account-codes-preview"],
    queryFn: async () => (await api.get("/account-codes?kind=EXPENSE")).data,
    staleTime: 60 * 60 * 1000,
  });

  const acById = useMemo(() => {
    const m = new Map<string, AccountCode>();
    accountCodes.forEach((a) => m.set(a.id, a));
    return m;
  }, [accountCodes]);

  // 카테고리별 그룹핑 (Rules of Hooks — early return 전에 호출)
  const grouped = useMemo(() => {
    if (!plan) return [];
    const map = new Map<string, Line[]>();
    for (const l of plan.lines) {
      const cat = acById.get(l.account_code_id ?? "")?.category ?? "(미지정)";
      const arr = map.get(cat) ?? [];
      arr.push(l);
      map.set(cat, arr);
    }
    return [...map.entries()].sort((a, b) => {
      const aMin = Math.min(...a[1].map((l) => l.sort_order));
      const bMin = Math.min(...b[1].map((l) => l.sort_order));
      return aMin - bMin;
    });
  }, [plan, acById]);

  if (!plan) return <div className="p-8 text-sm">로딩 중…</div>;

  const grand = plan.lines.reduce((s, l) => s + lineTotal(l), 0);
  const monthGrand = (i: number) =>
    plan.lines.reduce((s, l) => {
      const v = (l as any)[`m${i}`] || 0;
      return s + Number(v);
    }, 0);

  return (
    <div className="budget-calc-report bg-white text-sm">
      <style>{`
        @media print {
          @page { size: A3 landscape; margin: 12mm; }
          html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
          body * { visibility: hidden !important; }
          .budget-calc-report, .budget-calc-report * { visibility: visible !important; }
          .budget-calc-report { position: static !important; inset: auto !important; overflow: visible !important; }
          .no-print { display: none !important; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          thead { display: table-header-group; }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Printer className="h-4 w-4" />
            인쇄 / PDF 저장
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <X className="h-4 w-4" />
            닫기
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6 print:p-0">
        <h1 className="text-xl font-bold mb-1">운영 예산 계획</h1>
        <div className="text-muted-foreground mb-4">
          [{plan.year}] {plan.title}
        </div>
        {plan.memo && (
          <div className="text-sm text-muted-foreground mb-4 whitespace-pre-line">
            {plan.memo}
          </div>
        )}

        <div className="text-sm mb-3 tabular-nums">
          <span className="text-muted-foreground">총 연간 지출</span>{" "}
          <b>{fmtMoney(grand)}원</b>
          {" · "}
          <span className="text-muted-foreground">월평균</span>{" "}
          <b>{fmtMoney(grand / 12)}원</b>
          {" · "}
          <span className="text-muted-foreground">라인</span>{" "}
          <b>{plan.lines.length}건</b>
        </div>

        <table className="w-full border border-border text-xs tabular-nums">
          <colgroup>
            <col style={{ width: "100px" }} />
            <col style={{ width: "180px" }} />
            <col style={{ width: "120px" }} />
            {MONTHS.map((_, i) => (
              <col key={i} style={{ width: "70px" }} />
            ))}
            <col style={{ width: "100px" }} />
          </colgroup>
          <thead className="bg-slate-100">
            <tr>
              <th className="border border-border p-1.5 text-left">비목</th>
              <th className="border border-border p-1.5 text-left">항목</th>
              <th className="border border-border p-1.5 text-left">라벨</th>
              {MONTHS.map((m) => (
                <th key={m} className="border border-border p-1.5 text-right">
                  {m}
                </th>
              ))}
              <th className="border border-border p-1.5 text-right">합계</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([cat, lines]) => {
              const catSums = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
              for (const l of lines) {
                catSums[0] += Number(l.m1 || 0);
                catSums[1] += Number(l.m2 || 0);
                catSums[2] += Number(l.m3 || 0);
                catSums[3] += Number(l.m4 || 0);
                catSums[4] += Number(l.m5 || 0);
                catSums[5] += Number(l.m6 || 0);
                catSums[6] += Number(l.m7 || 0);
                catSums[7] += Number(l.m8 || 0);
                catSums[8] += Number(l.m9 || 0);
                catSums[9] += Number(l.m10 || 0);
                catSums[10] += Number(l.m11 || 0);
                catSums[11] += Number(l.m12 || 0);
              }
              const catTotal = catSums.reduce((s, v) => s + v, 0);
              return (
                <Fragment key={cat}>
                  <tr className="bg-slate-50 font-semibold">
                    <td className="border border-border p-1.5" colSpan={3}>
                      {cat}
                    </td>
                    {catSums.map((v, i) => (
                      <td
                        key={i}
                        className="border border-border p-1.5 text-right"
                      >
                        {fmtMoney(v)}
                      </td>
                    ))}
                    <td className="border border-border p-1.5 text-right">
                      {fmtMoney(catTotal)}
                    </td>
                  </tr>
                  {lines
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((l, idx) => {
                      const total = lineTotal(l);
                      const ac = acById.get(l.account_code_id ?? "");
                      return (
                        <tr key={l.id ?? `n${idx}`}>
                          <td className="border border-border p-1.5 text-muted-foreground">
                            {/* 빈 (그룹 헤더에 표시) */}
                          </td>
                          <td className="border border-border p-1.5">
                            {ac ? ac.name : "—"}
                          </td>
                          <td className="border border-border p-1.5">
                            {l.item_label ?? ""}
                          </td>
                          {[
                            l.m1, l.m2, l.m3, l.m4, l.m5, l.m6,
                            l.m7, l.m8, l.m9, l.m10, l.m11, l.m12,
                          ].map((v, i) => (
                            <td
                              key={i}
                              className="border border-border p-1.5 text-right"
                            >
                              {Number(v) > 0 ? fmtMoney(Number(v)) : "—"}
                            </td>
                          ))}
                          <td className="border border-border p-1.5 text-right font-semibold">
                            {fmtMoney(total)}
                          </td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
            <tr className="bg-slate-200 font-bold">
              <td className="border border-border p-1.5" colSpan={3}>
                총합
              </td>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
                <td
                  key={i}
                  className="border border-border p-1.5 text-right"
                >
                  {fmtMoney(monthGrand(i))}
                </td>
              ))}
              <td className="border border-border p-1.5 text-right">
                {fmtMoney(grand)}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="mt-8 text-xs text-muted-foreground">
          출력일: {new Date().toLocaleString("ko-KR")}
        </div>
      </div>
    </div>
  );
}
