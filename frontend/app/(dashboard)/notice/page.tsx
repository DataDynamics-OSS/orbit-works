"use client";

import { useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ColDef } from "ag-grid-community";
import { Paperclip, Pin, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, DataGridHandle } from "@/components/data-grid/DataGrid";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";

type NoticePost = {
  id: string;
  title: string;
  author_id: string | null;
  author_name: string | null;
  is_pinned: boolean;
  view_count: number;
  attachment_count: number;
  created_at: string | null;
  updated_at: string | null;
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export default function NoticeListPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<NoticePost>>(null);

  const { data: posts = [] } = useQuery<NoticePost[]>({
    queryKey: ["notice-posts"],
    queryFn: async () =>
      (await api.get("/board/posts", { params: { category: "NOTICE" } })).data,
    staleTime: 0,
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/board/posts/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notice-posts"] }),
    onError: (e: any) => {
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "삭제 실패");
    },
  });

  const columnDefs = useMemo<ColDef<NoticePost>[]>(
    () => [
      {
        field: "is_pinned",
        headerName: "",
        width: 44,
        maxWidth: 44,
        sortable: true,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) =>
          p.value ? (
            <Tooltip label="고정 글" side="right">
              <span className="text-amber-600 inline-flex">
                <Pin className="h-4 w-4" />
              </span>
            </Tooltip>
          ) : null,
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        field: "title",
        headerName: "제목",
        flex: 2,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) => (
          <a
            href={`/notice/${p.data.id}`}
            onClick={(e) => {
              e.preventDefault();
              router.push(`/notice/${p.data.id}`);
            }}
            className="text-primary hover:underline"
          >
            {p.value}
          </a>
        ),
      },
      {
        field: "author_name",
        headerName: "작성자",
        flex: 0.8,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        field: "attachment_count",
        headerName: "첨부",
        width: 80,
        maxWidth: 80,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) =>
          p.value > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Paperclip className="h-3 w-3" /> {p.value}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
        cellStyle: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        } as any,
      },
      {
        field: "view_count",
        headerName: "조회",
        width: 80,
        maxWidth: 80,
        headerClass: "ag-center-aligned-header",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "created_at",
        headerName: "작성일",
        flex: 0.8,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => fmtDate(p.value),
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "updated_at",
        headerName: "수정일",
        flex: 0.8,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => fmtDate(p.value),
        cellStyle: { textAlign: "center" } as any,
      },
    ],
    [router],
  );

  async function handleDelete(rows: NoticePost[]) {
    if (rows.length === 0) return;
    const ok = await dialog.confirm(
      `${rows.length}개 글을 삭제하시겠습니까? 첨부파일도 함께 삭제됩니다.`,
      { destructive: true },
    );
    if (ok) {
      await deleteM.mutateAsync(rows.map((r) => r.id));
      gridRef.current?.deselectAll();
    }
  }

  return (
    <>
      <DashboardHeader title="공지사항" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<NoticePost>
          ref={gridRef}
          rowData={posts}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="제목, 작성자 검색"
          onAdd={() => router.push("/notice/new")}
          onDelete={handleDelete}
          onRowDoubleClicked={(row) => router.push(`/notice/${row.id}`)}
        />
      </div>
    </>
  );
}
