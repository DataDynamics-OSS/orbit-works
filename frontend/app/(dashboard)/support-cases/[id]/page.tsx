"use client";

/**
 * 기술지원 케이스 상세 페이지.
 *
 * 목록 그리드에서 프로젝트 셀을 클릭하면 진입. support-logs 상세와 동일 패턴 —
 * 다이얼로그(편집 폼) 가 좁아 코멘트 관리가 답답하다는 피드백에 따라, 상세
 * 정보 + 코멘트 + 첨부를 풀 페이지에 넓게 펼쳐서 보여준다. 편집은 목록의
 * 더블클릭(다이얼로그) 으로.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Paperclip, Pencil, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { Tooltip } from "@/components/ui/Tooltip";
import { TipTapViewer } from "@/components/board/TipTapEditor";
import {
  CommentsBlock,
  type CommentRow,
} from "@/components/support/CommentsBlock";
import {
  SUPPORT_CASE_STATUS_LABEL,
  type SupportCaseStatus,
} from "@/lib/support-vendors";
import {
  SUPPORT_SEVERITY_CHIP_CLASS,
  SUPPORT_SEVERITY_DESCRIPTION,
  SUPPORT_SEVERITY_LABEL,
  type SupportSeverity,
} from "@/lib/support-severity";
import {
  SUPPORT_CASE_CATEGORY_LABEL,
  type SupportCaseCategory,
} from "@/lib/support-categories";

type AttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

type CaseDetail = {
  id: string;
  case_no: string | null;
  customer_id: string;
  project_id: string | null;
  sales_rep_developer_id: string | null;
  support_engineer_developer_id: string | null;
  vendor: string | null;
  products: { product: string | null; version: string | null }[];
  vendor_case_no: string | null;
  title: string;
  status: SupportCaseStatus;
  category: SupportCaseCategory;
  severity: SupportSeverity;
  body: string | null;
  customer_name: string | null;
  project_name: string | null;
  sales_rep_name: string | null;
  support_engineer_name: string | null;
  attachments: AttachmentRow[];
  comments: CommentRow[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
};

type Me = { id: string; role: string };

const STATUS_TONE: Record<SupportCaseStatus, string> = {
  OPEN: "border-blue-300 bg-blue-50 text-blue-700",
  IN_PROGRESS: "border-amber-300 bg-amber-50 text-amber-700",
  CLOSED: "border-slate-300 bg-slate-50 text-slate-700",
};

export default function SupportCaseDetailPage() {
  const params = useParams();
  // URL segment 는 UUID 또는 CASE-YYYY-NNN 둘 다 받음. 형식으로 분기.
  const ident = params?.id as string;
  const isCaseNo = /^CASE-\d{4}-\d{3,}$/.test(ident);
  const fetchUrl = isCaseNo
    ? `/support-cases/by-no/${ident}`
    : `/support-cases/${ident}`;
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: row } = useQuery<CaseDetail>({
    queryKey: ["support-case", ident],
    queryFn: async () => (await api.get(fetchUrl)).data,
  });
  // 서버 응답의 row.id (UUID) — 첨부/코멘트 sub 엔드포인트는 여전히 UUID 사용.
  const id = row?.id ?? "";
  const { data: me } = useQuery<Me>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      await api.post(`/support-cases/${id}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["support-case", ident] }),
  });

  // 상태 변경 — 종료/재오픈 버튼 + 인라인 드롭다운 양쪽에서 사용. 백엔드가
  // closed_at/closed_by 와 시스템 코멘트를 부수효과로 처리하므로 status 만 PATCH.
  const statusM = useMutation({
    mutationFn: async (next: SupportCaseStatus) => {
      await api.patch(`/support-cases/${id}`, { status: next });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["support-case", ident] });
      qc.invalidateQueries({ queryKey: ["support-cases"] });
      qc.invalidateQueries({ queryKey: ["support-cases-stats"] });
    },
  });

  async function handleClose() {
    const ok = await dialog.confirm("이 케이스를 종료하시겠습니까?");
    if (!ok) return;
    statusM.mutate("CLOSED");
  }
  async function handleReopen() {
    const ok = await dialog.confirm("종료된 케이스를 다시 열겠습니까? (처리중 상태로 전환됩니다.)");
    if (!ok) return;
    statusM.mutate("IN_PROGRESS");
  }

  async function downloadAttachment(att: AttachmentRow) {
    const res = await api.get(`/support-cases/${id}/attachments/${att.id}`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!row) {
    return (
      <>
        <DashboardHeader title="케이스 상세" />
        <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">불러오는 중...</div>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="케이스 상세"
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/support-cases"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
            {row.status !== "CLOSED" ? (
              <button
                type="button"
                onClick={handleClose}
                disabled={statusM.isPending}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                종료
              </button>
            ) : (
              <button
                type="button"
                onClick={handleReopen}
                disabled={statusM.isPending}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                다시 열기
              </button>
            )}
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {/* 기본 정보 카드 */}
        <div className="rounded-lg border border-border bg-card p-4 max-w-5xl">
          <h2 className="text-lg font-semibold text-foreground mb-3">
            {row.title}
          </h2>
          <div className="flex items-center gap-2 mb-3">
            {row.case_no && (
              <span className="inline-block px-2 py-0.5 rounded-md bg-muted text-xs font-mono tabular-nums text-foreground">
                {row.case_no}
              </span>
            )}
            {/* 상태 뱃지를 인라인 드롭다운으로 — 셋 중 자유 전환. PATCH 부수효과로
                closed_at/by + 시스템 코멘트가 백엔드에서 자동 처리됨. */}
            <select
              value={row.status}
              onChange={(e) => {
                const next = e.target.value as SupportCaseStatus;
                if (next !== row.status) statusM.mutate(next);
              }}
              disabled={statusM.isPending}
              className={
                "h-6 rounded-full border px-2 text-xs font-semibold appearance-none pr-6 bg-no-repeat bg-right cursor-pointer disabled:opacity-50 " +
                STATUS_TONE[row.status]
              }
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
                backgroundPosition: "right 4px center",
                backgroundSize: "10px 10px",
              }}
              aria-label="상태 변경"
            >
              <option value="OPEN">{SUPPORT_CASE_STATUS_LABEL.OPEN}</option>
              <option value="IN_PROGRESS">{SUPPORT_CASE_STATUS_LABEL.IN_PROGRESS}</option>
              <option value="CLOSED">{SUPPORT_CASE_STATUS_LABEL.CLOSED}</option>
            </select>
            {row.severity && (
              <Tooltip
                label={SUPPORT_SEVERITY_DESCRIPTION[row.severity]}
                side="bottom"
              >
                <span
                  className={
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold " +
                    (SUPPORT_SEVERITY_CHIP_CLASS[row.severity] ?? "")
                  }
                >
                  <span className="font-mono">{row.severity}</span>
                  <span>{SUPPORT_SEVERITY_LABEL[row.severity]}</span>
                </span>
              </Tooltip>
            )}
            {row.category && (
              <span className="inline-block px-2 py-0.5 rounded-full border border-slate-300 bg-slate-50 text-xs font-medium text-slate-700">
                {SUPPORT_CASE_CATEGORY_LABEL[row.category] ?? row.category}
              </span>
            )}
            {row.vendor_case_no && (
              <span className="text-xs text-muted-foreground tabular-nums">
                벤더 케이스 #{row.vendor_case_no}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <Field label="고객사" value={row.customer_name ?? "—"} />
            <Field label="프로젝트" value={row.project_name ?? "—"} />
            <Field
              label="벤더 / 제품"
              value={(() => {
                const prods = (row.products ?? [])
                  .map((p) =>
                    p.product
                      ? p.version
                        ? `${p.product} ${p.version}`
                        : p.product
                      : null,
                  )
                  .filter((x): x is string => !!x);
                const prodLabel = prods.length ? prods.join(", ") : "—";
                return `${row.vendor ?? "—"} / ${prodLabel}`;
              })()}
            />
            <Field label="영업대표" value={row.sales_rep_name ?? "—"} />
            <Field label="기술지원 담당자" value={row.support_engineer_name ?? "—"} />
            <Field label="등록일" value={row.created_at.slice(0, 10)} />
            {row.closed_at && (
              <Field
                label="종료"
                value={`${row.closed_at.slice(0, 10)}${
                  row.closed_by_name ? ` · ${row.closed_by_name}` : ""
                }`}
              />
            )}
          </div>

          {row.body && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="text-xs text-muted-foreground mb-1">케이스 세부 내용</div>
              <TipTapViewer html={row.body} />
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
          {row.attachments.length > 0 && (
            <ul className="mt-3 space-y-1">
              {row.attachments.map((a) => (
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
                    downloadPath={`/support-cases/${id}/attachments/${a.id}`}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const next = await dialog.prompt("파일 이름", {
                        defaultValue: a.file_name,
                      });
                      if (!next || !next.trim() || next === a.file_name) return;
                      await api.patch(`/support-cases/${id}/attachments/${a.id}`, {
                        file_name: next.trim(),
                      });
                      qc.invalidateQueries({ queryKey: ["support-case", ident] });
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
                      await api.delete(`/support-cases/${id}/attachments/${a.id}`);
                      qc.invalidateQueries({ queryKey: ["support-case", ident] });
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
            코멘트 ({row.comments.length})
          </h3>
          <CommentsBlock
            baseUrl="/support-cases"
            recordId={id}
            comments={row.comments}
            invalidateKey={["support-case", ident]}
            currentUserId={me?.id ?? null}
            currentUserRole={me?.role ?? null}
            tall
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
