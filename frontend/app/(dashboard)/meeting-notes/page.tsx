"use client";

/**
 * 회의록 목록 (sidebar > 개요 > 회의록).
 *
 * Grid: 작은 글꼴 (text-xs) + DataGrid. 행 클릭 시 상세로 이동.
 * "+ 새 회의록" 모달에서 고객사/프로젝트/제목/공유직원 입력 후 저장 → 상세로 이동.
 *
 * 권한:
 * - 목록: 내가 작성했거나 공유받은 회의록만.
 * - 작성: 매핑된 직원이 있어야 함 (User.mapped_developer_id).
 *
 * 알림:
 * - 공유받은 직원에게 Slack/Mattermost DM 자동 발송 (제목·작성자·링크).
 *   각 직원의 personal_email 우선, 없으면 company_email 사용 (notify provider 가
 *   이메일 → user_id 해석).
 */

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, type DataGridHandle } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { TabBar, TabItem } from "@/components/ui/TabBar";
import { useDialog } from "@/components/ui/DialogProvider";
import { sortDevelopersKo } from "@/lib/sort-developers";
import { SharePicker } from "@/components/meeting-notes/SharePicker";

type MeetingRow = {
  id: string;
  title: string;
  customer_id: string | null;
  customer_name: string | null;
  project_id: string | null;
  project_name: string | null;
  author_id: string | null;
  author_name: string | null;
  share_count: number;
  attachment_count: number;
  action_count: number;
  has_mindmap: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
};

type CustomerLite = { id: string; name: string };
type ProjectLite = { id: string; name: string; customer_id?: string | null };
type DevLite = {
  id: string;
  name: string;
  title?: string | null;
  employment_type?: string | null;
};

type Scope = "all" | "company" | "mine" | "shared";

const SCOPE_LABEL: Record<Scope, string> = {
  all: "전체 (내 회의록)",
  company: "전체 (회사)",
  mine: "내가 작성한 회의록",
  shared: "공유받은 회의록",
};

export default function MeetingNotesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const [scope, setScope] = useState<Scope>("all");
  const [createOpen, setCreateOpen] = useState(false);

  // 본인 권한 — '전체 (회사)' 탭은 관리자만 노출.
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  const isAdmin = me?.role === "ADMIN";
  const visibleScopes = useMemo<Scope[]>(
    () =>
      (Object.keys(SCOPE_LABEL) as Scope[]).filter(
        (s) => s !== "company" || isAdmin,
      ),
    [isAdmin],
  );

  const { data: rows = [], isLoading } = useQuery<MeetingRow[]>({
    queryKey: ["meeting-notes", scope],
    queryFn: async () =>
      (await api.get("/meeting-notes", { params: { scope } })).data,
  });

  // 삭제 — 작성자만 (can_edit=true). 그 외 행은 알림 후 무시.
  const gridRef = useRef<DataGridHandle<MeetingRow>>(null);
  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/meeting-notes/${id}`))),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["meeting-notes"] }),
  });
  async function handleDelete() {
    const sel = gridRef.current?.getSelectedRows() ?? [];
    if (sel.length === 0) return;
    const mine = sel.filter((r) => r.can_edit);
    const others = sel.length - mine.length;
    if (mine.length === 0) {
      await dialog.alert(
        "선택된 회의록은 모두 본인이 작성하지 않은 항목이라 삭제할 수 없습니다.",
        { title: "권한 없음" },
      );
      return;
    }
    const ok = await dialog.confirm(
      others > 0
        ? `본인 작성 ${mine.length}건을 삭제합니다. (선택한 ${sel.length}건 중 ${others}건은 작성자가 아니라 제외됩니다.)`
        : `선택된 회의록 ${mine.length}건을 삭제하시겠습니까? 첨부·액션·공유도 함께 사라집니다.`,
      { title: "회의록 삭제", confirmText: "삭제" },
    );
    if (!ok) return;
    try {
      await deleteM.mutateAsync(mine.map((r) => r.id));
      gridRef.current?.deselectAll();
    } catch (e: any) {
      await dialog.alert(
        e?.response?.data?.detail ?? "삭제 실패",
        { title: "오류" },
      );
    }
  }

  const fmtDate = (s: string) => {
    if (!s) return "-";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    // YYYY-MM-DD HH:mm:ss (로컬 타임존 — 사용자 시각 그대로 보임).
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
  };

  const columnDefs = useMemo<ColDef<MeetingRow>[]>(
    () => [
      {
        field: "title",
        headerName: "제목",
        flex: 1,
        minWidth: 240,
        sortable: true,
        filter: false,
        cellRenderer: (p: any) => (
          <Link
            href={`/meeting-notes/${p.data?.id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-primary hover:underline"
          >
            {p.value}
          </Link>
        ),
      },
      {
        field: "customer_name",
        headerName: "고객사",
        width: 120,
        flex: 0,
        sortable: false,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => p.value || "-",
      },
      {
        field: "project_name",
        headerName: "프로젝트",
        width: 350,
        flex: 0,
        sortable: false,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => p.value || "-",
      },
      {
        field: "author_name",
        headerName: "작성자",
        width: 80,
        flex: 0,
        sortable: false,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => p.value || "-",
      },
      {
        field: "share_count",
        headerName: "공유",
        width: 40,
        flex: 0,
        sortable: false,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => (p.value > 0 ? `${p.value}명` : "-"),
      },
      {
        field: "attachment_count",
        headerName: "첨부",
        width: 40,
        flex: 0,
        sortable: false,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => (p.value > 0 ? String(p.value) : "-"),
      },
      {
        field: "action_count",
        headerName: "액션",
        width: 40,
        flex: 0,
        sortable: false,
        filter: false,
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => (p.value > 0 ? String(p.value) : "-"),
      },
      {
        field: "updated_at",
        headerName: "수정일",
        width: 150,
        flex: 0,
        sortable: true,
        filter: false,
        sort: "desc",
        headerClass: "ag-center-aligned-header",
        cellStyle: { justifyContent: "center" } as any,
        valueFormatter: (p) => fmtDate(p.value),
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="회의록" />
      <div className="flex flex-1 min-h-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-2 shrink-0">
          <TabBar className="flex-1 min-w-0">
            {visibleScopes.map((s) => (
              <TabItem key={s} active={scope === s} onClick={() => setScope(s)}>
                {SCOPE_LABEL[s]}
              </TabItem>
            ))}
          </TabBar>
          {isLoading && (
            <span className="text-xs text-muted-foreground">불러오는 중…</span>
          )}
        </div>

        <DataGrid<MeetingRow>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          onAdd={() => setCreateOpen(true)}
          addLabel="새 회의록"
          // '공유받은' / '전체 (회사)' 탭에서는 삭제 버튼 숨김 — 본인 작성건이
          // 아닌 행이 다수 노출되므로. (회사 탭은 관리자 전용 보기 용도.)
          onDelete={
            scope === "shared" || scope === "company" ? undefined : handleDelete
          }
        />
      </div>

      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          qc.invalidateQueries({ queryKey: ["meeting-notes"] });
          router.push(`/meeting-notes/${id}`);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 작성 다이얼로그
// ---------------------------------------------------------------------------

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const dialog = useDialog();
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [shareIds, setShareIds] = useState<string[]>([]);

  const reset = () => {
    setTitle("");
    setCustomerId(null);
    setProjectId(null);
    setShareIds([]);
  };

  // 작성자(현재 로그인 사용자) 식별 — 매핑된 developer 가 있으면 공유 풀에서
  // 자기 자신을 제외해 중복 공유를 방지. 매핑이 없는 admin 도 작성은 가능.
  const { data: me } = useQuery<{ mapped_developer_id?: string | null }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60 * 1000,
  });
  const myDevId = me?.mapped_developer_id ?? null;

  // 모든 role 사용 — 메뉴 권한과 별개의 공용 picker.
  const { data: customers = [] } = useQuery<CustomerLite[]>({
    queryKey: ["pickers", "customers"],
    queryFn: async () => (await api.get("/pickers/customers")).data,
    staleTime: 60_000,
    enabled: open,
  });
  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ["pickers", "projects"],
    queryFn: async () => (await api.get("/pickers/projects")).data,
    staleTime: 60_000,
    enabled: open,
  });
  const { data: developers = [] } = useQuery<DevLite[]>({
    queryKey: ["developers", "share-pool"],
    queryFn: async () =>
      (
        await api.get("/developers", {
          params: { employment_type: "FULL_TIME", status_filter: "ACTIVE" },
        })
      ).data,
    staleTime: 60_000,
    enabled: open,
  });

  const sortedCustomers = useMemo(
    () => customers.slice().sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [customers],
  );
  const filteredProjects = useMemo(() => {
    const list = customerId
      ? projects.filter((p) => p.customer_id === customerId)
      : projects;
    return list.slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [projects, customerId]);
  const sortedDevs = useMemo(
    () => sortDevelopersKo(developers),
    [developers],
  );

  const createM = useMutation({
    mutationFn: async () =>
      (
        await api.post("/meeting-notes", {
          title: title.trim(),
          customer_id: customerId || null,
          project_id: projectId || null,
          share_developer_ids: shareIds,
        })
      ).data as { id: string },
    onSuccess: (data) => {
      reset();
      onClose();
      onCreated(data.id);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" }),
  });

  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="새 회의록"
      width="max-w-3xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => createM.mutate()}
            disabled={!title.trim() || createM.isPending}
            className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            {createM.isPending ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="제목 *" colSpan={2}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={input}
            autoFocus
            placeholder="회의록 제목"
          />
        </Field>
        <Field label="고객사">
          <select
            value={customerId ?? ""}
            onChange={(e) => {
              setCustomerId(e.target.value || null);
              setProjectId(null);
            }}
            className={input}
          >
            <option value="">미지정</option>
            {sortedCustomers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="프로젝트">
          <select
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
            className={input}
          >
            <option value="">미지정</option>
            {filteredProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="공유받을 직원 (정규직)" colSpan={2}>
          <SharePicker
            developers={sortedDevs}
            excludeIds={myDevId ? [myDevId] : []}
            selectedIds={shareIds}
            setSelectedIds={setShareIds}
            helpText="저장 시 선택된 직원에게 Slack/Mattermost DM 으로 회의록 링크가 발송됩니다."
          />
        </Field>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <label className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
