"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  FileDown,
  Gift,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { DataGrid } from "@/components/data-grid/DataGrid";
import type { ColDef } from "ag-grid-community";
import { downloadLeaveBalancePDF } from "@/lib/leave-export";
import { sortDevelopersKo } from "@/lib/sort-developers";

type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
type LeaveType = "ANNUAL" | "HALF" | "UNPAID_PUBLIC";

type LeaveRequest = {
  id: string;
  developer_id: string;
  developer_name: string | null;
  developer_tag: string | null;
  leave_type: LeaveType;
  half_kind: "AM" | "PM" | null;
  category: string | null;
  start_date: string;
  end_date: string;
  days_total: number;
  status: Status;
  reason: string | null;
  rejected_reason: string | null;
  approved_at: string | null;
  allocations: Array<{
    source_type: "STATUTORY" | "REWARD";
    year: number | null;
    grant_id: string | null;
    days: number;
  }>;
  created_at: string;
};

type Developer = {
  id: string;
  name: string;
  tag?: string | null;
  employment_type: string;
  status?: string;
  hire_date?: string | null;
};

type MissingRow = {
  developer_id: string;
  name: string;
  hire_date: string | null;
  tenure_months: number | null;
  suggested_strategy: "ANNUAL_15" | "MONTHLY_ACCRUAL";
};

type TeamBalance = {
  developer_id: string;
  name: string;
  tag: string | null;
  employment_type: string;
  hire_date: string | null;
  initialized: boolean;
  accrual_strategy: "ANNUAL_15" | "MONTHLY_ACCRUAL" | null;
  statutory_granted: number;
  statutory_used: number;
  statutory_pending: number;
  statutory_remaining: number;
  reward_remaining: number;
  total_remaining: number;
  pending_request_count: number;
};

type TabKey = "requests" | "balances" | "history";

const STATUS_LABEL: Record<Status, string> = {
  PENDING: "승인 대기",
  APPROVED: "승인",
  REJECTED: "반려",
  CANCELLED: "취소",
};

const STATUS_COLOR: Record<Status, string> = {
  PENDING: "bg-amber-100 text-amber-700 border-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-700 border-emerald-300",
  REJECTED: "bg-red-100 text-red-700 border-red-300",
  CANCELLED: "bg-slate-200 text-slate-500 border-slate-300",
};

export default function LeavesAdminPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const now = new Date();
  const [tab, setTab] = useState<TabKey>("balances");
  const [statusFilter, setStatusFilter] = useState<Status | "ALL">("PENDING");
  const [year, setYear] = useState(now.getFullYear());
  const [historyDevId, setHistoryDevId] = useState<string>("");
  const [initOpen, setInitOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [rewardOpen, setRewardOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<LeaveRequest | null>(null);
  const [assignedOnly, setAssignedOnly] = useState(false);
  // 연차 사용 일괄 변경 — 편집 모드 + draft (developer_id → 입력 문자열).
  const [editingUsed, setEditingUsed] = useState(false);
  const [usedDraft, setUsedDraft] = useState<Record<string, string>>({});

  const { data: requests = [] } = useQuery<LeaveRequest[]>({
    queryKey: ["leave-requests", statusFilter, assignedOnly],
    queryFn: async () => {
      const params: Record<string, unknown> = {};
      if (statusFilter !== "ALL") params.status = statusFilter;
      if (assignedOnly) params.assigned_to_me = true;
      return (await api.get("/leaves", { params })).data;
    },
    staleTime: 10_000,
  });

  // 선택된 year 에 대해 초기화가 아직 필요한 직원 목록.
  // 길이 0 이면 "이미 모두 초기화됨" → 초기화 버튼 비활성화.
  const { data: missing = [] } = useQuery<MissingRow[]>({
    queryKey: ["leave-missing", year],
    queryFn: async () =>
      (await api.get("/leaves/balances/missing", { params: { year } })).data,
    staleTime: 10_000,
  });

  const { data: teamBalances = [] } = useQuery<TeamBalance[]>({
    queryKey: ["leave-team-balances", year],
    queryFn: async () =>
      (await api.get("/leaves/balances", { params: { year } })).data,
    staleTime: 10_000,
  });
  // 회사 연차 정책 (1~21년차 총 부여 일수) — 법정 부여 셀 tooltip 계산용.
  const { data: leavesPolicy } = useQuery<{ annual_days_by_year?: number[] }>({
    queryKey: ["settings", "leaves"],
    queryFn: async () => (await api.get("/settings/leaves")).data,
    staleTime: 60_000,
  });
  const policyDaysByYear = useMemo(() => {
    const arr = leavesPolicy?.annual_days_by_year;
    if (Array.isArray(arr) && arr.length === 21) return arr.map((v) => Number(v) || 0);
    // 법정 최저 fallback.
    return [
      15, 15, 16, 16, 17, 17, 18, 18, 19, 19,
      20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25,
    ];
  }, [leavesPolicy]);
  // 화면 / 삭제 버튼 활성 여부는 "이미 초기화된 row" 기준.
  // 모든 연차 삭제 후엔 모두 initialized=false 가 되어 빈 목록으로 표시됨.
  const initializedBalances = useMemo(
    () => teamBalances.filter((b) => b.initialized),
    [teamBalances],
  );
  const hasInitialized = initializedBalances.length > 0;

  // editingUsed 진행 중 통계 — 저장 버튼 라벨 / 비활성 판정용.
  const usedDraftStats = useMemo(() => {
    let changed = 0;
    let invalid = 0;
    for (const b of initializedBalances) {
      const st = usedCellState(usedDraft[b.developer_id], Number(b.statutory_used));
      if (st === "changed") changed += 1;
      else if (st === "invalid") invalid += 1;
    }
    return { changed, invalid };
  }, [initializedBalances, usedDraft]);

  // 전체 직원 디렉토리 (history 콤보박스용, FULL_TIME 만)
  const { data: devDirectory = [] } = useQuery<Developer[]>({
    queryKey: ["devs-directory-fulltime"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 5 * 60 * 1000,
  });

  // 처리 이력 — 전체 상태, created_at DESC (API 기본 정렬), 선택 직원 필터.
  const { data: historyRequests = [] } = useQuery<LeaveRequest[]>({
    queryKey: ["leave-requests-history", historyDevId],
    queryFn: async () =>
      (
        await api.get("/leaves", {
          params: historyDevId ? { developer_id: historyDevId } : {},
        })
      ).data,
    staleTime: 10_000,
    enabled: tab === "history",
  });

  const isPastYear = year < now.getFullYear();
  const canInitialize = !isPastYear && missing.length > 0;

  const approveM = useMutation({
    mutationFn: async (id: string) => api.post(`/leaves/${id}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
    },
  });

  const rejectM = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/leaves/${id}/reject`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
      setRejectTarget(null);
    },
  });

  // 회사 프로필 — PDF 헤더의 회사명에 사용.
  const { data: tenant } = useQuery<{ name: string }>({
    queryKey: ["tenants", "me"],
    queryFn: async () => (await api.get("/tenants/me")).data,
  });

  const [pdfBusy, setPdfBusy] = useState(false);
  async function handleDownloadPdf() {
    setPdfBusy(true);
    try {
      await downloadLeaveBalancePDF({
        year,
        rows: initializedBalances,
        company: { name: tenant?.name ?? "회사" },
      });
    } catch (err) {
      console.error(err);
      dialog.alert("PDF 생성 중 오류가 발생했습니다.", { title: "PDF 다운로드 실패" });
    } finally {
      setPdfBusy(false);
    }
  }

  // 연차 사용 일괄 변경 — 변경된 row 만 PATCH (drift 위험 차단).
  const saveUsedM = useMutation({
    mutationFn: async () => {
      // draft 와 원본 비교해 변경된 항목만 추림.
      const items: { developer_id: string; used_days: number }[] = [];
      for (const b of initializedBalances) {
        const raw = usedDraft[b.developer_id];
        if (raw == null) continue;
        const trimmed = raw.trim();
        if (trimmed === "") continue;
        const num = Number(trimmed);
        if (!Number.isFinite(num)) {
          throw new Error(`${b.name}: 숫자만 입력 가능합니다.`);
        }
        if (num < 0 || (num * 2) % 1 !== 0) {
          throw new Error(`${b.name}: 0.5 단위 0 이상의 숫자만 입력 가능합니다.`);
        }
        if (Number(b.statutory_used) === num) continue; // 변경 없음 — skip
        items.push({ developer_id: b.developer_id, used_days: num });
      }
      if (items.length === 0) {
        return { year, updated: 0, submitted: 0 };
      }
      return (await api.patch("/leaves/balances/used-days", { year, items })).data as {
        year: number;
        updated: number;
        submitted: number;
      };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
      qc.invalidateQueries({ queryKey: ["leave-balance"] });
      setEditingUsed(false);
      setUsedDraft({});
    },
    onError: async (e: any) => {
      await dialog.alert(
        e?.response?.data?.detail ?? e?.message ?? "저장 실패",
        { title: "오류" },
      );
    },
  });

  function startEditUsed() {
    const draft: Record<string, string> = {};
    for (const b of initializedBalances) {
      draft[b.developer_id] = String(b.statutory_used);
    }
    setUsedDraft(draft);
    setEditingUsed(true);
  }
  function cancelEditUsed() {
    setUsedDraft({});
    setEditingUsed(false);
  }

  const catchupM = useMutation({
    mutationFn: async () =>
      (await api.post("/leaves/balances/catchup", null, { params: { year } })).data,
    onSuccess: (data: {
      year: number;
      added_rows: number;
      per_developer: Record<string, number>;
    }) => {
      // 목록·상세 양쪽 캐시 모두 invalidate.
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
      qc.invalidateQueries({ queryKey: ["leave-balance"] });
      qc.invalidateQueries({ queryKey: ["leave-requests"] });

      const entries = Object.entries(data.per_developer);
      if (entries.length === 0) {
        dialog.alert(
          <div className="text-sm">
            {data.year}년 기준, 추가로 적립할 월이 없습니다.
          </div>,
          { title: "월 적립 최신화" },
        );
        return;
      }
      dialog.alert(
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-medium">{entries.length}명</span>에게 총{" "}
            <span className="font-medium">{data.added_rows}일</span> 추가되었습니다.
          </div>
          <ul className="max-h-64 overflow-auto rounded-md border border-border divide-y divide-border">
            {entries.map(([dev_id, days]) => {
              const b = teamBalances.find((x) => x.developer_id === dev_id);
              return (
                <li key={dev_id} className="flex items-center justify-between px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    {b?.name ?? dev_id}
                    <NameBadge tag={b?.tag} />
                  </span>
                  <span className="tabular-nums text-primary font-semibold">
                    +{days}일
                  </span>
                </li>
              );
            })}
          </ul>
        </div>,
        { title: `월 적립 최신화 (${data.year}년)` },
      );
    },
  });

  return (
    <>
      <DashboardHeader
        title="연차 관리"
        actions={
          <div className="flex items-center gap-2">
            {tab === "requests" && (
              <>
                <label className="h-8 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignedOnly}
                    onChange={(e) => setAssignedOnly(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  내 담당만
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  className="h-8 rounded-md border border-border bg-card px-2 text-sm"
                >
                  <option value="ALL">전체 상태</option>
                  <option value="PENDING">승인 대기</option>
                  <option value="APPROVED">승인</option>
                  <option value="REJECTED">반려</option>
                  <option value="CANCELLED">취소</option>
                </select>
              </>
            )}
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-8 rounded-md border border-border bg-card px-2 text-sm"
            >
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
            <Tooltip
              label={
                isPastYear
                  ? `${year}년은 과거 연도입니다.`
                  : "오늘까지 완료된 근무월을 일괄 적립 (MONTHLY_ACCRUAL 직원만)"
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={() => catchupM.mutate()}
                disabled={catchupM.isPending || isPastYear}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                <Calendar className="h-3.5 w-3.5" />
                {catchupM.isPending ? "적립 중…" : "월 적립 최신화"}
              </button>
            </Tooltip>
            <Tooltip
              label={
                isPastYear
                  ? `${year}년은 과거 연도라 초기화할 수 없습니다.`
                  : missing.length === 0
                    ? `${year}년은 이미 모든 직원이 초기화되었습니다.`
                    : `${missing.length}명 초기화 필요`
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={() => setInitOpen(true)}
                disabled={!canInitialize}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-card"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                연도 초기화
                {canInitialize && (
                  <span className="ml-1 rounded-full bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5">
                    {missing.length}
                  </span>
                )}
              </button>
            </Tooltip>
            <Tooltip
              label={
                hasInitialized
                  ? `${year}년의 모든 leave_balance + leave_accrual 삭제 (위험)`
                  : `${year}년에 삭제할 연차 데이터가 없습니다.`
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={() => setDeleteAllOpen(true)}
                disabled={!hasInitialized || editingUsed}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                모든 연차 삭제
              </button>
            </Tooltip>
            <Tooltip
              label={
                editingUsed
                  ? "저장 또는 취소 후 다시 사용 가능"
                  : !hasInitialized
                    ? `${year}년에 변경할 연차 데이터가 없습니다.`
                    : `${year}년 연차 사용 일수를 일괄 수정 (변경된 row 만 저장)`
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={startEditUsed}
                disabled={!hasInitialized || editingUsed}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-card"
              >
                <Pencil className="h-3.5 w-3.5" />
                연차 사용 일괄 변경
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={() => setRewardOpen(true)}
              className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
            >
              <Gift className="h-3.5 w-3.5" />
              포상 부여
            </button>
          </div>
        }
      />

      <div className="flex flex-col gap-3 p-4 min-h-0 flex-1 overflow-hidden">
        {/* Tabs */}
        <TabBar>
          <TabItem active={tab === "balances"} onClick={() => setTab("balances")}>
            연차 현황
            <span className="ml-2 text-[10px] text-muted-foreground">
              {teamBalances.length}명
            </span>
          </TabItem>
          <TabItem active={tab === "requests"} onClick={() => setTab("requests")}>
            연차 신청
            <span className="ml-2 text-[10px] text-muted-foreground">
              {requests.length}건
            </span>
          </TabItem>
          <TabItem active={tab === "history"} onClick={() => setTab("history")}>
            연차 처리 이력
          </TabItem>
        </TabBar>

        {tab === "balances" && (
          <>
            <div className="flex items-center justify-end gap-2">
              {editingUsed && (
                <>
                  <button
                    type="button"
                    onClick={cancelEditUsed}
                    disabled={saveUsedM.isPending}
                    className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={() => saveUsedM.mutate()}
                    disabled={
                      saveUsedM.isPending ||
                      usedDraftStats.invalid > 0 ||
                      usedDraftStats.changed === 0
                    }
                    title={
                      usedDraftStats.invalid > 0
                        ? `잘못된 입력 ${usedDraftStats.invalid}개`
                        : usedDraftStats.changed === 0
                          ? "변경된 항목이 없습니다."
                          : `${usedDraftStats.changed}개 행 저장`
                    }
                    className="h-8 inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 text-xs text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saveUsedM.isPending
                      ? "저장 중..."
                      : `저장${
                          usedDraftStats.changed > 0
                            ? ` (${usedDraftStats.changed})`
                            : ""
                        }`}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={pdfBusy || initializedBalances.length === 0 || editingUsed}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                <FileDown className="h-3.5 w-3.5" />
                {pdfBusy ? "생성 중..." : "PDF"}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-sm text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">직원</th>
                  <th className="text-left px-3 py-2">입사일</th>
                  <th className="text-left px-3 py-2">입사후 연차</th>
                  <th className="text-left px-3 py-2">초기화</th>
                  <th className="text-right px-3 py-2">법정 부여</th>
                  <th className="text-right px-3 py-2">사용</th>
                  <th className="text-right px-3 py-2">대기</th>
                  <th className="text-right px-3 py-2">법정 잔여</th>
                  <th className="text-right px-3 py-2">포상 잔여</th>
                  <th className="text-right px-3 py-2">총 잔여</th>
                  <th className="text-right px-3 py-2">대기 건수</th>
                </tr>
              </thead>
              <tbody>
                {initializedBalances.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      className="px-3 py-10 text-center text-muted-foreground"
                    >
                      {teamBalances.length === 0
                        ? "활성 직원이 없습니다."
                        : "초기화된 연차 데이터가 없습니다. 상단의 [연도 초기화] 버튼을 눌러 생성하세요."}
                    </td>
                  </tr>
                ) : (
                  initializedBalances.map((b) => (
                    <tr
                      key={b.developer_id}
                      className="border-t border-border hover:bg-muted/30"
                    >
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <Link
                            href={`/leaves/${b.developer_id}`}
                            className="text-primary hover:underline font-medium"
                          >
                            {b.name}
                          </Link>
                          <NameBadge tag={b.tag} />
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {b.hire_date || "-"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                        {tenureLabel(b.hire_date)}
                      </td>
                      <td className="px-3 py-2">
                        {b.initialized ? (
                          <span className="inline-flex items-center rounded-md border border-emerald-300 bg-emerald-50 px-2 h-5 text-[10px] text-emerald-700">
                            {b.accrual_strategy === "ANNUAL_15" ? "15일 일괄" : "월 적립"}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 px-2 h-5 text-[10px] text-amber-700">
                            초기화 필요
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums cursor-help">
                        <Tooltip
                          label={explainGranted(b, year, policyDaysByYear)}
                          side="top"
                        >
                          <span>{fmt(b.statutory_granted)}</span>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {editingUsed ? (
                          (() => {
                            const state = usedCellState(
                              usedDraft[b.developer_id],
                              Number(b.statutory_used),
                            );
                            const stateCls =
                              state === "changed"
                                ? "border-amber-400 bg-amber-50 text-amber-900"
                                : state === "invalid"
                                  ? "border-rose-400 bg-rose-50 text-rose-900"
                                  : "border-input bg-background";
                            return (
                              <input
                                type="number"
                                step="0.5"
                                min="0"
                                value={usedDraft[b.developer_id] ?? ""}
                                onChange={(e) =>
                                  setUsedDraft((p) => ({
                                    ...p,
                                    [b.developer_id]: e.target.value,
                                  }))
                                }
                                className={
                                  "w-16 rounded border px-2 py-0.5 text-right text-sm tabular-nums " +
                                  stateCls
                                }
                              />
                            );
                          })()
                        ) : (
                          fmt(b.statutory_used)
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                        {fmt(b.statutory_pending)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmt(b.statutory_remaining)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-sky-700">
                        {fmt(b.reward_remaining)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-primary">
                        {fmt(b.total_remaining)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {b.pending_request_count > 0 ? (
                          <span className="inline-flex items-center rounded-md border border-amber-300 bg-amber-100 px-2 h-5 text-[10px] text-amber-700">
                            {b.pending_request_count}건
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </>
        )}

        {tab === "requests" && (
          <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-sm text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">상태</th>
                  <th className="text-left px-3 py-2">직원</th>
                  <th className="text-left px-3 py-2">유형</th>
                  <th className="text-left px-3 py-2">기간</th>
                  <th className="text-right px-3 py-2">일수</th>
                  <th className="text-left px-3 py-2">사유</th>
                  <th className="text-left px-3 py-2">배분</th>
                  <th className="text-right px-3 py-2">조치</th>
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-10 text-center text-muted-foreground"
                    >
                      해당 상태의 신청이 없습니다.
                    </td>
                  </tr>
                ) : (
                  requests.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <span
                          className={
                            "inline-flex items-center rounded-md border px-2 h-5 text-[10px] " +
                            STATUS_COLOR[r.status]
                          }
                        >
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <Link
                            href={`/leaves/${r.developer_id}`}
                            className="text-primary hover:underline"
                          >
                            {r.developer_name || "-"}
                          </Link>
                          <NameBadge tag={r.developer_tag} />
                        </span>
                      </td>
                      <td className="px-3 py-2">{typeLabel(r)}</td>
                      <td className="px-3 py-2">
                        {r.start_date}
                        {r.start_date !== r.end_date ? ` ~ ${r.end_date}` : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmt(r.days_total)}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
                        {r.reason}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.allocations.map((a, i) => (
                            <span
                              key={i}
                              className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                            >
                              {a.source_type === "STATUTORY"
                                ? `법정 ${a.year} ${fmt(a.days)}`
                                : `포상 ${fmt(a.days)}`}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.status === "PENDING" && (
                          <div className="inline-flex gap-1">
                            <button
                              type="button"
                              onClick={() => approveM.mutate(r.id)}
                              className="h-7 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
                            >
                              <Check className="h-3.5 w-3.5" />
                              승인
                            </button>
                            <button
                              type="button"
                              onClick={() => setRejectTarget(r)}
                              className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-2 text-xs text-destructive hover:bg-red-100"
                            >
                              <X className="h-3.5 w-3.5" />
                              반려
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "history" && (
          <HistoryTabContent
            devs={devDirectory}
            selectedDevId={historyDevId}
            onSelectDev={setHistoryDevId}
            rows={historyRequests}
          />
        )}
      </div>

      {initOpen && (
        <InitializeDialog open year={year} onClose={() => setInitOpen(false)} />
      )}
      {deleteAllOpen && (
        <DeleteAllBalancesDialog
          year={year}
          onClose={() => setDeleteAllOpen(false)}
        />
      )}
      {rewardOpen && (
        <RewardGrantDialog open onClose={() => setRewardOpen(false)} />
      )}
      {rejectTarget && (
        <RejectDialog
          target={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmit={(reason) => rejectM.mutate({ id: rejectTarget.id, reason })}
          saving={rejectM.isPending}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 연차 처리 이력 탭
// ---------------------------------------------------------------------------

function HistoryTabContent({
  devs,
  selectedDevId,
  onSelectDev,
  rows,
}: {
  devs: Developer[];
  selectedDevId: string;
  onSelectDev: (id: string) => void;
  rows: LeaveRequest[];
}) {
  const sortedDevs = useMemo(
    () =>
      [...devs].sort((a, b) =>
        (a.name + (a.tag ?? "")).localeCompare(b.name + (b.tag ?? ""), "ko-KR"),
      ),
    [devs],
  );

  const columnDefs = useMemo<ColDef<LeaveRequest>[]>(
    () => [
      {
        field: "created_at",
        headerName: "신청일",
        sort: "desc",
        valueFormatter: (p: any) =>
          p.value ? new Date(p.value).toLocaleDateString("ko-KR") : "",
        width: 110,
      },
      {
        field: "status",
        headerName: "상태",
        flex: 0,
        cellRenderer: (p: any) => (
          <span
            className={
              "inline-flex items-center rounded-md border px-2 h-5 text-[10px] " +
              STATUS_COLOR[p.value as Status]
            }
          >
            {STATUS_LABEL[p.value as Status]}
          </span>
        ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
      {
        field: "developer_name",
        headerName: "직원",
        flex: 0,
        cellRenderer: (p: any) => (
          <span className="inline-flex items-center gap-1.5">
            <Link
              href={`/leaves/${p.data.developer_id}`}
              className="text-primary hover:underline"
            >
              {p.value || "-"}
            </Link>
            <NameBadge tag={p.data.developer_tag} />
          </span>
        ),
      },
      {
        colId: "leave_type",
        headerName: "유형",
        flex: 0,
        valueGetter: (p: any) => typeLabel(p.data),
      },
      {
        headerName: "기간",
        valueGetter: (p: any) =>
          p.data.start_date === p.data.end_date
            ? p.data.start_date
            : `${p.data.start_date} ~ ${p.data.end_date}`,
        width: 180,
      },
      {
        field: "days_total",
        headerName: "일수",
        flex: 0,
        cellStyle: { textAlign: "right" } as any,
        valueFormatter: (p: any) => fmt(Number(p.value)),
      },
      {
        headerName: "배분",
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        } as any,
        cellRenderer: (p: any) => (
          <div className="flex flex-wrap gap-2 justify-center">
            {(p.data.allocations as any[]).map((a, i) => (
              <span key={i} className="text-sm text-black">
                {a.source_type === "STATUTORY"
                  ? `법정 ${a.year} ${fmt(Number(a.days))}`
                  : `포상 ${fmt(Number(a.days))}`}
              </span>
            ))}
          </div>
        ),
      },
      {
        field: "reason",
        headerName: "사유",
        flex: 1,
        cellRenderer: (p: any) => {
          const base = p.value || "";
          if (p.data.status === "REJECTED" && p.data.rejected_reason) {
            return (
              <span>
                {base}
                <span className="text-red-600 ml-2">
                  (반려: {p.data.rejected_reason})
                </span>
              </span>
            );
          }
          return base;
        },
      },
      {
        field: "approved_at",
        headerName: "처리일",
        width: 110,
        valueFormatter: (p: any) =>
          p.value ? new Date(p.value).toLocaleDateString("ko-KR") : "",
      },
    ],
    [],
  );

  const summaryText = selectedDevId
    ? `선택 직원의 신청 이력 ${rows.length}건`
    : `전체 직원 신청 이력 ${rows.length}건`;

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">직원</span>
        <select
          value={selectedDevId}
          onChange={(e) => onSelectDev(e.target.value)}
          className="h-8 rounded-md border border-border bg-card px-3 text-sm min-w-[200px]"
        >
          <option value="">전체 직원</option>
          {sortedDevs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.tag ? ` [${d.tag}]` : ""}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{summaryText}</span>
      </div>

      <div className="flex flex-1 min-h-0 flex-col">
        <DataGrid<LeaveRequest>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          enableCheckbox={false}
          hideSearch
          pagination
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: ["status", "developer_name", "leave_type", "days_total"],
          }}
        />
      </div>
    </div>
  );
}

function NameBadge({ tag }: { tag?: string | null }) {
  if (!tag) return null;
  return (
    <span className="inline-flex items-center justify-center h-4 min-w-4 rounded border border-primary/40 bg-primary/10 text-primary text-[10px] px-1 font-semibold align-middle">
      {tag}
    </span>
  );
}

// 입사일 + reference 일자 → 근속 개월. 입사일 day 가 reference day 보다 늦으면 -1.
// 사용 셀 input 의 상태 분류 — 시각 강조 + 저장 버튼 활성/비활성에 사용.
function usedCellState(
  raw: string | undefined,
  original: number,
): "neutral" | "changed" | "invalid" {
  if (raw == null || raw.trim() === "") return "neutral";
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || (num * 2) % 1 !== 0) return "invalid";
  return num === Number(original) ? "neutral" : "changed";
}

function tenureMonthsAt(hireIso: string, ref: Date): number {
  const m = hireIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  const hire = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(hire.getTime())) return 0;
  let months =
    (ref.getFullYear() - hire.getFullYear()) * 12 +
    (ref.getMonth() - hire.getMonth());
  if (ref.getDate() < hire.getDate()) months -= 1;
  return Math.max(0, months);
}

// 법정 부여 셀의 native 툴팁 (HTML title 속성 — JS 라이브러리 X).
// 초기화된 row 만 의미있음. 미초기화/입사일 미입력 시 빈 문자열 반환.
function explainGranted(
  b: { initialized: boolean; hire_date: string | null; accrual_strategy: "ANNUAL_15" | "MONTHLY_ACCRUAL" | null; statutory_granted: number },
  year: number,
  policyDaysByYear: number[],
): string {
  if (!b.initialized || !b.hire_date) return "";
  const ref = new Date(year, 0, 1); // YYYY-01-01
  const months = tenureMonthsAt(b.hire_date, ref);

  if (b.accrual_strategy === "ANNUAL_15") {
    const yearOfTenure = Math.max(1, Math.floor(months / 12));
    const idx = Math.max(0, Math.min(20, yearOfTenure - 1));
    const policyDays = policyDaysByYear[idx];
    return [
      `${year}-01-01 기준 근속 ${months}개월 (${yearOfTenure}년차)`,
      `회사 정책: ${yearOfTenure}년차 = ${policyDays}일`,
      `→ 일괄 부여 ${b.statutory_granted}일`,
      "근거: 근로기준법 60조 + 회사 연차 정책 (설정 > 연차 정책)",
    ].join("\n");
  }

  // MONTHLY_ACCRUAL — 만 1년 미만, 매월 개근 1일 lifetime cap 11.
  const m = b.hire_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let annivStr = "?";
  if (m) {
    const hire = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const anniv = new Date(hire);
    anniv.setFullYear(hire.getFullYear() + 1);
    annivStr = anniv.toISOString().slice(0, 10);
  }
  return [
    `${year}-01-01 기준 근속 ${months}개월 (만 1년 미만)`,
    `정책: 매월 개근 시 1일 적립, lifetime 최대 11일 (근로기준법 60조 2항)`,
    `현재 ${b.statutory_granted}일 누적`,
    `만 1년 도달일: ${annivStr} (이후 ANNUAL 자동 전환, 누적 일수 보존)`,
  ].join("\n");
}

// 입사일 → "Y년 M개월" / "M개월" 라벨. 미입력은 "-".
function tenureLabel(hireDate: string | null | undefined): string {
  if (!hireDate) return "-";
  const m = hireDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "-";
  const hire = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(hire.getTime())) return "-";
  const now = new Date();
  let months =
    (now.getFullYear() - hire.getFullYear()) * 12 +
    (now.getMonth() - hire.getMonth());
  if (now.getDate() < hire.getDate()) months -= 1;
  if (months < 0) return "-";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${rem}개월`;
  if (rem === 0) return `${years}년`;
  return `${years}년 ${rem}개월`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(1);
}

function typeLabel(r: { leave_type: LeaveType; half_kind: "AM" | "PM" | null; category: string | null }) {
  if (r.leave_type === "HALF") return `반차 (${r.half_kind})`;
  if (r.leave_type === "UNPAID_PUBLIC") return `공가 (${r.category || "기타"})`;
  return "연차";
}

// ---------------------------------------------------------------------------
// 연도 초기화 다이얼로그
// ---------------------------------------------------------------------------

function InitializeDialog({
  open,
  year,
  onClose,
}: {
  open: boolean;
  year: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [targetYear, setTargetYear] = useState(year);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<{ initialized: number; skipped: number } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);

  const dryRunM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/leaves/balances/initialize", {
          year: targetYear,
          dry_run: true,
          note,
        })
      ).data,
    onSuccess: (data) => {
      setPreview(data.preview);
      setSummary(null);
      setErr(null);
    },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "실패"),
  });

  const commitM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/leaves/balances/initialize", {
          year: targetYear,
          dry_run: false,
          note,
        })
      ).data,
    onSuccess: (data) => {
      setSummary({ initialized: data.initialized_count, skipped: data.skipped_count });
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-missing"] });
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
    },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "실패"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="연차 연도 초기화"
      width="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={dryRunM.isPending}
            onClick={() => dryRunM.mutate()}
            className="h-9 rounded-md border border-border bg-card px-3 text-sm hover:bg-muted"
          >
            {dryRunM.isPending ? "계산 중…" : "미리보기 (Dry Run)"}
          </button>
          <button
            type="button"
            disabled={!preview || !!summary || commitM.isPending}
            onClick={() => commitM.mutate()}
            className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {commitM.isPending ? "적용 중…" : "초기화 확정"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
            {typeof err === "string" ? err : JSON.stringify(err)}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">대상 연도</span>
            <input
              type="number"
              value={targetYear}
              onChange={(e) => setTargetYear(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">메모 (선택)</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>
        </div>
        {summary && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            완료: 초기화 {summary.initialized}명 / 스킵 {summary.skipped}명 (이미 초기화됨)
          </div>
        )}
        {preview && (
          <div className="max-h-80 overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-1.5">이름</th>
                  <th className="text-left px-3 py-1.5">입사일</th>
                  <th className="text-right px-3 py-1.5">근속(월)</th>
                  <th className="text-left px-3 py-1.5">전략</th>
                  <th className="text-right px-3 py-1.5">부여 일수</th>
                </tr>
              </thead>
              <tbody>
                {preview.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                      추가 초기화할 직원이 없습니다 (모두 이미 {targetYear}년 잔여 존재).
                    </td>
                  </tr>
                ) : (
                  preview.map((p, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          {p.name}
                          <NameBadge tag={p.tag} />
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {p.hire_date || "-"}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {p.tenure_months ?? "-"}
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {p.suggested_strategy === "ANNUAL_15" ? "15일 일괄" : "월 적립"}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {fmt(Number(p.suggested_granted_days))}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 포상 부여 다이얼로그
// ---------------------------------------------------------------------------

// 모든 연차 삭제 확인 다이얼로그 — 사용자가 정확히 "모든 연차 삭제" 입력 시만 활성화.
function DeleteAllBalancesDialog({
  year,
  onClose,
}: {
  year: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [confirmText, setConfirmText] = useState("");
  const REQUIRED = "모든 연차 삭제";

  const deleteM = useMutation({
    mutationFn: async () =>
      (await api.delete("/leaves/balances/all", { params: { year } })).data as {
        deleted_balances: number;
        deleted_accruals: number;
      },
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: ["leaves"] });
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
      qc.invalidateQueries({ queryKey: ["leave-balances"] });
      qc.invalidateQueries({ queryKey: ["leave-missing"] });
      onClose();
      await dialog.alert(
        `${year}년 연차 데이터를 모두 삭제했습니다.\nbalances=${res.deleted_balances} · accruals=${res.deleted_accruals}`,
        { title: "삭제 완료" },
      );
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "삭제 실패", {
        title: "오류",
      });
    },
  });

  const ok = confirmText === REQUIRED;

  return (
    <Dialog
      open
      onClose={() => (deleteM.isPending ? null : onClose())}
      title={`${year}년 연차 데이터 일괄 삭제`}
      width="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={deleteM.isPending}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => deleteM.mutate()}
            disabled={!ok || deleteM.isPending}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive px-4 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            {deleteM.isPending ? "삭제 중..." : "삭제"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
          ⚠️ <strong>{year}년</strong> 의 모든 leave_balance 와 leave_accrual
          row 가 삭제됩니다. 직원의 신청 이력 (leave_requests) 과 포상 grant 는
          유지되나, balance 가 사라져 잔여가 0 으로 보입니다. 복구는
          "연도 초기화" 로 다시 만드는 방법뿐 — 누적된 월 적립은 사라집니다.
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            확인을 위해 아래 칸에 정확히{" "}
            <code className="px-1 rounded bg-muted">{REQUIRED}</code> 를
            입력하세요.
          </span>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={REQUIRED}
            autoFocus
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </label>
      </div>
    </Dialog>
  );
}


function RewardGrantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: devs = [] } = useQuery<Developer[]>({
    queryKey: ["devs-directory-fulltime"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 5 * 60 * 1000,
  });

  const [developerId, setDeveloperId] = useState<string>("");
  const [days, setDays] = useState("1");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const createM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/leaves/reward-grants", {
          developer_id: developerId,
          granted_days: Number(days),
          reason,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests"] });
      qc.invalidateQueries({ queryKey: ["leave-team-balances"] });
      onClose();
    },
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "실패"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="포상 연차 부여"
      width="max-w-md"
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
            disabled={!developerId || !reason || createM.isPending}
            onClick={() => createM.mutate()}
            className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {createM.isPending ? "부여 중…" : "부여"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <div className="rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-xs text-destructive">
            {typeof err === "string" ? err : JSON.stringify(err)}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">직원</span>
          <select
            value={developerId}
            onChange={(e) => setDeveloperId(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">선택…</option>
            {sortDevelopersKo(devs).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.tag ? ` [${d.tag}]` : ""}
              </option>
            ))}
          </select>
          {developerId && (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5 pt-1">
              선택됨 :
              {(() => {
                const s = devs.find((x) => x.id === developerId);
                return s ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{s.name}</span>
                    <NameBadge tag={s.tag} />
                  </span>
                ) : null;
              })()}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">일수 (0.5 단위)</span>
          <input
            type="number"
            step={0.5}
            min={0.5}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">사유</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="예) 5년 장기근속 포상"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 반려 사유 입력 다이얼로그
// ---------------------------------------------------------------------------

function RejectDialog({
  target,
  onClose,
  onSubmit,
  saving,
}: {
  target: LeaveRequest;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title={`연차 반려 — ${target.developer_name}`}
      width="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={!reason || saving}
            onClick={() => onSubmit(reason)}
            className="h-9 rounded-md bg-destructive px-3 text-sm text-white disabled:opacity-50"
          >
            {saving ? "반려 중…" : "반려"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-sm text-muted-foreground">
          {target.start_date}
          {target.start_date !== target.end_date ? ` ~ ${target.end_date}` : ""} · {fmt(target.days_total)}일
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">반려 사유</span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>
    </Dialog>
  );
}
