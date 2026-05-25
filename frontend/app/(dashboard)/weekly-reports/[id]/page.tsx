"use client";

/**
 * 주간보고 — 편집 / 상세.
 *
 * 본문은 TipTap (게시판/공지/목표 와 동일 에디터). 작성은 본인만, 매니저·
 * 관리자는 읽기 전용.
 *
 * 5초 autosave (debounce). [제출] 클릭 시 status=SUBMITTED · submitted_at
 * 갱신. 제출 후에도 본인은 [재오픈] 으로 DRAFT 로 되돌릴 수 있음 (이력 미보존).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  History,
  Paperclip,
  Pencil,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { TipTapEditor, TipTapViewer } from "@/components/board/TipTapEditor";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { fmtLocalDateTime } from "@/lib/format";
import { Bell, MessageSquare } from "lucide-react";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";

type AttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

type ReportDetail = {
  id: string;
  developer_id: string;
  developer_name: string | null;
  iso_year: number;
  iso_week: number;
  week_start: string; // YYYY-MM-DD
  week_end: string;
  status: "DRAFT" | "SUBMITTED";
  submitted_at: string | null;
  body: string | null;
  plain_text: string | null;
  attachments: AttachmentRow[];
  can_edit: boolean;
  updated_at: string;
};

export default function WeeklyReportDetailPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const id = params?.id as string;

  const { data: row } = useQuery<ReportDetail>({
    queryKey: ["weekly-report", id],
    queryFn: async () => (await api.get(`/weekly-reports/${id}`)).data,
  });

  // 첨부 이름변경/삭제 권한 — ADMIN/HR/SUPER_ADMIN + 작성자 본인.
  // can_edit 은 본인(또는 SUPER_ADMIN) 이면 true 라 본인 케이스를 커버한다.
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const canModifyAttachment =
    me?.role === "SUPER_ADMIN" ||
    me?.role === "ADMIN" ||
    me?.role === "HR" ||
    !!row?.can_edit;

  const [draft, setDraft] = useState<string>("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const lastSavedRef = useRef<string>("");
  // 우측 "지난 보고" 패널 — 직전 N주 본인 보고서 read-only viewer.
  // 초기값 localStorage 영속 — 한 번 열어두면 다음 진입에도 유지.
  const [pastOpen, setPastOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("wrPastOpen") === "1";
    } catch {
      return false;
    }
  });
  // 우측 패널 폭 — 좌측 본문과의 경계 separator 드래그로 조정.
  // 범위 280~800px, localStorage 영속. drag 중에는 state 만 갱신하고
  // pointerup 시점에 한 번만 persist (rapid setItem 회피).
  const PAST_MIN = 280;
  const PAST_MAX = 800;
  const [pastWidth, setPastWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 380;
    try {
      const v = Number(localStorage.getItem("wrPastWidth"));
      if (Number.isFinite(v) && v >= 280 && v <= 800) return v;
    } catch {
      /* ignore */
    }
    return 380;
  });
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const dragWidthRef = useRef<number>(pastWidth);
  const onSeparatorPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const rect = splitContainerRef.current?.getBoundingClientRect();
      // 컨테이너 right - 마우스 X = 우측 패널이 차지해야 할 폭.
      const rightEdge = rect?.right ?? window.innerWidth;
      const onMove = (ev: PointerEvent) => {
        const w = Math.max(
          PAST_MIN,
          Math.min(PAST_MAX, Math.round(rightEdge - ev.clientX)),
        );
        dragWidthRef.current = w;
        setPastWidth(w);
      };
      const onUp = (ev: PointerEvent) => {
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        try {
          localStorage.setItem(
            "wrPastWidth",
            String(dragWidthRef.current),
          );
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );
  // 초기 로드 시 본문 셋업.
  useEffect(() => {
    if (row && lastSavedRef.current === "") {
      setDraft(row.body ?? "");
      lastSavedRef.current = row.body ?? "";
    }
  }, [row]);

  const saveBodyM = useMutation({
    mutationFn: async (body: string) =>
      (await api.patch(`/weekly-reports/${id}/body`, { body })).data as ReportDetail,
    onSuccess: (data) => {
      qc.setQueryData(["weekly-report", id], data);
      lastSavedRef.current = data.body ?? "";
      setSavedAt(data.updated_at);
    },
  });

  // 5초 debounce autosave.
  useEffect(() => {
    if (!row) return;
    if (!row.can_edit) return;
    if (draft === lastSavedRef.current) return;
    const t = setTimeout(() => saveBodyM.mutate(draft), 5_000);
    return () => clearTimeout(t);
  }, [draft, row]);

  const submitM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/weekly-reports/${id}/submit`)).data as ReportDetail,
    onSuccess: (data) => {
      qc.setQueryData(["weekly-report", id], data);
      qc.invalidateQueries({ queryKey: ["weekly-reports"] });
    },
  });
  const reopenM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/weekly-reports/${id}/reopen`)).data as ReportDetail,
    onSuccess: (data) => {
      qc.setQueryData(["weekly-report", id], data);
      qc.invalidateQueries({ queryKey: ["weekly-reports"] });
    },
  });
  // 양식 재적용 — DRAFT row 의 body 를 최신 양식으로 덮어씀.
  const reapplyM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/weekly-reports/${id}/reapply-template`)).data as ReportDetail,
    onSuccess: (data) => {
      qc.setQueryData(["weekly-report", id], data);
      // 본문 즉시 동기화 — autosave debounce 가 직전 draft 를 다시 저장하지
      // 않도록 lastSaved/draft 모두 갱신.
      lastSavedRef.current = data.body ?? "";
      setDraft(data.body ?? "");
      setSavedAt(data.updated_at);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "양식 재적용 실패", {
        title: "오류",
      }),
  });

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      return (
        await api.post(`/weekly-reports/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
      ).data as ReportDetail;
    },
    onSuccess: (data) => qc.setQueryData(["weekly-report", id], data),
  });
  const deleteAttM = useMutation({
    mutationFn: async (aid: string) =>
      api.delete(`/weekly-reports/attachments/${aid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["weekly-report", id] }),
  });
  // 파일명 변경 — DB file_name 만 update (디스크 파일은 그대로).
  const renameAttM = useMutation({
    mutationFn: async (vars: { aid: string; file_name: string }) =>
      (
        await api.patch(`/weekly-reports/attachments/${vars.aid}`, {
          file_name: vars.file_name,
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["weekly-report", id] }),
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "이름 변경 실패", {
        title: "오류",
      }),
  });
  // 다운로드 — JWT 가 쿠키지만 axios 인터셉터가 Bearer 헤더로 변환하므로
  // <a href> 직링크 대신 blob → object URL 패턴 사용.
  const downloadAtt = async (aid: string, filename: string) => {
    try {
      const res = await api.get(`/weekly-reports/attachments/${aid}`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e: any) {
      dialog.alert(e?.response?.data?.detail ?? "다운로드 실패", {
        title: "오류",
      });
    }
  };

  if (!row) {
    return (
      <>
        <DashboardHeader title="주간보고" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  const submitting = submitM.isPending || reopenM.isPending;
  const ws = new Date(row.week_start);
  const we = new Date(row.week_end);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const headerLabel =
    `${row.iso_year}-W${String(row.iso_week).padStart(2, "0")} ` +
    `(${fmt(ws)} ~ ${fmt(we)})`;

  return (
    <>
      <DashboardHeader
        title={`주간보고 — ${headerLabel}`}
        actions={
          <div className="flex gap-2 items-center">
            <span className="text-xs text-muted-foreground">
              작성자: <b>{row.developer_name ?? "-"}</b> ·
              상태:{" "}
              <span
                className={
                  "ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 border text-[11px] font-semibold " +
                  (row.status === "SUBMITTED"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-amber-300 bg-amber-50 text-amber-700")
                }
              >
                {row.status === "SUBMITTED" ? "제출 완료" : "작성중"}
              </span>
              {row.submitted_at && (
                <span className="ml-1 text-muted-foreground">
                  · 제출 {fmtLocalDateTime(row.submitted_at)}
                </span>
              )}
              {savedAt && (
                <span className="ml-1 text-emerald-600">
                  · 저장 {fmtLocalDateTime(savedAt)}
                </span>
              )}
            </span>
            {row.can_edit && row.status === "DRAFT" && (
              <button
                type="button"
                onClick={() => submitM.mutate()}
                disabled={submitting}
                className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                제출
              </button>
            )}
            {row.can_edit && row.status === "SUBMITTED" && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await dialog.confirm(
                    "재오픈 시 상태가 '작성중'으로 돌아갑니다. 진행할까요?",
                    { title: "재오픈", confirmText: "재오픈" },
                  );
                  if (ok) reopenM.mutate();
                }}
                disabled={submitting}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                재오픈
              </button>
            )}
            {row.can_edit && row.status === "DRAFT" && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await dialog.confirm(
                    "현재 본문이 최신 양식으로 대체됩니다. 본문 내용은 모두 사라지고 양식만 남습니다. 진행할까요?",
                    {
                      title: "양식 재적용",
                      destructive: true,
                      confirmText: "재적용",
                    },
                  );
                  if (ok) reapplyM.mutate();
                }}
                disabled={reapplyM.isPending}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
                title="현재 양식 (Settings > 주간보고) 으로 본문을 다시 채움"
              >
                <FileText className="h-3.5 w-3.5" />
                양식 재적용
              </button>
            )}
            {row.can_edit && (
              <button
                type="button"
                onClick={() => saveBodyM.mutate(draft)}
                disabled={saveBodyM.isPending || draft === lastSavedRef.current}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
                title="즉시 저장 (자동 저장: 5초 debounce)"
              >
                <Save className="h-3.5 w-3.5" />
                저장
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const next = !pastOpen;
                setPastOpen(next);
                try { localStorage.setItem("wrPastOpen", next ? "1" : "0"); } catch { /* ignore */ }
              }}
              className={
                "h-8 inline-flex items-center gap-1 rounded-md border px-3 text-sm " +
                (pastOpen
                  ? "border-primary text-primary bg-primary/5 hover:bg-primary/10"
                  : "border-border bg-background hover:bg-muted")
              }
              title="본인 직전 보고서 사이드 패널 토글"
            >
              <History className="h-3.5 w-3.5" />
              지난 보고
            </button>
            <Link
              href="/weekly-reports"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
          </div>
        }
      />

      <div
        ref={splitContainerRef}
        className="flex flex-1 min-h-0 overflow-hidden"
      >
        <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto min-w-0">
          <div className="rounded-md border border-border bg-card p-4">
            <TipTapEditor
              value={draft}
              onChange={setDraft}
              readOnly={!row.can_edit}
            />
          </div>

        {/* 첨부 */}
        <div className="rounded-md border border-border bg-card p-4 space-y-2">
          <div className="flex items-center gap-1 text-sm font-semibold">
            <Paperclip className="h-3.5 w-3.5" />
            첨부파일 ({row.attachments.length})
          </div>
          {row.can_edit && (
            <FileDropZone
              onFiles={(files) => uploadM.mutate(files)}
              disabled={uploadM.isPending}
              label="파일을 드래그하거나 클릭해서 선택"
            />
          )}
          {row.attachments.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">첨부 없음</div>
          ) : (
            <ul className="text-xs space-y-1">
              {row.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 border-b border-border/50 py-1"
                >
                  <span className="flex-1 truncate">{a.file_name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {a.size ? `${(a.size / 1024).toFixed(1)} KB` : "-"}
                  </span>
                  {/* 미리보기 — 모든 read 권한자. */}
                  <AttachmentPreviewButton
                    filename={a.file_name}
                    mime={a.mime_type}
                    downloadPath={`/weekly-reports/attachments/${a.id}`}
                  />
                  {/* 다운로드 — read 권한자 모두. (보고서를 열 수 있다는 건 이미
                      read 권한이 있다는 의미라 별도 가드 불필요.) */}
                  <button
                    type="button"
                    onClick={() => downloadAtt(a.id, a.file_name)}
                    className="text-muted-foreground hover:text-foreground"
                    title="다운로드"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  {/* 이름 변경 / 삭제 — ADMIN/HR + 본인. */}
                  {canModifyAttachment && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          const next = await dialog.prompt(
                            "새 파일명을 입력하세요.",
                            {
                              title: "파일명 변경",
                              defaultValue: a.file_name,
                              confirmText: "변경",
                            },
                          );
                          if (next && next.trim() && next.trim() !== a.file_name) {
                            renameAttM.mutate({ aid: a.id, file_name: next.trim() });
                          }
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        title="이름 변경"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await dialog.confirm(
                            `파일 [${a.file_name}] 을(를) 삭제할까요?`,
                            { title: "첨부 삭제", destructive: true, confirmText: "삭제" },
                          );
                          if (ok) deleteAttM.mutate(a.id);
                        }}
                        className="text-rose-500 hover:text-rose-600"
                        title="삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 코멘트 — SUBMITTED 상태에서만 노출. 본문 옆이 아니라 첨부 아래 */}
        {/* (피드백은 제출 후 활동이라 별도 영역으로 분리). */}
        {row.status === "SUBMITTED" && <CommentsSection reportId={id} />}
        </div>
        {pastOpen && (
          <>
            {/* 드래그 separator — 좌측 본문 / 우측 지난보고 폭 조정.
                cursor: col-resize + hover/active 시 brand color 띠. */}
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onSeparatorPointerDown}
              className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 active:bg-primary transition-colors"
              title="드래그하여 폭 조절"
            />
            <PastReportsPanel
              width={pastWidth}
              currentId={id}
              onPrepend={(html) => setDraft((prev) => `${html}\n${prev}`)}
              onAppend={(html) => setDraft((prev) => `${prev}\n${html}`)}
            />
          </>
        )}
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// 지난 보고 사이드 패널 — 본인의 직전 N주 보고서를 read-only viewer 로 미리보고
// "본문 가져오기" 로 현재 draft 의 앞/뒤에 prepend / append.
// 백엔드는 owner=me + include_body=true 로 한 번에 모두 받는다 (이미 기존
// 엔드포인트 활용).
// ---------------------------------------------------------------------------

type PastReportRow = {
  id: string;
  iso_year: number;
  iso_week: number;
  week_start: string;
  week_end: string;
  status: "DRAFT" | "SUBMITTED";
  submitted_at: string | null;
  body: string | null;
};

function PastReportsPanel({
  width,
  currentId,
  onPrepend,
  onAppend,
}: {
  width: number;
  currentId: string;
  onPrepend: (html: string) => void;
  onAppend: (html: string) => void;
}) {
  // 본인 보고서 — 최신순 → slice 후 sort 그대로 사용. 백엔드는 default 로
  // 최근→과거 정렬을 반환한다고 가정 (안전을 위해 클라이언트에서 한 번 더 sort).
  const { data = [], isLoading } = useQuery<PastReportRow[]>({
    queryKey: ["weekly-reports", "mine", "with-body"],
    queryFn: async () =>
      (
        await api.get(`/weekly-reports`, {
          params: { owner: "me", include_body: true },
        })
      ).data,
    staleTime: 60_000,
  });

  // 현재 보고서 제외 + 최신순 정렬 + 최대 6개.
  const rows = [...data]
    .filter((r) => r.id !== currentId)
    .sort((a, b) => {
      if (a.iso_year !== b.iso_year) return b.iso_year - a.iso_year;
      return b.iso_week - a.iso_week;
    })
    .slice(0, 6);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 첫 로드 시 자동으로 가장 최근 한 건 선택.
  useEffect(() => {
    if (selectedId == null && rows.length > 0) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const fmtRange = (r: PastReportRow) => {
    const ws = new Date(r.week_start);
    const we = new Date(r.week_end);
    const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    return `W${String(r.iso_week).padStart(2, "0")} (${f(ws)}~${f(we)})`;
  };

  return (
    <aside
      style={{ width }}
      className="shrink-0 border-l border-border bg-background flex flex-col min-h-0"
    >
      <div className="px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-1.5">
        <History className="h-3.5 w-3.5" />
        지난 보고 (본인)
        <span className="ml-1 text-muted-foreground font-normal">
          {rows.length}건
        </span>
      </div>
      {isLoading ? (
        <div className="p-3 text-xs text-muted-foreground">불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground italic">
          이전 주차 보고서가 없습니다.
        </div>
      ) : (
        <>
          {/* 목록 — 최근 6주 */}
          <ul className="border-b border-border max-h-44 overflow-auto">
            {rows.map((r) => {
              const active = r.id === selectedId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className={
                      "w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 " +
                      (active
                        ? "bg-primary/10 border-l-2 border-primary"
                        : "hover:bg-muted border-l-2 border-transparent")
                    }
                  >
                    <span className="tabular-nums font-medium">
                      {r.iso_year}-{fmtRange(r)}
                    </span>
                    <span
                      className={
                        "ml-auto inline-flex items-center rounded-full border px-1.5 text-[10px] " +
                        (r.status === "SUBMITTED"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                          : "border-amber-300 bg-amber-50 text-amber-700")
                      }
                    >
                      {r.status === "SUBMITTED" ? "제출" : "작성중"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {/* 본문 가져오기 — 현재 draft 의 앞/뒤에 삽입. 본문 자체는 read-only. */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
            <button
              type="button"
              disabled={!selected || !selected.body}
              onClick={() => selected?.body && onPrepend(selected.body)}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-40"
              title="현재 본문 맨 위에 삽입"
            >
              위에 삽입
            </button>
            <button
              type="button"
              disabled={!selected || !selected.body}
              onClick={() => selected?.body && onAppend(selected.body)}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-40"
              title="현재 본문 맨 아래에 삽입"
            >
              아래에 삽입
            </button>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {selected && selected.submitted_at
                ? `제출 ${fmtLocalDateTime(selected.submitted_at)}`
                : ""}
            </span>
          </div>
          {/* read-only viewer */}
          <div className="flex-1 overflow-auto p-3 text-sm">
            {selected ? (
              selected.body ? (
                <TipTapViewer html={selected.body} />
              ) : (
                <div className="text-xs text-muted-foreground italic">
                  본문이 비어 있습니다.
                </div>
              )
            ) : (
              <div className="text-xs text-muted-foreground italic">
                항목을 선택하세요.
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}


// ---------------------------------------------------------------------------
// 코멘트 섹션 — SUBMITTED 보고서에 작성. 작성 시 owner 에게 Slack/Mattermost
// DM 알림 (백엔드 weekly_report_notify). 본인 이 본인 보고서에 작성한 경우는
// self-notify 회피.
// ---------------------------------------------------------------------------

type Comment = {
  id: string;
  weekly_report_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
};

function CommentsSection({ reportId }: { reportId: string }) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const { data: comments = [], isLoading } = useQuery<Comment[]>({
    queryKey: ["weekly-report-comments", reportId],
    queryFn: async () =>
      (await api.get(`/weekly-reports/${reportId}/comments`)).data,
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["weekly-report-comments", reportId] });

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post(`/weekly-reports/${reportId}/comments`, { body: draft })).data,
    onSuccess: () => {
      setDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "작성 실패", { title: "오류" }),
  });

  const editM = useMutation({
    mutationFn: async (cid: string) =>
      (await api.patch(`/weekly-reports/${reportId}/comments/${cid}`, {
        body: editDraft,
      })).data,
    onSuccess: () => {
      setEditingId(null);
      setEditDraft("");
      refresh();
    },
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "수정 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (cid: string) =>
      api.delete(`/weekly-reports/${reportId}/comments/${cid}`),
    onSuccess: refresh,
    onError: (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "삭제 실패", { title: "오류" }),
  });

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
        <MessageSquare className="h-3.5 w-3.5" />
        코멘트
        <span className="text-xs text-muted-foreground ml-1 tabular-nums font-normal">
          {comments.length}
        </span>
      </h3>

      <div className="rounded-md border border-input bg-background overflow-hidden mb-3">
        <TipTapEditor
          value={draft}
          onChange={setDraft}
          placeholder="코멘트 작성... (제출 후 작성 시 본인에게 DM 알림이 발송됩니다)"
        />
      </div>
      <div className="flex justify-end mb-3">
        <button
          type="button"
          disabled={createM.isPending || !draft.trim() || draft === "<p></p>"}
          onClick={() => createM.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 h-8 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
        >
          작성
        </button>
      </div>

      {/* 알림 안내 */}
      <div className="rounded-md border border-border bg-muted/40 p-3 mb-3">
        <div className="flex items-center gap-1.5 mb-1">
          <Bell className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">알림 안내</span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          코멘트 작성 시 보고서 작성자에게 Slack/Mattermost DM 으로 본문이
          전송됩니다 (관리자 설정의 알림 채널 사용 · 본인이 본인 보고서에
          작성하면 발송하지 않음).
        </p>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      ) : comments.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">
          아직 코멘트가 없습니다.
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className="border border-border rounded-md p-3 bg-background"
            >
              <div className="flex items-center justify-between mb-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {c.author_name ?? "(작성자 없음)"}
                  </span>
                  <span className="text-muted-foreground">
                    {fmtLocalDateTime(c.created_at)}
                    {c.updated_at !== c.created_at && " · 수정됨"}
                  </span>
                </div>
                {c.can_edit && editingId !== c.id && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditDraft(c.body);
                      }}
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                    >
                      <Pencil className="h-3 w-3" /> 수정
                    </button>
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await dialog.confirm(
                          "이 코멘트를 삭제하시겠습니까?",
                          {
                            title: "코멘트 삭제",
                            confirmText: "삭제",
                            destructive: true,
                          },
                        );
                        if (ok) deleteM.mutate(c.id);
                      }}
                      className="text-muted-foreground hover:text-red-500 inline-flex items-center gap-0.5"
                    >
                      <Trash2 className="h-3 w-3" /> 삭제
                    </button>
                  </div>
                )}
              </div>
              {editingId === c.id ? (
                <>
                  <div className="rounded-md border border-input bg-background overflow-hidden">
                    <TipTapEditor value={editDraft} onChange={setEditDraft} />
                  </div>
                  <div className="flex justify-end gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setEditDraft("");
                      }}
                      className="rounded-md border border-input bg-background px-3 h-7 text-xs hover:bg-muted"
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      disabled={editM.isPending || !editDraft.trim()}
                      onClick={() => editM.mutate(c.id)}
                      className="rounded-md bg-primary px-3 h-7 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
                    >
                      저장
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-sm">
                  <TipTapViewer html={c.body} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
