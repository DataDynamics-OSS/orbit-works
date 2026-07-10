"use client";

/**
 * 운영 예산 계획 — 사이드바 > 예산 > 예산 계산.
 *
 * 연도별 12개월 지출 예산. account_codes (EXPENSE) 비목별로 라인 입력,
 * 월별 m1~m12 그리드. 비목 카테고리별 소계, 총합, 작년 비교, 도넛 차트.
 *
 * - 단위: 원 (DB 저장 원, 그리드 표시 원).
 * - 라인 저장은 일괄 치환 (Grid 패턴).
 * - 권한: ADMIN/HR.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import dynamic from "next/dynamic";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

const HighchartsReact = dynamic(
  () => import("highcharts-react-official").then((m) => m.default),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccountCode = {
  id: string;
  kind: "INCOME" | "EXPENSE";
  category: string;
  name: string;
  account_code: string | null;
  is_active: boolean;
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

type Plan = {
  id: string;
  year: number;
  title: string;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

type PlanDetail = Plan & { lines: Line[] };

type GridRow = Line & {
  _key: string;
  _kind: "DATA" | "CAT" | "TOTAL";
  category_label?: string;
  m_total: number;
};

const MONTH_LABELS = [
  "1월", "2월", "3월", "4월", "5월", "6월",
  "7월", "8월", "9월", "10월", "11월", "12월",
];

const fmtMoney = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString("ko-KR") : "-";

// 모든 금액 — 소숫점 버리고 원단위 반올림 (10원 단위).
const roundWon = (n: number) =>
  Number.isFinite(n) ? Math.round(n / 10) * 10 : 0;

const lineTotal = (l: Line): number =>
  Number(l.m1 || 0) + Number(l.m2 || 0) + Number(l.m3 || 0) +
  Number(l.m4 || 0) + Number(l.m5 || 0) + Number(l.m6 || 0) +
  Number(l.m7 || 0) + Number(l.m8 || 0) + Number(l.m9 || 0) +
  Number(l.m10 || 0) + Number(l.m11 || 0) + Number(l.m12 || 0);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BudgetCalcPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [planId, setPlanId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<Plan | null>(null);

  const { data: plans = [] } = useQuery<Plan[]>({
    queryKey: ["budget-calc-plans"],
    queryFn: async () => (await api.get("/budget-calc")).data,
  });

  // 첫 진입 시 가장 최근 예산서 자동 선택
  useEffect(() => {
    if (planId == null && plans.length > 0) {
      setPlanId(plans[0].id);
    }
  }, [plans, planId]);

  return (
    <>
      <DashboardHeader title="예산 계산" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <select
            value={planId ?? ""}
            onChange={(e) => setPlanId(e.target.value || null)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm min-w-[280px]"
          >
            <option value="">— 예산서 선택 —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.year}] {p.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setDuplicateSource(null);
              setCreateOpen(true);
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-4 w-4" />
            새 예산서
          </button>
          <button
            type="button"
            disabled={!planId}
            onClick={() => {
              const sel = plans.find((p) => p.id === planId);
              if (!sel) return;
              setDuplicateSource(sel);
              setCreateOpen(true);
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
            title="현재 예산서 복제"
          >
            <Copy className="h-4 w-4" />
            예산서 복제
          </button>
          <button
            type="button"
            disabled={!planId}
            onClick={async () => {
              if (!planId) return;
              const sel = plans.find((p) => p.id === planId);
              if (!sel) return;
              const ok = await dialog.confirm(
                <>
                  <b>[{sel.year}] {sel.title}</b> 예산서를 삭제할까요?
                  <br />
                  입력된 모든 라인이 함께 삭제되며 되돌릴 수 없습니다.
                </>,
                { title: "예산서 삭제", confirmText: "삭제", destructive: true },
              );
              if (!ok) return;
              try {
                await api.delete(`/budget-calc/${planId}`);
                setPlanId(null);
                qc.invalidateQueries({ queryKey: ["budget-calc-plans"] });
              } catch (e: any) {
                await dialog.alert(e?.response?.data?.detail ?? "삭제 실패");
              }
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive bg-background px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            예산서 삭제
          </button>
          <button
            type="button"
            onClick={() => {
              if (!planId) return;
              window.open(
                `/budget-calc-preview/${planId}`,
                "_blank",
                "noopener,noreferrer,width=1300,height=900",
              );
            }}
            disabled={!planId}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            <FileText className="h-4 w-4" />
            미리보기
          </button>
        </div>

        {planId ? (
          <BudgetCalcEditor planId={planId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            예산서를 선택하거나 새로 만들어주세요.
          </div>
        )}
      </div>

      <CreatePlanDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setDuplicateSource(null);
        }}
        onCreated={(id) => {
          qc.invalidateQueries({ queryKey: ["budget-calc-plans"] });
          setPlanId(id);
          setCreateOpen(false);
          setDuplicateSource(null);
        }}
        source={duplicateSource}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Editor — 그리드 + 요약 + 차트
// ---------------------------------------------------------------------------

function BudgetCalcEditor({ planId }: { planId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: plan } = useQuery<PlanDetail>({
    queryKey: ["budget-calc-plan", planId],
    queryFn: async () => (await api.get(`/budget-calc/${planId}`)).data,
    enabled: !!planId,
  });

  // 작년 동일 연도 plan (있으면 비교)
  const lastYear = plan ? plan.year - 1 : null;
  const { data: lastYearPlans = [] } = useQuery<Plan[]>({
    queryKey: ["budget-calc-plans-year", lastYear],
    queryFn: async () =>
      (await api.get(`/budget-calc?year=${lastYear}`)).data,
    enabled: lastYear != null,
  });
  const { data: lastYearDetail } = useQuery<PlanDetail | null>({
    queryKey: ["budget-calc-plan-last", lastYearPlans[0]?.id],
    queryFn: async () =>
      lastYearPlans[0]
        ? (await api.get(`/budget-calc/${lastYearPlans[0].id}`)).data
        : null,
    enabled: !!lastYearPlans[0],
  });

  const { data: accountCodes = [] } = useQuery<AccountCode[]>({
    queryKey: ["account-codes", "EXPENSE"],
    queryFn: async () =>
      (await api.get("/account-codes?kind=EXPENSE")).data,
    staleTime: 60 * 60 * 1000,
  });

  const [dataLines, setDataLines] = useState<Line[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(true);
  const [bulkValue, setBulkValue] = useState<number>(0);

  useEffect(() => {
    if (plan) {
      setDataLines(
        plan.lines.map((l) => ({
          ...l,
          m1: Number(l.m1 ?? 0), m2: Number(l.m2 ?? 0),
          m3: Number(l.m3 ?? 0), m4: Number(l.m4 ?? 0),
          m5: Number(l.m5 ?? 0), m6: Number(l.m6 ?? 0),
          m7: Number(l.m7 ?? 0), m8: Number(l.m8 ?? 0),
          m9: Number(l.m9 ?? 0), m10: Number(l.m10 ?? 0),
          m11: Number(l.m11 ?? 0), m12: Number(l.m12 ?? 0),
        })),
      );
      setDirty(false);
    }
  }, [plan?.id, plan?.updated_at]);

  // account_code lookup
  const acById = useMemo(() => {
    const m = new Map<string, AccountCode>();
    accountCodes.forEach((a) => m.set(a.id, a));
    return m;
  }, [accountCodes]);

  // 카테고리별 소계 + 총합 그리드 행 생성
  const gridRows = useMemo<GridRow[]>(() => {
    const lines = dataLines.map((l) => ({
      ...l,
      _category: acById.get(l.account_code_id ?? "")?.category ?? "(미지정)",
    }));
    // 카테고리 첫 등장 sort_order 로 정렬
    const catKey = new Map<string, number>();
    for (const l of lines) {
      const k = l._category;
      const cur = catKey.get(k);
      if (cur === undefined || l.sort_order < cur) catKey.set(k, l.sort_order);
    }
    const sorted = [...lines].sort((a, b) => {
      const ca = catKey.get(a._category) ?? 0;
      const cb = catKey.get(b._category) ?? 0;
      if (ca !== cb) return ca - cb;
      return a.sort_order - b.sort_order;
    });

    const out: GridRow[] = [];
    let curCat = "";
    let catSums = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let grandSums = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const flushCat = () => {
      if (!curCat) return;
      out.push({
        _key: `cat:${curCat}`,
        _kind: "CAT",
        account_code_id: null,
        item_label: null,
        category_label: curCat,
        m1: catSums[0], m2: catSums[1], m3: catSums[2], m4: catSums[3],
        m5: catSums[4], m6: catSums[5], m7: catSums[6], m8: catSums[7],
        m9: catSums[8], m10: catSums[9], m11: catSums[10], m12: catSums[11],
        note: null,
        sort_order: 0,
        m_total: catSums.reduce((s, v) => s + v, 0),
      });
      catSums = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    };
    for (const l of sorted) {
      if (l._category !== curCat) {
        flushCat();
        curCat = l._category;
      }
      const months = [
        l.m1, l.m2, l.m3, l.m4, l.m5, l.m6,
        l.m7, l.m8, l.m9, l.m10, l.m11, l.m12,
      ];
      for (let i = 0; i < 12; i++) {
        const v = Number(months[i] || 0);
        catSums[i] += v;
        grandSums[i] += v;
      }
      out.push({
        ...l,
        _key: l.id ?? `n:${l.sort_order}`,
        _kind: "DATA",
        category_label: l._category,
        m_total: months.reduce((s, v) => s + (Number(v) || 0), 0),
      });
    }
    flushCat();
    if (sorted.length > 0) {
      out.push({
        _key: "total",
        _kind: "TOTAL",
        account_code_id: null,
        item_label: null,
        m1: grandSums[0], m2: grandSums[1], m3: grandSums[2], m4: grandSums[3],
        m5: grandSums[4], m6: grandSums[5], m7: grandSums[6], m8: grandSums[7],
        m9: grandSums[8], m10: grandSums[9], m11: grandSums[10], m12: grandSums[11],
        note: null,
        sort_order: 0,
        m_total: grandSums.reduce((s, v) => s + v, 0),
      });
    }
    return out;
  }, [dataLines, acById]);

  const grandTotal = useMemo(
    () => dataLines.reduce((s, l) => s + lineTotal(l), 0),
    [dataLines],
  );
  const monthlyAvg = grandTotal / 12;
  const lastYearTotal = useMemo(
    () =>
      lastYearDetail
        ? lastYearDetail.lines.reduce((s, l) => s + lineTotal(l), 0)
        : 0,
    [lastYearDetail],
  );

  // 카테고리별 합계 (도넛 차트 + 비교)
  const catTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of dataLines) {
      const cat = acById.get(l.account_code_id ?? "")?.category ?? "(미지정)";
      m.set(cat, (m.get(cat) ?? 0) + lineTotal(l));
    }
    return [...m.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [dataLines, acById]);

  // ── 셀 편집 핸들러
  function onCellValueChanged(e: any) {
    if (e.data?._kind !== "DATA") return;
    const id = e.data._key;
    const field = e.colDef?.field as keyof Line;
    if (!field) return;
    setDataLines((cur) =>
      cur.map((l) => {
        if ((l.id ?? `n:${l.sort_order}`) !== id) return l;
        let v: any = e.newValue;
        if (typeof v === "string" && (field === "item_label" || field === "note")) {
          v = v.trim() || null;
        }
        return { ...l, [field]: v };
      }),
    );
    setDirty(true);
  }

  function addRow() {
    setDataLines((cur) => {
      // 새 행을 그리드 최상단에 두기 위해 sort_order 를 기존 최소값 - 1 로.
      // (그리드 정렬이 카테고리별 first-occurrence sort_order → 가장 작은 값이 최상)
      const minOrder = cur.length
        ? Math.min(...cur.map((l) => l.sort_order))
        : 0;
      return [
        {
          account_code_id: null,
          item_label: null,
          m1: 0, m2: 0, m3: 0, m4: 0, m5: 0, m6: 0,
          m7: 0, m8: 0, m9: 0, m10: 0, m11: 0, m12: 0,
          note: null,
          sort_order: minOrder - 1,
        },
        ...cur,
      ];
    });
    setDirty(true);
  }

  function deleteSelected() {
    if (!selectedRowKey) return;
    setDataLines((cur) =>
      cur.filter((l) => (l.id ?? `n:${l.sort_order}`) !== selectedRowKey),
    );
    setSelectedRowKey(null);
    setDirty(true);
  }

  function bulkFillSelected() {
    if (!selectedRowKey) return;
    const v = roundWon(bulkValue);
    setDataLines((cur) =>
      cur.map((l) => {
        if ((l.id ?? `n:${l.sort_order}`) !== selectedRowKey) return l;
        return {
          ...l,
          m1: v, m2: v, m3: v, m4: v, m5: v, m6: v,
          m7: v, m8: v, m9: v, m10: v, m11: v, m12: v,
        };
      }),
    );
    setDirty(true);
  }

  // ── 비목 변경 (별도 핸들러 — select)
  function onAccountCodeChange(rowKey: string, accountCodeId: string) {
    setDataLines((cur) =>
      cur.map((l) => {
        if ((l.id ?? `n:${l.sort_order}`) !== rowKey) return l;
        return { ...l, account_code_id: accountCodeId || null };
      }),
    );
    setDirty(true);
  }

  // ── 저장
  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        lines: dataLines.map((l, idx) => ({
          account_code_id: l.account_code_id,
          item_label: l.item_label,
          m1: l.m1, m2: l.m2, m3: l.m3, m4: l.m4,
          m5: l.m5, m6: l.m6, m7: l.m7, m8: l.m8,
          m9: l.m9, m10: l.m10, m11: l.m11, m12: l.m12,
          note: l.note,
          sort_order: idx,
        })),
      };
      return (await api.put(`/budget-calc/${planId}/lines`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budget-calc-plan", planId] });
      qc.invalidateQueries({ queryKey: ["budget-calc-plans"] });
      setDirty(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  // ── ColDef
  const cellStyleFor = (kind: GridRow["_kind"] | undefined): any => {
    if (!kind || kind === "DATA") return {};
    if (kind === "CAT")
      return {
        backgroundColor: "#e2e8f0",
        fontWeight: 700,
        color: "#0f172a",
      };
    if (kind === "TOTAL")
      return {
        backgroundColor: "#0f172a",
        color: "#fff",
        fontWeight: 700,
      };
    return {};
  };

  const monthCols: ColDef<GridRow>[] = MONTH_LABELS.map((label, i) => {
    const field = `m${i + 1}` as keyof Line;
    return {
      field: field as any,
      headerName: label,
      width: 80,
      flex: 0,
      sortable: false,
      filter: false,
      editable: (p: any) => p.data?._kind === "DATA",
      valueFormatter: (p: any) =>
        p.value == null ? "" : fmtMoney(Number(p.value)),
      valueParser: (p: any) => {
        const n = Number(String(p.newValue ?? "").replace(/,/g, ""));
        return Number.isFinite(n) ? roundWon(n) : 0;
      },
      cellStyle: (p: any) => ({
        ...cellStyleFor(p.data?._kind),
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      } as any),
      cellEditor: "agNumberCellEditor",
    };
  });

  const columnDefs: ColDef<GridRow>[] = [
    {
      field: "category_label",
      headerName: "비목",
      width: 130,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      valueFormatter: (p) => (p.data?._kind === "TOTAL" ? "합계" : p.value ?? ""),
      cellStyle: (p) => cellStyleFor(p.data?._kind),
    },
    {
      field: "account_code_id",
      headerName: "항목",
      width: 200,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      cellRenderer: (p: any) => {
        if (p.data?._kind === "CAT") return "비목 합계";
        if (p.data?._kind === "TOTAL") return "";
        return (
          <SearchableAccountSelect
            value={p.data?.account_code_id ?? null}
            options={accountCodes.filter((a) => a.is_active !== false)}
            onChange={(id) => onAccountCodeChange(p.data._key, id)}
          />
        );
      },
      cellStyle: (p) => cellStyleFor(p.data?._kind),
    },
    {
      field: "item_label",
      headerName: "라벨",
      width: 140,
      flex: 0,
      sortable: false,
      filter: false,
      editable: (p) => p.data?._kind === "DATA",
      valueFormatter: (p) =>
        p.data?._kind !== "DATA" ? "" : (p.value ?? ""),
      cellEditor: "agTextCellEditor",
      cellStyle: (p) => cellStyleFor(p.data?._kind),
    },
    ...monthCols,
    {
      field: "m_total",
      headerName: "합계",
      width: 110,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      valueFormatter: (p) => fmtMoney(Number(p.value)),
      cellStyle: (p) => ({
        ...cellStyleFor(p.data?._kind),
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        fontWeight: 600,
      } as any),
    },
  ];

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-auto">
      {/* 요약 */}
      <section className="rounded-md border border-border bg-card text-sm">
        <div className="px-3 py-2 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setSummaryExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {summaryExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <span className="font-semibold text-foreground">요약</span>
          </button>
          <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
            <span>
              <span className="text-muted-foreground">총 연간 지출</span>{" "}
              <b>{fmtMoney(grandTotal)}원</b>
            </span>
            <span>
              <span className="text-muted-foreground">월평균</span>{" "}
              <b>{fmtMoney(monthlyAvg)}원</b>
            </span>
            <span>
              <span className="text-muted-foreground">라인</span>{" "}
              <b>{dataLines.length}건</b>
            </span>
            {lastYearTotal > 0 && (
              <span
                className={
                  grandTotal > lastYearTotal
                    ? "text-rose-600"
                    : grandTotal < lastYearTotal
                      ? "text-emerald-700"
                      : "text-muted-foreground"
                }
              >
                <span className="text-muted-foreground">
                  vs {lastYear}
                </span>{" "}
                <b>
                  {grandTotal >= lastYearTotal ? "+" : ""}
                  {fmtMoney(grandTotal - lastYearTotal)}원
                </b>{" "}
                <span className="text-[11px]">
                  ({lastYearTotal > 0
                    ? `${((grandTotal / lastYearTotal - 1) * 100).toFixed(1)}%`
                    : "—"})
                </span>
              </span>
            )}
          </span>
        </div>
        {summaryExpanded && catTotals.length > 0 && (
          <div className="border-t border-border p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <CategoryDonut catTotals={catTotals} grand={grandTotal} />
            <CategoryTable
              catTotals={catTotals}
              grand={grandTotal}
              lastYearDetail={lastYearDetail}
              acById={acById}
            />
          </div>
        )}
      </section>

      {/* 툴바 */}
      <div className="flex items-center gap-2 text-sm shrink-0">
        <button
          type="button"
          onClick={addRow}
          className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 hover:bg-muted"
        >
          <Plus className="h-4 w-4" />행 추가
        </button>
        <button
          type="button"
          onClick={deleteSelected}
          disabled={!selectedRowKey}
          className="h-9 inline-flex items-center gap-1 rounded-md border border-border px-3 text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />선택 삭제
        </button>
        <span className="ml-2 inline-flex items-center gap-1">
          <span className="text-muted-foreground text-xs">선택 행 12개월 채우기</span>
          <input
            type="number"
            value={bulkValue || ""}
            onChange={(e) => setBulkValue(Number(e.target.value) || 0)}
            placeholder="0"
            className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm text-right tabular-nums"
          />
          <span className="text-muted-foreground text-xs">원</span>
          <button
            type="button"
            onClick={bulkFillSelected}
            disabled={!selectedRowKey || bulkValue === 0}
            className="h-9 px-3 rounded-md border border-border bg-background text-sm hover:bg-muted disabled:opacity-50"
          >
            적용
          </button>
        </span>
        <span className="text-xs text-muted-foreground">(단위: 원)</span>
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={!dirty || saveM.isPending}
          className="ml-auto h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saveM.isPending ? "저장 중..." : dirty ? "저장" : "저장됨"}
        </button>
      </div>

      <DataGrid<GridRow>
        rowData={gridRows}
        columnDefs={columnDefs}
        getRowId={(r) => r._key}
        pagination={false}
        autoHeight
        onRowClicked={(r) => setSelectedRowKey(r._key)}
        onCellValueChanged={onCellValueChanged}
        enableCheckbox={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 도넛 차트 (Highcharts)
// ---------------------------------------------------------------------------

function CategoryDonut({
  catTotals,
  grand,
}: {
  catTotals: [string, number][];
  grand: number;
}) {
  const [Highcharts, setHC] = useState<any>(null);
  useEffect(() => {
    import("@/lib/highcharts-init").then((m) => setHC(m.default));
  }, []);
  if (!Highcharts) return <div className="text-muted-foreground">차트 로딩…</div>;

  const options = {
    chart: { type: "pie", height: 280, backgroundColor: "transparent" },
    title: { text: "" },
    credits: { enabled: false },
    tooltip: {
      pointFormatter() {
        // @ts-ignore
        const v = (this as any).y as number;
        const pct = grand > 0 ? ((v / grand) * 100).toFixed(1) : "0";
        return `<b>${fmtMoney(v)}원</b> (${pct}%)`;
      },
    },
    plotOptions: {
      pie: {
        innerSize: "55%",
        dataLabels: {
          enabled: true,
          format: "{point.name}: {point.percentage:.1f}%",
          style: { fontSize: "11px" },
        },
      },
    },
    series: [
      {
        type: "pie",
        name: "비목",
        data: catTotals.map(([name, value]) => ({ name, y: value })),
      },
    ],
  };
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}

// ---------------------------------------------------------------------------
// 카테고리별 표 — 작년 비교 포함
// ---------------------------------------------------------------------------

function CategoryTable({
  catTotals,
  grand,
  lastYearDetail,
  acById,
}: {
  catTotals: [string, number][];
  grand: number;
  lastYearDetail: PlanDetail | null | undefined;
  acById: Map<string, AccountCode>;
}) {
  const lastByCategory = useMemo(() => {
    const m = new Map<string, number>();
    if (!lastYearDetail) return m;
    for (const l of lastYearDetail.lines) {
      const cat = acById.get(l.account_code_id ?? "")?.category ?? "(미지정)";
      m.set(cat, (m.get(cat) ?? 0) + lineTotal(l));
    }
    return m;
  }, [lastYearDetail, acById]);

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm tabular-nums">
        <thead className="bg-slate-100">
          <tr>
            <th className="text-left p-2 font-normal">비목</th>
            <th className="text-right p-2 font-normal w-32">금액</th>
            <th className="text-right p-2 font-normal w-16">%</th>
            {lastYearDetail && (
              <th className="text-right p-2 font-normal w-24">vs 작년</th>
            )}
          </tr>
        </thead>
        <tbody>
          {catTotals.map(([cat, v]) => {
            const last = lastByCategory.get(cat) ?? 0;
            const diff = v - last;
            const pct = grand > 0 ? (v / grand) * 100 : 0;
            return (
              <tr key={cat} className="border-b border-border/50">
                <td className="p-2">{cat}</td>
                <td className="text-right p-2">{fmtMoney(v)}원</td>
                <td className="text-right p-2">{pct.toFixed(1)}%</td>
                {lastYearDetail && (
                  <td
                    className={
                      "text-right p-2 " +
                      (diff > 0
                        ? "text-rose-600"
                        : diff < 0
                          ? "text-emerald-700"
                          : "text-muted-foreground")
                    }
                  >
                    {diff > 0 ? "+" : ""}
                    {fmtMoney(diff)}
                  </td>
                )}
              </tr>
            );
          })}
          <tr className="border-t-2 border-border font-semibold">
            <td className="p-2">합계</td>
            <td className="text-right p-2">{fmtMoney(grand)}원</td>
            <td className="text-right p-2">100.0%</td>
            {lastYearDetail && <td></td>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 새/복제 다이얼로그
// ---------------------------------------------------------------------------

function CreatePlanDialog({
  open,
  onClose,
  onCreated,
  source,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  source?: Plan | null;
}) {
  const dialog = useDialog();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(thisYear);
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");

  useEffect(() => {
    if (!open) return;
    if (source) {
      setYear(source.year);
      setTitle(`${source.title} (복사본)`.slice(0, 200));
      setMemo(source.memo ?? "");
    } else {
      setYear(thisYear);
      setTitle("");
      setMemo("");
    }
  }, [open, thisYear, source?.id]);

  const isDuplicate = !!source;

  const createM = useMutation({
    mutationFn: async () => {
      const payload = {
        year,
        title: title.trim(),
        memo: memo.trim() || null,
      };
      if (isDuplicate && source) {
        return (await api.post(`/budget-calc/${source.id}/duplicate`, payload))
          .data as Plan;
      }
      return (await api.post("/budget-calc", payload)).data as Plan;
    },
    onSuccess: (p) => onCreated(p.id),
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isDuplicate ? "예산서 복제" : "새 예산서"}
      width="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => createM.mutate()}
            disabled={!title.trim() || createM.isPending}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {createM.isPending
              ? "저장 중..."
              : isDuplicate
                ? "복제 생성"
                : "생성"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-muted-foreground">연도</span>
          <input
            type="number"
            min={2020}
            max={2100}
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || thisYear)}
            className={input}
          />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">제목 *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="2026 운영 예산"
            className={input}
          />
        </label>
        <label className="block">
          <span className="text-sm text-muted-foreground">메모</span>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={3}
            className={input}
          />
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Searchable Account Select — 검색 가능한 비목 picker.
//   AG Grid 셀 안에서 작동하도록 dropdown 은 Portal 로 body 에 렌더 (overflow 클립 회피).
//   - 빈 input 은 전체 목록, 글자 입력 시 비목명/카테고리 부분일치 필터.
//   - 클릭 또는 Esc 로 닫힘.
// ---------------------------------------------------------------------------

function SearchableAccountSelect({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: AccountCode[];
  onChange: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.category.toLowerCase().includes(q),
    );
  }, [query, options]);

  // 입력 위치 계산 (열린 동안 스크롤·리사이즈 추적)
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords({ top: r.bottom + 2, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // 외부 클릭 / Esc 닫기
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (
        inputRef.current &&
        !inputRef.current.contains(tgt) &&
        !(tgt instanceof HTMLElement && tgt.closest("[data-acsel-popup]"))
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const display = open
    ? query
    : selected
      ? `[${selected.category}] ${selected.name}`
      : "";

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        value={display}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="비목 검색 / 선택"
        className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
      />
      {open &&
        coords &&
        createPortal(
          <div
            data-acsel-popup
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              width: Math.max(coords.width, 280),
              zIndex: 1000,
            }}
            className="max-h-72 overflow-auto rounded-md border border-input bg-background shadow-lg text-xs"
          >
            {filtered.length === 0 ? (
              <div className="p-2 text-muted-foreground">결과 없음</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                    setQuery("");
                    inputRef.current?.blur();
                  }}
                  className={
                    "block w-full text-left px-2 py-1.5 hover:bg-muted " +
                    (o.id === value ? "bg-blue-50 font-semibold" : "")
                  }
                >
                  <span className="text-muted-foreground">[{o.category}]</span>{" "}
                  {o.name}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
