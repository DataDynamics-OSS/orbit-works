"use client";

/**
 * 결재 — 결재함 / 내 신청 통합 페이지.
 *
 * 두 사용 케이스를 하나의 페이지에서 탭으로 전환:
 * - 결재함 (/approvals/inbox)  : 내가 처리해야 할 결재.
 * - 내 신청 (/approvals/mine)   : 내가 올린 결재.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { TabBar, TabItem } from "@/components/ui/TabBar";

type Step = {
  id: string;
  step_no: number;
  step_name: string;
  approver_id: string | null;
  approver_name: string | null;
  approver_title: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "DELEGATED" | "SKIPPED";
};

type CurrentPending = {
  step_no: number;
  step_name: string;
  approver_id: string | null;
  approver_name: string | null;
  approver_title: string | null;
  approver_phone: string | null;
  approver_email: string | null;
};

type Summary = {
  id: string;
  kind: string;
  template_id: string;
  template_name: string | null;
  template_icon: string | null;
  title: string;
  requester_id: string;
  requester_name: string | null;
  status: "DRAFT" | "SUBMITTED" | "IN_PROGRESS" | "APPROVED" | "REJECTED" | "CANCELLED";
  submitted_at: string | null;
  completed_at: string | null;
  created_at: string;
  my_pending_step: Step | null;
  current_pending_step: CurrentPending | null;
  total_steps: number;
  approved_steps: number;
};

const STATUS_LABEL: Record<Summary["status"], string> = {
  DRAFT: "임시저장",
  SUBMITTED: "제출됨",
  IN_PROGRESS: "결재 대기",
  APPROVED: "승인",
  REJECTED: "반려",
  CANCELLED: "취소",
};

const STATUS_TONE: Record<Summary["status"], string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-amber-100 text-amber-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-800",
  CANCELLED: "bg-zinc-200 text-zinc-700",
};

export default function ApprovalsLandingPage() {
  const [tab, setTab] = useState<"inbox" | "mine">("inbox");

  return (
    <>
      <DashboardHeader title="결재" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto">
        <div className="flex items-center justify-between">
          <TabBar>
            <TabItem active={tab === "inbox"} onClick={() => setTab("inbox")}>
              결재함
            </TabItem>
            <TabItem active={tab === "mine"} onClick={() => setTab("mine")}>
              내 신청
            </TabItem>
          </TabBar>
          <Link
            href="/approvals/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 h-8 text-xs text-primary-foreground hover:bg-brand-dark"
          >
            <Plus className="h-3.5 w-3.5" /> 신청서 작성
          </Link>
        </div>

        {tab === "inbox" ? <Inbox /> : <Mine />}
      </div>
    </>
  );
}

function Inbox() {
  const [filter, setFilter] = useState<"PENDING" | "DECIDED" | "ALL">("PENDING");
  const { data: rows = [], isLoading } = useQuery<Summary[]>({
    queryKey: ["approvals", "inbox", filter],
    queryFn: async () =>
      (await api.get("/approvals/inbox", { params: { status_filter: filter } })).data,
  });

  return (
    <section>
      <FilterBar
        options={[
          ["PENDING", "결재 대기"],
          ["DECIDED", "처리 완료"],
          ["ALL", "전체"],
        ]}
        value={filter}
        onChange={setFilter as (v: string) => void}
      />
      <RequestList
        rows={rows}
        isLoading={isLoading}
        emptyText={
          filter === "PENDING"
            ? "현재 결재할 항목이 없습니다."
            : filter === "DECIDED"
              ? "처리한 결재가 없습니다."
              : "결재함이 비어 있습니다."
        }
      />
    </section>
  );
}

function Mine() {
  const [filter, setFilter] = useState<"ALL" | "DRAFT" | "IN_PROGRESS" | "DONE" | "CANCELLED">(
    "ALL",
  );
  const { data: rows = [], isLoading } = useQuery<Summary[]>({
    queryKey: ["approvals", "mine", filter],
    queryFn: async () =>
      (await api.get("/approvals/mine", { params: { status_filter: filter } })).data,
  });
  return (
    <section>
      <FilterBar
        options={[
          ["ALL", "전체"],
          ["DRAFT", "임시저장"],
          ["IN_PROGRESS", "결재 대기"],
          ["DONE", "완료"],
          ["CANCELLED", "취소"],
        ]}
        value={filter}
        onChange={setFilter as (v: string) => void}
      />
      <RequestList
        rows={rows}
        isLoading={isLoading}
        emptyText="신청한 결재가 없습니다."
      />
    </section>
  );
}

function FilterBar({
  options,
  value,
  onChange,
}: {
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5 w-fit mb-3">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={
            "h-7 rounded px-3 text-xs transition-colors " +
            (value === v
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted")
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function RequestList({
  rows,
  isLoading,
  emptyText,
}: {
  rows: Summary[];
  isLoading: boolean;
  emptyText: string;
}) {
  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">불러오는 중…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* AG Grid (DataGrid 컴포넌트) 와 시각적 통일 — 13px + Roboto Condensed.
          헤더는 size 만 본문과 동일, font-medium + muted color 로 차별화. */}
      <table className="w-full text-[13px] font-display">
        <thead>
          <tr className="border-b text-left text-muted-foreground bg-muted/30">
            <th className="py-2 px-3 font-medium w-[170px]">종류</th>
            <th className="py-2 px-3 font-medium">제목</th>
            <th className="py-2 px-3 font-medium w-24">상태</th>
            <th className="py-2 px-3 font-medium w-44">현재 대기</th>
            <th className="py-2 px-3 font-medium w-24">진행</th>
            <th className="py-2 px-3 font-medium w-32">신청자</th>
            <th className="py-2 px-3 font-medium w-32">신청일</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
              onClick={() => {
                window.location.href = `/approvals/${r.id}`;
              }}
            >
              <td className="py-2 px-3">{r.template_name ?? r.kind}</td>
              <td className="py-2 px-3">
                <Link
                  href={`/approvals/${r.id}`}
                  className="font-medium hover:underline"
                >
                  {r.title}
                </Link>
              </td>
              <td className="py-2 px-3">
                <span
                  className={
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] " +
                    STATUS_TONE[r.status]
                  }
                >
                  {STATUS_LABEL[r.status]}
                </span>
              </td>
              <td className="py-2 px-3">
                <CurrentPendingCell pending={r.current_pending_step} />
              </td>
              <td className="py-2 px-3 tabular-nums">
                {r.approved_steps}/{r.total_steps}
              </td>
              <td className="py-2 px-3">{r.requester_name ?? "—"}</td>
              <td className="py-2 px-3">
                {(r.submitted_at ?? r.created_at).slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


// 현재 대기 셀 — 이름·직책 + hover 시 연락처 (📞 / 📧) tooltip.
// tooltip 은 native title 이 아니라 커스텀 div — tap-to-call / mailto 액션 가능하도록.
// row 의 onClick (상세 이동) 과 충돌하지 않도록 stopPropagation.
function CurrentPendingCell({ pending }: { pending: CurrentPending | null }) {
  if (!pending || !pending.approver_id) {
    return <span className="text-muted-foreground">—</span>;
  }
  const { approver_name, approver_title, approver_phone, approver_email } = pending;
  const hasContact = !!(approver_phone || approver_email);
  return (
    <div className="relative inline-block group">
      <span className="font-medium">
        {approver_name ?? "—"}
        {approver_title && (
          <span className="ml-1 text-xs text-muted-foreground">/ {approver_title}</span>
        )}
      </span>
      {hasContact && (
        <div
          onClick={(e) => e.stopPropagation()}
          className={
            "absolute z-20 left-0 top-full mt-1 hidden group-hover:flex " +
            "flex-col gap-1 rounded-md border border-border bg-popover " +
            "p-2 shadow-md text-xs whitespace-nowrap min-w-[180px]"
          }
        >
          {approver_phone && (
            <a
              href={`tel:${approver_phone.replace(/[^0-9+]/g, "")}`}
              className="inline-flex items-center gap-1.5 text-foreground hover:underline"
            >
              <span>📞</span>
              <span className="tabular-nums">{approver_phone}</span>
            </a>
          )}
          {approver_email && (
            <a
              href={`mailto:${approver_email}`}
              className="inline-flex items-center gap-1.5 text-foreground hover:underline"
            >
              <span>📧</span>
              <span>{approver_email}</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
