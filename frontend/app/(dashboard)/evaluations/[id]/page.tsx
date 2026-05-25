"use client";

/**
 * 임직원 평가 — 상세 / 작성.
 *
 * 4 섹션:
 *   1. 헤더 — 직원 + 매니저 + cycle + status stepper.
 *   2. 목표 달성도 — cycle 기간의 PERSONAL goal 자동 집계 + self/manager/final.
 *   3. 역량 평가 — dimension 별 1~5 점 + 코멘트 (self/manager/final 컬럼).
 *   4. 종합 의견 — TipTap (self_narrative / manager_narrative / calibration_note).
 *
 * stage(self/manager/calibrate) 는 status + 본인 매핑으로 결정. 권한 없는
 * 컬럼은 read-only. FINALIZED 후엔 manager / final 이 본인에게도 노출.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, RotateCcw, Save } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { TipTapEditor, TipTapViewer } from "@/components/board/TipTapEditor";
import { fmtLocalDateTime } from "@/lib/format";

type EvalStatus =
  | "NOT_STARTED"
  | "SELF_DRAFT"
  | "SELF_SUBMITTED"
  | "MGR_DRAFT"
  | "MGR_SUBMITTED"
  | "CALIBRATED"
  | "FINALIZED";
type Grade = "S" | "A" | "B" | "C" | "D";

type Comp = {
  dimension_key: string;
  self_score: number | null;
  manager_score: number | null;
  final_score: number | null;
  self_comment: string | null;
  manager_comment: string | null;
  final_comment: string | null;
};

type GoalSummary = {
  count: number;
  completed: number;
  avg_progress: number;
  sum_self_score: number;
  sum_manager_score: number;
  prefill_score: number;
};

type Detail = {
  id: string;
  cycle_id: string;
  developer_id: string;
  developer_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  status: EvalStatus;
  final_grade: Grade | null;
  final_overall_score: number | null;
  self_submitted_at: string | null;
  manager_submitted_at: string | null;
  finalized_at: string | null;
  can_self: boolean;
  can_manager: boolean;
  can_calibrate: boolean;
  self_narrative: string | null;
  manager_narrative: string | null;
  calibration_note: string | null;
  goal_score_self: string | null;
  goal_score_manager: string | null;
  goal_score_final: string | null;
  competency_avg_self: string | null;
  competency_avg_manager: string | null;
  competency_avg_final: string | null;
  competencies: Comp[];
  goal_summary: GoalSummary | null;
};

type Dimension = {
  key: string;
  label: string;
  description: string | null;
  active: boolean;
  sort_order: number;
};

const STATUS_ORDER: EvalStatus[] = [
  "NOT_STARTED",
  "SELF_DRAFT",
  "SELF_SUBMITTED",
  "MGR_DRAFT",
  "MGR_SUBMITTED",
  "CALIBRATED",
  "FINALIZED",
];
const STATUS_LABEL: Record<EvalStatus, string> = {
  NOT_STARTED: "미시작",
  SELF_DRAFT: "자기평가",
  SELF_SUBMITTED: "자기평가 제출",
  MGR_DRAFT: "매니저 작성",
  MGR_SUBMITTED: "매니저 제출",
  CALIBRATED: "조정 완료",
  FINALIZED: "공개",
};
// goals 페이지와 동일 톤 (진한 배경 + 흰 글자).
const GRADE_COLOR: Record<Grade, string> = {
  S: "bg-purple-600 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-blue-600 text-white",
  C: "bg-amber-600 text-white",
  D: "bg-red-600 text-white",
};

export default function EvaluationDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: detail } = useQuery<Detail>({
    queryKey: ["eval", id],
    queryFn: async () => (await api.get(`/evaluations/${id}`)).data,
  });

  const { data: dims = [] } = useQuery<Dimension[]>({
    queryKey: ["evals", "dimensions"],
    queryFn: async () => (await api.get("/evaluations/dimensions")).data,
    staleTime: 5 * 60_000,
  });

  // stage 결정 — can_self > can_manager > can_calibrate > view-only.
  const stage: "self" | "manager" | "calibrate" | "view" = useMemo(() => {
    if (!detail) return "view";
    if (detail.can_calibrate) return "calibrate";
    if (detail.can_manager) return "manager";
    if (detail.can_self) return "self";
    return "view";
  }, [detail]);

  // 권한별 narrative + competency draft state.
  const [selfDraft, setSelfDraft] = useState({ narrative: "", goal: "" });
  const [mgrDraft, setMgrDraft] = useState({ narrative: "", goal: "" });
  const [calDraft, setCalDraft] = useState({
    note: "",
    goal: "",
    overall: "",
    grade: "" as Grade | "",
  });
  const [compDraft, setCompDraft] = useState<Record<string, Comp>>({});

  useEffect(() => {
    if (!detail) return;
    setSelfDraft({
      narrative: detail.self_narrative ?? "",
      goal: detail.goal_score_self ?? "",
    });
    setMgrDraft({
      narrative: detail.manager_narrative ?? "",
      goal: detail.goal_score_manager ?? "",
    });
    setCalDraft({
      note: detail.calibration_note ?? "",
      goal: detail.goal_score_final ?? "",
      overall:
        detail.final_overall_score === null ? "" : String(detail.final_overall_score),
      grade: detail.final_grade ?? "",
    });
    const map: Record<string, Comp> = {};
    for (const c of detail.competencies) map[c.dimension_key] = { ...c };
    setCompDraft(map);
  }, [detail]);

  const saveSelf = useMutation({
    mutationFn: async () => {
      const competencies = Object.values(compDraft).map((c) => ({
        dimension_key: c.dimension_key,
        score: c.self_score,
        comment: c.self_comment,
      }));
      return (
        await api.patch(`/evaluations/${id}/self`, {
          self_narrative: selfDraft.narrative,
          goal_score_self: selfDraft.goal === "" ? null : Number(selfDraft.goal),
          competencies,
        })
      ).data;
    },
    onSuccess: (data) => qc.setQueryData(["eval", id], data),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });
  const saveManager = useMutation({
    mutationFn: async () => {
      const competencies = Object.values(compDraft).map((c) => ({
        dimension_key: c.dimension_key,
        score: c.manager_score,
        comment: c.manager_comment,
      }));
      return (
        await api.patch(`/evaluations/${id}/manager`, {
          manager_narrative: mgrDraft.narrative,
          goal_score_manager: mgrDraft.goal === "" ? null : Number(mgrDraft.goal),
          competencies,
        })
      ).data;
    },
    onSuccess: (data) => qc.setQueryData(["eval", id], data),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });
  const saveCal = useMutation({
    mutationFn: async () => {
      const competencies = Object.values(compDraft).map((c) => ({
        dimension_key: c.dimension_key,
        score: c.final_score,
        comment: c.final_comment,
      }));
      return (
        await api.patch(`/evaluations/${id}/calibrate`, {
          calibration_note: calDraft.note,
          goal_score_final: calDraft.goal === "" ? null : Number(calDraft.goal),
          final_overall_score:
            calDraft.overall === "" ? null : Number(calDraft.overall),
          final_grade: calDraft.grade || null,
          competencies,
        })
      ).data;
    },
    onSuccess: (data) => qc.setQueryData(["eval", id], data),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const transitionM = useMutation({
    mutationFn: async (path: string) =>
      (await api.post(`/evaluations/${id}${path}`)).data,
    onSuccess: (data) => qc.setQueryData(["eval", id], data),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "전환 실패", { title: "오류" }),
  });

  if (!detail) {
    return (
      <>
        <DashboardHeader title="평가" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  const activeDims = dims.filter((d) => d.active);

  return (
    <>
      <DashboardHeader
        title={`평가 — ${detail.developer_name ?? "(이름 없음)"}`}
        actions={
          <Link
            href="/evaluations"
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            목록
          </Link>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto max-w-5xl">
        {/* 1. 상단 — status stepper. */}
        <section className="rounded-md border border-border bg-card p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm">
              <span className="font-semibold">
                {detail.developer_name ?? "—"}
              </span>
              <span className="text-muted-foreground ml-2">
                매니저 {detail.manager_name ?? "—"}
              </span>
            </div>
            {detail.final_grade && (
              <span
                className={
                  "inline-flex items-center justify-center w-10 h-10 rounded-md text-base font-bold " +
                  GRADE_COLOR[detail.final_grade]
                }
              >
                {detail.final_grade}
              </span>
            )}
          </div>
          <Stepper status={detail.status} />
          <div className="text-xs text-muted-foreground flex gap-4 flex-wrap">
            {detail.self_submitted_at && (
              <span>본인 제출 {fmtLocalDateTime(detail.self_submitted_at)}</span>
            )}
            {detail.manager_submitted_at && (
              <span>매니저 제출 {fmtLocalDateTime(detail.manager_submitted_at)}</span>
            )}
            {detail.finalized_at && (
              <span>공개 {fmtLocalDateTime(detail.finalized_at)}</span>
            )}
          </div>
          {/* stage 별 액션 버튼. */}
          <div className="flex gap-2 flex-wrap">
            {stage === "self" && (
              <>
                <button
                  type="button"
                  disabled={saveSelf.isPending}
                  onClick={() => saveSelf.mutate()}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> 저장
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await dialog.confirm(
                      "자기평가를 제출합니다. 매니저가 작성하기 전까지 재오픈 가능합니다.",
                      { title: "제출", confirmText: "제출" },
                    );
                    if (ok) {
                      await saveSelf.mutateAsync();
                      transitionM.mutate("/self/submit");
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
                >
                  <Check className="h-3.5 w-3.5" /> 제출
                </button>
              </>
            )}
            {stage === "manager" && (
              <>
                <button
                  type="button"
                  disabled={saveManager.isPending}
                  onClick={() => saveManager.mutate()}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> 저장
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await dialog.confirm(
                      "매니저 평가를 제출합니다. HR calibration 전까지 재오픈 가능합니다.",
                      { title: "제출", confirmText: "제출" },
                    );
                    if (ok) {
                      await saveManager.mutateAsync();
                      transitionM.mutate("/manager/submit");
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
                >
                  <Check className="h-3.5 w-3.5" /> 제출
                </button>
              </>
            )}
            {stage === "calibrate" && (
              <>
                <button
                  type="button"
                  disabled={saveCal.isPending}
                  onClick={() => saveCal.mutate()}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> 조정 저장
                </button>
                {detail.status === "CALIBRATED" && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await dialog.confirm(
                        "본인에게 평가를 공개합니다. 등급과 매니저 코멘트가 노출됩니다.",
                        { title: "공개", confirmText: "공개" },
                      );
                      if (ok) transitionM.mutate("/finalize");
                    }}
                    className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
                  >
                    <Check className="h-3.5 w-3.5" /> 본인 공개
                  </button>
                )}
              </>
            )}
            {/* reopen — 본인 / 매니저 자기 단계만. */}
            {detail.status === "SELF_SUBMITTED" && stage !== "manager" && (
              <button
                type="button"
                onClick={() => transitionM.mutate("/self/reopen")}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted"
              >
                <RotateCcw className="h-3.5 w-3.5" /> 자기평가 재오픈
              </button>
            )}
            {detail.status === "MGR_SUBMITTED" && stage === "manager" && (
              <button
                type="button"
                onClick={() => transitionM.mutate("/manager/reopen")}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted"
              >
                <RotateCcw className="h-3.5 w-3.5" /> 매니저평가 재오픈
              </button>
            )}
          </div>
        </section>

        {/* 2. 목표 달성도. */}
        <section className="rounded-md border border-border bg-card p-3">
          <h3 className="text-sm font-semibold mb-2">목표 달성도</h3>
          {detail.goal_summary && detail.goal_summary.count > 0 ? (
            <div className="text-xs text-muted-foreground mb-2">
              cycle 기간 PERSONAL 목표: {detail.goal_summary.count}건 ·
              완료 {detail.goal_summary.completed} ·
              평균 진행률 {detail.goal_summary.avg_progress}%
              <span className="ml-2 text-emerald-600">
                권장 prefill {detail.goal_summary.prefill_score}
              </span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic mb-2">
              cycle 기간의 PERSONAL 목표가 없습니다.
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 text-xs">
            <ScoreInput
              label="자기평가 점수 (1.0~5.0)"
              value={selfDraft.goal}
              disabled={stage !== "self"}
              onChange={(v) => setSelfDraft({ ...selfDraft, goal: v })}
            />
            <ScoreInput
              label="매니저 점수"
              value={mgrDraft.goal}
              disabled={stage !== "manager"}
              onChange={(v) => setMgrDraft({ ...mgrDraft, goal: v })}
            />
            <ScoreInput
              label="최종 점수"
              value={calDraft.goal}
              disabled={stage !== "calibrate"}
              onChange={(v) => setCalDraft({ ...calDraft, goal: v })}
            />
          </div>
        </section>

        {/* 3. 역량 평가 — dimension × {self|manager|final} 매트릭스. */}
        <section className="rounded-md border border-border bg-card">
          <header className="px-3 py-2 border-b border-border text-sm font-semibold">
            역량 평가 (1~5점, 빈칸 = N/A)
          </header>
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5 w-32">항목</th>
                <th className="text-left px-3 py-1.5 w-16">자기</th>
                <th className="text-left px-3 py-1.5">자기 코멘트</th>
                <th className="text-left px-3 py-1.5 w-16">매니저</th>
                <th className="text-left px-3 py-1.5">매니저 코멘트</th>
                <th className="text-left px-3 py-1.5 w-16">최종</th>
              </tr>
            </thead>
            <tbody>
              {activeDims.map((dim) => {
                const c =
                  compDraft[dim.key] ?? {
                    dimension_key: dim.key,
                    self_score: null,
                    manager_score: null,
                    final_score: null,
                    self_comment: null,
                    manager_comment: null,
                    final_comment: null,
                  };
                const upd = (next: Comp) =>
                  setCompDraft({ ...compDraft, [dim.key]: next });
                return (
                  <tr key={dim.key} className="border-t border-border/50">
                    <td className="px-3 py-1.5 font-medium" title={dim.description ?? ""}>
                      {dim.label}
                    </td>
                    <td className="px-3 py-1">
                      <ScoreCell
                        value={c.self_score}
                        disabled={stage !== "self"}
                        onChange={(v) => upd({ ...c, self_score: v })}
                      />
                    </td>
                    <td className="px-3 py-1 align-top">
                      {/* 6 라인 정도 입력 가능 — 평가 코멘트는 한 줄에 끝나는
                          내용이 아니라 textarea 로 충분한 공간 제공. */}
                      <textarea
                        value={c.self_comment ?? ""}
                        disabled={stage !== "self"}
                        onChange={(e) => upd({ ...c, self_comment: e.target.value || null })}
                        rows={6}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 resize-y disabled:bg-muted/30"
                      />
                    </td>
                    <td className="px-3 py-1">
                      <ScoreCell
                        value={c.manager_score}
                        disabled={stage !== "manager"}
                        onChange={(v) => upd({ ...c, manager_score: v })}
                      />
                    </td>
                    <td className="px-3 py-1 align-top">
                      <textarea
                        value={c.manager_comment ?? ""}
                        disabled={stage !== "manager"}
                        onChange={(e) => upd({ ...c, manager_comment: e.target.value || null })}
                        rows={6}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 resize-y disabled:bg-muted/30"
                      />
                    </td>
                    <td className="px-3 py-1">
                      <ScoreCell
                        value={c.final_score}
                        disabled={stage !== "calibrate"}
                        onChange={(v) => upd({ ...c, final_score: v })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/20 text-xs">
              <tr>
                <td className="px-3 py-1.5 text-muted-foreground">평균</td>
                <td className="px-3 py-1.5 tabular-nums">
                  {detail.competency_avg_self ?? "—"}
                </td>
                <td />
                <td className="px-3 py-1.5 tabular-nums">
                  {detail.competency_avg_manager ?? "—"}
                </td>
                <td />
                <td className="px-3 py-1.5 tabular-nums">
                  {detail.competency_avg_final ?? "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        {/* 4. 종합 의견 — TipTap 3 영역. */}
        <section className="rounded-md border border-border bg-card p-3 flex flex-col gap-3">
          <h3 className="text-sm font-semibold">종합 의견</h3>

          <NarrativeBlock
            label="자기평가"
            html={selfDraft.narrative}
            onChange={(v) => setSelfDraft({ ...selfDraft, narrative: v })}
            readOnly={stage !== "self"}
          />

          {/* 매니저 — 본인이 본인 평가 보면 FINALIZED 후만 나옴 (백엔드에서 None
              처리). detail.manager_narrative 이 있으면 viewer 로 표시. */}
          {(stage === "manager" || stage === "calibrate") ? (
            <NarrativeBlock
              label="매니저 평가"
              html={mgrDraft.narrative}
              onChange={(v) => setMgrDraft({ ...mgrDraft, narrative: v })}
              readOnly={stage !== "manager"}
            />
          ) : detail.manager_narrative ? (
            <div>
              <div className="text-xs text-muted-foreground mb-1">매니저 평가</div>
              <div className="rounded-md border border-border p-2 bg-muted/20">
                <TipTapViewer html={detail.manager_narrative} />
              </div>
            </div>
          ) : null}

          {stage === "calibrate" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <ScoreInput
                  label="최종 종합 점수 (1.0~5.0)"
                  value={String(calDraft.overall)}
                  disabled={false}
                  onChange={(v) => setCalDraft({ ...calDraft, overall: v })}
                />
                <label className="flex flex-col gap-0.5 text-xs">
                  <span className="text-muted-foreground">최종 등급</span>
                  <select
                    value={calDraft.grade}
                    onChange={(e) =>
                      setCalDraft({ ...calDraft, grade: e.target.value as Grade | "" })
                    }
                    className="h-7 rounded-md border border-input bg-background px-2"
                  >
                    <option value="">—</option>
                    <option value="S">S</option>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                    <option value="D">D</option>
                  </select>
                </label>
              </div>
              <NarrativeBlock
                label="HR 조정 메모 (본인·매니저 미노출)"
                html={calDraft.note}
                onChange={(v) => setCalDraft({ ...calDraft, note: v })}
                readOnly={false}
              />
            </>
          )}
        </section>
      </div>
    </>
  );
}

function Stepper({ status }: { status: EvalStatus }) {
  const idx = STATUS_ORDER.indexOf(status);
  return (
    <ol className="flex items-center gap-1 overflow-x-auto">
      {STATUS_ORDER.map((s, i) => {
        const reached = i <= idx;
        return (
          <li key={s} className="flex items-center gap-1 text-[11px]">
            <span
              className={
                "inline-flex items-center justify-center w-5 h-5 rounded-full border " +
                (reached
                  ? "bg-primary border-primary text-primary-foreground"
                  : "bg-background border-border text-muted-foreground")
              }
            >
              {i + 1}
            </span>
            <span className={reached ? "font-semibold" : "text-muted-foreground"}>
              {STATUS_LABEL[s]}
            </span>
            {i < STATUS_ORDER.length - 1 && (
              <span className="mx-1 text-muted-foreground">›</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ScoreInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string | number | null;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        step="0.1"
        min="1"
        max="5"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded-md border border-input bg-background px-2 disabled:bg-muted/30"
      />
    </label>
  );
}

function ScoreCell({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onChange: (v: number | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) =>
        onChange(e.target.value === "" ? null : Number(e.target.value))
      }
      className="h-7 w-full rounded-md border border-input bg-background px-1 disabled:bg-muted/30 text-center tabular-nums"
    >
      <option value="">—</option>
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="3">3</option>
      <option value="4">4</option>
      <option value="5">5</option>
    </select>
  );
}

function NarrativeBlock({
  label,
  html,
  onChange,
  readOnly,
}: {
  label: string;
  html: string;
  onChange: (v: string) => void;
  readOnly: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="rounded-md border border-input bg-background overflow-hidden">
        <TipTapEditor value={html} onChange={onChange} readOnly={readOnly} />
      </div>
    </div>
  );
}
