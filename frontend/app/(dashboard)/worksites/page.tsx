"use client";

/**
 * 근무지(Worksite) 관리 — 사이드바 ATTENDANCE 그룹.
 *
 * - 권한: `worksites.manage` (HR + ADMIN). 일반 사용자는 메뉴에 노출되지 않음.
 * - 프로젝트 연결은 선택. 본사 사무실 등 프로젝트 무관 근무지도 동일하게 다룸.
 * - 등록 시 위경도는 직접 입력. 카카오맵 지오코딩은 PR 3 에 추가 예정.
 *   주소가 입력되면 우측 아이콘으로 카카오맵 외부 페이지를 새 탭에서 연다.
 * - 직원 매핑은 상세 다이얼로그 안에서 인라인 추가/제거.
 */

import { useMemo, useState } from "react";
import { ColDef } from "ag-grid-community";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  MapPin,
  Pencil,
  Plus,
  Save,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { Tooltip } from "@/components/ui/Tooltip";
import { KakaoMapDialog } from "@/components/integrations/KakaoMapDialog";

type Worksite = {
  id: string;
  name: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  radius_meters: number;
  work_start_time: string;
  work_end_time: string;
  projects: { id: string; name: string }[];
  status: "ACTIVE" | "INACTIVE";
  memo: string | null;
  assignment_count: number;
  created_at: string;
  updated_at: string;
};

type Assignment = {
  id: string;
  worksite_id: string;
  developer_id: string;
  developer_name: string | null;
  developer_status: string | null;  // ACTIVE | INACTIVE — 백엔드 derived
  start_date: string;
  end_date: string | null;
  is_primary: boolean;
  memo: string | null;
};

type WorksiteDetail = Worksite & { assignments: Assignment[] };

type ProjectBrief = { id: string; name: string };
type DeveloperBrief = {
  id: string;
  name: string;
  status?: string | null;
  employment_type?: "FULL_TIME" | "FREELANCER" | null;
};

type WorksiteForm = {
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  radius_meters: string;        // 입력은 string, payload 직전 number 변환
  work_start_time: string;      // "HH:MM"
  work_end_time: string;        // "HH:MM"
  project_ids: string[];        // M:N
  status: "ACTIVE" | "INACTIVE";
  memo: string;
};

const BLANK_FORM: WorksiteForm = {
  name: "",
  address: "",
  latitude: "",
  longitude: "",
  radius_meters: "100",
  work_start_time: "09:00",
  work_end_time: "18:00",
  project_ids: [],
  status: "ACTIVE",
  memo: "",
};

// 00:00 부터 23:30 까지 30분 단위 — 48 옵션.
const TIME_OPTIONS: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    out.push(`${String(h).padStart(2, "0")}:00`);
    out.push(`${String(h).padStart(2, "0")}:30`);
  }
  return out;
})();

export default function WorksitesPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<WorksiteForm>(BLANK_FORM);
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<WorksiteForm>(BLANK_FORM);

  const { data: rows = [] } = useQuery<Worksite[]>({
    queryKey: ["worksites"],
    queryFn: async () => (await api.get("/worksites")).data,
  });

  const { data: projects = [] } = useQuery<ProjectBrief[]>({
    queryKey: ["projects-brief"],
    queryFn: async () => (await api.get("/projects")).data,
    staleTime: 60_000,
  });

  // 근무지 배정용 직원 목록 — FULL_TIME 과 FREELANCER 모두 포함하도록
  // include_hidden=true 로 디렉터리 숨김 리스트도 무시. (Settings 의 디렉터리
  // 제외 리스트가 적용된 다른 picker 와 분리된 캐시 키 사용.)
  const { data: developers = [] } = useQuery<DeveloperBrief[]>({
    queryKey: ["developers-for-worksite"],
    queryFn: async () =>
      (await api.get("/developers", { params: { include_hidden: true } })).data,
    staleTime: 60_000,
  });

  const createM = useMutation({
    mutationFn: async (form: WorksiteForm) =>
      (await api.post("/worksites", formToPayload(form))).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worksites"] });
      setAddOpen(false);
      setAddForm(BLANK_FORM);
    },
    onError: async (e: any) =>
      dialog.alert(extractError(e) ?? "등록 실패", { title: "오류" }),
  });

  const updateM = useMutation({
    mutationFn: async ({ id, form }: { id: string; form: WorksiteForm }) =>
      (await api.patch(`/worksites/${id}`, formToPayload(form))).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worksites"] });
      qc.invalidateQueries({ queryKey: ["worksite-detail"] });
      setEditTargetId(null);
    },
    onError: async (e: any) =>
      dialog.alert(extractError(e) ?? "저장 실패", { title: "오류" }),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/worksites/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worksites"] }),
  });

  async function handleDelete(sel: Worksite[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}개 근무지를 비활성화하시겠습니까?\n` +
        "(데이터는 유지되며 status=INACTIVE 로 전환됩니다.)",
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  function openEdit(row: Worksite) {
    setEditTargetId(row.id);
    setEditForm({
      name: row.name,
      address: row.address ?? "",
      latitude: row.latitude ?? "",
      longitude: row.longitude ?? "",
      radius_meters: String(row.radius_meters),
      work_start_time: row.work_start_time ?? "09:00",
      work_end_time: row.work_end_time ?? "18:00",
      project_ids: (row.projects ?? []).map((p) => p.id),
      status: row.status,
      memo: row.memo ?? "",
    });
  }

  const columnDefs = useMemo<ColDef<Worksite>[]>(
    () => [
      { field: "name", headerName: "근무지명", flex: 0 },
      {
        colId: "projects",
        headerName: "프로젝트",
        // 고정 폭 200px — auto-size 대상에서 제외.
        width: 200,
        suppressSizeToFit: true,
        // 여러 프로젝트는 줄바꿈으로 표시. autoHeight 로 row 높이 자동 확장.
        autoHeight: true,
        // 정렬·필터 시 valueGetter 가 사용됨 — \n 으로 구분하면 한 줄 검색에서도 매칭.
        valueGetter: (p) =>
          (p.data?.projects ?? []).map((x: any) => x.name).join("\n"),
        cellRenderer: (p: any) => {
          const list = p.data?.projects ?? [];
          if (list.length === 0)
            return <span className="text-muted-foreground">—</span>;
          return (
            <div className="leading-snug py-1">
              {list.map((x: any) => (
                <div key={x.id}>{x.name}</div>
              ))}
            </div>
          );
        },
      },
      {
        colId: "work_hours",
        headerName: "근무시간",
        flex: 0,
        valueGetter: (p) =>
          p.data
            ? `${p.data.work_start_time}~${p.data.work_end_time}`
            : "",
      },
      { field: "address", headerName: "주소", flex: 1 },
      {
        colId: "coords",
        headerName: "위경도",
        flex: 0,
        valueGetter: (p) =>
          p.data?.latitude && p.data?.longitude
            ? `${Number(p.data.latitude).toFixed(5)}, ${Number(p.data.longitude).toFixed(5)}`
            : "—",
      },
      {
        field: "radius_meters",
        headerName: "반경",
        flex: 0,
        valueFormatter: (p) => `${p.value}m`,
      },
      {
        field: "assignment_count",
        headerName: "배정",
        flex: 0,
        valueFormatter: (p) => `${p.value ?? 0}명`,
      },
      {
        field: "status",
        headerName: "상태",
        flex: 0,
        cellRenderer: (p: any) => (
          <span
            className={
              "rounded px-1.5 py-0.5 text-xs " +
              (p.value === "ACTIVE"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-200 text-slate-600")
            }
          >
            {p.value === "ACTIVE" ? "활성" : "비활성"}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="근무지" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid<Worksite>
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          compact
          searchPlaceholder="근무지명, 주소 검색"
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: [
              "name",
              "work_hours",
              "coords",
              "radius_meters",
              "assignment_count",
              "status",
            ],
          }}
          onAdd={() => {
            setAddForm(BLANK_FORM);
            setAddOpen(true);
          }}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
        />
      </div>

      {/* 신규 등록 */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="근무지 등록"
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              disabled={!validForm(addForm) || createM.isPending}
              onClick={() => createM.mutate(addForm)}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {createM.isPending ? "등록 중..." : "등록"}
            </button>
          </>
        }
      >
        <WorksiteFormBody
          form={addForm}
          setForm={setAddForm}
          projects={projects}
        />
      </Dialog>

      {/* 편집 + 직원 매핑 */}
      {editTargetId && (
        <EditDialog
          worksiteId={editTargetId}
          form={editForm}
          setForm={setEditForm}
          projects={projects}
          developers={developers}
          submitting={updateM.isPending}
          onClose={() => setEditTargetId(null)}
          onSave={() =>
            updateM.mutate({ id: editTargetId, form: editForm })
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 편집 다이얼로그 — 본체 폼 + 매핑 인라인 패널
// ---------------------------------------------------------------------------

function EditDialog({
  worksiteId,
  form,
  setForm,
  projects,
  developers,
  submitting,
  onClose,
  onSave,
}: {
  worksiteId: string;
  form: WorksiteForm;
  setForm: (f: WorksiteForm | ((prev: WorksiteForm) => WorksiteForm)) => void;
  projects: ProjectBrief[];
  developers: DeveloperBrief[];
  submitting: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: detail } = useQuery<WorksiteDetail>({
    queryKey: ["worksite-detail", worksiteId],
    queryFn: async () => (await api.get(`/worksites/${worksiteId}`)).data,
    enabled: !!worksiteId,
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const addAssignM = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      // 일괄 추가 — 병렬 POST. start_date 미지정 → 백엔드가 오늘로 자동 채움.
      // is_primary 는 멀티 추가에서 의미가 모호하므로 false. 단일 ★ 지정은
      // 기존 매핑 표의 ☆/★ 토글로.
      await Promise.all(
        ids.map((developer_id) =>
          api.post(`/worksites/${worksiteId}/assignments`, {
            developer_id,
            is_primary: false,
          }),
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worksite-detail", worksiteId] });
      qc.invalidateQueries({ queryKey: ["worksites"] });
      setSelectedIds(new Set());
    },
    onError: async (e: any) =>
      dialog.alert(extractError(e) ?? "매핑 실패", { title: "오류" }),
  });

  const togglePrimaryM = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) =>
      api.patch(`/worksites/assignments/${id}`, { is_primary: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worksite-detail", worksiteId] });
    },
  });

  const endAssignM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/worksites/assignments/${id}`, { params: { end_now: true } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worksite-detail", worksiteId] });
      qc.invalidateQueries({ queryKey: ["worksites"] });
    },
  });

  const removeAssignM = useMutation({
    mutationFn: async (id: string) =>
      api.delete(`/worksites/assignments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["worksite-detail", worksiteId] });
      qc.invalidateQueries({ queryKey: ["worksites"] });
    },
  });

  // 이미 매핑된 (진행중) 직원 ID set — picker 에서 숨김.
  const mappedActiveIds = useMemo(
    () =>
      new Set(
        (detail?.assignments ?? [])
          .filter((a) => !a.end_date)
          .map((a) => a.developer_id),
      ),
    [detail],
  );

  // picker 후보 — 활성 직원만 + 진행중 매핑된 직원 제외 (중복 매핑 방지).
  // status 가 비어있는 응답(레거시) 도 활성으로 간주해 통과.
  const pickerCandidates = useMemo(
    () =>
      developers
        .filter(
          (d) =>
            (!d.status || d.status === "ACTIVE") && !mappedActiveIds.has(d.id),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [developers, mappedActiveIds],
  );

  // 퇴사(INACTIVE) 직원의 매핑은 표시에서 제외 — 매핑 row 자체는 DB 에 보존.
  // 백엔드가 assignment.developer_status 를 직접 내려주므로 client-side
  // lookup 불필요 (이전 방식은 캐시 race 로 누락 가능했음).
  const visibleAssignments = useMemo(
    () =>
      (detail?.assignments ?? []).filter(
        (a) => a.developer_status !== "INACTIVE",
      ),
    [detail],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="근무지 수정"
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
            disabled={!validForm(form) || submitting}
            onClick={onSave}
            className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {submitting ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <WorksiteFormBody form={form} setForm={setForm} projects={projects} />

      <div className="mt-4 border-t border-border pt-3">
        <div className="text-xs font-semibold mb-2 flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          배정된 직원
        </div>

        {/* 멀티 직원 picker — Alarms > 담당자 DM 패턴: chip-checkbox flex-wrap. */}
        <div className="max-h-48 overflow-auto rounded-md border border-border p-2 flex flex-wrap gap-1.5">
          {pickerCandidates.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              선택 가능한 직원이 없습니다.
            </span>
          ) : (
            pickerCandidates.map((d) => {
              const checked = selectedIds.has(d.id);
              return (
                <label
                  key={d.id}
                  className={
                    "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs cursor-pointer " +
                    (checked
                      ? "border-primary bg-primary/10"
                      : "border-border")
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelect(d.id)}
                  />
                  {d.name}
                  {d.employment_type === "FREELANCER" && (
                    <span className="text-amber-700"> · 프리랜서</span>
                  )}
                </label>
              );
            })
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-[11px] text-muted-foreground hover:underline"
            >
              모두 해제
            </button>
          )}
          <button
            type="button"
            disabled={selectedIds.size === 0 || addAssignM.isPending}
            onClick={() => addAssignM.mutate()}
            className="h-8 ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {addAssignM.isPending
              ? "추가 중..."
              : selectedIds.size > 0
                ? `${selectedIds.size}명 추가`
                : "추가"}
          </button>
        </div>

        {/* 기존 매핑 목록 — 퇴사 직원 제외 */}
        {visibleAssignments.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            배정된 직원이 없습니다.
          </div>
        ) : (
          // 5행까지만 보이게 max-h 고정 + 스크롤. thead sticky 로 헤더 유지.
          // 행 높이 ≈ 28px (text-xs + py-1.5) → thead 28 + 5*28 = 168px ≈ max-h-44.
          <div className="max-h-44 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground sticky top-0 z-10">
              <tr>
                <th className="px-2 py-1.5 text-left">직원</th>
                <th className="px-2 py-1.5">시작일</th>
                <th className="px-2 py-1.5">종료일</th>
                <th className="px-2 py-1.5">주근무지</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {visibleAssignments.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-2 py-1.5 font-medium">
                    {a.developer_name ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center text-muted-foreground">
                    {a.start_date}
                  </td>
                  <td className="px-2 py-1.5 text-center text-muted-foreground">
                    {a.end_date ?? "진행중"}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {/* 토글 — 진행중 매핑만 변경 가능 */}
                    {!a.end_date ? (
                      <button
                        type="button"
                        onClick={() =>
                          togglePrimaryM.mutate({
                            id: a.id,
                            next: !a.is_primary,
                          })
                        }
                        title={a.is_primary ? "주근무지 해제" : "주근무지로 지정"}
                        className={
                          "h-5 w-5 rounded inline-flex items-center justify-center " +
                          (a.is_primary
                            ? "text-amber-500 hover:text-amber-600"
                            : "text-muted-foreground hover:text-foreground")
                        }
                      >
                        {a.is_primary ? "★" : "☆"}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">
                        {a.is_primary ? "★" : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {!a.end_date ? (
                      <button
                        type="button"
                        onClick={() => endAssignM.mutate(a.id)}
                        title="종료(end_date=오늘)"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                      >
                        <X className="h-3 w-3" />
                        종료
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await dialog.confirm(
                            "이 매핑 이력을 완전히 삭제하시겠습니까?",
                            { destructive: true },
                          );
                          if (ok) removeAssignM.mutate(a.id);
                        }}
                        title="삭제(hard)"
                        className="text-destructive hover:underline inline-flex items-center gap-0.5"
                      >
                        <Trash2 className="h-3 w-3" />
                        삭제
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 폼 본체 (등록·수정 공통)
// ---------------------------------------------------------------------------

function WorksiteFormBody({
  form,
  setForm,
  projects,
}: {
  form: WorksiteForm;
  setForm: (f: WorksiteForm | ((prev: WorksiteForm) => WorksiteForm)) => void;
  projects: ProjectBrief[];
}) {
  const input =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  // Kakao Map 활성화 여부 — 주소 입력 옆 아이콘 노출 게이팅.
  const { data: kakaoCfg } = useQuery<{ enabled: boolean }>({
    queryKey: ["kakao-map-config"],
    queryFn: async () => (await api.get("/integrations/kakao-map")).data,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const kakaoEnabled = !!kakaoCfg?.enabled;

  // 지도 미리보기 — 위경도 + 반경 모두 입력됐을 때만 활성. Kakao Map 연동도 필요.
  const [mapOpen, setMapOpen] = useState(false);
  const lat = Number(form.latitude);
  const lng = Number(form.longitude);
  const rad = Number(form.radius_meters);
  const canShowMap =
    kakaoEnabled &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat !== 0 &&
    lng !== 0 &&
    Number.isFinite(rad) &&
    rad > 0;

  return (
    <div className="grid grid-cols-2 gap-3">
      {/* Row 1 — 근무지명 / 프로젝트 폭 비율 35:65 (50% 기준 ±30%). */}
      <div
        className="col-span-2 grid gap-3"
        style={{ gridTemplateColumns: "35% 65%" }}
      >
        <Field label="근무지명 *">
          <input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            className={input}
            autoFocus
            placeholder="예: 강남 본사 / OO프로젝트 상주"
          />
        </Field>

        <Field label="프로젝트 (선택, 복수)">
          {/* 1 ROW = 1 프로젝트. flex-col 로 수직 stack — 프로젝트명이 길어도
              잘리지 않고 행마다 한 개씩 명확히 표시. */}
          <div className="max-h-48 overflow-auto rounded-md border border-input bg-background p-2 flex flex-col gap-1">
          {projects.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              등록된 프로젝트가 없습니다.
            </span>
          ) : (
            projects
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name, "ko"))
              .map((p) => {
                const checked = form.project_ids.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={
                      "flex items-center gap-2 rounded border px-2 py-1 text-xs cursor-pointer " +
                      (checked
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted/30")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setForm((prev) => ({
                          ...prev,
                          project_ids: prev.project_ids.includes(p.id)
                            ? prev.project_ids.filter((id) => id !== p.id)
                            : [...prev.project_ids, p.id],
                        }))
                      }
                    />
                    <span className="truncate">{p.name}</span>
                  </label>
                );
              })
          )}
          </div>
        </Field>
      </div>

      <Field label="근무시간">
        <div className="flex items-center gap-2">
          <select
            value={form.work_start_time}
            onChange={(e) =>
              setForm((p) => ({ ...p, work_start_time: e.target.value }))
            }
            className={input}
          >
            {TIME_OPTIONS.map((t) => (
              <option key={`s-${t}`} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">~</span>
          <select
            value={form.work_end_time}
            onChange={(e) =>
              setForm((p) => ({ ...p, work_end_time: e.target.value }))
            }
            className={input}
          >
            {TIME_OPTIONS.map((t) => (
              <option key={`e-${t}`} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <Field label="상태">
        <select
          value={form.status}
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              status: e.target.value as "ACTIVE" | "INACTIVE",
            }))
          }
          className={input}
        >
          <option value="ACTIVE">활성</option>
          <option value="INACTIVE">비활성</option>
        </select>
      </Field>

      <Field label="주소" colSpan={2}>
        <div className="flex items-center gap-1">
          <input
            value={form.address}
            onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
            className={input}
            placeholder="서울특별시 강남구 ..."
          />
          {kakaoEnabled && form.address && form.address.trim() && (
            <Tooltip label="카카오맵에서 보기" side="top">
              <a
                href={`https://map.kakao.com/?q=${encodeURIComponent(form.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="카카오맵에서 보기"
                className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border border-input bg-background text-primary hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
              </a>
            </Tooltip>
          )}
        </div>
      </Field>

      {/* 위도·경도·허용 반경 — 한 row 3 컬럼. */}
      <div className="col-span-2 grid grid-cols-3 gap-3">
        <Field label="위도 (latitude)">
          <input
            value={form.latitude}
            onChange={(e) =>
              setForm((p) => ({ ...p, latitude: e.target.value }))
            }
            className={input}
            placeholder="37.5172"
            inputMode="decimal"
          />
        </Field>
        <Field label="경도 (longitude)">
          <input
            value={form.longitude}
            onChange={(e) =>
              setForm((p) => ({ ...p, longitude: e.target.value }))
            }
            className={input}
            placeholder="127.0473"
            inputMode="decimal"
          />
        </Field>
        <Field label="허용 반경 (m) *">
          <div className="flex items-center gap-1">
            <input
              value={form.radius_meters}
              onChange={(e) =>
                setForm((p) => ({ ...p, radius_meters: e.target.value }))
              }
              className={input}
              placeholder="100"
              inputMode="numeric"
            />
            <Tooltip
              label={
                canShowMap
                  ? "지도에서 위치·반경 확인"
                  : kakaoEnabled
                    ? "위·경도와 반경을 모두 입력하세요"
                    : "Settings 에서 Kakao Map 활성화 필요"
              }
              side="top"
            >
              <button
                type="button"
                disabled={!canShowMap}
                onClick={() => setMapOpen(true)}
                aria-label="지도 보기"
                className={
                  "h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md border border-input bg-background " +
                  (canShowMap
                    ? "text-primary hover:bg-muted"
                    : "text-muted-foreground/50 cursor-not-allowed")
                }
              >
                <MapPin className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        </Field>
      </div>

      {mapOpen && canShowMap && (
        <KakaoMapDialog
          latitude={lat}
          longitude={lng}
          radiusMeters={rad}
          title={form.name ? `${form.name} · 반경 ${rad}m` : `반경 ${rad}m`}
          address={form.address || undefined}
          onClose={() => setMapOpen(false)}
        />
      )}

      <Field label="메모" colSpan={2}>
        <textarea
          value={form.memo}
          onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
          rows={2}
          className={input}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 2;
  children: React.ReactNode;
}) {
  return (
    <label className={"flex flex-col gap-1 " + (colSpan === 2 ? "col-span-2" : "")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validForm(f: WorksiteForm): boolean {
  if (!f.name.trim()) return false;
  const r = Number(f.radius_meters);
  if (!Number.isFinite(r) || r <= 0) return false;
  // lat/lng 는 옵션. 입력했다면 둘 다 입력돼야.
  const hasLat = f.latitude.trim() !== "";
  const hasLng = f.longitude.trim() !== "";
  if (hasLat !== hasLng) return false;
  return true;
}

function formToPayload(f: WorksiteForm): Record<string, unknown> {
  const hasCoords = f.latitude.trim() !== "" && f.longitude.trim() !== "";
  return {
    name: f.name.trim(),
    address: f.address.trim() || null,
    latitude: hasCoords ? Number(f.latitude) : null,
    longitude: hasCoords ? Number(f.longitude) : null,
    radius_meters: Number(f.radius_meters),
    work_start_time: f.work_start_time,
    work_end_time: f.work_end_time,
    project_ids: f.project_ids,
    status: f.status,
    memo: f.memo.trim() || null,
  };
}

function extractError(e: any): string | null {
  const d = e?.response?.data?.detail;
  if (Array.isArray(d)) {
    return d
      .map((it: any) => {
        const field = Array.isArray(it.loc) ? it.loc.slice(1).join(".") : "";
        return field ? `${field}: ${it.msg}` : it.msg;
      })
      .join(" / ");
  }
  if (typeof d === "string") return d;
  return e?.message ?? null;
}
