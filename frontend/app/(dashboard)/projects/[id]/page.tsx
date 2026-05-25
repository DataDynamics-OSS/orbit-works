"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { colorForId, formatKRW, formatMoney } from "@/lib/format";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { GanttChart } from "@/components/GanttChart";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import { TaxInvoiceDetailDialog } from "@/components/tax-invoices/TaxInvoiceDetailDialog";
import { sortDevelopersKo } from "@/lib/sort-developers";

type EmploymentType = "FREELANCER" | "FULL_TIME" | "INSOURCED";

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  FULL_TIME: "정규직",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
};

const EMPLOYMENT_BADGE: Record<EmploymentType, string> = {
  FULL_TIME: "bg-blue-100 text-blue-700 border-blue-200",
  FREELANCER: "bg-red-100 text-red-700 border-red-200",
  INSOURCED: "bg-orange-100 text-orange-700 border-orange-200",
};

// Bar / row-dot colors used on the Gantt chart, keyed by employment type.
const EMPLOYMENT_COLOR: Record<EmploymentType, string> = {
  FULL_TIME: "#3b82f6", // blue-500
  FREELANCER: "#ef4444", // red-500
  INSOURCED: "#f97316", // orange-500
};

type Developer = {
  id: string;
  name: string;
  employment_type: EmploymentType;
  roles?: string[];
  status: "ACTIVE" | "INACTIVE";
  color?: string;
};

type Assignment = {
  id: string;
  project_id: string;
  developer_id: string;
  developer_name?: string;
  project_name?: string;
  start_date: string;
  end_date: string;
  monthly_rate: string;
  is_insourced: boolean;
  allocation_percent?: string | number;
  color?: string;
  memo?: string;
};

type AssignmentForm = {
  developer_id: string;
  estimate_item_id: string;
  start_date: string;
  end_date: string;
  base_monthly: string;
  insurance_monthly: string;
  overhead_monthly: string;
  freelancer_monthly: string;
  is_insourced: boolean;
  allocation_percent: string;
  memo?: string;
};

const BLANK_ASN: AssignmentForm = {
  developer_id: "",
  estimate_item_id: "",
  start_date: "",
  end_date: "",
  base_monthly: "",
  insurance_monthly: "",
  overhead_monthly: "",
  freelancer_monthly: "",
  is_insourced: false,
  allocation_percent: "100",
  memo: "",
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: project } = useQuery<any>({
    queryKey: ["project", id],
    queryFn: async () => (await api.get(`/projects/${id}`)).data,
  });

  const { data: summary } = useQuery<any>({
    queryKey: ["project-summary", id],
    queryFn: async () => (await api.get(`/projects/${id}/cost-summary`)).data,
  });

  // 이 프로젝트에 매핑된 세금계산서 집계 (매입·매출 건수·총액). 상단 round box + 마진 계산에 사용.
  const { data: taxAgg } = useQuery<{
    purchase_count: number;
    purchase_total: number;
    sales_count: number;
    sales_total: number;
  }>({
    queryKey: ["project-tax-agg", id],
    queryFn: async () => {
      const [purch, sales] = await Promise.all([
        api.get("/tax-invoices", {
          params: {
            kind: "PURCHASE",
            linked_project_id: id,
            page: 1,
            page_size: 500,
          },
        }),
        api.get("/tax-invoices", {
          params: {
            kind: "SALES",
            linked_project_id: id,
            page: 1,
            page_size: 500,
          },
        }),
      ]);
      const sumTotal = (items: any[]) =>
        items.reduce((s, r) => s + (r.total_amount || 0), 0);
      return {
        purchase_count: purch.data.total as number,
        purchase_total: sumTotal(purch.data.items),
        sales_count: sales.data.total as number,
        sales_total: sumTotal(sales.data.items),
      };
    },
  });

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ["project-assignments", id],
    queryFn: async () =>
      (await api.get("/assignments", { params: { project_id: id } })).data,
  });

  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers-active"],
    queryFn: async () => (await api.get("/developers")).data,
  });

  // Narrow to developers active in the project (for gantt labels/colors)
  const projectDevelopers = useMemo<Developer[]>(() => {
    const ids = new Set(assignments.map((a) => a.developer_id));
    return developers.filter((d) => ids.has(d.id));
  }, [assignments, developers]);

  // Assignment modal
  const [asnOpen, setAsnOpen] = useState(false);
  const [asnForm, setAsnForm] = useState<AssignmentForm>(BLANK_ASN);
  const [asnEditingId, setAsnEditingId] = useState<string | null>(null);
  const [asnError, setAsnError] = useState<string | null>(null);
  const [ganttView, setGanttView] = useState<"developer" | "estimate">("developer");

  const createAssignment = useMutation({
    mutationFn: async () => {
      const base = num(asnForm.base_monthly);
      const ins = num(asnForm.insurance_monthly);
      const overhead = num(asnForm.overhead_monthly);
      const fl = num(asnForm.freelancer_monthly);
      const total = base + ins + overhead + fl;
      const allocRaw = Number(asnForm.allocation_percent);
      const alloc =
        Number.isFinite(allocRaw) && allocRaw > 0 ? Math.min(allocRaw, 100) : 100;
      const common = {
        estimate_item_id: asnForm.estimate_item_id || null,
        start_date: asnForm.start_date,
        end_date: asnForm.end_date,
        monthly_rate: total.toFixed(2),
        base_monthly: asnForm.base_monthly ? asnForm.base_monthly : null,
        insurance_monthly: asnForm.insurance_monthly ? asnForm.insurance_monthly : null,
        overhead_monthly: asnForm.overhead_monthly ? asnForm.overhead_monthly : null,
        freelancer_monthly: asnForm.freelancer_monthly ? asnForm.freelancer_monthly : null,
        is_insourced: asnForm.is_insourced,
        allocation_percent: alloc.toFixed(2),
        memo: asnForm.memo || undefined,
      };
      if (asnEditingId) {
        return (await api.patch(`/assignments/${asnEditingId}`, common)).data;
      }
      const payload = {
        ...common,
        project_id: id,
        developer_id: asnForm.developer_id,
      };
      return (await api.post("/assignments", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-assignments", id] });
      qc.invalidateQueries({ queryKey: ["project-summary", id] });
      qc.invalidateQueries({ queryKey: ["estimate-fulfillment", id] });
      qc.invalidateQueries({ queryKey: ["project-monthly-costs", id] });
      setAsnOpen(false);
      setAsnForm(BLANK_ASN);
      setAsnEditingId(null);
      setAsnError(null);
    },
    onError: (e: any) => {
      setAsnError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "추가 실패",
      );
    },
  });

  const deleteAssignment = useMutation({
    mutationFn: async (assignmentId: string) =>
      api.delete(`/assignments/${assignmentId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-assignments", id] });
      qc.invalidateQueries({ queryKey: ["project-summary", id] });
      qc.invalidateQueries({ queryKey: ["estimate-fulfillment", id] });
      qc.invalidateQueries({ queryKey: ["project-monthly-costs", id] });
    },
  });

  async function handleDeleteAssignment(aid: string) {
    if (
      await dialog.confirm("해당 투입을 삭제하시겠습니까?", {
        destructive: true,
      })
    ) {
      deleteAssignment.mutate(aid);
    }
  }

  if (!project)
    return (
      <>
        <DashboardHeader
          title="프로젝트"
          actions={
            <Link
              href="/projects"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
          }
        />
        <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">로딩 중...</div>
      </>
    );

  return (
    <>
      <DashboardHeader
        title={project.name}
        actions={
          <Link
            href="/projects"
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            목록
          </Link>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        <div className="grid grid-cols-4 gap-4">
          <Card
            label="총 사업비"
            value={formatMoney(
              project.total_contract_amount,
              project.contract_currency ?? "KRW",
            )}
            sub={
              (project.contract_currency ?? "KRW") === "USD" &&
              summary?.fx_rate_used ? (
                <>
                  ≈ {formatKRW(summary.contract_amount_krw)} @{" "}
                  {Number(summary.fx_rate_used).toLocaleString()}
                </>
              ) : undefined
            }
          />
          <Card
            label="총 투입 원가"
            value={formatKRW(summary?.total_cost)}
            sub={
              summary ? (
                <>
                  인력 {formatKRW(summary.personnel_cost)} + 매입{" "}
                  {formatKRW(summary.procurement_cost)}
                </>
              ) : undefined
            }
          />
          <Card
            label={`마진 (${((summary?.margin_ratio ?? 0) * 100).toFixed(1)}%)`}
            value={formatKRW(summary?.margin)}
          />
          {(() => {
            // 총 매입을 뺀 마진 = 계약금액(KRW) - 인력원가 - 매입 세금계산서 합계(VAT 포함).
            // 기존 마진은 procurement_cost(공급가액 기준)만 빼지만, 이 카드는
            // VAT 포함 전체 매입 합계를 추가로 차감해 보수적 마진을 보여준다.
            const contractKrw = Number(
              summary?.contract_amount_krw ?? project.total_contract_amount ?? 0,
            );
            const personnel = Number(summary?.personnel_cost ?? 0);
            const purchaseTotal = Number(taxAgg?.purchase_total ?? 0);
            const marginMinusPurchase = contractKrw - personnel - purchaseTotal;
            const ratio =
              contractKrw > 0 ? (marginMinusPurchase / contractKrw) * 100 : 0;
            return (
              <Card
                label={`총 매입을 뺀 마진 (${ratio.toFixed(1)}%)`}
                value={formatKRW(marginMinusPurchase)}
                sub={
                  taxAgg ? (
                    <>매입 합계 {formatKRW(purchaseTotal)} (VAT 포함)</>
                  ) : undefined
                }
              />
            );
          })()}
        </div>

        {/* 매입·매출 건수·금액 — 총 사업비 카드와 동일 디자인 (Card 컴포넌트 재사용) */}
        <div className="grid grid-cols-4 gap-4">
          <Card label="총 매입 건수" value={String(taxAgg?.purchase_count ?? 0)} />
          <Card label="총 매출 건수" value={String(taxAgg?.sales_count ?? 0)} />
          <Card label="총 매입 금액" value={formatKRW(taxAgg?.purchase_total ?? 0)} />
          <Card label="총 매출 금액" value={formatKRW(taxAgg?.sales_total ?? 0)} />
        </div>

        <EstimateEditor projectId={id} />

        {/* Assignments + Gantt */}
        <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-semibold">투입 인력</h2>
            <div className="ml-auto flex items-center gap-2">
              <div className="inline-flex rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setGanttView("developer")}
                  className={`px-3 h-8 text-xs ${
                    ganttView === "developer"
                      ? "bg-primary text-primary-foreground"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  개발자별
                </button>
                <button
                  type="button"
                  onClick={() => setGanttView("estimate")}
                  className={`px-3 h-8 text-xs border-l border-border ${
                    ganttView === "estimate"
                      ? "bg-primary text-primary-foreground"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  견적서별
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAsnForm({
                    ...BLANK_ASN,
                    start_date: project.start_date,
                    end_date: project.end_date,
                  });
                  setAsnEditingId(null);
                  setAsnError(null);
                  setAsnOpen(true);
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
              >
                <Plus className="h-3.5 w-3.5" />
                투입 인력 추가
              </button>
            </div>
          </div>

          {ganttView === "developer" ? (
            <>
              <AssignmentList
                assignments={assignments}
                developers={developers}
                onDelete={(aid) =>
                  handleDeleteAssignment(aid)
                }
              />

              <div className="mt-4 border-t border-border pt-4">
                <div className="text-xs font-semibold mb-2 text-muted-foreground">
                  기간: {project.start_date} ~ {project.end_date}
                </div>
                <GanttChart
                  assignments={assignments.map((a) => {
                    const dev = projectDevelopers.find((d) => d.id === a.developer_id);
                    const color = dev
                      ? EMPLOYMENT_COLOR[dev.employment_type]
                      : colorForId(a.developer_id);
                    return {
                      id: a.id,
                      developer_id: a.developer_id,
                      developer_name: a.developer_name,
                      project_id: a.project_id,
                      project_name: a.project_name ?? project.name,
                      start_date: a.start_date,
                      end_date: a.end_date,
                      is_insourced: a.is_insourced,
                      color,
                    };
                  })}
                  developers={projectDevelopers.map((d) => ({
                    id: d.id,
                    name: d.name,
                    color: EMPLOYMENT_COLOR[d.employment_type],
                  }))}
                  rangeStart={project.start_date}
                  rangeEnd={project.end_date}
                />
              </div>
            </>
          ) : (
            <EstimateGantt
              projectId={id}
              projectStart={project.start_date}
              projectEnd={project.end_date}
              onAddForSlot={(slotId, startDate, endDate) => {
                setAsnForm({
                  ...BLANK_ASN,
                  estimate_item_id: slotId ?? "",
                  start_date: startDate,
                  end_date: endDate,
                });
                setAsnEditingId(null);
                setAsnError(null);
                setAsnOpen(true);
              }}
              onEditAssignment={(aid) => {
                const a = assignments.find((x) => x.id === aid);
                if (!a) return;
                setAsnForm({
                  developer_id: a.developer_id,
                  estimate_item_id: (a as any).estimate_item_id ?? "",
                  start_date: a.start_date,
                  end_date: a.end_date,
                  base_monthly: "",
                  insurance_monthly: "",
                  overhead_monthly: "",
                  freelancer_monthly: "",
                  is_insourced: a.is_insourced,
                  allocation_percent:
                    a.allocation_percent != null
                      ? String(Number(a.allocation_percent))
                      : "100",
                  memo: a.memo ?? "",
                });
                setAsnEditingId(aid);
                setAsnError(null);
                setAsnOpen(true);
              }}
              onDeleteAssignment={(aid) => handleDeleteAssignment(aid)}
            />
          )}
        </section>

        <ProjectTaxInvoicesSection projectId={id} kind="PURCHASE" />

        <ProjectTaxInvoicesSection projectId={id} kind="SALES" />

        <CostCalculation projectId={id} />

        <MemoEditor projectId={id} initialMemo={project.memo ?? ""} />
      </div>

      {/* Assignment create/edit dialog */}
      <Dialog
        open={asnOpen}
        onClose={() => {
          setAsnOpen(false);
          setAsnEditingId(null);
        }}
        title={asnEditingId ? "인력 투입 수정" : "인력 투입 추가"}
        width="max-w-lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setAsnOpen(false);
                setAsnEditingId(null);
              }}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() =>
                asnForm.developer_id &&
                asnForm.start_date &&
                asnForm.end_date &&
                createAssignment.mutate()
              }
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              {asnEditingId ? (
                <>
                  <Save className="h-4 w-4" /> 저장
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> 추가
                </>
              )}
            </button>
          </>
        }
      >
        <AssignmentForm
          form={asnForm}
          setForm={setAsnForm}
          developers={developers}
          projectId={id}
        />
        {asnError && <div className="text-xs text-destructive mt-2">{asnError}</div>}
      </Dialog>
    </>
  );
}

function MemoEditor({
  projectId,
  initialMemo,
}: {
  projectId: string;
  initialMemo: string;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(initialMemo);
  const [saved, setSaved] = useState<string>(initialMemo);

  useEffect(() => {
    setValue(initialMemo);
    setSaved(initialMemo);
  }, [initialMemo]);

  const saveM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/projects/${projectId}`, { memo: value })).data,
    onSuccess: () => {
      setSaved(value);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const dirty = value !== saved;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold">메모</h2>
        <div className="flex items-center gap-2">
          {saveM.isSuccess && !dirty && (
            <span className="text-xs text-emerald-600">저장됨</span>
          )}
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={!dirty || saveM.isPending}
            className={`h-8 rounded-md px-3 text-sm ${
              dirty
                ? "bg-primary text-primary-foreground hover:bg-brand-dark"
                : "border border-border bg-background text-muted-foreground"
            } disabled:opacity-50`}
          >
            {saveM.isPending ? "저장 중..." : dirty ? "저장" : "변경 없음"}
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={8}
        placeholder="프로젝트 관련 메모를 자유롭게 입력하세요."
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
      />
    </section>
  );
}

function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AssignmentList({
  assignments,
  developers,
  onDelete,
}: {
  assignments: Assignment[];
  developers: Developer[];
  onDelete: (id: string) => void;
}) {
  if (assignments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">등록된 투입 인력이 없습니다.</p>
    );
  }
  const devMap = new Map(developers.map((d) => [d.id, d]));
  return (
    <ul className="divide-y divide-border rounded-md border border-border text-sm">
      {assignments.map((a) => {
        const dev = devMap.get(a.developer_id);
        const type = dev?.employment_type;
        return (
          <li key={a.id} className="flex items-center gap-3 px-3 py-2">
            <span className="font-medium w-28 truncate">
              {a.developer_name ?? dev?.name ?? "-"}
            </span>
            {type && (
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${EMPLOYMENT_BADGE[type]}`}
              >
                {EMPLOYMENT_LABEL[type]}
              </span>
            )}
            {dev?.roles && dev.roles.length > 0 && (
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                {dev.roles.join(", ")}
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {a.start_date} ~ {a.end_date} · 월 {Number(a.monthly_rate).toLocaleString()}원
              {a.is_insourced ? " · 자사화" : ""}
            </span>
            <button
              type="button"
              onClick={() => onDelete(a.id)}
              className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
            >
              <Trash2 className="h-3 w-3" />
              삭제
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type CostContext = {
  at: string;
  annual_salary: string | null;
  monthly_compensation: string;
  national_pension: string;
  health: string;
  long_term_care: string;
  employment: string;
  industrial_accident: string;
  insurance_total: string;
  salary_effective_from: string | null;
  rate_effective_from: string | null;
};

function AssignmentForm({
  form,
  setForm,
  developers,
  projectId,
}: {
  form: AssignmentForm;
  setForm: React.Dispatch<React.SetStateAction<AssignmentForm>>;
  developers: Developer[];
  projectId: string;
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  const { data: estimateItems = [] } = useQuery<EstimateItem[]>({
    queryKey: ["estimate-items", projectId],
    queryFn: async () =>
      (await api.get(`/projects/${projectId}/estimate-items`)).data,
  });

  const GRADE_LABEL_LOCAL: Record<EstimateGrade, string> = {
    PREMIUM: "특급",
    HIGH: "고급",
    MID: "중급",
    JUNIOR: "초급",
  };
  const stripZeros = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : "";
  };

  const grouped = useMemo(() => {
    const g: Record<EmploymentType, Developer[]> = {
      FULL_TIME: [],
      FREELANCER: [],
      INSOURCED: [],
    };
    for (const d of developers) g[d.employment_type]?.push(d);
    return g;
  }, [developers]);

  const selectedDev = developers.find((d) => d.id === form.developer_id);
  const type = selectedDev?.employment_type;

  const isFullTimeLike = type === "FULL_TIME" || type === "INSOURCED";
  const isFreelancerLike = type === "FREELANCER" || type === "INSOURCED";

  // Auto-fetch cost context so monthly_rate can be populated behind the scenes
  // using the developer's salary + effective 4대보험 rate at the assignment
  // start date. We no longer expose 월 비용 inputs — the individual's salary
  // history is the single source of truth.
  const { data: ctx } = useQuery<CostContext>({
    queryKey: ["cost-context", form.developer_id, form.start_date],
    enabled: Boolean(form.developer_id && form.start_date),
    queryFn: async () =>
      (
        await api.get(`/developers/${form.developer_id}/cost-context`, {
          params: { at: form.start_date },
        })
      ).data,
  });

  // Auto-fill hidden breakdown fields so the existing submit logic can still
  // compute monthly_rate = sum(base + insurance + overhead + freelancer).
  useEffect(() => {
    if (!ctx) return;
    const monthly = String(Math.round(Number(ctx.monthly_compensation || 0)));
    const insurance = String(Math.round(Number(ctx.insurance_total || 0)));
    setForm((p) => ({
      ...p,
      base_monthly: isFullTimeLike ? monthly : "",
      insurance_monthly: isFullTimeLike ? insurance : "",
      overhead_monthly: "",
      freelancer_monthly: isFreelancerLike && !isFullTimeLike ? monthly : "",
    }));
  }, [ctx, isFullTimeLike, isFreelancerLike, setForm]);

  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 col-span-2">
        <span className="text-xs text-muted-foreground">인력 *</span>
        <select
          value={form.developer_id}
          onChange={(e) => setForm((p) => ({ ...p, developer_id: e.target.value }))}
          className={input}
        >
          <option value="">선택</option>
          {(["FULL_TIME", "FREELANCER", "INSOURCED"] as EmploymentType[]).map((t) => {
            const devs = grouped[t];
            if (devs.length === 0) return null;
            const sorted = sortDevelopersKo(devs);
            return (
              <optgroup key={t} label={EMPLOYMENT_LABEL[t]}>
                {sorted.map((d) => {
                  const roles = d.roles && d.roles.length > 0 ? ` · ${d.roles.join(", ")}` : "";
                  const inactive = d.status !== "ACTIVE" ? " (퇴사)" : "";
                  return (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {roles}
                      {inactive}
                    </option>
                  );
                })}
              </optgroup>
            );
          })}
        </select>
      </label>

      <label className="flex flex-col gap-1 col-span-2">
        <span className="text-xs text-muted-foreground">
          견적서 항목 <span className="text-muted-foreground">(선택)</span>
        </span>
        <select
          value={form.estimate_item_id}
          onChange={(e) => setForm((p) => ({ ...p, estimate_item_id: e.target.value }))}
          className={input}
        >
          <option value="">선택 안 함</option>
          {estimateItems.map((it) => (
            <option key={it.id} value={it.id}>
              {(it.name || "(이름 없음)") +
                ` (${GRADE_LABEL_LOCAL[it.grade]}, ${stripZeros(it.months)}개월)`}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">투입 시작일</span>
        <DateInput
          value={form.start_date}
          onChange={(v) => setForm((p) => ({ ...p, start_date: v }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">투입 종료일</span>
        <DateInput
          value={form.end_date}
          onChange={(v) => setForm((p) => ({ ...p, end_date: v }))}
        />
      </label>

      <label className="flex flex-col gap-1 col-span-2">
        <span className="text-xs text-muted-foreground">투입 공수(%)</span>
        <input
          type="number"
          min={0}
          max={100}
          step="1"
          value={form.allocation_percent}
          onChange={(e) =>
            setForm((p) => ({ ...p, allocation_percent: e.target.value }))
          }
          className={input}
        />
        <span className="text-[11px] text-muted-foreground">
          풀타임 투입은 100. 60 = 월 원가의 60%만 이 프로젝트에 귀속.
        </span>
      </label>

      <label className="flex items-center gap-2 col-span-2 text-sm">
        <input
          type="checkbox"
          checked={form.is_insourced}
          onChange={(e) => setForm((p) => ({ ...p, is_insourced: e.target.checked }))}
        />
        자사화 인력 (비용 대신 자사 배정)
      </label>

      <label className="flex flex-col gap-1 col-span-2">
        <span className="text-xs text-muted-foreground">메모</span>
        <textarea
          value={form.memo ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
          rows={2}
          className={input}
        />
      </label>
    </div>
  );
}

function num(v: string | undefined | null): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatNumberInput(v: string): string {
  if (!v) return "";
  const digits = v.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}

type MonthlyCostCell = {
  month: string;
  monthly_comp: string;
  insurance: string;
  freelancer: string;
  overlap_days: number;
  days_in_month: number;
  cost: string;
  revenue: string;
  profit: string;
  projected?: boolean;
};
type MonthlyCostRow = {
  developer_id: string;
  developer_name: string;
  employment_type: "FULL_TIME" | "FREELANCER" | "INSOURCED";
  cells: MonthlyCostCell[];
  total: string;
  total_revenue: string;
  total_profit: string;
};
type MonthlyCostMatrix = {
  project_id: string;
  start_date: string;
  end_date: string;
  months: string[];
  delay_months: string[];
  rows: MonthlyCostRow[];
  monthly_totals: string[];
  monthly_revenues: string[];
  monthly_profits: string[];
  grand_total: string;
  grand_revenue: string;
  grand_profit: string;
};

const EMP_BADGE: Record<MonthlyCostRow["employment_type"], string> = {
  FULL_TIME: "bg-blue-100 text-blue-700 border-blue-200",
  FREELANCER: "bg-red-100 text-red-700 border-red-200",
  INSOURCED: "bg-orange-100 text-orange-700 border-orange-200",
};
const EMP_LABEL: Record<MonthlyCostRow["employment_type"], string> = {
  FULL_TIME: "정규직",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
};

function CostCalculation({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery<MonthlyCostMatrix>({
    queryKey: ["project-monthly-costs", projectId],
    queryFn: async () =>
      (await api.get(`/projects/${projectId}/monthly-costs`)).data,
  });

  if (isLoading)
    return (
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h2 className="font-semibold mb-3">비용 계산</h2>
        <p className="text-sm text-muted-foreground">계산 중...</p>
      </section>
    );
  if (!data)
    return (
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h2 className="font-semibold mb-3">비용 계산</h2>
        <p className="text-sm text-muted-foreground">표시할 데이터가 없습니다.</p>
      </section>
    );

  // 인력 컬럼 — 이전 9.8rem 에서 +10% (이름 + 배지 한 줄 표시 여유).
  const NAME_W = "10.78rem";
  const TOTAL_W = "9rem";
  const fmt = (v: string | number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return "-";
    return Math.round(n).toLocaleString() + "원";
  };
  const delaySet = new Set(data.delay_months);
  const isDelay = (m: string) => delaySet.has(m);
  const delayColCls = "bg-red-50/40";
  const anyProjected = data.rows.some((r) => r.cells.some((c) => c.projected));
  const hasDelay = data.delay_months.length > 0;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">비용 계산</h2>
        <span className="text-sm text-muted-foreground">
          회사 지출 기준 (월 보수 + 회사 부담 4대보험 + 프리랜서 단가)
        </span>
      </div>
      {anyProjected && (
        <div className="text-sm text-blue-600 mb-2">
          ※ 파란색 숫자는 마지막 연봉 계약 종료 이후 마지막 연봉을 기준으로 한 추정치입니다.
        </div>
      )}
      {hasDelay && (
        <div className="text-sm text-red-600 mb-2">
          ※ 붉은 배경 컬럼은 프로젝트 종료일({data.end_date}) 이후의 지연 투입 구간입니다.
          해당 기간의 매출은 견적서 상한을 초과할 수 없어 수익이 음수로 계산됩니다.
        </div>
      )}
      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          투입된 인력이 없거나 비용 데이터가 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="text-sm border-collapse border border-border table-fixed"
            style={{
              width: `calc(${NAME_W} + ${TOTAL_W} + ${data.months.length} * 7.5rem)`,
            }}
          >
            <colgroup>
              <col style={{ width: NAME_W }} />
              <col style={{ width: TOTAL_W }} />
              {data.months.map((m) => (
                <col key={m} style={{ width: "7.5rem" }} />
              ))}
            </colgroup>
            <thead className="text-sm text-muted-foreground">
              <tr>
                <th
                  className="border border-border bg-muted/30 sticky left-0 z-20 px-2 py-1 text-left"
                  style={{ width: NAME_W }}
                >
                  인력
                </th>
                <th
                  className="border border-border bg-muted/40 sticky z-20 px-2 py-1 text-right"
                  style={{ left: NAME_W, width: TOTAL_W }}
                >
                  합계
                </th>
                {data.months.map((m) => (
                  <th
                    key={m}
                    className={`border border-border px-2 py-1 text-right whitespace-nowrap ${
                      isDelay(m) ? `${delayColCls} text-red-600 group/tt relative` : ""
                    }`}
                  >
                    {m}
                    {isDelay(m) && <span className="ml-1 text-[10px]">지연</span>}
                    {isDelay(m) && (
                      <Tooltip label="프로젝트 종료일 이후 지연 구간" side="top" inline />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.developer_id}>
                  <td
                    className="border border-border bg-card sticky left-0 z-10 px-2 py-1.5"
                    style={{ width: NAME_W }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{r.developer_name}</span>
                      <span
                        className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] leading-4 font-medium shrink-0 ${EMP_BADGE[r.employment_type]}`}
                      >
                        {EMP_LABEL[r.employment_type]}
                      </span>
                    </div>
                  </td>
                  <td
                    className="border border-border bg-muted/40 sticky z-10 px-2 py-1.5 text-right tabular-nums font-semibold"
                    style={{ left: NAME_W, width: TOTAL_W }}
                  >
                    {fmt(r.total)}
                  </td>
                  {r.cells.map((c) => {
                    const tooltipLabel =
                      c.overlap_days > 0
                        ? `${c.projected ? "(추정) " : ""}보수 ${Math.round(
                            Number(c.monthly_comp),
                          ).toLocaleString()}원 + 보험 ${Math.round(
                            Number(c.insurance),
                          ).toLocaleString()}원${
                            Number(c.freelancer) > 0
                              ? " + 프리랜서 " +
                                Math.round(Number(c.freelancer)).toLocaleString() +
                                "원"
                              : ""
                          } · ${c.overlap_days}/${c.days_in_month}일`
                        : "";
                    return (
                      <td
                        key={c.month}
                        className={`border border-border px-2 py-1.5 text-right tabular-nums ${
                          isDelay(c.month) ? delayColCls : ""
                        } ${c.projected ? "text-blue-600" : ""} ${
                          tooltipLabel ? "group/tt relative" : ""
                        }`}
                      >
                        {fmt(c.cost)}
                        {tooltipLabel && (
                          <Tooltip label={tooltipLabel} side="top" inline />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td
                  className="border border-border bg-muted/40 sticky left-0 z-10 px-2 py-1.5 font-semibold"
                  style={{ width: NAME_W }}
                >
                  월 원가
                </td>
                <td
                  className="border border-border bg-muted sticky z-10 px-2 py-1.5 text-right tabular-nums font-bold"
                  style={{ left: NAME_W, width: TOTAL_W }}
                >
                  {fmt(data.grand_total)}
                </td>
                {data.monthly_totals.map((v, i) => (
                  <td
                    key={i}
                    className={`border border-border bg-muted/40 px-2 py-1.5 text-right tabular-nums font-semibold ${
                      isDelay(data.months[i]) ? delayColCls : ""
                    }`}
                  >
                    {fmt(v)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type EstimateGrade = "PREMIUM" | "HIGH" | "MID" | "JUNIOR";
type EstimateItem = {
  id?: string;
  project_id?: string;
  name: string;
  grade: EstimateGrade;
  unit_rate: string;
  months: string;
  discount_rate: string;
  position?: number;
};

const BLANK_ESTIMATE: EstimateItem = {
  name: "",
  grade: "MID",
  unit_rate: "",
  months: "1",
  discount_rate: "0",
};

function EstimateEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<EstimateItem[]>([]);
  const [initialKey, setInitialKey] = useState<string>(""); // for dirty check

  const { data } = useQuery<EstimateItem[]>({
    queryKey: ["estimate-items", projectId],
    queryFn: async () =>
      (await api.get(`/projects/${projectId}/estimate-items`)).data,
  });

  // Seed local state when server data arrives (first time or after save).
  // Numeric fields come back as zero-padded strings (e.g. "9350000.00") from
  // Postgres NUMERIC — normalize so the comma-formatter doesn't misread them.
  useEffect(() => {
    if (!data) return;
    const stripZeros = (v: unknown, fallback = "") => {
      if (v == null || v === "") return fallback;
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return String(n); // "9350000.00" → "9350000", "1.50" → "1.5"
    };
    const rows = data.map((r) => ({
      ...r,
      name: r.name ?? "",
      grade: (r.grade ?? "MID") as EstimateGrade,
      unit_rate: stripZeros(r.unit_rate, ""),
      months: stripZeros(r.months, "1"),
      discount_rate: stripZeros(r.discount_rate, "0"),
    }));
    setItems(rows);
    setInitialKey(JSON.stringify(rows));
  }, [data]);

  const saveM = useMutation({
    mutationFn: async () => {
      const payload = {
        items: items.map((r) => ({
          id: r.id ?? undefined,
          name: r.name,
          grade: r.grade,
          unit_rate: r.unit_rate === "" ? "0" : r.unit_rate,
          months: r.months === "" ? "0" : r.months,
          discount_rate: r.discount_rate === "" ? "0" : r.discount_rate,
        })),
      };
      return (await api.put(`/projects/${projectId}/estimate-items`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["estimate-items", projectId] });
      // 총 사업비는 견적서 합계로 서버에서 동기화되므로 프로젝트/요약 캐시도 갱신
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["project-summary", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      // 라인의 개월이 줄어들면 서버가 assignments end_date 를 클램프하므로 갱신
      qc.invalidateQueries({ queryKey: ["project-assignments", projectId] });
      qc.invalidateQueries({ queryKey: ["estimate-fulfillment", projectId] });
      qc.invalidateQueries({ queryKey: ["project-monthly-costs", projectId] });
    },
  });

  const dirty = JSON.stringify(items) !== initialKey;

  function lineTotal(r: EstimateItem): number {
    const u = Number(r.unit_rate) || 0;
    const m = Number(r.months) || 0;
    const d = Number(r.discount_rate) || 0;
    return u * m * (1 - d / 100);
  }
  const grandTotal = items.reduce((acc, r) => acc + lineTotal(r), 0);

  function updateRow(idx: number, patch: Partial<EstimateItem>) {
    setItems((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setItems((prev) => [...prev, { ...BLANK_ESTIMATE }]);
  }
  function removeRow(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  const input =
    "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">견적서</h2>
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={!dirty || saveM.isPending}
          className={`h-8 rounded-md px-3 text-sm ${
            dirty
              ? "bg-primary text-primary-foreground hover:bg-brand-dark"
              : "border border-border bg-background text-muted-foreground"
          } disabled:opacity-50`}
        >
          {saveM.isPending ? "저장 중..." : dirty ? "저장" : "변경 없음"}
        </button>
      </div>

      <table className="w-full text-sm border-collapse border border-border table-fixed">
        <colgroup>
          <col style={{ width: "3rem" }} />
          <col />
          <col style={{ width: "8rem" }} />
          <col style={{ width: "10rem" }} />
          <col style={{ width: "5rem" }} />
          <col style={{ width: "5rem" }} />
          <col style={{ width: "12rem" }} />
          <col style={{ width: "3rem" }} />
        </colgroup>
        <thead className="text-sm text-muted-foreground">
          <tr>
            <th className="border border-border bg-muted/30 px-2 py-1 text-center">
              #
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-left">
              명칭
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-center">
              등급
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-right">
              단가
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-right">
              개월
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-right">
              할인%
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-right">
              합계
            </th>
            <th className="border border-border bg-muted/30 px-2 py-1 text-center">
              —
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, idx) => (
            <tr key={idx}>
              <td className="border border-border text-center text-muted-foreground">
                {idx + 1}
              </td>
              <td className="border border-border p-1">
                <input
                  value={r.name}
                  onChange={(e) => updateRow(idx, { name: e.target.value })}
                  placeholder="예: 시스템 분석가"
                  className={input}
                />
              </td>
              <td className="border border-border p-1">
                <select
                  value={r.grade}
                  onChange={(e) =>
                    updateRow(idx, { grade: e.target.value as EstimateGrade })
                  }
                  className={input}
                >
                  <option value="PREMIUM">특급</option>
                  <option value="HIGH">고급</option>
                  <option value="MID">중급</option>
                  <option value="JUNIOR">초급</option>
                </select>
              </td>
              <td className="border border-border p-1">
                <input
                  type="text"
                  inputMode="numeric"
                  value={formatNumberInput(r.unit_rate)}
                  onChange={(e) =>
                    updateRow(idx, {
                      unit_rate: e.target.value.replace(/[^0-9]/g, ""),
                    })
                  }
                  placeholder="0"
                  className={`${input} text-right`}
                />
              </td>
              <td className="border border-border p-1">
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={r.months}
                  onChange={(e) => updateRow(idx, { months: e.target.value })}
                  className={`${input} text-right`}
                />
              </td>
              <td className="border border-border p-1">
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  max={100}
                  value={r.discount_rate}
                  onChange={(e) =>
                    updateRow(idx, { discount_rate: e.target.value })
                  }
                  className={`${input} text-right`}
                />
              </td>
              <td className="border border-border px-2 py-1.5 text-right tabular-nums font-medium">
                {Math.round(lineTotal(r)).toLocaleString()}원
              </td>
              <td className="border border-border text-center">
                <Tooltip label="이 행 삭제" side="top">
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    className="h-7 w-7 rounded-md text-destructive hover:bg-destructive/10"
                  >
                    ×
                  </button>
                </Tooltip>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td
                colSpan={8}
                className="border border-border px-2 py-4 text-center text-muted-foreground text-sm"
              >
                등록된 라인이 없습니다. 아래 "+ 행 추가" 를 눌러 시작하세요.
              </td>
            </tr>
          )}
          <tr>
            <td
              colSpan={6}
              className="border border-border bg-muted/40 px-2 py-1.5 font-semibold"
            >
              총 합계
            </td>
            <td className="border border-border bg-muted/40 px-2 py-1.5 text-right tabular-nums font-bold">
              {Math.round(grandTotal).toLocaleString()}원
            </td>
            <td className="border border-border bg-muted/40" />
          </tr>
        </tbody>
      </table>

      <div className="mt-3 flex">
        <button
          type="button"
          onClick={addRow}
          className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
        >
          <Plus className="h-4 w-4" />
          행 추가
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 견적서별 Gantt 뷰 (parent row = estimate line, child rows = assignments)
// ---------------------------------------------------------------------------

type FulfillStatus = "DONE" | "PARTIAL" | "EMPTY";
type FulfillAssignment = {
  id: string;
  developer_id: string;
  developer_name: string;
  employment_type: "FULL_TIME" | "FREELANCER" | "INSOURCED";
  start_date: string;
  end_date: string;
  is_insourced: boolean;
  monthly_rate: string;
};
type FulfillItem = {
  estimate_item: EstimateItem & { id: string; months: string | number };
  required_months: string;
  assigned_months: string;
  status: FulfillStatus;
  assignments: FulfillAssignment[];
};
type FulfillmentData = {
  project_id: string;
  project_start: string;
  project_end: string;
  items: FulfillItem[];
  unassigned: FulfillAssignment[];
};

const STATUS_STYLE: Record<FulfillStatus, { dot: string; label: string; text: string }> = {
  DONE: { dot: "bg-emerald-500", label: "완료", text: "text-emerald-700" },
  PARTIAL: { dot: "bg-amber-500", label: "부족", text: "text-amber-700" },
  EMPTY: { dot: "bg-slate-400", label: "미배정", text: "text-slate-600" },
};

function EstimateGantt({
  projectId,
  projectStart,
  projectEnd,
  onAddForSlot,
  onEditAssignment,
  onDeleteAssignment,
}: {
  projectId: string;
  projectStart: string;
  projectEnd: string;
  onAddForSlot: (
    slotId: string | null,
    startDate: string,
    endDate: string,
  ) => void;
  onEditAssignment: (assignmentId: string) => void;
  onDeleteAssignment: (assignmentId: string) => void;
}) {
  const { data } = useQuery<FulfillmentData>({
    queryKey: ["estimate-fulfillment", projectId],
    queryFn: async () =>
      (await api.get(`/projects/${projectId}/estimate-fulfillment`)).data,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!data) {
    return <p className="text-sm text-muted-foreground">로딩 중...</p>;
  }

  const DAY_MS = 86_400_000;
  const ROW_HEIGHT = 36;
  const LABEL_WIDTH = 280;
  const rangeStart = new Date(`${projectStart}T00:00:00`);
  const rangeEnd = new Date(new Date(`${projectEnd}T00:00:00`).getTime() + DAY_MS);
  const totalMs = Math.max(rangeEnd.getTime() - rangeStart.getTime(), DAY_MS);
  const pct = (d: Date) => ((d.getTime() - rangeStart.getTime()) / totalMs) * 100;

  // Month ticks
  const months: Date[] = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cursor < rangeEnd) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  function renderChildBars(asns: FulfillAssignment[], rowColor: string) {
    return asns.map((a) => {
      const s = new Date(`${a.start_date}T00:00:00`);
      const e = new Date(`${a.end_date}T00:00:00`);
      const endExclusive = new Date(e.getTime() + DAY_MS);
      const left = Math.max(0, pct(s));
      const right = Math.min(100, pct(endExclusive));
      const width = right - left;
      if (width <= 0) return null;
      return (
        <div
          key={a.id}
          className="group/tt absolute cursor-pointer"
          style={{
            left: `${left}%`,
            width: `${width}%`,
            top: 4,
            height: ROW_HEIGHT - 8,
          }}
          onClick={(ev) => {
            ev.stopPropagation();
            onEditAssignment(a.id);
          }}
        >
          <div
            className="h-full w-full rounded px-2 text-sm text-white flex items-center overflow-hidden whitespace-nowrap shadow-sm"
            style={{
              backgroundColor: rowColor,
              border: a.is_insourced ? "2px dashed rgba(255,255,255,0.7)" : undefined,
            }}
          >
            {a.developer_name}
          </div>
          <Tooltip
            inline
            side="top"
            label={`${a.developer_name} · ${a.start_date} ~ ${a.end_date} (클릭 편집)`}
          />
        </div>
      );
    });
  }

  return (
    <div>
      {/* Month header */}
      <div className="flex border-b border-border">
        <div
          className="shrink-0 px-3 py-2 text-sm font-semibold bg-muted/40 border-r border-border"
          style={{ width: LABEL_WIDTH }}
        >
          견적서 라인
        </div>
        <div className="flex-1 relative bg-muted/20 h-9">
          {months.map((m, i) => {
            const left = pct(m);
            return (
              <div
                key={i}
                className="absolute top-0 h-full border-l border-border text-sm text-muted-foreground"
                style={{ left: `${left}%` }}
              >
                <span className="pl-1">
                  {m.getFullYear()}.{String(m.getMonth() + 1).padStart(2, "0")}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Items */}
      {data.items.length === 0 && data.unassigned.length === 0 && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          견적서 라인과 투입이 없습니다. 위의 "+ 투입 인력 추가" 또는 견적서 작성 후
          사용하세요.
        </div>
      )}

      {data.items.map((it, idx) => {
        const isOpen = expanded[it.estimate_item.id] ?? true;
        const color = PROJECT_PALETTE[idx % PROJECT_PALETTE.length];
        const sstyle = STATUS_STYLE[it.status];

        return (
          <div key={it.estimate_item.id}>
            {/* Parent row */}
            <div
              className="flex border-b border-border hover:bg-muted/30 cursor-pointer"
              style={{ minHeight: ROW_HEIGHT }}
              onClick={() =>
                setExpanded((p) => ({
                  ...p,
                  [it.estimate_item.id]: !isOpen,
                }))
              }
            >
              <div
                className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-sm border-r border-border bg-card"
                style={{ width: LABEL_WIDTH }}
              >
                <span className="w-4 text-muted-foreground">
                  {isOpen ? "▼" : "▶"}
                </span>
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {it.estimate_item.name || "(이름 없음)"}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {it.estimate_item.grade === "PREMIUM"
                      ? "특급"
                      : it.estimate_item.grade === "HIGH"
                      ? "고급"
                      : it.estimate_item.grade === "MID"
                      ? "중급"
                      : "초급"}
                    {" · "}
                    {Number(it.estimate_item.months)}개월{" · "}
                    <span className={`inline-flex items-center gap-1 ${sstyle.text}`}>
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${sstyle.dot}`}
                      />
                      {sstyle.label} ({Number(it.assigned_months)}/
                      {Number(it.required_months)})
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex-1 relative" style={{ minHeight: ROW_HEIGHT }}>
                {months.map((m, i) => {
                  const left = pct(m);
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-full border-l border-border/50"
                      style={{ left: `${left}%` }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Child assignment rows */}
            {isOpen && (
              <>
                {it.assignments.map((a) => (
                  <div
                    key={a.id}
                    className="flex border-b border-border hover:bg-muted/20"
                    style={{ minHeight: ROW_HEIGHT }}
                  >
                    <div
                      className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-sm border-r border-border bg-card pl-10"
                      style={{ width: LABEL_WIDTH }}
                    >
                      <span className="text-muted-foreground">└</span>
                      <span className="truncate">{a.developer_name}</span>
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onDeleteAssignment(a.id);
                        }}
                        className="group/tt relative ml-auto text-sm text-destructive hover:underline"
                      >
                        ×
                        <Tooltip label="해제" side="top" inline />
                      </button>
                    </div>
                    <div
                      className="flex-1 relative"
                      style={{ minHeight: ROW_HEIGHT }}
                    >
                      {months.map((m, i) => {
                        const left = pct(m);
                        return (
                          <div
                            key={i}
                            className="absolute top-0 h-full border-l border-border/50"
                            style={{ left: `${left}%` }}
                          />
                        );
                      })}
                      {renderChildBars([a], color)}
                    </div>
                  </div>
                ))}
                {/* Add row */}
                <div
                  className="flex border-b border-border"
                  style={{ minHeight: ROW_HEIGHT }}
                >
                  <div
                    className="shrink-0 px-3 py-1.5 flex items-center text-sm border-r border-border bg-card pl-10"
                    style={{ width: LABEL_WIDTH }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onAddForSlot(it.estimate_item.id, projectStart, projectEnd)
                      }
                      className="inline-flex items-center gap-0.5 text-sm text-primary hover:underline"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      이 라인에 인력 배정
                    </button>
                  </div>
                  <div className="flex-1 relative" />
                </div>
              </>
            )}
          </div>
        );
      })}

      {/* Unassigned group */}
      {data.unassigned.length > 0 && (
        <div>
          <div
            className="flex border-b border-border bg-muted/40"
            style={{ minHeight: ROW_HEIGHT }}
          >
            <div
              className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-sm border-r border-border"
              style={{ width: LABEL_WIDTH }}
            >
              <span className="w-4 text-muted-foreground">▼</span>
              <span className="font-medium text-muted-foreground">
                (견적서 외)
              </span>
              <span className="text-sm text-muted-foreground">
                · {data.unassigned.length}명
              </span>
            </div>
            <div className="flex-1 relative" />
          </div>
          {data.unassigned.map((a) => (
            <div
              key={a.id}
              className="flex border-b border-border hover:bg-muted/20"
              style={{ minHeight: ROW_HEIGHT }}
            >
              <div
                className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-sm border-r border-border bg-card pl-10"
                style={{ width: LABEL_WIDTH }}
              >
                <span className="text-muted-foreground">└</span>
                <span className="truncate">{a.developer_name}</span>
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onDeleteAssignment(a.id);
                  }}
                  className="group/tt relative ml-auto text-sm text-destructive hover:underline"
                >
                  ×
                  <Tooltip label="해제" side="top" inline />
                </button>
              </div>
              <div className="flex-1 relative" style={{ minHeight: ROW_HEIGHT }}>
                {months.map((m, i) => {
                  const left = pct(m);
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-full border-l border-border/50"
                      style={{ left: `${left}%` }}
                    />
                  );
                })}
                {renderChildBars([a], "#64748b")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Palette used by both the AssignmentHistory Gantt and the estimate view.
const PROJECT_PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#f97316",
  "#10b981",
  "#8b5cf6",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
  "#22c55e",
  "#eab308",
  "#06b6d4",
  "#a855f7",
  "#d946ef",
  "#84cc16",
  "#f43f5e",
  "#0ea5e9",
  "#64748b",
  "#78716c",
  "#7c3aed",
];

// ---------------------------------------------------------------------------
// 프로젝트에 매핑된 세금계산서 섹션 (매입·매출 공용).
// tax-invoices 상세에서 '프로젝트 매칭' 지정 시 여기에 집계. 승인번호 클릭 시
// 같은 페이지에서 팝업(readOnly) 로 조회. 편집은 Tax Invoices 메뉴에서만.
// ---------------------------------------------------------------------------

type ProjectTaxInvoice = {
  id: string;
  kind: "SALES" | "PURCHASE";
  approval_no: string;
  issue_date: string;
  buyer_name: string | null;
  buyer_biz_no: string | null;
  supplier_name: string | null;
  supplier_biz_no: string | null;
  supply_amount: number;
  tax_amount: number;
  total_amount: number;
  status: string;
};

type ProjectTaxInvoicePage = {
  items: ProjectTaxInvoice[];
  total: number;
};

function ProjectTaxInvoicesSection({
  projectId,
  kind,
}: {
  projectId: string;
  kind: "SALES" | "PURCHASE";
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const title = kind === "SALES" ? "매출" : "매입";
  // 매출은 구매자(buyer), 매입은 공급자(supplier) 가 "상대방".
  const counterpartyHeader = kind === "SALES" ? "구매자" : "공급자";

  const { data } = useQuery<ProjectTaxInvoicePage>({
    queryKey: [`project-${kind.toLowerCase()}-tax-invoices`, projectId],
    queryFn: async () =>
      (
        await api.get("/tax-invoices", {
          params: {
            kind,
            linked_project_id: projectId,
            page: 1,
            page_size: 200,
          },
        })
      ).data,
  });

  const rows = data?.items ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      supply: acc.supply + (r.supply_amount || 0),
      tax: acc.tax + (r.tax_amount || 0),
      total: acc.total + (r.total_amount || 0),
    }),
    { supply: 0, tax: 0, total: 0 },
  );

  function counterpartyName(r: ProjectTaxInvoice): string {
    return (kind === "SALES" ? r.buyer_name : r.supplier_name) || "-";
  }
  function counterpartyBiz(r: ProjectTaxInvoice): string {
    return (kind === "SALES" ? r.buyer_biz_no : r.supplier_biz_no) || "-";
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="font-semibold">{title} (세금계산서)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            이 프로젝트로 매핑된 전자세금계산서 · 매칭은 Tax Invoices 상세에서 설정
          </p>
        </div>
        <a
          href="/tax-invoices"
          className="text-xs text-primary hover:underline"
        >
          Tax Invoices →
        </a>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          매핑된 {title} 세금계산서가 없습니다. Tax Invoices 메뉴에서
          세금계산서를 열어 "프로젝트 매칭" 을 지정하세요.
        </p>
      ) : (
        <div className="rounded-md border border-border overflow-auto">
          {/* table-fixed + 각 컬럼 고정 width: 매입·매출 두 Grid 가 동일한 열 모양을 갖도록. */}
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[9%]" />
              <col className="w-[22%]" />
              <col className="w-[18%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[12%]" />
              <col className="w-[5%]" />
            </colgroup>
            <thead className="bg-muted/50 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">발행일</th>
                <th className="px-3 py-2 text-left font-medium">승인번호</th>
                <th className="px-3 py-2 text-left font-medium">{counterpartyHeader}</th>
                <th className="px-3 py-2 text-left font-medium">사업자번호</th>
                <th className="px-3 py-2 text-right font-medium">공급가액</th>
                <th className="px-3 py-2 text-right font-medium">부가세</th>
                <th className="px-3 py-2 text-right font-medium">합계</th>
                <th className="px-3 py-2 text-center font-medium">상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60 tabular-nums">
                  <td className="px-3 py-1.5">{r.issue_date}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">
                    <button
                      type="button"
                      onClick={() => setOpenId(r.id)}
                      className="text-primary hover:underline"
                      title="세금계산서 상세 보기"
                    >
                      {r.approval_no}
                    </button>
                  </td>
                  <td className="px-3 py-1.5">{counterpartyName(r)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {counterpartyBiz(r)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {formatKRW(r.supply_amount)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {formatKRW(r.tax_amount)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold">
                    {formatKRW(r.total_amount)}
                  </td>
                  <td className="px-3 py-1.5 text-center text-xs text-muted-foreground">
                    {r.status}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold tabular-nums">
                <td colSpan={4} className="px-3 py-2 text-right">
                  합계 ({rows.length}건)
                </td>
                <td className="px-3 py-2 text-right">{formatKRW(totals.supply)}</td>
                <td className="px-3 py-2 text-right">{formatKRW(totals.tax)}</td>
                <td className="px-3 py-2 text-right">{formatKRW(totals.total)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* 프로젝트 화면에서 열면 읽기 전용 — 편집은 Tax Invoices 메뉴에서만. */}
      <TaxInvoiceDetailDialog
        invoiceId={openId}
        onClose={() => setOpenId(null)}
        readOnly
      />
    </section>
  );
}
