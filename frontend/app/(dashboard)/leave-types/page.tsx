"use client";

/**
 * 휴가 유형 (LeaveType) 관리 — 사이드바 ATTENDANCE 그룹.
 *
 * 권한: `leave_types.manage` (HR + ADMIN). 일반 사용자는 메뉴 미노출.
 *
 * 기존 leave_requests.leave_type 과 별개로 운영되는 reference 테이블.
 * "기본 유형 일괄 등록" 버튼 — idempotent (이미 같은 code 가 있으면 skip).
 */

import { useMemo, useState } from "react";
import { ColDef } from "ag-grid-community";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus, Save, Sparkles } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Category =
  | "ANNUAL"
  | "LIFE_EVENT"
  | "PUBLIC_DUTY"
  | "SICK"
  | "REWARD"
  | "OTHER";
type Unit = "DAY" | "HALF" | "HOUR";

const CATEGORY_LABEL: Record<Category, string> = {
  ANNUAL: "연차/반차",
  LIFE_EVENT: "경조/출산",
  PUBLIC_DUTY: "공가",
  SICK: "병가",
  REWARD: "포상",
  OTHER: "기타",
};

const CATEGORY_COLOR: Record<Category, string> = {
  ANNUAL: "#3B82F6",
  LIFE_EVENT: "#F59E0B",
  PUBLIC_DUTY: "#8B5CF6",
  SICK: "#EF4444",
  REWARD: "#10B981",
  OTHER: "#6B7280",
};

// 30색 팔레트 — 색상환을 따라 배치 (왼→오른, 진→연), 마지막 줄은 회색.
// 캘린더·뱃지 표시를 의식해 명도가 너무 낮은 색은 제외.
const COLOR_PALETTE = [
  // Row 1 — vivid (Tailwind 500 계열 hue 환)
  "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#84CC16", "#22C55E",
  // Row 2 — cool vivid
  "#10B981", "#14B8A6", "#06B6D4", "#0EA5E9", "#3B82F6", "#6366F1",
  // Row 3 — purple/pink vivid
  "#8B5CF6", "#A855F7", "#D946EF", "#EC4899", "#F43F5E", "#FB7185",
  // Row 4 — soft pastels
  "#FCA5A5", "#FDBA74", "#FCD34D", "#86EFAC", "#67E8F9", "#93C5FD",
  // Row 5 — soft purple/pink + grays
  "#C4B5FD", "#F9A8D4", "#1F2937", "#475569", "#6B7280", "#94A3B8",
];

const UNIT_LABEL: Record<Unit, string> = {
  DAY: "일",
  HALF: "반일",
  HOUR: "시간",
};

type LeaveType = {
  id: string;
  code: string;
  name: string;
  category: Category;
  unit: Unit;
  deducts_annual: boolean;
  paid: boolean;
  max_days_per_year: string | null;
  max_uses_per_year: number | null;
  requires_evidence: boolean;
  requires_reason: boolean;
  color: string | null;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type Form = {
  // code 는 UI 에서 다루지 않고 백엔드가 자동 생성 (편집 시에도 그대로 둠).
  name: string;
  category: Category;
  unit: Unit;
  deducts_annual: boolean;
  paid: boolean;
  max_days_per_year: string;
  max_uses_per_year: string;
  requires_evidence: boolean;
  requires_reason: boolean;
  color: string;
  description: string;
  sort_order: string;
  is_active: boolean;
};

const BLANK_FORM: Form = {
  name: "",
  category: "OTHER",
  unit: "DAY",
  deducts_annual: false,
  paid: true,
  max_days_per_year: "",
  max_uses_per_year: "",
  requires_evidence: false,
  requires_reason: false,
  color: CATEGORY_COLOR.OTHER,
  description: "",
  sort_order: "0",
  is_active: true,
};

export default function LeaveTypesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [filterActive, setFilterActive] = useState<string>("true");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<Form>(BLANK_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Form>(BLANK_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const { data: rows = [] } = useQuery<LeaveType[]>({
    queryKey: ["leave-types", filterActive, filterCategory],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filterActive) params.is_active = filterActive;
      if (filterCategory) params.category = filterCategory;
      return (await api.get("/leave-types", { params })).data;
    },
  });

  const editTarget = useMemo(
    () => rows.find((r) => r.id === editTargetId) ?? null,
    [rows, editTargetId],
  );

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post("/leave-types", formToPayload(addForm))).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-types"] });
      setAddOpen(false);
      setAddForm(BLANK_FORM);
      setAddError(null);
    },
    onError: (e: any) => setAddError(extractError(e) ?? "등록 실패"),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return;
      await api.patch(`/leave-types/${editTargetId}`, formToPayload(editForm));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-types"] });
      setEditTargetId(null);
      setEditError(null);
    },
    onError: (e: any) => setEditError(extractError(e) ?? "저장 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/leave-types/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leave-types"] }),
  });

  const seedM = useMutation({
    mutationFn: async () =>
      (await api.post<{ inserted: number; skipped: number }>("/leave-types/seed"))
        .data,
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: ["leave-types"] });
      await dialog.alert(
        `기본 유형 등록 완료\n신규: ${res.inserted}건 / 이미 존재(skip): ${res.skipped}건`,
        { title: "시드 완료" },
      );
    },
    onError: async (e: any) =>
      dialog.alert(extractError(e) ?? "시드 실패", { title: "오류" }),
  });

  async function handleSeed() {
    const ok = await dialog.confirm(
      "기본 휴가 유형 19개를 등록합니다.\n이미 같은 코드가 있으면 건너뜁니다.",
      { confirmText: "등록" },
    );
    if (ok) seedM.mutate();
  }

  async function handleDelete(sel: LeaveType[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}개 휴가 유형을 비활성화하시겠습니까?\n` +
        "(데이터는 유지되며 is_active=false 로 전환됩니다.)",
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  function openEdit(row: LeaveType) {
    setEditTargetId(row.id);
    setEditForm({
      name: row.name,
      category: row.category,
      unit: row.unit,
      deducts_annual: row.deducts_annual,
      paid: row.paid,
      max_days_per_year:
        row.max_days_per_year != null ? String(row.max_days_per_year) : "",
      max_uses_per_year:
        row.max_uses_per_year != null ? String(row.max_uses_per_year) : "",
      requires_evidence: row.requires_evidence,
      requires_reason: row.requires_reason,
      color: row.color ?? CATEGORY_COLOR[row.category],
      description: row.description ?? "",
      sort_order: String(row.sort_order),
      is_active: row.is_active,
    });
    setEditError(null);
  }

  const columnDefs = useMemo<ColDef<LeaveType>[]>(
    () => [
      { field: "sort_order", headerName: "정렬", flex: 0, width: 70 },
      {
        colId: "color_name",
        headerName: "이름",
        flex: 1,
        cellRenderer: (p: any) => (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm shrink-0"
              style={{
                backgroundColor:
                  p.data?.color ?? CATEGORY_COLOR[p.data?.category as Category],
              }}
            />
            <span>{p.data?.name}</span>
          </div>
        ),
      },
      {
        field: "category",
        headerName: "카테고리",
        flex: 0,
        valueFormatter: (p) => CATEGORY_LABEL[p.value as Category] ?? p.value,
      },
      {
        field: "unit",
        headerName: "단위",
        flex: 0,
        valueFormatter: (p) => UNIT_LABEL[p.value as Unit] ?? p.value,
      },
      {
        field: "deducts_annual",
        headerName: "연차차감",
        flex: 0,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="text-emerald-600">✓</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        field: "paid",
        headerName: "유급",
        flex: 0,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="text-emerald-600">✓</span>
          ) : (
            <span className="text-amber-600">무급</span>
          ),
      },
      {
        colId: "max",
        headerName: "한도",
        flex: 0,
        valueGetter: (p) => {
          const r = p.data;
          if (!r) return "";
          const parts: string[] = [];
          if (r.max_days_per_year != null)
            parts.push(`${r.max_days_per_year}일/년`);
          if (r.max_uses_per_year != null)
            parts.push(`${r.max_uses_per_year}회/년`);
          return parts.join(" · ") || "—";
        },
      },
      {
        field: "requires_evidence",
        headerName: "증빙",
        flex: 0,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="text-amber-600">필수</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        field: "requires_reason",
        headerName: "사유",
        flex: 0,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="text-amber-600">필수</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        field: "is_active",
        headerName: "활성",
        flex: 0,
        cellRenderer: (p: any) => (
          <span
            className={
              "rounded px-1.5 py-0.5 text-xs " +
              (p.value
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-200 text-slate-600")
            }
          >
            {p.value ? "활성" : "비활성"}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="휴가 유형" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<LeaveType>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          compact
          searchPlaceholder="이름·코드 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "sort_order",
              "category",
              "unit",
              "deducts_annual",
              "paid",
              "max",
              "requires_evidence",
              "requires_reason",
              "is_active",
            ],
          }}
          extraActions={
            <>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                title="카테고리 필터"
              >
                <option value="">전체 카테고리</option>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <select
                value={filterActive}
                onChange={(e) => setFilterActive(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                title="활성 상태"
              >
                <option value="true">활성</option>
                <option value="false">비활성</option>
                <option value="">전체</option>
              </select>
              {rows.length === 0 && (
                <button
                  type="button"
                  onClick={handleSeed}
                  disabled={seedM.isPending}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {seedM.isPending ? "등록 중..." : "기본 유형 일괄 등록"}
                </button>
              )}
            </>
          }
          onAdd={() => {
            setAddForm(BLANK_FORM);
            setAddError(null);
            setAddOpen(true);
          }}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
        />
      </div>

      {/* 신규 등록 */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="휴가 유형 등록"
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!validForm(addForm) || createM.isPending}
              onClick={() => createM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {createM.isPending ? "등록 중..." : "등록"}
            </button>
          </>
        }
      >
        {addError && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
            {addError}
          </div>
        )}
        <FormBody form={addForm} setForm={setAddForm} />
      </Dialog>

      {/* 편집 */}
      <Dialog
        open={!!editTargetId}
        onClose={() => setEditTargetId(null)}
        title="휴가 유형 수정"
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditTargetId(null)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!validForm(editForm) || updateM.isPending}
              onClick={() => updateM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {updateM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        {editTarget && (
          <>
            {editError && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
                {editError}
              </div>
            )}
            <FormBody form={editForm} setForm={setEditForm} />
          </>
        )}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// 폼 본체
// ---------------------------------------------------------------------------

function FormBody({
  form,
  setForm,
}: {
  form: Form;
  setForm: (f: Form | ((prev: Form) => Form)) => void;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  // 카테고리 변경 시 색상 기본값 prefill (사용자가 명시적으로 변경했을 때만 보존).
  function changeCategory(c: Category) {
    setForm((p) => ({
      ...p,
      category: c,
      color:
        !p.color || p.color === CATEGORY_COLOR[p.category]
          ? CATEGORY_COLOR[c]
          : p.color,
    }));
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="이름 *" colSpan={2}>
        <input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          className={input}
          autoFocus
          placeholder="예: 경조 - 결혼"
        />
      </Field>
      <Field label="활성">
        <select
          value={form.is_active ? "true" : "false"}
          onChange={(e) =>
            setForm((p) => ({ ...p, is_active: e.target.value === "true" }))
          }
          className={input}
        >
          <option value="true">활성</option>
          <option value="false">비활성</option>
        </select>
      </Field>

      <Field label="카테고리 *">
        <select
          value={form.category}
          onChange={(e) => changeCategory(e.target.value as Category)}
          className={input}
        >
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="단위">
        <select
          value={form.unit}
          onChange={(e) =>
            setForm((p) => ({ ...p, unit: e.target.value as Unit }))
          }
          className={input}
        >
          <option value="DAY">일 (DAY)</option>
          <option value="HALF">반일 (HALF)</option>
          <option value="HOUR">시간 (HOUR)</option>
        </select>
      </Field>


      <Field label="연 한도 (일)">
        <input
          value={form.max_days_per_year}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              max_days_per_year: e.target.value.replace(/[^0-9.]/g, ""),
            }))
          }
          inputMode="decimal"
          placeholder="비우면 무제한"
          className={input}
        />
      </Field>
      <Field label="연 사용 횟수">
        <input
          value={form.max_uses_per_year}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              max_uses_per_year: e.target.value.replace(/[^0-9]/g, ""),
            }))
          }
          inputMode="numeric"
          placeholder="비우면 무제한"
          className={input}
        />
      </Field>
      <Field label="정렬 순서">
        <input
          value={form.sort_order}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              sort_order: e.target.value.replace(/[^0-9-]/g, ""),
            }))
          }
          inputMode="numeric"
          className={input}
        />
      </Field>

      <Field label="색상" colSpan={2}>
        <div className="rounded-md border border-input bg-background p-2 grid grid-cols-6 gap-1.5">
          {COLOR_PALETTE.map((c) => {
            const selected = form.color.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                onClick={() => setForm((p) => ({ ...p, color: c }))}
                title={c}
                aria-label={`색상 ${c}`}
                className={
                  "h-6 w-6 rounded transition-transform " +
                  (selected
                    ? "ring-2 ring-offset-1 ring-foreground scale-110"
                    : "hover:scale-110")
                }
                style={{ backgroundColor: c }}
              />
            );
          })}
        </div>
      </Field>
      <Field label="규칙">
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.deducts_annual}
              onChange={(e) =>
                setForm((p) => ({ ...p, deducts_annual: e.target.checked }))
              }
            />
            연차 차감
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.paid}
              onChange={(e) =>
                setForm((p) => ({ ...p, paid: e.target.checked }))
              }
            />
            유급
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.requires_evidence}
              onChange={(e) =>
                setForm((p) => ({ ...p, requires_evidence: e.target.checked }))
              }
            />
            증빙 필수
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.requires_reason}
              onChange={(e) =>
                setForm((p) => ({ ...p, requires_reason: e.target.checked }))
              }
            />
            사유 제출 필수
          </label>
        </div>
      </Field>

      <Field label="설명" colSpan={3}>
        <textarea
          value={form.description}
          onChange={(e) =>
            setForm((p) => ({ ...p, description: e.target.value }))
          }
          rows={2}
          className={input}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const cls =
    colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validForm(f: Form): boolean {
  if (!f.name.trim()) return false;
  return true;
}

function formToPayload(f: Form): Record<string, unknown> {
  const num = (s: string) => (s.trim() ? Number(s) : null);
  return {
    // code 는 보내지 않음 — 백엔드가 신규 등록 시 자동 생성, 편집 시 그대로 유지.
    name: f.name.trim(),
    category: f.category,
    unit: f.unit,
    deducts_annual: f.deducts_annual,
    paid: f.paid,
    max_days_per_year: num(f.max_days_per_year),
    max_uses_per_year: f.max_uses_per_year.trim()
      ? Number(f.max_uses_per_year)
      : null,
    requires_evidence: f.requires_evidence,
    requires_reason: f.requires_reason,
    color: f.color || null,
    description: f.description.trim() || null,
    sort_order: f.sort_order.trim() ? Number(f.sort_order) : 0,
    is_active: f.is_active,
  };
}

function extractError(e: any): string | null {
  const d = e?.response?.data?.detail;
  if (Array.isArray(d)) {
    return d
      .map((it: any) => {
        const field = Array.isArray(it.loc) ? it.loc.slice(1).join(".") : "";
        return field ? `${field}: ${it.msg}` : it.msg;
      })
      .join("\n");
  }
  if (typeof d === "string") return d;
  return e?.message ?? null;
}
