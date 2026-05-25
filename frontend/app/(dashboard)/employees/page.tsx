"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, FileText, GitBranch, MapPin, Plus, Save } from "lucide-react";
import { api } from "@/lib/api";
import { hasFeature } from "@/components/layout/feature-registry";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { OrgChartDialog } from "@/components/developers/OrgChartDialog";
import { DeveloperStatsPanel } from "@/components/developers/DeveloperStatsPanel";
import { PositionTenureDialog } from "@/components/developers/PositionTenureDialog";
import { SalaryDistributionDialog } from "@/components/developers/SalaryDistributionDialog";
import { DataGrid, type DataGridHandle } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import { downloadDevelopersRosterPDF } from "@/lib/developers-roster-export";
import { tenureFromHireDate } from "@/lib/format";
import {
  GENDER_LABEL,
  ageFromRRN,
  birthDateFromRRN,
  genderFromRRN,
  isBirthdayThisMonth,
} from "@/lib/resident";

type PaymentMethod = "PAYROLL" | "TAX_INVOICE" | "HOURLY";
type EmploymentType =
  | "FREELANCER"
  | "FULL_TIME"
  | "FULL_TIME_SPECIAL"
  | "INSOURCED"
  | "INTERN"
  | "PART_TIME";
type DeveloperStatus = "ACTIVE" | "INACTIVE";

const ROLE_OPTIONS = [
  "컨설팅",
  "기술지원",
  "연구",
  "영업",
  "PM",
  "관리",
  "총무",
  "IR",
  "개발",
] as const;

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  FULL_TIME: "정규직",
  FULL_TIME_SPECIAL: "정규직 (특수)",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
  INTERN: "인턴",
  PART_TIME: "아르바이트",
};

const EMPLOYMENT_BADGE: Record<EmploymentType, string> = {
  FULL_TIME: "bg-blue-100 text-blue-700 border-blue-200",
  FULL_TIME_SPECIAL: "bg-purple-100 text-purple-700 border-purple-200",
  FREELANCER: "bg-red-100 text-red-700 border-red-200",
  INSOURCED: "bg-orange-100 text-orange-700 border-orange-200",
  INTERN: "bg-emerald-100 text-emerald-700 border-emerald-200",
  PART_TIME: "bg-amber-100 text-amber-700 border-amber-200",
};

const STATUS_LABEL: Record<DeveloperStatus, string> = {
  ACTIVE: "활성",
  INACTIVE: "비활성",
};

const STATUS_BADGE: Record<DeveloperStatus, string> = {
  ACTIVE: "bg-blue-100 text-blue-700 border-blue-200",
  INACTIVE: "bg-red-100 text-red-700 border-red-200",
};

type SecurityRole = "ADMIN" | "HR" | "SALES" | "SUPPORT" | "ETC";

const SECURITY_ROLE_LABEL: Record<SecurityRole, string> = {
  ADMIN: "관리자",
  HR: "HR",
  SALES: "영업",
  SUPPORT: "지원",
  ETC: "기타",
};

const SECURITY_ROLE_BADGE: Record<SecurityRole, string> = {
  ADMIN: "bg-red-100 text-red-700 border-red-200",
  HR: "bg-blue-100 text-blue-700 border-blue-200",
  SALES: "bg-emerald-100 text-emerald-700 border-emerald-200",
  SUPPORT: "bg-amber-100 text-amber-700 border-amber-200",
  ETC: "bg-zinc-100 text-zinc-700 border-zinc-200",
};

type Developer = {
  id: string;
  name: string;
  tag?: string | null;
  // 사번 — 정규직만 부여. 서버 자동 생성, read-only.
  employee_no?: string | null;
  security_role?: "ADMIN" | "SALES" | "HR" | "SUPPORT" | "ETC";
  employment_type: EmploymentType;
  status: DeveloperStatus;
  title?: string;
  phone?: string;
  address?: string;
  personal_email?: string;
  company_email?: string;
  tax_invoice_email?: string;
  resident_number?: string;
  payment_method: PaymentMethod;
  business_no?: string;
  business_address?: string;
  salary?: string | number;
  hourly_rate?: string | number;
  latest_salary?: string | number | null;
  hire_date?: string;
  career_months_at_hire?: number | null;
  roles?: string[];
  skills?: string[];
  memo?: string;
  created_at: string;
  manager_id?: string | null;
  rank_id?: string | null;
  position_id?: string | null;
};

const BLANK: Partial<Developer> = {
  name: "",
  employment_type: "FULL_TIME",
  title: "매니저",
  roles: ["개발"],
  payment_method: "PAYROLL",
  status: "ACTIVE",
};

const EMPTY_STRING_FIELDS = [
  "company_email",
  "personal_email",
  "tax_invoice_email",
  "resident_number",
  "title",
  "phone",
  "address",
  "business_no",
  "business_address",
  "memo",
  "hire_date",
] as const;

// 주민등록번호 입력 포맷: 숫자만 남기고 6자리 뒤 하이픈 삽입.
// 최대 13자리 숫자 + 1 하이픈 = 14자. 빈 입력은 빈 문자열 그대로.
function formatResidentNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 13);
  if (digits.length <= 6) return digits;
  return digits.slice(0, 6) + "-" + digits.slice(6);
}

// 숫자 입력용 3자리 콤마 포맷터. 표시 전용 — state 에는 숫자 문자열(콤마 없음) 저장.
function formatNumberWithCommas(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "";
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("ko-KR");
}

function parseNumberInput(display: string): string {
  return display.replace(/[^\d]/g, "");
}

function preparePayload(form: Partial<Developer>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...form };
  for (const k of EMPTY_STRING_FIELDS) {
    if (payload[k] === "") payload[k] = null;
  }
  if (payload.salary === "" || payload.salary == null) delete payload.salary;
  if (payload.hourly_rate === "" || payload.hourly_rate == null) {
    payload.hourly_rate = null;
  }
  if (Array.isArray(payload.roles) && payload.roles.length === 0) payload.roles = [];
  // 사번은 서버 자동 부여 — 클라이언트가 보내지 않는다.
  delete payload.employee_no;
  return payload;
}

// 공통 필수값 체크. 빠진 필드가 있으면 사람이 읽을 수 있는 메시지 반환.
// 이메일은 고용형태별로 요구가 다르다:
//   FREELANCER → 개인 이메일 필수 (회사 이메일이 없을 수 있음).
//   그 외(FULL_TIME, INSOURCED) → 회사 이메일 필수.
function missingRequiredMessage(form: Partial<Developer>): string | null {
  if (!form.name?.trim()) return "이름을 입력해주세요.";
  if (!form.phone?.trim()) return "연락처를 입력해주세요.";
  if (!form.resident_number || !/^\d{6}-\d{7}$/.test(form.resident_number)) {
    return "주민등록번호를 XXXXXX-XXXXXXX 형식으로 입력해주세요.";
  }
  if (!form.hire_date) return "입사일을 선택해주세요.";
  if (form.employment_type === "FREELANCER") {
    if (!form.personal_email?.trim()) return "프리랜서는 개인 이메일이 필수입니다.";
  } else {
    if (!form.company_email?.trim()) {
      return "정규직/자사화는 회사 이메일이 필수입니다.";
    }
  }
  return null;
}

function errorMessage(e: any, fallback: string): string {
  return (
    e?.response?.data?.detail?.[0]?.msg ??
    e?.response?.data?.detail ??
    fallback
  );
}

export default function DevelopersPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [q, setQ] = useState("");
  // 그리드 선택 행 → PDF 부분 출력. 선택 없으면 전체.
  const gridRef = useRef<DataGridHandle<Developer>>(null);
  const [selectedCount, setSelectedCount] = useState(0);

  // Create
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<Partial<Developer>>(BLANK);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit
  const [editOpen, setEditOpen] = useState(false);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Developer>>({});
  const [editError, setEditError] = useState<string | null>(null);

  // 결재선 시각화 다이얼로그
  const [orgChartOpen, setOrgChartOpen] = useState(false);
  const [posTenureOpen, setPosTenureOpen] = useState(false);
  const [salaryDistOpen, setSalaryDistOpen] = useState(false);
  // 그리드를 정규직(FULL_TIME) ∧ ACTIVE 임직원만 표시하도록 필터링. 기본 켜짐.
  const [fullTimeOnly, setFullTimeOnly] = useState(true);
  // "연봉" 컬럼 숨김 토글. 기본 켜짐 — 평시 노출 최소화. HR/ADMIN 이 필요할 때만 끈다.
  const [salaryHidden, setSalaryHidden] = useState(true);

  const { data: raw = [] } = useQuery<Developer[]>({
    queryKey: ["developers", q],
    queryFn: async () =>
      (
        await api.get("/developers", {
          // Employees 페이지는 디렉터리 제외 목록 포함 임직원도 모두 표시.
          params: { q: q || undefined, include_hidden: true },
        })
      ).data,
  });
  // 본인 권한 — 연봉 마스킹 판정용. 서버도 동일 권한으로 salary 를 null 로 내려보냄.
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const { data: featurePerms = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["feature-permissions"],
    queryFn: async () => (await api.get("/feature-permissions")).data,
    staleTime: 5 * 60_000,
  });
  const canSeeSalary = hasFeature(featurePerms, "employees.salary.view", me?.role);
  const canCreate = hasFeature(featurePerms, "employees.create", me?.role);

  // 이름 가나다 순 정렬 (한글 로케일) + "정규직만" 필터 (FULL_TIME ∧ ACTIVE 만).
  const data = useMemo(() => {
    const filtered = fullTimeOnly
      ? raw.filter(
          (d) => d.employment_type === "FULL_TIME" && d.status === "ACTIVE",
        )
      : raw;
    return [...filtered].sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? "", "ko-KR"),
    );
  }, [raw, fullTimeOnly]);

  const createM = useMutation({
    mutationFn: async () => {
      const payload = preparePayload(addForm);
      // For POST, empty-string fields should be absent (validator-friendly)
      for (const k of EMPTY_STRING_FIELDS) {
        if (payload[k] === null) delete payload[k];
      }
      return (await api.post("/developers", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["developers"] });
      setAddForm(BLANK);
      setAddError(null);
      setAddOpen(false);
    },
    onError: (e: any) => setAddError(errorMessage(e, "등록 실패")),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTargetId) return null;
      const payload = preparePayload(editForm);
      return (await api.patch(`/developers/${editTargetId}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["developers"] });
      setEditOpen(false);
      setEditTargetId(null);
    },
    onError: (e: any) => setEditError(errorMessage(e, "수정 실패")),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/developers/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["developers"] }),
  });

  // 직위·직책 마스터 — 그리드의 ID → 이름 lookup. 등록·수정 폼의 GradeSelect 와
  // 동일 query key 를 공유해 캐시 재사용.
  const { data: ranksList = [] } = useQuery<
    { id: string; name: string }[]
  >({
    queryKey: ["job-ranks-active"],
    queryFn: async () => (await api.get("/job-ranks")).data,
    staleTime: 5 * 60_000,
  });
  const { data: positionsList = [] } = useQuery<
    { id: string; name: string }[]
  >({
    queryKey: ["job-positions-active"],
    queryFn: async () => (await api.get("/job-positions")).data,
    staleTime: 5 * 60_000,
  });
  const rankMap = useMemo(
    () => new Map(ranksList.map((r) => [r.id, r.name])),
    [ranksList],
  );
  const positionMap = useMemo(
    () => new Map(positionsList.map((p) => [p.id, p.name])),
    [positionsList],
  );

  const columnDefs = useMemo<ColDef<Developer>[]>(
    // 모든 컬럼은 filter: false. 정렬은 사번 / 이름 / 생년월일 / 연봉 / 입사일 만 활성.
    // 가운데 정렬은 사번/이름/직급/성별/고용형태/상태/연락처/생년월일/입사일.
    // auto resize 미사용 — 컬럼별 width / flex 만으로 폭 결정.
    () => [
      {
        field: "employee_no",
        headerName: "사번",
        width: 80,
        flex: 0,
        filter: false,
        sortable: true,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { fontFamily: "monospace", textAlign: "center" } as any,
      },
      {
        colId: "security_role",
        headerName: "보안등급",
        width: 100,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p) => p.data?.security_role ?? "ETC",
        cellRenderer: (p: any) => {
          const role = (p.value ?? "ETC") as
            "ADMIN" | "HR" | "SALES" | "SUPPORT" | "ETC";
          const tone = SECURITY_ROLE_BADGE[role];
          const label = SECURITY_ROLE_LABEL[role];
          return <Badge className={tone}>{label}</Badge>;
        },
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        field: "name",
        headerName: "이름",
        width: 80,
        flex: 0,
        filter: false,
        sortable: true,
        headerClass: "ag-center-aligned-header",
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
        cellRenderer: (p: any) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              href={`/employees/${p.data.id}`}
              className="text-primary hover:underline"
            >
              {p.value}
            </Link>
            {p.data.tag && (
              <span className="inline-flex items-center justify-center h-4 min-w-4 rounded border border-primary/40 bg-primary/10 text-primary text-[10px] px-1 font-semibold">
                {p.data.tag}
              </span>
            )}
          </span>
        ),
      },
      {
        colId: "rank",
        headerName: "직위",
        width: 120,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { textAlign: "center" } as any,
        valueGetter: (p) =>
          p.data?.rank_id ? rankMap.get(p.data.rank_id) ?? "-" : "-",
      },
      {
        colId: "position",
        headerName: "직책",
        width: 80,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { textAlign: "center" } as any,
        valueGetter: (p) =>
          p.data?.position_id ? positionMap.get(p.data.position_id) ?? "-" : "-",
      },
      {
        colId: "tenure",
        headerName: "근무기간",
        width: 100,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p) => tenureFromHireDate(p.data?.hire_date),
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        colId: "age",
        headerName: "나이",
        width: 60,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p) => ageFromRRN(p.data?.resident_number),
        valueFormatter: (p) => (p.value == null ? "-" : `${p.value}`),
        cellStyle: { textAlign: "center" } as any,
      },
      {
        colId: "gender",
        headerName: "성별",
        width: 60,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p) => {
          const g = genderFromRRN(p.data?.resident_number);
          return g ? GENDER_LABEL[g] : null;
        },
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "employment_type",
        headerName: "고용형태",
        width: 120,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) => (
          <Badge className={EMPLOYMENT_BADGE[p.value as EmploymentType] ?? ""}>
            {EMPLOYMENT_LABEL[p.value as EmploymentType] ?? p.value}
          </Badge>
        ),
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        field: "status",
        headerName: "상태",
        width: 60,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) => (
          <Badge className={STATUS_BADGE[p.value as DeveloperStatus] ?? ""}>
            {STATUS_LABEL[p.value as DeveloperStatus] ?? p.value}
          </Badge>
        ),
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        colId: "latest_salary",
        headerName: "연봉",
        hide: salaryHidden,
        width: 130,
        flex: 0,
        filter: false,
        sortable: true,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p) =>
          canSeeSalary ? (p.data?.latest_salary ?? p.data?.salary ?? null) : null,
        valueFormatter: (p) => {
          if (!canSeeSalary) return "*****";
          return p.value ? Number(p.value).toLocaleString() + "원" : "-";
        },
        cellStyle: { textAlign: "right" } as any,
      },
      {
        field: "phone",
        headerName: "연락처",
        width: 130,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "company_email",
        headerName: "회사 이메일",
        width: 250,
        flex: 0,
        filter: false,
        sortable: false,
        headerClass: "ag-center-aligned-header",
      },
      {
        colId: "birth_date",
        headerName: "생년월일",
        width: 110,
        flex: 0,
        filter: false,
        sortable: true,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p) => birthDateFromRRN(p.data?.resident_number),
        // YYYY-MM-DD 형식 — ISO 문자열을 그대로 사용 (timezone 변환 없이 안전).
        // tabular-nums + monospace 비슷한 폭 보장 → 컬럼 정렬이 깨지지 않음.
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : "-"),
        cellStyle: (p: any) => {
          const base = {
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          } as any;
          return isBirthdayThisMonth(p.value)
            ? { ...base, color: "#dc2626", fontWeight: 600 }
            : base;
        },
      },
      {
        field: "hire_date",
        headerName: "입사일",
        width: 110,
        flex: 0,
        filter: false,
        sortable: true,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : "-"),
        cellStyle: {
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
        } as any,
      },
    ],
    [canSeeSalary, rankMap, positionMap, salaryHidden],
  );

  async function handleDelete(rows: Developer[]) {
    const ok = await dialog.confirm(
      `${rows.length}명을 비활성화하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(rows.map((r) => r.id));
  }

  function openAdd() {
    setAddForm(BLANK);
    setAddError(null);
    setAddOpen(true);
  }

  function openEdit(row: Developer) {
    setEditTargetId(row.id);
    setEditForm({
      name: row.name,
      employee_no: row.employee_no ?? null,
      employment_type: row.employment_type,
      status: row.status,
      title: row.title ?? "",
      phone: row.phone ?? "",
      address: row.address ?? "",
      company_email: row.company_email ?? "",
      personal_email: row.personal_email ?? "",
      tax_invoice_email: row.tax_invoice_email ?? "",
      resident_number: row.resident_number ?? "",
      payment_method: row.payment_method,
      business_no: row.business_no ?? "",
      business_address: row.business_address ?? "",
      salary: row.salary ?? "",
      hourly_rate: row.hourly_rate ?? "",
      hire_date: row.hire_date ?? "",
      career_months_at_hire: row.career_months_at_hire ?? null,
      roles: row.roles ?? [],
      memo: row.memo ?? "",
      security_role: row.security_role ?? "ETC",
      manager_id: row.manager_id ?? null,
      rank_id: row.rank_id ?? null,
      position_id: row.position_id ?? null,
    });
    setEditError(null);
    setEditOpen(true);
  }

  return (
    <>
      <DashboardHeader title="임직원 관리" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DeveloperStatsPanel
          devs={data as any}
          rankMap={rankMap}
          // 직급별 인원수 차트 — '연구원 → 대표이사' (낮은 → 높은) 순서.
          // API 는 level DESC 로 반환하므로 reverse 해서 ASC 로 뒤집음.
          rankOrder={[...ranksList].reverse().map((r) => r.id)}
          canSeeSalary={canSeeSalary}
        />
        <DataGrid<Developer>
          ref={gridRef}
          rowData={data}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="이름, 연락처, 회사 이메일 검색"
          onSearch={(v) => setQ(v)}
          onAdd={canCreate ? openAdd : undefined}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
          onSelectionChange={setSelectedCount}
          toolbarLeading={
            <>
              <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={fullTimeOnly}
                  onChange={(e) => setFullTimeOnly(e.target.checked)}
                />
                정규직만 표시
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={salaryHidden}
                  onChange={(e) => setSalaryHidden(e.target.checked)}
                />
                연봉 숨김
              </label>
            </>
          }
          extraActions={
            <>
              <button
                type="button"
                onClick={async () => {
                  try {
                    // 체크박스 선택 행이 있으면 그 ID 들만, 없으면 전체.
                    const selected = gridRef.current?.getSelectedRows() ?? [];
                    const ids = selected.map((r) => r.id);
                    await downloadDevelopersRosterPDF(ids);
                  } catch (e: any) {
                    await dialog.alert(
                      e?.response?.data?.detail ?? "PDF 생성 실패",
                      { title: "오류" },
                    );
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
              >
                <FileText className="h-3.5 w-3.5" />
                PDF{selectedCount > 0 ? ` (${selectedCount})` : ""}
              </button>
              <button
                type="button"
                onClick={() => setOrgChartOpen(true)}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
              >
                <GitBranch className="h-3.5 w-3.5" />
                결재선
              </button>
              <button
                type="button"
                onClick={() => setPosTenureOpen(true)}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
                title="직위별 총 경력 분포 (Gantt)"
              >
                <Activity className="h-3.5 w-3.5" />
                직위 분포
              </button>
              {/* 연봉 분포 — HR/ADMIN 만 노출 (canSeeSalary). 사내 기밀. */}
              {canSeeSalary && (
                <button
                  type="button"
                  onClick={() => setSalaryDistOpen(true)}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
                  title="직위별 연차·연봉 분포 (Scatter)"
                >
                  <Activity className="h-3.5 w-3.5" />
                  연봉 분포
                </button>
              )}
            </>
          }
        />
      </div>

      {/* Add Dialog */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="신규 임직원 등록"
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
              onClick={() => {
                const msg = missingRequiredMessage(addForm);
                if (msg) {
                  setAddError(msg);
                  return;
                }
                createM.mutate();
              }}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              등록
            </button>
          </>
        }
      >
        <DeveloperFormBody
          form={addForm}
          setForm={(updater) =>
            setAddForm((prev) => (typeof updater === "function" ? updater(prev) : updater))
          }
          error={addError}
          editTargetId={null}
        />
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="임직원 수정"
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => {
                const msg = missingRequiredMessage(editForm);
                if (msg) {
                  setEditError(msg);
                  return;
                }
                updateM.mutate();
              }}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        <DeveloperFormBody
          form={editForm}
          setForm={(updater) =>
            setEditForm((prev) => (typeof updater === "function" ? updater(prev) : updater))
          }
          error={editError}
          showStatus
          editTargetId={editTargetId}
        />
      </Dialog>

      <OrgChartDialog
        open={orgChartOpen}
        onClose={() => setOrgChartOpen(false)}
      />

      <PositionTenureDialog
        open={posTenureOpen}
        onClose={() => setPosTenureOpen(false)}
        devs={data as any}
        ranks={ranksList as any}
      />
      <SalaryDistributionDialog
        open={salaryDistOpen}
        onClose={() => setSalaryDistOpen(false)}
        devs={data as any}
        ranks={ranksList as any}
        canSeeSalary={canSeeSalary}
      />
    </>
  );
}

type CustomerOption = {
  id: string;
  name: string;
  business_no?: string;
  address?: string;
};

function DeveloperFormBody({
  form,
  setForm,
  error,
  showStatus,
  editTargetId,
}: {
  form: Partial<Developer>;
  setForm: (
    f: Partial<Developer> | ((prev: Partial<Developer>) => Partial<Developer>),
  ) => void;
  error: string | null;
  showStatus?: boolean;
  /** 수정 모드면 해당 임직원 id (자기·하위 트리 제외 후보 fetch). 등록 모드는 null. */
  editTargetId: string | null;
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const isFreelancer = form.employment_type === "FREELANCER";
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const { data: featurePerms = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["feature-permissions"],
    queryFn: async () => (await api.get("/feature-permissions")).data,
    staleTime: 5 * 60_000,
  });
  const canEditRole = hasFeature(featurePerms, "employees.role.edit", me?.role);
  const isHr = me?.role === "HR";
  // HR 은 ADMIN 을 부여할 수 없고, 이미 ADMIN 인 임직원 편집 시 권한 등급 변경 금지 (코드 invariant).
  const lockAdminSlot = isHr && form.security_role === "ADMIN";

  // Kakao Map 활성화 여부 — 주소 입력 옆 아이콘 노출 게이팅.
  const { data: kakaoCfg } = useQuery<{ enabled: boolean }>({
    queryKey: ["kakao-map-config"],
    queryFn: async () =>
      (await api.get("/integrations/kakao-map")).data,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const kakaoEnabled = !!kakaoCfg?.enabled;

  const { data: customers = [] } = useQuery<CustomerOption[]>({
    queryKey: ["customers-min"],
    queryFn: async () => (await api.get("/customers")).data,
    enabled: form.payment_method === "TAX_INVOICE",
    staleTime: 60_000,
  });

  // Identify the currently-selected customer by matching business_no (primary)
  const currentCustomerId = useMemo(() => {
    if (!form.business_no) return "";
    const hit = customers.find((c) => c.business_no === form.business_no);
    return hit?.id ?? "";
  }, [customers, form.business_no]);

  function applyCustomer(cid: string) {
    const c = customers.find((x) => x.id === cid);
    if (!c) {
      setForm((p) => ({ ...p, business_no: "", business_address: "" }));
      return;
    }
    setForm((p) => ({
      ...p,
      business_no: c.business_no ?? "",
      business_address: c.address ?? "",
    }));
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {form.employee_no && (
        <Field label="사번">
          <input
            value={form.employee_no}
            readOnly
            className={input + " font-mono bg-muted/50"}
          />
        </Field>
      )}
      <Field label="이름 *">
        <input
          value={form.name ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label="직위 *">
        <GradeSelect
          endpoint="/job-ranks"
          queryKey="job-ranks-active"
          valueId={form.rank_id ?? null}
          fallbackName={form.title ?? null}
          placeholder="— 직위 선택 —"
          onChange={(id, name) =>
            setForm((p) => ({
              ...p,
              rank_id: id,
              // 직책이 비어있을 때만 직위명을 title 로 sync.
              title: p.position_id ? p.title : name ?? undefined,
            }))
          }
          inputClass={input}
        />
      </Field>
      <Field label="직책">
        <GradeSelect
          endpoint="/job-positions"
          queryKey="job-positions-active"
          valueId={form.position_id ?? null}
          fallbackName={null}
          placeholder="— 직책 없음 —"
          onChange={(id, name) =>
            setForm((p) => {
              // 직책이 선택되면 title 도 직책명으로, 직책 해제 시 직위명으로 폴백.
              if (id) {
                return { ...p, position_id: id, title: name ?? undefined };
              }
              // 직책 해제 — 직위명으로 폴백 (직위 응답은 동기 fetch 어려움 → 그대로 둠).
              return { ...p, position_id: null };
            })
          }
          inputClass={input}
        />
      </Field>
      <Field label="고용형태">
        <select
          value={form.employment_type ?? "FREELANCER"}
          onChange={(e) =>
            setForm((p) => ({ ...p, employment_type: e.target.value as EmploymentType }))
          }
          className={input}
        >
          <option value="FREELANCER">프리랜서</option>
          <option value="FULL_TIME">정규직</option>
          <option value="FULL_TIME_SPECIAL">정규직 (특수)</option>
          <option value="INSOURCED">자사화</option>
          <option value="INTERN">인턴</option>
          <option value="PART_TIME">아르바이트</option>
        </select>
      </Field>
      <Field label="연락처 *">
        <input
          value={form.phone ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
          className={input}
        />
      </Field>
      {showStatus && (
        <Field label="상태">
          <select
            value={form.status ?? "ACTIVE"}
            onChange={(e) =>
              setForm((p) => ({ ...p, status: e.target.value as DeveloperStatus }))
            }
            className={input}
          >
            <option value="ACTIVE">활성</option>
            <option value="INACTIVE">비활성</option>
          </select>
        </Field>
      )}
      {isFreelancer && (
        <Field label="연봉 (원)" colSpan={showStatus ? 1 : 2}>
          <input
            type="text"
            inputMode="numeric"
            value={formatNumberWithCommas(form.salary as string | number | undefined)}
            onChange={(e) =>
              setForm((p) => ({ ...p, salary: parseNumberInput(e.target.value) }))
            }
            placeholder="예: 96,000,000"
            className={input + " tabular-nums"}
          />
        </Field>
      )}
      <Field label="입사일 *">
        <DateInput
          value={form.hire_date ?? ""}
          onChange={(v) => setForm((p) => ({ ...p, hire_date: v }))}
        />
      </Field>
      <Field label="입사일 기준 경력 (개월)">
        <input
          type="number"
          value={
            form.career_months_at_hire == null
              ? ""
              : String(form.career_months_at_hire)
          }
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              career_months_at_hire: e.target.value === "" ? null : Number(e.target.value),
            }))
          }
          placeholder="예: 25"
          className={input}
        />
      </Field>
      <Field label="주민등록번호 *">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="XXXXXX-XXXXXXX"
          maxLength={14}
          value={form.resident_number ?? ""}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              resident_number: formatResidentNumber(e.target.value),
            }))
          }
          className={input + " tabular-nums"}
        />
      </Field>
      {canEditRole && (
        <Field label="보안등급">
          <select
            value={form.security_role ?? "ETC"}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                security_role: e.target.value as Developer["security_role"],
              }))
            }
            disabled={lockAdminSlot}
            className={input + " disabled:bg-muted"}
          >
            {isHr ? (
              <>
                <option value="SALES">영업 (SALES)</option>
                <option value="HR">HR (관리)</option>
                <option value="SUPPORT">지원 (SUPPORT)</option>
                <option value="ETC">기타 (ETC)</option>
                {form.security_role === "ADMIN" && (
                  <option value="ADMIN" disabled>
                    관리자 (ADMIN) · HR 변경 불가
                  </option>
                )}
              </>
            ) : (
              <>
                <option value="ADMIN">관리자 (ADMIN)</option>
                <option value="SALES">영업 (SALES)</option>
                <option value="HR">HR (관리)</option>
                <option value="SUPPORT">지원 (SUPPORT)</option>
                <option value="ETC">기타 (ETC)</option>
              </>
            )}
          </select>
        </Field>
      )}
      {canEditRole && (
        <Field label="상위 관리자 (1차 결재자)">
          <ManagerSelect
            value={form.manager_id ?? null}
            onChange={(v) => setForm((p) => ({ ...p, manager_id: v }))}
            editTargetId={editTargetId}
            inputClass={input}
          />
        </Field>
      )}
      <Field label="주소" colSpan={2}>
        <div className="flex items-center gap-1">
          <input
            value={form.address ?? ""}
            onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
            className={input}
          />
          {kakaoEnabled && form.address && form.address.trim() && (
            <Tooltip label="카카오맵에서 보기" side="top">
              <a
                href={`https://map.kakao.com/?q=${encodeURIComponent(form.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="카카오맵에서 보기"
                className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border border-input bg-background text-primary hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
              </a>
            </Tooltip>
          )}
        </div>
      </Field>
      <Field label={isFreelancer ? "회사 이메일" : "회사 이메일 *"}>
        <input
          type="email"
          value={form.company_email ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, company_email: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label={isFreelancer ? "개인 이메일 *" : "개인 이메일"}>
        <input
          type="email"
          value={form.personal_email ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, personal_email: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label="세금계산서 이메일" colSpan={2}>
        <input
          type="email"
          value={form.tax_invoice_email ?? ""}
          onChange={(e) => setForm((p) => ({ ...p, tax_invoice_email: e.target.value }))}
          className={input}
        />
      </Field>

      <Field label="역할" colSpan={2}>
        <div className="flex flex-wrap gap-2">
          {ROLE_OPTIONS.map((r) => {
            const selected = form.roles?.includes(r) ?? false;
            return (
              <button
                key={r}
                type="button"
                onClick={() =>
                  setForm((p) => {
                    const curr = new Set(p.roles ?? []);
                    if (curr.has(r)) curr.delete(r);
                    else curr.add(r);
                    return { ...p, roles: Array.from(curr) };
                  })
                }
                className={`h-8 rounded-full border px-3 text-xs font-medium transition-colors ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="col-span-2 mt-2 border-t border-border pt-3">
        <div className="text-xs font-semibold mb-2">비용 지급 방식</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="지급 방식">
            <select
              value={form.payment_method ?? "PAYROLL"}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  payment_method: e.target.value as PaymentMethod,
                }))
              }
              className={input}
            >
              <option value="PAYROLL">급여</option>
              <option value="TAX_INVOICE">세금계산서</option>
              <option value="HOURLY">시간</option>
            </select>
          </Field>

          {form.payment_method === "HOURLY" && (
            <Field label="시간당 금액 (KRW)">
              <input
                value={formatNumberWithCommas(form.hourly_rate ?? "")}
                onChange={(e) =>
                  setForm((p) => ({ ...p, hourly_rate: parseNumberInput(e.target.value) }))
                }
                placeholder="예: 15,000"
                inputMode="numeric"
                className={input + " tabular-nums text-right"}
              />
            </Field>
          )}

          {form.payment_method === "TAX_INVOICE" && (
            <Field label="사업자 선택 *">
              <select
                value={currentCustomerId}
                onChange={(e) => applyCustomer(e.target.value)}
                className={input}
              >
                <option value="">선택</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.business_no ? ` · ${c.business_no}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {form.payment_method === "TAX_INVOICE" && (form.business_no || form.business_address) && (
            <div className="col-span-2 text-[11px] text-muted-foreground -mt-1">
              사업자번호: {form.business_no || "-"} · 주소:{" "}
              {form.business_address || "-"}
            </div>
          )}
        </div>
      </div>

      {error && <div className="col-span-2 text-xs text-destructive">{error}</div>}
    </div>
  );
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
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
    <label className={`flex flex-col gap-1 ${colSpan === 2 ? "col-span-2" : ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}



// ---------------------------------------------------------------------------
// 등록·수정 폼의 "상위 관리자" 콤보박스 — ACTIVE 정규직 전체.
//
// 백엔드 /developers/manager-candidates 가 employment_type IN
// ('FULL_TIME','FULL_TIME_SPECIAL') AND status='ACTIVE' 만 이름 정렬로 응답.
// 사이클 방지는 PATCH 단의 SQL 가드가 처리하므로 UI 는 단순 select.
// 권한(HR/ADMIN) 체크는 호출자(DeveloperFormBody) 가 책임.
// ---------------------------------------------------------------------------
function ManagerSelect({
  value,
  onChange,
  editTargetId,
  inputClass,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  editTargetId: string | null;
  inputClass: string;
}) {
  const { data: candidates = [] } = useQuery<{
    id: string;
    name: string;
    title: string | null;
    employee_no: string | null;
  }[]>({
    queryKey: ["manager-candidates", editTargetId],
    queryFn: async () =>
      (
        await api.get("/developers/manager-candidates", {
          params: editTargetId ? { exclude_id: editTargetId } : {},
        })
      ).data,
    staleTime: 60_000,
  });

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={inputClass}
    >
      <option value="">상위 관리자 없음 (대표/외부)</option>
      {/* 정규직이 아니거나 INACTIVE 인 현재 manager 가 후보에 없으면 옵션 보강 */}
      {value && !candidates.some((c) => c.id === value) && (
        <option value={value}>(현재 선택)</option>
      )}
      {candidates.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {c.title ? ` · ${c.title}` : ""}
          {c.employee_no ? ` (${c.employee_no})` : ""}
        </option>
      ))}
    </select>
  );
}


// ---------------------------------------------------------------------------
// 직위·직책 콤보박스 — Settings 의 마스터 ACTIVE 목록.
// kind=rank/position 모두 같은 shape 라 endpoint 만 갈아끼움.
// fallback: 미설정인데 free-text title 이 있으면 마스터에서 이름 매칭 시도.
// ---------------------------------------------------------------------------
function GradeSelect({
  endpoint,
  queryKey,
  valueId,
  fallbackName,
  placeholder,
  onChange,
  inputClass,
}: {
  endpoint: string;
  queryKey: string;
  valueId: string | null;
  fallbackName: string | null;
  placeholder: string;
  onChange: (id: string | null, name: string | null) => void;
  inputClass: string;
}) {
  const { data: items = [] } = useQuery<{
    id: string;
    name: string;
    level: number;
  }[]>({
    queryKey: [queryKey],
    queryFn: async () => (await api.get(endpoint)).data,
    staleTime: 5 * 60_000,
  });

  const matchedByName =
    !valueId && fallbackName
      ? items.find((t) => t.name === fallbackName)
      : null;

  return (
    <select
      value={valueId ?? matchedByName?.id ?? ""}
      onChange={(e) => {
        const id = e.target.value || null;
        const name = id ? items.find((t) => t.id === id)?.name ?? null : null;
        onChange(id, name);
      }}
      className={inputClass}
    >
      <option value="">{placeholder}</option>
      {items.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} (level {Number(t.level)})
        </option>
      ))}
    </select>
  );
}
