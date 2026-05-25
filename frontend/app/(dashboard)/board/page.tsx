"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ColDef } from "ag-grid-community";
import { Lock, Paperclip, Pin, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, DataGridHandle } from "@/components/data-grid/DataGrid";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";

type BoardPost = {
  id: string;
  title: string;
  author_id: string | null;
  author_name: string | null;
  is_pinned: boolean;
  visible_roles: string[] | null;
  view_count: number;
  attachment_count: number;
  created_at: string | null;
  updated_at: string | null;
};

// "관리자만 보기" — visible_roles = ["HR"] (HR + ADMIN + 작성자만 노출)
const isAdminOnly = (p: BoardPost): boolean =>
  (p.visible_roles?.length ?? 0) === 1 && p.visible_roles?.[0] === "HR";

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

export default function BoardListPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<BoardPost>>(null);

  const { data: me } = useQuery<{ id: string; role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  // "관리자만 제외" 토글은 ADMIN/HR 만 노출 — 일반 사용자는 visible_roles=["HR"]
  // 글이 애초에 응답에 안 오므로 토글 자체가 무의미. UI clutter 방지.
  const canSeeAdminOnlyToggle = me?.role === "ADMIN" || me?.role === "HR";

  const { data: posts = [] } = useQuery<BoardPost[]>({
    queryKey: ["board-posts"],
    queryFn: async () =>
      (await api.get("/board/posts", { params: { category: "BOARD" } })).data,
    staleTime: 0,
  });

  // "관리자만 제외" 체크박스 — visible_roles=["HR"] 인 글을 목록에서 숨김.
  // 사용자 선호는 localStorage 영속 (탭/세션 무관 동일 동작).
  const [excludeAdminOnly, setExcludeAdminOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("board-exclude-admin-only") === "1") {
      setExcludeAdminOnly(true);
    }
  }, []);
  function toggleExcludeAdminOnly(next: boolean) {
    setExcludeAdminOnly(next);
    try {
      window.localStorage.setItem(
        "board-exclude-admin-only",
        next ? "1" : "0",
      );
    } catch {
      /* localStorage 비허용 무시 */
    }
  }
  const visiblePosts = useMemo(
    () =>
      canSeeAdminOnlyToggle && excludeAdminOnly
        ? posts.filter((p) => !isAdminOnly(p))
        : posts,
    [posts, excludeAdminOnly, canSeeAdminOnlyToggle],
  );

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/board/posts/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board-posts"] }),
    onError: (e: any) => {
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "삭제 실패");
    },
  });

  const columnDefs = useMemo<ColDef<BoardPost>[]>(
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
            href={`/board/${p.data.id}`}
            onClick={(e) => {
              e.preventDefault();
              router.push(`/board/${p.data.id}`);
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
        field: "is_pinned",
        colId: "is_pinned_named",
        headerComponent: () => (
          <span className="inline-flex items-center gap-1">
            <Pin className="h-3 w-3" /> 고정
          </span>
        ),
        width: 80,
        maxWidth: 80,
        sortable: true,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellRenderer: (p: any) =>
          p.value ? (
            <Tooltip label="고정 글">
              <span className="text-amber-600 inline-flex">
                <Pin className="h-4 w-4" />
              </span>
            </Tooltip>
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
        colId: "admin_only",
        headerComponent: () => (
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" /> 관리자만
          </span>
        ),
        width: 100,
        maxWidth: 100,
        sortable: true,
        filter: false,
        headerClass: "ag-center-aligned-header",
        valueGetter: (p: any) => (p.data ? isAdminOnly(p.data) : false),
        cellRenderer: (p: any) =>
          p.value ? (
            <Tooltip label="HR/ADMIN/작성자만 보기">
              <span className="text-rose-600 inline-flex">
                <Lock className="h-4 w-4" />
              </span>
            </Tooltip>
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

  async function handleDelete(rows: BoardPost[]) {
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
      <DashboardHeader title="게시판" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<BoardPost>
          ref={gridRef}
          rowData={visiblePosts}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="제목, 작성자 검색"
          toolbarLeading={
            canSeeAdminOnlyToggle ? (
              <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                <input
                  type="checkbox"
                  checked={excludeAdminOnly}
                  onChange={(e) => toggleExcludeAdminOnly(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                <Lock className="h-3 w-3" />
                <span>'관리자만' 제외</span>
              </label>
            ) : null
          }
          onAdd={() => router.push("/board/new")}
          onDelete={handleDelete}
          onRowDoubleClicked={(row) => router.push(`/board/${row.id}`)}
        />
      </div>
    </>
  );
}
