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
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
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

// ---------------------------------------------------------------------------
// 고객사별 그룹 보기 (ag-grid community 는 native row grouping 미지원 →
// full-width 밴드 행을 직접 끼워 넣는 방식)
// ---------------------------------------------------------------------------

const NONE_KEY = "__none__";

type GroupBand = {
  __group: true;
  key: string;      // customer_id 또는 NONE_KEY
  name: string;
  count: number;
};
type FlatRow = MeetingRow | GroupBand;

const isBand = (r: FlatRow): r is GroupBand =>
  (r as GroupBand).__group === true;

/**
 * rows 를 고객사별 버킷으로 묶어 [밴드, ...회의록, 밴드, ...] 평면 배열로.
 * - 고객사명 ko 정렬, "고객사 없음" 버킷은 항상 마지막.
 * - 버킷 내부는 updated_at 내림차순.
 * - collapsed 에 든 key 의 버킷은 자식 행을 생략(밴드만 남김).
 */
function buildGrouped(rows: MeetingRow[], collapsed: Set<string>): FlatRow[] {
  const buckets = new Map<string, { name: string; items: MeetingRow[] }>();
  for (const r of rows) {
    const key = r.customer_id ?? NONE_KEY;
    const name = r.customer_id
      ? r.customer_name ?? "(이름없음)"
      : "고객사 없음";
    let b = buckets.get(key);
    if (!b) {
      b = { name, items: [] };
      buckets.set(key, b);
    }
    b.items.push(r);
  }
  const ordered = [...buckets.entries()].sort(([ka, a], [kb, b]) => {
    if (ka === NONE_KEY) return 1;
    if (kb === NONE_KEY) return -1;
    return a.name.localeCompare(b.name, "ko");
  });
  const out: FlatRow[] = [];
  for (const [key, { name, items }] of ordered) {
    items.sort((x, y) => y.updated_at.localeCompare(x.updated_at));
    out.push({ __group: true, key, name, count: items.length });
    if (!collapsed.has(key)) out.push(...items);
  }
  return out;
}

// 그룹 모드 전용 검색 — quickFilter 대신 rows 를 선필터(밴드 깨짐 방지).
function filterRows(rows: MeetingRow[], q: string): MeetingRow[] {
  const term = q.trim().toLowerCase();
  if (!term) return rows;
  return rows.filter((r) =>
    [r.title, r.customer_name, r.project_name, r.author_name]
      .some((v) => (v ?? "").toLowerCase().includes(term)),
  );
}

export default function MeetingNotesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const dialog = useDialog();
  const [scope, setScope] = useState<Scope>("all");
  const [createOpen, setCreateOpen] = useState(false);
  // 고객사별 그룹 보기 토글 + 접힌 그룹 key 집합.
  const [grouped, setGrouped] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupQuery, setGroupQuery] = useState("");

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

  // 그룹 모드 컬럼 — 고객사는 밴드로 대체되어 중복이라 제외하고, 정렬을 켜면
  // 밴드 구조가 깨지므로 모든 컬럼 sortable=false (정렬은 buildGrouped 가 고정).
  const groupedColumnDefs = useMemo<ColDef<MeetingRow>[]>(
    () =>
      columnDefs
        .filter((c) => c.field !== "customer_name")
        .map((c) => ({ ...c, sortable: false, sort: undefined })),
    [columnDefs],
  );

  const displayRows = useMemo<FlatRow[]>(
    () => (grouped ? buildGrouped(filterRows(rows, groupQuery), collapsed) : rows),
    [grouped, rows, groupQuery, collapsed],
  );

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // full-width 밴드 셀 렌더러 — 고객사명 + 건수 + ▼/▶ 토글.
  const GroupBandRenderer = (p: any) => {
    const b = p.data as GroupBand;
    const isCollapsed = collapsed.has(b.key);
    return (
      <button
        type="button"
        onClick={() => toggleCollapse(b.key)}
        className="flex h-full w-full items-center gap-2 bg-muted/60 px-2 text-left font-medium text-foreground hover:bg-muted"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">{b.name}</span>
        <span className="text-xs text-muted-foreground">({b.count}건)</span>
      </button>
    );
  };

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
          rowData={displayRows as MeetingRow[]}
          columnDefs={grouped ? groupedColumnDefs : columnDefs}
          getRowId={(r: any) => (r.__group ? `band:${r.key}` : r.id)}
          // 그룹 모드: 밴드 경계와 페이지가 안 맞으므로 페이지네이션 끄고 스크롤.
          pagination={!grouped}
          // 그룹 모드에서는 quickFilter 대신 rows 선필터(groupQuery) 사용 —
          // 밴드 행이 필터에 걸려 그룹 구조가 깨지는 것을 방지.
          hideSearch={grouped}
          isFullWidthRow={grouped ? (p) => !!p.rowNode.data?.__group : undefined}
          fullWidthCellRenderer={grouped ? GroupBandRenderer : undefined}
          getRowHeight={
            grouped ? (p) => (p.data?.__group ? 34 : undefined) : undefined
          }
          toolbarLeading={
            <>
              {grouped && (
                <input
                  value={groupQuery}
                  onChange={(e) => setGroupQuery(e.target.value)}
                  placeholder="검색"
                  className="h-8 w-56 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              )}
              <button
                type="button"
                onClick={() => setGrouped((g) => !g)}
                className={
                  "h-8 inline-flex items-center gap-1 rounded-md border px-3 text-xs font-medium " +
                  (grouped
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-muted")
                }
              >
                <Layers className="h-3.5 w-3.5" />
                고객사별 묶기
              </button>
            </>
          }
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
