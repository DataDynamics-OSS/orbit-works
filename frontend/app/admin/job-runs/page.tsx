"use client";

/**
 * 작업 이력 (Job Runs) — sidebar > 관리 > 작업 이력 (ADMIN 전용).
 *
 * 백엔드의 모든 백그라운드 job 실행 흔적을 통합 그리드로 노출.
 * - 스케줄러가 돌린 정기 작업 (FX·금리·주가·DB 백업·사업공고·세금계산서·일일알림)
 * - 사용자 수동 트리거 (알람 "지금 테스트 발송" 등)
 * - 향후 추가될 API 트리거
 *
 * 보존 14일, 매일 03:00 정리 cron 자동 실행.
 * 행 더블클릭으로 상세(extra/error_message) 다이얼로그.
 */

import { useMemo, useState } from "react";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type JobStatus = "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED";
type TriggeredBy = "SCHEDULER" | "MANUAL" | "API";

type JobRun = {
  id: string;
  job_name: string;
  job_kind: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  triggered_by: TriggeredBy;
  triggered_by_user_id: string | null;
  triggered_by_user_name: string | null;
  result_summary: string | null;
  error_message: string | null;
  extra: Record<string, unknown> | null;
};

const STATUS_LABEL: Record<JobStatus, string> = {
  RUNNING: "진행중",
  SUCCESS: "성공",
  FAILED: "실패",
  SKIPPED: "건너뜀",
};

const STATUS_BADGE: Record<JobStatus, string> = {
  RUNNING: "bg-blue-100 text-blue-700 border-blue-200",
  SUCCESS: "bg-emerald-100 text-emerald-700 border-emerald-200",
  FAILED: "bg-red-100 text-red-700 border-red-200",
  SKIPPED: "bg-slate-100 text-slate-600 border-slate-200",
};

const TRIGGER_LABEL: Record<TriggeredBy, string> = {
  SCHEDULER: "스케줄러",
  MANUAL: "수동",
  API: "API",
};

function fmtDateTime(s: string | null): string {
  if (!s) return "-";
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} 초`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)} 분`;
  return `${(min / 60).toFixed(1)} 시간`;
}

export default function JobRunsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [kindFilter, setKindFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "">("");
  const [days, setDays] = useState<number>(14);

  const [detail, setDetail] = useState<JobRun | null>(null);

  const { data: rows = [], refetch, isFetching } = useQuery<JobRun[]>({
    queryKey: ["job-runs", kindFilter, statusFilter, days],
    queryFn: async () => {
      const params: Record<string, string | number> = { days };
      if (kindFilter) params.kind = kindFilter;
      if (statusFilter) params.status = statusFilter;
      const { data } = await api.get("/job-runs", { params });
      return data;
    },
    refetchInterval: 30_000, // RUNNING 상태 진행 모니터용 30초 폴링.
    staleTime: 10_000,
  });

  // 그리드 표시되는 row 들에서 직접 추출한 unique kind 목록 — 필터 드롭다운용.
  const kinds = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.job_kind));
    return [...set].sort();
  }, [rows]);

  const cleanupMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.delete("/job-runs/cleanup", {
        params: { days: 14 },
      });
      return data as { deleted: number };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["job-runs"] });
      dialog.alert(
        `${data.deleted} 개의 오래된 작업 이력을 삭제했습니다.`,
        { title: "정리 완료" },
      );
    },
  });

  const columnDefs = useMemo<ColDef<JobRun>[]>(
    () => [
      {
        field: "started_at",
        headerName: "시작 시간",
        valueFormatter: (p) => fmtDateTime(p.value),
        sort: "desc",
      },
      {
        field: "finished_at",
        headerName: "종료 시간",
        valueFormatter: (p) => fmtDateTime(p.value),
      },
      { field: "job_name", headerName: "작업명", minWidth: 200 },
      { field: "job_kind", headerName: "종류", width: 170 },
      {
        field: "status",
        headerName: "상태",
        width: 110,
        cellRenderer: (p: any) => (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[p.value as JobStatus] ?? ""}`}
          >
            {STATUS_LABEL[p.value as JobStatus] ?? p.value}
          </span>
        ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
      {
        field: "duration_ms",
        headerName: "소요",
        width: 100,
        valueFormatter: (p) => fmtDuration(p.value),
      },
      {
        field: "triggered_by",
        headerName: "트리거",
        width: 100,
        valueFormatter: (p) =>
          TRIGGER_LABEL[p.value as TriggeredBy] ?? p.value,
      },
      {
        field: "triggered_by_user_name",
        headerName: "사용자",
        width: 120,
        valueFormatter: (p) => p.value ?? "-",
      },
      {
        field: "result_summary",
        headerName: "요약",
        flex: 1.5,
        minWidth: 250,
        valueFormatter: (p) => p.value ?? "-",
      },
    ],
    [],
  );

  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <h1 className="text-lg font-bold">작업 이력</h1>
      </div>
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted-foreground">기간</label>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value={1}>최근 1일</option>
            <option value={3}>최근 3일</option>
            <option value={7}>최근 7일</option>
            <option value={14}>최근 14일</option>
          </select>

          <label className="ml-2 text-sm text-muted-foreground">종류</label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">전체</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <label className="ml-2 text-sm text-muted-foreground">상태</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as JobStatus | "")}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">전체</option>
            <option value="RUNNING">진행중</option>
            <option value="SUCCESS">성공</option>
            <option value="FAILED">실패</option>
            <option value="SKIPPED">건너뜀</option>
          </select>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1 h-9 rounded-md border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              새로고침
            </button>
            <button
              type="button"
              onClick={async () => {
                const ok = await dialog.confirm(
                  "14일 이전 작업 이력을 모두 삭제할까요? 되돌릴 수 없습니다.",
                  { title: "정리", destructive: true },
                );
                if (ok) cleanupMutation.mutate();
              }}
              disabled={cleanupMutation.isPending}
              className="inline-flex items-center gap-1 h-9 rounded-md border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              오래된 항목 정리
            </button>
          </div>
        </div>

        <DataGrid<JobRun>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="작업명·종류·요약 검색"
          onRowDoubleClicked={(row) => setDetail(row)}
          enableCheckbox={false}
          compact
          disableFilters
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: ["started_at", "finished_at", "job_name"],
          }}
        />
      </div>

      <Dialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.job_name} (${detail.job_kind})` : ""}
        width="max-w-3xl"
      >
        {detail && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <Row label="상태">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[detail.status]}`}
                >
                  {STATUS_LABEL[detail.status]}
                </span>
              </Row>
              <Row label="트리거">
                {TRIGGER_LABEL[detail.triggered_by]}
                {detail.triggered_by_user_name
                  ? ` (${detail.triggered_by_user_name})`
                  : ""}
              </Row>
              <Row label="시작">{fmtDateTime(detail.started_at)}</Row>
              <Row label="종료">{fmtDateTime(detail.finished_at)}</Row>
              <Row label="소요">{fmtDuration(detail.duration_ms)}</Row>
            </div>

            {detail.result_summary && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  요약
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-2 whitespace-pre-wrap break-words">
                  {detail.result_summary}
                </div>
              </div>
            )}

            {detail.extra && Object.keys(detail.extra).length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  상세 (extra)
                </div>
                <pre className="rounded-md border border-border bg-muted/30 p-2 max-h-72 overflow-auto text-xs">
                  {JSON.stringify(detail.extra, null, 2)}
                </pre>
              </div>
            )}

            {detail.error_message && (
              <div>
                <div className="text-xs font-medium text-red-600 mb-1">
                  에러
                </div>
                <pre className="rounded-md border border-red-200 bg-red-50 p-2 max-h-72 overflow-auto text-xs text-red-900">
                  {detail.error_message}
                </pre>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-16 text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
