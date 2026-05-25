"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HardDriveDownload, Plus, Save, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { SchedulerTab } from "@/components/settings/SchedulerTab";
import { NotificationsToggleTab } from "@/components/settings/NotificationsToggleTab";
import { IntegrationsTab } from "@/components/settings/IntegrationsTab";
import { CloudCostTab } from "@/components/settings/CloudCostTab";
import { AssistantTab } from "@/components/settings/AssistantTab";
import { LeavesPolicyTab } from "@/components/settings/LeavesPolicyTab";
import { AdvancedTab } from "@/components/settings/AdvancedTab";
import { JobGradesTab } from "@/components/settings/JobGradesTab";
import { ApprovalTemplatesTab } from "@/components/settings/ApprovalTemplatesTab";
import { GoalBaselinesTab } from "@/components/settings/GoalBaselinesTab";
import { WeeklyReportsSettingsTab } from "@/components/settings/WeeklyReportsSettingsTab";
import { PayrollSettingsTab } from "@/components/settings/PayrollSettingsTab";

type CompanySizeTier = "UNDER_150" | "150_TO_1000" | "OVER_1000";

type InsuranceRate = {
  id: string;
  effective_from: string;
  year: number;
  national_pension_rate: string;
  national_pension_ceiling: number;
  national_pension_floor: number | null;
  health_rate: string;
  long_term_care_rate_on_health: string;
  employment_unemployment_rate: string;
  employment_stability_rate: string;
  industrial_accident_rate: string;
  company_size_tier: CompanySizeTier | null;
  industry_note: string | null;
  updated_at: string;
};

const SIZE_LABEL: Record<CompanySizeTier, string> = {
  UNDER_150: "150인 미만",
  "150_TO_1000": "150~1000인",
  OVER_1000: "1000인 이상",
};

export default function SettingsPage() {
  const { data: me } = useQuery<any>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
  });

  const [tab, setTab] = useState<
    | "profile"
    | "insurance"
    | "taxtable"
    | "leaves"
    | "grades"
    | "approvals"
    | "goal_baselines"
    | "weekly_reports"
    | "payroll"
    | "scheduler"
    | "notifications_toggle"
    | "integrations"
    | "cloud_cost"
    | "assistant"
    | "advanced"
  >("profile");
  const isAdmin = me?.role === "ADMIN";

  return (
    <>
      <DashboardHeader title="설정" />
      {/* 간이세액표 탭은 좌측 2열 + 부양가족 11 컬럼이 모두 들어가도록
          컨테이너 max-w 를 기본 4xl(56rem) 대비 50% 키운 84rem 으로 확장. */}
      <div
        className={
          "flex flex-1 flex-col gap-4 p-4 min-h-0 " +
          (tab === "taxtable"
            ? "max-w-[84rem] overflow-auto "
            : tab === "approvals"
              ? "max-w-[84rem] overflow-hidden "
              : "max-w-4xl overflow-auto ")
        }
      >
        <TabBar>
          <TabItem active={tab === "profile"} onClick={() => setTab("profile")}>
            회사 프로필
          </TabItem>
          <TabItem
            active={tab === "insurance"}
            onClick={() => setTab("insurance")}
          >
            4대보험 요율
          </TabItem>
          <TabItem
            active={tab === "taxtable"}
            onClick={() => setTab("taxtable")}
          >
            간이세액표
          </TabItem>
          {isAdmin && (
            <TabItem active={tab === "leaves"} onClick={() => setTab("leaves")}>
              연차 정책
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "grades"} onClick={() => setTab("grades")}>
              직위·직책
            </TabItem>
          )}
          {/* 메뉴/기능 권한 탭은 별도 메뉴 '/permissions' 로 분리 — 사용자별
              추가 메뉴/추가 권한도 함께 관리. */}
          {isAdmin && (
            <TabItem
              active={tab === "approvals"}
              onClick={() => setTab("approvals")}
            >
              결재 양식
            </TabItem>
          )}
          {isAdmin && (
            <TabItem
              active={tab === "goal_baselines"}
              onClick={() => setTab("goal_baselines")}
            >
              목표 기준
            </TabItem>
          )}
          {isAdmin && (
            <TabItem
              active={tab === "weekly_reports"}
              onClick={() => setTab("weekly_reports")}
            >
              주간보고
            </TabItem>
          )}
          {isAdmin && (
            <TabItem
              active={tab === "payroll"}
              onClick={() => setTab("payroll")}
            >
              급여
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "scheduler"} onClick={() => setTab("scheduler")}>
              알림·스케줄
            </TabItem>
          )}
          {isAdmin && (
            <TabItem
              active={tab === "notifications_toggle"}
              onClick={() => setTab("notifications_toggle")}
            >
              알림 ON/OFF
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "integrations"} onClick={() => setTab("integrations")}>
              외부 연동
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "cloud_cost"} onClick={() => setTab("cloud_cost")}>
              클라우드 비용
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "assistant"} onClick={() => setTab("assistant")}>
              AI 어시스턴트
            </TabItem>
          )}
          {isAdmin && (
            <TabItem active={tab === "advanced"} onClick={() => setTab("advanced")}>
              고급
            </TabItem>
          )}
        </TabBar>

        {tab === "profile" ? (
          <CompanyProfileCard isAdmin={isAdmin} />
        ) : tab === "insurance" ? (
          <InsuranceRatesCard isAdmin={isAdmin} />
        ) : tab === "taxtable" ? (
          <TaxTableCard isAdmin={isAdmin} />
        ) : tab === "leaves" ? (
          <LeavesPolicyTab />
        ) : tab === "grades" ? (
          <JobGradesTab />
        ) : tab === "approvals" ? (
          <ApprovalTemplatesTab />
        ) : tab === "goal_baselines" ? (
          <GoalBaselinesTab />
        ) : tab === "weekly_reports" ? (
          <WeeklyReportsSettingsTab />
        ) : tab === "payroll" ? (
          <PayrollSettingsTab />
        ) : tab === "scheduler" ? (
          <SchedulerTab />
        ) : tab === "notifications_toggle" ? (
          <NotificationsToggleTab />
        ) : tab === "integrations" ? (
          <IntegrationsTab />
        ) : tab === "cloud_cost" ? (
          <CloudCostTab />
        ) : tab === "assistant" ? (
          <AssistantTab />
        ) : (
          <AdvancedTab />
        )}
      </div>
    </>
  );
}

type CompanyProfile = {
  id?: string;
  // 한글
  name?: string;
  business_no?: string;
  representative?: string;
  address?: string;
  phone?: string;
  fax?: string;
  email?: string;
  bank_name?: string;
  bank_account?: string;
  bank_holder?: string;
  // 영문
  name_en?: string;
  representative_en?: string;
  address_en?: string;
  bank_name_en?: string;
  bank_holder_en?: string;
  // 공통
  number_prefix?: string;
  logo_name?: string;
  stamp_name?: string;
  seal_name?: string;
};

type AssetKind = "logo" | "stamp" | "seal";

function CompanyProfileCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CompanyProfile>({});
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data } = useQuery<CompanyProfile>({
    queryKey: ["company-profile"],
    queryFn: async () => (await api.get("/company-profile")).data,
  });

  useEffect(() => {
    if (data) {
      setForm(data);
      setDirty(false);
    }
  }, [data]);

  const saveM = useMutation({
    mutationFn: async () => (await api.patch("/company-profile", form)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-profile"] });
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function update<K extends keyof CompanyProfile>(k: K, v: CompanyProfile[K]) {
    setForm((p) => ({ ...p, [k]: v }));
    setDirty(true);
  }

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60";
  const disabled = !isAdmin;

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">회사 프로필 (발행자 정보)</h2>
        {!isAdmin && (
          <span className="text-xs text-muted-foreground">관리자만 수정 가능</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        견적서/매출 인보이스 발행 시 이 정보가 문서에 자동 복사되어 동결 저장됩니다. 번호
        prefix 는 발번 포맷(<code>PREFIXQ-YYYY-NNNN</code>, <code>PREFIXI-YYYY-NNNN</code>)에 사용됩니다.
        <span className="block mt-1">
          매출 인보이스(Invoice) PDF 는 영문 필드를 우선 사용합니다. 영문 필드가 비어 있으면 한글 값으로 자동 폴백됩니다.
        </span>
      </p>

      {/* 이미지 자산: 로고 / 도장 / 직인 */}
      <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <ImageAssetBlock
          kind="logo"
          title="회사 로고"
          description="PDF 우측 하단에 표시됩니다."
          fileName={data?.logo_name ?? null}
          isAdmin={isAdmin}
        />
        <ImageAssetBlock
          kind="stamp"
          title="도장"
          description="PDF 공급자 대표자 옆에 표시됩니다."
          fileName={data?.stamp_name ?? null}
          isAdmin={isAdmin}
        />
        <ImageAssetBlock
          kind="seal"
          title="직인"
          description="법인 직인. 필요 시 PDF 에 표시됩니다."
          fileName={data?.seal_name ?? null}
          isAdmin={isAdmin}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 한글 섹션 */}
        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-semibold mb-2 text-muted-foreground">
            한글 (견적서 / 국내 청구)
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">상호</span>
              <input
                disabled={disabled}
                value={form.name ?? ""}
                onChange={(e) => update("name", e.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">사업자번호</span>
              <input
                disabled={disabled}
                value={form.business_no ?? ""}
                onChange={(e) => update("business_no", e.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">대표자</span>
              <input
                disabled={disabled}
                value={form.representative ?? ""}
                onChange={(e) => update("representative", e.target.value)}
                className={input}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">주소</span>
              <input
                disabled={disabled}
                value={form.address ?? ""}
                onChange={(e) => update("address", e.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">은행</span>
              <input
                disabled={disabled}
                value={form.bank_name ?? ""}
                onChange={(e) => update("bank_name", e.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">예금주</span>
              <input
                disabled={disabled}
                value={form.bank_holder ?? ""}
                onChange={(e) => update("bank_holder", e.target.value)}
                className={input}
              />
            </label>
          </div>
        </div>

        {/* 영문 섹션 */}
        <div className="rounded-md border border-border p-3 bg-muted/20">
          <div className="text-xs font-semibold mb-2 text-muted-foreground">
            English (Invoice / Overseas)
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Company Name</span>
              <input
                disabled={disabled}
                value={form.name_en ?? ""}
                onChange={(e) => update("name_en", e.target.value)}
                className={input}
                placeholder="Acme Inc."
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Representative</span>
              <input
                disabled={disabled}
                value={form.representative_en ?? ""}
                onChange={(e) => update("representative_en", e.target.value)}
                className={input}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Address</span>
              <input
                disabled={disabled}
                value={form.address_en ?? ""}
                onChange={(e) => update("address_en", e.target.value)}
                className={input}
                placeholder="123 Teheran-ro, Gangnam-gu, Seoul, Korea"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Bank</span>
              <input
                disabled={disabled}
                value={form.bank_name_en ?? ""}
                onChange={(e) => update("bank_name_en", e.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Account Holder</span>
              <input
                disabled={disabled}
                value={form.bank_holder_en ?? ""}
                onChange={(e) => update("bank_holder_en", e.target.value)}
                className={input}
              />
            </label>
          </div>
        </div>
      </div>

      {/* 공통 (언어 구분 없음) */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">전화</span>
          <input
            disabled={disabled}
            value={form.phone ?? ""}
            onChange={(e) => update("phone", e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">팩스</span>
          <input
            disabled={disabled}
            value={form.fax ?? ""}
            onChange={(e) => update("fax", e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">이메일</span>
          <input
            disabled={disabled}
            value={form.email ?? ""}
            onChange={(e) => update("email", e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">계좌번호</span>
          <input
            disabled={disabled}
            value={form.bank_account ?? ""}
            onChange={(e) => update("bank_account", e.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-1 col-span-2 md:col-span-1">
          <span className="text-xs text-muted-foreground">번호 prefix</span>
          <input
            disabled={disabled}
            value={form.number_prefix ?? "DD"}
            onChange={(e) => update("number_prefix", e.target.value)}
            className={input}
          />
        </label>
      </div>
      {isAdmin && (
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={!dirty || saveM.isPending}
            onClick={() => saveM.mutate()}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {saveM.isPending ? "저장 중..." : "저장"}
          </button>
          {saved && (
            <span className="text-xs text-emerald-600">저장되었습니다.</span>
          )}
        </div>
      )}
    </div>
  );
}

function ImageAssetBlock({
  kind,
  title,
  description,
  fileName,
  isAdmin,
}: {
  kind: AssetKind;
  title: string;
  description: string;
  fileName: string | null;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const inputRef = useRef<HTMLInputElement>(null);
  const endpoint = `/company-profile/${kind}`;
  const blobKey = ["company-asset", kind, fileName] as const;

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return (
        await api.post(endpoint, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-profile"] });
      qc.invalidateQueries({ queryKey: ["company-asset", kind] });
    },
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "업로드에 실패했습니다.",
      );
    },
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(endpoint),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-profile"] });
      qc.invalidateQueries({ queryKey: ["company-asset", kind] });
    },
  });

  // Blob 을 캐시 — object URL 을 캐시하면 언마운트 시 revoke 된 뒤에도 쿼리 캐시에 남아
  // 탭 이동 후 재마운트 시 깨진 URL 이 재사용됨.
  const { data: blob } = useQuery<Blob | null>({
    queryKey: blobKey,
    queryFn: async () => {
      if (!fileName) return null;
      const res = await api.get(endpoint, { responseType: "blob" });
      return res.data as Blob;
    },
    enabled: Boolean(fileName),
    staleTime: 60_000,
  });

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  return (
    <div className="rounded-md border border-border p-3 flex flex-col gap-3">
      <div className="flex h-24 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 overflow-hidden">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={title}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {title} 없음
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 text-xs">
        <div className="font-semibold">{title}</div>
        <div className="text-muted-foreground">{description}</div>
        {fileName && (
          <div className="text-muted-foreground truncate">
            현재 파일: <span className="font-mono">{fileName}</span>
          </div>
        )}
        {isAdmin && (
          <div className="flex items-center gap-2 mt-1">
            <input
              ref={inputRef}
              type="file"
              accept="image/svg+xml,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadM.mutate(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploadM.isPending}
              onClick={() => inputRef.current?.click()}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadM.isPending ? "업로드 중..." : "업로드"}
            </button>
            {fileName && (
              <button
                type="button"
                disabled={deleteM.isPending}
                onClick={async () => {
                  if (
                    await dialog.confirm(`${title} 파일을 삭제하시겠습니까?`, {
                      destructive: true,
                    })
                  ) {
                    deleteM.mutate();
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                삭제
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InsuranceRatesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<InsuranceRate | null>(null);

  const { data: rates = [] } = useQuery<InsuranceRate[]>({
    queryKey: ["insurance-rates"],
    queryFn: async () => (await api.get("/hr/insurance-rates")).data,
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/hr/insurance-rates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insurance-rates"] }),
  });

  const current = rates[0];

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">4대보험 요율 (회사 부담)</h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              setEditTarget(null);
              setEditOpen(true);
            }}
            className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3.5 w-3.5" />
            새 요율 등록
          </button>
        )}
      </div>

      {current ? (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <div className="text-xs font-semibold text-primary mb-1">
            현재 적용 중 · {current.effective_from}부터
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <Row label="국민연금" value={`${pct(current.national_pension_rate)}% (상한 ${current.national_pension_ceiling.toLocaleString()}원)`} />
            <Row label="건강보험" value={`${pct(current.health_rate)}%`} />
            <Row label="장기요양 (건강보험료 대비)" value={`${pct(current.long_term_care_rate_on_health)}%`} />
            <Row label="고용보험 실업급여" value={`${pct(current.employment_unemployment_rate)}%`} />
            <Row label="고용안정·직능" value={`${pct(current.employment_stability_rate)}%`} />
            <Row label="산재" value={`${pct(current.industrial_accident_rate)}%`} />
            <Row
              label="회사 규모"
              value={current.company_size_tier ? SIZE_LABEL[current.company_size_tier] : "-"}
            />
            <Row label="업종" value={current.industry_note ?? "-"} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">등록된 요율이 없습니다.</p>
      )}

      <div className="text-xs font-semibold mb-2 text-muted-foreground">이력</div>
      {rates.length === 0 ? (
        <p className="text-xs text-muted-foreground">없음</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1">적용일</th>
              <th>연금</th>
              <th>건강</th>
              <th>장기요양</th>
              <th>실업</th>
              <th>고용안정</th>
              <th>산재</th>
              {isAdmin && <th className="text-right">작업</th>}
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-1.5">{r.effective_from}</td>
                <td>{pct(r.national_pension_rate)}%</td>
                <td>{pct(r.health_rate)}%</td>
                <td>{pct(r.long_term_care_rate_on_health)}%</td>
                <td>{pct(r.employment_unemployment_rate)}%</td>
                <td>{pct(r.employment_stability_rate)}%</td>
                <td>{pct(r.industrial_accident_rate)}%</td>
                {isAdmin && (
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setEditTarget(r);
                        setEditOpen(true);
                      }}
                      className="text-primary hover:underline mr-3"
                    >
                      편집
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          await dialog.confirm("이 요율을 삭제하시겠습니까?", {
                            destructive: true,
                          })
                        ) {
                          deleteM.mutate(r.id);
                        }
                      }}
                      className="inline-flex items-center gap-0.5 text-destructive hover:underline"
                    >
                      <Trash2 className="h-3 w-3" />
                      삭제
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <RateEditor open={editOpen} onClose={() => setEditOpen(false)} target={editTarget} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function pct(v: string | number): string {
  return (Number(v) * 100).toFixed(3).replace(/\.?0+$/, "");
}

type RateForm = {
  effective_from: string;
  year: string;
  national_pension_rate: string;
  national_pension_ceiling: string;
  national_pension_floor: string;
  health_rate: string;
  long_term_care_rate_on_health: string;
  employment_unemployment_rate: string;
  employment_stability_rate: string;
  industrial_accident_rate: string;
  company_size_tier: CompanySizeTier | "";
  industry_note: string;
};

const BLANK_RATE: RateForm = {
  effective_from: "",
  year: String(new Date().getFullYear()),
  national_pension_rate: "0.045",
  national_pension_ceiling: "6170000",
  national_pension_floor: "390000",
  health_rate: "0.03545",
  long_term_care_rate_on_health: "0.1295",
  employment_unemployment_rate: "0.009",
  employment_stability_rate: "0.0025",
  industrial_accident_rate: "0.007",
  company_size_tier: "UNDER_150",
  industry_note: "",
};

function RateEditor({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: InsuranceRate | null;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<RateForm>(BLANK_RATE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (target) {
      setForm({
        effective_from: target.effective_from,
        year: String(target.year),
        national_pension_rate: target.national_pension_rate,
        national_pension_ceiling: String(target.national_pension_ceiling),
        national_pension_floor:
          target.national_pension_floor != null ? String(target.national_pension_floor) : "",
        health_rate: target.health_rate,
        long_term_care_rate_on_health: target.long_term_care_rate_on_health,
        employment_unemployment_rate: target.employment_unemployment_rate,
        employment_stability_rate: target.employment_stability_rate,
        industrial_accident_rate: target.industrial_accident_rate,
        company_size_tier: target.company_size_tier ?? "",
        industry_note: target.industry_note ?? "",
      });
    } else {
      setForm(BLANK_RATE);
    }
    setError(null);
  }, [open, target]);

  const saveM = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        effective_from: form.effective_from,
        year: Number(form.year),
        national_pension_rate: form.national_pension_rate,
        national_pension_ceiling: Number(form.national_pension_ceiling),
        national_pension_floor: form.national_pension_floor
          ? Number(form.national_pension_floor)
          : null,
        health_rate: form.health_rate,
        long_term_care_rate_on_health: form.long_term_care_rate_on_health,
        employment_unemployment_rate: form.employment_unemployment_rate,
        employment_stability_rate: form.employment_stability_rate,
        industrial_accident_rate: form.industrial_accident_rate,
        company_size_tier: form.company_size_tier || null,
        industry_note: form.industry_note || null,
      };
      if (target) {
        return (await api.patch(`/hr/insurance-rates/${target.id}`, payload)).data;
      }
      return (await api.post("/hr/insurance-rates", payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["insurance-rates"] });
      onClose();
    },
    onError: (e: any) =>
      setError(
        e?.response?.data?.detail?.[0]?.msg ?? e?.response?.data?.detail ?? "저장 실패",
      ),
  });

  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={target ? "요율 편집" : "새 요율 등록"}
      width="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => form.effective_from && saveM.mutate()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
          >
            <Save className="h-4 w-4" />
            저장
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 text-xs">
        <RField label="적용 시작일 *">
          <DateInput
            value={form.effective_from}
            onChange={(v) => setForm((p) => ({ ...p, effective_from: v }))}
          />
        </RField>
        <RField label="연도">
          <input
            type="number"
            value={form.year}
            onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))}
            className={input}
          />
        </RField>

        <RField label="국민연금 요율 (예: 0.045)">
          <input
            value={form.national_pension_rate}
            onChange={(e) =>
              setForm((p) => ({ ...p, national_pension_rate: e.target.value }))
            }
            className={input}
          />
        </RField>
        <RField label="국민연금 보수월액 상한 (원)">
          <input
            type="number"
            value={form.national_pension_ceiling}
            onChange={(e) =>
              setForm((p) => ({ ...p, national_pension_ceiling: e.target.value }))
            }
            className={input}
          />
        </RField>

        <RField label="국민연금 보수월액 하한 (원)">
          <input
            type="number"
            value={form.national_pension_floor}
            onChange={(e) =>
              setForm((p) => ({ ...p, national_pension_floor: e.target.value }))
            }
            className={input}
          />
        </RField>
        <RField label="건강보험 요율 (예: 0.03545)">
          <input
            value={form.health_rate}
            onChange={(e) => setForm((p) => ({ ...p, health_rate: e.target.value }))}
            className={input}
          />
        </RField>

        <RField label="장기요양 요율 (건강보험료 대비, 예: 0.1295)">
          <input
            value={form.long_term_care_rate_on_health}
            onChange={(e) =>
              setForm((p) => ({ ...p, long_term_care_rate_on_health: e.target.value }))
            }
            className={input}
          />
        </RField>
        <RField label="고용보험 실업급여 요율 (예: 0.009)">
          <input
            value={form.employment_unemployment_rate}
            onChange={(e) =>
              setForm((p) => ({ ...p, employment_unemployment_rate: e.target.value }))
            }
            className={input}
          />
        </RField>

        <RField label="고용보험 고용안정·직능 요율 (예: 0.0025)">
          <input
            value={form.employment_stability_rate}
            onChange={(e) =>
              setForm((p) => ({ ...p, employment_stability_rate: e.target.value }))
            }
            className={input}
          />
        </RField>
        <RField label="산재 요율 (예: 0.007)">
          <input
            value={form.industrial_accident_rate}
            onChange={(e) =>
              setForm((p) => ({ ...p, industrial_accident_rate: e.target.value }))
            }
            className={input}
          />
        </RField>

        <RField label="회사 규모">
          <select
            value={form.company_size_tier}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                company_size_tier: (e.target.value || "") as CompanySizeTier | "",
              }))
            }
            className={input}
          >
            <option value="">선택</option>
            <option value="UNDER_150">150인 미만</option>
            <option value="150_TO_1000">150~1000인</option>
            <option value="OVER_1000">1000인 이상</option>
          </select>
        </RField>
        <RField label="업종 메모">
          <input
            value={form.industry_note}
            onChange={(e) => setForm((p) => ({ ...p, industry_note: e.target.value }))}
            className={input}
          />
        </RField>

        {error && <div className="col-span-2 text-xs text-destructive">{error}</div>}
      </div>
    </Dialog>
  );
}

function RField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

type TaxTable = {
  id: string;
  effective_from: string;
  source_filename: string | null;
  note: string | null;
  row_count: number;
};

function TaxTableCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const fileRef = useRef<HTMLInputElement>(null);
  const [effFrom, setEffFrom] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [note, setNote] = useState("");

  const { data: tables = [] } = useQuery<TaxTable[]>({
    queryKey: ["withholding-tax-tables"],
    queryFn: async () => (await api.get("/payroll/tax-tables")).data,
  });

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("effective_from", effFrom);
      if (note) fd.append("note", note);
      return (
        await api.post("/payroll/tax-tables", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["withholding-tax-tables"] });
      setNote("");
    },
    onError: (e: any) => {
      dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "업로드 실패",
      );
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/payroll/tax-tables/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["withholding-tax-tables"] }),
  });

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60";

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">간이세액표 (국세청)</h2>
        {!isAdmin && (
          <span className="text-xs text-muted-foreground">관리자만 업로드 가능</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        국세청 배포 <b>근로소득간이세액표</b> Excel 파일을 업로드합니다. 기준일
        이후의 급여 회차에 자동 적용됩니다. 최신 효력일 파일이 항상 우선
        적용되며, 과거 회차 재계산을 위해 구 버전은 그대로 유지됩니다.
      </p>
      {isAdmin && (
        <div className="grid grid-cols-3 gap-2 mb-3 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">기준 년월일</span>
            <DateInput
              value={effFrom}
              onChange={(v) => setEffFrom(v)}
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-xs text-muted-foreground">비고 (선택)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="예: 2026년 1월 개정"
              className={input}
            />
          </label>
          <div className="col-span-3 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadM.mutate(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploadM.isPending || !effFrom}
              onClick={() => fileRef.current?.click()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {uploadM.isPending ? "업로드 중..." : "Excel 업로드"}
            </button>
            <span className="text-xs text-muted-foreground">
              시트 이름에 80/100/120 이 포함되면 각각 선택율로 매핑, 아니면
              첫 시트를 100% 기준으로 사용.
            </span>
          </div>
        </div>
      )}

      <TaxTableViewer
        tables={tables}
        isAdmin={isAdmin}
        onDelete={(id) => deleteM.mutate(id)}
      />
    </div>
  );
}

type TaxRow = {
  id: string;
  bracket_min: string;
  bracket_max: string;
  dependents: number;
  tax_80: string;
  tax_100: string;
  tax_120: string;
};

// 업로드된 세액표 중 하나를 선택 → AG Grid 로 월급여 구간 × 부양가족 1..11 세액 표시.
function TaxTableViewer({
  tables,
  isAdmin,
  onDelete,
}: {
  tables: TaxTable[];
  isAdmin: boolean;
  onDelete: (id: string) => void;
}) {
  const dialog = useDialog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rate, setRate] = useState<"80" | "100" | "120">("100");

  // 목록이 로드되면 기본 선택을 최신(효력시점 내림차순 첫 항목) 으로.
  useEffect(() => {
    if (!selectedId && tables.length > 0) {
      setSelectedId(tables[0].id);
    }
    if (selectedId && !tables.find((t) => t.id === selectedId)) {
      setSelectedId(tables[0]?.id ?? null);
    }
  }, [tables, selectedId]);

  const current = tables.find((t) => t.id === selectedId);

  const { data: rows = [] } = useQuery<TaxRow[]>({
    queryKey: ["withholding-tax-rows", selectedId],
    queryFn: async () =>
      (await api.get(`/payroll/tax-tables/${selectedId}/rows`)).data,
    enabled: !!selectedId,
  });

  // 픽셀 관점: 구간 (bracket_min, bracket_max) 별로 1행 — 11 dep 를 컬럼으로 펼침.
  type PivotRow = {
    id: string; // "minwon-maxwon"
    bracket_min: number;
    bracket_max: number;
    dep1: number;
    dep2: number;
    dep3: number;
    dep4: number;
    dep5: number;
    dep6: number;
    dep7: number;
    dep8: number;
    dep9: number;
    dep10: number;
    dep11: number;
  };

  const pivoted: PivotRow[] = useMemo(() => {
    const col = rate === "80" ? "tax_80" : rate === "120" ? "tax_120" : "tax_100";
    const bucket = new Map<string, PivotRow>();
    for (const r of rows) {
      const key = `${r.bracket_min}-${r.bracket_max}`;
      let b = bucket.get(key);
      if (!b) {
        b = {
          id: key,
          bracket_min: Number(r.bracket_min),
          bracket_max: Number(r.bracket_max),
          dep1: 0,
          dep2: 0,
          dep3: 0,
          dep4: 0,
          dep5: 0,
          dep6: 0,
          dep7: 0,
          dep8: 0,
          dep9: 0,
          dep10: 0,
          dep11: 0,
        };
        bucket.set(key, b);
      }
      const d = r.dependents;
      if (d >= 1 && d <= 11) {
        (b as any)[`dep${d}`] = Number((r as any)[col]);
      }
    }
    return [...bucket.values()].sort(
      (a, b) => a.bracket_min - b.bracket_min,
    );
  }, [rows, rate]);

  const fmt = (v: number) =>
    v ? Number(v).toLocaleString("ko-KR") : "-";

  const input =
    "h-9 rounded-md border border-input bg-background px-3 text-sm";

  if (tables.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">업로드된 파일 없음</p>
    );
  }

  return (
    <div className="flex flex-col gap-3 min-h-[500px]">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">기준 년월일</span>
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className={input + " min-w-[220px]"}
          >
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.effective_from}
                {t.note ? ` · ${t.note}` : ""}
                {" · "}
                {t.row_count.toLocaleString("ko-KR")}행
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">선택율</span>
          <select
            value={rate}
            onChange={(e) => setRate(e.target.value as "80" | "100" | "120")}
            className={input}
          >
            <option value="80">80%</option>
            <option value="100">100% (기본)</option>
            <option value="120">120%</option>
          </select>
        </label>
        {current && (
          <div className="text-xs text-muted-foreground flex-1">
            <div>
              <span className="font-medium text-foreground">
                {current.source_filename ?? "-"}
              </span>
            </div>
            <div>{pivoted.length.toLocaleString("ko-KR")} 월급여 구간 · 부양가족 1~11명</div>
          </div>
        )}
        {isAdmin && current && (
          <button
            type="button"
            onClick={async () => {
              if (
                await dialog.confirm(
                  `${current.effective_from} 기준 세액표를 삭제하시겠습니까?`,
                  { destructive: true },
                )
              ) {
                onDelete(current.id);
              }
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100"
          >
            <Trash2 className="h-4 w-4" />
            이 버전 삭제
          </button>
        )}
      </div>

      {/* 모든 행을 일반 HTML 테이블로 표시. 스크롤 컨테이너 고정 높이 + sticky 헤더. */}
      <div
        className="border border-border rounded-md bg-card overflow-auto"
        style={{ maxHeight: 700 }}
      >
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted/60">
            <tr>
              <th className="sticky left-0 z-20 bg-muted/80 px-2 py-2 text-right font-medium border-b border-border whitespace-nowrap">
                이상(원)
              </th>
              <th className="sticky left-[90px] z-20 bg-muted/80 px-2 py-2 text-right font-medium border-b border-border whitespace-nowrap">
                미만(원)
              </th>
              {Array.from({ length: 11 }, (_, i) => i + 1).map((n) => (
                <th
                  key={n}
                  className="px-2 py-2 text-right font-medium border-b border-border whitespace-nowrap"
                >
                  {n}명
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pivoted.length === 0 ? (
              <tr>
                <td
                  colSpan={13}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  데이터가 없습니다.
                </td>
              </tr>
            ) : (
              pivoted.map((r, idx) => (
                <tr
                  key={r.id}
                  className={
                    "border-b border-border/40 tabular-nums " +
                    (idx % 2 === 0 ? "" : "bg-muted/20")
                  }
                >
                  <td className="sticky left-0 bg-inherit px-2 py-1 text-right font-medium whitespace-nowrap">
                    {fmt(r.bracket_min)}
                  </td>
                  <td className="sticky left-[90px] bg-inherit px-2 py-1 text-right font-medium whitespace-nowrap border-r border-border">
                    {fmt(r.bracket_max)}
                  </td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep1)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep2)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep3)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep4)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep5)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep6)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep7)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep8)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep9)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep10)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.dep11)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

