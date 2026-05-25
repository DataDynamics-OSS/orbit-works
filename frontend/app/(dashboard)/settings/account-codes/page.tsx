"use client";

/**
 * 계정과목 (수입·지출 항목) 마스터 — 사이드바 > 관리 > 계정과목.
 *
 * 1년 예산 수립 / 실적 매핑 / 결산 P&L / 현금흐름표의 토대.
 *
 * - kind: 수입(INCOME) / 지출(EXPENSE)
 * - category: 자유 입력 (권장 enum 은 select 에서 안내)
 * - account_code/account_name: 한국 회계 표준 매핑 — 시드는 기본값 채움, 사용자 수정 가능
 * - is_pl=false → 자본·자산·부채 거래 (대출 원금 / 펀드 / 임직원 대여 등). 결산 P&L 에선 제외
 * - "시드 가져오기" 버튼: 표준 한국 SME 항목 ~64건 일괄 등록 (중복 스킵)
 *
 * 권한: ADMIN/HR (재무 마스터). 시드 등록은 ADMIN 만.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Database, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { TabBar, TabItem } from "@/components/ui/TabBar";

type Kind = "INCOME" | "EXPENSE";

type AccountCode = {
  id: string;
  kind: Kind;
  category: string;
  name: string;
  description: string | null;
  usage_guide: string | null;
  account_code: string | null;
  account_name: string | null;
  is_pl: boolean;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const KIND_LABEL: Record<Kind, string> = { INCOME: "수입", EXPENSE: "지출" };

const SUGGESTED_CATEGORIES: Record<Kind, string[]> = {
  INCOME: [
    "매출",
    "영업외수익",
    "R&D 지원금",
    "고용지원금",
    "수출지원금",
    "기타 정부지원",
    "자본조달",
    "자산성보조금",
    "환급",
    "잡수익",
  ],
  EXPENSE: [
    "인건비",
    "사무실 운영",
    "출장",
    "통신·IT",
    "차량",
    "외부 자문",
    "복리후생",
    "영업비",
    "R&D 비용",
    "세금",
    "자산투자",
    "영업외비용",
    "비손익 현금유출",
  ],
};

type FormState = {
  id?: string;
  kind: Kind;
  category: string;
  name: string;
  description: string;
  usage_guide: string;
  account_code: string;
  account_name: string;
  is_pl: boolean;
  sort_order: number;
  is_active: boolean;
};

const BLANK_FORM: FormState = {
  kind: "EXPENSE",
  category: "",
  name: "",
  description: "",
  usage_guide: "",
  account_code: "",
  account_name: "",
  is_pl: true,
  sort_order: 0,
  is_active: true,
};

export default function AccountCodesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [kindFilter, setKindFilter] = useState<"ALL" | Kind>("ALL");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);

  const { data: rows = [], isLoading } = useQuery<AccountCode[]>({
    queryKey: ["account-codes", kindFilter, includeInactive],
    queryFn: async () =>
      (
        await api.get("/account-codes", {
          params: {
            kind: kindFilter === "ALL" ? undefined : kindFilter,
            include_inactive: includeInactive,
          },
        })
      ).data,
  });

  const createM = useMutation({
    mutationFn: async (f: FormState) => {
      const payload = serializeForm(f);
      return (await api.post("/account-codes", payload)).data as AccountCode;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-codes"] });
      setFormOpen(false);
      setForm(BLANK_FORM);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const updateM = useMutation({
    mutationFn: async (f: FormState) => {
      if (!f.id) throw new Error("id missing");
      const payload = serializeForm(f);
      return (await api.patch(`/account-codes/${f.id}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-codes"] });
      setFormOpen(false);
      setForm(BLANK_FORM);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/account-codes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-codes"] }),
  });

  const openEdit = (row: AccountCode) => {
    setForm({
      id: row.id,
      kind: row.kind,
      category: row.category,
      name: row.name,
      description: row.description ?? "",
      usage_guide: row.usage_guide ?? "",
      account_code: row.account_code ?? "",
      account_name: row.account_name ?? "",
      is_pl: row.is_pl,
      sort_order: row.sort_order,
      is_active: row.is_active,
    });
    setFormOpen(true);
  };

  const onClickAdd = () => {
    setForm(BLANK_FORM);
    setFormOpen(true);
  };

  const runSeed = async () => {
    setSeedBusy(true);
    try {
      const res = (await api.post("/account-codes/seed")).data as {
        inserted: number;
        skipped: number;
        total: number;
      };
      qc.invalidateQueries({ queryKey: ["account-codes"] });
      setSeedOpen(false);
      await dialog.alert(
        `신규 등록 ${res.inserted}건 · 중복 스킵 ${res.skipped}건 / 전체 ${res.total}건`,
        { title: "시드 적용 완료" },
      );
    } catch (e: any) {
      await dialog.alert(e?.response?.data?.detail ?? "시드 적용 실패", {
        title: "오류",
      });
    } finally {
      setSeedBusy(false);
    }
  };

  const columnDefs = useMemo<ColDef<AccountCode>[]>(
    () => [
      {
        field: "kind",
        headerName: "구분",
        width: 70,
        flex: 0,
        sortable: true,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) => (
          <span
            className={
              "px-1.5 py-0.5 rounded text-[10px] font-semibold " +
              (p.value === "INCOME"
                ? "bg-rose-100 text-rose-700"
                : "bg-sky-100 text-sky-700")
            }
          >
            {KIND_LABEL[p.value as Kind]}
          </span>
        ),
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "category",
        headerName: "카테고리",
        width: 130,
        flex: 0,
        sortable: true,
        filter: false,
      },
      {
        field: "name",
        headerName: "항목명",
        flex: 1.2,
        minWidth: 180,
        sortable: true,
        filter: false,
        cellRenderer: (p: any) => (
          <button
            type="button"
            onClick={() => openEdit(p.data)}
            className="text-primary hover:underline text-left"
          >
            {p.value}
          </button>
        ),
      },
      {
        field: "description",
        headerName: "비고",
        flex: 1.2,
        minWidth: 210,
        sortable: false,
        filter: false,
        valueFormatter: (p) => p.value ?? "-",
        // autoHeight + 다른 컬럼이 더 길어도 수직 중앙 정렬되도록 flex.
        cellStyle: {
          whiteSpace: "normal",
          lineHeight: "1.4",
          display: "flex",
          alignItems: "center",
        } as any,
        wrapText: true,
        autoHeight: true,
      },
      {
        field: "usage_guide",
        headerName: "사용 지침",
        flex: 1.1,
        minWidth: 160,
        sortable: false,
        filter: false,
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: {
          whiteSpace: "normal",
          lineHeight: "1.5",
          color: "#475569",
          fontSize: "11px",
        } as any,
        wrapText: true,
        autoHeight: true,
      },
      {
        field: "account_code",
        headerName: "계정코드",
        width: 90,
        flex: 0,
        sortable: false,
        filter: false,
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: {
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
        } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "account_name",
        headerName: "계정명",
        width: 130,
        flex: 0,
        sortable: false,
        filter: false,
        valueFormatter: (p) => p.value ?? "-",
      },
      {
        field: "is_pl",
        headerName: "P&L",
        width: 70,
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="text-emerald-600">✓</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "sort_order",
        headerName: "정렬",
        width: 70,
        flex: 0,
        sortable: true,
        filter: false,
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "is_active",
        headerName: "활성",
        width: 70,
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="text-emerald-600">✓</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        cellStyle: { textAlign: "center" } as any,
        headerClass: "ag-center-aligned-header",
      },
      {
        colId: "actions",
        headerName: "",
        width: 50,
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => (
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm(
                `"${p.data.name}" 을(를) 삭제하시겠습니까?`,
                { title: "삭제 확인", confirmText: "삭제" },
              );
              if (ok) deleteM.mutate(p.data.id);
            }}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
            title="삭제"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ),
        cellStyle: { textAlign: "center" } as any,
      },
    ],
    [deleteM, dialog],
  );

  return (
    <>
      <DashboardHeader title="계정과목" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <TabBar className="flex-1 min-w-0">
            {(["ALL", "INCOME", "EXPENSE"] as const).map((k) => (
              <TabItem
                key={k}
                active={kindFilter === k}
                onClick={() => setKindFilter(k)}
              >
                {k === "ALL" ? "전체" : KIND_LABEL[k]}
              </TabItem>
            ))}
          </TabBar>
          <label className="flex items-center gap-1 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            비활성 포함
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSeedOpen(true)}
              className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
              title="표준 한국 SME 수입·지출 항목 일괄 등록"
            >
              <Database className="h-4 w-4" />
              시드 가져오기
            </button>
            <button
              type="button"
              onClick={onClickAdd}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              항목 추가
            </button>
          </div>
        </div>

        <DataGrid<AccountCode>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          compact
        />

        {isLoading && (
          <div className="text-xs text-muted-foreground">불러오는 중…</div>
        )}
      </div>

      <FormDialog
        open={formOpen}
        form={form}
        setForm={setForm}
        onClose={() => {
          setFormOpen(false);
          setForm(BLANK_FORM);
        }}
        onSubmit={() => (form.id ? updateM.mutate(form) : createM.mutate(form))}
        submitting={createM.isPending || updateM.isPending}
      />

      <SeedDialog
        open={seedOpen}
        onClose={() => setSeedOpen(false)}
        onConfirm={runSeed}
        busy={seedBusy}
      />
    </>
  );
}

function serializeForm(f: FormState) {
  return {
    kind: f.kind,
    category: f.category.trim(),
    name: f.name.trim(),
    description: f.description.trim() || null,
    usage_guide: f.usage_guide.trim() || null,
    account_code: f.account_code.trim() || null,
    account_name: f.account_name.trim() || null,
    is_pl: f.is_pl,
    sort_order: Number.isFinite(f.sort_order) ? f.sort_order : 0,
    is_active: f.is_active,
  };
}

// ---------------------------------------------------------------------------
// 추가/수정 다이얼로그
// ---------------------------------------------------------------------------

function FormDialog({
  open,
  form,
  setForm,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  form: FormState;
  setForm: (f: FormState) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const isEdit = !!form.id;
  const suggested = SUGGESTED_CATEGORIES[form.kind];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? "계정과목 수정" : "계정과목 추가"}
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
            onClick={onSubmit}
            disabled={
              !form.category.trim() || !form.name.trim() || submitting
            }
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {submitting ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="구분 *">
          <div className="flex items-center gap-3 h-10">
            {(["INCOME", "EXPENSE"] as const).map((k) => (
              <label
                key={k}
                className="inline-flex items-center gap-1.5 text-sm cursor-pointer"
              >
                <input
                  type="radio"
                  name="kind"
                  checked={form.kind === k}
                  onChange={() => setForm({ ...form, kind: k })}
                  className="h-3.5 w-3.5"
                />
                {KIND_LABEL[k]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="카테고리 *">
          <input
            list="cat-suggest"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className={input}
            placeholder="자유 입력 또는 권장 카테고리 선택"
          />
          <datalist id="cat-suggest">
            {suggested.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="항목명 *" colSpan={2}>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={input}
            placeholder="예: 라이센스 매출 / 급여 / 임차료"
            autoFocus
          />
        </Field>
        <Field label="비고 (한 줄 부제)" colSpan={2}>
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className={input}
            placeholder="이 항목이 무엇인지 한 줄로 (예: 정규직 월급)"
          />
        </Field>
        <Field label="사용 지침 (비전문가용 안내)" colSpan={2}>
          <textarea
            value={form.usage_guide}
            onChange={(e) => setForm({ ...form, usage_guide: e.target.value })}
            className={input + " min-h-24"}
            rows={4}
            placeholder="언제 이 항목을 쓰고 어떤 의미인지 — 회계 비전문가도 이해할 수 있게 작성. 예) 매월 정기 지급되는 정규직 월급. 상여금/퇴직급여는 별도 항목 사용. 4대보험 회사부담분도 별도."
          />
        </Field>

        <div className="col-span-2 mt-2 mb-1 text-xs text-muted-foreground border-b border-border pb-1">
          회계 매핑 (선택)
        </div>
        <Field label="계정코드">
          <input
            value={form.account_code}
            onChange={(e) =>
              setForm({ ...form, account_code: e.target.value })
            }
            className={input}
            placeholder="예: 80100"
          />
        </Field>
        <Field label="계정명">
          <input
            value={form.account_name}
            onChange={(e) =>
              setForm({ ...form, account_name: e.target.value })
            }
            className={input}
            placeholder="예: 급여"
          />
        </Field>

        <Field label="P&L 합산 대상">
          <label className="flex items-center gap-2 h-10 text-sm">
            <input
              type="checkbox"
              checked={form.is_pl}
              onChange={(e) => setForm({ ...form, is_pl: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            손익 결산에 포함 (해제 = 자본·자산·부채 거래)
          </label>
        </Field>
        <Field label="활성 / 정렬">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) =>
                  setForm({ ...form, is_active: e.target.checked })
                }
                className="h-3.5 w-3.5"
              />
              활성
            </label>
            <input
              type="number"
              value={form.sort_order}
              onChange={(e) =>
                setForm({ ...form, sort_order: Number(e.target.value) || 0 })
              }
              className={input + " w-24"}
              title="정렬순서 (작을수록 위)"
            />
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 시드 가져오기 다이얼로그
// ---------------------------------------------------------------------------

function SeedDialog({
  open,
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="시드 가져오기"
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
            onClick={onConfirm}
            disabled={busy}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            {busy ? "등록 중..." : "일괄 등록"}
          </button>
        </>
      }
    >
      <div className="text-sm space-y-2">
        <div>
          한국 중소기업 표준 수입·지출 항목 약 155건을 일괄 등록합니다.
        </div>
        <div className="text-xs text-muted-foreground">
          ※ 이미 같은 (구분, 카테고리, 항목명) 으로 등록된 행은 자동 스킵됩니다.
        </div>
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          <b>마이그레이션</b>: 기존 "정부지원금" 카테고리의 3건은 자동으로
          R&D 지원금 / 고용지원금 / 수출지원금 카테고리로 이동됩니다.
        </div>
        <div className="rounded-md bg-muted/30 p-2 text-xs space-y-1">
          <div>
            <b>수입 (56)</b> — 매출(10) · 영업외수익(7) · R&D 지원금(7) ·
            고용지원금(7) · 수출지원금(5) · 기타 정부지원(3) · 자본조달(2) ·
            자산성보조금(4) · 환급(8) · 잡수익(3)
          </div>
          <div>
            <b>지출 (99)</b> — 인건비(6) · 사무실 운영(14) · 출장(7) ·
            통신·IT(8) · 차량(5) · 외부 자문(12) · 복리후생(12) · 영업비(5) ·
            R&D 비용(6) · 세금(5) · 자산투자(10) · 영업외(6) · 비손익(3)
          </div>
        </div>
      </div>
    </Dialog>
  );
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
