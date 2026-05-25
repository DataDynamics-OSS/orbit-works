"use client";

/**
 * 특허 (Patents) — sidebar > 자원 > 특허.
 *
 * 권한: patents.manage (SALES + HR + ADMIN). 단순 관리용 — 프로젝트 연결·만료
 * 알림 X. 상태(FILED/REGISTERED) 수동 전환만.
 *
 * 상단 stat cards: 총 건수, 등록 건수, 출원 건수.
 * 행 더블클릭 → 편집 다이얼로그 (다중 첨부 드래그앤드롭, 이름 변경, 삭제).
 */

import { useMemo, useState } from "react";
import { ColDef, ICellRendererParams } from "ag-grid-community";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FileDown, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { downloadPatentsPdf } from "@/lib/patent-export";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { DateInput } from "@/components/ui/DateInput";

type PatentStatus = "FILED" | "REGISTERED";

type Attachment = {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size: number | null;
  created_at: string;
};

type Patent = {
  id: string;
  status: PatentStatus;
  title: string;
  application_no: string | null;
  patent_no: string | null;
  filed_date: string | null;
  registered_date: string | null;
  patent_holder: string | null;
  holder_address: string | null;
  inventors: string | null;
  inventor_address: string | null;
  country: string | null;
  memo: string | null;
  attachment_count: number;
  attachments: Attachment[];
  created_at: string;
  updated_at: string;
};

const STATUS_LABEL: Record<PatentStatus, string> = {
  FILED: "출원",
  REGISTERED: "등록",
};

const STATUS_BADGE: Record<PatentStatus, string> = {
  FILED: "bg-amber-100 text-amber-700 border-amber-200",
  REGISTERED: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

const BLANK_FORM: Partial<Patent> = {
  status: "FILED",
  title: "",
  application_no: "",
  patent_no: "",
  filed_date: null,
  registered_date: null,
  patent_holder: "",
  holder_address: "",
  inventors: "",
  inventor_address: "",
  country: "KR",
  memo: "",
};

export default function PatentsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [statusFilter, setStatusFilter] = useState<"" | PatentStatus>("");

  const { data: patents = [] } = useQuery<Patent[]>({
    queryKey: ["patents", statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (statusFilter) params.status_filter = statusFilter;
      return (await api.get("/patents", { params })).data;
    },
    staleTime: 10_000,
  });

  const stats = useMemo(() => {
    let registered = 0;
    let filed = 0;
    for (const p of patents) {
      if (p.status === "REGISTERED") registered += 1;
      if (p.status === "FILED") filed += 1;
    }
    return { total: patents.length, registered, filed };
  }, [patents]);

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Patent | null>(null);

  async function handleDelete(rows: Patent[]) {
    if (rows.length === 0) return;
    const ok = await dialog.confirm(
      `${rows.length}건의 특허를 삭제하시겠습니까?\n첨부 파일도 모두 함께 삭제됩니다.`,
      { title: "특허 삭제", destructive: true },
    );
    if (!ok) return;
    await Promise.all(rows.map((r) => api.delete(`/patents/${r.id}`)));
    qc.invalidateQueries({ queryKey: ["patents"] });
  }

  const columnDefs = useMemo<ColDef<Patent>[]>(
    () => [
      {
        field: "status",
        headerName: "상태",
        headerClass: "ag-header-center",
        width: 70,
        flex: 0,
        // 체크박스가 좌측에 고정되도록 셀은 좌측 정렬 유지하고,
        // cellRenderer 안에서 flex-grow + 가운데 정렬로 칩만 가운데 표시.
        cellRenderer: (p: any) => (
          <div className="flex-1 flex items-center justify-center">
            <span
              className={
                "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium " +
                STATUS_BADGE[p.value as PatentStatus]
              }
            >
              {STATUS_LABEL[p.value as PatentStatus]}
            </span>
          </div>
        ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
      {
        headerName: "번호",
        headerClass: "ag-header-center",
        // quickFilter 가 row 값을 추출할 수 있도록 valueGetter 명시 —
        // field/valueGetter 없는 cellRenderer-only 컬럼은 검색 대상에서 빠진다.
        valueGetter: (p) =>
          `${p.data?.patent_no ?? ""} ${p.data?.application_no ?? ""}`,
        cellRenderer: (p: ICellRendererParams<Patent>) => {
          const r = p.data;
          if (!r) return null;
          return (
            <div className="font-mono text-xs leading-tight py-1">
              {r.patent_no && <div>등 {r.patent_no}</div>}
              {r.application_no && (
                <div className="text-muted-foreground">출 {r.application_no}</div>
              )}
            </div>
          );
        },
        width: 140,
        flex: 0,
      },
      {
        field: "title",
        headerName: "발명의 명칭",
        headerClass: "ag-header-center",
        flex: 2,
        minWidth: 250,
        wrapText: true,
        autoHeight: true,
      },
      {
        field: "inventors",
        headerName: "발명자",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 70,
        flex: 0,
        valueFormatter: (p) => p.value ?? "—",
      },
      {
        field: "patent_holder",
        headerName: "특허권자",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 180,
        flex: 0,
        valueFormatter: (p) => p.value ?? "—",
      },
      {
        field: "country",
        headerName: "국가",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 60,
        flex: 0,
        valueFormatter: (p) => p.value ?? "—",
      },
      {
        field: "filed_date",
        headerName: "출원일",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 100,
        flex: 0,
        valueFormatter: (p) => p.value ?? "—",
      },
      {
        field: "registered_date",
        headerName: "등록일",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 100,
        flex: 0,
        valueFormatter: (p) => p.value ?? "—",
      },
      {
        field: "attachment_count",
        headerName: "첨부",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 60,
        flex: 0,
        valueFormatter: (p) => (p.value > 0 ? `📎 ${p.value}` : "—"),
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="특허" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="총 건수" value={stats.total} />
          <StatCard label="등록 건수" value={stats.registered} tone="emerald" />
          <StatCard label="출원 건수" value={stats.filed} tone="amber" />
        </div>

        <DataGrid<Patent>
          rowData={patents}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="명칭·번호·발명자·특허권자 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            // 명시적 width 가 있는 컬럼은 제외 (autoSize 가 덮어쓰지 않도록).
            colIds: [],
          }}
          onAdd={() => setAddOpen(true)}
          onDelete={handleDelete}
          onRowDoubleClicked={(row) => setEditTarget(row)}
          disableFilters
          extraActions={
            <>
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as "" | PatentStatus)
                }
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="">전체 상태</option>
                <option value="FILED">출원</option>
                <option value="REGISTERED">등록</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  downloadPatentsPdf(
                    patents,
                    statusFilter === "FILED"
                      ? "출원"
                      : statusFilter === "REGISTERED"
                        ? "등록"
                        : "전체",
                  )
                }
                disabled={patents.length === 0}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                <FileDown className="h-3.5 w-3.5" />
                PDF
              </button>
            </>
          }
        />
      </div>

      {addOpen && (
        <PatentFormDialog
          mode="add"
          initial={BLANK_FORM}
          onClose={() => setAddOpen(false)}
        />
      )}
      {editTarget && (
        <PatentFormDialog
          mode="edit"
          initial={editTarget}
          patentId={editTarget.id}
          onClose={() => setEditTarget(null)}
        />
      )}
    </>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber";
}) {
  const colorClass =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "amber"
        ? "text-amber-600"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={"text-2xl font-bold tabular-nums mt-0.5 " + colorClass}>
        {value.toLocaleString("ko-KR")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 등록·편집 다이얼로그
// ---------------------------------------------------------------------------

function PatentFormDialog({
  mode,
  initial,
  patentId,
  onClose,
}: {
  mode: "add" | "edit";
  initial: Partial<Patent>;
  patentId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [form, setForm] = useState<Partial<Patent>>(initial);
  const [error, setError] = useState<string | null>(null);

  // 편집 모드는 attachments 가 initial 에 들어오지만 추가 후 갱신을 위해 로컬 state.
  const [attachments, setAttachments] = useState<Attachment[]>(
    initial.attachments ?? [],
  );

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form.title || !form.title.trim()) {
        throw new Error("발명의 명칭은 필수입니다.");
      }
      const body = {
        ...form,
        title: form.title.trim(),
      };
      if (mode === "add") {
        const { data } = await api.post<Patent>("/patents", body);
        return data;
      }
      const { data } = await api.patch<Patent>(`/patents/${patentId}`, body);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patents"] });
      onClose();
    },
    onError: (e: any) => {
      setError(
        e?.response?.data?.detail ??
          (e instanceof Error ? e.message : "저장 실패"),
      );
    },
  });

  async function uploadFiles(files: File[]) {
    if (mode === "add") {
      setError("첨부는 먼저 저장 후 가능합니다.");
      return;
    }
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const { data } = await api.post<Attachment>(
          `/patents/${patentId}/attachments`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
        setAttachments((prev) => [...prev, data]);
      } catch (e: any) {
        setError(
          e?.response?.data?.detail ??
            (e instanceof Error ? e.message : "업로드 실패"),
        );
      }
    }
    qc.invalidateQueries({ queryKey: ["patents"] });
  }

  async function renameAttachment(att: Attachment) {
    const next = await dialog.prompt("새 파일명", {
      defaultValue: att.filename,
      title: "파일명 변경",
    });
    if (!next || next === att.filename) return;
    const { data } = await api.patch<Attachment>(
      `/patents/attachments/${att.id}`,
      { filename: next },
    );
    setAttachments((prev) => prev.map((a) => (a.id === att.id ? data : a)));
  }

  async function deleteAttachment(att: Attachment) {
    const ok = await dialog.confirm(`'${att.filename}' 을 삭제할까요?`, {
      destructive: true,
    });
    if (!ok) return;
    await api.delete(`/patents/attachments/${att.id}`);
    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    qc.invalidateQueries({ queryKey: ["patents"] });
  }

  async function downloadAttachment(att: Attachment) {
    const res = await api.get(
      `/patents/attachments/${att.id}/download`,
      { responseType: "blob" },
    );
    const url = window.URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.filename;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  const isRegistered = form.status === "REGISTERED";

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "add" ? "특허 등록" : "특허 수정"}
      width="max-w-3xl"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={saveM.isPending}
            onClick={() => saveM.mutate()}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saveM.isPending ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="상태">
          <div className="flex gap-1">
            {(["FILED", "REGISTERED"] as PatentStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setForm((p) => ({ ...p, status: s }))}
                className={
                  "h-9 px-3 rounded-md border text-sm flex-1 " +
                  (form.status === s
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background")
                }
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="국가">
          <input
            type="text"
            value={form.country ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, country: e.target.value }))
            }
            placeholder="KR / US / EP …"
            className={input}
          />
        </Field>

        <Field label="발명의 명칭" colSpan={2} required>
          <input
            type="text"
            value={form.title ?? ""}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            className={input}
            required
          />
        </Field>

        <Field label="출원번호">
          <input
            type="text"
            value={form.application_no ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, application_no: e.target.value }))
            }
            // 등록 상태에선 등록번호만 입력 — 출원번호 비활성.
            disabled={isRegistered}
            className={input + " font-mono"}
          />
        </Field>
        <Field label="특허번호 (등록번호)">
          <input
            type="text"
            value={form.patent_no ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, patent_no: e.target.value }))
            }
            // 출원 상태에선 등록번호 비활성.
            disabled={!isRegistered}
            className={input + " font-mono"}
          />
        </Field>

        <Field label="출원일">
          <DateInput
            value={form.filed_date ?? ""}
            onChange={(v) => setForm((p) => ({ ...p, filed_date: v || null }))}
            // 등록 상태에선 등록일만 입력 — 출원일 비활성.
            disabled={isRegistered}
          />
        </Field>
        <Field label="등록일">
          <DateInput
            value={form.registered_date ?? ""}
            onChange={(v) =>
              setForm((p) => ({ ...p, registered_date: v || null }))
            }
            disabled={!isRegistered}
          />
        </Field>

        <Field label="특허권자" colSpan={2}>
          <input
            type="text"
            value={form.patent_holder ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, patent_holder: e.target.value }))
            }
            placeholder="회사명 또는 개인명"
            className={input}
          />
        </Field>
        <Field label="특허권자 주소" colSpan={2}>
          <textarea
            value={form.holder_address ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, holder_address: e.target.value }))
            }
            rows={2}
            className={input}
          />
        </Field>

        <Field label="발명자" colSpan={2}>
          <input
            type="text"
            value={form.inventors ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, inventors: e.target.value }))
            }
            placeholder="홍길동, 김철수 (콤마 구분)"
            className={input}
          />
        </Field>
        <Field label="발명자 주소" colSpan={2}>
          <textarea
            value={form.inventor_address ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, inventor_address: e.target.value }))
            }
            rows={2}
            className={input}
          />
        </Field>

        <Field label="메모" colSpan={2}>
          <textarea
            value={form.memo ?? ""}
            onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
            rows={2}
            className={input}
          />
        </Field>

        {/* 첨부 — 편집 모드에서만 활성. 신규 등록은 저장 후 다시 열어야 첨부 가능 */}
        <Field label="첨부 파일" colSpan={2}>
          {mode === "edit" ? (
            <div className="space-y-2">
              <FileDropZone
                onFiles={uploadFiles}
                multiple
                label="특허 관련 서류를 끌어놓거나 클릭해서 선택"
              />
              {attachments.length > 0 && (
                <ul className="rounded-md border border-border bg-background divide-y divide-border">
                  {attachments.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm"
                    >
                      <button
                        type="button"
                        onClick={() => downloadAttachment(a)}
                        className="flex-1 text-left text-primary hover:underline truncate"
                        title="다운로드"
                      >
                        {a.filename}
                      </button>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {a.file_size != null
                          ? `${(a.file_size / 1024).toFixed(1)} KB`
                          : ""}
                      </span>
                      <AttachmentPreviewButton
                        filename={a.filename}
                        mime={a.mime_type}
                        downloadPath={`/patents/attachments/${a.id}/download`}
                      />
                      <button
                        type="button"
                        onClick={() => renameAttachment(a)}
                        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-muted"
                        title="이름 변경"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteAttachment(a)}
                        className="h-7 w-7 inline-flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
                        title="삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground p-3 rounded-md border border-dashed border-border">
              먼저 저장 후 다시 열어 첨부할 수 있습니다.
            </div>
          )}
        </Field>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-red-50 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
    </Dialog>
  );
}

const input =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed";

function Field({
  label,
  required,
  colSpan = 1,
  children,
}: {
  label: string;
  required?: boolean;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div className={colSpan === 2 ? "col-span-2" : ""}>
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
