"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Paperclip, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  OpportunityFormBody,
  oppToPayload,
  type OppFormValues,
  type DeveloperBrief,
} from "@/components/opportunities/OpportunityFormBody";

type Stage = "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION";
type Status = "OPEN" | "WON" | "LOST" | "ABANDONED";

type Activity = {
  id: string;
  opportunity_id: string;
  activity_type: "MEETING" | "CALL" | "EMAIL" | "PROPOSAL" | "NOTE" | "OTHER";
  happened_at: string;
  summary: string;
  owner_id: string | null;
};

type StageHistory = {
  id: string;
  opportunity_id: string;
  from_stage: string | null;
  to_stage: string;
  from_status: string | null;
  to_status: string;
  changed_at: string;
  changed_by: string | null;
  note: string | null;
};

type Opportunity = {
  id: string;
  name: string;
  customer_id: string | null;
  customer_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  sales_rep_id: string | null;
  sales_rep_name: string | null;
  stage: Stage;
  status: Status;
  probability: number;
  expected_amount: string;
  currency: "KRW" | "USD";
  expected_close_date: string | null;
  closed_at: string | null;
  source: string | null;
  business_type: "RESEARCH" | "PRIVATE" | "PUBLIC" | null;
  description: string | null;
  memo: string | null;
  contact_name: string | null;
  contact_department: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  weighted_amount: string;
  converted_license_id: string | null;
  converted_project_id: string | null;
  registered_at: string | null;
  created_at: string;
  activities: Activity[];
  stage_history: StageHistory[];
};

const STAGE_LABEL: Record<Stage, string> = {
  LEAD: "발굴",
  QUALIFIED: "검증",
  PROPOSAL: "제안",
  NEGOTIATION: "협상",
};
const STATUS_LABEL: Record<Status, string> = {
  OPEN: "진행중",
  WON: "수주",
  LOST: "실주",
  ABANDONED: "중단",
};
const ACTIVITY_LABEL: Record<Activity["activity_type"], string> = {
  MEETING: "미팅",
  CALL: "전화",
  EMAIL: "메일",
  PROPOSAL: "제안",
  NOTE: "메모",
  OTHER: "기타",
};

const STAGE_BADGE: Record<Stage, string> = {
  LEAD: "bg-slate-100 text-slate-700 border-slate-200",
  QUALIFIED: "bg-sky-100 text-sky-700 border-sky-200",
  PROPOSAL: "bg-indigo-100 text-indigo-700 border-indigo-200",
  NEGOTIATION: "bg-amber-100 text-amber-700 border-amber-200",
};
const STATUS_BADGE: Record<Status, string> = {
  OPEN: "bg-slate-100 text-slate-700 border-slate-200",
  WON: "bg-emerald-100 text-emerald-700 border-emerald-200",
  LOST: "bg-red-100 text-red-700 border-red-200",
  ABANDONED: "bg-gray-100 text-gray-500 border-gray-200",
};

function fmtMoney(v: string | number, ccy: "KRW" | "USD") {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "-";
  if (ccy === "USD") {
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return Math.round(n).toLocaleString() + "원";
}

function daysUntil(iso?: string | null) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`).getTime();
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((d - t.getTime()) / 86_400_000);
}

type CustomerBrief = { id: string; name: string };

export default function OpportunityDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const dialog = useDialog();
  const router = useRouter();

  const { data: opp } = useQuery<Opportunity>({
    queryKey: ["opportunity", id],
    queryFn: async () => (await api.get(`/opportunities/${id}`)).data,
  });

  const { data: customers = [] } = useQuery<CustomerBrief[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  const { data: developersList = [] } = useQuery<DeveloperBrief[]>({
    queryKey: ["developers-active"],
    queryFn: async () => (await api.get("/developers")).data,
    staleTime: 60_000,
  });

  // Full-record edit modal.
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<OppFormValues>({});
  const [editError, setEditError] = useState<string | null>(null);

  const updateM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/opportunities/${id}`, oppToPayload(editForm))).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunity", id] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["opportunities-summary"] });
      setEditOpen(false);
      setEditError(null);
    },
    onError: (e: any) =>
      setEditError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "수정 실패",
      ),
  });

  function openEdit() {
    if (!opp) return;
    setEditForm({
      name: opp.name,
      customer_id: opp.customer_id,
      owner_id: opp.owner_id,
      sales_rep_id: (opp as any).sales_rep_id ?? null,
      stage: opp.stage,
      status: opp.status,
      probability: opp.probability,
      expected_amount: String(Number(opp.expected_amount) || 0),
      currency: opp.currency,
      expected_close_date: opp.expected_close_date ?? "",
      registered_at: opp.registered_at ?? "",
      source: opp.source ?? "",
      business_type: opp.business_type,
      description: opp.description ?? "",
      contact_name: opp.contact_name ?? "",
      contact_department: opp.contact_department ?? "",
      contact_phone: opp.contact_phone ?? "",
      contact_email: opp.contact_email ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/opportunities/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["opportunities-summary"] });
      router.push("/opportunities");
    },
  });

  if (!opp) {
    return (
      <>
        <DashboardHeader
          title="영업기회"
          actions={
            <Link
              href="/opportunities"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
          }
        />
        <div className="flex flex-1 flex-col gap-4 p-4">로딩 중...</div>
      </>
    );
  }

  const remaining = daysUntil(opp.expected_close_date);
  const title = opp.customer_name
    ? `${opp.customer_name} - ${opp.name}`
    : opp.name;

  return (
    <>
      <DashboardHeader
        title={title}
        actions={
          <div className="flex gap-2">
            <Link
              href="/opportunities"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
            <button
              type="button"
              onClick={openEdit}
              className="h-8 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted inline-flex items-center gap-1"
            >
              <Pencil className="h-3.5 w-3.5" />
              수정
            </button>
            <button
              type="button"
              onClick={async () => {
                if (
                  await dialog.confirm("이 영업기회를 삭제하시겠습니까?", {
                    destructive: true,
                  })
                ) {
                  deleteM.mutate();
                }
              }}
              disabled={deleteM.isPending}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-sm text-destructive hover:bg-red-100 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteM.isPending ? "삭제 중..." : "삭제"}
            </button>
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        <div className="grid grid-cols-4 gap-4">
          <Card label="예상 금액">
            <div className="text-2xl font-bold">
              {fmtMoney(opp.expected_amount, opp.currency)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              가중 {fmtMoney(opp.weighted_amount, opp.currency)}
            </div>
          </Card>
          <Card label="확률">
            <div className="text-2xl font-bold">{opp.probability}%</div>
          </Card>
          <Card label="단계 / 상태">
            <div className="flex flex-wrap gap-2 mt-1">
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STAGE_BADGE[opp.stage]}`}
              >
                {STAGE_LABEL[opp.stage]}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STATUS_BADGE[opp.status]}`}
              >
                {STATUS_LABEL[opp.status]}
              </span>
            </div>
          </Card>
          <Card label="예상 마감">
            <div
              className={`text-2xl font-bold ${
                remaining != null && remaining < 0 && opp.status === "OPEN"
                  ? "text-red-600"
                  : remaining != null && remaining < 30 && opp.status === "OPEN"
                    ? "text-amber-600"
                    : ""
              }`}
            >
              {remaining == null
                ? "-"
                : remaining < 0
                  ? `${-remaining}일 경과`
                  : `D-${remaining}`}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {opp.expected_close_date ?? "-"}
            </div>
          </Card>
        </div>

        <InfoSection opp={opp} />

        <StageControl opp={opp} />

        <ActivitiesSection opportunityId={id} activities={opp.activities} />

        <StageHistorySection history={opp.stage_history} />

        <AttachmentsSection opportunityId={id} />

        <MemoEditor opportunityId={id} initialMemo={opp.memo ?? ""} />
      </div>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="영업기회 수정"
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
              onClick={() => editForm.name && updateM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        <OpportunityFormBody
          form={editForm}
          setForm={(u) =>
            setEditForm((prev) => (typeof u === "function" ? u(prev) : u))
          }
          customers={customers}
          developers={developersList}
          error={editError}
        />
      </Dialog>
    </>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function InfoSection({ opp }: { opp: Opportunity }) {
  const bizLabel: Record<"RESEARCH" | "PRIVATE" | "PUBLIC", string> = {
    RESEARCH: "연구과제",
    PRIVATE: "민간사업",
    PUBLIC: "공공사업",
  };
  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="font-semibold mb-3">기본 정보</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Row label="기회명" value={opp.name} />
        <Row label="고객사" value={opp.customer_name ?? "-"} />
        <Row label="영업대표" value={opp.sales_rep_name ?? "-"} />
        <Row
          label="사업구분"
          value={opp.business_type ? bizLabel[opp.business_type] : "-"}
        />
        <Row label="소스" value={opp.source ?? "-"} />
        <Row
          label="등록일"
          value={opp.registered_at ?? opp.created_at.slice(0, 10)}
        />
        <Row label="예상 마감일" value={opp.expected_close_date ?? "-"} />
        <Row
          label="종료일"
          value={
            opp.closed_at
              ? new Date(opp.closed_at).toLocaleString("ko-KR")
              : "-"
          }
        />
      </dl>

      <div className="mt-4 border-t border-border pt-3">
        <div className="text-xs font-semibold mb-2">고객사 담당자 정보</div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="부서" value={opp.contact_department ?? "-"} />
          <Row label="담당자명" value={opp.contact_name ?? "-"} />
          <Row label="전화번호" value={opp.contact_phone ?? "-"} />
          <Row label="전자우편" value={opp.contact_email ?? "-"} />
        </dl>
      </div>

      {opp.description && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="text-xs text-muted-foreground mb-1">설명</div>
          <div className="text-sm whitespace-pre-wrap">{opp.description}</div>
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex-1">{value}</dd>
    </div>
  );
}

function StageControl({ opp }: { opp: Opportunity }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>(opp.stage);
  const [statusV, setStatusV] = useState<Status>(opp.status);
  const [probability, setProbability] = useState<number>(opp.probability);
  const [note, setNote] = useState("");

  useEffect(() => {
    setStage(opp.stage);
    setStatusV(opp.status);
    setProbability(opp.probability);
  }, [opp.id, opp.stage, opp.status, opp.probability]);

  const dirty =
    stage !== opp.stage ||
    statusV !== opp.status ||
    probability !== opp.probability;

  const mutate = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/opportunities/${opp.id}`, {
          stage,
          status: statusV,
          probability,
          stage_change_note: note || undefined,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunity", opp.id] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["opportunities-summary"] });
      setNote("");
    },
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">단계 / 상태</h2>
        <button
          type="button"
          onClick={() => mutate.mutate()}
          disabled={!dirty || mutate.isPending}
          className={`h-8 rounded-md px-3 text-sm ${
            dirty
              ? "bg-primary text-primary-foreground hover:bg-brand-dark"
              : "border border-border bg-background text-muted-foreground"
          } disabled:opacity-50`}
        >
          {mutate.isPending ? "저장 중..." : dirty ? "저장" : "변경 없음"}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="단계">
          <select
            value={stage}
            onChange={(e) => {
              const s = e.target.value as Stage;
              setStage(s);
              const p = { LEAD: 10, QUALIFIED: 25, PROPOSAL: 50, NEGOTIATION: 75 }[s];
              if (p != null) setProbability(p);
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="LEAD">발굴</option>
            <option value="QUALIFIED">검증</option>
            <option value="PROPOSAL">제안</option>
            <option value="NEGOTIATION">협상</option>
          </select>
        </Field>
        <Field label="상태">
          <select
            value={statusV}
            onChange={(e) => {
              const s = e.target.value as Status;
              setStatusV(s);
              if (s === "WON") setProbability(100);
              if (s === "LOST") setProbability(0);
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="OPEN">진행중</option>
            <option value="WON">수주</option>
            <option value="LOST">실주</option>
            <option value="ABANDONED">중단</option>
          </select>
        </Field>
        <Field label="확률 (%)">
          <input
            type="number"
            min={0}
            max={100}
            value={probability}
            onChange={(e) => setProbability(Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
        <Field label="변경 메모">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="예: 제안서 발송 완료"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Field>
      </div>
    </section>
  );
}

function toLocalDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ActivitiesSection({
  opportunityId,
  activities,
}: {
  opportunityId: string;
  activities: Activity[];
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [type, setType] = useState<Activity["activity_type"]>("NOTE");
  const [when, setWhen] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [summary, setSummary] = useState("");

  // Inline edit state — null means no row is being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editType, setEditType] = useState<Activity["activity_type"]>("NOTE");
  const [editWhen, setEditWhen] = useState("");
  const [editSummary, setEditSummary] = useState("");

  // Send the date as local midnight — server stores as timestamp but we only
  // care about the day.
  const toIso = (d: string) =>
    d ? new Date(`${d}T00:00:00`).toISOString() : new Date().toISOString();

  const addM = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/opportunities/${opportunityId}/activities`, {
          activity_type: type,
          happened_at: toIso(when),
          summary,
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunity", opportunityId] });
      setSummary("");
    },
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editingId) return null;
      return (
        await api.patch(`/opportunities/activities/${editingId}`, {
          activity_type: editType,
          happened_at: toIso(editWhen),
          summary: editSummary,
        })
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunity", opportunityId] });
      setEditingId(null);
    },
  });

  const delM = useMutation({
    mutationFn: async (aid: string) =>
      api.delete(`/opportunities/activities/${aid}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["opportunity", opportunityId] }),
  });

  function startEdit(a: Activity) {
    setEditingId(a.id);
    setEditType(a.activity_type);
    setEditWhen(toLocalDateInput(a.happened_at));
    setEditSummary(a.summary);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="font-semibold mb-3">활동 기록</h2>

      <div className="grid grid-cols-[7rem,9rem,1fr,auto] gap-2 mb-3">
        <select
          value={type}
          onChange={(e) =>
            setType(e.target.value as Activity["activity_type"])
          }
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="MEETING">미팅</option>
          <option value="CALL">전화</option>
          <option value="EMAIL">메일</option>
          <option value="PROPOSAL">제안</option>
          <option value="NOTE">메모</option>
          <option value="OTHER">기타</option>
        </select>
        <DateInput
          value={when}
          onChange={(v) => setWhen(v)}
        />
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="요약"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => summary && addM.mutate()}
          className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-40"
          disabled={!summary || addM.isPending}
        >
          <Plus className="h-4 w-4" />
          추가
        </button>
      </div>

      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">등록된 활동이 없습니다.</p>
      ) : (
        <ul className="space-y-0 divide-y divide-border rounded-md border border-border text-sm">
          {activities.map((a) =>
            editingId === a.id ? (
              <li
                key={a.id}
                className="grid grid-cols-[7rem,9rem,1fr,auto] gap-2 px-3 py-2 bg-muted/30"
              >
                <select
                  value={editType}
                  onChange={(e) =>
                    setEditType(
                      e.target.value as Activity["activity_type"],
                    )
                  }
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  <option value="MEETING">미팅</option>
                  <option value="CALL">전화</option>
                  <option value="EMAIL">메일</option>
                  <option value="PROPOSAL">제안</option>
                  <option value="NOTE">메모</option>
                  <option value="OTHER">기타</option>
                </select>
                <DateInput
                  value={editWhen}
                  onChange={(v) => setEditWhen(v)}
                />
                <input
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => updateM.mutate()}
                    disabled={!editSummary || updateM.isPending}
                    className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-40"
                  >
                    <Save className="h-4 w-4" />
                    저장
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="h-8 rounded-md border border-border bg-background px-3 text-sm"
                  >
                    취소
                  </button>
                </div>
              </li>
            ) : (
              <li key={a.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-sm font-medium shrink-0">
                  {ACTIVITY_LABEL[a.activity_type]}
                </span>
                <span className="text-sm text-muted-foreground shrink-0 w-24">
                  {new Date(a.happened_at).toLocaleDateString("ko-KR")}
                </span>
                <span className="flex-1 whitespace-pre-wrap">{a.summary}</span>
                <Tooltip label="수정" side="top">
                  <button
                    type="button"
                    onClick={() => startEdit(a)}
                    className="shrink-0 h-6 w-6 rounded-md text-muted-foreground hover:bg-muted flex items-center justify-center"
                    aria-label="수정"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip label="삭제" side="top">
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        await dialog.confirm("이 활동기록을 삭제하시겠습니까?", {
                          destructive: true,
                        })
                      ) {
                        delM.mutate(a.id);
                      }
                    }}
                    className="shrink-0 h-6 w-6 rounded-md text-destructive hover:bg-destructive/10 flex items-center justify-center"
                    aria-label="삭제"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Tooltip>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function StageHistorySection({ history }: { history: StageHistory[] }) {
  if (history.length === 0) return null;
  const stageKo = (v: string | null | undefined) =>
    v ? (STAGE_LABEL[v as Stage] ?? v) : "";
  const statusKo = (v: string | null | undefined) =>
    v ? (STATUS_LABEL[v as Status] ?? v) : "";
  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="font-semibold mb-3">단계 변경 이력</h2>
      <ol className="relative border-l border-border pl-4 space-y-3">
        {history.map((h) => {
          const hasFrom = !!h.from_stage || !!h.from_status;
          return (
            <li key={h.id} className="text-sm">
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-primary" />
              <div className="text-sm text-muted-foreground">
                {new Date(h.changed_at).toLocaleString("ko-KR")}
              </div>
              <div>
                {hasFrom ? (
                  <>
                    <span className="text-muted-foreground">
                      {stageKo(h.from_stage) || "-"}/
                      {statusKo(h.from_status) || "-"}
                    </span>
                    <span className="mx-2">→</span>
                  </>
                ) : null}
                <span className="font-medium">
                  {stageKo(h.to_stage)}/{statusKo(h.to_status)}
                </span>
              </div>
              {h.note && (
                <div className="text-sm text-muted-foreground mt-0.5">
                  {h.note}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type Attachment = {
  id: string;
  opportunity_id: string;
  file_name: string;
  mime_type?: string | null;
  size?: number | null;
  description?: string | null;
};

function AttachmentsSection({ opportunityId }: { opportunityId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: files = [] } = useQuery<Attachment[]>({
    queryKey: ["opportunity-attachments", opportunityId],
    queryFn: async () =>
      (await api.get(`/opportunities/${opportunityId}/attachments`)).data,
  });

  const uploadM = useMutation({
    mutationFn: async (list: File[]) => {
      for (const f of list) {
        const fd = new FormData();
        fd.append("file", f);
        await api.post(
          `/opportunities/${opportunityId}/attachments`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["opportunity-attachments", opportunityId],
      });
      setError(null);
    },
    onError: (e: any) =>
      setError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "업로드 실패",
      ),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/opportunities/attachments/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["opportunity-attachments", opportunityId],
      }),
  });

  const renameM = useMutation({
    mutationFn: async (args: { id: string; file_name: string }) =>
      api.patch(`/opportunities/attachments/${args.id}`, {
        file_name: args.file_name,
      }),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["opportunity-attachments", opportunityId],
      }),
  });

  const onFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const arr = Array.from(list);
    if (arr.length > 0) uploadM.mutate(arr);
  };

  const fmtSize = (n?: number | null) => {
    if (!n || n <= 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">첨부 파일</h2>
        <label className="h-8 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted inline-flex items-center gap-1 cursor-pointer">
          <Paperclip className="h-3.5 w-3.5" />
          파일 선택
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={`rounded-md border-2 border-dashed text-center text-sm py-8 mb-3 transition-colors ${
          dragging
            ? "border-primary bg-primary/5 text-primary"
            : "border-border text-muted-foreground"
        }`}
      >
        {uploadM.isPending
          ? "업로드 중..."
          : dragging
            ? "여기에 파일을 놓으세요"
            : "파일을 드래그해서 놓거나 우측 상단의 \"+ 파일 선택\"을 눌러 업로드하세요"}
      </div>
      {error && <div className="text-xs text-destructive mb-2">{error}</div>}

      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          업로드된 파일이 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await api.get(
                      `/opportunities/attachments/${f.id}/download`,
                      { responseType: "blob" },
                    );
                    const url = URL.createObjectURL(res.data as Blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = f.file_name;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 0);
                  } catch (e: any) {
                    dialog.alert(
                      e?.response?.data?.detail ??
                        e?.message ??
                        "다운로드에 실패했습니다.",
                    );
                  }
                }}
                className="font-medium text-primary hover:underline truncate text-left"
              >
                {f.file_name}
              </button>
              <span className="text-xs text-muted-foreground">
                {fmtSize(f.size)}
              </span>
              {f.description && (
                <span className="text-xs text-muted-foreground truncate max-w-md">
                  {f.description}
                </span>
              )}
              <AttachmentPreviewButton
                filename={f.file_name}
                mime={f.mime_type ?? null}
                downloadPath={`/opportunities/attachments/${f.id}/download`}
              />
              <button
                type="button"
                onClick={async () => {
                  const next = await dialog.prompt("파일 표시명 변경", {
                    defaultValue: f.file_name,
                  });
                  if (next && next.trim() && next !== f.file_name) {
                    renameM.mutate({ id: f.id, file_name: next.trim() });
                  }
                }}
                className="group/tt relative ml-auto text-xs text-muted-foreground hover:underline"
              >
                이름 변경
                <Tooltip label="이름 변경" side="top" inline />
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (
                    await dialog.confirm(
                      `"${f.file_name}"을(를) 삭제하시겠습니까?`,
                      { destructive: true },
                    )
                  ) {
                    deleteM.mutate(f.id);
                  }
                }}
                className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
              >
                <Trash2 className="h-3 w-3" />
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoEditor({
  opportunityId,
  initialMemo,
}: {
  opportunityId: string;
  initialMemo: string;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(initialMemo);
  const [saved, setSaved] = useState(initialMemo);

  useEffect(() => {
    setValue(initialMemo);
    setSaved(initialMemo);
  }, [initialMemo]);

  const saveM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/opportunities/${opportunityId}`, { memo: value })).data,
    onSuccess: () => {
      setSaved(value);
      qc.invalidateQueries({ queryKey: ["opportunity", opportunityId] });
    },
  });

  const dirty = value !== saved;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold">메모</h2>
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
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
      />
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
