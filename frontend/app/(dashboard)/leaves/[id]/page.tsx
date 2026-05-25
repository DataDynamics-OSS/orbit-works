"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Gift,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";

type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
type LeaveType = "ANNUAL" | "HALF" | "UNPAID_PUBLIC";

type Developer = {
  id: string;
  name: string;
  tag?: string | null;
  employment_type: string;
  status: string;
  hire_date: string | null;
  company_email: string | null;
  personal_email: string | null;
  title?: string | null;
};

type Balance = {
  year: number;
  statutory: {
    year: number;
    granted: number;
    used: number;
    pending: number;
    remaining: number;
    accrual_strategy: "ANNUAL_15" | "MONTHLY_ACCRUAL";
    expires_on: string;
    initialized_at: string | null;
  };
  reward: {
    remaining: number;
    grants: Array<{
      id: string;
      granted_days: number;
      remaining_days: number;
      reason: string;
      granted_at: string;
      revoked_at: string | null;
    }>;
  };
  total_remaining: number;
};

type LeaveRequest = {
  id: string;
  developer_id: string;
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

const STATUS_LABEL: Record<Status, string> = {
  PENDING: "승인 대기",
  APPROVED: "승인",
  REJECTED: "반려",
  CANCELLED: "취소",
};

// 임직원 고용형태·상태 한글 라벨 (developers 페이지와 동일).
const EMPLOYMENT_LABEL: Record<string, string> = {
  FULL_TIME: "정규직",
  FULL_TIME_SPECIAL: "정규직 (특수)",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
  INTERN: "인턴",
  PART_TIME: "아르바이트",
};
const DEV_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "활성",
  INACTIVE: "비활성",
};

// 입사일 → "Y년 M개월" / "M개월" 라벨. 미입력은 빈 문자열.
function tenureLabel(hireDate: string | null | undefined): string {
  if (!hireDate) return "";
  const m = hireDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const hire = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(hire.getTime())) return "";
  const now = new Date();
  let months =
    (now.getFullYear() - hire.getFullYear()) * 12 +
    (now.getMonth() - hire.getMonth());
  if (now.getDate() < hire.getDate()) months -= 1;
  if (months < 0) return "";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${rem}개월`;
  if (rem === 0) return `${years}년`;
  return `${years}년 ${rem}개월`;
}

const STATUS_COLOR: Record<Status, string> = {
  PENDING: "bg-amber-100 text-amber-700 border-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-700 border-emerald-300",
  REJECTED: "bg-red-100 text-red-700 border-red-300",
  CANCELLED: "bg-slate-200 text-slate-500 border-slate-300",
};

export default function LeaveDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [rewardOpen, setRewardOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Balance["reward"]["grants"][number] | null>(
    null,
  );
  const [rejectTarget, setRejectTarget] = useState<LeaveRequest | null>(null);

  const { data: dev } = useQuery<Developer>({
    queryKey: ["developer", id],
    queryFn: async () => (await api.get(`/developers/${id}`)).data,
    staleTime: 60_000,
  });

  const { data: balance } = useQuery<Balance>({
    queryKey: ["leave-balance", id, year],
    queryFn: async () =>
      (await api.get("/leaves/balance", { params: { developer_id: id, year } })).data,
    enabled: !!id,
  });

  const { data: requests = [] } = useQuery<LeaveRequest[]>({
    queryKey: ["leave-requests", id],
    queryFn: async () =>
      (await api.get("/leaves", { params: { developer_id: id } })).data,
    enabled: !!id,
    staleTime: 10_000,
  });

  const approveM = useMutation({
    mutationFn: async (rid: string) => api.post(`/leaves/${rid}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests", id] });
      qc.invalidateQueries({ queryKey: ["leave-balance", id] });
    },
  });

  const rejectM = useMutation({
    mutationFn: async ({ rid, reason }: { rid: string; reason: string }) =>
      api.post(`/leaves/${rid}/reject`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-requests", id] });
      qc.invalidateQueries({ queryKey: ["leave-balance", id] });
      setRejectTarget(null);
    },
  });

  const revokeM = useMutation({
    mutationFn: async ({ gid, reason }: { gid: string; reason: string }) =>
      api.patch(`/leaves/reward-grants/${gid}/revoke`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-balance", id] });
      setRevokeTarget(null);
    },
  });

  const pendingCount = useMemo(
    () => requests.filter((r) => r.status === "PENDING").length,
    [requests],
  );

  return (
    <>
      <DashboardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            {dev?.name || "-"}
            {dev?.tag && (
              <span className="inline-flex items-center justify-center h-5 min-w-5 rounded border border-primary/40 bg-primary/10 text-primary text-xs px-1.5 font-semibold">
                {dev.tag}
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/leaves"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
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

      <div className="flex flex-col gap-4 p-4 min-h-0 flex-1 overflow-auto">
        {/* 직원 기본 정보 */}
        {dev && (
          <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center text-lg font-bold">
              {dev.name.slice(0, 1)}
            </div>
            <div className="flex-1">
              <div className="text-base font-semibold inline-flex items-center gap-2">
                {dev.name}
                {dev.tag && (
                  <span className="inline-flex items-center justify-center h-5 min-w-5 rounded border border-primary/40 bg-primary/10 text-primary text-xs px-1.5 font-semibold">
                    {dev.tag}
                  </span>
                )}
                {dev.title ? (
                  <span className="text-sm text-muted-foreground font-normal">{dev.title}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {EMPLOYMENT_LABEL[dev.employment_type] ?? dev.employment_type}
                {" · "}
                {DEV_STATUS_LABEL[dev.status] ?? dev.status}
                {dev.hire_date ? ` · 입사 ${dev.hire_date}` : ""}
                {dev.hire_date ? ` · 입사후 ${tenureLabel(dev.hire_date)}` : ""}
              </div>
            </div>
            {pendingCount > 0 && (
              <span className="rounded-md border border-amber-300 bg-amber-100 px-3 h-8 inline-flex items-center text-xs text-amber-700">
                승인 대기 {pendingCount}건
              </span>
            )}
          </div>
        )}

        {/* 잔여 현황 */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold">{year}년 잔여 현황</h2>
            {balance?.statutory.initialized_at ? (
              <span className="text-xs text-muted-foreground">
                초기화: {new Date(balance.statutory.initialized_at).toLocaleDateString("ko-KR")} ·
                전략 {balance.statutory.accrual_strategy === "ANNUAL_15" ? "15일 일괄" : "월 적립"}
              </span>
            ) : (
              <span className="text-xs text-destructive">아직 {year}년 초기화 안됨</span>
            )}
          </div>
          <div className="grid grid-cols-5 gap-3">
            <StatBig
              label="총 잔여"
              value={balance ? fmt(balance.total_remaining) : "-"}
              sub="법정 + 포상"
              accent
            />
            <StatBig
              label="법정 부여"
              value={balance ? fmt(balance.statutory.granted) : "-"}
              sub={balance?.statutory.accrual_strategy === "MONTHLY_ACCRUAL" ? "월 적립" : "일괄"}
            />
            <StatBig
              label="법정 사용"
              value={balance ? fmt(balance.statutory.used) : "-"}
              sub="승인 완료"
            />
            <StatBig
              label="법정 승인대기"
              value={balance ? fmt(balance.statutory.pending) : "-"}
              sub="선차감"
            />
            <StatBig
              label="포상 잔여"
              value={balance ? fmt(balance.reward.remaining) : "-"}
              sub="이월 누적"
            />
          </div>
        </div>

        {/* 포상 이력 */}
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">포상 연차 이력</h2>
            <span className="text-xs text-muted-foreground">
              {balance?.reward.grants.length ?? 0}건
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2">부여일</th>
                <th className="text-left px-4 py-2">사유</th>
                <th className="text-right px-4 py-2">부여</th>
                <th className="text-right px-4 py-2">잔여</th>
                <th className="text-right px-4 py-2">조치</th>
              </tr>
            </thead>
            <tbody>
              {(balance?.reward.grants ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    부여된 포상 연차가 없습니다.
                  </td>
                </tr>
              ) : (
                balance!.reward.grants.map((g) => (
                  <tr key={g.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      {new Date(g.granted_at).toLocaleDateString("ko-KR")}
                    </td>
                    <td className="px-4 py-2">{g.reason}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(g.granted_days)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmt(g.remaining_days)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {g.remaining_days > 0 ? (
                        <button
                          type="button"
                          onClick={() => setRevokeTarget(g)}
                          className="h-7 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-2 text-xs text-destructive hover:bg-red-100"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          회수
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">소진</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 신청 이력 */}
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">연차 신청 이력</h2>
            <span className="text-xs text-muted-foreground">{requests.length}건</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2">상태</th>
                <th className="text-left px-4 py-2">유형</th>
                <th className="text-left px-4 py-2">기간</th>
                <th className="text-right px-4 py-2">일수</th>
                <th className="text-left px-4 py-2">배분</th>
                <th className="text-left px-4 py-2">사유</th>
                <th className="text-right px-4 py-2">조치</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                    신청 이력이 없습니다.
                  </td>
                </tr>
              ) : (
                requests.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      <span
                        className={
                          "inline-flex items-center rounded-md border px-2 h-5 text-[10px] " +
                          STATUS_COLOR[r.status]
                        }
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2">{typeLabel(r)}</td>
                    <td className="px-4 py-2">
                      {r.start_date}
                      {r.start_date !== r.end_date ? ` ~ ${r.end_date}` : ""}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.days_total)}</td>
                    <td className="px-4 py-2 text-xs">
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
                    <td className="px-4 py-2 text-xs text-muted-foreground max-w-xs truncate">
                      {r.reason}
                      {r.status === "REJECTED" && r.rejected_reason ? (
                        <span className="text-red-600"> · 반려: {r.rejected_reason}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right">
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
      </div>

      {rewardOpen && dev && (
        <RewardGrantDialog
          developerId={dev.id}
          developerName={dev.name}
          onClose={() => setRewardOpen(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["leave-balance", id] });
            setRewardOpen(false);
          }}
        />
      )}
      {revokeTarget && (
        <RevokeDialog
          grant={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onSubmit={(reason) => revokeM.mutate({ gid: revokeTarget.id, reason })}
          saving={revokeM.isPending}
        />
      )}
      {rejectTarget && (
        <RejectDialog
          target={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmit={(reason) => rejectM.mutate({ rid: rejectTarget.id, reason })}
          saving={rejectM.isPending}
        />
      )}
    </>
  );
}

function StatBig({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border px-4 py-3 " +
        (accent
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-background")
      }
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={"mt-1 text-2xl font-bold " + (accent ? "text-primary" : "")}>
        {value}
        <span className="ml-1 text-sm font-normal text-muted-foreground">일</span>
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
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
// 포상 부여
// ---------------------------------------------------------------------------

function RewardGrantDialog({
  developerId,
  developerName,
  onClose,
  onSuccess,
}: {
  developerId: string;
  developerName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
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
    onSuccess,
    onError: (e: any) => setErr(e?.response?.data?.detail ?? "실패"),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`포상 연차 부여 — ${developerName}`}
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
            disabled={!reason || createM.isPending}
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
// 포상 회수
// ---------------------------------------------------------------------------

function RevokeDialog({
  grant,
  onClose,
  onSubmit,
  saving,
}: {
  grant: { id: string; granted_days: number; remaining_days: number; reason: string };
  onClose: () => void;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="포상 연차 회수"
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
            {saving ? "회수 중…" : "회수"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="text-sm">
          "{grant.reason}" · 부여 {fmt(grant.granted_days)}일 · 잔여 {fmt(grant.remaining_days)}일
        </div>
        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          이미 사용된 일수는 회수되지 않고, 남은 잔여만 0으로 처리됩니다.
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">회수 사유</span>
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

// ---------------------------------------------------------------------------
// 반려
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
      title="연차 반려"
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
          {target.start_date !== target.end_date ? ` ~ ${target.end_date}` : ""} ·{" "}
          {fmt(target.days_total)}일
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
