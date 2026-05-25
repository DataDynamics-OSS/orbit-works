"use client";

/**
 * 정부 R&D 예산 — 사이드바 > 예산 > 정부 R&D.
 *
 * 탭:
 * 1. 예산 산정 — 연도·프로젝트별 예산서 선택 + Grid 입력 (비목/세목/항목/단가/건수/합계)
 *               + 비목/세목별 회색 소계 행 + 우측 산정기준 패널
 * 2. 정산 서류 — rnd_settlement_docs_list_seed.json 표 렌더 (read-only)
 * 3. 불인정 기준 — rnd_disallowed_expenses_criteria_seed.json 표 (read-only)
 *
 * 권한: ADMIN/HR.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
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
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { TabBar, TabItem } from "@/components/ui/TabBar";

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

type CriteriaItem = {
  id: string;
  label: string;
  examples?: string[];
  note?: string;
  referenceTables?: Array<{
    id: string;
    label: string;
    rows: Array<Record<string, string>>;
  }>;
};
type CriteriaSubcategory = {
  id: string;
  label: string;
  applicableTargets?: string[];
  calculationFormulas?: Array<{
    id: string;
    condition: string;
    formula: string;
    items?: string[];
    note?: string;
  }>;
  calculationCriteria?: string[];
  exceptions?: string[];
  items?: CriteriaItem[];
};
type CriteriaCategory = {
  id: string;
  label: string;
  subcategories: CriteriaSubcategory[];
};
type StandardCriteria = {
  title: string;
  관련근거?: string;
  기준문서?: string;
  작성일?: string;
  categories: CriteriaCategory[];
};

type SettlementDoc = { id: string; title: string; note?: string };
type SettlementSubcategory = {
  id: string;
  label: string;
  documents: SettlementDoc[];
  sharesDocumentsWith?: string;
};
type SettlementCategory = {
  id: string;
  label: string;
  subcategories: SettlementSubcategory[];
};
type SettlementData = {
  title: string;
  categories: SettlementCategory[];
};

type DisallowedCase = {
  id: string;
  title: string;
  description?: string;
  note?: string;
};
type DisallowedSubcategory = {
  id: string;
  label: string;
  cases: DisallowedCase[];
};
// common 은 cases 직접, categories 는 subcategories[].cases 로 중첩.
type DisallowedCommon = {
  id: string;
  label: string;
  description?: string;
  cases: DisallowedCase[];
};
type DisallowedCategory = {
  id: string;
  label: string;
  description?: string;
  subcategories: DisallowedSubcategory[];
};
type DisallowedData = {
  title: string;
  common?: DisallowedCommon;
  categories?: DisallowedCategory[];
};

type Line = {
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

type GridRow = Line & {
  _key: string;
  _kind: "DATA" | "CAT" | "TOTAL";
  // CAT/TOTAL 에서 "전체 사업비 대비 비율" — null = 분모(총 연구개발비)가 0
  _pct?: number | null;
};

type PersonnelSegment = "EXISTING" | "NEW";
type Personnel = {
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

type CompanySize = "SMALL" | "MID" | "LARGE";
type Plan = {
  id: string;
  year: number;
  title: string;
  project_id: string | null;
  customer_id: string | null;
  funding_agency: string | null;
  memo: string | null;
  status: "DRAFT" | "SUBMITTED" | "APPROVED";
  total_amount: number;
  // 예산 요약
  company_size: CompanySize | null;
  total_rnd_budget: number | null;
  gov_funding_amount: number | null;
  own_cash_amount: number | null;
  own_inkind_amount: number | null;
  // 비율 사용자 정의 (null = 기업규모 default)
  gov_funding_rate: number | null;
  own_burden_rate: number | null;
  cash_min_rate: number | null;
  inkind_min_rate: number | null;
  project_name: string | null;
  customer_name: string | null;
  line_count: number;
  created_at: string;
  updated_at: string;
};
type PlanDetail = Plan & { lines: Line[]; personnel?: Personnel[] };

const COMPANY_SIZE: Record<
  CompanySize,
  { label: string; govMax: number; ownMin: number; cashMinWithinOwn: number }
> = {
  SMALL: { label: "중소기업", govMax: 0.75, ownMin: 0.25, cashMinWithinOwn: 0.10 },
  MID:   { label: "중견기업", govMax: 0.70, ownMin: 0.30, cashMinWithinOwn: 0.13 },
  LARGE: { label: "대기업",   govMax: 0.50, ownMin: 0.50, cashMinWithinOwn: 0.15 },
};

type ProjectLite = { id: string; name: string };
type CustomerLite = { id: string; name: string };

// 자유 입력 세목용 — 어떤 항목명을 써야 하는지 placeholder 로 안내.
// 시드 JSON 의 applicableTargets / calculationCriteria 에서 추출한 대표 예시.
// 사용자가 직접 입력하므로 이 목록은 안내일 뿐 — 자유롭게 다른 이름 가능.
const FREE_INPUT_EXAMPLES: Record<string, string[]> = {
  "personnel-salary": ["김XX 인건비", "성과상여금", "연가보상비", "4대보험"],
  "personnel-regular-wage": ["계약직 김XX 인건비", "전문계약직 인건비", "4대보험"],
  "personnel-daily-wage": ["강사료", "위촉직원", "아르바이트"],
  "personnel-research-allowance": [
    "참여연구원 김XX 연구수당",
    "참여연구원 이XX 연구수당",
    "성과 우수자 인센티브",
  ],
  "operation-overtime-meal": ["야근 식대", "휴일근무 매식비"],
  "operation-material": ["시약", "시료", "시제품 재료", "데이터셋"],
  "operation-fuel": ["업무용 차량 주유비", "차량 정비비", "차량 소모품"],
  "operation-welfare": ["동호회 지원", "의약품", "명절선물", "생일기념품"],
  "operation-general-service": ["행사 대행", "채용 대행", "구매 대행", "정보시스템 공사"],
  "operation-management-service": ["시설관리 위탁", "장비유지보수", "전산운영 위탁"],
  "operation-etc": ["다과비", "간담회", "회의 운영비"],
  "travel-domestic": ["철도료", "항공료", "자동차임차료", "숙박료", "식비", "일비"],
  "travel-overseas": ["항공료", "숙박료", "식비", "일비", "비자 발급비"],
  "business-promotion-project": ["사업 운영 회의비", "협의회 비용", "부서 추진 행사"],
  "research-service-general": ["외부 연구기관 위탁", "공동연구 분담금"],
  "tangible-asset-acquisition": ["PC·노트북", "서버", "시험장비", "측정기"],
  "private-transfer-grant": ["민간단체 보조금", "협회 운영 지원"],
  "private-transfer-entrustment": ["민간 위탁사업 운영비"],
  "private-transfer-capital": ["민간 자산 취득 보조금"],
};

const fmtMoney = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString("ko-KR") : "-";

// 모든 금액 — 소숫점 버리고 원단위(=10원 단위) 반올림.
const roundWon = (n: number) =>
  Number.isFinite(n) ? Math.round(n / 10) * 10 : 0;

// 인력 1명의 투입 금액 = ((월급여+월보험)×12 + 퇴직금) / 12 × 개월 × 비율%
const calcPersonnelAmount = (p: Personnel): number => {
  const annual =
    (Number(p.monthly_salary) + Number(p.monthly_insurance)) * 12 +
    Number(p.severance_annual);
  const months = Number(p.months) || 0;
  const ratio = Number(p.ratio_pct) || 0;
  return roundWon((annual * months * ratio) / (12 * 100));
};

// 백엔드 컬럼 한도 (원 단위). DB Numeric(p, s) 의 p-s 자릿수 기준.
const RND_LIMITS = {
  unit_price: 9_999_999_999.99,   // Numeric(12, 2) — ≈ 100억원
  quantity:        99_999_999.99, // Numeric(10, 2) — ≈ 1억건
  amount:    999_999_999_999.99,  // Numeric(14, 2) — ≈ 1조원
} as const;

const overflowCellStyle = (value: unknown, limit: number) =>
  Math.abs(Number(value) || 0) > limit
    ? {
        boxShadow: "inset 0 0 0 2px #f43f5e",
        backgroundColor: "#fff1f2",
        color: "#be123c",
      }
    : {};

// ---------------------------------------------------------------------------
// 메인 페이지
// ---------------------------------------------------------------------------

type Tab = "budget" | "settlement" | "disallowed";

export default function RndBudgetPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("budget");
  const [planId, setPlanId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<Plan | null>(null);

  // ── 기준 (3개 read-only)
  const { data: standard } = useQuery<StandardCriteria>({
    queryKey: ["rnd-criteria", "standard"],
    queryFn: async () =>
      (await api.get("/rnd-budgets/criteria/standard")).data,
    staleTime: 60 * 60 * 1000,
  });
  const { data: settlement } = useQuery<SettlementData>({
    queryKey: ["rnd-criteria", "settlement"],
    queryFn: async () =>
      (await api.get("/rnd-budgets/criteria/settlement-docs")).data,
    staleTime: 60 * 60 * 1000,
  });
  const { data: disallowed } = useQuery<DisallowedData>({
    queryKey: ["rnd-criteria", "disallowed"],
    queryFn: async () =>
      (await api.get("/rnd-budgets/criteria/disallowed")).data,
    staleTime: 60 * 60 * 1000,
  });

  // ── 예산서 목록
  const { data: plans = [] } = useQuery<Plan[]>({
    queryKey: ["rnd-budgets"],
    queryFn: async () => (await api.get("/rnd-budgets")).data,
  });

  // 첫 진입 시 가장 최근 예산서 자동 선택
  useEffect(() => {
    if (planId == null && plans.length > 0) {
      setPlanId(plans[0].id);
    }
  }, [plans, planId]);

  return (
    <>
      <DashboardHeader title="정부 R&D 예산" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        {/* 상단 — 예산서 picker + 메타 */}
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
                {p.project_name ? ` · ${p.project_name}` : ""}
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
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            title="현재 예산서 복제 (기본 정보 입력)"
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
                  <b>
                    [{sel.year}] {sel.title}
                  </b>{" "}
                  예산서를 삭제할까요?
                  <br />
                  입력된 모든 라인이 함께 삭제되며 되돌릴 수 없습니다.
                </>,
                { confirmText: "삭제", title: "예산서 삭제", destructive: true },
              );
              if (!ok) return;
              try {
                await api.delete(`/rnd-budgets/${planId}`);
                setPlanId(null);
                qc.invalidateQueries({ queryKey: ["rnd-budgets"] });
              } catch (e: any) {
                await dialog.alert(
                  e?.response?.data?.detail ?? "삭제 실패",
                );
              }
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive bg-background px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
            title="현재 예산서 삭제"
          >
            <Trash2 className="h-4 w-4" />
            예산서 삭제
          </button>
        </div>

        {/* 탭 */}
        <TabBar className="shrink-0">
          {(
            [
              ["budget", "예산 산정"],
              ["settlement", "정산 서류"],
              ["disallowed", "불인정 기준"],
            ] as const
          ).map(([k, label]) => (
            <TabItem key={k} active={tab === k} onClick={() => setTab(k)}>
              {label}
            </TabItem>
          ))}
        </TabBar>

        <div className="flex-1 min-h-0">
          {tab === "budget" && (
            <BudgetTab
              planId={planId}
              setPlanId={setPlanId}
              standard={standard}
            />
          )}
          {tab === "settlement" && <SettlementTab data={settlement} />}
          {tab === "disallowed" && <DisallowedTab data={disallowed} />}
        </div>
      </div>

      <CreatePlanDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setDuplicateSource(null);
        }}
        onCreated={(id) => {
          qc.invalidateQueries({ queryKey: ["rnd-budgets"] });
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
// Tab 1: 예산 산정
// ---------------------------------------------------------------------------

function BudgetTab({
  planId,
  setPlanId,
  standard,
}: {
  planId: string | null;
  setPlanId: (id: string | null) => void;
  standard: StandardCriteria | undefined;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: plan } = useQuery<PlanDetail>({
    queryKey: ["rnd-budget", planId],
    queryFn: async () => (await api.get(`/rnd-budgets/${planId}`)).data,
    enabled: !!planId,
  });

  // 로컬 편집 state — 서버 라인을 가져온 뒤 여기에 보관
  const [dataLines, setDataLines] = useState<Line[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [addRowOpen, setAddRowOpen] = useState(false);
  const [sideTab, setSideTab] = useState<"criteria" | "breakdown">("criteria");
  // 메인 뷰 — 세부 내역 그리드 / 인건비 인력 (서브 탭)
  const [mainView, setMainView] = useState<"detail" | "personnel">("detail");
  // 인건비 인력 — 보수 행 합계와 매칭하기 위한 인력별 입력
  const [personnelData, setPersonnelData] = useState<Personnel[]>([]);
  const [personnelDirty, setPersonnelDirty] = useState(false);

  useEffect(() => {
    if (plan) {
      setDataLines(
        plan.lines.map((l) => ({
          ...l,
          unit_price: Number(l.unit_price ?? 0),
          quantity: Number(l.quantity ?? 0),
          amount: Number(l.amount ?? 0),
        })),
      );
      setDirty(false);
      setPersonnelData(
        (plan.personnel ?? []).map((p) => ({
          ...p,
          monthly_salary: Number(p.monthly_salary ?? 0),
          monthly_insurance: Number(p.monthly_insurance ?? 0),
          severance_annual: Number(p.severance_annual ?? 0),
          months: Number(p.months ?? 0),
          ratio_pct: Number(p.ratio_pct ?? 0),
        })),
      );
      setPersonnelDirty(false);
    } else {
      setDataLines([]);
      setDirty(false);
      setPersonnelData([]);
      setPersonnelDirty(false);
    }
  }, [plan?.id, plan?.updated_at]);

  // ── Grid 행 = 데이터 + 비목 합계 + 전체 합계 (세목 소계는 노출 X)
  const grandTotal = useMemo(
    () => dataLines.reduce((s, l) => s + l.amount, 0),
    [dataLines],
  );
  // 분모 = 저장된 총 연구개발비. 미설정이면 합계 자체로 fallback (배분 비율 표시).
  const pctDenom = Number(plan?.total_rnd_budget ?? 0) || grandTotal;
  const gridRows = useMemo(
    () => buildGridRows(dataLines, pctDenom),
    [dataLines, pctDenom],
  );

  // ── 메타: 선택 행 → 카테고리·세목 → 산정 기준 패널
  const selected = gridRows.find((r) => r._key === selectedRowKey);
  const selectedCriteria = useMemo(() => {
    if (!standard || !selected || selected._kind !== "DATA") return null;
    const cat = standard.categories.find(
      (c) => c.id === selected.category_id,
    );
    const sub = cat?.subcategories.find(
      (s) => s.id === selected.subcategory_id,
    );
    return { cat, sub };
  }, [standard, selected]);

  // ── 단가/건수/항목/메모 인라인 편집
  function onCellValueChanged(e: any) {
    if (e.data?._kind !== "DATA") return;
    const id = e.data._key;
    const field = e.colDef?.field as keyof Line;
    if (!field) return;
    setDataLines((cur) =>
      cur.map((l) => {
        if ((l.id ?? `n:${l.sort_order}`) !== id) return l;
        let v = e.newValue;
        if (field === "item_label" || field === "note") {
          v = typeof v === "string" ? v.trim() || null : v;
        }
        const next = { ...l, [field]: v };
        if (field === "unit_price" || field === "quantity") {
          const u = Number(next.unit_price) || 0;
          const q = Number(next.quantity) || 0;
          next.amount = Math.round(u * q * 100) / 100;
        }
        return next;
      }),
    );
    setDirty(true);
  }

  function onDeleteSelected() {
    if (!selected || selected._kind !== "DATA") return;
    setDataLines((cur) =>
      cur.filter(
        (l) => (l.id ?? `n:${l.sort_order}`) !== selected._key,
      ),
    );
    setSelectedRowKey(null);
    setDirty(true);
  }

  // [+ 같은 세목] — 동일 비목·세목으로 빈 라인 1개 추가 (인력별 인건비 등 입력에 핵심)
  function addSameSub(row: GridRow) {
    if (row._kind !== "DATA") return;
    setDataLines((cur) => {
      const sameSub = cur.filter(
        (l) => l.subcategory_id === row.subcategory_id,
      );
      const maxSort = sameSub.length
        ? Math.max(...sameSub.map((l) => l.sort_order))
        : row.sort_order;
      return [
        ...cur,
        {
          category_id: row.category_id,
          category_label: row.category_label,
          subcategory_id: row.subcategory_id,
          subcategory_label: row.subcategory_label,
          item_id: null,
          item_label: null,
          unit_price: 0,
          quantity: 0,
          amount: 0,
          note: null,
          sort_order: maxSort + 1,
        },
      ];
    });
    setDirty(true);
  }
  function deleteRow(row: GridRow) {
    if (row._kind !== "DATA") return;
    setDataLines((cur) =>
      cur.filter((l) => (l.id ?? `n:${l.sort_order}`) !== row._key),
    );
    setDirty(true);
  }

  // ── 저장
  const saveM = useMutation({
    mutationFn: async () => {
      if (!planId) throw new Error("no plan");
      const payload = {
        lines: dataLines.map((l, idx) => ({
          category_id: l.category_id,
          category_label: l.category_label,
          subcategory_id: l.subcategory_id,
          subcategory_label: l.subcategory_label,
          item_id: l.item_id ?? null,
          item_label: l.item_label ?? null,
          unit_price: Number(l.unit_price) || 0,
          quantity: Number(l.quantity) || 0,
          amount: Number(l.amount) || 0,
          note: l.note ?? null,
          sort_order: idx,
        })),
      };
      return (await api.put(`/rnd-budgets/${planId}/lines`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rnd-budget", planId] });
      qc.invalidateQueries({ queryKey: ["rnd-budgets"] });
      setDirty(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  // ── 인건비 인력 저장 — 이름이 비어있는 행은 자동 스킵 (사용자가 행 추가 후
  // 미입력 상태로 저장해도 에러 없이 진행 — 입력된 행만 저장)
  const savePersonnelM = useMutation({
    mutationFn: async () => {
      if (!planId) throw new Error("no plan");
      const payload = {
        personnel: personnelData
          .filter((p) => p.name.trim() !== "")
          .map((p, idx) => ({
            segment: p.segment,
            name: p.name.trim(),
            role: p.role?.trim() || null,
            monthly_salary: p.monthly_salary,
            monthly_insurance: p.monthly_insurance,
            severance_annual: p.severance_annual,
            months: p.months,
            ratio_pct: p.ratio_pct,
            sort_order: idx,
          })),
      };
      return (
        await api.put(`/rnd-budgets/${planId}/personnel`, payload)
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rnd-budget", planId] });
      setPersonnelDirty(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "인력 저장 실패", {
        title: "오류",
      }),
  });

  // 잔여금액 = 저장된 총 연구개발비 - 그리드 합계.
  // (BudgetSummaryPanel 의 미저장 입력은 미반영 — 먼저 저장 필요)
  const totalBudget = Number(plan?.total_rnd_budget ?? 0);
  const remaining = totalBudget - grandTotal;

  // [인건비 강제 맞춤] — 잔여 < 0 일 때, personnel-salary 첫 행의 amount 를
  // (현재값 + remaining) 으로 줄여 그리드 총합을 총 사업비에 맞춤.
  // 그리드 단위가 천원이므로 사용자 시각으론 "단가에 잔여/1000 (천원) 를 가산".
  function forceFitPersonnel() {
    if (remaining >= 0) return;
    const targetIdx = dataLines.findIndex(
      (l) => l.subcategory_id === "personnel-salary",
    );
    if (targetIdx < 0) {
      dialog.alert(
        "인건비-보수 행이 없습니다. 먼저 인건비 행을 추가해 주세요.",
        { title: "조정 실패" },
      );
      return;
    }
    setDataLines((cur) => {
      const next = [...cur];
      const l = { ...next[targetIdx] };
      const oldAmount = Number(l.amount) || 0;
      const newAmount = Math.max(0, oldAmount + remaining);
      const q = Number(l.quantity) || 0;
      if (q <= 0) {
        l.quantity = 1;
        l.unit_price = newAmount;
        l.amount = newAmount;
      } else {
        l.unit_price = Math.round(newAmount / q);
        l.amount = Math.round(l.unit_price * q * 100) / 100;
      }
      next[targetIdx] = l;
      return next;
    });
    setDirty(true);
  }

  // 저장 전 검증 — DB 컬럼 한도 초과한 라인이 있으면 다이얼로그 띄우고 중단.
  async function handleSave() {
    const errors: string[] = [];
    dataLines.forEach((l, idx) => {
      const u = Number(l.unit_price) || 0;
      const q = Number(l.quantity) || 0;
      const a = Number(l.amount) || 0;
      const where = `${idx + 1}행 [${l.category_label} > ${l.subcategory_label}${
        l.item_label ? ` > ${l.item_label}` : ""
      }]`;
      if (Math.abs(u) > RND_LIMITS.unit_price)
        errors.push(
          `${where} 단가 ${fmtMoney(u / 1000)}천원 — 최대 9,999,999천원`,
        );
      if (Math.abs(q) > RND_LIMITS.quantity)
        errors.push(`${where} 건수 ${fmtMoney(q)} — 최대 99,999,999건`);
      if (Math.abs(a) > RND_LIMITS.amount)
        errors.push(
          `${where} 합계 ${fmtMoney(a / 1000)}천원 — 최대 999,999,999,999천원`,
        );
    });
    if (errors.length > 0) {
      await dialog.alert(
        <div className="space-y-1 text-xs">
          <p className="font-semibold text-rose-600">
            저장 불가 — 일부 라인이 컬럼 한도를 초과합니다.
          </p>
          <ul className="list-disc ml-5 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2">
            빨간 셀의 값을 줄이거나 행을 분할해서 저장해 주세요.
          </p>
        </div>,
        { title: "입력값 오류" },
      );
      return;
    }
    saveM.mutate();
  }

  if (!planId) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        예산서를 선택하거나 새로 만들어주세요.
      </div>
    );
  }

  // ── 컬럼 정의
  const columnDefs: ColDef<GridRow>[] = [
    {
      field: "category_label",
      headerName: "비목",
      width: 110,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      valueFormatter: (p) => (p.data?._kind === "TOTAL" ? "합계" : p.value),
      cellStyle: (p) => subtotalCellStyle(p.data?._kind),
    },
    {
      field: "subcategory_label",
      headerName: "세목",
      width: 130,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      valueFormatter: (p) =>
        p.data?._kind === "CAT" ? "비목 합계" : p.data?._kind === "TOTAL" ? "" : p.value,
      cellStyle: (p) => subtotalCellStyle(p.data?._kind, "bold-on-cat"),
    },
    {
      field: "item_label",
      headerName: "항목",
      flex: 1,
      minWidth: 180,
      sortable: false,
      filter: false,
      editable: (p) =>
        p.data?._kind === "DATA" &&
        p.data?.subcategory_id !== "personnel-salary",
      valueFormatter: (p) =>
        p.data?._kind !== "DATA" ? "" : (p.value ?? "-"),
      cellEditor: "agTextCellEditor",
      cellStyle: (p) => subtotalCellStyle(p.data?._kind),
    },
    {
      field: "unit_price",
      headerName: "단가 (천원)",
      width: 110,
      flex: 0,
      sortable: false,
      filter: false,
      editable: (p) =>
        p.data?._kind === "DATA" &&
        p.data?.subcategory_id !== "personnel-salary",
      // 표시: 원 → 천원 (÷1000), 입력: 천원 → 원 (×1000). DB 는 원 단위 유지.
      valueFormatter: (p) =>
        p.data?._kind !== "DATA" ? "" : fmtMoney(Number(p.value) / 1000),
      valueParser: (p) => {
        const n = Number(String(p.newValue ?? "").replace(/,/g, ""));
        return Number.isFinite(n) ? Math.round(n * 1000) : 0;
      },
      cellStyle: (p) => ({
        ...subtotalCellStyle(p.data?._kind),
        ...(p.data?._kind === "DATA"
          ? overflowCellStyle(p.value, RND_LIMITS.unit_price)
          : {}),
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      } as any),
      cellEditor: "agNumberCellEditor",
    },
    {
      field: "quantity",
      headerName: "건수",
      width: 80,
      flex: 0,
      sortable: false,
      filter: false,
      editable: (p) =>
        p.data?._kind === "DATA" &&
        p.data?.subcategory_id !== "personnel-salary",
      valueFormatter: (p) =>
        p.data?._kind !== "DATA" ? "" : Number(p.value).toLocaleString("ko-KR"),
      cellStyle: (p) => ({
        ...subtotalCellStyle(p.data?._kind),
        ...(p.data?._kind === "DATA"
          ? overflowCellStyle(p.value, RND_LIMITS.quantity)
          : {}),
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      } as any),
      cellEditor: "agNumberCellEditor",
    },
    {
      field: "amount",
      headerName: "합계 (천원)",
      width: 170,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      valueFormatter: (p) => {
        const v = Number(p.value);
        const money = fmtMoney(v / 1000);
        const pct = p.data?._pct;
        if (pct != null && v > 0) {
          return `${money}  (${pct.toFixed(1)}%)`;
        }
        return money;
      },
      cellStyle: (p) => ({
        ...subtotalCellStyle(p.data?._kind, "amount"),
        ...(p.data?._kind === "DATA"
          ? overflowCellStyle(p.value, RND_LIMITS.amount)
          : {}),
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      } as any),
    },
    {
      field: "note",
      headerName: "메모",
      flex: 1,
      minWidth: 140,
      sortable: false,
      filter: false,
      editable: (p) => p.data?._kind === "DATA",
      valueFormatter: (p) =>
        p.data?._kind !== "DATA" ? "" : (p.value ?? ""),
      cellStyle: (p) => subtotalCellStyle(p.data?._kind),
    },
    {
      colId: "actions",
      headerName: "",
      width: 70,
      flex: 0,
      sortable: false,
      filter: false,
      editable: false,
      cellRenderer: (p: any) =>
        p.data?._kind === "DATA" ? (
          <div className="flex items-center gap-0.5 h-full">
            <button
              type="button"
              onClick={() => addSameSub(p.data)}
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted"
              title="같은 세목으로 행 추가"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => deleteRow(p.data)}
              className="h-6 w-6 inline-flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
              title="삭제"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ) : null,
      cellStyle: (p) => subtotalCellStyle(p.data?._kind),
    },
  ];

  // 인력 합계와 보수 행 amount 차액 — 서브 탭 라벨 옆 인디케이터에 사용
  const bosalAmount = dataLines
    .filter((l) => l.subcategory_id === "personnel-salary")
    .reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const personnelTotalSum = personnelData.reduce(
    (s, p) => s + calcPersonnelAmount(p),
    0,
  );
  const bosalDiff = bosalAmount - personnelTotalSum;

  return (
    <div className="flex h-full flex-col gap-3">
      {plan && (
        <BudgetSummaryPanel
          plan={plan}
          gridTotal={grandTotal}
          personnelTotal={dataLines
            .filter((l) => l.category_id === "personnel")
            .reduce((s, l) => s + l.amount, 0)}
        />
      )}

      {/* 서브 탭 — 세부 내역 / 인건비 인력 */}
      <div className="flex border-b border-border text-sm shrink-0">
        {(
          [
            ["detail", "세부 내역"],
            ["personnel", "인건비"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setMainView(k)}
            className={
              "h-9 px-4 border-b-2 -mb-px transition-colors inline-flex items-center gap-2 " +
              (mainView === k
                ? "border-primary text-primary font-semibold"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {label}
            {k === "personnel" && bosalDiff !== 0 && (
              <span
                className={
                  "inline-block w-2 h-2 rounded-full " +
                  (bosalDiff > 0 ? "bg-amber-500" : "bg-rose-500")
                }
                title={`차액 ${fmtMoney(bosalDiff)}원`}
              />
            )}
          </button>
        ))}
      </div>

      {mainView === "detail" ? (
        <div className="flex flex-1 min-h-0 gap-3">
          <div className="flex-1 min-w-0 flex flex-col gap-2 overflow-auto">
            <div className="flex items-center gap-2 text-sm shrink-0">
              <button
                type="button"
                onClick={() => setAddRowOpen(true)}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 hover:bg-muted"
              >
                <Plus className="h-4 w-4" />행 추가
              </button>
              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={!selected || selected._kind !== "DATA"}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-border px-3 text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />선택 삭제
              </button>
              <span className="text-xs text-muted-foreground">
                (단위: 천원)
              </span>
              <span className="ml-auto text-muted-foreground">
                총 라인 {dataLines.length}건 · 총합{" "}
                <b className="text-foreground tabular-nums">
                  {fmtMoney(grandTotal)}원
                </b>
              </span>
              <button
                type="button"
                onClick={forceFitPersonnel}
                disabled={remaining >= 0}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-amber-500 bg-amber-50 text-amber-700 px-3 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
                title={
                  remaining < 0
                    ? `잔여 ${fmtMoney(remaining / 1000)}천원 만큼 인건비-보수 행 단가를 차감`
                    : "잔여금액이 음수일 때만 사용 가능"
                }
              >
                인건비 강제 맞춤
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || saveM.isPending}
                className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {saveM.isPending ? "저장 중..." : dirty ? "저장" : "저장됨"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!planId) return;
                  window.open(
                    `/rnd-budget-preview/${planId}`,
                    "_blank",
                    "noopener,noreferrer,width=1100,height=900",
                  );
                }}
                disabled={!plan}
                className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 hover:bg-muted disabled:opacity-50"
                title="별도 창으로 예산서 미리보기 — 브라우저 인쇄로 PDF 저장 가능"
              >
                <FileText className="h-4 w-4" />
                미리보기
              </button>
            </div>
            <DataGrid<GridRow>
              rowData={gridRows}
              columnDefs={columnDefs}
              getRowId={(r) => r._key}
              pagination={false}
              height={800}
              onRowClicked={(r) => setSelectedRowKey(r._key)}
              onCellValueChanged={onCellValueChanged}
              enableCheckbox={false}
            />
          </div>

          {/* 우측 — 산정 기준 / 비목·세목 합계 (탭) — detail 뷰에서만 */}
          <aside className="w-80 shrink-0 border border-border rounded-md bg-card flex flex-col text-sm overflow-hidden">
        <div className="flex border-b border-border shrink-0">
          {(
            [
              ["criteria", "산정 기준"],
              ["breakdown", "비목 / 세목 합계"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSideTab(k)}
              className={
                "flex-1 h-9 px-3 text-sm border-b-2 -mb-px transition-colors " +
                (sideTab === k
                  ? "border-primary text-primary font-semibold"
                  : "border-transparent text-muted-foreground hover:text-foreground")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {sideTab === "criteria" ? (
            !selectedCriteria || !selectedCriteria.sub ? (
              <div className="text-muted-foreground">
                라인을 선택하면 해당 비목·세목의 산정 기준이 표시됩니다.
              </div>
            ) : (
              <CriteriaPanel
                cat={selectedCriteria.cat}
                sub={selectedCriteria.sub}
              />
            )
          ) : (
            <BudgetBreakdownTable lines={dataLines} pctDenom={pctDenom} />
          )}
        </div>
          </aside>
        </div>
      ) : (
        // 인건비 인력 뷰 — 전체 폭 활용, 우측 aside 없음
        <div className="flex-1 min-h-0 overflow-auto">
          <PersonnelPanel
            personnel={personnelData}
            onChange={(next) => {
              setPersonnelData(next);
              setPersonnelDirty(true);
            }}
            bosalAmount={bosalAmount}
            dirty={personnelDirty}
            saving={savePersonnelM.isPending}
            onSave={() => savePersonnelM.mutate()}
          />
        </div>
      )}

      <AddRowDialog
        open={addRowOpen}
        onClose={() => setAddRowOpen(false)}
        standard={standard}
        onAdd={(line) => {
          setDataLines((cur) => [
            ...cur,
            { ...line, sort_order: cur.length },
          ]);
          setDirty(true);
          setAddRowOpen(false);
        }}
      />

    </div>
  );
}

// 비목/세목 합계 표 — 우측 패널 하단. 그리드와 동일한 분모로 % 계산.
// 비목 행(굵게/회색 배경)과 세목 행(들여쓰기) 을 별도 tr 로 분리해 각각의 합계·% 표시.
function BudgetBreakdownTable({
  lines,
  pctDenom,
}: {
  lines: Line[];
  pctDenom: number;
}) {
  const tree = useMemo(() => {
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
      subs: Map<string, Sub>;
    };
    const cats = new Map<string, Cat>();
    for (const l of lines) {
      const a = Number(l.amount) || 0;
      let cat = cats.get(l.category_id);
      if (!cat) {
        cat = {
          catId: l.category_id,
          catLabel: l.category_label,
          amount: 0,
          sortKey: l.sort_order,
          subs: new Map(),
        };
        cats.set(l.category_id, cat);
      }
      cat.amount += a;
      if (l.sort_order < cat.sortKey) cat.sortKey = l.sort_order;
      let sub = cat.subs.get(l.subcategory_id);
      if (!sub) {
        sub = {
          subId: l.subcategory_id,
          subLabel: l.subcategory_label,
          amount: 0,
          sortKey: l.sort_order,
        };
        cat.subs.set(l.subcategory_id, sub);
      }
      sub.amount += a;
      if (l.sort_order < sub.sortKey) sub.sortKey = l.sort_order;
    }
    return [...cats.values()]
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((c) => ({
        ...c,
        subs: [...c.subs.values()].sort((a, b) => a.sortKey - b.sortKey),
      }));
  }, [lines]);

  if (tree.length === 0)
    return (
      <div className="text-muted-foreground">입력된 라인이 없습니다.</div>
    );
  const total = tree.reduce((s, c) => s + c.amount, 0);
  const pct = (n: number) =>
    pctDenom > 0 ? `${((n / pctDenom) * 100).toFixed(1)}%` : "—";

  return (
    <div>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left py-1 font-normal">비목 · 세목</th>
            <th className="text-right py-1 font-normal">천원</th>
            <th className="text-right py-1 font-normal w-12">%</th>
          </tr>
        </thead>
        <tbody>
          {tree.map((c) => (
            <Fragment key={c.catId}>
              <tr className="border-b border-border bg-slate-100">
                <td className="py-1 font-semibold">{c.catLabel}</td>
                <td className="text-right py-1 font-semibold">
                  {fmtMoney(c.amount / 1000)}
                </td>
                <td className="text-right py-1 font-semibold">
                  {pct(c.amount)}
                </td>
              </tr>
              {c.subs.map((s) => (
                <tr
                  key={`${c.catId}|${s.subId}`}
                  className="border-b border-border/50"
                >
                  <td className="py-1 pl-3 text-muted-foreground">
                    {s.subLabel}
                  </td>
                  <td className="text-right py-1">
                    {fmtMoney(s.amount / 1000)}
                  </td>
                  <td className="text-right py-1">{pct(s.amount)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr className="border-t-2 border-border font-semibold">
            <td className="py-1">합계</td>
            <td className="text-right py-1">{fmtMoney(total / 1000)}</td>
            <td className="text-right py-1">{pct(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}


// 인건비 인력 패널 — 그리드 하단. 기존/신규 인력 분리 입력, 합계와 보수 행과의 차액 표시.
function PersonnelPanel({
  personnel,
  onChange,
  bosalAmount,
  dirty,
  saving,
  onSave,
}: {
  personnel: Personnel[];
  onChange: (next: Personnel[]) => void;
  bosalAmount: number;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  // 정규직 임직원 picker — 이름·직급/직책 + 현재 연봉 + 추정 4대보험 + 입사일.
  // 선택 시 월급여(연봉/12), 월 4대보험, 연간 퇴직금(월급여 1개월분) 자동 채움.
  const { data: staff = [] } = useQuery<
    {
      id: string;
      name: string;
      tag: string | null;
      title: string | null;
      hire_date: string | null;
      annual_salary: number | null;
      employer_insurance_monthly: number | null;
    }[]
  >({
    queryKey: ["rnd-budget-staff-picker"],
    queryFn: async () => (await api.get("/rnd-budgets/staff-picker")).data,
    staleTime: 60 * 60 * 1000,
  });

  // 입사일 → "입사후 N개월" (음수면 null, 입사일 없으면 null)
  const tenureMonths = (iso: string | null): number | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let m =
      (now.getFullYear() - d.getFullYear()) * 12 +
      (now.getMonth() - d.getMonth());
    if (now.getDate() < d.getDate()) m -= 1;
    return m < 0 ? null : m;
  };
  const staffOptionLabel = (s: (typeof staff)[number]) => {
    const m = tenureMonths(s.hire_date);
    return m == null ? s.name : `${s.name} (${m}개월)`;
  };
  const calc = (p: Personnel) => calcPersonnelAmount(p);
  const sumOf = (arr: Personnel[]) => arr.reduce((s, p) => s + calc(p), 0);
  const existing = personnel
    .map((p, idx) => ({ p, idx }))
    .filter((x) => x.p.segment === "EXISTING");
  const incoming = personnel
    .map((p, idx) => ({ p, idx }))
    .filter((x) => x.p.segment === "NEW");
  const existingTotal = sumOf(existing.map((x) => x.p));
  const incomingTotal = sumOf(incoming.map((x) => x.p));
  const grandTotal = existingTotal + incomingTotal;
  const diff = bosalAmount - grandTotal;

  const updateField = <K extends keyof Personnel>(
    idx: number,
    field: K,
    value: Personnel[K],
  ) => {
    const next = [...personnel];
    next[idx] = { ...next[idx], [field]: value };
    onChange(next);
  };
  const addRow = (segment: PersonnelSegment) => {
    onChange([
      ...personnel,
      {
        segment,
        name: "",
        // EXISTING: 정규직 선택 시 staff.title 로 자동 채워짐. 비워둠.
        // NEW: 기본 "신규채용".
        role: segment === "EXISTING" ? "" : "신규채용",
        monthly_salary: 0,
        monthly_insurance: 0,
        severance_annual: 0,
        months: 0,
        ratio_pct: 100,
        sort_order: personnel.length,
      },
    ]);
  };
  const deleteRow = (idx: number) => {
    onChange(personnel.filter((_, i) => i !== idx));
  };
  // 퇴직금 자동 (월급여 × 12 × 10% = 연봉 × 10%)
  const autoSeverance = (idx: number) => {
    const p = personnel[idx];
    const v = roundWon(Number(p.monthly_salary) * 12 * 0.1);
    updateField(idx, "severance_annual", v);
  };

  const cell =
    "h-8 w-full rounded border border-input bg-background px-2 text-sm text-right tabular-nums";
  const cellLeft =
    "h-8 w-full rounded border border-input bg-background px-2 text-sm";

  const renderSection = (
    title: string,
    segment: PersonnelSegment,
    rows: { p: Personnel; idx: number }[],
    subtotal: number,
  ) => (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-border">
        <div className="font-semibold">{title}</div>
        <div className="flex items-center gap-3">
          <span className="text-sm tabular-nums">
            소계 <b>{fmtMoney(subtotal)}원</b>
          </span>
          <button
            type="button"
            onClick={() => addRow(segment)}
            className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
          >
            <Plus className="h-3 w-3" />행 추가
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-b border-border bg-slate-50">
              <th className="text-left p-2 font-normal w-40">이름</th>
              <th className="text-left p-2 font-normal w-28">
                {segment === "EXISTING" ? "직급/직책" : "신규인력"}
              </th>
              <th className="text-right p-2 font-normal w-32">월 급여</th>
              <th className="text-right p-2 font-normal w-32">월 4대보험</th>
              <th className="text-right p-2 font-normal w-32">연간 퇴직금</th>
              <th className="text-right p-2 font-normal w-20">개월</th>
              <th className="text-right p-2 font-normal w-20">투입율 %</th>
              <th className="text-right p-2 font-normal w-36">합계 (자동)</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="p-3 text-center text-muted-foreground"
                >
                  등록된 인력 없음
                </td>
              </tr>
            )}
            {rows.map(({ p, idx }) => (
              <tr key={idx} className="border-b border-border/50 align-top">
                <td className="p-1.5">
                  <select
                    value={p.name}
                    onChange={(e) => {
                      const v = e.target.value;
                      const matched = staff.find((s) => s.name === v);
                      const next = [...personnel];
                      if (matched) {
                        // 정규직 선택 → 직급/직책 + 월급여 + 월 4대보험
                        // + 연간 퇴직금(월급여 1개월분) 자동 채움.
                        const annual = Number(matched.annual_salary) || 0;
                        const monthly = roundWon(annual / 12);
                        const insurance = roundWon(
                          Number(matched.employer_insurance_monthly) || 0,
                        );
                        next[idx] = {
                          ...next[idx],
                          name: v,
                          // EXISTING: title, NEW: 기존 role 보존(또는 신규채용)
                          role:
                            segment === "EXISTING"
                              ? matched.title ?? ""
                              : next[idx].role || "신규채용",
                          monthly_salary: monthly,
                          monthly_insurance: insurance,
                          severance_annual: monthly,
                        };
                      } else {
                        next[idx] = {
                          ...next[idx],
                          name: v,
                          role:
                            segment === "EXISTING" ? "" : next[idx].role,
                        };
                      }
                      onChange(next);
                    }}
                    className={cellLeft}
                  >
                    <option value="">— 정규직 선택 —</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.name}>
                        {staffOptionLabel(s)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-1.5">
                  <input
                    className={cellLeft}
                    value={p.role ?? ""}
                    onChange={(e) =>
                      updateField(idx, "role", e.target.value || null)
                    }
                    placeholder={
                      segment === "EXISTING" ? "책임/연구원 등" : "신규채용"
                    }
                  />
                </td>
                <td className="p-1.5">
                  <AmountInput
                    value={p.monthly_salary}
                    onChange={(v) => updateField(idx, "monthly_salary", v)}
                    className={cell}
                  />
                </td>
                <td className="p-1.5">
                  <AmountInput
                    value={p.monthly_insurance}
                    onChange={(v) => updateField(idx, "monthly_insurance", v)}
                    className={cell}
                  />
                </td>
                <td className="p-1.5">
                  <div className="flex items-center gap-1">
                    <AmountInput
                      value={p.severance_annual}
                      onChange={(v) =>
                        updateField(idx, "severance_annual", v)
                      }
                      className={cell}
                    />
                    <button
                      type="button"
                      onClick={() => autoSeverance(idx)}
                      className="h-8 px-1.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded"
                      title="연봉의 10% 자동 입력"
                    >
                      自
                    </button>
                  </div>
                </td>
                <td className="p-1.5">
                  <input
                    type="number"
                    min={0}
                    max={99}
                    step={1}
                    value={p.months || ""}
                    onChange={(e) =>
                      updateField(idx, "months", Number(e.target.value) || 0)
                    }
                    className={cell}
                    placeholder="0"
                  />
                </td>
                <td className="p-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={p.ratio_pct || ""}
                    onChange={(e) =>
                      updateField(
                        idx,
                        "ratio_pct",
                        Number(e.target.value) || 0,
                      )
                    }
                    className={cell}
                    placeholder="0"
                  />
                </td>
                <td className="p-1.5 text-right tabular-nums font-semibold">
                  {fmtMoney(calc(p))}
                </td>
                <td className="p-1.5">
                  <button
                    type="button"
                    onClick={() => deleteRow(idx)}
                    className="h-7 w-7 inline-flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
                    title="삭제"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <section className="rounded-md border border-border bg-card mt-3">
      <div className="px-3 py-2 border-b border-border flex items-center gap-4 flex-wrap">
        <div className="font-semibold text-base">인건비</div>
        <span className="text-sm tabular-nums">
          <span className="text-muted-foreground">필요 보수 총액</span>{" "}
          <b>{fmtMoney(bosalAmount)}원</b>
        </span>
        <span className="text-sm tabular-nums">
          <span className="text-muted-foreground">보수 합계</span>{" "}
          <b>{fmtMoney(grandTotal)}원</b>
        </span>
        <span
          className={
            "text-sm tabular-nums " +
            (diff === 0
              ? "text-emerald-700"
              : diff > 0
                ? "text-amber-700"
                : "text-rose-600")
          }
        >
          <span className="text-muted-foreground">차액</span>{" "}
          <b>{fmtMoney(diff)}원</b>
          {diff !== 0 && (
            <span className="ml-1 text-[11px]">
              ({diff > 0 ? "필요 보수가 더 큼 — 인력 추가" : "보수 합계가 더 큼 — 인력 줄이기"})
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="ml-auto h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-3 w-3" />
          {saving ? "저장 중..." : dirty ? "인력 저장" : "저장됨"}
        </button>
      </div>
      <div className="p-3 space-y-3">
        {renderSection(
          "기존 인력 (이미 정규직)",
          "EXISTING",
          existing,
          existingTotal,
        )}
        {renderSection(
          "신규 인력 (입사 6개월 이내 또는 미입사)",
          "NEW",
          incoming,
          incomingTotal,
        )}
        <div className="text-right text-sm tabular-nums">
          <span className="text-muted-foreground">전체 합계</span>{" "}
          <b className="text-base">{fmtMoney(grandTotal)}원</b>
        </div>
      </div>
    </section>
  );
}


function CriteriaPanel({
  cat,
  sub,
}: {
  cat: CriteriaCategory | undefined;
  sub: CriteriaSubcategory;
}) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-sm text-muted-foreground">비목 / 세목</div>
        <div>
          {cat?.label} / <b>{sub.label}</b>
        </div>
      </div>
      {sub.applicableTargets && sub.applicableTargets.length > 0 && (
        <Section title="적용 대상">
          <ul className="list-disc pl-4 space-y-0.5">
            {sub.applicableTargets.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </Section>
      )}
      {sub.calculationFormulas && sub.calculationFormulas.length > 0 && (
        <Section title="산정 공식">
          {sub.calculationFormulas.map((f) => (
            <div key={f.id} className="mb-2">
              <div className="font-semibold">{f.condition}</div>
              <div>{f.formula}</div>
              {f.items && (
                <ul className="list-disc pl-4 text-sm mt-0.5">
                  {f.items.map((i, idx) => (
                    <li key={idx}>{i}</li>
                  ))}
                </ul>
              )}
              {f.note && (
                <div className="text-sm text-muted-foreground mt-0.5">
                  ※ {f.note}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
      {sub.calculationCriteria && sub.calculationCriteria.length > 0 && (
        <Section title="산정 기준">
          <ul className="list-disc pl-4 space-y-0.5">
            {sub.calculationCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </Section>
      )}
      {sub.exceptions && sub.exceptions.length > 0 && (
        <Section title="예외">
          <ul className="list-disc pl-4 space-y-0.5 text-amber-700">
            {sub.exceptions.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Section>
      )}
      {sub.items && sub.items.length > 0 && (
        <Section title="세부 항목">
          <ul className="space-y-3">
            {sub.items.map((item) => (
              <li key={item.id} className="border-l-2 border-border pl-2">
                <div className="font-semibold">{item.label}</div>
                {item.examples && item.examples.length > 0 && (
                  <ul className="list-disc pl-4 text-muted-foreground mt-0.5 space-y-0.5">
                    {item.examples.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {item.note && (
                  <div className="text-sm text-amber-700 mt-0.5">
                    ※ {item.note}
                  </div>
                )}
                {item.referenceTables?.map((tbl) => (
                  <ReferenceTable key={tbl.id} table={tbl} />
                ))}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

const REF_TABLE_COLUMN_LABEL: Record<string, string> = {
  range: "사업비 규모",
  amount: "표준수수료",
  participantCount: "참여기관 수",
  surcharge: "가산금",
};

function ReferenceTable({
  table,
}: {
  table: { label: string; rows: Array<Record<string, string>> };
}) {
  if (!table.rows || table.rows.length === 0) return null;
  const columns = Object.keys(table.rows[0]);
  return (
    <div className="mt-2">
      <div className="text-sm font-semibold text-slate-700 mb-1">
        {table.label}
      </div>
      <table className="w-full border border-border text-sm tabular-nums">
        <thead className="bg-slate-100">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="border border-border px-2 py-1 text-left font-normal"
              >
                {REF_TABLE_COLUMN_LABEL[c] ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} className="border border-border px-2 py-1">
                  {row[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-sm text-muted-foreground mb-1">{title}</div>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 행 추가 다이얼로그 — 비목 → 세목 → 항목 (있으면 select, 없으면 자유 입력)
// ---------------------------------------------------------------------------

function AddRowDialog({
  open,
  onClose,
  standard,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  standard: StandardCriteria | undefined;
  onAdd: (l: Line) => void;
}) {
  const [catId, setCatId] = useState("");
  const [subId, setSubId] = useState("");
  const [itemId, setItemId] = useState("");
  const [itemLabelFree, setItemLabelFree] = useState("");
  const [unitPrice, setUnitPrice] = useState(0);
  const [quantity, setQuantity] = useState(0);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) {
      setCatId("");
      setSubId("");
      setItemId("");
      setItemLabelFree("");
      setUnitPrice(0);
      setQuantity(0);
      setNote("");
    }
  }, [open]);

  const cat = standard?.categories.find((c) => c.id === catId);
  const sub = cat?.subcategories.find((s) => s.id === subId);
  const items = sub?.items ?? [];
  const hasItems = items.length > 0;

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  const canSubmit =
    !!cat &&
    !!sub &&
    (hasItems ? !!itemId : true) &&
    unitPrice > 0 &&
    quantity > 0;

  function submit() {
    if (!canSubmit || !cat || !sub) return;
    const item = hasItems ? items.find((i) => i.id === itemId) : null;
    const label = hasItems
      ? item?.label ?? null
      : itemLabelFree.trim() || null;
    onAdd({
      category_id: cat.id,
      category_label: cat.label,
      subcategory_id: sub.id,
      subcategory_label: sub.label,
      item_id: item?.id ?? null,
      item_label: label,
      unit_price: unitPrice,
      quantity,
      amount: Math.round(unitPrice * quantity * 100) / 100,
      note: note.trim() || null,
      sort_order: 0,
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="예산 행 추가"
      width="max-w-2xl"
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
            onClick={submit}
            disabled={!canSubmit}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            추가
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="비목 *" colSpan={2}>
          <select
            value={catId}
            onChange={(e) => {
              setCatId(e.target.value);
              setSubId("");
              setItemId("");
            }}
            className={input}
          >
            <option value="">선택</option>
            {standard?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        {/* 세목 — 카드 리스트 (옆에 산정 지침 노출) */}
        {cat && (
          <Field label="세목 * — 적용 대상·산정 공식 확인 후 선택" colSpan={2}>
            <div className="max-h-72 overflow-auto rounded-md border border-input divide-y divide-border">
              {cat.subcategories.map((s) => {
                const selected = subId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSubId(s.id);
                      setItemId("");
                    }}
                    className={
                      "w-full text-left p-2.5 hover:bg-muted/40 transition-colors block " +
                      (selected
                        ? "bg-primary/5 border-l-4 border-primary"
                        : "border-l-4 border-transparent")
                    }
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={
                          "mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0 inline-flex items-center justify-center " +
                          (selected
                            ? "border-primary bg-primary"
                            : "border-slate-400")
                        }
                        aria-hidden
                      >
                        {selected && (
                          <span className="h-1.5 w-1.5 rounded-full bg-white" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div
                          className={
                            "text-sm " +
                            (selected
                              ? "font-semibold text-primary"
                              : "font-medium text-foreground")
                          }
                        >
                          {s.label}
                        </div>
                        {s.applicableTargets &&
                          s.applicableTargets.length > 0 && (
                            <ul className="text-[11px] text-muted-foreground mt-1 space-y-0.5">
                              {s.applicableTargets.map((t, i) => (
                                <li key={i}>· {t}</li>
                              ))}
                            </ul>
                          )}
                        {s.calculationFormulas &&
                          s.calculationFormulas.length > 0 && (
                            <div className="text-[10px] text-slate-500 mt-1">
                              <b>공식</b>:{" "}
                              {s.calculationFormulas
                                .map(
                                  (f) =>
                                    `${f.condition} → ${f.formula}`,
                                )
                                .join(" / ")}
                            </div>
                          )}
                        {s.calculationCriteria &&
                          s.calculationCriteria.length > 0 && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              <b>기준</b>: {s.calculationCriteria[0]}
                              {s.calculationCriteria.length > 1 && (
                                <span className="text-slate-400">
                                  {" "}
                                  외 {s.calculationCriteria.length - 1}건
                                </span>
                              )}
                            </div>
                          )}
                        {s.exceptions && s.exceptions.length > 0 && (
                          <div className="text-[10px] text-amber-700 mt-0.5">
                            ⚠ {s.exceptions[0]}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        <Field label={hasItems ? "항목 * (시드)" : "항목 (자유 입력)"} colSpan={2}>
          {hasItems ? (
            <select
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              className={input}
            >
              <option value="">선택</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                value={itemLabelFree}
                onChange={(e) => setItemLabelFree(e.target.value)}
                className={input}
                placeholder={
                  sub && FREE_INPUT_EXAMPLES[sub.id]
                    ? `예: ${FREE_INPUT_EXAMPLES[sub.id].join(", ")}`
                    : "예: 김XX 인건비, 출장 항공료 등 (선택)"
                }
                disabled={!sub}
              />
              {sub && FREE_INPUT_EXAMPLES[sub.id] && (
                <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-1">
                  <span className="text-slate-500">선택 가능:</span>
                  {FREE_INPUT_EXAMPLES[sub.id].map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setItemLabelFree(ex)}
                      className="px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>
        <Field label="단가 (원) *">
          <AmountInput
            value={unitPrice}
            onChange={setUnitPrice}
            className={input + " text-right tabular-nums"}
          />
        </Field>
        <Field label="건수 *">
          <input
            type="number"
            value={quantity || ""}
            onChange={(e) => setQuantity(Number(e.target.value) || 0)}
            className={input + " text-right tabular-nums"}
            min={0}
            step={1}
          />
        </Field>
        <Field label="메모" colSpan={2}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={input}
            placeholder="(선택)"
          />
        </Field>
        {unitPrice > 0 && quantity > 0 && (
          <div className="col-span-2 text-right text-sm">
            합계{" "}
            <b className="tabular-nums">
              {fmtMoney(unitPrice * quantity)}원
            </b>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 신규 예산서 다이얼로그
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
  /** source 가 있으면 "복제" 모드 — 필드 prefill + duplicate 엔드포인트 호출 */
  source?: Plan | null;
}) {
  const dialog = useDialog();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(thisYear);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [agency, setAgency] = useState("");
  const [memo, setMemo] = useState("");

  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ["projects", "light"],
    queryFn: async () => (await api.get("/projects")).data,
    staleTime: 60_000,
    enabled: open,
  });
  const { data: customers = [] } = useQuery<CustomerLite[]>({
    queryKey: ["customers", "light"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    if (source) {
      // 복제 모드 — 원본 값 prefill, 제목엔 (복사본) suffix
      setYear(source.year);
      setTitle(`${source.title} (복사본)`.slice(0, 200));
      setProjectId(source.project_id);
      setCustomerId(source.customer_id);
      setAgency(source.funding_agency ?? "");
      setMemo(source.memo ?? "");
    } else {
      // 신규 모드 — 빈 폼
      setYear(thisYear);
      setTitle("");
      setProjectId(null);
      setCustomerId(null);
      setAgency("");
      setMemo("");
    }
  }, [open, thisYear, source?.id]);

  const isDuplicate = !!source;

  const createM = useMutation({
    mutationFn: async () => {
      const payload = {
        year,
        title: title.trim(),
        project_id: projectId,
        customer_id: customerId,
        funding_agency: agency.trim() || null,
        memo: memo.trim() || null,
        status: "DRAFT",
      };
      if (isDuplicate && source) {
        return (
          await api.post(`/rnd-budgets/${source.id}/duplicate`, payload)
        ).data as Plan;
      }
      return (await api.post("/rnd-budgets", payload)).data as Plan;
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
      title={isDuplicate ? "예산서 복제" : "새 R&D 예산서"}
      width="max-w-xl"
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="연도 *">
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className={input}
            min={2000}
            max={2100}
          />
        </Field>
        <Field label="출연기관">
          <input
            value={agency}
            onChange={(e) => setAgency(e.target.value)}
            className={input}
            placeholder="예: TIPA / IITP / KEIT"
          />
        </Field>
        <Field label="제목 *" colSpan={2}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={input}
            placeholder="예: TIPS R&D 2026"
            autoFocus
          />
        </Field>
        <Field label="프로젝트">
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
            className={input}
          >
            <option value="">미지정</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="발주처/고객사">
          <select
            value={customerId ?? ""}
            onChange={(e) => setCustomerId(e.target.value || null)}
            className={input}
          >
            <option value="">미지정</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="메모" colSpan={2}>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className={input + " min-h-16"}
            rows={2}
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: 정산 서류 (read-only 표)
// ---------------------------------------------------------------------------

function SettlementTab({ data }: { data: SettlementData | undefined }) {
  if (!data)
    return <div className="text-sm text-muted-foreground p-4">로딩 중…</div>;
  return (
    <div className="overflow-auto h-full pr-2 text-sm">
      <h2 className="text-sm font-semibold mb-2">{data.title}</h2>
      <table className="w-full text-sm border border-border">
        <thead className="bg-muted/40">
          <tr>
            <th className="border border-border p-2 w-32 text-left">비목</th>
            <th className="border border-border p-2 w-40 text-left">세목</th>
            <th className="border border-border p-2 text-left">제출 서류</th>
          </tr>
        </thead>
        <tbody>
          {data.categories.flatMap((c) =>
            c.subcategories.map((s, idx) => (
              <tr key={`${c.id}-${s.id}`} className="align-top">
                {idx === 0 && (
                  <td
                    rowSpan={c.subcategories.length}
                    className="border border-border p-2 font-semibold bg-muted/20"
                  >
                    {c.label}
                  </td>
                )}
                <td className="border border-border p-2">{s.label}</td>
                <td className="border border-border p-2">
                  {s.sharesDocumentsWith ? (
                    <span className="text-muted-foreground">
                      ※ 다른 세목과 동일
                    </span>
                  ) : (
                    <ul className="list-disc pl-4 space-y-0.5">
                      {s.documents.map((d) => (
                        <li key={d.id}>
                          <span>{d.title}</span>
                          {d.note && (
                            <span className="text-muted-foreground">
                              {" "}
                              — {d.note}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: 불인정 기준 (read-only 표)
// ---------------------------------------------------------------------------

function DisallowedTab({ data }: { data: DisallowedData | undefined }) {
  if (!data)
    return <div className="text-sm text-muted-foreground p-4">로딩 중…</div>;
  return (
    <div className="overflow-auto h-full pr-2 space-y-4 text-sm">
      <h2 className="text-sm font-semibold">{data.title}</h2>

      {/* 공통사항 — cases 가 카테고리 직속 */}
      {data.common && (
        <section className="rounded-md border border-border bg-card p-3">
          <div className="text-sm font-semibold">{data.common.label}</div>
          {data.common.description && (
            <div className="text-sm text-muted-foreground mb-2">
              {data.common.description}
            </div>
          )}
          <CaseTable cases={data.common.cases} />
        </section>
      )}

      {/* 비목별 — subcategories[].cases 로 중첩 */}
      {(data.categories ?? []).map((cat) => (
        <section
          key={cat.id}
          className="rounded-md border border-border bg-card p-3"
        >
          <div className="text-sm font-semibold">{cat.label}</div>
          {cat.description && (
            <div className="text-sm text-muted-foreground mb-2">
              {cat.description}
            </div>
          )}
          <div className="space-y-3">
            {(cat.subcategories ?? []).map((sub) => (
              <div key={sub.id}>
                <div className="text-sm font-semibold text-slate-700 mb-1">
                  ▸ {sub.label}
                </div>
                <CaseTable cases={sub.cases ?? []} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CaseTable({ cases }: { cases: DisallowedCase[] }) {
  if (!cases || cases.length === 0)
    return (
      <div className="text-sm text-muted-foreground italic">
        등록된 불인정 사례 없음
      </div>
    );
  return (
    <table className="w-full text-sm">
      <tbody>
        {cases.map((c) => (
          <tr key={c.id} className="border-t border-border align-top">
            <td className="py-1.5 pr-3 font-semibold w-56">{c.title}</td>
            <td className="py-1.5">
              {c.description}
              {c.note && (
                <div className="text-sm text-muted-foreground mt-0.5">
                  ※ {c.note}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGridRows(lines: Line[], pctDenom: number): GridRow[] {
  // 카테고리/세목 정렬 기준 = "첫 등장 sort_order".
  // 백엔드 scaffold 가 시드 JSON 순서로 sort_order 를 부여하므로
  // 인건비 → 운영비 → … → 민간이전 순서가 그대로 유지됨
  // (알파벳순 정렬을 쓰면 인건비가 3 번째로 밀린다).
  const catKey = new Map<string, number>();
  const subKey = new Map<string, number>();
  for (const l of lines) {
    const ck = l.category_id;
    const sk = `${l.category_id}|${l.subcategory_id}`;
    const cv = catKey.get(ck);
    if (cv === undefined || l.sort_order < cv) catKey.set(ck, l.sort_order);
    const sv = subKey.get(sk);
    if (sv === undefined || l.sort_order < sv) subKey.set(sk, l.sort_order);
  }
  const sorted = [...lines].sort((a, b) => {
    const ca = catKey.get(a.category_id) ?? 0;
    const cb = catKey.get(b.category_id) ?? 0;
    if (ca !== cb) return ca - cb;
    const sa = subKey.get(`${a.category_id}|${a.subcategory_id}`) ?? 0;
    const sb = subKey.get(`${b.category_id}|${b.subcategory_id}`) ?? 0;
    if (sa !== sb) return sa - sb;
    return a.sort_order - b.sort_order;
  });

  const pctOf = (n: number) =>
    pctDenom > 0 ? (n / pctDenom) * 100 : null;

  const out: GridRow[] = [];
  let curCat = "";
  let curCatLabel = "";
  let catSum = 0;
  let grand = 0;

  function flushCat() {
    if (curCat) {
      out.push({
        _key: `cat:${curCat}`,
        _kind: "CAT",
        category_id: curCat,
        category_label: curCatLabel,
        subcategory_id: "",
        subcategory_label: "",
        item_id: null,
        item_label: null,
        unit_price: 0,
        quantity: 0,
        amount: catSum,
        note: null,
        sort_order: 0,
        _pct: pctOf(catSum),
      });
    }
    catSum = 0;
  }

  for (const l of sorted) {
    if (l.category_id !== curCat) {
      flushCat();
      curCat = l.category_id;
      curCatLabel = l.category_label;
    }
    out.push({
      ...l,
      _key: l.id ?? `n:${l.sort_order}`,
      _kind: "DATA",
      _pct: pctOf(Number(l.amount) || 0),
    });
    catSum += Number(l.amount) || 0;
    grand += Number(l.amount) || 0;
  }
  flushCat();
  if (sorted.length > 0) {
    out.push({
      _key: "total",
      _kind: "TOTAL",
      category_id: "",
      category_label: "",
      subcategory_id: "",
      subcategory_label: "",
      item_id: null,
      item_label: null,
      unit_price: 0,
      quantity: 0,
      amount: grand,
      note: null,
      sort_order: 0,
      _pct: pctOf(grand),
    });
  }
  return out;
}

function subtotalCellStyle(
  kind: GridRow["_kind"] | undefined,
  _variant?: "amount" | "bold-on-cat",
): any {
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
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <label
      className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 예산 요약 패널 — Grid 위에 위치. A(슬라이더)+B(직접금액) 입력 동시 지원.
// 명시적 [예산 요약 저장] 버튼으로 PATCH. 한도 위반은 경고만, 저장 허용.
// ---------------------------------------------------------------------------

function BudgetSummaryPanel({
  plan,
  gridTotal,
  personnelTotal,
}: {
  plan: PlanDetail;
  gridTotal: number;
  personnelTotal: number;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  // 모든 금액은 직접 입력. 총 연구개발비 = 정부지원금 + 기관부담금 (read-only).
  // 0원 케이스 모두 허용 (정부 100% 지원 / 현금만 / 현물만 / 기관부담금 0).
  const [size, setSize] = useState<CompanySize>(plan.company_size ?? "SMALL");
  const [gov, setGov] = useState<number>(plan.gov_funding_amount ?? 0);
  const [own, setOwn] = useState<number>(
    (plan.own_cash_amount ?? 0) + (plan.own_inkind_amount ?? 0),
  );
  const [cash, setCash] = useState<number>(plan.own_cash_amount ?? 0);
  const [inkind, setInkind] = useState<number>(plan.own_inkind_amount ?? 0);
  // 비율 사용자 정의 — null 이면 기업규모 default.
  // 현금/현물은 독립 저장: cashRate 우선 입력 시 inkindRate auto(null),
  // 사용자가 inkind 명시 입력하면 별도 저장 → 둘 다 0% 같은 케이스 가능.
  const [govRate, setGovRate] = useState<number | null>(plan.gov_funding_rate);
  const [cashRate, setCashRate] = useState<number | null>(plan.cash_min_rate);
  const [inkindRate, setInkindRate] = useState<number | null>(
    plan.inkind_min_rate,
  );
  // 편집 빈도 낮음 — 기본 접힘. 펼침 시 전체 입력 폼 노출.
  const [expanded, setExpanded] = useState(false);
  const [dirty, setDirty] = useState(false);

  // plan 이 바뀌면(예산서 전환·refetch) 다시 동기화
  useEffect(() => {
    setSize(plan.company_size ?? "SMALL");
    setGov(roundWon(Number(plan.gov_funding_amount ?? 0)));
    const c = roundWon(Number(plan.own_cash_amount ?? 0));
    const k = roundWon(Number(plan.own_inkind_amount ?? 0));
    setOwn(c + k);
    setCash(c);
    setInkind(k);
    setGovRate(
      plan.gov_funding_rate == null ? null : Number(plan.gov_funding_rate),
    );
    setCashRate(
      plan.cash_min_rate == null ? null : Number(plan.cash_min_rate),
    );
    setInkindRate(
      plan.inkind_min_rate == null ? null : Number(plan.inkind_min_rate),
    );
    setDirty(false);
  }, [plan.id, plan.updated_at]);

  // 적용 비율 — 사용자 정의 우선, 없으면 기업규모 default.
  // Option A: gov 만 사용자 입력, own = 1 - gov 자동.
  // 현금/현물 — 보통 cash 입력 시 inkind = 1 - cash 자동, 단 사용자가 inkind
  // 명시 입력 시 그 값 사용 (둘 다 0% 같은 비표준 조합 가능).
  const sizeDefault = COMPANY_SIZE[size];
  const effGovMax = govRate ?? sizeDefault.govMax;
  const effOwnMin = govRate != null ? 1 - govRate : sizeDefault.ownMin;
  const effCashMin = cashRate ?? sizeDefault.cashMinWithinOwn;
  const effInkindMin =
    inkindRate ??
    (cashRate != null
      ? Math.max(0, 1 - cashRate)
      : 1 - sizeDefault.cashMinWithinOwn);
  const isCustom =
    govRate !== null || cashRate !== null || inkindRate !== null;

  // 자동 계산 (read-only)
  const total = gov + own;
  const govRatio = total > 0 ? gov / total : 0;
  const ownRatio = total > 0 ? own / total : 0;
  const cashRatio = own > 0 ? cash / own : 0;

  // 한도 검증 — 경고만 (저장 허용).
  // 정부지원금은 입력의 기준점이고 기관부담금이 역계산되므로 별도 검증 불필요.
  // 임계치는 cascade 와 동일하게 roundWon (10원 단위 반올림) 사용.
  const govOk = true;
  const ownOk = total === 0 || own >= roundWon(total * effOwnMin);
  const cashOk = own === 0 || cash >= roundWon(own * effCashMin);

  // ── 입력 핸들러 — cascade 자동 계산 (정부지원금 → 기관 → 현금 → 현물).
  // 정수화 정책: 모든 금액은 소숫점을 버리고 원단위(10원) 반올림 = roundWon.
  // 현물(inkind) = own - cash 차감으로 10원 단위 보존.
  const onGovChange = (v: number) => {
    const newGov = roundWon(Math.max(0, v));
    setGov(newGov);
    const newOwn =
      effGovMax > 0 ? roundWon(newGov * (effOwnMin / effGovMax)) : 0;
    const newCash = roundWon(newOwn * effCashMin);
    const newInkind =
      inkindRate != null ? roundWon(newOwn * inkindRate) : newOwn - newCash;
    setOwn(newOwn);
    setCash(newCash);
    setInkind(newInkind);
    setDirty(true);
  };
  const onOwnChange = (v: number) => {
    const newOwn = roundWon(Math.max(0, v));
    setOwn(newOwn);
    const newCash = roundWon(newOwn * effCashMin);
    const newInkind =
      inkindRate != null ? roundWon(newOwn * inkindRate) : newOwn - newCash;
    setCash(newCash);
    setInkind(newInkind);
    setDirty(true);
  };
  const onCashChange = (v: number) => {
    const c = roundWon(Math.max(0, Math.min(v, own)));
    setCash(c);
    setInkind(own - c);
    setDirty(true);
  };
  const onInkindChange = (v: number) => {
    const k = roundWon(Math.max(0, Math.min(v, own)));
    setInkind(k);
    setCash(own - k);
    setDirty(true);
  };
  const onSizeChange = (s: CompanySize) => {
    setSize(s);
    setDirty(true);
    if (isCustom) return;
    const sc = COMPANY_SIZE[s];
    const newOwn =
      sc.govMax > 0 ? roundWon(gov * (sc.ownMin / sc.govMax)) : 0;
    const newCash = roundWon(newOwn * sc.cashMinWithinOwn);
    setOwn(newOwn);
    setCash(newCash);
    setInkind(newOwn - newCash);
  };
  // 비율 입력 — 사용자 % (0~100) → 0.0~1.0 으로 환산. NaN/범위 외는 거부.
  const parsePct = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) return undefined as never;
    return n / 100;
  };
  // 비율 변경 시 — 정부 amount 는 보존하고 기관/현금/현물 cascade 재계산.
  const onGovRateChange = (s: string) => {
    const r = parsePct(s);
    if (r === undefined) return; // 범위 외 — 무시
    setGovRate(r);
    setDirty(true);
    const newGovMax = r ?? sizeDefault.govMax;
    const newOwnMin = r != null ? 1 - r : sizeDefault.ownMin;
    const newOwn =
      newGovMax > 0 ? roundWon(gov * (newOwnMin / newGovMax)) : 0;
    const newCash = roundWon(newOwn * effCashMin);
    setOwn(newOwn);
    setCash(newCash);
    setInkind(newOwn - newCash);
  };
  // 현금 비율 변경 — 우선순위 높음. inkindRate 를 null 로 리셋해 자동 모드.
  // cash = own × cashRate, inkind = own − cash (1 − cashRate 자동).
  const onCashRateChange = (s: string) => {
    const r = parsePct(s);
    if (r === undefined) return;
    setCashRate(r);
    setInkindRate(null);
    setDirty(true);
    const newCashMin = r ?? sizeDefault.cashMinWithinOwn;
    const newCash = roundWon(own * newCashMin);
    setCash(newCash);
    setInkind(own - newCash);
  };
  // 현물 비율 변경 — 명시 모드. cashRate 는 그대로 두고 inkind 만 own × r 로.
  // (둘 다 0% 같은 비표준 조합도 가능 — cash + inkind != own 허용)
  const onInkindRateChange = (s: string) => {
    const r = parsePct(s);
    if (r === undefined) return;
    setInkindRate(r);
    setDirty(true);
    const newInkindMin =
      r ??
      (cashRate != null
        ? Math.max(0, 1 - cashRate)
        : 1 - sizeDefault.cashMinWithinOwn);
    const newInkind = roundWon(own * newInkindMin);
    setInkind(newInkind);
  };
  const resetRatesToStandard = async () => {
    const ok = await dialog.confirm(
      <>
        현재 기업규모(<b>{COMPANY_SIZE[size].label}</b>) 표준 비율로
        되돌립니다. 사용자 정의 값은 사라지고 기관·현금·현물 금액이
        표준 비율로 재계산됩니다.
      </>,
      { title: "표준값 적용", confirmText: "적용" },
    );
    if (!ok) return;
    setGovRate(null);
    setCashRate(null);
    setInkindRate(null);
    setDirty(true);
    const sc = sizeDefault;
    const newOwn =
      sc.govMax > 0 ? roundWon(gov * (sc.ownMin / sc.govMax)) : 0;
    const newCash = roundWon(newOwn * sc.cashMinWithinOwn);
    setOwn(newOwn);
    setCash(newCash);
    setInkind(newOwn - newCash);
  };

  const saveM = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/rnd-budgets/${plan.id}`, {
          company_size: size,
          total_rnd_budget: total,
          gov_funding_amount: gov,
          own_cash_amount: cash,
          own_inkind_amount: inkind,
          gov_funding_rate: govRate,
          // own_burden_rate 는 1 - govRate 로 자동 도출. null 이면 server 도 null.
          own_burden_rate: govRate == null ? null : 1 - govRate,
          cash_min_rate: cashRate,
          inkind_min_rate: inkindRate,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rnd-budget", plan.id] });
      qc.invalidateQueries({ queryKey: ["rnd-budgets"] });
      setDirty(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const remaining = total - gridTotal;

  const inputCls =
    "rounded-md border border-input bg-background px-2 py-1 text-sm text-right tabular-nums w-36";
  const num = (n: number) =>
    Number.isFinite(n) ? Math.round(n).toLocaleString("ko-KR") : "0";
  const pct = (r: number) =>
    (Number.isFinite(r) ? (r * 100).toFixed(1) : "0") + "%";

  // 비율 입력 셀 — % 단위 표시. 값이 있으면 그 값, null 이면 placeholder 로 default.
  const rateInputCls =
    "h-8 w-16 rounded-md border border-input bg-background px-1.5 text-sm text-right tabular-nums";
  const fmtPctInput = (r: number | null) =>
    r == null ? "" : (r * 100).toFixed(1).replace(/\.0$/, "");

  return (
    <section className="rounded-md border border-border bg-card text-sm shrink-0">
      {/* 헤더 — 항상 보이는 한 줄 통계 + 펼치기 토글 + 저장 */}
      <div className="px-3 py-2 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          title={expanded ? "접기" : "펼쳐서 편집"}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <span className="font-semibold text-foreground">예산 요약</span>
        </button>
        <span className="text-xs text-muted-foreground">
          {COMPANY_SIZE[size].label}
          {isCustom && (
            <span className="text-blue-600 font-semibold ml-1">
              · 사용자 정의 비율
            </span>
          )}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
          <span>
            <span className="text-muted-foreground">총 연구개발비</span>{" "}
            <b>{num(total)}원</b>
          </span>
          <span>
            <span className="text-muted-foreground">세부 내역 총합</span>{" "}
            <b>{num(gridTotal)}원</b>
          </span>
          <span
            className={
              remaining < 0
                ? "text-rose-600"
                : remaining > 0
                  ? "text-amber-700"
                  : ""
            }
          >
            <span className="text-muted-foreground">잔여</span>{" "}
            <b>{num(remaining)}원</b>
            {remaining < 0 && " (초과)"}
          </span>
          <span>
            <span className="text-muted-foreground">인건비 합계</span>{" "}
            <b>{num(personnelTotal)}원</b>
          </span>
        </span>
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={!dirty || saveM.isPending}
          className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          <Save className="h-3 w-3" />
          {saveM.isPending ? "저장 중..." : dirty ? "예산 요약 저장" : "저장됨"}
        </button>
      </div>

      {/* 본문 — 펼침 시에만 노출 */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
          {/* 비율 입력 */}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">기업 규모</span>
              <select
                value={size}
                onChange={(e) => onSizeChange(e.target.value as CompanySize)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {(Object.keys(COMPANY_SIZE) as CompanySize[]).map((k) => (
                  <option key={k} value={k}>
                    {COMPANY_SIZE[k].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">정부</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={fmtPctInput(govRate)}
                onChange={(e) => onGovRateChange(e.target.value)}
                placeholder={(sizeDefault.govMax * 100).toString()}
                className={rateInputCls}
              />
              <span className="text-muted-foreground">%</span>
            </label>
            <span className="text-muted-foreground text-xs">
              기관 {pct(effOwnMin)}{" "}
              <span className="text-[10px]">(자동)</span>
            </span>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">현금(內)</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={fmtPctInput(cashRate)}
                onChange={(e) => onCashRateChange(e.target.value)}
                placeholder={(sizeDefault.cashMinWithinOwn * 100).toString()}
                className={rateInputCls}
              />
              <span className="text-muted-foreground">%</span>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">현물(內)</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={fmtPctInput(
                  inkindRate != null
                    ? inkindRate
                    : cashRate != null
                      ? Math.max(0, 1 - cashRate)
                      : null,
                )}
                onChange={(e) => onInkindRateChange(e.target.value)}
                placeholder={((1 - sizeDefault.cashMinWithinOwn) * 100).toString()}
                className={rateInputCls}
              />
              <span className="text-muted-foreground">%</span>
            </label>
            {isCustom && (
              <button
                type="button"
                onClick={resetRatesToStandard}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-amber-500 bg-amber-50 px-2 text-xs text-amber-700 hover:bg-amber-100"
                title="현재 기업규모의 표준 비율로 되돌리기"
              >
                표준값 적용
              </button>
            )}
            <span className="text-[11px] text-muted-foreground">
              한도: 기관 ≥ {pct(effOwnMin)} · 현금(內) ≥ {pct(effCashMin)}
            </span>
          </div>

          {/* 정부 / 기관 — 가로 2 분할 */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <AmountRow
              label="정부지원금"
              amount={gov}
              ratio={govRatio}
              ratioLabel="총액 대비"
              ok={govOk}
              violation=""
              onChange={onGovChange}
            />
            <AmountRow
              label="기관부담금"
              amount={own}
              ratio={ownRatio}
              ratioLabel="총액 대비"
              ok={ownOk}
              violation={`최소 ${pct(effOwnMin)} 미달`}
              onChange={onOwnChange}
            />
            <AmountRow
              label="기관의 현금 (실 입금)"
              amount={cash}
              ratio={cashRatio}
              ratioLabel="기관부담금 內"
              ok={cashOk}
              violation={`최소 ${pct(effCashMin)} 미달`}
              onChange={onCashChange}
              disabled={own === 0}
            />
            <AmountRow
              label="기관의 현물"
              amount={inkind}
              ratio={own > 0 ? inkind / own : 0}
              ratioLabel="기관부담금 內"
              ok={true}
              violation=""
              extraNote="인건비로 충당"
              onChange={onInkindChange}
              disabled={own === 0}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function AmountRow({
  label,
  amount,
  ratio,
  ratioLabel,
  ok,
  violation,
  extraNote,
  onChange,
  disabled,
}: {
  label: string;
  amount: number;
  ratio: number;
  ratioLabel: string;
  ok: boolean;
  violation: string;
  extraNote?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const inputCls =
    "rounded-md border border-input bg-background px-2 py-1 text-sm text-right tabular-nums w-40";
  const pct = (r: number) =>
    (Number.isFinite(r) ? (r * 100).toFixed(1) : "0") + "%";
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="w-32 text-muted-foreground">{label}</span>
      <AmountInput
        value={amount}
        onChange={onChange}
        disabled={disabled}
        className={inputCls + (ok ? "" : " border-rose-500")}
      />
      <span className="text-muted-foreground">원</span>
      <span className="text-[11px] tabular-nums text-slate-500">
        {pct(ratio)} ({ratioLabel})
      </span>
      {!ok && violation && (
        <span className="text-rose-600 text-[11px]">⚠ {violation}</span>
      )}
      {extraNote && (
        <span className="text-[11px] font-bold text-blue-600">— {extraNote}</span>
      )}
    </div>
  );
}

// 금액 input — 천 단위 콤마 자동 포맷 + 입력 시 콤마 자동 제거.
// type="text" + inputMode="numeric" 로 모바일 숫자 키패드도 호환.
function AmountInput({
  value,
  onChange,
  className,
  disabled,
  placeholder = "0",
}: {
  value: number;
  onChange: (v: number) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const display =
    !Number.isFinite(value) || value === 0
      ? ""
      : Math.round(value).toLocaleString("ko-KR");
  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      onChange={(e) => {
        const raw = e.target.value.replace(/,/g, "").replace(/[^\d-]/g, "");
        if (raw === "" || raw === "-") {
          onChange(0);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
    />
  );
}
