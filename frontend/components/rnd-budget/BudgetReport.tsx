"use client";

import { Fragment } from "react";
import { Printer, X } from "lucide-react";

// ---------------------------------------------------------------------------
// Types — rnd-budget 도메인 자족 (page.tsx 의 정의와 호환)
// ---------------------------------------------------------------------------

export type CompanySize = "SMALL" | "MID" | "LARGE";
export type PlanStatus = "DRAFT" | "SUBMITTED" | "APPROVED";

export type Line = {
  id?: string;
  category_id: string;
  category_label: string;
  subcategory_id: string;
  subcategory_label: string;
  item_id: string | null;
  item_label: string | null;
  unit_price: number;
  quantity: number;
  amount: number;
  note: string | null;
  sort_order: number;
};

export type PersonnelSegment = "EXISTING" | "NEW";
export type Personnel = {
  id?: string;
  segment: PersonnelSegment;
  name: string;
  role: string | null;
  monthly_salary: number;
  monthly_insurance: number;
  severance_annual: number;
  months: number;
  ratio_pct: number;
  sort_order: number;
};

export type PlanDetail = {
  id: string;
  year: number;
  title: string;
  project_id: string | null;
  customer_id: string | null;
  funding_agency: string | null;
  memo: string | null;
  status: PlanStatus;
  total_amount: number;
  company_size: CompanySize | null;
  total_rnd_budget: number | null;
  gov_funding_amount: number | null;
  own_cash_amount: number | null;
  own_inkind_amount: number | null;
  gov_funding_rate: number | null;
  own_burden_rate: number | null;
  cash_min_rate: number | null;
  inkind_min_rate: number | null;
  project_name: string | null;
  customer_name: string | null;
  line_count: number;
  created_at: string;
  updated_at: string;
  lines: Line[];
  personnel?: Personnel[];
};

const COMPANY_SIZE_LABEL: Record<CompanySize, string> = {
  SMALL: "중소기업",
  MID: "중견기업",
  LARGE: "대기업",
};

const fmtMoney = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString("ko-KR") : "-";

const roundWon = (n: number) =>
  Number.isFinite(n) ? Math.round(n / 10) * 10 : 0;

const calcPersonnelAmount = (p: Personnel): number => {
  const annual =
    (Number(p.monthly_salary) + Number(p.monthly_insurance)) * 12 +
    Number(p.severance_annual);
  return roundWon(
    (annual * (Number(p.months) || 0) * (Number(p.ratio_pct) || 0)) /
      (12 * 100),
  );
};

// ---------------------------------------------------------------------------
// 컴포넌트
// ---------------------------------------------------------------------------

export function BudgetReport({
  plan,
  pctDenom,
  onClose,
  embedded = false,
}: {
  plan: PlanDetail;
  /**
   * 비목/세목/세부 행의 % 분모. 일반적으로 plan.total_rnd_budget 사용,
   * 미설정이면 grand total 로 fallback (호출측에서 결정).
   */
  pctDenom: number;
  onClose: () => void;
  /**
   * embedded=true 면 fixed 오버레이 / visibility 트릭 등을 끄고,
   * 일반 흐름 안에 인라인 렌더 (별도 창에서 사용 시 권장).
   */
  embedded?: boolean;
}) {
  const dataLines = plan.lines.map((l) => ({
    ...l,
    unit_price: Number(l.unit_price ?? 0),
    quantity: Number(l.quantity ?? 0),
    amount: Number(l.amount ?? 0),
  }));
  const nonZero = dataLines.filter((l) => l.amount > 0);
  const grand = dataLines.reduce((s, l) => s + l.amount, 0);
  const pct = (n: number) =>
    pctDenom > 0 ? `${((n / pctDenom) * 100).toFixed(1)}%` : "—";

  // 비목·세목 트리
  type Sub = {
    subId: string;
    subLabel: string;
    amount: number;
    sortKey: number;
  };
  type Cat = {
    catId: string;
    catLabel: string;
    amount: number;
    sortKey: number;
    subs: Sub[];
  };
  const catMap = new Map<string, Cat>();
  for (const l of dataLines) {
    let cat = catMap.get(l.category_id);
    if (!cat) {
      cat = {
        catId: l.category_id,
        catLabel: l.category_label,
        amount: 0,
        sortKey: l.sort_order,
        subs: [],
      };
      catMap.set(l.category_id, cat);
    }
    cat.amount += l.amount;
    if (l.sort_order < cat.sortKey) cat.sortKey = l.sort_order;
    let sub = cat.subs.find((s) => s.subId === l.subcategory_id);
    if (!sub) {
      sub = {
        subId: l.subcategory_id,
        subLabel: l.subcategory_label,
        amount: 0,
        sortKey: l.sort_order,
      };
      cat.subs.push(sub);
    }
    sub.amount += l.amount;
    if (l.sort_order < sub.sortKey) sub.sortKey = l.sort_order;
  }
  const tree = [...catMap.values()]
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((c) => ({
      ...c,
      subs: c.subs.sort((a, b) => a.sortKey - b.sortKey),
    }));

  const detailSorted = [...nonZero].sort((a, b) => a.sort_order - b.sort_order);

  const sizeLabel =
    plan.company_size && COMPANY_SIZE_LABEL[plan.company_size]
      ? COMPANY_SIZE_LABEL[plan.company_size]
      : "—";
  const fmtRate = (r: number | null, suffix = "") =>
    r == null ? "—" : `${(Number(r) * 100).toFixed(1).replace(/\.0$/, "")}%${suffix}`;
  const ratesLabel =
    plan.gov_funding_rate != null || plan.cash_min_rate != null
      ? `정부 ≤ ${fmtRate(plan.gov_funding_rate)} · 기관 ≥ ${fmtRate(plan.own_burden_rate)} · 현금(內) ≥ ${fmtRate(plan.cash_min_rate)} (사용자 정의)`
      : `${sizeLabel} 표준 비율`;
  const gov = Number(plan.gov_funding_amount ?? 0);
  const cash = Number(plan.own_cash_amount ?? 0);
  const inkind = Number(plan.own_inkind_amount ?? 0);
  const own = cash + inkind;
  const total = gov + own;

  const rootClass = embedded
    ? "budget-report bg-white text-sm"
    : "budget-report fixed inset-0 z-50 bg-white overflow-auto text-sm";

  return (
    <div className={rootClass}>
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
          body * { visibility: hidden !important; }
          .budget-report, .budget-report * { visibility: visible !important; }
          .budget-report {
            position: static !important;
            inset: auto !important;
            overflow: visible !important;
            background: #fff !important;
            z-index: auto !important;
          }
          .no-print { display: none !important; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          thead { display: table-header-group; }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-border">
        <div className="max-w-5xl mx-auto px-6 py-2 flex justify-end gap-2">
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
            onClick={onClose}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <X className="h-4 w-4" />
            닫기
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6 print:p-0">
        <h1 className="text-xl font-bold mb-1">정부 R&amp;D 예산서</h1>
        <div className="text-muted-foreground mb-4">
          [{plan.year}] {plan.title}
        </div>

        <table className="w-full border border-border mb-6 text-sm">
          <tbody>
            <Row label="연도" value={String(plan.year)} />
            <Row label="예산서명" value={plan.title} />
            <Row label="프로젝트" value={plan.project_name ?? "—"} />
            <Row label="고객사" value={plan.customer_name ?? "—"} />
            <Row label="발주처" value={plan.funding_agency ?? "—"} />
            {plan.memo && <Row label="메모" value={plan.memo} />}
          </tbody>
        </table>

        <h2 className="text-lg font-semibold mb-2">예산 요약</h2>
        <table className="w-full border border-border mb-6 text-sm tabular-nums">
          <tbody>
            <Row label="기업 규모" value={sizeLabel} />
            <Row label="적용 비율" value={ratesLabel} />
            <Row label="정부 지원금" value={`${fmtMoney(gov)}원`} />
            <Row label="기관 부담금 (현금)" value={`${fmtMoney(cash)}원`} />
            <Row label="기관 부담금 (현물)" value={`${fmtMoney(inkind)}원`} />
            <Row label="기관 부담금 합계" value={`${fmtMoney(own)}원`} />
            <Row label="총 연구개발비" value={`${fmtMoney(total)}원`} />
            <Row label="세부 내역 총합" value={`${fmtMoney(grand)}원`} />
            <Row
              label="잔여"
              value={`${fmtMoney(total - grand)}원${total - grand < 0 ? " (초과)" : ""}`}
            />
          </tbody>
        </table>

        <h2 className="text-lg font-semibold mb-2">비목 · 세목 합계</h2>
        <table className="w-full border border-border mb-6 text-sm tabular-nums">
          <thead className="bg-slate-100">
            <tr>
              <th className="border border-border p-2 text-left">비목 / 세목</th>
              <th className="border border-border p-2 text-right w-32">금액 (원)</th>
              <th className="border border-border p-2 text-right w-20">%</th>
            </tr>
          </thead>
          <tbody>
            {tree.map((c) => (
              <Fragment key={c.catId}>
                <tr className="bg-slate-50 font-semibold">
                  <td className="border border-border p-2">{c.catLabel}</td>
                  <td className="border border-border p-2 text-right">
                    {fmtMoney(c.amount)}
                  </td>
                  <td className="border border-border p-2 text-right">
                    {pct(c.amount)}
                  </td>
                </tr>
                {c.subs.map((s) => (
                  <tr key={`${c.catId}|${s.subId}`}>
                    <td className="border border-border p-2 pl-6 text-muted-foreground">
                      {s.subLabel}
                    </td>
                    <td className="border border-border p-2 text-right">
                      {fmtMoney(s.amount)}
                    </td>
                    <td className="border border-border p-2 text-right">
                      {pct(s.amount)}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="bg-slate-200 font-bold">
              <td className="border border-border p-2">합계</td>
              <td className="border border-border p-2 text-right">
                {fmtMoney(grand)}
              </td>
              <td className="border border-border p-2 text-right">
                {pct(grand)}
              </td>
            </tr>
          </tbody>
        </table>

        <h2 className="text-lg font-semibold mb-2">
          세부 내역
          <span className="text-muted-foreground text-sm font-normal ml-2">
            (금액 0 인 라인 제외 · {detailSorted.length} 건)
          </span>
        </h2>
        {detailSorted.length === 0 ? (
          <div className="text-muted-foreground p-4 border border-border rounded-md">
            금액이 입력된 라인이 없습니다.
          </div>
        ) : (
          <table className="w-full border border-border text-sm tabular-nums table-fixed">
            <colgroup>
              <col style={{ width: "70px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "210px" }} />
              <col style={{ width: "85px" }} />
              <col style={{ width: "55px" }} />
              <col style={{ width: "85px" }} />
              <col style={{ width: "50px" }} />
              <col />
            </colgroup>
            <thead className="bg-slate-100">
              <tr>
                <th className="border border-border p-2 text-left">비목</th>
                <th className="border border-border p-2 text-left">세목</th>
                <th className="border border-border p-2 text-left">항목</th>
                <th className="border border-border p-2 text-right">단가 (원)</th>
                <th className="border border-border p-2 text-right">건수</th>
                <th className="border border-border p-2 text-right">합계 (원)</th>
                <th className="border border-border p-2 text-right">%</th>
                <th className="border border-border p-2 text-left">메모</th>
              </tr>
            </thead>
            <tbody>
              {detailSorted.map((l) => (
                <tr key={l.id ?? `n:${l.sort_order}`}>
                  <td className="border border-border p-2 break-words">
                    {l.category_label}
                  </td>
                  <td className="border border-border p-2 break-words">
                    {l.subcategory_label}
                  </td>
                  <td className="border border-border p-2 break-words">
                    {l.item_label ?? "-"}
                  </td>
                  <td className="border border-border p-2 text-right whitespace-nowrap">
                    {fmtMoney(Number(l.unit_price))}
                  </td>
                  <td className="border border-border p-2 text-right whitespace-nowrap">
                    {Number(l.quantity).toLocaleString("ko-KR")}
                  </td>
                  <td className="border border-border p-2 text-right whitespace-nowrap">
                    {fmtMoney(Number(l.amount))}
                  </td>
                  <td className="border border-border p-2 text-right whitespace-nowrap">
                    {pct(Number(l.amount))}
                  </td>
                  <td className="border border-border p-2 break-words">
                    {l.note ?? ""}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-200 font-bold">
                <td
                  className="border border-border p-2 text-right whitespace-nowrap"
                  colSpan={5}
                >
                  세부 내역 합계
                </td>
                <td className="border border-border p-2 text-right whitespace-nowrap">
                  {fmtMoney(grand)}
                </td>
                <td className="border border-border p-2 text-right whitespace-nowrap">
                  {pct(grand)}
                </td>
                <td className="border border-border p-2"></td>
              </tr>
            </tbody>
          </table>
        )}

        {/* 인건비 — 기존/신규 인력별 입력 */}
        {plan.personnel && plan.personnel.length > 0 && (() => {
          const existing = plan.personnel.filter(
            (p) => p.segment === "EXISTING",
          );
          const newcomers = plan.personnel.filter(
            (p) => p.segment === "NEW",
          );
          const sumOf = (arr: Personnel[]) =>
            arr.reduce((s, p) => s + calcPersonnelAmount(p), 0);
          const existingTotal = sumOf(existing);
          const newcomerTotal = sumOf(newcomers);
          const personnelGrand = existingTotal + newcomerTotal;

          const renderTbl = (
            title: string,
            rows: Personnel[],
            subtotal: number,
            isExisting: boolean,
          ) => (
            <div className="mt-4">
              <div className="font-semibold mb-1">
                {title}
                <span className="ml-2 text-muted-foreground font-normal text-sm">
                  ({rows.length} 명 · {fmtMoney(subtotal)}원)
                </span>
              </div>
              {rows.length === 0 ? (
                <div className="text-muted-foreground p-3 border border-border rounded-md text-sm">
                  등록된 인력 없음
                </div>
              ) : (
                <table className="w-full border border-border text-sm tabular-nums">
                  <colgroup>
                    <col style={{ width: "120px" }} />
                    <col style={{ width: "100px" }} />
                    <col style={{ width: "100px" }} />
                    <col style={{ width: "90px" }} />
                    <col style={{ width: "100px" }} />
                    <col style={{ width: "60px" }} />
                    <col style={{ width: "60px" }} />
                    <col />
                  </colgroup>
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="border border-border p-2 text-left">
                        이름
                      </th>
                      <th className="border border-border p-2 text-left">
                        {isExisting ? "직급/직책" : "신규인력"}
                      </th>
                      <th className="border border-border p-2 text-right">
                        월 급여
                      </th>
                      <th className="border border-border p-2 text-right">
                        월 4대보험
                      </th>
                      <th className="border border-border p-2 text-right">
                        연간 퇴직금
                      </th>
                      <th className="border border-border p-2 text-right">
                        개월
                      </th>
                      <th className="border border-border p-2 text-right">
                        투입율
                      </th>
                      <th className="border border-border p-2 text-right">
                        합계
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p, i) => (
                      <tr key={p.id ?? `n:${i}`}>
                        <td className="border border-border p-2 break-words">
                          {p.name}
                        </td>
                        <td className="border border-border p-2 break-words">
                          {p.role ?? ""}
                        </td>
                        <td className="border border-border p-2 text-right whitespace-nowrap">
                          {fmtMoney(Number(p.monthly_salary))}
                        </td>
                        <td className="border border-border p-2 text-right whitespace-nowrap">
                          {fmtMoney(Number(p.monthly_insurance))}
                        </td>
                        <td className="border border-border p-2 text-right whitespace-nowrap">
                          {fmtMoney(Number(p.severance_annual))}
                        </td>
                        <td className="border border-border p-2 text-right whitespace-nowrap">
                          {Number(p.months)}
                        </td>
                        <td className="border border-border p-2 text-right whitespace-nowrap">
                          {Number(p.ratio_pct)}%
                        </td>
                        <td className="border border-border p-2 text-right whitespace-nowrap font-semibold">
                          {fmtMoney(calcPersonnelAmount(p))}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-100 font-bold">
                      <td
                        className="border border-border p-2 text-right"
                        colSpan={7}
                      >
                        소계
                      </td>
                      <td className="border border-border p-2 text-right whitespace-nowrap">
                        {fmtMoney(subtotal)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          );

          return (
            <div className="mt-6">
              <h2 className="text-lg font-semibold mb-1">인건비</h2>
              <div className="text-sm text-muted-foreground mb-2">
                전체 합계 <b className="text-foreground tabular-nums">
                  {fmtMoney(personnelGrand)}원
                </b>
              </div>
              {renderTbl(
                "기존 인력 (이미 정규직)",
                existing,
                existingTotal,
                true,
              )}
              {renderTbl(
                "신규 인력 (입사 6개월 이내 또는 미입사)",
                newcomers,
                newcomerTotal,
                false,
              )}
            </div>
          );
        })()}

        <div className="mt-8 text-xs text-muted-foreground">
          출력일: {new Date().toLocaleString("ko-KR")}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="border border-border bg-slate-50 p-2 w-40 font-semibold">
        {label}
      </td>
      <td className="border border-border p-2">{value}</td>
    </tr>
  );
}
