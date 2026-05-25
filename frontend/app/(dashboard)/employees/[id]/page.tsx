"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, MapPin, Plus, RotateCcw, Trash2, Undo2, UserMinus } from "lucide-react";
import { api } from "@/lib/api";
import { hasFeature } from "@/components/layout/feature-registry";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { MENU_REGISTRY } from "@/components/layout/menu-registry";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { Tooltip } from "@/components/ui/Tooltip";
import { SavedAtLabel } from "@/components/ui/SavedAtLabel";
import { AttachmentsSection } from "@/components/developer/AttachmentsSection";
import { ResumeSection } from "@/components/developer/ResumeSection";
import { CommentsBlock, type CommentRow } from "@/components/support/CommentsBlock";
import { ApprovalChainView } from "@/components/permissions/ApprovalChainView";

type TabKey =
  | "info"
  | "resume"
  | "passport"
  | "emergency"
  | "attachments"
  | "interview";

const TABS: { key: TabKey; label: string }[] = [
  { key: "info", label: "기본정보" },
  { key: "resume", label: "이력서" },
  { key: "passport", label: "여권정보" },
  { key: "emergency", label: "비상연락처" },
  { key: "attachments", label: "첨부파일" },
  { key: "interview", label: "면담" },
];

type EmploymentType = "FREELANCER" | "FULL_TIME" | "INSOURCED";
type DeveloperStatus = "ACTIVE" | "INACTIVE";

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  FULL_TIME: "정규직",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
};

const STATUS_LABEL: Record<DeveloperStatus, string> = {
  ACTIVE: "활성",
  INACTIVE: "비활성",
};

type Developer = {
  id: string;
  name: string;
  employment_type: EmploymentType;
  status: DeveloperStatus;
  title?: string;
  phone?: string;
  address?: string;
  personal_email?: string;
  company_email?: string;
  tax_invoice_email?: string;
  resident_number?: string;
  payment_method: "PAYROLL" | "TAX_INVOICE";
  business_no?: string;
  business_address?: string;
  latest_salary?: string | number | null;
  hire_date?: string;
  career_months_at_hire?: number | null;
  resigned_date?: string | null;
  resignation_reason?: string | null;
  roles?: string[];
  created_at: string;
  manager_id?: string | null;
  rank_id?: string | null;
  position_id?: string | null;
};

type SalaryRow = {
  id: string;
  developer_id: string;
  annual_salary: string;
  effective_from: string;
  effective_to?: string | null;
  note?: string;
  estimated_employee_insurance_monthly?: string | null;
  estimated_employer_insurance_monthly?: string | null;
  actual_employee_insurance_monthly?: string | null;
  actual_employer_insurance_monthly?: string | null;
  created_at: string;
};

type InsuranceRate = {
  national_pension_rate: string;
  national_pension_ceiling: number;
  health_rate: string;
  long_term_care_rate_on_health: string;
  employment_unemployment_rate: string;
  employment_stability_rate: string;
  industrial_accident_rate: string;
  effective_from: string;
};

type InsuranceBreakdown = {
  pension: number;
  health: number;
  long_term_care: number;
  employment: number;
  industrial_accident: number;
  total: number;
};

function computeInsurance(annual: number, rate: InsuranceRate) {
  const monthly = annual / 12;
  const pensionBase = Math.min(monthly, rate.national_pension_ceiling);
  const pension = pensionBase * Number(rate.national_pension_rate);
  const health = monthly * Number(rate.health_rate);
  const care = health * Number(rate.long_term_care_rate_on_health);
  const unemployment = monthly * Number(rate.employment_unemployment_rate);
  const stability = monthly * Number(rate.employment_stability_rate);
  const industrial = monthly * Number(rate.industrial_accident_rate);

  // 근로자는 실업급여만, 고용안정·직능 + 산재는 사업자 단독
  const employee: InsuranceBreakdown = {
    pension,
    health,
    long_term_care: care,
    employment: unemployment,
    industrial_accident: 0,
    total: pension + health + care + unemployment,
  };
  const employer: InsuranceBreakdown = {
    pension,
    health,
    long_term_care: care,
    employment: unemployment + stability,
    industrial_accident: industrial,
    total: pension + health + care + unemployment + stability + industrial,
  };
  return { monthly, employee, employer };
}

type AssignmentHistory = {
  assignment_id: string;
  project_id: string;
  project_name: string;
  start_date: string;
  end_date: string;
  monthly_rate: string;
  is_insourced: boolean;
};

export default function DeveloperDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: dev } = useQuery<Developer>({
    queryKey: ["developer", id],
    queryFn: async () => (await api.get(`/developers/${id}`)).data,
  });

  // 탭 노출 — 본인 데이터는 항상 본인이 열람(코드 invariant), 그 외는 기능 권한.
  const { data: me } = useQuery<{
    id: string;
    role: string;
    mapped_developer_id?: string | null;
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60 * 1000,
  });
  const { data: featurePerms = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["feature-permissions"],
    queryFn: async () => (await api.get("/feature-permissions")).data,
    staleTime: 5 * 60 * 1000,
  });
  const isSelf = !!me && me.mapped_developer_id === id;
  const canSeePassport =
    !!me &&
    (isSelf || hasFeature(featurePerms, "employees.tab.passport", me.role));
  const canSeeEmergency =
    !!me &&
    (isSelf || hasFeature(featurePerms, "employees.tab.emergency", me.role));
  // 면담은 본인 예외 없음 (HR 평가 보호) — 기능 권한만 본다.
  const canSeeInterview =
    !!me && hasFeature(featurePerms, "employees.tab.interview", me.role);
  const visibleTabs = TABS.filter((t) => {
    if (t.key === "passport") return canSeePassport;
    if (t.key === "emergency") return canSeeEmergency;
    if (t.key === "interview") return canSeeInterview;
    return true;
  });

  const [activeTab, setActiveTab] = useState<TabKey>("info");
  const [resignOpen, setResignOpen] = useState(false);
  const [resignForm, setResignForm] = useState({ resigned_date: "", reason: "" });
  const [resignError, setResignError] = useState<string | null>(null);

  const resignM = useMutation({
    mutationFn: async () => {
      const payload = {
        resigned_date: resignForm.resigned_date,
        resignation_reason: resignForm.reason || null,
        status: "INACTIVE" as const,
      };
      return (await api.patch(`/developers/${id}`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["developer", id] });
      qc.invalidateQueries({ queryKey: ["developers"] });
      setResignOpen(false);
      setResignForm({ resigned_date: "", reason: "" });
      setResignError(null);
    },
    onError: (e: any) =>
      setResignError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "처리 실패",
      ),
  });

  const restoreM = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/developers/${id}`, {
          resigned_date: null,
          resignation_reason: null,
          status: "ACTIVE",
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["developer", id] });
      qc.invalidateQueries({ queryKey: ["developers"] });
    },
  });

  if (!dev)
    return (
      <>
        <DashboardHeader title="임직원" />
        <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">로딩 중...</div>
      </>
    );

  // 퇴사 처리 시 status 는 INACTIVE, resigned_date 는 채워지는 것이 정상 경로.
  // 둘 중 하나만 세팅된 엣지케이스에도 "퇴사 상태" 로 간주해 중복 퇴사를 막는다.
  const alreadyResigned = !!dev.resigned_date || dev.status === "INACTIVE";

  return (
    <>
      <DashboardHeader
        title={dev.name}
        actions={
          <>
            <Link
              href="/employees"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
            {alreadyResigned ? (
              <button
                type="button"
                onClick={async () => {
                  if (
                    await dialog.confirm(
                      "퇴사 처리를 취소하고 복직시키겠습니까?",
                    )
                  ) {
                    restoreM.mutate();
                  }
                }}
                className="h-8 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted inline-flex items-center gap-1"
              >
                <Undo2 className="h-3.5 w-3.5" />
                퇴사 취소
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setResignForm({
                    resigned_date: new Date().toISOString().slice(0, 10),
                    reason: "",
                  });
                  setResignError(null);
                  setResignOpen(true);
                }}
                className="h-8 rounded-md border border-destructive/40 bg-background px-3 text-sm text-destructive hover:bg-destructive/10 inline-flex items-center gap-1"
              >
                <UserMinus className="h-3.5 w-3.5" />
                퇴사
              </button>
            )}
          </>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        <TabBar>
          {visibleTabs.map((t) => (
            <TabItem
              key={t.key}
              active={activeTab === t.key}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </TabItem>
          ))}
        </TabBar>
        {activeTab === "info" && (
          <>
            <InfoCard dev={dev} />
            {/* 결재선 체인 — 읽기 전용. 편집(보안등급/연차 승인자/상위 관리자)
                은 권한 관리 → 결재선·보안등급 탭에서. */}
            <ApprovalChainView developerId={id} />
            <SalaryHistory
              developerId={id}
              isFreelancer={dev.employment_type === "FREELANCER"}
            />
            <SalaryTrend
              developerId={id}
              resignedDate={dev.resigned_date ?? null}
              isFreelancer={dev.employment_type === "FREELANCER"}
            />
            <PermissionGrantsSummary developerId={id} />
            <PasswordResetSection developerId={id} />
            <AssignmentHistorySection developerId={id} />
          </>
        )}
        {activeTab === "resume" && <ResumeSection developerId={id} />}
        {activeTab === "passport" && canSeePassport && (
          <PassportSection developerId={id} />
        )}
        {activeTab === "emergency" && canSeeEmergency && (
          <EmergencyContactsSection developerId={id} />
        )}
        {activeTab === "attachments" && <AttachmentsSection developerId={id} />}
        {activeTab === "interview" && canSeeInterview && (
          <InterviewsSection
            developerId={id}
            currentUserId={me?.id ?? null}
            currentUserRole={me?.role ?? null}
          />
        )}
      </div>

      <Dialog
        open={resignOpen}
        onClose={() => setResignOpen(false)}
        title="퇴사 처리"
        width="max-w-md"
        footer={
          <>
            <button
              type="button"
              onClick={() => setResignOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => resignForm.resigned_date && resignM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-destructive px-3 text-sm text-destructive-foreground hover:opacity-90"
            >
              <UserMinus className="h-4 w-4" />
              퇴사 처리
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">퇴사일 *</span>
            <DateInput
              value={resignForm.resigned_date}
              onChange={(v) => setResignForm((p) => ({ ...p, resigned_date: v }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">퇴사 사유</span>
            <textarea
              value={resignForm.reason}
              onChange={(e) =>
                setResignForm((p) => ({ ...p, reason: e.target.value }))
              }
              rows={3}
              placeholder="예: 개인 사정, 이직 등"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <p className="text-sm text-muted-foreground">
            퇴사일 이후 월부터는 월급여 계산에서 제외됩니다. 임직원 상태는
            자동으로 <span className="font-semibold">비활성</span>으로 변경됩니다.
          </p>
          {resignError && <div className="text-sm text-destructive">{resignError}</div>}
        </div>
      </Dialog>
    </>
  );
}

function InfoCard({ dev }: { dev: Developer }) {
  // Kakao Map 이 활성화돼 있으면 주소 옆 아이콘으로 카카오맵 외부 링크 노출.
  // Developer 는 lat/lng 가 없어 지도 팝업 대신 새 탭에서 카카오맵을 연다.
  const { data: kakaoCfg } = useQuery<{ enabled: boolean }>({
    queryKey: ["kakao-map-config"],
    queryFn: async () =>
      (await api.get("/integrations/kakao-map")).data,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const kakaoEnabled = !!kakaoCfg?.enabled;

  // 직위(rank) / 직책(position) ID → 이름 lookup. 임직원 그리드와 동일한
  // query key 를 공유해 캐시 재사용.
  const { data: ranksList = [] } = useQuery<{ id: string; name: string }[]>({
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
  const rankName = dev.rank_id
    ? ranksList.find((r) => r.id === dev.rank_id)?.name ?? null
    : null;
  const positionName = dev.position_id
    ? positionsList.find((p) => p.id === dev.position_id)?.name ?? null
    : null;
  const rankPositionDisplay =
    rankName && positionName
      ? `${rankName} / ${positionName}`
      : rankName ?? positionName ?? "-";

  const mapAction = (address: string | null | undefined) =>
    kakaoEnabled && address && address.trim() ? (
      <Tooltip label="카카오맵에서 보기" side="top">
        <a
          href={`https://map.kakao.com/?q=${encodeURIComponent(address)}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="카카오맵에서 보기"
          className="inline-flex items-center justify-center h-5 w-5 rounded text-primary hover:bg-muted"
        >
          <MapPin className="h-3.5 w-3.5" />
        </a>
      </Tooltip>
    ) : undefined;

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <Row label="이름" value={dev.name} />
        <Row label="직위/직책" value={rankPositionDisplay} />
        <Row label="고용형태" value={EMPLOYMENT_LABEL[dev.employment_type]} />
        <Row label="상태" value={STATUS_LABEL[dev.status]} />
        <Row label="연락처" value={dev.phone ?? "-"} />
        <Row
          label="지급 방식"
          value={dev.payment_method === "TAX_INVOICE" ? "세금계산서" : "급여"}
        />
        <Row label="개인 이메일" value={dev.personal_email ?? "-"} />
        <Row label="회사 이메일" value={dev.company_email ?? "-"} />
        <Row label="세금계산서 이메일" value={dev.tax_invoice_email ?? "-"} />
        <Row label="주민등록번호" value={dev.resident_number ?? "-"} />
        <Row label="역할" value={dev.roles?.length ? dev.roles.join(", ") : "-"} />
        <Row
          label="최종 연봉"
          value={
            dev.latest_salary
              ? `${Number(dev.latest_salary).toLocaleString()}원`
              : "-"
          }
        />
        <Row label="입사일" value={dev.hire_date ?? "-"} />
        <Row
          label="경력"
          value={careerText(dev.hire_date, dev.career_months_at_hire ?? null)}
        />
        {dev.resigned_date && (
          <>
            <Row label="퇴사일" value={dev.resigned_date} />
            <Row label="퇴사 사유" value={dev.resignation_reason ?? "-"} />
          </>
        )}
        <Row
          label="주소"
          value={dev.address ?? "-"}
          action={mapAction(dev.address)}
        />
        {dev.payment_method === "TAX_INVOICE" && (
          <>
            <Row label="사업자등록번호" value={dev.business_no ?? "-"} />
            <Row
              label="사업자 주소"
              value={dev.business_address ?? "-"}
              action={mapAction(dev.business_address)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 items-center">
      <span className="w-36 text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium">{value}</span>
      {action}
    </div>
  );
}

function SalaryHistory({
  developerId,
  isFreelancer,
}: {
  developerId: string;
  isFreelancer: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [form, setForm] = useState({
    annual_salary: "",
    effective_from: "",
    effective_to: "",
    note: "",
  });
  const [error, setError] = useState<string | null>(null);

  const { data: rows = [], isError } = useQuery<SalaryRow[]>({
    queryKey: ["dev-salaries", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/salaries`)).data,
    retry: false,
  });

  const { data: rate } = useQuery<InsuranceRate>({
    queryKey: ["insurance-rate-current", form.effective_from || "today"],
    queryFn: async () =>
      (
        await api.get("/hr/insurance-rates/current", {
          params: form.effective_from ? { at: form.effective_from } : undefined,
        })
      ).data,
    retry: false,
    enabled: !isFreelancer,
  });

  const annualNum = Number(form.annual_salary);
  const preview =
    !isFreelancer && Number.isFinite(annualNum) && annualNum > 0 && rate
      ? computeInsurance(annualNum, rate)
      : null;

  // 이전 연봉(지금 등록할 row보다 앞서 끝났거나 시작 중인 가장 최근 row)
  const previousRow = rows
    .filter((r) => !form.effective_from || r.effective_from < form.effective_from)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  const raisePct =
    previousRow && annualNum > 0
      ? ((annualNum - Number(previousRow.annual_salary)) /
          Number(previousRow.annual_salary)) *
        100
      : null;

  const addM = useMutation({
    mutationFn: async () => {
      if (form.effective_to && form.effective_to <= form.effective_from) {
        throw new Error("종료일은 시작일보다 뒤여야 합니다.");
      }
      const payload = {
        annual_salary: form.annual_salary,
        effective_from: form.effective_from,
        effective_to: form.effective_to || null,
        note: form.note || undefined,
      };
      return (await api.post(`/developers/${developerId}/salaries`, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-salaries", developerId] });
      qc.invalidateQueries({ queryKey: ["developer", developerId] });
      qc.invalidateQueries({ queryKey: ["developers"] });
      setForm({
        annual_salary: "",
        effective_from: "",
        effective_to: "",
        note: "",
      });
      setError(null);
    },
    onError: (e: any) =>
      setError(
        e?.message ??
          e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "등록 실패",
      ),
  });

  const deleteM = useMutation({
    mutationFn: async (sid: string) => api.delete(`/developers/salaries/${sid}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dev-salaries", developerId] });
      qc.invalidateQueries({ queryKey: ["developer", developerId] });
      qc.invalidateQueries({ queryKey: ["developers"] });
    },
  });

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="font-semibold mb-3">연봉 이력</h2>

      {isError ? (
        <p className="text-sm text-muted-foreground">관리자만 조회할 수 있습니다.</p>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">등록된 이력이 없습니다.</p>
          ) : (
            <table className="w-full text-sm mb-3 table-fixed border-collapse border border-border">
              <colgroup>
                <col style={{ width: "7rem" }} />
                <col style={{ width: "7rem" }} />
                <col style={{ width: "8rem" }} />
                {!isFreelancer && <col style={{ width: "7rem" }} />}
                {!isFreelancer && <col style={{ width: "7rem" }} />}
                <col />
                <col style={{ width: "4rem" }} />
              </colgroup>
              <thead className="text-sm text-muted-foreground">
                <tr>
                  <th className="py-1 px-2 border border-border text-center">시작일</th>
                  <th className="py-1 px-2 border border-border text-center">종료일</th>
                  <th className="py-1 px-2 border border-border text-right">
                    {isFreelancer ? "단가/연봉" : "연봉"}
                  </th>
                  {!isFreelancer && (
                    <th
                      className="py-1 px-2 border border-border text-right"
                      colSpan={2}
                    >
                      예상 4대보험 (근로자 / 회사)
                    </th>
                  )}
                  <th className="py-1 px-2 border border-border text-center">메모</th>
                  <th className="py-1 px-2 border border-border text-center">작업</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="py-1.5 px-2 border border-border text-center">
                      {s.effective_from}
                    </td>
                    <td className="py-1.5 px-2 border border-border text-center">
                      {s.effective_to ?? (
                        <span className="text-muted-foreground">~ (현재)</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 border border-border text-right tabular-nums">
                      {Number(s.annual_salary).toLocaleString()}원
                    </td>
                    {!isFreelancer && (
                      <td className="py-1.5 px-2 border border-border text-right tabular-nums text-muted-foreground">
                        {money(s.estimated_employee_insurance_monthly)}
                      </td>
                    )}
                    {!isFreelancer && (
                      <td className="py-1.5 px-2 border border-border text-right tabular-nums text-muted-foreground">
                        {money(s.estimated_employer_insurance_monthly)}
                      </td>
                    )}
                    <td className="py-1.5 px-2 border border-border text-center text-muted-foreground truncate">
                      {s.note ?? ""}
                    </td>
                    <td className="py-1.5 px-2 border border-border text-center">
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            await dialog.confirm("이 항목을 삭제하시겠습니까?", {
                              destructive: true,
                            })
                          ) {
                            deleteM.mutate(s.id);
                          }
                        }}
                        className="inline-flex items-center gap-0.5 text-sm text-destructive hover:underline"
                      >
                        <Trash2 className="h-3 w-3" />
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="grid grid-cols-[140px,140px,minmax(0,0.15fr),1fr,auto] gap-2 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">시작일 *</span>
              <DateInput
                value={form.effective_from}
                onChange={(v) => setForm((p) => ({ ...p, effective_from: v }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">
                종료일 <span className="text-sm">(비우면 현재)</span>
              </span>
              <DateInput
                value={form.effective_to}
                onChange={(v) => setForm((p) => ({ ...p, effective_to: v }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">연봉 (원) *</span>
              <input
                type="text"
                inputMode="numeric"
                value={formatNumberInput(form.annual_salary)}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    annual_salary: e.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
                placeholder="0"
                className={`${input} text-right`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">메모</span>
              <input
                value={form.note}
                onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
                placeholder="예: 연봉협상, 승급"
                className={input}
              />
            </label>
            <button
              type="button"
              disabled={!form.annual_salary || !form.effective_from}
              onClick={() => addM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              연봉 추가
            </button>
          </div>

          {preview && (
            <div className="mt-3 rounded-md border border-dashed border-primary/40 bg-primary/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-primary">
                  예상 4대보험 (월 보수 {Math.round(preview.monthly).toLocaleString()}원 기준)
                </span>
                {raisePct != null && (
                  <span
                    className={`text-sm font-semibold ${
                      raisePct > 0
                        ? "text-emerald-600"
                        : raisePct < 0
                        ? "text-red-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    이전 대비 {raisePct > 0 ? "+" : ""}
                    {raisePct.toFixed(2)}%
                    {previousRow && (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        ({Number(previousRow.annual_salary).toLocaleString()}원 → {annualNum.toLocaleString()}원)
                      </span>
                    )}
                  </span>
                )}
                {raisePct == null && previousRow == null && annualNum > 0 && (
                  <span className="text-sm text-muted-foreground">초기 등록</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <InsuranceColumn title="본인 부담 (근로자)" br={preview.employee} />
                <InsuranceColumn title="회사 부담 (사업주)" br={preview.employer} />
              </div>

              {rate && (
                <div className="mt-2 text-sm text-muted-foreground">
                  요율 기준일: {rate.effective_from}
                </div>
              )}
            </div>
          )}
          {error && <div className="text-sm text-destructive mt-2">{error}</div>}
        </>
      )}
    </section>
  );
}

function InsuranceColumn({
  title,
  br,
}: {
  title: string;
  br: InsuranceBreakdown;
}) {
  const fmt = (n: number) => `${Math.round(n).toLocaleString()}원`;
  return (
    <div>
      <div className="text-sm font-semibold text-muted-foreground mb-1">
        {title}
      </div>
      <Line label="국민연금" v={fmt(br.pension)} />
      <Line label="건강보험" v={fmt(br.health)} />
      <Line label="장기요양" v={fmt(br.long_term_care)} />
      <Line label="고용보험" v={fmt(br.employment)} />
      {br.industrial_accident > 0 && (
        <Line label="산재" v={fmt(br.industrial_accident)} />
      )}
      <div className="flex justify-between border-t border-border mt-1 pt-1">
        <span className="font-semibold">합계</span>
        <span className="font-semibold tabular-nums">{fmt(br.total)}</span>
      </div>
    </div>
  );
}

function Line({ label, v }: { label: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

function toYearMonths(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return `${m ?? 0}개월`;
  const y = Math.floor(m / 12);
  const mm = m % 12;
  if (y === 0) return `${mm}개월`;
  if (mm === 0) return `${y}년`;
  return `${y}년 ${mm}개월`;
}

function careerText(
  hireDate?: string | null,
  atHire?: number | null,
): string {
  if (atHire == null && !hireDate) return "-";
  const atHireVal = atHire ?? 0;
  const sinceHire = hireDate
    ? Math.max(0, monthsBetween(new Date(`${hireDate}T00:00:00`), new Date()))
    : 0;
  const total = atHireVal + sinceHire;
  const parts: string[] = [];
  parts.push(`총 ${toYearMonths(total)} (${total}개월)`);
  if (hireDate || atHire != null) {
    parts.push(
      `입사 기준 ${toYearMonths(atHireVal)} + 입사 후 ${toYearMonths(sinceHire)}`,
    );
  }
  return parts.join(" · ");
}

function money(v: string | number | null | undefined): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return `${Math.round(n).toLocaleString()}원`;
}

function formatNumberInput(v: string): string {
  if (!v) return "";
  const digits = v.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}

function SalaryTrend({
  developerId,
  resignedDate,
  isFreelancer,
}: {
  developerId: string;
  resignedDate: string | null;
  isFreelancer: boolean;
}) {
  const { data: rows = [], isError } = useQuery<SalaryRow[]>({
    queryKey: ["dev-salaries", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/salaries`)).data,
    retry: false,
  });

  const nowYear = new Date().getFullYear();
  const [monthlyYear, setMonthlyYear] = useState<number>(nowYear);

  if (isError) {
    return (
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h2 className="font-semibold mb-3">연봉 추이</h2>
        <p className="text-sm text-muted-foreground">관리자만 조회할 수 있습니다.</p>
      </section>
    );
  }
  if (rows.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h2 className="font-semibold mb-3">연봉 추이</h2>
        <p className="text-sm text-muted-foreground">표시할 데이터가 없습니다.</p>
      </section>
    );
  }

  const contractPoints = buildContractPoints(rows);

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm space-y-6">
      <h2 className="font-semibold">연봉 추이</h2>

      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="text-sm font-semibold text-muted-foreground">
            계약 단위 (연봉)
          </div>
          <div className="ml-auto text-sm text-muted-foreground">
            직전 계약 대비 인상율
          </div>
        </div>
        {contractPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">표시할 계약이 없습니다.</p>
        ) : (
          <ContractBars data={contractPoints} />
        )}
      </div>

      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="text-sm font-semibold text-muted-foreground">
            월단위 (월봉 = 연봉 / 12)
          </div>
          <div className="ml-auto flex items-center gap-2">
            <NavButton
              onClick={() => setMonthlyYear((y) => y - 1)}
              title="이전 해"
            >
              ‹
            </NavButton>
            <span className="text-sm font-medium tabular-nums w-20 text-center">
              {monthlyYear}년
            </span>
            <NavButton
              onClick={() => setMonthlyYear((y) => Math.min(nowYear, y + 1))}
              disabled={monthlyYear >= nowYear}
              title="다음 해"
            >
              ›
            </NavButton>
          </div>
        </div>
        <MonthlyTable
          developerId={developerId}
          rows={rows}
          year={monthlyYear}
          resignedDate={resignedDate}
          isFreelancer={isFreelancer}
        />
      </div>
    </section>
  );
}

function NavButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-7 w-7 rounded-md border border-border bg-background text-sm hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
  return title ? (
    <Tooltip label={title} side="top">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

type ContractPoint = {
  id: string;
  label: string; // 예: "24.01 ~ 24.12" 혹은 "25.07 ~ (현재)"
  annual: number;
  growth: number | null;
};

function salaryAtDate(rows: SalaryRow[], iso: string): number | null {
  const d = new Date(`${iso}T00:00:00`).getTime();
  const candidates = rows.filter((r) => {
    const from = new Date(`${r.effective_from}T00:00:00`).getTime();
    const to = r.effective_to
      ? new Date(`${r.effective_to}T00:00:00`).getTime()
      : Infinity;
    return from <= d && d <= to;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return Number(candidates[0].annual_salary);
}

function buildContractPoints(rows: SalaryRow[]): ContractPoint[] {
  // effective_from 오름차순으로 정렬해 직전 계약 대비 증감 계산
  const sorted = [...rows].sort((a, b) =>
    a.effective_from.localeCompare(b.effective_from),
  );
  const points: ContractPoint[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const annual = Number(r.annual_salary);
    if (!Number.isFinite(annual)) continue;
    const prev = i > 0 ? Number(sorted[i - 1].annual_salary) : NaN;
    const growth =
      Number.isFinite(prev) && prev > 0 ? ((annual - prev) / prev) * 100 : null;
    const from = shortYM(r.effective_from);
    const to = r.effective_to ? shortYM(r.effective_to) : "(현재)";
    points.push({
      id: r.id,
      label: `${from} ~ ${to}`,
      annual,
      growth,
    });
  }
  return points;
}

function shortYM(iso: string): string {
  // "2024-07-15" -> "24.07"
  return `${iso.slice(2, 4)}.${iso.slice(5, 7)}`;
}

function ContractBars({ data }: { data: ContractPoint[] }) {
  const max = Math.max(...data.map((d) => d.annual), 1);
  return (
    <div
      className="flex items-end gap-3 pt-8 pb-2 border-b border-border overflow-x-auto"
      style={{ minHeight: 220 }}
    >
      {data.map((d) => {
        const heightPct = Math.max(4, (d.annual / max) * 100);
        const growthColor =
          d.growth == null
            ? "text-muted-foreground"
            : d.growth > 0
            ? "text-emerald-600"
            : d.growth < 0
            ? "text-red-600"
            : "text-muted-foreground";
        return (
          <div
            key={d.id}
            className="flex flex-col items-center flex-1 min-w-[100px]"
          >
            <div className={`text-sm font-semibold ${growthColor} mb-1`}>
              {d.growth == null
                ? "—"
                : `${d.growth > 0 ? "+" : ""}${d.growth.toFixed(1)}%`}
            </div>
            <div className="text-sm font-semibold mb-1 tabular-nums">
              {Math.round(d.annual).toLocaleString()}원
            </div>
            <div
              className="w-full bg-muted rounded-sm overflow-hidden"
              style={{ height: 140 }}
            >
              <div
                className="w-full bg-primary transition-all"
                style={{ height: `${heightPct}%`, marginTop: `${100 - heightPct}%` }}
              />
            </div>
            <div className="text-sm mt-1 text-muted-foreground whitespace-nowrap">
              {d.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthlyTable({
  developerId,
  rows,
  year,
  resignedDate,
  isFreelancer,
}: {
  developerId: string;
  rows: SalaryRow[];
  year: number;
  resignedDate: string | null;
  isFreelancer: boolean;
}) {
  const { data: rates = [] } = useQuery<InsuranceRate[]>({
    queryKey: ["insurance-rates-all"],
    queryFn: async () => (await api.get("/hr/insurance-rates")).data,
    enabled: !isFreelancer,
  });

  const today = new Date();
  const months = Array.from({ length: 12 }, (_, i) => i + 1);

  type Cell = {
    monthly: number | null;
    est_emp: InsuranceBreakdown | null;
    est_co: InsuranceBreakdown | null;
    act_emp: number | null;
    act_co: number | null;
    projected: boolean;
  };

  const resignedTs = resignedDate
    ? new Date(`${resignedDate}T00:00:00`).getTime()
    : null;

  const data: Cell[] = months.map((m) => {
    const probeDate = new Date(year, m - 1, 1);
    const isFuture = probeDate > today;
    const iso = `${year}-${String(m).padStart(2, "0")}-01`;

    // After the resignation date, exclude this employee from salary calc.
    if (resignedTs != null && probeDate.getTime() > resignedTs) {
      return {
        monthly: null,
        est_emp: null,
        est_co: null,
        act_emp: null,
        act_co: null,
        projected: false,
      };
    }

    // Find the most-recent salary row whose effective_from <= this month.
    // If it's effective_to has passed, we mark this month as 'projected'
    // (no confirmed contract covers this month, but we carry the last-known
    //  salary forward as a best-effort estimate).
    const probeTs = probeDate.getTime();
    const startedRows = rows
      .filter(
        (r) =>
          new Date(`${r.effective_from}T00:00:00`).getTime() <= probeTs,
      )
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
    const salaryRow = startedRows[0] ?? null;

    if (!salaryRow)
      return {
        monthly: null,
        est_emp: null,
        est_co: null,
        act_emp: null,
        act_co: null,
        projected: false,
      };

    const endTs = salaryRow.effective_to
      ? new Date(`${salaryRow.effective_to}T00:00:00`).getTime()
      : Infinity;
    const projected = endTs < probeTs;

    const annual = Number(salaryRow.annual_salary);
    const rate = rateAtDate(rates, iso);
    const calc = rate ? computeInsurance(annual, rate) : null;
    return {
      monthly: annual / 12,
      est_emp: calc?.employee ?? null,
      est_co: calc?.employer ?? null,
      act_emp:
        isFuture || projected || salaryRow.actual_employee_insurance_monthly == null
          ? null
          : Number(salaryRow.actual_employee_insurance_monthly),
      act_co:
        isFuture || projected || salaryRow.actual_employer_insurance_monthly == null
          ? null
          : Number(salaryRow.actual_employer_insurance_monthly),
      projected,
    };
  });

  const projectedFlags = data.map((c) => c.projected);
  const anyProjected = projectedFlags.some(Boolean);

  const hasAny = data.some((c) => c.monthly != null);
  if (!hasAny) {
    return <p className="text-sm text-muted-foreground">이 해에는 데이터가 없습니다.</p>;
  }

  const fmt = (n: number | null | undefined) =>
    n == null ? "-" : Math.round(n).toLocaleString();

  return (
    <div className="overflow-x-auto">
      {resignedDate && (
        <div className="text-sm text-destructive mb-2">
          ※ 퇴사일 ({resignedDate}) 이후 월은 급여 계산에서 제외됩니다.
        </div>
      )}
      {anyProjected && (
        <div className="text-sm text-blue-600 mb-2">
          ※ 파란색은 연봉 계약이 종료된 이후의 월로, 마지막 연봉을 기준으로 한
          추정치입니다.
        </div>
      )}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="text-left py-1 pr-2">항목</th>
            {months.map((m) => (
              <th key={m} className="text-right py-1 px-1 tabular-nums">
                {m}월
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <BodyRow
            label="월 급여"
            cells={data.map((c) => fmt(c.monthly))}
            projected={projectedFlags}
            bold
          />

          {!isFreelancer && (
            <>
              <GroupRow label="예상 4대보험 · 근로자 부담" />
              <BodyRow
                label="국민연금"
                cells={data.map((c) => fmt(c.est_emp?.pension))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="건강보험"
                cells={data.map((c) => fmt(c.est_emp?.health))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="장기요양"
                cells={data.map((c) => fmt(c.est_emp?.long_term_care))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="고용보험"
                cells={data.map((c) => fmt(c.est_emp?.employment))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="소계"
                cells={data.map((c) => fmt(c.est_emp?.total))}
                projected={projectedFlags}
              />

              <GroupRow label="예상 4대보험 · 회사 부담" />
              <BodyRow
                label="국민연금"
                cells={data.map((c) => fmt(c.est_co?.pension))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="건강보험"
                cells={data.map((c) => fmt(c.est_co?.health))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="장기요양"
                cells={data.map((c) => fmt(c.est_co?.long_term_care))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="고용보험"
                cells={data.map((c) => fmt(c.est_co?.employment))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="산재"
                cells={data.map((c) => fmt(c.est_co?.industrial_accident))}
                projected={projectedFlags}
                dim
              />
              <BodyRow
                label="소계"
                cells={data.map((c) => fmt(c.est_co?.total))}
                projected={projectedFlags}
              />

              <BodyRow
                label="월 급여 + 근로자 부담"
                cells={data.map((c) =>
                  fmt(
                    c.monthly != null && c.est_emp?.total != null
                      ? c.monthly + c.est_emp.total
                      : null,
                  ),
                )}
                projected={projectedFlags}
                bold
              />
              <BodyRow
                label="월 급여 + 회사 부담"
                cells={data.map((c) =>
                  fmt(
                    c.monthly != null && c.est_co?.total != null
                      ? c.monthly + c.est_co.total
                      : null,
                  ),
                )}
                projected={projectedFlags}
                bold
              />
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function GroupRow({ label }: { label: string }) {
  return (
    <tr className="border-t border-border bg-muted/40">
      <td colSpan={13} className="py-1 px-2 text-sm font-semibold text-muted-foreground">
        {label}
      </td>
    </tr>
  );
}

function BodyRow({
  label,
  cells,
  projected,
  bold,
  dim,
}: {
  label: string;
  cells: string[];
  projected?: boolean[];
  bold?: boolean;
  dim?: boolean;
}) {
  return (
    <tr className="border-t border-border">
      <td
        className={`py-1 pr-2 ${bold ? "font-semibold" : ""} ${dim ? "text-muted-foreground pl-4" : ""}`}
      >
        {label}
      </td>
      {cells.map((v, i) => {
        const isProj = projected?.[i] && v !== "-";
        const cls = isProj
          ? "text-blue-600"
          : dim
          ? "text-muted-foreground"
          : "";
        return (
          <td
            key={i}
            className={`py-1 px-1 text-right tabular-nums ${bold ? "font-semibold" : ""} ${cls}`}
          >
            {v}
          </td>
        );
      })}
    </tr>
  );
}

function rateAtDate(rates: InsuranceRate[], iso: string): InsuranceRate | null {
  const d = iso;
  const candidates = rates.filter((r) => r.effective_from <= d);
  if (candidates.length === 0) return rates[0] ?? null;
  candidates.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return candidates[0];
}



function PasswordResetSection({ developerId }: { developerId: string }) {
  const dialog = useDialog();
  const [result, setResult] = useState<{
    mode: "birthday" | "random";
    temp_password: string | null;
  } | null>(null);

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
  const { data: dev } = useQuery<{ security_role: string }>({
    queryKey: ["developer", developerId],
    queryFn: async () => (await api.get(`/developers/${developerId}`)).data,
  });

  // `employees.password.reset` 권한 없으면 섹션 자체 숨김.
  const canManage = hasFeature(featurePerms, "employees.password.reset", me?.role);
  // HR→ADMIN 대상자 초기화 차단 — 코드 invariant (설정으로 못 풀게).
  const blockedForHr = me?.role === "HR" && dev?.security_role === "ADMIN";

  const resetM = useMutation({
    mutationFn: async () =>
      (await api.post(`/developers/${developerId}/password/reset`)).data as {
        mode: "birthday" | "random";
        temp_password: string | null;
      },
    onSuccess: (data) => {
      setResult(data);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "재설정 실패", {
        title: "오류",
      });
    },
  });

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      await dialog.alert("복사했습니다.");
    } catch {
      await dialog.alert("복사 실패. 수동으로 복사해 주세요.");
    }
  }

  if (!canManage) return null;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold">로그인 비밀번호 초기화</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            주민등록번호 앞 6자리(생년월일)로 초기화합니다. 주민번호가 없으면
            랜덤 임시 비번을 생성해 이 화면에서 1회 표시합니다. 초기화 후 본인이
            첫 로그인하면 비밀번호를 즉시 변경해야 합니다.
          </p>
        </div>
      </header>
      <div className="px-4 py-3 space-y-3">
        {blockedForHr ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            HR 은 보안등급 ADMIN 임직원의 비밀번호를 초기화할 수 없습니다.
          </div>
        ) : (
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm(
                "이 임직원의 비밀번호를 초기화하시겠습니까?",
                { destructive: true },
              );
              if (ok) resetM.mutate();
            }}
            disabled={resetM.isPending}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {resetM.isPending ? "적용 중…" : "비밀번호 초기화"}
          </button>
        )}

        {result && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm space-y-2">
            {result.mode === "birthday" ? (
              <>
                <div className="font-semibold text-emerald-900">
                  생년월일(주민번호 앞 6자리) 로 초기화되었습니다.
                </div>
                <div className="text-xs text-emerald-800">
                  본인에게 &quot;주민등록번호 앞 6자리로 로그인 후 즉시 변경하세요&quot;
                  라고 안내하세요.
                </div>
              </>
            ) : (
              <>
                <div className="font-semibold text-emerald-900">
                  주민번호가 없어 임시 비밀번호를 생성했습니다.
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm font-mono select-all break-all">
                    {result.temp_password}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(result.temp_password ?? "")}
                    className="h-9 rounded-md border border-border bg-background px-3 text-xs inline-flex items-center gap-1"
                  >
                    <Copy className="h-3.5 w-3.5" /> 복사
                  </button>
                </div>
                <div className="text-xs text-amber-800">
                  ⚠ 이 화면을 벗어나면 다시 볼 수 없습니다. 지금 본인에게 안전한
                  경로로 전달하세요.
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}


function AssignmentHistorySection({ developerId }: { developerId: string }) {
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(nowYear);

  const { data: assignments = [] } = useQuery<AssignmentHistory[]>({
    queryKey: ["dev-history", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/assignments`)).data,
  });

  const { data: grants = [] } = useQuery<ResearchGrant[]>({
    queryKey: ["research-grants", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/research-grants`)).data,
    retry: false,
  });

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const overlaps = (s: string, e: string) => !(e < yearStart || s > yearEnd);

  const asnInYear = assignments.filter((a) => overlaps(a.start_date, a.end_date));
  const grantsInYear = grants.filter((g) => overlaps(g.start_date, g.end_date));

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center mb-3 gap-3">
        <h2 className="font-semibold">투입 이력</h2>
        <div className="ml-auto flex items-center gap-2">
          <Tooltip label="이전 해" side="top">
            <NavButton onClick={() => setYear((y) => y - 1)}>
              ‹
            </NavButton>
          </Tooltip>
          <span className="text-sm font-medium tabular-nums w-20 text-center">
            {year}년
          </span>
          <Tooltip label="다음 해" side="top">
            <NavButton onClick={() => setYear((y) => y + 1)}>
              ›
            </NavButton>
          </Tooltip>
        </div>
      </div>
      {asnInYear.length === 0 && grantsInYear.length === 0 ? (
        <p className="text-sm text-muted-foreground">이 해에는 이력이 없습니다.</p>
      ) : (
        <ProjectGantt
          assignments={asnInYear}
          grants={grantsInYear}
          year={year}
        />
      )}
    </section>
  );
}

// Palette cycled through by project (and grants). Pulled mostly from Tailwind
// 500/600 tones to stay visually distinct at small sizes.
const PROJECT_PALETTE = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#f97316", // orange
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#ec4899", // pink
  "#14b8a6", // teal
  "#6366f1", // indigo
  "#22c55e", // green
  "#eab308", // yellow
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#d946ef", // fuchsia
  "#84cc16", // lime
  "#f43f5e", // rose
  "#0ea5e9", // sky
  "#64748b", // slate
  "#78716c", // stone
  "#7c3aed", // violet-600
];

type GanttRow = {
  kind: "project" | "grant";
  id: string;
  name: string;
  color: string;
  bars: Array<{
    id: string;
    start: string;
    end: string;
    is_insourced?: boolean;
    tooltip: string;
  }>;
  firstStart: number;
};

function ProjectGantt({
  assignments,
  grants,
  year,
}: {
  assignments: AssignmentHistory[];
  grants: ResearchGrant[];
  year: number;
}) {
  const DAY_MS = 86_400_000;
  const ROW_HEIGHT = 40;
  const LABEL_WIDTH = 220;

  // X axis is bounded to the selected year (Jan 1 ~ Dec 31 inclusive).
  const rangeStart = new Date(year, 0, 1);
  const rangeEnd = new Date(year + 1, 0, 1); // exclusive
  const totalMs = rangeEnd.getTime() - rangeStart.getTime();
  const pct = (d: Date) => ((d.getTime() - rangeStart.getTime()) / totalMs) * 100;

  // Jan..Dec ticks
  const months: Date[] = [];
  for (let m = 0; m < 12; m++) months.push(new Date(year, m, 1));

  // Group assignments by project + keep grants as their own rows.
  const byProject = new Map<
    string,
    {
      name: string;
      items: AssignmentHistory[];
    }
  >();
  for (const a of assignments) {
    const bucket = byProject.get(a.project_id);
    if (bucket) bucket.items.push(a);
    else byProject.set(a.project_id, { name: a.project_name, items: [a] });
  }

  const projectRows: GanttRow[] = Array.from(byProject, ([id, v]) => ({
    kind: "project" as const,
    id,
    name: v.name,
    color: "",
    bars: v.items.map((a) => ({
      id: a.assignment_id,
      start: a.start_date,
      end: a.end_date,
      is_insourced: a.is_insourced,
      tooltip: `${a.start_date} ~ ${a.end_date}${
        a.is_insourced ? " · 자사화" : ""
      } · 월 ${Number(a.monthly_rate).toLocaleString()}원`,
    })),
    firstStart: Math.min(
      ...v.items.map((a) => new Date(a.start_date).getTime()),
    ),
  }));

  const grantRows: GanttRow[] = grants.map((g) => ({
    kind: "grant",
    id: g.id,
    name: `[과제] ${g.name ?? "(이름 없음)"}`,
    color: "",
    bars: [
      {
        id: g.id,
        start: g.start_date,
        end: g.end_date,
        tooltip: `${g.start_date} ~ ${g.end_date} · 참여율 ${Number(
          g.participation_rate,
        )}% · 총 ${Number(g.total_amount).toLocaleString()}원`,
      },
    ],
    firstStart: new Date(g.start_date).getTime(),
  }));

  // Merge + order: projects (newest-first start) then grants (newest-first)
  projectRows.sort((a, b) => b.firstStart - a.firstStart);
  grantRows.sort((a, b) => b.firstStart - a.firstStart);
  const rows = [...projectRows, ...grantRows].map((r, i) => ({
    ...r,
    color: PROJECT_PALETTE[i % PROJECT_PALETTE.length],
  }));

  return (
    <div>
      <div className="w-full">
        {/* Month header */}
        <div className="flex border-b border-border">
          <div
            className="shrink-0 px-3 py-2 text-sm font-semibold bg-muted/40 border-r border-border"
            style={{ width: LABEL_WIDTH }}
          >
            프로젝트 / 과제
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

        {/* Rows */}
        {rows.map((row) => (
          <div
            key={`${row.kind}-${row.id}`}
            className="flex border-b border-border hover:bg-muted/30"
            style={{ minHeight: ROW_HEIGHT }}
          >
            <div
              className="shrink-0 px-3 py-1.5 flex items-center gap-2 text-sm border-r border-border bg-card"
              style={{ width: LABEL_WIDTH }}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: row.color }}
              />
              {row.kind === "project" ? (
                <Link
                  href={`/projects/${row.id}`}
                  className="text-primary hover:underline break-words leading-snug"
                >
                  {row.name}
                </Link>
              ) : (
                <span className="break-words leading-snug text-muted-foreground">
                  {row.name}
                </span>
              )}
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
              {row.bars.map((b) => {
                const s = new Date(`${b.start}T00:00:00`);
                const e = new Date(`${b.end}T00:00:00`);
                const endExclusive = new Date(e.getTime() + DAY_MS);
                const leftPct = Math.max(0, pct(s));
                const rightPct = Math.min(100, pct(endExclusive));
                const widthPct = rightPct - leftPct;
                if (widthPct <= 0) return null;
                return (
                  <div
                    key={b.id}
                    className="group/tt absolute"
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: 6,
                      height: ROW_HEIGHT - 12,
                    }}
                  >
                    <div
                      className="h-full w-full rounded px-2 text-sm text-white flex items-center overflow-hidden whitespace-nowrap shadow-sm"
                      style={{
                        backgroundColor: row.color,
                        border: b.is_insourced
                          ? "2px dashed rgba(255,255,255,0.7)"
                          : undefined,
                      }}
                    >
                      {b.start} ~ {b.end}
                    </div>
                    <Tooltip inline side="top" label={b.tooltip} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type ResearchGrant = {
  id: string;
  developer_id: string;
  name?: string | null;
  start_date: string;
  end_date: string;
  total_amount: string;
  participation_rate: string;
  note?: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// 여권정보 섹션 — 본인/HR/ADMIN 만 접근 (백엔드도 동일 가드).
// 여권번호는 백엔드에서 Fernet 으로 암호화 저장, 응답 시 복호화. UI 는 평문.
// 만료일 6개월 이내면 빨간색 경고.
// ---------------------------------------------------------------------------

type PassportData = {
  passport_number: string | null;
  gender: "M" | "F" | null;
  surname_en: string | null;
  given_name_en: string | null;
  nationality: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  issue_country: string | null;
  passport_type: "REGULAR" | "OFFICIAL" | "DIPLOMATIC" | null;
};

const PASSPORT_BLANK: PassportData = {
  passport_number: "",
  gender: null,
  surname_en: "",
  given_name_en: "",
  nationality: "KOR",
  issue_date: null,
  expiry_date: null,
  issue_country: "REPUBLIC OF KOREA",
  passport_type: "REGULAR",
};

// ---------------------------------------------------------------------------
// 면담 (Interviews)
// HR / ADMIN / SUPER_ADMIN 만 열람·작성 가능. 본인이라도 차단 (탭 노출 여부에서 처리).
// CommentsBlock 을 resourcePath="interviews" 로 재사용 — 케이스 코멘트와 동일 UX.
// ---------------------------------------------------------------------------

function InterviewsSection({
  developerId,
  currentUserId,
  currentUserRole,
}: {
  developerId: string;
  currentUserId: string | null;
  currentUserRole: string | null;
}) {
  const queryKey = ["developer-interviews", developerId];
  const { data: rows = [] } = useQuery<CommentRow[]>({
    queryKey,
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/interviews`)).data,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 max-w-5xl">
      <div className="text-sm font-semibold mb-2">면담 기록</div>
      <p className="text-[11px] text-muted-foreground mb-3">
        HR 평가 보호 — 본인은 열람 불가. ADMIN/HR 만 열람·작성 가능.
        본인 작성 면담 + ADMIN 만 수정·삭제 가능.
      </p>
      <CommentsBlock
        baseUrl="/developers"
        recordId={developerId}
        resourcePath="interviews"
        comments={rows}
        invalidateKey={queryKey}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        emptyMessage="아직 면담 기록이 없습니다."
        draftPlaceholder="면담 내용 추가... (마크다운 지원)"
        rows={15}
      />
    </div>
  );
}


function PassportSection({ developerId }: { developerId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [form, setForm] = useState<PassportData>(PASSPORT_BLANK);
  const [exists, setExists] = useState(false);

  // GET — 없으면 404 (자연스러운 신규 등록 상태). 그 외 에러는 throw.
  const { data, isLoading } = useQuery<PassportData | null>({
    queryKey: ["developer-passport", developerId],
    queryFn: async () => {
      try {
        const res = await api.get(`/developers/${developerId}/passport`);
        return res.data as PassportData;
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },
  });

  useEffect(() => {
    if (data) {
      setForm({
        passport_number: data.passport_number ?? "",
        gender: data.gender ?? null,
        surname_en: data.surname_en ?? "",
        given_name_en: data.given_name_en ?? "",
        nationality: data.nationality ?? "KOR",
        issue_date: data.issue_date,
        expiry_date: data.expiry_date,
        issue_country: data.issue_country ?? "",
        passport_type: data.passport_type ?? "REGULAR",
      });
      setExists(true);
    } else if (data === null) {
      setForm(PASSPORT_BLANK);
      setExists(false);
    }
  }, [data]);

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saveM = useMutation({
    mutationFn: async () =>
      (await api.put(`/developers/${developerId}/passport`, form)).data as PassportData,
    onSuccess: () => {
      setSavedAt(new Date());
      qc.invalidateQueries({ queryKey: ["developer-passport", developerId] });
    },
    onError: async (e: any) => {
      const msg = e?.response?.data?.detail ?? "저장 실패";
      await dialog.alert(typeof msg === "string" ? msg : JSON.stringify(msg), {
        title: "오류",
      });
    },
  });

  const deleteM = useMutation({
    mutationFn: async () =>
      (await api.delete(`/developers/${developerId}/passport`)).data,
    onSuccess: () => {
      setSavedAt(null);
      qc.invalidateQueries({ queryKey: ["developer-passport", developerId] });
    },
  });

  // 만료일 6 개월 이내 경고 — 1차 시각 힌트. 만료된 경우는 빨강 + "만료" 표기.
  const expiryWarning = useMemo(() => {
    if (!form.expiry_date) return null;
    const exp = new Date(form.expiry_date);
    if (Number.isNaN(exp.getTime())) return null;
    const now = new Date();
    const diffDays = Math.floor((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return { tone: "expired" as const, days: -diffDays };
    if (diffDays <= 180) return { tone: "soon" as const, days: diffDays };
    return null;
  }, [form.expiry_date]);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">불러오는 중...</div>;
  }

  const inputCls =
    "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">여권정보</h3>
        <span className="text-[11px] text-muted-foreground">
          {exists ? "등록됨 — 수정 가능" : "신규 등록"}
        </span>
      </div>

      {expiryWarning && (
        <div
          className={
            "rounded-md border px-3 py-2 text-xs " +
            (expiryWarning.tone === "expired"
              ? "border-destructive/40 bg-destructive/10 text-destructive font-semibold"
              : "border-amber-300 bg-amber-50 text-amber-800")
          }
        >
          {expiryWarning.tone === "expired"
            ? `여권이 만료되었습니다 (${expiryWarning.days}일 경과). 갱신이 필요합니다.`
            : `여권 만료까지 ${expiryWarning.days}일 남았습니다. 출장 전 갱신 검토.`}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">여권번호</span>
          <input
            value={form.passport_number ?? ""}
            onChange={(e) => setForm({ ...form, passport_number: e.target.value })}
            className={inputCls + " font-mono tracking-wider"}
            placeholder="M12345678"
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">성별</span>
          <select
            value={form.gender ?? ""}
            onChange={(e) =>
              setForm({
                ...form,
                gender: (e.target.value || null) as PassportData["gender"],
              })
            }
            className={inputCls}
          >
            <option value="">— 선택 —</option>
            <option value="M">남자 (M)</option>
            <option value="F">여자 (F)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">영문 성 (Surname)</span>
          <input
            value={form.surname_en ?? ""}
            onChange={(e) => setForm({ ...form, surname_en: e.target.value.toUpperCase() })}
            className={inputCls + " uppercase"}
            placeholder="HONG"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">영문 이름 (Given name)</span>
          <input
            value={form.given_name_en ?? ""}
            onChange={(e) => setForm({ ...form, given_name_en: e.target.value.toUpperCase() })}
            className={inputCls + " uppercase"}
            placeholder="GILDONG"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">국적 (3-letter)</span>
          <input
            value={form.nationality ?? ""}
            onChange={(e) => setForm({ ...form, nationality: e.target.value.toUpperCase().slice(0, 3) })}
            className={inputCls + " uppercase"}
            placeholder="KOR"
            maxLength={3}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">여권 종류</span>
          <select
            value={form.passport_type ?? "REGULAR"}
            onChange={(e) =>
              setForm({ ...form, passport_type: e.target.value as PassportData["passport_type"] })
            }
            className={inputCls}
          >
            <option value="REGULAR">일반 (Regular)</option>
            <option value="OFFICIAL">관용 (Official)</option>
            <option value="DIPLOMATIC">외교관 (Diplomatic)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">발급일</span>
          <input
            type="date"
            value={form.issue_date ?? ""}
            onChange={(e) => setForm({ ...form, issue_date: e.target.value || null })}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">만료일</span>
          <input
            type="date"
            value={form.expiry_date ?? ""}
            onChange={(e) => setForm({ ...form, expiry_date: e.target.value || null })}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-xs text-muted-foreground">발급국가</span>
          <input
            value={form.issue_country ?? ""}
            onChange={(e) => setForm({ ...form, issue_country: e.target.value })}
            className={inputCls}
            placeholder="REPUBLIC OF KOREA"
          />
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <SavedAtLabel at={savedAt} />
        {exists && (
          <button
            type="button"
            onClick={async () => {
              const ok = await dialog.confirm("여권정보를 삭제하시겠습니까?", {
                destructive: true,
              });
              if (ok) deleteM.mutate();
            }}
            className="h-9 rounded-md border border-destructive/40 bg-background px-3 text-sm text-destructive hover:bg-destructive/10"
          >
            삭제
          </button>
        )}
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={saveM.isPending}
          className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          {saveM.isPending ? "저장 중..." : exists ? "저장" : "등록"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 비상연락처 섹션 — 본인/HR/ADMIN 만 접근. 2 슬롯(이름·관계·전화) 한 row 씩.
// 백엔드는 N 개 허용하지만 UI 는 항상 2개 고정 슬롯 유지.
// ---------------------------------------------------------------------------

type EmergencyContact = {
  name: string;
  relation: string;
  phone: string;
};

const EMPTY_CONTACT: EmergencyContact = { name: "", relation: "", phone: "" };

function EmergencyContactsSection({ developerId }: { developerId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [items, setItems] = useState<EmergencyContact[]>([
    { ...EMPTY_CONTACT },
    { ...EMPTY_CONTACT },
  ]);

  const { data, isLoading } = useQuery<EmergencyContact[]>({
    queryKey: ["developer-emergency-contacts", developerId],
    queryFn: async () =>
      (await api.get(`/developers/${developerId}/emergency-contacts`)).data,
  });

  useEffect(() => {
    if (!data) return;
    // 항상 2 슬롯 유지 — 응답이 1건이면 두 번째는 빈 상태로.
    const next: EmergencyContact[] = [
      data[0]
        ? {
            name: data[0].name ?? "",
            relation: data[0].relation ?? "",
            phone: data[0].phone ?? "",
          }
        : { ...EMPTY_CONTACT },
      data[1]
        ? {
            name: data[1].name ?? "",
            relation: data[1].relation ?? "",
            phone: data[1].phone ?? "",
          }
        : { ...EMPTY_CONTACT },
    ];
    setItems(next);
  }, [data]);

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const saveM = useMutation({
    mutationFn: async () =>
      (
        await api.put(`/developers/${developerId}/emergency-contacts`, {
          items,
        })
      ).data,
    onSuccess: () => {
      setSavedAt(new Date());
      qc.invalidateQueries({
        queryKey: ["developer-emergency-contacts", developerId],
      });
    },
    onError: async (e: any) => {
      const msg = e?.response?.data?.detail ?? "저장 실패";
      await dialog.alert(typeof msg === "string" ? msg : JSON.stringify(msg), {
        title: "오류",
      });
    },
  });

  function update(i: 0 | 1, patch: Partial<EmergencyContact>) {
    setItems((p) => p.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">불러오는 중...</div>;
  }

  const inputCls =
    "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">비상연락처</h3>
        <span className="text-[11px] text-muted-foreground">
          최대 2건 — 비워두면 저장되지 않음
        </span>
      </div>

      {[0, 1].map((i) => (
        <div key={i} className="space-y-1">
          <div className="text-xs text-muted-foreground">#{i + 1}</div>
          <div className="grid grid-cols-3 gap-3">
            <input
              value={items[i]?.name ?? ""}
              onChange={(e) => update(i as 0 | 1, { name: e.target.value })}
              className={inputCls}
              placeholder="이름"
            />
            <input
              value={items[i]?.relation ?? ""}
              onChange={(e) => update(i as 0 | 1, { relation: e.target.value })}
              className={inputCls}
              placeholder="관계 (예: 배우자, 부, 모)"
            />
            <input
              value={items[i]?.phone ?? ""}
              onChange={(e) => update(i as 0 | 1, { phone: e.target.value })}
              className={inputCls}
              placeholder="전화번호 (예: 010-1234-5678)"
            />
          </div>
        </div>
      ))}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <SavedAtLabel at={savedAt} />
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={saveM.isPending}
          className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          {saveM.isPending ? "저장 중..." : "저장"}
        </button>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// 권한 grant 요약 — 이 임직원에게 부여된 추가 메뉴 / 추가 권한을 읽기 전용으로
// 노출. 편집은 사이드바 > 관리 > 권한 관리(/permissions) 로 이동.
//
// 임직원 상세에서 자주 확인하는 정보라 한눈 보기 + 한 번 클릭으로 편집 화면
// 진입이 목표. ADMIN/SUPER_ADMIN/HR 만 노출. 그 외 role 은 마운트 안 함.
// ---------------------------------------------------------------------------

function PermissionGrantsSummary({ developerId }: { developerId: string }) {
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canView =
    me?.role === "ADMIN" || me?.role === "SUPER_ADMIN" || me?.role === "HR";

  const { data: dev } = useQuery<{ user_id: string | null }>({
    queryKey: ["developer", developerId],
    queryFn: async () => (await api.get(`/developers/${developerId}`)).data,
    enabled: canView,
  });
  const userId = dev?.user_id ?? null;

  // 추가 메뉴 목록 (key 만). MENU_REGISTRY 에서 label 매칭해 표시.
  const { data: menuKeys = [] } = useQuery<string[]>({
    queryKey: ["user-menu-grants", userId],
    queryFn: async () =>
      (await api.get("/user-menu-grants", { params: { user_id: userId } })).data,
    enabled: canView && !!userId,
  });
  // 추가 기능 권한 — ADMIN/SUPER_ADMIN 만 (backend 가드 일치).
  const canSeeFeature = me?.role === "ADMIN" || me?.role === "SUPER_ADMIN";
  const { data: featureGrants = [] } = useQuery<
    { user_id: string; feature_key: string }[]
  >({
    queryKey: ["user-feature-grants", userId],
    queryFn: async () =>
      (
        await api.get("/user-feature-grants", { params: { user_id: userId } })
      ).data,
    enabled: canSeeFeature && !!userId,
  });

  if (!canView) return null;

  const menuLabels = menuKeys
    .map((k) => MENU_REGISTRY.find((m) => m.key === k)?.label ?? k)
    .sort((a, b) => a.localeCompare(b, "ko-KR"));

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">추가 권한 / 메뉴</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            보안등급(역할) 외에 이 임직원에게 개별 부여된 항목. 편집은 권한 관리
            화면에서 가능합니다.
          </p>
        </div>
        <Link
          href="/permissions"
          className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted"
          title="권한 관리 화면으로 이동"
        >
          권한 관리에서 편집 →
        </Link>
      </header>
      <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1">
            추가 메뉴
          </div>
          {!userId ? (
            <div className="text-xs text-muted-foreground italic">
              매핑된 사용자 계정이 없습니다.
            </div>
          ) : menuLabels.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              부여된 추가 메뉴가 없습니다.
            </div>
          ) : (
            <ul className="list-disc pl-5 space-y-0.5">
              {menuLabels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          )}
        </div>
        {canSeeFeature && (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">
              추가 기능 권한
            </div>
            {!userId ? (
              <div className="text-xs text-muted-foreground italic">
                매핑된 사용자 계정이 없습니다.
              </div>
            ) : featureGrants.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                부여된 추가 권한이 없습니다.
              </div>
            ) : (
              <ul className="list-disc pl-5 space-y-0.5 font-mono text-xs">
                {featureGrants.map((g) => (
                  <li key={g.feature_key}>{g.feature_key}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

