"use client";

/**
 * 목표 작성 — query string scope=COMPANY|PERSONAL 로 진입.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bell, Save } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";

const TipTapEditor = dynamic(
  () => import("@/components/board/TipTapEditor").then((m) => m.TipTapEditor),
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">에디터 로딩…</div> },
);

type Me = {
  id: string;
  mapped_developer_id: string | null;
  role: string;
};

type Goal = {
  id: string;
  scope: "COMPANY" | "PERSONAL";
  year: number;
  title: string;
  category?: string;
  priority?: "HIGH" | "MEDIUM" | "LOW";
  difficulty?: "ROUTINE" | "NORMAL" | "CHALLENGING" | "STRETCH";
};

type AssignmentCandidate = {
  id: string;
  name: string;
  tag: string | null;
  title: string | null;
  is_self: boolean;
};

const CATEGORIES = [
  ["BUSINESS", "사업"],
  ["TECH", "기술"],
  ["CAREER", "커리어"],
  ["OPERATIONS", "운영"],
  ["PERSONAL_GROWTH", "자기계발"],
  ["OTHER", "기타"],
] as const;

const PRIORITIES = [
  ["HIGH", "상"],
  ["MEDIUM", "중"],
  ["LOW", "하"],
] as const;

const DIFFICULTIES = [
  ["ROUTINE", "일상 (×0.8)"],
  ["NORMAL", "표준 (×1.0)"],
  ["CHALLENGING", "도전 (×1.5)"],
  ["STRETCH", "도약 (×2.0)"],
] as const;

const STATUSES = [
  ["DRAFT", "초안"],
  ["IN_PROGRESS", "진행중"],
  ["AT_RISK", "위기"],
  ["DONE", "완료"],
  ["DROPPED", "중단"],
] as const;

export default function NewGoalPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const dialog = useDialog();
  const thisYear = new Date().getFullYear();

  const initialScope = (sp.get("scope") as "COMPANY" | "PERSONAL") ?? "PERSONAL";
  const initialYear = Number(sp.get("year")) || thisYear;
  const teamMode = sp.get("for") === "team"; // 팀 목표 탭에서 진입 — owner picker 활성.

  const { data: me } = useQuery<Me>({
    queryKey: ["auth-me"],
    queryFn: async () => (await api.get("/auth/me")).data,
  });

  // 할당 후보 — 본인 + 매니저 chain 후손 (또는 ADMIN 전체).
  const { data: candidates = [] } = useQuery<AssignmentCandidate[]>({
    queryKey: ["goal-assignment-candidates"],
    queryFn: async () => (await api.get("/goals/assignment-candidates")).data,
    enabled: !!me,
  });
  const onlyOne = candidates.length === 1;

  const [form, setForm] = useState({
    scope: initialScope,
    year: initialYear,
    // teamMode 일 때 owner_id 명시 입력. 그 외엔 "" → 본인 자동.
    owner_id: "",
    title: "",
    description: "",
    category: "BUSINESS",
    priority: "MEDIUM" as "HIGH" | "MEDIUM" | "LOW",
    difficulty: "NORMAL" as "ROUTINE" | "NORMAL" | "CHALLENGING" | "STRETCH",
    status: "DRAFT" as "DRAFT" | "IN_PROGRESS" | "AT_RISK" | "DONE" | "DROPPED",
    progress_pct: 0,
    due_date: "",
    parent_goal_id: "",
  });

  // PERSONAL 일 때 회사 목표 picker — 같은 연도의 회사 목표 목록.
  const { data: companyGoals = [] } = useQuery<Goal[]>({
    queryKey: ["goals", form.year, "COMPANY"],
    queryFn: async () =>
      (
        await api.get("/goals", {
          params: { year: form.year, scope: "COMPANY" },
        })
      ).data,
  });

  // ADMIN 이 아닌데 COMPANY 가 선택된 상태로 진입했으면 PERSONAL 로 강제 전환.
  // (URL ?scope=COMPANY 로 직접 접근하는 케이스 가드.)
  useEffect(() => {
    if (!me) return;
    if (form.scope === "COMPANY" && me.role !== "ADMIN") {
      setForm((f) => ({ ...f, scope: "PERSONAL", parent_goal_id: "" }));
    }
  }, [me?.role, form.scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // 회사 목표 연결 변경 시 분류·우선순위·난이도를 부모 회사 목표와 동일하게
  // 자동 설정. 사용자가 이후 수동으로 바꾸면 그 값이 우선 — 이 effect 는
  // parent_goal_id 변경 시점에만 동기화. 연결 해제(빈 값) 시에는 변경 안 함.
  useEffect(() => {
    if (!form.parent_goal_id) return;
    const parent = companyGoals.find((g) => g.id === form.parent_goal_id);
    if (!parent) return;
    setForm((f) => ({
      ...f,
      category: parent.category ?? f.category,
      priority: parent.priority ?? f.priority,
      difficulty: parent.difficulty ?? f.difficulty,
    }));
  }, [form.parent_goal_id, companyGoals]);

  // 디폴트 owner_id 자동 설정:
  //  - teamMode (팀 목표 탭에서 진입): "" — 사용자가 명시 선택 강제
  //  - 그 외: me 의 mapped_developer_id (할당 combo 기본값)
  //  - 옵션 1개뿐이면 그 id 로 강제 (disabled UI 와 일치)
  useEffect(() => {
    if (form.owner_id) return;
    if (onlyOne && candidates[0]) {
      setForm((f) => ({ ...f, owner_id: candidates[0].id }));
      return;
    }
    if (!teamMode && me?.mapped_developer_id) {
      setForm((f) => ({ ...f, owner_id: me.mapped_developer_id! }));
    }
  }, [me?.mapped_developer_id, candidates.length, onlyOne, teamMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const createM = useMutation({
    mutationFn: async () => {
      if (!form.title.trim()) throw new Error("제목을 입력하세요.");
      let owner_id: string | null = null;
      if (form.scope === "PERSONAL") {
        if (!form.owner_id) throw new Error("할당 대상자를 선택하세요.");
        owner_id = form.owner_id;
      }
      const body = {
        scope: form.scope,
        year: form.year,
        owner_id,
        parent_goal_id: form.parent_goal_id || null,
        title: form.title.trim(),
        description: form.description || null,
        category: form.category,
        priority: form.priority,
        difficulty: form.difficulty,
        status: form.status,
        progress_pct: form.progress_pct,
        due_date: form.due_date || null,
      };
      return (await api.post("/goals", body)).data;
    },
    onSuccess: (g: any) => router.push(`/goals/${g.id}`),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  return (
    <>
      <DashboardHeader title="목표 작성" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto max-w-3xl">
        <Link
          href="/goals"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 목표 목록으로
        </Link>

        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <Field label="범위">
            <div className="flex items-center gap-2">
              {(["PERSONAL", "COMPANY"] as const).map((s) => {
                // 회사 목표는 ADMIN 만 선택 가능. 그 외는 disabled.
                const isCompanyAdminOnly =
                  s === "COMPANY" && me?.role !== "ADMIN";
                const disabled =
                  (teamMode && s === "COMPANY") || isCompanyAdminOnly;
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={disabled}
                    title={
                      isCompanyAdminOnly
                        ? "회사 목표는 ADMIN 만 등록할 수 있습니다."
                        : undefined
                    }
                    onClick={() =>
                      setForm({ ...form, scope: s, parent_goal_id: "" })
                    }
                    className={
                      "h-8 rounded-md border px-3 text-xs disabled:opacity-50 disabled:cursor-not-allowed " +
                      (form.scope === s
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-input hover:bg-muted")
                    }
                  >
                    {s === "PERSONAL" ? "내 목표" : "회사 목표"}
                  </button>
                );
              })}
              {me?.role !== "ADMIN" && (
                <span className="text-[11px] text-muted-foreground">
                  (회사 목표는 ADMIN 전용)
                </span>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-4 gap-3">
            <Field label="연도">
              <input
                type="number"
                value={form.year}
                onChange={(e) =>
                  setForm({ ...form, year: Number(e.target.value) })
                }
                min={2024}
                max={2099}
                className={inputClass}
              />
            </Field>
            <Field label="분류">
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className={inputClass}
              >
                {CATEGORIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="우선순위">
              <select
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: e.target.value as any })
                }
                className={inputClass}
              >
                {PRIORITIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="난이도">
              <select
                value={form.difficulty}
                onChange={(e) =>
                  setForm({ ...form, difficulty: e.target.value as any })
                }
                className={inputClass}
              >
                {DIFFICULTIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="제목">
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="예: B2B 매출 30% 증대"
              className={inputClass}
            />
          </Field>

          {form.scope === "PERSONAL" && (
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-1">
                <Field label="할당">
                  <select
                    value={form.owner_id}
                    onChange={(e) =>
                      setForm({ ...form, owner_id: e.target.value })
                    }
                    disabled={onlyOne}
                    className={inputClass + " disabled:opacity-70 disabled:cursor-not-allowed"}
                  >
                    {!form.owner_id && <option value="">— 선택 —</option>}
                    {candidates.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.tag ? ` (${d.tag})` : ""}
                        {d.title ? ` · ${d.title}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="col-span-3">
                <Field label="회사 목표 연결 (선택)">
                  <select
                    value={form.parent_goal_id}
                    onChange={(e) =>
                      setForm({ ...form, parent_goal_id: e.target.value })
                    }
                    className={inputClass}
                  >
                    <option value="">— 연결 안 함 —</option>
                    {companyGoals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-muted-foreground">
                    선택 시 해당 회사 목표의 분류·우선순위·난이도가 자동 적용됩니다 (이후 수동 변경 가능).
                  </span>
                </Field>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Field label="상태">
              <select
                value={form.status}
                onChange={async (e) => {
                  const next = e.target.value as typeof form.status;
                  if (next === "DONE" && Number(form.progress_pct) < 100) {
                    const ok = await dialog.confirm(
                      <span>
                        완료 처리 시 진행률을 <b>100%</b> 로 변경하시겠습니까?
                        100% 가 되어야 종합 점수에 완료가 반영됩니다.
                      </span>,
                      {
                        title: "목표 완료",
                        confirmText: "100% 로 변경",
                        cancelText: "현재 진행률 유지",
                      },
                    );
                    setForm({
                      ...form,
                      status: next,
                      progress_pct: ok ? 100 : form.progress_pct,
                    });
                    return;
                  }
                  setForm({ ...form, status: next });
                }}
                className={inputClass}
              >
                {STATUSES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="진행률 (%)">
              <input
                type="number"
                value={form.progress_pct}
                onChange={(e) =>
                  setForm({ ...form, progress_pct: Number(e.target.value) })
                }
                min={0}
                max={200}
                className={inputClass + " tabular-nums"}
              />
            </Field>
            <Field label="마감일 (선택)">
              <input
                type="date"
                value={form.due_date}
                onChange={(e) =>
                  setForm({ ...form, due_date: e.target.value })
                }
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="설명">
            <div className="rounded-md border border-input bg-background overflow-hidden">
              <TipTapEditor
                value={form.description}
                onChange={(html) => setForm({ ...form, description: html })}
                placeholder="목표 배경·근거·KR(향후 자동화) 등 자유 기술"
              />
            </div>
          </Field>

          <NotificationInfoBox />

          <div className="flex justify-end gap-2 pt-2">
            <Link
              href="/goals"
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-4 h-8 text-xs hover:bg-muted"
            >
              취소
            </Link>
            <button
              type="button"
              disabled={createM.isPending || !form.title.trim()}
              onClick={() => createM.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" /> 저장
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const inputClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function NotificationInfoBox() {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Bell className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">알림 안내</span>
      </div>
      <ul className="text-xs space-y-1 text-muted-foreground leading-relaxed">
        <li>
          • <b>마감 1개월 전 (D-30) 1회</b> — 담당자(나) + 직속 매니저
        </li>
        <li>
          • <b>마감일 이후 첫 영업일 1회</b> — 담당자 + 직속 매니저 (토/일·공휴일은
          자동 다음 평일로 이동)
        </li>
        <li>
          • <b>완료(DONE) 처리 시</b> — 직속 매니저에게 즉시 알림
        </li>
        <li className="text-[11px]">
          ※ 회사 목표(COMPANY) 는 ADMIN role 사용자 전체에게 발송 · 매니저 미설정
          시 해당 수신자만 skip · 발송 채널은 Slack/Mattermost (관리자 설정).
        </li>
      </ul>
    </div>
  );
}
