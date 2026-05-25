"use client";

/**
 * 기술지원 활동 로그 상세 페이지.
 *
 * 목록 그리드에서 프로젝트 셀을 클릭하면 진입. 다이얼로그(편집 폼) 가 좁아
 * 코멘트 관리가 답답하다는 피드백에 따라, 상세 정보 + 코멘트 + 첨부를 풀
 * 페이지에 넓게 펼쳐서 보여준다. 편집은 목록의 더블클릭(다이얼로그) 으로.
 */

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Paperclip, Pencil, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { TipTapViewer } from "@/components/board/TipTapEditor";
import {
  CommentsBlock,
  type CommentRow,
} from "@/components/support/CommentsBlock";
import { formatDurationMinutes } from "@/lib/support-vendors";

type AttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

type LogDetail = {
  id: string;
  customer_id: string;
  project_id: string | null;
  sales_rep_developer_id: string | null;
  support_engineer_developer_id: string | null;
  start_date: string;
  end_date: string;
  duration_minutes: number;
  vendor: string | null;
  products: { product: string | null; version: string | null }[];
  body: string | null;
  customer_name: string | null;
  project_name: string | null;
  sales_rep_name: string | null;
  support_engineer_name: string | null;
  attachments: AttachmentRow[];
  comments: CommentRow[];
  created_at: string;
  updated_at: string;
};

type Me = { id: string; role: string };

export default function SupportLogDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: log } = useQuery<LogDetail>({
    queryKey: ["support-log", id],
    queryFn: async () => (await api.get(`/support-logs/${id}`)).data,
  });
  const { data: me } = useQuery<Me>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });

  // 첨부 — 상세 화면에서 직접 추가/이름변경/삭제 가능.
  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      await api.post(`/support-logs/${id}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["support-log", id] }),
  });

  async function downloadAttachment(att: AttachmentRow) {
    const res = await api.get(`/support-logs/${id}/attachments/${att.id}`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!log) {
    return (
      <>
        <DashboardHeader title="기술지원 상세" />
        <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">불러오는 중...</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="기술지원 상세"
        actions={
          <Link
            href="/support-logs"
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            목록
          </Link>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {/* 기본 정보 카드 */}
        <div className="rounded-lg border border-border bg-card p-4 max-w-5xl">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <Field label="고객사" value={log.customer_name ?? "—"} />
            <Field label="프로젝트" value={log.project_name ?? "—"} />
            <Field
              label="기간 / 소요시간"
              value={`${log.start_date} ~ ${log.end_date} · ${
                formatDurationMinutes(log.duration_minutes) || "—"
              }`}
            />
            <Field label="영업대표" value={log.sales_rep_name ?? "—"} />
            <Field label="기술지원 담당자" value={log.support_engineer_name ?? "—"} />
            <Field
              label="벤더 / 제품"
              value={(() => {
                const prods = (log.products ?? [])
                  .map((p) =>
                    p.product
                      ? p.version
                        ? `${p.product} ${p.version}`
                        : p.product
                      : null,
                  )
                  .filter((x): x is string => !!x);
                const prodLabel = prods.length ? prods.join(", ") : "—";
                return `${log.vendor ?? "—"} / ${prodLabel}`;
              })()}
            />
          </div>

          {log.body && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="text-xs text-muted-foreground mb-1">기술지원 세부 내용</div>
              <div className="text-sm leading-relaxed">
                <TipTapViewer html={log.body} />
              </div>
            </div>
          )}
        </div>

        {/* 첨부파일 */}
        <div className="rounded-lg border border-border bg-card p-4 max-w-5xl">
          <h3 className="text-base font-semibold mb-3">첨부파일</h3>
          <FileDropZone
            multiple
            label="파일을 끌어놓거나 클릭해서 선택"
            onFiles={(files) => uploadM.mutate(files)}
          />
          {log.attachments.length > 0 && (
            <ul className="mt-3 space-y-1">
              {log.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 text-sm border-b border-border/50 py-1.5"
                >
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <button
                    type="button"
                    onClick={() => downloadAttachment(a)}
                    className="flex-1 truncate text-left text-primary hover:underline"
                  >
                    {a.file_name}
                  </button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {a.size ? `${(a.size / 1024).toFixed(1)} KB` : ""}
                  </span>
                  <AttachmentPreviewButton
                    filename={a.file_name}
                    mime={a.mime_type ?? null}
                    downloadPath={`/support-logs/${id}/attachments/${a.id}`}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const next = await dialog.prompt("파일 이름", {
                        defaultValue: a.file_name,
                      });
                      if (!next || !next.trim() || next === a.file_name) return;
                      await api.patch(`/support-logs/${id}/attachments/${a.id}`, {
                        file_name: next.trim(),
                      });
                      qc.invalidateQueries({ queryKey: ["support-log", id] });
                    }}
                    className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                  >
                    <Pencil className="h-3 w-3" /> 이름
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await dialog.confirm("이 첨부를 삭제하시겠습니까?", {
                        destructive: true,
                      });
                      if (!ok) return;
                      await api.delete(`/support-logs/${id}/attachments/${a.id}`);
                      qc.invalidateQueries({ queryKey: ["support-log", id] });
                    }}
                    className="text-xs text-destructive hover:underline inline-flex items-center gap-0.5"
                  >
                    <X className="h-3 w-3" /> 삭제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 코멘트 — 풀 사이즈 */}
        <div className="rounded-lg border border-border bg-card p-4 max-w-5xl">
          <h3 className="text-base font-semibold mb-3">
            코멘트 ({log.comments.length})
          </h3>
          <CommentsBlock
            baseUrl="/support-logs"
            recordId={id}
            comments={log.comments}
            invalidateKey={["support-log", id]}
            currentUserId={me?.id ?? null}
            currentUserRole={me?.role ?? null}
            showDurationMinutes
          />
        </div>
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}
