"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowLeft,
  BadgeCheck,
  Calculator,
  Download,
  FileDown,
  Lock,
  Mail,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  downloadPayStubPDF,
  exportPayStubPDF,
  type PayStubData,
} from "@/lib/payroll-export";
import { stripCommas } from "@/lib/billing";
import { sortDevelopersKo } from "@/lib/sort-developers";

type Status = "DRAFT" | "FINAL" | "PAID";
type Mode = "PAYROLL" | "WITHHOLDING";

type Item = {
  id: string;
  run_id: string;
  developer_id: string;
  developer_name?: string | null;
  developer_employment_type?: string | null;
  developer_email?: string | null;
  pdf_password?: string | null;
  mode: Mode;
  base_salary: string;
  position_allowance: string;
  overtime_pay: string;
  holiday_pay: string;
  annual_leave_pay: string;
  family_allowance: string;
  bonus: string;
  holiday_bonus: string;
  other_taxable: string;
  meal_allowance: string;
  car_allowance: string;
  childcare_allowance: string;
  research_allowance: string;
  expense_reimbursement: string;
  tuition: string;
  other_nontax: string;
  pension: string;
  health: string;
  long_term_care: string;
  employment_insurance: string;
  income_tax: string;
  local_tax: string;
  year_end_income_tax: string;
  year_end_local_tax: string;
  other_deduction: string;
  freelancer_gross: string;
  gross_taxable: string;
  gross_nontax: string;
  total_deduction: string;
  net_pay: string;
  memo?: string | null;
};

type Run = {
  id: string;
  year: number;
  month: number;
  status: Status;
  pay_date: string | null;
  is_year_end_adjustment: boolean;
  memo: string | null;
  item_count: number;
  total_gross_taxable: string;
  total_gross_nontax: string;
  total_deduction: string;
  total_net_pay: string;
};

const STATUS_LABEL: Record<Status, string> = {
  DRAFT: "작성 중",
  FINAL: "최종 확정",
  PAID: "지급 완료",
};

function fmt(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("ko-KR");
}

// 실수령액 표시용 — 원단위 절사 (10원 미만 버림).
function fmtNet(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0";
  const t = Math.trunc(n / 10) * 10;
  return t.toLocaleString("ko-KR");
}

// 편집 셀 display-input 값 포맷 (천 단위 comma, 정수만).
// backend 는 Decimal("200000.00") 처럼 소수점을 딸려 보내므로 반드시 truncate.
// 0 은 빈 문자열로 반환해 불필요한 "0" 표시 방지.
function displayInt(v: string | number | null | undefined): string {
  if (v == null || v === "") return "";
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString("en-US");
}

// 사용자 입력을 정수 문자열로 정규화. 빈 값·NaN → "0".
function parseIntCell(raw: string): string {
  const cleaned = stripCommas(raw).replace(/[^\d-]/g, "");
  if (!cleaned || cleaned === "-") return "0";
  const n = Math.trunc(Number(cleaned));
  return Number.isFinite(n) ? String(n) : "0";
}

// 실시간 계산용 — 서버 `recompute_totals` 와 동일한 공식으로 클라이언트에서
// 실수령·합계를 산출해 editMap 의 변경을 즉시 반영. 4대보험/소득세 자동 계산은
// 서버의 "자동 재계산" 버튼 몫이므로 여기서는 입력된 값들을 그대로 합산만.
type LiveTotals = {
  gross_taxable: number;
  gross_nontax: number;
  total_deduction: number;
  net_pay: number;
};
function computeLive(
  it: Item,
  override?: Partial<Item>,
): LiveTotals {
  const get = (k: keyof Item) =>
    Math.trunc(
      Number((override?.[k] as any) ?? (it[k] as any) ?? 0),
    ) || 0;

  if (it.mode === "WITHHOLDING") {
    const gross = get("freelancer_gross");
    const ded = get("income_tax") + get("local_tax") + get("other_deduction");
    return {
      gross_taxable: gross,
      gross_nontax: 0,
      total_deduction: ded,
      net_pay: gross - ded,
    };
  }
  const taxable =
    get("base_salary") +
    get("position_allowance") +
    get("overtime_pay") +
    get("holiday_pay") +
    get("annual_leave_pay") +
    get("family_allowance") +
    get("bonus") +
    get("holiday_bonus") +
    get("other_taxable");
  const nontax =
    get("meal_allowance") +
    get("car_allowance") +
    get("childcare_allowance") +
    get("research_allowance") +
    get("expense_reimbursement") +
    get("tuition") +
    get("other_nontax");
  const ded =
    get("pension") +
    get("health") +
    get("long_term_care") +
    get("employment_insurance") +
    get("income_tax") +
    get("local_tax") +
    get("year_end_income_tax") +
    get("year_end_local_tax") +
    get("other_deduction");
  return {
    gross_taxable: taxable,
    gross_nontax: nontax,
    total_deduction: ded,
    net_pay: taxable + nontax - ded,
  };
}

// 편집 가능한 column 정의 — (key, label, flag).
type ColKey = keyof Item;

const TAXABLE_COLS: { key: ColKey; label: string }[] = [
  { key: "base_salary", label: "기본급" },
  { key: "position_allowance", label: "직책수당" },
  { key: "overtime_pay", label: "연장" },
  { key: "holiday_pay", label: "휴일" },
  { key: "annual_leave_pay", label: "연차" },
  { key: "family_allowance", label: "가족" },
  { key: "bonus", label: "상여" },
  { key: "holiday_bonus", label: "명절상여" },
  { key: "other_taxable", label: "기타과세" },
];
const NONTAX_COLS: { key: ColKey; label: string }[] = [
  { key: "meal_allowance", label: "식대" },
  { key: "car_allowance", label: "차량유지비" },
  { key: "childcare_allowance", label: "육아" },
  { key: "research_allowance", label: "연구" },
  { key: "expense_reimbursement", label: "경비" },
  { key: "tuition", label: "학자금" },
  { key: "other_nontax", label: "기타" },
];
const DEDUCT_COLS: { key: ColKey; label: string }[] = [
  { key: "pension", label: "국민연금" },
  { key: "health", label: "건강" },
  { key: "long_term_care", label: "장기요양" },
  { key: "employment_insurance", label: "고용" },
  { key: "income_tax", label: "소득세" },
  { key: "local_tax", label: "지방소득세" },
  { key: "other_deduction", label: "기타공제" },
];
const YE_COLS: { key: ColKey; label: string }[] = [
  { key: "year_end_income_tax", label: "연말정산 소득세" },
  { key: "year_end_local_tax", label: "연말정산 지방소득세" },
];

export default function PayrollDetailPage() {
  const params = useParams<{ id: string }>();
  const runId = params.id;
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();

  const { data: run } = useQuery<Run>({
    queryKey: ["payroll-run", runId],
    queryFn: async () => (await api.get(`/payroll/runs/${runId}`)).data,
    staleTime: 0,
  });

  const { data: items = [] } = useQuery<Item[]>({
    queryKey: ["payroll-items", runId],
    queryFn: async () =>
      (await api.get(`/payroll/runs/${runId}/items`)).data,
    staleTime: 0,
  });

  const { data: company } = useQuery<any>({
    queryKey: ["company-profile"],
    queryFn: async () => (await api.get("/company-profile")).data,
    staleTime: 60_000,
  });

  type Distribution = {
    id: string;
    developer_id: string;
    developer_name?: string | null;
    method: string;
    to_email: string | null;
    pdf_size_bytes: number | null;
    status: "SENT" | "FAILED";
    error_msg: string | null;
    delivered_at: string | null;
  };
  const { data: distributions = [] } = useQuery<Distribution[]>({
    queryKey: ["payroll-distributions", runId],
    queryFn: async () =>
      (await api.get(`/payroll/runs/${runId}/distributions`)).data,
  });

  const [editMap, setEditMap] = useState<Record<string, Partial<Item>>>({});
  // 탭: 정규직/자사화(PAYROLL) / 프리랜서(WITHHOLDING). "전체" 탭은 제거.
  const [modeFilter, setModeFilter] = useState<Mode>("PAYROLL");
  // 포커스된 행의 id. 행 전체 배경 강조용.
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  // 체크박스 선택된 item id. 탭 전환/회차 변경 시 초기화.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddDialog, setShowAddDialog] = useState(false);

  useEffect(() => {
    setEditMap({});
    setSelectedIds(new Set());
  }, [runId, run?.status]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [modeFilter]);

  const readOnly = run?.status !== "DRAFT";

  const dirtyIds = Object.keys(editMap).filter(
    (id) => Object.keys(editMap[id] || {}).length > 0,
  );

  function update(id: string, patch: Partial<Item>) {
    setEditMap((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...patch },
    }));
  }

  function valueOf(it: Item, key: ColKey): string {
    const override = editMap[it.id]?.[key];
    const base = it[key];
    const v = override ?? base;
    return v == null ? "" : String(v);
  }

  const saveM = useMutation({
    mutationFn: async () => {
      for (const id of dirtyIds) {
        const patch = editMap[id];
        if (!patch || Object.keys(patch).length === 0) continue;
        // Send only the changed fields — values stringified from inputs.
        await api.patch(`/payroll/items/${id}`, patch);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-items", runId] });
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
      setEditMap({});
    },
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "저장 실패",
      );
    },
  });

  const recomputeM = useMutation({
    mutationFn: async () =>
      api.post(`/payroll/runs/${runId}/recompute`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-items", runId] });
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
      setEditMap({});
    },
  });

  const finalizeM = useMutation({
    mutationFn: async () => api.post(`/payroll/runs/${runId}/finalize`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
    },
  });
  const unfinalizeM = useMutation({
    mutationFn: async () => api.post(`/payroll/runs/${runId}/unfinalize`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
    },
  });
  const payM = useMutation({
    mutationFn: async () => api.post(`/payroll/runs/${runId}/mark-paid`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
    },
  });

  const addItemsM = useMutation({
    mutationFn: async (developer_ids: string[]) =>
      (
        await api.post(`/payroll/runs/${runId}/items`, { developer_ids })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-items", runId] });
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
      qc.invalidateQueries({
        queryKey: ["payroll-available-devs", runId],
      });
      setShowAddDialog(false);
    },
    onError: (e: any) => {
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "추가 실패");
    },
  });

  const deleteItemsM = useMutation({
    mutationFn: async (item_ids: string[]) =>
      api.delete(`/payroll/runs/${runId}/items`, { data: { item_ids } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-items", runId] });
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
      setSelectedIds(new Set());
    },
    onError: (e: any) => {
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "삭제 실패");
    },
  });

  const filtered = useMemo(
    () =>
      items
        .filter((i) => i.mode === modeFilter)
        .slice()
        .sort((a, b) =>
          (a.developer_name ?? "").localeCompare(
            b.developer_name ?? "",
            "ko-KR",
          ),
        ),
    [items, modeFilter],
  );

  // 전체 item 의 실시간 합계 (editMap 반영). 요약 카드 + 실수령 셀 표시용.
  const liveMap = useMemo(() => {
    const map = new Map<string, LiveTotals>();
    for (const it of items) {
      map.set(it.id, computeLive(it, editMap[it.id]));
    }
    return map;
  }, [items, editMap]);
  const liveTotals = useMemo(() => {
    let gt = 0,
      gn = 0,
      td = 0,
      np = 0;
    for (const v of liveMap.values()) {
      gt += v.gross_taxable;
      gn += v.gross_nontax;
      td += v.total_deduction;
      np += v.net_pay;
    }
    return { gt, gn, td, np };
  }, [liveMap]);

  // 고용형태별 인원 집계 — FULL_TIME(정규직), FREELANCER(프리랜서), INSOURCED(자사화).
  const headCount = useMemo(() => {
    let full = 0,
      free = 0,
      inso = 0;
    for (const it of items) {
      const t = (it.developer_employment_type ?? "").toUpperCase();
      if (t === "FULL_TIME") full += 1;
      else if (t === "FREELANCER") free += 1;
      else if (t === "INSOURCED") inso += 1;
    }
    return { full, free, inso };
  }, [items]);

  const toStub = (it: Item): PayStubData | null => {
    if (!run) return null;
    const n = (v: string | null | undefined) => Number(v ?? 0) || 0;
    return {
      company: {
        name: company?.name ?? "",
        business_no: company?.business_no ?? "",
        representative: company?.representative ?? "",
        address: company?.address ?? "",
        logo_name: company?.logo_name ?? null,
      },
      year: run.year,
      month: run.month,
      pay_date: run.pay_date,
      is_year_end_adjustment: run.is_year_end_adjustment,
      employee: {
        id: it.developer_id,
        name: it.developer_name ?? it.developer_id,
        employment_type: it.developer_employment_type ?? null,
      },
      mode: it.mode,
      base_salary: n(it.base_salary),
      position_allowance: n(it.position_allowance),
      overtime_pay: n(it.overtime_pay),
      holiday_pay: n(it.holiday_pay),
      annual_leave_pay: n(it.annual_leave_pay),
      family_allowance: n(it.family_allowance),
      bonus: n(it.bonus),
      holiday_bonus: n(it.holiday_bonus),
      other_taxable: n(it.other_taxable),
      meal_allowance: n(it.meal_allowance),
      car_allowance: n(it.car_allowance),
      childcare_allowance: n(it.childcare_allowance),
      research_allowance: n(it.research_allowance),
      expense_reimbursement: n(it.expense_reimbursement),
      tuition: n(it.tuition),
      other_nontax: n(it.other_nontax),
      pension: n(it.pension),
      health: n(it.health),
      long_term_care: n(it.long_term_care),
      employment_insurance: n(it.employment_insurance),
      income_tax: n(it.income_tax),
      local_tax: n(it.local_tax),
      year_end_income_tax: n(it.year_end_income_tax),
      year_end_local_tax: n(it.year_end_local_tax),
      other_deduction: n(it.other_deduction),
      freelancer_gross: n(it.freelancer_gross),
      gross_taxable: n(it.gross_taxable),
      gross_nontax: n(it.gross_nontax),
      total_deduction: n(it.total_deduction),
      net_pay: n(it.net_pay),
      memo: it.memo ?? null,
      pdf_password: it.pdf_password ?? null,
    };
  };

  async function downloadAllPdfs() {
    for (const it of filtered) {
      const stub = toStub(it);
      if (!stub) continue;
      await downloadPayStubPDF(stub);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const distributeM = useMutation({
    mutationFn: async (it: Item) => {
      const stub = toStub(it);
      if (!stub) throw new Error("run not loaded");
      const email = it.developer_email;
      if (!email) throw new Error("이메일이 등록되지 않은 직원입니다.");
      const blob = await exportPayStubPDF(stub);
      const fd = new FormData();
      fd.append(
        "file",
        new File(
          [blob],
          `급여명세서_${run!.year}-${String(run!.month).padStart(2, "0")}_${it.developer_name}.pdf`,
          { type: "application/pdf" },
        ),
      );
      fd.append("to_email", email);
      return (
        await api.post(
          `/payroll/runs/${runId}/distribute/${it.developer_id}`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        )
      ).data;
    },
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "배포 실패",
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll-distributions", runId] });
    },
  });

  const copyFromPrevM = useMutation({
    mutationFn: async () =>
      (await api.post(`/payroll/runs/${runId}/copy-from-previous`)).data,
    onSuccess: (data: Item[]) => {
      qc.invalidateQueries({ queryKey: ["payroll-items", runId] });
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
      setEditMap({});
      dialog.alert(`${data.length}명의 급여 정보를 이전 달에서 가져왔습니다.`);
    },
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "이전달 가져오기 실패",
      );
    },
  });

  if (!run) {
    return (
      <>
        <DashboardHeader title="급여 회차" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  const statusPill =
    run.status === "DRAFT"
      ? "bg-amber-50 border-amber-400 text-amber-800"
      : run.status === "FINAL"
        ? "bg-sky-50 border-sky-300 text-sky-700"
        : "bg-emerald-50 border-emerald-300 text-emerald-700";

  // 기본폭 (base_salary, 용역비, freelancer_gross 등) 96px.
  const inpBase =
    "w-24 text-right tabular-nums h-7 rounded border border-input bg-background px-1 text-xs disabled:opacity-60";
  // 좁은 폭 (나머지 수당/공제) 67px ≈ base 의 70%.
  const inpNarrowBase =
    "w-[67px] text-right tabular-nums h-7 rounded border border-input bg-background px-1 text-xs disabled:opacity-60";
  // 값이 음수면 빨간색 텍스트. tailwind JIT 처리용 전용 클래스.
  const inpClass = (
    raw: string | number | null | undefined,
    narrow = false,
  ) => {
    const base = narrow ? inpNarrowBase : inpBase;
    return Number(raw) < 0 ? base + " text-red-600 font-semibold" : base;
  };

  return (
    <>
      <DashboardHeader
        title={`급여 ${run.year}년 ${String(run.month).padStart(2, "0")}월${run.is_year_end_adjustment ? " (연말정산)" : ""}`}
        actions={
          <div className="flex gap-2 items-center flex-wrap">
            <Link
              href="/payroll"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
            <span
              className={
                "inline-flex items-center h-7 rounded-md border px-2 text-[11px] font-medium " +
                statusPill
              }
            >
              {STATUS_LABEL[run.status]}
            </span>
            <span className="text-xs text-muted-foreground">
              지급일 {run.pay_date ?? "-"} · 인원 {run.item_count}
            </span>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            <Tooltip
              side="bottom"
              label={
                readOnly
                  ? "DRAFT 상태에서만 저장 가능"
                  : `변경된 ${dirtyIds.length}명 저장`
              }
            >
              <button
                type="button"
                disabled={readOnly || dirtyIds.length === 0 || saveM.isPending}
                onClick={() => saveM.mutate()}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {saveM.isPending
                  ? "저장 중..."
                  : `저장${dirtyIds.length ? ` (${dirtyIds.length})` : ""}`}
              </button>
            </Tooltip>
            <Tooltip label="4대보험 요율 + 간이세액표 기반 자동 계산" side="bottom">
              <button
                type="button"
                disabled={readOnly || recomputeM.isPending}
                onClick={async () => {
                  if (
                    await dialog.confirm(
                      "전체 직원에 4대보험/소득세를 자동 재계산합니다. 수동 입력한 공제 값도 덮어써집니다. 계속할까요?",
                    )
                  ) {
                    recomputeM.mutate();
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                <Calculator className="h-3.5 w-3.5" />
                {recomputeM.isPending ? "계산 중..." : "자동 재계산"}
              </button>
            </Tooltip>

            <button
              type="button"
              onClick={downloadAllPdfs}
              disabled={filtered.length === 0}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              PDF
            </button>
            <Tooltip
              side="bottom"
              label={
                readOnly
                  ? "DRAFT 상태에서만 가져오기 가능"
                  : "이전 달 회차의 값을 현재 회차로 복사"
              }
            >
              <button
                type="button"
                disabled={readOnly || copyFromPrevM.isPending}
                onClick={async () => {
                  const prevY = run.month === 1 ? run.year - 1 : run.year;
                  const prevM = run.month === 1 ? 12 : run.month - 1;
                  if (
                    await dialog.confirm(
                      `${prevY}년 ${String(prevM).padStart(2, "0")}월 회차의 지급/공제 값을 현재 회차에 복사합니다. 기존 입력값은 덮어써집니다. 계속할까요?`,
                    )
                  ) {
                    copyFromPrevM.mutate();
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />
                {copyFromPrevM.isPending
                  ? "가져오는 중..."
                  : "이전 달에서 가져오기"}
              </button>
            </Tooltip>

            {run.status === "DRAFT" ? (
              dirtyIds.length > 0 ? (
                <Tooltip label="저장되지 않은 변경이 있습니다" side="bottom">
                  <button
                    type="button"
                    disabled={dirtyIds.length > 0 || finalizeM.isPending}
                    onClick={async () => {
                      if (
                        await dialog.confirm(
                          "회차를 최종 확정하시겠습니까? 이후 편집은 확정 취소 후 가능합니다.",
                        )
                      ) {
                        finalizeM.mutate();
                      }
                    }}
                    className="h-8 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-50 px-3 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                  >
                    <Lock className="h-3.5 w-3.5" />
                    최종 확정
                  </button>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  disabled={dirtyIds.length > 0 || finalizeM.isPending}
                  onClick={async () => {
                    if (
                      await dialog.confirm(
                        "회차를 최종 확정하시겠습니까? 이후 편집은 확정 취소 후 가능합니다.",
                      )
                    ) {
                      finalizeM.mutate();
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-50 px-3 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  최종 확정
                </button>
              )
            ) : run.status === "FINAL" ? (
              <>
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm("최종 확정을 취소하고 DRAFT 로 되돌립니다.")
                    ) {
                      unfinalizeM.mutate();
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-50 px-3 text-xs text-amber-700 hover:bg-amber-100"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  확정 취소
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      await dialog.confirm("이 회차를 지급 완료로 마킹하시겠습니까?")
                    ) {
                      payM.mutate();
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-50 px-3 text-xs text-emerald-700 hover:bg-emerald-100"
                >
                  <BadgeCheck className="h-3.5 w-3.5" />
                  지급 완료
                </button>
              </>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4 overflow-hidden">
        {/* Summary card */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <SummaryCard
            label="인원"
            value={
              <div className="flex items-baseline gap-2 flex-wrap">
                <span>{run.item_count}명</span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  정규직{" "}
                  <span className="tabular-nums">{headCount.full}</span>명 /
                  프리랜서{" "}
                  <span className="tabular-nums">{headCount.free}</span>명 /
                  자사화{" "}
                  <span className="tabular-nums">{headCount.inso}</span>명
                </span>
              </div>
            }
          />
          <SummaryCard label="총 과세" value={`${fmt(liveTotals.gt)}원`} />
          <SummaryCard label="총 비과세" value={`${fmt(liveTotals.gn)}원`} />
          <SummaryCard label="총 공제" value={`${fmt(liveTotals.td)}원`} />
          <SummaryCard
            label="실수령 합계"
            value={`${fmtNet(liveTotals.np)}원`}
            highlight
          />
        </div>

        {/* Mode filter */}
        <div className="flex gap-2 text-xs">
          {(["PAYROLL", "WITHHOLDING"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setModeFilter(m)}
              className={
                "h-7 rounded-md border px-3 " +
                (modeFilter === m
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-border bg-card hover:bg-muted")
              }
            >
              {m === "PAYROLL" ? "정규직/자사화" : "프리랜서"}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Tooltip
              side="bottom"
              label={
                readOnly
                  ? "DRAFT 상태에서만 추가 가능"
                  : "활성 직원 중 아직 없는 인원 추가"
              }
            >
              <button
                type="button"
                disabled={readOnly}
                onClick={() => setShowAddDialog(true)}
                className="h-7 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-50 px-3 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                추가
              </button>
            </Tooltip>
            <Tooltip
              side="bottom"
              label={
                readOnly
                  ? "DRAFT 상태에서만 삭제 가능"
                  : selectedIds.size === 0
                    ? "직원 체크박스 선택 후 사용"
                    : `선택된 ${selectedIds.size}명 삭제`
              }
            >
              <button
                type="button"
                disabled={
                  readOnly ||
                  selectedIds.size === 0 ||
                  deleteItemsM.isPending
                }
                onClick={async () => {
                  const targets = filtered.filter((i) =>
                    selectedIds.has(i.id),
                  );
                  if (targets.length === 0) return;
                  const names = targets
                    .map((i) => i.developer_name ?? i.developer_id.slice(0, 8))
                    .join(", ");
                  if (
                    await dialog.confirm(
                      `${targets.length}명 삭제할까요?\n\n${names}\n\n해당 직원의 편집 내용도 함께 사라집니다.`,
                    )
                  ) {
                    deleteItemsM.mutate(targets.map((t) => t.id));
                  }
                }}
                className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                삭제{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Items grid — 모드별 다른 컬럼 셋. 정규직/자사화는 풀 테이블,
            프리랜서는 기본급·기타·소득세·지방소득세 4컬럼 축약. */}
        {modeFilter === "PAYROLL" && (
        <div className="flex-[2] min-h-0 overflow-auto border border-border rounded-md bg-card">
          <table className="text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              {/* 1행: 그룹 라벨 (체크박스/직원/구분/실수령/명세서 는 rowSpan=2) */}
              <tr className="bg-muted/40">
                <th
                  rowSpan={2}
                  className="sticky left-0 z-20 text-center p-1 border-b border-r border-border"
                  style={{ width: 32, minWidth: 32, backgroundColor: "#ffffff" }}
                >
                  <input
                    type="checkbox"
                    disabled={readOnly || filtered.length === 0}
                    checked={
                      filtered.length > 0 &&
                      filtered.every((i) => selectedIds.has(i.id))
                    }
                    onChange={(e) => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) {
                          filtered.forEach((i) => next.add(i.id));
                        } else {
                          filtered.forEach((i) => next.delete(i.id));
                        }
                        return next;
                      });
                    }}
                    aria-label="전체 선택"
                  />
                </th>
                <th
                  rowSpan={2}
                  className="sticky z-20 text-center p-2 border-b border-r border-border whitespace-nowrap"
                  style={{ width: 80, minWidth: 80, left: 32, backgroundColor: "#ffffff" }}
                >
                  직원
                </th>
                <th
                  rowSpan={2}
                  className="sticky z-20 text-center p-2 border-b border-r-2 border-border whitespace-nowrap"
                  style={{
                    width: 80,
                    minWidth: 80,
                    left: 112,
                    backgroundColor: "#ffffff",
                  }}
                >
                  구분
                </th>
                <th
                  colSpan={TAXABLE_COLS.length}
                  className="text-center p-1.5 border-b border-r-2 border-border font-semibold"
                >
                  지급 · 과세
                </th>
                <th
                  colSpan={NONTAX_COLS.length}
                  className="text-center p-1.5 border-b border-r-2 border-border font-semibold bg-sky-50/60"
                >
                  지급 · 비과세
                </th>
                <th
                  colSpan={DEDUCT_COLS.length}
                  className={
                    "text-center p-1.5 border-b font-semibold bg-rose-50/60 " +
                    (run.is_year_end_adjustment ? "border-r-2 border-border" : "")
                  }
                >
                  공제
                </th>
                {run.is_year_end_adjustment && (
                  <th
                    colSpan={YE_COLS.length}
                    className="text-center p-1.5 border-b font-semibold bg-purple-50/60"
                  >
                    연말정산
                  </th>
                )}
                <th
                  rowSpan={2}
                  className="text-right p-2 border-b border-border sticky z-20 border-l-2 border-border"
                  style={{
                    width: 100,
                    minWidth: 100,
                    right: 88,
                    backgroundColor: "#DDDDDD",
                  }}
                >
                  실수령
                </th>
                <th
                  rowSpan={2}
                  className="text-center p-2 border-b border-border sticky z-20"
                  style={{
                    width: 88,
                    minWidth: 88,
                    right: 0,
                    backgroundColor: "#DDDDDD",
                  }}
                >
                  명세서
                </th>
              </tr>
              {/* 2행: 개별 컬럼 */}
              <tr className="bg-muted/40">
                {TAXABLE_COLS.map((c, i) => {
                  const isLast = i === TAXABLE_COLS.length - 1;
                  return (
                    <th
                      key={c.key}
                      className={
                        "text-center p-2 border-b border-border " +
                        (isLast ? "border-r-2" : "")
                      }
                    >
                      {c.label}
                    </th>
                  );
                })}
                {NONTAX_COLS.map((c, i) => {
                  const isLast = i === NONTAX_COLS.length - 1;
                  return (
                    <th
                      key={c.key}
                      className={
                        "text-center p-2 border-b border-border bg-sky-50/50 " +
                        (isLast ? "border-r-2" : "")
                      }
                    >
                      {c.label}
                    </th>
                  );
                })}
                {DEDUCT_COLS.map((c, i) => {
                  const isLast = i === DEDUCT_COLS.length - 1;
                  return (
                    <th
                      key={c.key}
                      className={
                        "text-center p-2 border-b border-border bg-rose-50/50 " +
                        (isLast && run.is_year_end_adjustment ? "border-r-2" : "")
                      }
                    >
                      {c.label}
                    </th>
                  );
                })}
                {run.is_year_end_adjustment &&
                  YE_COLS.map((c) => (
                    <th
                      key={c.key}
                      className="text-center p-2 border-b border-border bg-purple-50/50"
                    >
                      {c.label}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const isFree = it.mode === "WITHHOLDING";
                return (
                  <tr
                    key={it.id}
                    onFocusCapture={() => setFocusedRowId(it.id)}
                    onBlurCapture={(e) => {
                      // 포커스가 같은 행 내부로 이동하면 유지, 밖으로 빠지면 해제.
                      const next = e.relatedTarget as HTMLElement | null;
                      if (!e.currentTarget.contains(next)) {
                        setFocusedRowId((cur) => (cur === it.id ? null : cur));
                      }
                    }}
                    className={
                      "border-b border-border/50 " +
                      (focusedRowId === it.id
                        ? "bg-amber-50"
                        : "hover:bg-muted/20")
                    }
                  >
                    <td
                      className="sticky left-0 z-10 text-center p-1"
                      style={{
                        width: 32,
                        minWidth: 32,
                        backgroundColor:
                          focusedRowId === it.id ? "#fef3c7" : "#ffffff",
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={selectedIds.has(it.id)}
                        onChange={(e) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(it.id);
                            else next.delete(it.id);
                            return next;
                          });
                        }}
                        aria-label={`${it.developer_name ?? ""} 선택`}
                      />
                    </td>
                    <td
                      className="sticky z-10 p-2 font-medium whitespace-nowrap text-center"
                      style={{
                        width: 80,
                        minWidth: 80,
                        left: 32,
                        backgroundColor:
                          focusedRowId === it.id ? "#fef3c7" : "#ffffff",
                      }}
                    >
                      {it.developer_name ?? it.developer_id.slice(0, 8)}
                    </td>
                    <td
                      className="sticky z-10 text-center p-1 text-[11px]"
                      style={{
                        width: 80,
                        minWidth: 80,
                        left: 112,
                        backgroundColor:
                          focusedRowId === it.id ? "#fef3c7" : "#ffffff",
                      }}
                    >
                      <span
                        className={
                          "inline-block rounded px-1.5 py-0.5 " +
                          (isFree
                            ? "bg-orange-100 text-orange-700"
                            : "bg-sky-100 text-sky-700")
                        }
                      >
                        {isFree ? "프리랜서" : "월급제"}
                      </span>
                    </td>
                    {/* 프리랜서인 경우 freelancer_gross 입력만 첫 셀에 노출하고 나머지 과세 컬럼 비활성 */}
                    {isFree ? (
                      <>
                        <td className="p-1 text-right" colSpan={TAXABLE_COLS.length}>
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-[11px] text-muted-foreground">
                              용역비
                            </span>
                            <input
                              className={inpClass(
                                valueOf(it, "freelancer_gross"),
                              )}
                              disabled={readOnly}
                              type="text"
                              inputMode="numeric"
                              value={displayInt(
                                valueOf(it, "freelancer_gross"),
                              )}
                              onChange={(e) =>
                                update(it.id, {
                                  freelancer_gross: parseIntCell(
                                    e.target.value,
                                  ) as any,
                                })
                              }
                            />
                          </div>
                        </td>
                      </>
                    ) : (
                      TAXABLE_COLS.map((c, i) => {
                        const narrow = c.key !== "base_salary";
                        const isLast = i === TAXABLE_COLS.length - 1;
                        return (
                          <td
                            key={c.key}
                            className={
                              "p-1 text-right " +
                              (isLast ? "border-r-2 border-border" : "")
                            }
                          >
                            <input
                              className={inpClass(
                                valueOf(it, c.key),
                                narrow,
                              )}
                              disabled={readOnly}
                              type="text"
                              inputMode="numeric"
                              value={displayInt(valueOf(it, c.key))}
                              onChange={(e) =>
                                update(it.id, {
                                  [c.key]: parseIntCell(e.target.value),
                                } as any)
                              }
                            />
                          </td>
                        );
                      })
                    )}
                    {/* 비과세 */}
                    {NONTAX_COLS.map((c, i) => {
                      const isLast = i === NONTAX_COLS.length - 1;
                      return (
                      <td
                        key={c.key}
                        className={
                          "p-1 text-right bg-sky-50/20 " +
                          (isLast ? "border-r-2 border-border" : "")
                        }
                      >
                        <input
                          className={inpClass(
                            isFree ? "" : valueOf(it, c.key),
                            true,
                          )}
                          disabled={readOnly || isFree}
                          type="text"
                          inputMode="numeric"
                          value={
                            isFree ? "" : displayInt(valueOf(it, c.key))
                          }
                          onChange={(e) =>
                            update(it.id, {
                              [c.key]: parseIntCell(e.target.value),
                            } as any)
                          }
                        />
                      </td>
                      );
                    })}
                    {/* 공제 */}
                    {DEDUCT_COLS.map((c, i) => {
                      // 프리랜서는 소득세/지방소득세/기타공제만 의미. 4대보험은 비활성.
                      const disabledCol =
                        isFree &&
                        c.key !== "income_tax" &&
                        c.key !== "local_tax" &&
                        c.key !== "other_deduction";
                      const isLast = i === DEDUCT_COLS.length - 1;
                      return (
                        <td
                          key={c.key}
                          className={
                            "p-1 text-right bg-rose-50/20 " +
                            (isLast && run.is_year_end_adjustment
                              ? "border-r-2 border-border"
                              : "")
                          }
                        >
                          <input
                            className={inpClass(
                              disabledCol ? "" : valueOf(it, c.key),
                            )}
                            disabled={readOnly || disabledCol}
                            type="text"
                            inputMode="numeric"
                            value={
                              disabledCol
                                ? ""
                                : displayInt(valueOf(it, c.key))
                            }
                            onChange={(e) =>
                              update(it.id, {
                                [c.key]: parseIntCell(e.target.value),
                              } as any)
                            }
                          />
                        </td>
                      );
                    })}
                    {run.is_year_end_adjustment &&
                      YE_COLS.map((c) => (
                        <td key={c.key} className="p-1 text-right bg-purple-50/20">
                          <input
                            className={inpClass(
                              isFree ? "" : valueOf(it, c.key),
                            )}
                            disabled={readOnly || isFree}
                            type="text"
                            inputMode="numeric"
                            value={
                              isFree
                                ? ""
                                : displayInt(valueOf(it, c.key))
                            }
                            onChange={(e) =>
                              update(it.id, {
                                [c.key]: parseIntCell(e.target.value),
                              } as any)
                            }
                          />
                        </td>
                      ))}
                    {(() => {
                      const live =
                        liveMap.get(it.id)?.net_pay ?? Number(it.net_pay);
                      return (
                        <td
                          className={
                            "text-right p-2 tabular-nums font-semibold sticky z-10 border-l border-border " +
                            (live < 0 ? "text-red-600" : "")
                          }
                          style={{
                            width: 100,
                            minWidth: 100,
                            right: 88,
                            backgroundColor:
                              focusedRowId === it.id ? "#fef3c7" : "#DDDDDD",
                          }}
                        >
                          {fmtNet(live)}
                        </td>
                      );
                    })()}
                    <td
                      className="text-center p-1 sticky z-10 whitespace-nowrap"
                      style={{
                        width: 88,
                        minWidth: 88,
                        right: 0,
                        backgroundColor:
                          focusedRowId === it.id ? "#fef3c7" : "#DDDDDD",
                      }}
                    >
                      <button
                        type="button"
                        onClick={async () => {
                          const stub = toStub(it);
                          if (stub) await downloadPayStubPDF(stub);
                        }}
                        className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline mr-2"
                      >
                        <FileDown className="h-3 w-3" />
                        PDF
                      </button>
                      <Tooltip
                        side="top"
                        label={
                          !it.developer_email
                            ? "이메일 미등록"
                            : run.status === "DRAFT"
                              ? "FINAL 이후 배포 가능"
                              : "개별 메일 발송"
                        }
                      >
                        <button
                          type="button"
                          disabled={
                            !(run.status === "FINAL" || run.status === "PAID") ||
                            !it.developer_email ||
                            distributeM.isPending
                          }
                          onClick={async () => {
                            if (
                              await dialog.confirm(
                                `${it.developer_name} (${it.developer_email}) 에게 이메일 발송`,
                              )
                            ) {
                              distributeM.mutate(it);
                            }
                          }}
                          className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                        >
                          <Mail className="h-3 w-3" />
                          메일
                        </button>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      3 +
                      TAXABLE_COLS.length +
                      NONTAX_COLS.length +
                      DEDUCT_COLS.length +
                      (run.is_year_end_adjustment ? YE_COLS.length : 0) +
                      2
                    }
                    className="p-6 text-center text-muted-foreground"
                  >
                    정규직/자사화 직원이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        {modeFilter === "WITHHOLDING" && (
          <FreelancerTable
            filtered={filtered}
            liveMap={liveMap}
            readOnly={!!readOnly}
            focusedRowId={focusedRowId}
            setFocusedRowId={setFocusedRowId}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            valueOf={valueOf}
            update={update}
            inpClass={inpClass}
            toStub={toStub}
            distributeM={distributeM}
            runStatus={run.status}
            dialog={dialog}
          />
        )}

        {/* 배포 이력 (P4/P5) */}
        {distributions.length > 0 && (
          <div className="rounded-md border border-border bg-card p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">
                배포 이력 ({distributions.length}건)
              </h3>
              <span className="text-xs text-muted-foreground">
                FAILED 항목은 "재시도" 로 다시 발송할 수 있습니다.
              </span>
            </div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1">발송 일자</th>
                  <th>직원</th>
                  <th>수신</th>
                  <th className="text-right">크기</th>
                  <th>상태</th>
                  <th>비고</th>
                  <th className="text-right">작업</th>
                </tr>
              </thead>
              <tbody>
                {distributions.map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="py-1.5">{d.delivered_at ?? "-"}</td>
                    <td>{d.developer_name ?? d.developer_id.slice(0, 8)}</td>
                    <td className="font-mono">{d.to_email ?? "-"}</td>
                    <td className="text-right tabular-nums">
                      {d.pdf_size_bytes
                        ? `${(d.pdf_size_bytes / 1024).toFixed(1)} KB`
                        : "-"}
                    </td>
                    <td>
                      <span
                        className={
                          d.status === "SENT"
                            ? "text-emerald-700"
                            : "text-destructive"
                        }
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="text-muted-foreground truncate max-w-xs">
                      {d.error_msg ?? ""}
                    </td>
                    <td className="text-right">
                      {d.status === "FAILED" && (
                        <button
                          type="button"
                          onClick={() => {
                            const it = items.find(
                              (x) => x.developer_id === d.developer_id,
                            );
                            if (it) distributeM.mutate(it);
                          }}
                          className="inline-flex items-center gap-0.5 text-primary hover:underline"
                        >
                          <RotateCcw className="h-3 w-3" />
                          재시도
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAddDialog && (
        <AddEmployeeDialog
          runId={runId}
          pending={addItemsM.isPending}
          onClose={() => setShowAddDialog(false)}
          onSubmit={(ids) => addItemsM.mutate(ids)}
        />
      )}
    </>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border p-3 shadow-sm " +
        (highlight
          ? "border-emerald-300 bg-emerald-50"
          : "border-border bg-card")
      }
    >
      <div className="text-[11px] text-muted-foreground font-semibold">
        {label}
      </div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// 프리랜서 전용 축약 테이블: 직원 · 구분 · 기본급 · 기타 · 소득세 · 지방소득세 · 실수령 · 명세서.
// 기본급 = freelancer_gross (월 공제전 금액), 기타 = other_deduction (공제).
function FreelancerTable({
  filtered,
  liveMap,
  readOnly,
  focusedRowId,
  setFocusedRowId,
  selectedIds,
  setSelectedIds,
  valueOf,
  update,
  inpClass,
  toStub,
  distributeM,
  runStatus,
  dialog,
}: {
  filtered: Item[];
  liveMap: Map<string, LiveTotals>;
  readOnly: boolean;
  focusedRowId: string | null;
  setFocusedRowId: (id: string | null | ((cur: string | null) => string | null)) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  valueOf: (it: Item, key: ColKey) => string;
  update: (id: string, patch: Partial<Item>) => void;
  inpClass: (raw: string | number | null | undefined, narrow?: boolean) => string;
  toStub: (it: Item) => PayStubData | null;
  distributeM: ReturnType<typeof useMutation<any, any, Item, any>>;
  runStatus: Status;
  dialog: ReturnType<typeof useDialog>;
}) {
  return (
    <div className="flex-[2] min-h-0 overflow-auto border border-border rounded-md bg-card">
      <table className="text-xs border-collapse">
        <thead className="bg-muted/40 sticky top-0 z-10">
          <tr>
            <th
              className="sticky left-0 z-20 text-center p-1 border-b border-border"
              style={{ width: 32, minWidth: 32, backgroundColor: "#ffffff" }}
            >
              <input
                type="checkbox"
                disabled={readOnly || filtered.length === 0}
                checked={
                  filtered.length > 0 &&
                  filtered.every((i) => selectedIds.has(i.id))
                }
                onChange={(e) => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked)
                      filtered.forEach((i) => next.add(i.id));
                    else filtered.forEach((i) => next.delete(i.id));
                    return next;
                  });
                }}
                aria-label="전체 선택"
              />
            </th>
            <th
              className="sticky z-20 text-center p-2 border-b border-border whitespace-nowrap"
              style={{ width: 80, minWidth: 80, left: 32, backgroundColor: "#ffffff" }}
            >
              직원
            </th>
            <th
              className="sticky z-20 text-center p-2 border-b border-border whitespace-nowrap"
              style={{ width: 80, minWidth: 80, left: 112, backgroundColor: "#ffffff" }}
            >
              구분
            </th>
            <th className="text-center p-2 border-b border-border">기본급</th>
            <th className="text-center p-2 border-b border-border bg-rose-50/50">
              기타
            </th>
            <th className="text-center p-2 border-b border-border bg-rose-50/50">
              소득세
            </th>
            <th className="text-center p-2 border-b border-border bg-rose-50/50">
              지방소득세
            </th>
            <th
              className="text-right p-2 border-b border-border sticky z-20 border-l border-border"
              style={{
                width: 100,
                minWidth: 100,
                right: 88,
                backgroundColor: "#DDDDDD",
              }}
            >
              실수령
            </th>
            <th
              className="text-center p-2 border-b border-border sticky z-20"
              style={{
                width: 88,
                minWidth: 88,
                right: 0,
                backgroundColor: "#DDDDDD",
              }}
            >
              명세서
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td
                colSpan={9}
                className="p-6 text-center text-muted-foreground"
              >
                프리랜서 직원이 없습니다.
              </td>
            </tr>
          ) : (
            filtered.map((it) => (
              <tr
                key={it.id}
                onFocusCapture={() => setFocusedRowId(it.id)}
                onBlurCapture={(e) => {
                  const next = e.relatedTarget as HTMLElement | null;
                  if (!e.currentTarget.contains(next)) {
                    setFocusedRowId((cur) =>
                      cur === it.id ? null : cur,
                    );
                  }
                }}
                className={
                  "border-b border-border/50 " +
                  (focusedRowId === it.id
                    ? "bg-amber-50"
                    : "hover:bg-muted/20")
                }
              >
                <td
                  className="sticky left-0 z-10 text-center p-1"
                  style={{
                    width: 32,
                    minWidth: 32,
                    backgroundColor:
                      focusedRowId === it.id ? "#fef3c7" : "#ffffff",
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={selectedIds.has(it.id)}
                    onChange={(e) => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(it.id);
                        else next.delete(it.id);
                        return next;
                      });
                    }}
                    aria-label={`${it.developer_name ?? ""} 선택`}
                  />
                </td>
                <td
                  className="sticky z-10 p-2 font-medium whitespace-nowrap text-center"
                  style={{
                    width: 80,
                    minWidth: 80,
                    left: 32,
                    backgroundColor:
                      focusedRowId === it.id ? "#fef3c7" : "#ffffff",
                  }}
                >
                  {it.developer_name ?? it.developer_id.slice(0, 8)}
                </td>
                <td
                  className="sticky z-10 text-center p-1 text-[11px]"
                  style={{
                    width: 80,
                    minWidth: 80,
                    left: 112,
                    backgroundColor:
                      focusedRowId === it.id ? "#fef3c7" : "#ffffff",
                  }}
                >
                  <span className="inline-block rounded px-1.5 py-0.5 bg-orange-100 text-orange-700">
                    프리랜서
                  </span>
                </td>
                <td className="p-1 text-right">
                  <input
                    className={inpClass(valueOf(it, "freelancer_gross"))}
                    disabled={readOnly}
                    type="text"
                    inputMode="numeric"
                    value={displayInt(valueOf(it, "freelancer_gross"))}
                    onChange={(e) =>
                      update(it.id, {
                        freelancer_gross: parseIntCell(e.target.value) as any,
                      })
                    }
                  />
                </td>
                <td className="p-1 text-right bg-rose-50/20">
                  <input
                    className={inpClass(valueOf(it, "other_deduction"), true)}
                    disabled={readOnly}
                    type="text"
                    inputMode="numeric"
                    value={displayInt(valueOf(it, "other_deduction"))}
                    onChange={(e) =>
                      update(it.id, {
                        other_deduction: parseIntCell(e.target.value) as any,
                      })
                    }
                  />
                </td>
                <td className="p-1 text-right bg-rose-50/20">
                  <input
                    className={inpClass(valueOf(it, "income_tax"), true)}
                    disabled={readOnly}
                    type="text"
                    inputMode="numeric"
                    value={displayInt(valueOf(it, "income_tax"))}
                    onChange={(e) =>
                      update(it.id, {
                        income_tax: parseIntCell(e.target.value) as any,
                      })
                    }
                  />
                </td>
                <td className="p-1 text-right bg-rose-50/20">
                  <input
                    className={inpClass(valueOf(it, "local_tax"), true)}
                    disabled={readOnly}
                    type="text"
                    inputMode="numeric"
                    value={displayInt(valueOf(it, "local_tax"))}
                    onChange={(e) =>
                      update(it.id, {
                        local_tax: parseIntCell(e.target.value) as any,
                      })
                    }
                  />
                </td>
                {(() => {
                  const live =
                    liveMap.get(it.id)?.net_pay ?? Number(it.net_pay);
                  return (
                    <td
                      className={
                        "text-right p-2 tabular-nums font-semibold sticky z-10 border-l border-border " +
                        (live < 0 ? "text-red-600" : "")
                      }
                      style={{
                        width: 100,
                        minWidth: 100,
                        right: 88,
                        backgroundColor:
                          focusedRowId === it.id ? "#fef3c7" : "#DDDDDD",
                      }}
                    >
                      {fmtNet(live)}
                    </td>
                  );
                })()}
                <td
                  className="text-center p-1 sticky z-10 whitespace-nowrap"
                  style={{
                    width: 88,
                    minWidth: 88,
                    right: 0,
                    backgroundColor:
                      focusedRowId === it.id ? "#fef3c7" : "#DDDDDD",
                  }}
                >
                  <button
                    type="button"
                    onClick={async () => {
                      const stub = toStub(it);
                      if (stub) await downloadPayStubPDF(stub);
                    }}
                    className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline mr-2"
                  >
                    <FileDown className="h-3 w-3" />
                    PDF
                  </button>
                  <Tooltip
                    side="top"
                    label={
                      !it.developer_email
                        ? "이메일 미등록"
                        : runStatus === "DRAFT"
                          ? "FINAL 이후 배포 가능"
                          : "개별 메일 발송"
                    }
                  >
                    <button
                      type="button"
                      disabled={
                        !(runStatus === "FINAL" || runStatus === "PAID") ||
                        !it.developer_email ||
                        distributeM.isPending
                      }
                      onClick={async () => {
                        if (
                          await dialog.confirm(
                            `${it.developer_name} (${it.developer_email}) 에게 이메일 발송`,
                          )
                        ) {
                          distributeM.mutate(it);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                    >
                      <Mail className="h-3 w-3" />
                      메일
                    </button>
                  </Tooltip>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// 활성 직원 중 회차에 포함되지 않은 인원을 모달로 선택 후 추가.
type AvailableDev = {
  id: string;
  name: string;
  employment_type: string;
  email: string | null;
  monthly_salary: string;
};

function AddEmployeeDialog({
  runId,
  onClose,
  onSubmit,
  pending,
}: {
  runId: string;
  onClose: () => void;
  onSubmit: (ids: string[]) => void;
  pending: boolean;
}) {
  const { data: devs = [], isLoading } = useQuery<AvailableDev[]>({
    queryKey: ["payroll-available-devs", runId],
    queryFn: async () =>
      (await api.get(`/payroll/runs/${runId}/available-developers`)).data,
    staleTime: 0,
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const typeLabel = (t: string) => {
    const u = (t || "").toUpperCase();
    if (u === "FULL_TIME") return "정규직";
    if (u === "INSOURCED") return "자사화";
    if (u === "FREELANCER") return "프리랜서";
    return t || "-";
  };
  const typeBadge = (t: string) => {
    const u = (t || "").toUpperCase();
    if (u === "FREELANCER") return "bg-orange-100 text-orange-700";
    if (u === "INSOURCED") return "bg-purple-100 text-purple-700";
    return "bg-sky-100 text-sky-700";
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-[540px] max-w-full max-h-[80vh] rounded-lg bg-card border border-border shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">임직원 추가</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {isLoading ? (
            <div className="p-6 text-center text-muted-foreground text-xs">
              로딩 중...
            </div>
          ) : devs.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-xs">
              추가할 수 있는 직원이 없습니다. (모두 이미 포함되어 있거나 비활성 상태)
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="w-8 p-1 text-center">
                    <input
                      type="checkbox"
                      checked={picked.size === devs.length && devs.length > 0}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked
                            ? new Set(devs.map((d) => d.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="p-1 text-left">이름</th>
                  <th className="p-1 text-left">구분</th>
                  <th className="p-1 text-right">월급</th>
                  <th className="p-1 text-left">이메일</th>
                </tr>
              </thead>
              <tbody>
                {sortDevelopersKo(devs).map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-border/50 hover:bg-muted/30 cursor-pointer"
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(d.id)) next.delete(d.id);
                        else next.add(d.id);
                        return next;
                      })
                    }
                  >
                    <td className="p-1 text-center">
                      <input
                        type="checkbox"
                        checked={picked.has(d.id)}
                        onChange={() => {}}
                      />
                    </td>
                    <td className="p-1 font-medium">{d.name}</td>
                    <td className="p-1">
                      <span
                        className={
                          "inline-block rounded px-1.5 py-0.5 " +
                          typeBadge(d.employment_type)
                        }
                      >
                        {typeLabel(d.employment_type)}
                      </span>
                    </td>
                    <td className="p-1 text-right tabular-nums text-muted-foreground">
                      {Number(d.monthly_salary) > 0
                        ? Math.round(
                            Number(d.monthly_salary),
                          ).toLocaleString("ko-KR")
                        : "-"}
                    </td>
                    <td className="p-1 text-muted-foreground truncate max-w-[160px]">
                      {d.email ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="p-3 border-t border-border flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {picked.size}명 선택
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
            >
              취소
            </button>
            <button
              type="button"
              disabled={picked.size === 0 || pending}
              onClick={() => onSubmit(Array.from(picked))}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {pending ? "추가 중..." : `${picked.size}명 추가`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
