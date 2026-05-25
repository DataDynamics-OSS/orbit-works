"use client";

/**
 * 지식 베이스 (KB) — 목록 페이지.
 *
 * 두 종류 컨텐츠 통합:
 *  - DOC : 벤더 자료 (PDF·매뉴얼·release note). 본문 짧음, 첨부 중심.
 *  - KB  : 사내 트러블슈팅 노하우. TipTap 긴 본문, 부속 첨부.
 *
 * 그리드 + 상단 type 토글 (전체/DOC/KB) + 검색. "+ 신규" 다이얼로그는 제목·type
 * 만 받고 POST → 상세 페이지로 이동 (나머지 메타·본문·첨부는 상세에서).
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { BookOpen, FileText } from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { DataGrid } from "@/components/data-grid/DataGrid";

type KbType = "DOC" | "KB";

type KbRow = {
  id: string;
  title: string;
  type: KbType;
  vendor_name: string | null;
  product_name: string | null;
  version_name: string | null;
  category: string | null;
  tags: string[];
  resolved: boolean;
  visibility: "all" | "manager" | "admin";
  author_name: string | null;
  attachment_count: number;
  created_at: string;
  updated_at: string;
};

const TYPE_LABEL: Record<KbType, string> = {
  DOC: "벤더 자료",
  KB: "노하우",
};
const TYPE_COLOR: Record<KbType, string> = {
  DOC: "bg-blue-100 text-blue-700",
  KB: "bg-emerald-100 text-emerald-700",
};

export default function KbPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const [typeFilter, setTypeFilter] = useState<"" | KbType>("");
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const { data: rows = [] } = useQuery<KbRow[]>({
    queryKey: ["kb-entries", typeFilter, q],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (typeFilter) params.type = typeFilter;
      if (q.trim()) params.q = q.trim();
      return (await api.get("/kb-entries", { params })).data;
    },
  });

  const createM = useMutation({
    mutationFn: async (payload: { title: string; type: KbType }) =>
      (await api.post("/kb-entries", payload)).data as KbRow,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["kb-entries"] });
      setCreateOpen(false);
      router.push(`/kb/${created.id}`);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "생성 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/kb-entries/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb-entries"] }),
  });

  const columnDefs = useMemo<ColDef<KbRow>[]>(
    // 모든 헤더 가운데 정렬 — globals.css 의 .ag-header-center 활용.
    () => ([
      {
        field: "type",
        headerName: "구분",
        width: 90,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        valueFormatter: (p) => TYPE_LABEL[p.value as KbType] ?? "",
      },
      {
        field: "title",
        headerName: "제목",
        flex: 2,
        headerClass: "ag-header-center",
        // 제목 word wrap — 긴 제목도 자동 여러 줄.
        wrapText: true,
        autoHeight: true,
        cellStyle: { fontWeight: 500, lineHeight: "1.4" },
      },
      { field: "vendor_name", headerName: "벤더", width: 110, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" }, valueFormatter: (p) => p.value || "—" },
      { field: "product_name", headerName: "제품", width: 110, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" }, valueFormatter: (p) => p.value || "—" },
      // 폭은 명시되어 있으며, quartz 의 header separator 는 resizable 컬럼 사이
      // 에만 그려져 일관성 위해 resizable=true (default) 유지. 사용자가 drag
      // 안 하면 width 그대로.
      { field: "version_name", headerName: "버전", width: 70, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" }, valueFormatter: (p) => p.value || "—" },
      {
        field: "tags",
        headerName: "태그",
        width: 120,
        flex: 0,
        headerClass: "ag-header-center",
        autoHeight: true,
        cellStyle: { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", paddingTop: 4, paddingBottom: 4 },
        cellRenderer: (p: any) => {
          const tags: string[] = p.data?.tags ?? [];
          if (tags.length === 0) return "";
          return (
            <>
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-semibold leading-none"
                >
                  {t}
                </span>
              ))}
            </>
          );
        },
      },
      {
        field: "attachment_count",
        headerName: "첨부",
        width: 70,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        valueFormatter: (p) => (p.value ? String(p.value) : ""),
      },
      { field: "author_name", headerName: "작성자", width: 70, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" }, valueFormatter: (p) => p.value || "—" },
      {
        field: "updated_at",
        headerName: "수정일",
        width: 90,
        flex: 0,
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : ""),
      },
    ] as ColDef<KbRow>[]),
    [],
  );

  return (
    <>
      <DashboardHeader title="지식 베이스" />
      <div className="flex flex-1 min-h-0 flex-col gap-2 p-4">
        {/* type 토글 */}
        <div className="flex items-center gap-1 self-start">
          <TypeBtn active={typeFilter === ""} onClick={() => setTypeFilter("")}>
            전체
          </TypeBtn>
          <TypeBtn active={typeFilter === "DOC"} onClick={() => setTypeFilter("DOC")} icon={<FileText className="h-3.5 w-3.5" />}>
            벤더 자료
          </TypeBtn>
          <TypeBtn active={typeFilter === "KB"} onClick={() => setTypeFilter("KB")} icon={<BookOpen className="h-3.5 w-3.5" />}>
            노하우
          </TypeBtn>
        </div>

        {/* DataGrid 가 자체 flex flex-1 min-h-0 flex-col 이라 outer flex-col 의
            직접 자식으로 두면 viewport 끝까지 stretch. footer 의 pagination
            controls (page size 셀렉터·페이지 이동) 가 항상 노출됨. */}
        <DataGrid<KbRow>
          rowData={rows}
          columnDefs={columnDefs}
          onSearch={setQ}
          searchPlaceholder="제목·본문 검색"
          onAdd={() => setCreateOpen(true)}
          addLabel="추가"
          onDelete={(items) => {
            if (items.length === 0) return;
            dialog
              .confirm(`${items.length}건을 삭제하시겠습니까?`, {
                title: "삭제 확인",
                confirmText: "삭제",
                destructive: true,
              })
              .then((ok) => ok && deleteM.mutate(items.map((it) => it.id)));
          }}
          onRowClicked={(row) => router.push(`/kb/${row.id}`)}
          disableFilters
        />
      </div>

      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          submitting={createM.isPending}
          onSubmit={(p) => createM.mutate(p)}
        />
      )}
    </>
  );
}

function TypeBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-7 inline-flex items-center gap-1 rounded-md px-2.5 text-xs transition-colors " +
        (active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted")
      }
    >
      {icon}
      {children}
    </button>
  );
}

function CreateDialog({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (p: { title: string; type: KbType }) => void;
  submitting: boolean;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<KbType>("KB");
  return (
    <Dialog
      open
      onClose={onClose}
      title="새 KB 항목"
      width="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            disabled={!title.trim() || submitting}
            onClick={() => onSubmit({ title: title.trim(), type })}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {submitting ? "생성 중..." : "생성 후 상세로"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">제목 *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: CDP 7.1.9 설치 가이드 / Spark OOM 트러블슈팅"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">구분</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setType("KB")}
              className={
                "h-9 flex-1 rounded-md border text-sm transition-colors " +
                (type === "KB"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted")
              }
            >
              노하우 (사내 트러블슈팅)
            </button>
            <button
              type="button"
              onClick={() => setType("DOC")}
              className={
                "h-9 flex-1 rounded-md border text-sm transition-colors " +
                (type === "DOC"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted")
              }
            >
              벤더 자료
            </button>
          </div>
        </label>
        <p className="text-xs text-muted-foreground">
          나머지 메타(벤더·제품·태그·본문·첨부) 는 다음 상세 페이지에서 편집합니다.
        </p>
      </div>
    </Dialog>
  );
}
