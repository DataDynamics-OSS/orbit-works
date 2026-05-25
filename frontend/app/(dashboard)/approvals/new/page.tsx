"use client";

/**
 * 결재 신청서 작성.
 *
 * 흐름:
 *   1. 결재 종류 (kind) 선택  → 좌측 목록.
 *   2. 우측에 제목 + rjsf 폼 + 결재선 미리보기.
 *   3. 임시저장(DRAFT) 또는 제출(IN_PROGRESS).
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { ArrowLeft, FileText, Save, Send } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";

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
  { ssr: false, loading: () => <div className="text-xs text-muted-foreground">폼 로딩…</div> },
);

type Template = {
  id: string;
  kind: string;
  name: string;
  icon: string | null;
  form_schema: any;
  ui_schema: any | null;
  approval_rules: any;
  attachment_slots: {
    slots: Array<{
      slug: string;
      label: string;
      required?: boolean;
      description?: string;
    }>;
  } | null;
  version: number;
  description: string | null;
};

type PreviewStep = {
  step_no: number;
  step_name: string;
  approver_id: string | null;
  approver_name: string | null;
  approver_title: string | null;
};

type Preview = {
  matched_rule_name: string | null;
  steps: PreviewStep[];
  warnings: string[];
};

export default function ApprovalNewPage() {
  const router = useRouter();
  const dialog = useDialog();

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ["approval-templates", false],
    queryFn: async () => (await api.get("/approval-templates")).data,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && templates.length) setSelectedId(templates[0].id);
  }, [templates, selectedId]);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const [title, setTitle] = useState("");
  const [formData, setFormData] = useState<any>({});

  // 양식 변경 시 입력 초기화.
  useEffect(() => {
    setTitle("");
    setFormData({});
  }, [selectedId]);

  // 결재선 미리보기 — 폼 변경 시 디바운스 후 호출.
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    if (!selected) return;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.post("/approvals/preview", {
          template_id: selected.id,
          form_data: formData,
        });
        setPreview(r.data);
      } catch (e: any) {
        setPreview({
          matched_rule_name: null,
          steps: [],
          warnings: [e?.response?.data?.detail ?? "미리보기 실패"],
        });
      } finally {
        setPreviewLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [selected?.id, JSON.stringify(formData)]);   // eslint-disable-line react-hooks/exhaustive-deps

  const submitM = useMutation({
    mutationFn: async (vars: { submit: boolean }) => {
      if (!selected) throw new Error("양식을 선택하세요.");
      if (!title.trim()) throw new Error("제목을 입력하세요.");
      return (
        await api.post("/approvals", {
          template_id: selected.id,
          title: title.trim(),
          form_data: formData,
          submit: vars.submit,
        })
      ).data;
    },
    onSuccess: (d: any) => {
      router.push(`/approvals/${d.id}`);
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  return (
    <>
      <DashboardHeader title="결재 신청서 작성" />
      <div className="flex flex-1 flex-col gap-3 p-4 overflow-auto max-w-[68rem]">
        <Link
          href="/approvals"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 결재함으로
        </Link>

        <div className="grid grid-cols-[14rem_1fr] gap-4">
          <ul className="space-y-0.5 sticky top-0">
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
                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{t.name}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="space-y-3">
            {selected ? (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    제목
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={`${selected.name} 제목`}
                    className="mt-1 w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>

                <div className="rounded-lg border border-border bg-card p-4">
                  <Form
                    schema={selected.form_schema}
                    uiSchema={selected.ui_schema ?? {}}
                    formData={formData}
                    onChange={(e: any) => setFormData(e.formData)}
                    onSubmit={() => submitM.mutate({ submit: true })}
                  >
                    {/* 우리는 외부 버튼으로 제출 — 기본 submit 버튼 숨김. */}
                    <button type="submit" className="hidden" />
                  </Form>
                </div>

                <AttachmentSlotsHint template={selected} />

                <ChainPreview preview={preview} loading={previewLoading} />

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => submitM.mutate({ submit: false })}
                    disabled={submitM.isPending || !title.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-4 h-8 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" /> 임시저장
                  </button>
                  <button
                    type="button"
                    onClick={() => submitM.mutate({ submit: true })}
                    disabled={
                      submitM.isPending ||
                      !title.trim() ||
                      !preview ||
                      preview.steps.length === 0 ||
                      preview.steps.some((s) => !s.approver_id)
                    }
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" /> 제출
                  </button>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">왼쪽에서 결재 종류를 선택하세요.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function ChainPreview({
  preview,
  loading,
}: {
  preview: Preview | null;
  loading: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold">결재선 미리보기</h3>
        {preview?.matched_rule_name && (
          <span className="text-[10px] text-muted-foreground">
            룰: {preview.matched_rule_name}
          </span>
        )}
      </div>
      {loading ? (
        <div className="text-xs text-muted-foreground">계산 중…</div>
      ) : !preview ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : preview.steps.length === 0 ? (
        <div className="text-xs text-amber-700">
          매치되는 결재 룰이 없습니다 — 입력값을 다시 확인하세요.
        </div>
      ) : (
        <ol className="space-y-1.5">
          {preview.steps.map((s, idx) => (
            <li
              key={idx}
              className="flex items-center gap-2 text-xs bg-background rounded-md px-3 py-1.5 border border-border"
            >
              <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary text-[10px] text-primary-foreground tabular-nums">
                {s.step_no}
              </span>
              <span className="font-medium">{s.step_name}</span>
              <span className="text-muted-foreground">·</span>
              {s.approver_id ? (
                <span>
                  {s.approver_name}
                  {s.approver_title ? ` (${s.approver_title})` : ""}
                </span>
              ) : (
                <span className="text-red-500">결재자 미정</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {preview?.warnings.length ? (
        <ul className="mt-2 space-y-0.5">
          {preview.warnings.map((w, i) => (
            <li key={i} className="text-[10px] text-amber-700">
              ⚠ {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AttachmentSlotsHint({ template }: { template: Template }) {
  const slots = template.attachment_slots?.slots ?? [];
  if (slots.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <h3 className="text-sm font-semibold mb-1.5">첨부 안내</h3>
      <p className="text-xs text-muted-foreground mb-2">
        이 양식은 다음 첨부가 가능합니다. 임시저장 후 상세 화면에서 슬롯별로 업로드할 수 있습니다.
      </p>
      <ul className="space-y-1">
        {slots.map((s) => (
          <li key={s.slug} className="text-xs">
            <span className="font-medium">{s.label}</span>
            {s.required ? (
              <span className="ml-1 text-red-500 text-[10px]">필수</span>
            ) : (
              <span className="ml-1 text-muted-foreground text-[10px]">선택</span>
            )}
            {s.description && (
              <span className="ml-2 text-muted-foreground">— {s.description}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
