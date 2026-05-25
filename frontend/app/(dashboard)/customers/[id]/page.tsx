"use client";

/**
 * 회사 360° — 한 회사를 중심으로 영업기회·프로젝트·청구·라이센스·인터랙션을
 * 단일 페이지에서 요약. 권한은 SALES + ADMIN 만 (백엔드에서도 가드).
 *
 * 진입: `/customers` 그리드의 "상세" 아이콘 → `/customers/{id}`.
 * "전체보기" 링크는 각 도메인 페이지로 `?customer_id=<id>` 를 붙여 deep link.
 */

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Briefcase,
  ChevronRight,
  CreditCard,
  ExternalLink,
  FileText,
  Globe,
  Key,
  MessageSquare,
  Phone,
  Plus,
  Target,
  User,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { CustomerActivityDrawer } from "@/components/customers/CustomerActivityDrawer";

type Stats = {
  open_opportunities: number;
  won_opportunities: number;
  active_projects: number;
  completed_projects: number;
  active_licenses: number;
  invoices_total_krw: string;
  invoices_total_usd: string;
  invoices_unpaid_krw: string;
  invoices_unpaid_usd: string;
  interaction_count: number;
};

type CustomerOut = {
  id: string;
  name: string;
  business_no: string | null;
  representative: string | null;
  address: string | null;
  memo: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_status: string | null;
  contacts: Array<{ id: string; name: string; phone?: string; email?: string }>;
};

type Opp = {
  id: string;
  name: string;
  stage: string;
  status: string;
  expected_amount: string;
  currency: string;
  expected_close_date: string | null;
};

type Proj = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  total_contract_amount: string;
  contract_currency: string;
  is_orderer: boolean;
};

type Inv = {
  id: string;
  number: string;
  title: string;
  issue_date: string;
  due_date: string | null;
  currency: string;
  total_amount: string;
  paid_amount: string;
  status: string;
};

type Lic = {
  id: string;
  product_name: string;
  start_date: string;
  end_date: string;
  currency: string;
  amount: string;
  status: string;
};

type Inter = {
  id: string;
  type: string;
  occurred_at: string;
  title: string;
  author_name: string | null;
};

type Overview = {
  customer: CustomerOut;
  stats: Stats;
  recent_opportunities: Opp[];
  recent_projects: Proj[];
  recent_invoices: Inv[];
  recent_licenses: Lic[];
  recent_interactions: Inter[];
};

const STAGE_LABEL: Record<string, string> = {
  LEAD: "리드",
  QUALIFIED: "검증",
  PROPOSAL: "제안",
  NEGOTIATION: "협상",
};
const STATUS_LABEL: Record<string, string> = {
  OPEN: "진행",
  WON: "수주",
  LOST: "실주",
  ABANDONED: "중단",
};
const TYPE_LABEL: Record<string, string> = {
  CALL: "통화",
  MEETING: "미팅",
  EMAIL: "이메일",
  OTHER: "기타",
};

function fmtMoney(amount: string | null | undefined, currency: string): string {
  const n = Number(amount ?? 0);
  if (currency === "USD") return `$${n.toLocaleString("en-US")}`;
  return `₩${n.toLocaleString("ko-KR")}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return d.slice(0, 10);
}

function fmtDateTime(d: string): string {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export default function Customer360Page() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id;
  // URL `?activity=open` 와 양방향 동기화 → 링크 공유·뒤로가기 지원.
  const activityOpen = searchParams.get("activity") === "open";
  const setActivityOpen = (open: boolean) => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    if (open) sp.set("activity", "open");
    else sp.delete("activity");
    const qs = sp.toString();
    router.replace(qs ? `/customers/${id}?${qs}` : `/customers/${id}`, { scroll: false });
  };

  const { data: me } = useQuery<{
    role: string;
    mapped_developer_id: string | null;
    permissions?: string[];
  }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading, error } = useQuery<Overview>({
    queryKey: ["customer-overview", id],
    queryFn: async () => (await api.get(`/customers/${id}/overview`)).data,
    enabled: !!id,
  });

  const canManage = !!me?.permissions?.includes("customers.manage");
  const myDeveloperId = me?.mapped_developer_id ?? null;

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="회사 360°" />
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      </>
    );
  }

  if (error) {
    const status = (error as any)?.response?.status;
    return (
      <>
        <DashboardHeader title="회사 360°" />
        <div className="p-6 text-sm text-destructive">
          {status === 403
            ? "회사 360° 는 SALES 또는 ADMIN 역할만 접근할 수 있습니다."
            : status === 404
              ? "존재하지 않는 회사입니다."
              : "불러오기 실패"}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => router.push("/customers")}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록으로
            </button>
          </div>
        </div>
      </>
    );
  }

  if (!data) return null;
  const c = data.customer;

  return (
    <>
      <DashboardHeader
        title="회사 360°"
        actions={
          <button
            type="button"
            onClick={() => router.push("/customers")}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card shadow-sm px-3 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            목록으로
          </button>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {/* 회사 헤더 */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold">{c.name}</h1>
                {c.owner_name && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                    <User className="h-3 w-3" />
                    {c.owner_name}
                    {c.owner_status && c.owner_status !== "ACTIVE"
                      ? " (퇴사)"
                      : ""}
                  </span>
                )}
                {c.contacts[0] && (
                  <span className="text-xs text-muted-foreground">
                    담당자: {c.contacts[0].name}
                    {c.contacts[0].phone ? ` · ${c.contacts[0].phone}` : ""}
                  </span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <div>
                  <span className="text-muted-foreground/70">사업자번호 </span>
                  <span className="text-foreground/90">
                    {c.business_no ?? "—"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground/70">대표자 </span>
                  <span className="text-foreground/90">
                    {c.representative ?? "—"}
                  </span>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground/70">주소 </span>
                  <span className="text-foreground/90">
                    {c.address ?? "—"}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              {/* 활동 추가 — customers.manage 권한자만. ETC 는 read-only. */}
              {canManage && (
                <button
                  type="button"
                  onClick={() => setActivityOpen(true)}
                  className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark"
                >
                  <Plus className="h-3.5 w-3.5" />
                  활동 추가
                </button>
              )}
            </div>
          </div>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard
            icon={<Target className="h-4 w-4" />}
            label="진행 영업기회"
            value={String(data.stats.open_opportunities)}
            sub={`수주 ${data.stats.won_opportunities}건`}
          />
          <KpiCard
            icon={<Briefcase className="h-4 w-4" />}
            label="진행 프로젝트"
            value={String(data.stats.active_projects)}
            sub={`완료 ${data.stats.completed_projects}건`}
          />
          <KpiCard
            icon={<Key className="h-4 w-4" />}
            label="활성 라이센스"
            value={String(data.stats.active_licenses)}
            sub="만료일 기준"
          />
          <KpiCard
            icon={<CreditCard className="h-4 w-4" />}
            label="청구 합계"
            value={
              Number(data.stats.invoices_total_usd) > 0
                ? `${fmtMoney(data.stats.invoices_total_krw, "KRW")} / ${fmtMoney(data.stats.invoices_total_usd, "USD")}`
                : fmtMoney(data.stats.invoices_total_krw, "KRW")
            }
            sub={
              Number(data.stats.invoices_unpaid_krw) +
                Number(data.stats.invoices_unpaid_usd) >
              0
                ? `미수 ${fmtMoney(data.stats.invoices_unpaid_krw, "KRW")}${Number(data.stats.invoices_unpaid_usd) > 0 ? ` / ${fmtMoney(data.stats.invoices_unpaid_usd, "USD")}` : ""}`
                : "전액 수금"
            }
          />
          <KpiCard
            icon={<MessageSquare className="h-4 w-4" />}
            label="활동 기록"
            value={String(data.stats.interaction_count)}
            sub="누적"
          />
        </div>

        {/* 영업기회 */}
        <Section
          icon={<Target className="h-4 w-4" />}
          title="영업기회"
          countLabel={`${data.stats.open_opportunities + data.stats.won_opportunities}건`}
          seeAll={`/opportunities?customer_id=${c.id}`}
        >
          {data.recent_opportunities.length === 0 ? (
            <Empty>등록된 영업기회가 없습니다.</Empty>
          ) : (
            <Table>
              <THead cols={["이름", "단계 / 상태", "예상금액", "예상마감"]} />
              <tbody>
                {data.recent_opportunities.map((o) => (
                  <tr key={o.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link
                        href={`/opportunities?customer_id=${c.id}`}
                        className="text-primary hover:underline"
                      >
                        {o.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {STAGE_LABEL[o.stage] ?? o.stage} ·{" "}
                      {STATUS_LABEL[o.status] ?? o.status}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(o.expected_amount, o.currency)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtDate(o.expected_close_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>

        {/* 프로젝트 */}
        <Section
          icon={<Briefcase className="h-4 w-4" />}
          title="프로젝트"
          countLabel={`${data.stats.active_projects + data.stats.completed_projects}건`}
          seeAll={`/projects?customer_id=${c.id}`}
        >
          {data.recent_projects.length === 0 ? (
            <Empty>등록된 프로젝트가 없습니다.</Empty>
          ) : (
            <Table>
              <THead cols={["이름", "기간", "계약금액", "구분"]} />
              <tbody>
                {data.recent_projects.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link
                        href={`/projects?customer_id=${c.id}`}
                        className="text-primary hover:underline"
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtDate(p.start_date)} ~ {fmtDate(p.end_date)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(p.total_contract_amount, p.contract_currency)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {p.is_orderer ? "발주사" : "고객사"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>

        {/* 청구 */}
        <Section
          icon={<CreditCard className="h-4 w-4" />}
          title="청구"
          countLabel={fmtMoney(data.stats.invoices_total_krw, "KRW")}
          seeAll={`/invoices?customer_id=${c.id}`}
        >
          {data.recent_invoices.length === 0 ? (
            <Empty>발행된 매출 인보이스가 없습니다.</Empty>
          ) : (
            <Table>
              <THead
                cols={["번호 / 제목", "발행일", "금액", "수금", "상태"]}
              />
              <tbody>
                {data.recent_invoices.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link
                        href={`/invoices/${i.id}`}
                        className="text-primary hover:underline"
                      >
                        {i.number}
                      </Link>
                      <div className="text-xs text-muted-foreground truncate max-w-[300px]">
                        {i.title}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtDate(i.issue_date)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(i.total_amount, i.currency)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {fmtMoney(i.paid_amount, i.currency)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          "rounded px-1.5 py-0.5 " +
                          (i.status === "FINAL"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-700")
                        }
                      >
                        {i.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>

        {/* 라이센스 — KPI 만 + 최근 5건 (전체보기는 라이센스 페이지가 customer_id 필터를 미지원하므로 단순 링크) */}
        {data.recent_licenses.length > 0 && (
          <Section
            icon={<Key className="h-4 w-4" />}
            title="라이센스"
            countLabel={`활성 ${data.stats.active_licenses}건`}
          >
            <Table>
              <THead cols={["제품", "기간", "금액", "상태"]} />
              <tbody>
                {data.recent_licenses.map((li) => (
                  <tr key={li.id} className="border-t border-border">
                    <td className="px-3 py-2">{li.product_name}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtDate(li.start_date)} ~ {fmtDate(li.end_date)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(li.amount, li.currency)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {li.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>
        )}

        {/* 활동 */}
        <Section
          icon={<MessageSquare className="h-4 w-4" />}
          title="최근 활동"
          countLabel={`${data.stats.interaction_count}건`}
          // ETC 는 활동 작성 불가 — '활동 추가' 버튼 미노출. '전체보기' 는
          // drawer 안에서 read-only 모드로 자동 처리되므로 그대로 노출.
          actionLabel={canManage ? "활동 추가" : undefined}
          onAction={canManage ? () => setActivityOpen(true) : undefined}
          actionLabel2="전체보기"
          onAction2={() => setActivityOpen(true)}
        >
          {data.recent_interactions.length === 0 ? (
            <Empty>기록된 활동이 없습니다.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {data.recent_interactions.map((it) => (
                <li
                  key={it.id}
                  className="px-3 py-2 flex items-center gap-3 text-sm"
                >
                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-700 px-1.5 py-0.5 text-[11px]">
                    {TYPE_LABEL[it.type] ?? it.type}
                  </span>
                  <span className="text-xs text-muted-foreground w-32 shrink-0">
                    {fmtDateTime(it.occurred_at)}
                  </span>
                  <span className="flex-1 truncate">{it.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {it.author_name ?? "관리자"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {activityOpen && (
        <CustomerActivityDrawer
          customerId={c.id}
          customerName={c.name}
          ownerName={c.owner_name}
          myDeveloperId={myDeveloperId}
          canManage={canManage}
          onClose={() => setActivityOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 작은 building blocks
// ---------------------------------------------------------------------------

function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums truncate">
        {value}
      </div>
      {sub && (
        <div className="text-[11px] text-muted-foreground truncate">{sub}</div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  countLabel,
  seeAll,
  actionLabel,
  onAction,
  actionLabel2,
  onAction2,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  countLabel?: string;
  seeAll?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionLabel2?: string;
  onAction2?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold">{title}</h2>
          {countLabel && (
            <span className="text-xs text-muted-foreground">
              · {countLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
            >
              <Plus className="h-3 w-3" />
              {actionLabel}
            </button>
          )}
          {seeAll && (
            <Link
              href={seeAll}
              className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
            >
              전체보기
              <ChevronRight className="h-3 w-3" />
            </Link>
          )}
          {actionLabel2 && onAction2 && !seeAll && (
            <button
              type="button"
              onClick={onAction2}
              className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
            >
              {actionLabel2}
              <ChevronRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function Table({ children }: { children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      {children}
    </table>
  );
}

function THead({ cols }: { cols: string[] }) {
  return (
    <thead className="bg-muted/30 text-xs text-muted-foreground">
      <tr>
        {cols.map((c, i) => (
          <th
            key={c}
            className={
              "px-3 py-2 text-left font-medium " +
              (i >= cols.length - 2 && (c.includes("금액") || c.includes("수금"))
                ? "text-right"
                : "")
            }
          >
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
