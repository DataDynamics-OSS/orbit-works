"use client";

/**
 * Settings → 결재 양식.
 *
 * 10종 결재 양식 (EXPENSE / LEAVE / BUSINESS_TRIP / ...) 의 form_schema /
 * ui_schema / approval_rules JSON 편집. 변경 즉시 version +1 (백엔드).
 *
 * 좌측: 양식 목록 (kind 별).
 * 우측: 선택한 양식의 JSON 편집 + rjsf 미리보기.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save } from "lucide-react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { useDialog } from "@/components/ui/DialogProvider";

// rjsf 는 브라우저 전용 (SSR 비호환 코드 포함). client-only dynamic import.
const Form = dynamic(
  async () => {
    const [{ default: FormCore }, { default: validator }, theme] = await Promise.all([
      import("@rjsf/core"),
      import("@rjsf/validator-ajv8"),
      import("@/components/approvals/RjsfTableTheme"),
    ]);
    function Bound(props: any) {
      return (
        <FormCore
          validator={validator}
          templates={theme.tableTemplates}
          widgets={theme.tableWidgets}
          {...props}
        />
      );
    }
    return { default: Bound };
  },
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">미리보기 로딩…</div> },
);

// Monaco editor — JSON 편집 (라인 번호 + 신택스 하이라이트). 브라우저 전용.
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="text-xs text-muted-foreground p-2">에디터 로딩…</div>
    ),
  },
);

type ApprovalTemplate = {
  id: string;
  kind: string;
  name: string;
  icon: string | null;
  form_schema: Record<string, unknown>;
  ui_schema: Record<string, unknown> | null;
  approval_rules: Record<string, unknown>;
  attachment_slots: Record<string, unknown> | null;
  version: number;
  is_active: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
};

const KIND_LABEL: Record<string, string> = {
  EXPENSE: "지출결의서",
  LEAVE: "휴가",
  BUSINESS_TRIP: "출장",
  PURCHASE: "물품 구매",
  REMOTE_WORK: "재택근무",
  OVERTIME: "야근/휴일근무",
  CARD_USAGE: "법인카드",
  SUBSCRIPTION: "구독",
  OUTSOURCING: "외주/용역",
  PERSONNEL: "인사",
  BIZ_HOSPITALITY: "접대",
  POC: "PoC 수행",
  ETC: "기타",
};

export function ApprovalTemplatesTab() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: templates = [] } = useQuery<ApprovalTemplate[]>({
    queryKey: ["approval-templates", true],
    queryFn: async () =>
      (await api.get("/approval-templates", { params: { include_inactive: true } })).data,
  });

  // 첫 row 자동 선택.
  useEffect(() => {
    if (!selectedId && templates.length > 0) {
      setSelectedId(templates[0].id);
    }
  }, [templates, selectedId]);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const reseedM = useMutation({
    mutationFn: async () => (await api.post("/approval-templates/seed")).data,
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ["approval-templates"] });
      dialog.alert(`신규 ${d.inserted ?? 0}건 추가됨 (총 시드 ${d.total_in_seed ?? "?"}개).`, {
        title: "기본 시드 적용 완료",
      });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "시드 실패", { title: "오류" }),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold">결재 양식</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            JSON Schema (양식 필드) + UI Schema (위젯 힌트) + 결재 룰 (단계별 결재자) 직접 편집.
            저장 시 version 자동 +1, 진행중 결재는 옛 버전 그대로 유지됩니다.
          </p>
        </div>
        <button
          type="button"
          onClick={() => reseedM.mutate()}
          disabled={reseedM.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-xs hover:bg-muted disabled:opacity-50"
          title="시드 JSON 의 누락 양식만 추가합니다 (기존 양식은 보존)."
        >
          <RefreshCw className="h-3.5 w-3.5" />
          기본 시드 적용
        </button>
      </div>

      <div className="grid grid-cols-[14rem_1fr] gap-3 flex-1 min-h-0">
        <ul className="space-y-0.5 overflow-y-auto pr-1">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={
                  "w-full text-left rounded-md px-2.5 py-1.5 text-sm transition-colors " +
                  (selectedId === t.id
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{t.name}</span>
                  <span
                    className={
                      "text-[10px] tabular-nums " +
                      (selectedId === t.id ? "opacity-80" : "text-muted-foreground")
                    }
                  >
                    v{t.version}
                  </span>
                </div>
                <div
                  className={
                    "text-[10px] " +
                    (selectedId === t.id ? "opacity-80" : "text-muted-foreground")
                  }
                >
                  {KIND_LABEL[t.kind] ?? t.kind}
                  {!t.is_active && " · 비활성"}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div className="overflow-y-auto pr-1 min-h-0">
          {selected ? (
            <TemplateEditor key={selected.id} template={selected} />
          ) : (
            <div className="text-sm text-muted-foreground">왼쪽에서 양식을 선택하세요.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor — JSON textarea + rjsf 미리보기
// ---------------------------------------------------------------------------

type EditorState = {
  name: string;
  description: string;
  is_active: boolean;
  form_schema_text: string;
  ui_schema_text: string;
  approval_rules_text: string;
  attachment_slots_text: string;
};

function buildState(t: ApprovalTemplate): EditorState {
  return {
    name: t.name,
    description: t.description ?? "",
    is_active: t.is_active,
    form_schema_text: JSON.stringify(t.form_schema ?? {}, null, 2),
    ui_schema_text: JSON.stringify(t.ui_schema ?? {}, null, 2),
    approval_rules_text: JSON.stringify(t.approval_rules ?? {}, null, 2),
    attachment_slots_text: JSON.stringify(t.attachment_slots ?? {}, null, 2),
  };
}

function tryParse(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "JSON 파싱 실패" };
  }
}

function TemplateEditor({ template }: { template: ApprovalTemplate }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [state, setState] = useState<EditorState>(() => buildState(template));
  const [previewData, setPreviewData] = useState<unknown>({});

  // 양식 변경 시 state 리셋.
  useEffect(() => {
    setState(buildState(template));
    setPreviewData({});
  }, [template.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const formSchemaParsed = useMemo(
    () => tryParse(state.form_schema_text),
    [state.form_schema_text],
  );
  const uiSchemaParsed = useMemo(
    () => tryParse(state.ui_schema_text),
    [state.ui_schema_text],
  );
  const rulesParsed = useMemo(
    () => tryParse(state.approval_rules_text),
    [state.approval_rules_text],
  );
  const slotsParsed = useMemo(
    () => tryParse(state.attachment_slots_text),
    [state.attachment_slots_text],
  );

  const allValid =
    formSchemaParsed.ok && uiSchemaParsed.ok && rulesParsed.ok && slotsParsed.ok;

  const dirty =
    state.name !== template.name ||
    state.description !== (template.description ?? "") ||
    state.is_active !== template.is_active ||
    state.form_schema_text !== JSON.stringify(template.form_schema ?? {}, null, 2) ||
    state.ui_schema_text !== JSON.stringify(template.ui_schema ?? {}, null, 2) ||
    state.approval_rules_text !== JSON.stringify(template.approval_rules ?? {}, null, 2) ||
    state.attachment_slots_text !== JSON.stringify(template.attachment_slots ?? {}, null, 2);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!allValid) throw new Error("JSON 형식 오류");
      const slotsValue = (slotsParsed as any).value;
      // 빈 객체는 NULL 로 (DB 에 빈 객체 보다 NULL 이 의미상 명확).
      const slotsClean =
        slotsValue && Object.keys(slotsValue).length > 0 ? slotsValue : null;
      const body: any = {
        name: state.name,
        description: state.description || null,
        is_active: state.is_active,
        form_schema: (formSchemaParsed as any).value,
        ui_schema: (uiSchemaParsed as any).value,
        approval_rules: (rulesParsed as any).value,
        attachment_slots: slotsClean,
      };
      return (await api.patch(`/approval-templates/${template.id}`, body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approval-templates"] });
      dialog.alert("저장 완료. version 이 자동 증가했습니다.", { title: "완료" });
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  function format(field: keyof EditorState) {
    const text = state[field] as string;
    const r = tryParse(text);
    if (!r.ok) {
      dialog.alert(r.error, { title: "JSON 파싱 오류" });
      return;
    }
    setState({ ...state, [field]: JSON.stringify(r.value, null, 2) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 shrink-0">
        <div className="col-span-2 grid grid-cols-[1fr_auto_auto] gap-2 items-center">
          <input
            type="text"
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value })}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            placeholder="양식 이름"
          />
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={state.is_active}
              onChange={(e) => setState({ ...state, is_active: e.target.checked })}
            />
            활성
          </label>
          <button
            type="button"
            disabled={!dirty || !allValid || saveM.isPending}
            onClick={() => saveM.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            저장
            {dirty ? " *" : ""}
          </button>
        </div>
        <input
          type="text"
          value={state.description}
          onChange={(e) => setState({ ...state, description: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs col-span-2"
          placeholder="설명 (선택)"
        />
      </div>

      {/* 4개 JSON 편집기 — 세로 스택. 각 18rem 고정. 부모가 overflow-y-auto 라 자연스레 스크롤. */}
      <JsonField
        label="form_schema (JSON Schema)"
        hint="rjsf 가 그대로 렌더링하는 필드 정의. 표준 Draft 7."
        value={state.form_schema_text}
        onChange={(v) => setState({ ...state, form_schema_text: v })}
        onFormat={() => format("form_schema_text")}
        error={formSchemaParsed.ok ? null : formSchemaParsed.error}
      />

      <JsonField
        label="ui_schema (rjsf UI 힌트)"
        hint="필드별 위젯/숨김/순서 등. 빈 객체 가능."
        value={state.ui_schema_text}
        onChange={(v) => setState({ ...state, ui_schema_text: v })}
        onFormat={() => format("ui_schema_text")}
        error={uiSchemaParsed.ok ? null : uiSchemaParsed.error}
      />

      <JsonField
        label="approval_rules (결재선 룰)"
        hint='{ "rules": [ { "name": ..., "when": {...}, "approvers": [...] } ] }'
        value={state.approval_rules_text}
        onChange={(v) => setState({ ...state, approval_rules_text: v })}
        onFormat={() => format("approval_rules_text")}
        error={rulesParsed.ok ? null : rulesParsed.error}
      />

      <JsonField
        label="attachment_slots (첨부 슬롯)"
        hint='{ "slots": [ { "slug": "quote", "label": "견적서", "required": false } ] }'
        value={state.attachment_slots_text}
        onChange={(v) => setState({ ...state, attachment_slots_text: v })}
        onFormat={() => format("attachment_slots_text")}
        error={slotsParsed.ok ? null : slotsParsed.error}
      />

      {/* 미리보기 — form_schema 가 valid 일 때만 */}
      {formSchemaParsed.ok && (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs font-medium mb-2 text-muted-foreground">
            폼 미리보기 (rjsf)
          </div>
          <div className="text-sm">
            <Form
              schema={(formSchemaParsed as any).value}
              uiSchema={uiSchemaParsed.ok ? (uiSchemaParsed as any).value : {}}
              formData={previewData}
              onChange={(e: any) => setPreviewData(e.formData)}
              onSubmit={() => {
                /* preview only */
              }}
            >
              <button type="submit" className="hidden" />
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}

function JsonField({
  label,
  hint,
  value,
  onChange,
  onFormat,
  error,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onFormat: () => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <div className="min-w-0">
          <span className="text-xs font-medium">{label}</span>
          {hint && (
            <span className="text-[10px] text-muted-foreground ml-2">{hint}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onFormat}
          className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
        >
          정렬
        </button>
      </div>
      <div
        className={
          "w-full h-72 rounded-md border bg-background overflow-hidden " +
          (error ? "border-red-500" : "border-input")
        }
      >
        <MonacoEditor
          height="100%"
          defaultLanguage="json"
          theme="vs"
          value={value}
          onChange={(v) => onChange(v ?? "")}
          options={{
            minimap: { enabled: false },
            lineNumbers: "on",
            fontSize: 13,
            fontFamily: '"D2Coding", ui-monospace, Menlo, Consolas, monospace',
            fontLigatures: false,
            tabSize: 2,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: "line",
            folding: true,
            formatOnPaste: true,
            formatOnType: true,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </div>
      {error && <div className="text-[10px] text-red-500 mt-0.5">{error}</div>}
    </div>
  );
}
