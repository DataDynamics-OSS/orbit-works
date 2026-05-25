"use client";

/**
 * 워크샵 / 컨퍼런스 (events) — 일정·항공권·숙박·참석자·첨부 통합 관리.
 *
 * 그리드는 매출 인보이스 패턴 (DataGrid + 연도 네비). 등록·편집 다이얼로그는
 * 매입 인보이스 패턴 (max-w-3xl 3-column).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Tooltip } from "@/components/ui/Tooltip";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import {
  AddressMapButtons,
  AddressMapDisplay,
  useAddressMapState,
} from "@/components/events/AddressMap";
import { downloadEventPDF } from "@/lib/event-export";

type Kind = "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";

const KIND_LABEL: Record<Kind, string> = {
  WORKSHOP: "워크샵",
  CONFERENCE: "컨퍼런스",
  BUSINESS_TRIP: "출장",
};

type Flight = {
  id?: string;
  position?: number;
  airline?: string | null;
  booking_ref?: string | null;
  ticket_no?: string | null;
  flight_no?: string | null;
  departure_airport?: string | null;
  departure_terminal?: string | null;
  arrival_airport?: string | null;
  arrival_terminal?: string | null;
  seat_class?: string | null;
  departure_at?: string | null;     // datetime-local 입력 호환 ISO 또는 빈값
  arrival_at?: string | null;
  cost: string | number;
  memo?: string | null;
};

type Lodging = {
  id?: string;
  position?: number;
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  check_in_date?: string | null;
  check_out_date?: string | null;
  cost: string | number;
  memo?: string | null;
};

type Participant = {
  id?: string;
  position?: number;
  developer_id?: string | null;
  guest_name?: string | null;
  display_name?: string | null;
  gender?: "M" | "F" | null;
};

type Attachment = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

type EventRow = {
  id: string;
  kind: Kind;
  title: string;
  address: string | null;
  start_date: string;
  end_date: string;
  budget: string;
  actual_cost: string;
  entry_fee: string;
  expenses: string;
  memo: string | null;
  plan: string | null;
  flights: Flight[];
  lodgings: Lodging[];
  participants: Participant[];
  attachments: Attachment[];
  flights_total: string;
  lodgings_total: string;
  grand_total: string;
};

type Form = {
  id?: string;
  kind: Kind;
  title: string;
  address: string;
  start_date: string;
  end_date: string;
  budget: string;          // 숫자 문자열 (콤마 없는 raw digits)
  actual_cost: string;     // 동
  entry_fee: string;       // 동
  expenses: string;        // 동
  memo: string;
  plan: string;
  flights: Flight[];
  lodgings: Lodging[];
  participants: Participant[];
};

const BLANK: Form = {
  kind: "WORKSHOP",
  title: "",
  address: "",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: new Date().toISOString().slice(0, 10),
  budget: "",
  actual_cost: "",
  entry_fee: "",
  expenses: "",
  memo: "",
  plan: "",
  flights: [],
  lodgings: [],
  participants: [],
};

// 정수 KRW 콤마 포맷 — 빈문자열이면 그대로.
function commaInt(raw: string): string {
  if (!raw) return "";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString("ko-KR");
}

type Developer = { id: string; name: string; phone?: string | null; status?: string | null; gender?: "M" | "F" | null };

function fmtKRW(v: string | number): string {
  const n = Number(v) || 0;
  return `₩ ${n.toLocaleString("ko-KR")}`;
}

export default function EventsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  // 정보 변경 권한 — ADMIN / HR (`events.manage`) 만. 그 외는 read-only.
  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 5 * 60_000,
  });
  // 추가·수정·삭제 권한 — 백엔드 events.manage (ADMIN/HR/SUPER_ADMIN) 매핑.
  // 그 외 role 은 read-only 로 목록·상세·첨부 다운로드까지 가능.
  const canManage =
    me?.role === "ADMIN" || me?.role === "HR" || me?.role === "SUPER_ADMIN";

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [kindFilter, setKindFilter] = useState<Kind | "">("");

  const { data: rows = [] } = useQuery<EventRow[]>({
    queryKey: ["events", year, kindFilter],
    queryFn: async () => {
      const params: Record<string, string | number> = { year };
      if (kindFilter) params.kind = kindFilter;
      return (await api.get("/events", { params })).data;
    },
  });

  // 정규직(FULL_TIME) + 재직중(ACTIVE) 만 — `/developers/directory` 가 서버단에서
  // status==ACTIVE 로 자동 필터하므로 employment_type 만 명시.
  const { data: developers = [] } = useQuery<Developer[]>({
    queryKey: ["developers-directory", "FULL_TIME"],
    queryFn: async () =>
      (await api.get("/developers/directory", {
        params: { employment_type: "FULL_TIME" },
      })).data,
    staleTime: 60_000,
  });
  const devNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of developers) m.set(d.id, d.name);
    return m;
  }, [developers]);
  const devPhoneById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of developers) if (d.phone) m.set(d.id, d.phone);
    return m;
  }, [developers]);
  const devGenderById = useMemo(() => {
    const m = new Map<string, "M" | "F">();
    for (const d of developers) if (d.gender) m.set(d.id, d.gender);
    return m;
  }, [developers]);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<Attachment[]>([]);
  const editingIdRef = useRef<string | null>(null);

  const saveM = useMutation({
    mutationFn: async () => {
      const body = {
        kind: form.kind,
        title: form.title,
        address: form.address || null,
        start_date: form.start_date,
        end_date: form.end_date,
        budget: form.budget ? Number(form.budget) : 0,
        actual_cost: form.actual_cost ? Number(form.actual_cost) : 0,
        entry_fee: form.entry_fee ? Number(form.entry_fee) : 0,
        expenses: form.expenses ? Number(form.expenses) : 0,
        memo: form.memo || null,
        plan: form.plan || null,
        flights: form.flights.map((f, i) => ({
          ...f,
          position: i,
          cost: f.cost ? Number(f.cost) : 0,
        })),
        lodgings: form.lodgings.map((l, i) => ({
          ...l,
          position: i,
          cost: l.cost ? Number(l.cost) : 0,
        })),
        participants: form.participants.map((p, i) => ({
          position: i,
          developer_id: p.developer_id || null,
          guest_name: p.developer_id ? null : (p.guest_name || null),
        })),
      };
      let id: string;
      if (form.id) {
        await api.patch(`/events/${form.id}`, body);
        id = form.id;
      } else {
        const { data } = await api.post("/events", body);
        id = data.id;
      }
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        await api.post(`/events/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      setOpen(false);
      setForm(BLANK);
      setPendingFiles([]);
      setExistingAttachments([]);
    },
    onError: async (e: any) => {
      const detail = e?.response?.data?.detail;
      const msg = Array.isArray(detail)
        ? detail.map((d: any) => d.msg ?? JSON.stringify(d)).join("\n")
        : (detail ?? "저장 실패");
      await dialog.alert(msg, { title: "오류" });
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/events/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events"] }),
  });

  const renameAttachM = useMutation({
    mutationFn: async ({ eid, aid, name }: { eid: string; aid: string; name: string }) =>
      api.patch(`/events/${eid}/attachments/${aid}`, { file_name: name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["events"] }),
  });

  const deleteAttachM = useMutation({
    mutationFn: async ({ eid, aid }: { eid: string; aid: string }) =>
      api.delete(`/events/${eid}/attachments/${aid}`),
    onSuccess: (_d, vars) => {
      setExistingAttachments((p) => p.filter((a) => a.id !== vars.aid));
      qc.invalidateQueries({ queryKey: ["events"] });
    },
  });

  function startAdd() {
    setForm(BLANK);
    setPendingFiles([]);
    setExistingAttachments([]);
    editingIdRef.current = null;
    setOpen(true);
  }

  function startEdit(r: EventRow) {
    setForm({
      id: r.id,
      kind: r.kind,
      title: r.title,
      address: r.address ?? "",
      start_date: r.start_date,
      end_date: r.end_date,
      // backend 가 Decimal → 문자열로 직렬화. 숫자 0/빈 처리.
      budget: r.budget && Number(r.budget) > 0 ? String(Math.trunc(Number(r.budget))) : "",
      actual_cost: r.actual_cost && Number(r.actual_cost) > 0 ? String(Math.trunc(Number(r.actual_cost))) : "",
      entry_fee: r.entry_fee && Number(r.entry_fee) > 0 ? String(Math.trunc(Number(r.entry_fee))) : "",
      expenses: r.expenses && Number(r.expenses) > 0 ? String(Math.trunc(Number(r.expenses))) : "",
      memo: r.memo ?? "",
      plan: r.plan ?? "",
      flights: r.flights.map((f) => ({
        ...f,
        // numeric(18,2) → 정수 raw digits 로 (입력은 콤마 포맷 표시).
        cost: f.cost ? String(Math.trunc(Number(f.cost))) : "0",
        departure_at: f.departure_at ? f.departure_at.slice(0, 16) : "",
        arrival_at: f.arrival_at ? f.arrival_at.slice(0, 16) : "",
      })),
      lodgings: r.lodgings.map((l) => ({
        ...l,
        address: l.address ?? "",
        phone: l.phone ?? "",
        email: l.email ?? "",
        cost: l.cost ? String(Math.trunc(Number(l.cost))) : "0",
      })),
      participants: r.participants.map((p) => ({ ...p })),
    });
    setPendingFiles([]);
    setExistingAttachments(r.attachments || []);
    editingIdRef.current = r.id;
    setOpen(true);
  }

  async function handleDelete(sel: EventRow[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 이벤트를 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  async function downloadAttachment(eid: string, att: Attachment) {
    const res = await api.get(`/events/${eid}/attachments/${att.id}`, { responseType: "blob" });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    a.click();
    URL.revokeObjectURL(url);
  }

  const columnDefs = useMemo<ColDef<EventRow>[]>(
    () => [
      {
        field: "kind",
        headerName: "종류",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 90,
        flex: 0,
        valueFormatter: (p) => KIND_LABEL[(p.value ?? "WORKSHOP") as Kind],
      },
      {
        field: "title",
        headerName: "제목",
        headerClass: "ag-header-center",
        flex: 60,
        minWidth: 200,
      },
      {
        field: "address",
        headerName: "장소",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 230,
        flex: 0,
        valueFormatter: (p) => p.value || "—",
      },
      { field: "start_date", headerName: "시작일", width: 102, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" } },
      { field: "end_date", headerName: "종료일", width: 102, flex: 0, headerClass: "ag-header-center", cellStyle: { textAlign: "center" } },
      {
        field: "budget",
        headerName: "예산",
        headerClass: "ag-header-center",
        width: 111,
        flex: 0,
        cellClass: "tabular-nums",
        cellStyle: { justifyContent: "flex-end" } as any,
        valueFormatter: (p) => fmtKRW(p.value ?? 0),
      },
      {
        field: "actual_cost",
        headerName: "소요금액",
        headerClass: "ag-header-center",
        width: 111,
        flex: 0,
        cellClass: "tabular-nums",
        cellStyle: { justifyContent: "flex-end" } as any,
        valueFormatter: (p) => fmtKRW(p.value ?? 0),
      },
      {
        colId: "participants_count",
        headerName: "참석자",
        headerClass: "ag-header-center",
        cellStyle: { textAlign: "center" },
        width: 64,
        flex: 0,
        valueGetter: (p) => p.data?.participants?.length ?? 0,
      },
      {
        field: "flights_total",
        headerName: "항공권 합계",
        headerClass: "ag-header-center",
        width: 111,
        flex: 0,
        cellClass: "tabular-nums",
        cellStyle: { justifyContent: "flex-end" } as any,
        valueFormatter: (p) => fmtKRW(p.value ?? 0),
      },
      {
        field: "lodgings_total",
        headerName: "숙박 합계",
        headerClass: "ag-header-center",
        width: 111,
        flex: 0,
        cellClass: "tabular-nums",
        cellStyle: { justifyContent: "flex-end" } as any,
        valueFormatter: (p) => fmtKRW(p.value ?? 0),
      },
      {
        field: "grand_total",
        headerName: "총 합계",
        headerClass: "ag-header-center",
        width: 119,
        flex: 0,
        cellClass: "tabular-nums font-semibold",
        cellStyle: { justifyContent: "flex-end" } as any,
        valueFormatter: (p) => fmtKRW(p.value ?? 0),
      },
    ],
    [],
  );

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
  const inputSm = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";

  return (
    <>
      <DashboardHeader
        title="이벤트"
        actions={
          <div className="flex gap-2 items-center">
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as Kind | "")}
              className="h-8 rounded-md border border-border bg-card shadow-sm px-2 text-sm"
            >
              <option value="">전체</option>
              <option value="WORKSHOP">워크샵</option>
              <option value="CONFERENCE">컨퍼런스</option>
              <option value="BUSINESS_TRIP">출장</option>
            </select>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      />

      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          onRowDoubleClicked={(r) => startEdit(r)}
          onAdd={canManage ? startAdd : undefined}
          onDelete={canManage ? handleDelete : undefined}
          enableCheckbox
          disableFilters
          autoSizeStrategy={{
            type: "fitCellContents",
            colIds: ["kind", "start_date", "end_date", "participants_count"],
          }}
        />
      </div>

      {/* 등록·편집 다이얼로그 */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width="max-w-3xl"
        title={form.id ? "이벤트 편집" : "새 이벤트"}
        footer={
          <>
            {form.id && (
              <button
                type="button"
                onClick={() =>
                  downloadEventPDF({
                    kind: form.kind,
                    title: form.title,
                    address: form.address,
                    start_date: form.start_date,
                    end_date: form.end_date,
                    budget: form.budget,
                    actual_cost: form.actual_cost,
                    entry_fee: form.entry_fee,
                    expenses: form.expenses,
                    flights_total: rows.find((r) => r.id === form.id)?.flights_total ?? 0,
                    lodgings_total: rows.find((r) => r.id === form.id)?.lodgings_total ?? 0,
                    grand_total: rows.find((r) => r.id === form.id)?.grand_total ?? 0,
                    memo: form.memo,
                    plan: form.plan,
                    flights: form.flights,
                    lodgings: form.lodgings,
                    participants: form.participants.map((p) => ({
                      developer_id: p.developer_id ?? null,
                      guest_name: p.guest_name ?? null,
                      display_name: p.developer_id
                        ? (devNameById.get(p.developer_id) ?? null)
                        : (p.guest_name ?? null),
                      phone: p.developer_id
                        ? (devPhoneById.get(p.developer_id) ?? null)
                        : null,
                    })),
                  })
                }
                className="h-9 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
              >
                PDF
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              {canManage ? "취소" : "닫기"}
            </button>
            {canManage && (
              <button
                type="button"
                onClick={() => saveM.mutate()}
                disabled={
                  saveM.isPending || !form.title.trim() || !form.start_date || !form.end_date
                }
                className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
              >
                {saveM.isPending ? "저장 중..." : "저장"}
              </button>
            )}
          </>
        }
      >
        <div className="grid grid-cols-3 gap-3">
          {/* 종류 + 제목 */}
          <Field label="종류 *">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}
              className={input}
              disabled={!canManage}
            >
              <option value="WORKSHOP">워크샵</option>
              <option value="CONFERENCE">컨퍼런스</option>
              <option value="BUSINESS_TRIP">출장</option>
            </select>
          </Field>
          <Field label="제목 *" colSpan={2}>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={input}
              disabled={!canManage}
            />
          </Field>

          {/* 일정 */}
          <Field label="시작일 *">
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              className={input}
              disabled={!canManage}
            />
          </Field>
          <Field label="종료일 *">
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              className={input}
              disabled={!canManage}
            />
          </Field>
          <div />

          {/* 예산 / 소요금액 / 참가비 / 실비 — KRW 한 row 4-col 서브그리드.
              외곽이 3-col 이라 col-span-3 wrapper 안에서 자체 4-col 분할. */}
          <div className="col-span-3 grid grid-cols-4 gap-3">
            <Field label="예산 (KRW)">
              <input
                inputMode="numeric"
                value={commaInt(form.budget)}
                onChange={(e) =>
                  setForm({ ...form, budget: e.target.value.replace(/[^\d]/g, "") })
                }
                className={input + " text-right tabular-nums"}
                placeholder="0"
                disabled={!canManage}
              />
            </Field>
            <Field
              label="소요금액 (KRW)"
              tooltip="실제로 사용한 전체 행사비용 (참가비, 스폰서비용, 부스 운영비용, 경품 등 모두 포함)"
            >
              <input
                inputMode="numeric"
                value={commaInt(form.actual_cost)}
                onChange={(e) =>
                  setForm({ ...form, actual_cost: e.target.value.replace(/[^\d]/g, "") })
                }
                className={input + " text-right tabular-nums"}
                placeholder="0"
                disabled={!canManage}
              />
            </Field>
            <Field
              label="참가비 (KRW)"
              tooltip="컨퍼런스 참가비, 행사 스폰서 비용 등"
            >
              <input
                inputMode="numeric"
                value={commaInt(form.entry_fee)}
                onChange={(e) =>
                  setForm({ ...form, entry_fee: e.target.value.replace(/[^\d]/g, "") })
                }
                className={input + " text-right tabular-nums"}
                placeholder="0"
                disabled={!canManage}
              />
            </Field>
            <Field
              label="실비 (KRW)"
              tooltip="교통비, 식대 등의 실비"
            >
              <input
                inputMode="numeric"
                value={commaInt(form.expenses)}
                onChange={(e) =>
                  setForm({ ...form, expenses: e.target.value.replace(/[^\d]/g, "") })
                }
                className={input + " text-right tabular-nums"}
                placeholder="0"
                disabled={!canManage}
              />
            </Field>
          </div>

          {/* 장소 + 지도 — 입력 옆에 카카오/구글 토글, 그 아래 지도 본문. */}
          <EventAddressField
            address={form.address}
            onChange={(v) => setForm({ ...form, address: v })}
            inputClass={input}
            readOnly={!canManage}
          />
          {/* (위 컴포넌트가 col-span-3 으로 감쌈) */}

          {/* 항공권 */}
          <FlightsSection
            flights={form.flights}
            setFlights={(fs) => setForm({ ...form, flights: fs })}
            readOnly={!canManage}
          />

          {/* 숙박 */}
          <LodgingsSection
            lodgings={form.lodgings}
            setLodgings={(ls) => setForm({ ...form, lodgings: ls })}
            readOnly={!canManage}
          />

          {/* 참석자 */}
          <ParticipantsSection
            participants={form.participants}
            setParticipants={(ps) => setForm({ ...form, participants: ps })}
            developers={developers}
            devNameById={devNameById}
            devGenderById={devGenderById}
            readOnly={!canManage}
          />

          {/* 이벤트 상세 계획 — 일정·준비물·체크리스트 등 자유 입력 (plain text). */}
          <Field label="이벤트 상세 계획" colSpan={3}>
            <textarea
              value={form.plan}
              onChange={(e) => setForm({ ...form, plan: e.target.value })}
              rows={16}
              placeholder="예시) Day 1 — 09:00 출국 / 도착 후 호텔 체크인 / 14:00 키노트 ..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
              disabled={!canManage}
            />
          </Field>

          {/* 메모 — 짧은 요약·비고. */}
          <Field label="메모 (요약)" colSpan={3}>
            <textarea
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={!canManage}
            />
          </Field>

          {/* 첨부 */}
          <Field label="첨부파일" colSpan={3}>
            {canManage && (
              <FileDropZone
                multiple
                label="파일을 끌어놓거나 클릭해서 선택"
                onFiles={(files) => setPendingFiles((p) => [...p, ...files])}
              />
            )}
            {existingAttachments.length > 0 && (
              <ul className="mt-2 space-y-1">
                {existingAttachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-xs border-b border-border/50 py-1">
                    <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                    <button
                      type="button"
                      onClick={() => form.id && downloadAttachment(form.id, a)}
                      className="flex-1 truncate text-left text-primary hover:underline"
                    >
                      {a.file_name}
                    </button>
                    <span className="text-muted-foreground tabular-nums">
                      {a.size ? `${(a.size / 1024).toFixed(1)} KB` : ""}
                    </span>
                    {form.id && (
                      <AttachmentPreviewButton
                        filename={a.file_name}
                        mime={a.mime_type}
                        downloadPath={`/events/${form.id}/attachments/${a.id}`}
                      />
                    )}
                    {canManage && (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!form.id) return;
                            const next = await dialog.prompt("파일 이름", { defaultValue: a.file_name });
                            if (!next || !next.trim() || next === a.file_name) return;
                            renameAttachM.mutate({ eid: form.id, aid: a.id, name: next.trim() });
                            setExistingAttachments((p) =>
                              p.map((x) => (x.id === a.id ? { ...x, file_name: next.trim() } : x)),
                            );
                          }}
                          className="text-primary hover:underline inline-flex items-center gap-0.5"
                        >
                          <Pencil className="h-3 w-3" />
                          이름
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!form.id) return;
                            const ok = await dialog.confirm("이 첨부를 삭제하시겠습니까?", {
                              destructive: true,
                            });
                            if (ok) deleteAttachM.mutate({ eid: form.id, aid: a.id });
                          }}
                          className="text-destructive hover:underline inline-flex items-center gap-0.5"
                        >
                          <X className="h-3 w-3" />
                          삭제
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && pendingFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pendingFiles.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs border-b border-border/50 py-1">
                    <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {(f.size / 1024).toFixed(1)} KB
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingFiles((p) => p.filter((_, idx) => idx !== i))}
                      className="text-destructive hover:underline inline-flex items-center gap-0.5"
                    >
                      <X className="h-3 w-3" />
                      제거
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-sections
// ---------------------------------------------------------------------------

function FlightsSection({
  flights,
  setFlights,
  readOnly = false,
}: {
  flights: Flight[];
  setFlights: (fs: Flight[]) => void;
  readOnly?: boolean;
}) {
  function add() {
    setFlights([
      ...flights,
      { cost: "0" } as Flight,
    ]);
  }
  function update(i: number, patch: Partial<Flight>) {
    setFlights(flights.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function remove(i: number) {
    setFlights(flights.filter((_, idx) => idx !== i));
  }
  const cell = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";
  return (
    <fieldset
      disabled={readOnly}
      className="col-span-3 mt-2 pt-3 border-0 border-t border-border space-y-2 p-0 m-0 [&[disabled]_input]:opacity-60 [&[disabled]_select]:opacity-60 [&[disabled]_textarea]:opacity-60"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">항공권 ({flights.length})</h4>
        {!readOnly && (
          <button
            type="button"
            onClick={add}
            className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
          >
            <Plus className="h-3 w-3" /> 추가
          </button>
        )}
      </div>
      {flights.map((f, i) => (
        <div key={i} className="rounded-md border border-border p-3 space-y-2 bg-muted/20">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">항공권 #{i + 1}</span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-destructive text-xs hover:underline inline-flex items-center gap-0.5"
              >
                <Trash2 className="h-3 w-3" /> 삭제
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <SmField label="항공사">
              <input value={f.airline ?? ""} onChange={(e) => update(i, { airline: e.target.value })} className={cell} />
            </SmField>
            <SmField
              label="예약번호 (PNR)"
              tooltip="항공권이 많은 경우 상세 정보에 추가하시기 바랍니다."
            >
              <input value={f.booking_ref ?? ""} onChange={(e) => update(i, { booking_ref: e.target.value })} className={cell} />
            </SmField>
            <SmField
              label="항공권 번호 (eTicket)"
              tooltip="항공권이 많은 경우 상세 정보에 추가하시기 바랍니다."
            >
              <input value={f.ticket_no ?? ""} onChange={(e) => update(i, { ticket_no: e.target.value })} className={cell} />
            </SmField>
            <SmField label="편명">
              <input value={f.flight_no ?? ""} onChange={(e) => update(i, { flight_no: e.target.value })} className={cell} />
            </SmField>
            <SmField label="좌석등급">
              <select value={f.seat_class ?? ""} onChange={(e) => update(i, { seat_class: e.target.value })} className={cell}>
                <option value="">—</option>
                <option value="ECONOMY">Economy</option>
                <option value="PREMIUM_ECONOMY">Premium Economy</option>
                <option value="BUSINESS">Business</option>
                <option value="FIRST">First</option>
              </select>
            </SmField>
            <SmField label="비용 (KRW)">
              <input
                inputMode="numeric"
                value={commaInt(typeof f.cost === "string" ? f.cost : String(f.cost ?? ""))}
                onChange={(e) => update(i, { cost: e.target.value.replace(/[^\d]/g, "") })}
                className={cell + " text-right tabular-nums"}
              />
            </SmField>
            <SmField label="출발 공항">
              <input value={f.departure_airport ?? ""} onChange={(e) => update(i, { departure_airport: e.target.value })} placeholder="ICN / Incheon" className={cell} />
            </SmField>
            <SmField label="출발 터미널">
              <input value={f.departure_terminal ?? ""} onChange={(e) => update(i, { departure_terminal: e.target.value })} className={cell} />
            </SmField>
            <SmField label="출발 시간">
              <input
                type="datetime-local"
                value={f.departure_at ?? ""}
                onChange={(e) => update(i, { departure_at: e.target.value })}
                className={cell}
              />
            </SmField>
            <SmField label="도착 공항">
              <input value={f.arrival_airport ?? ""} onChange={(e) => update(i, { arrival_airport: e.target.value })} placeholder="LAX / Los Angeles" className={cell} />
            </SmField>
            <SmField label="도착 터미널">
              <input value={f.arrival_terminal ?? ""} onChange={(e) => update(i, { arrival_terminal: e.target.value })} className={cell} />
            </SmField>
            <SmField label="도착 시간">
              <input
                type="datetime-local"
                value={f.arrival_at ?? ""}
                onChange={(e) => update(i, { arrival_at: e.target.value })}
                className={cell}
              />
            </SmField>
            <SmField label="메모" colSpan={3}>
              <input value={f.memo ?? ""} onChange={(e) => update(i, { memo: e.target.value })} className={cell} />
            </SmField>
          </div>
        </div>
      ))}
    </fieldset>
  );
}

function LodgingsSection({
  lodgings,
  setLodgings,
  readOnly = false,
}: {
  lodgings: Lodging[];
  setLodgings: (ls: Lodging[]) => void;
  readOnly?: boolean;
}) {
  function add() {
    setLodgings([...lodgings, { cost: "0" } as Lodging]);
  }
  function updateAt(i: number, patch: Partial<Lodging>) {
    setLodgings(lodgings.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function remove(i: number) {
    setLodgings(lodgings.filter((_, idx) => idx !== i));
  }
  return (
    <fieldset
      disabled={readOnly}
      className="col-span-3 mt-2 pt-3 border-0 border-t border-border space-y-2 p-0 m-0 [&[disabled]_input]:opacity-60 [&[disabled]_select]:opacity-60 [&[disabled]_textarea]:opacity-60"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">숙박 ({lodgings.length})</h4>
        {!readOnly && (
          <button
            type="button"
            onClick={add}
            className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
          >
            <Plus className="h-3 w-3" /> 추가
          </button>
        )}
      </div>
      {lodgings.map((l, i) => (
        <LodgingItem
          key={i}
          index={i}
          lodging={l}
          onUpdate={(patch) => updateAt(i, patch)}
          onRemove={() => remove(i)}
          readOnly={readOnly}
        />
      ))}
    </fieldset>
  );
}

/**
 * 숙박 1건 — 호텔명/주소+지도/체크인/체크아웃/비용/전화·이메일/메모.
 *
 * `useAddressMapState` 가 hook 이라 각 row 마다 컴포넌트로 분리해 호출.
 * 동시에 여러 호텔의 지도를 펼쳐 비교하는 케이스도 자연스럽게 동작.
 */
function LodgingItem({
  index,
  lodging,
  onUpdate,
  onRemove,
  readOnly = false,
}: {
  index: number;
  lodging: Lodging;
  onUpdate: (patch: Partial<Lodging>) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const cell = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";
  const mapState = useAddressMapState(lodging.address ?? "");
  return (
    <div className="rounded-md border border-border p-3 space-y-2 bg-muted/20">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">숙박 #{index + 1}</span>
        {!readOnly && (
          <button
            type="button"
            onClick={onRemove}
            className="text-destructive text-xs hover:underline inline-flex items-center gap-0.5"
          >
            <Trash2 className="h-3 w-3" /> 삭제
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <SmField label="호텔명" colSpan={3}>
          <input
            value={lodging.name ?? ""}
            onChange={(e) => onUpdate({ name: e.target.value })}
            className={cell}
          />
        </SmField>
        {/* 주소 + 지도 토글 (입력 우측 인라인). */}
        <SmField label="주소" colSpan={3}>
          <div className="flex items-stretch gap-2">
            <input
              value={lodging.address ?? ""}
              onChange={(e) => onUpdate({ address: e.target.value })}
              className={cell + " flex-1"}
              placeholder="예: 서울 중구 ..."
            />
            <AddressMapButtons state={mapState} />
          </div>
          <AddressMapDisplay state={mapState} />
        </SmField>
        <SmField label="체크인">
          <input
            type="date"
            value={lodging.check_in_date ?? ""}
            onChange={(e) => onUpdate({ check_in_date: e.target.value })}
            className={cell}
          />
        </SmField>
        <SmField label="체크아웃">
          <input
            type="date"
            value={lodging.check_out_date ?? ""}
            onChange={(e) => onUpdate({ check_out_date: e.target.value })}
            className={cell}
          />
        </SmField>
        <SmField label="비용 (KRW)">
          <input
            inputMode="numeric"
            value={commaInt(typeof lodging.cost === "string" ? lodging.cost : String(lodging.cost ?? ""))}
            onChange={(e) => onUpdate({ cost: e.target.value.replace(/[^\d]/g, "") })}
            className={cell + " text-right tabular-nums"}
          />
        </SmField>
        {/* 전화 + 이메일 — 한 row 에 50/50. */}
        <div className="col-span-3 grid grid-cols-2 gap-2">
          <SmField label="전화번호">
            <input
              value={lodging.phone ?? ""}
              onChange={(e) => onUpdate({ phone: e.target.value })}
              className={cell}
              placeholder="+82-2-1234-5678"
            />
          </SmField>
          <SmField label="이메일">
            <input
              type="email"
              value={lodging.email ?? ""}
              onChange={(e) => onUpdate({ email: e.target.value })}
              className={cell}
              placeholder="reservation@hotel.com"
            />
          </SmField>
        </div>
        <SmField label="메모" colSpan={3}>
          <input
            value={lodging.memo ?? ""}
            onChange={(e) => onUpdate({ memo: e.target.value })}
            className={cell}
          />
        </SmField>
      </div>
    </div>
  );
}

/**
 * 이벤트 장소 (주소) 필드 — input 옆에 카카오/구글 토글, 그 아래 지도.
 */
function EventAddressField({
  address,
  onChange,
  inputClass,
  readOnly = false,
}: {
  address: string;
  onChange: (v: string) => void;
  inputClass: string;
  readOnly?: boolean;
}) {
  const mapState = useAddressMapState(address);
  return (
    <div className="col-span-3">
      <label className="block text-xs font-medium text-muted-foreground mb-1">장소 (주소)</label>
      <div className="flex items-stretch gap-2">
        <input
          value={address}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass + " flex-1"}
          placeholder="예: 서울특별시 강남구 ..."
          disabled={readOnly}
        />
        <AddressMapButtons state={mapState} />
      </div>
      <AddressMapDisplay state={mapState} />
    </div>
  );
}

function ParticipantsSection({
  participants,
  setParticipants,
  developers,
  devNameById,
  devGenderById,
  readOnly = false,
}: {
  participants: Participant[];
  setParticipants: (ps: Participant[]) => void;
  developers: Developer[];
  devNameById: Map<string, string>;
  devGenderById: Map<string, "M" | "F">;
  readOnly?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [guestName, setGuestName] = useState("");

  function addDeveloper(devId: string) {
    if (participants.some((p) => p.developer_id === devId)) return;
    const gender = devGenderById.get(devId) ?? null;
    setParticipants([...participants, { developer_id: devId, gender }]);
  }
  function addGuest() {
    const name = guestName.trim();
    if (!name) return;
    setParticipants([...participants, { guest_name: name }]);
    setGuestName("");
  }
  function remove(i: number) {
    setParticipants(participants.filter((_, idx) => idx !== i));
  }

  const filtered = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return developers
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .filter((d) => !participants.some((p) => p.developer_id === d.id))
      .slice(0, 30);
  }, [developers, pickerQuery, participants]);

  return (
    <div className="col-span-3 mt-2 pt-3 border-t border-border space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">참석자 ({participants.length})</h4>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted"
          >
            <Plus className="h-3 w-3" /> 사내 직원 추가
          </button>
        )}
      </div>
      {/* 선택된 참석자 chip 리스트 — 여자(F) 는 빨강 배경, 남자/미상은 기본 색상 */}
      <div className="flex flex-wrap gap-1.5">
        {participants.map((p, i) => {
          const label = p.developer_id
            ? (devNameById.get(p.developer_id) ?? "(직원)")
            : (p.guest_name ?? "");
          // server 가 채운 gender 우선, 누락 시 directory 캐시에서 폴백.
          const gender =
            p.gender ?? (p.developer_id ? devGenderById.get(p.developer_id) ?? null : null);
          const cls = !p.developer_id
            ? "border-border bg-muted/40"
            : gender === "F"
              ? "border-rose-300 bg-rose-100 text-rose-900"
              : "border-primary/30 bg-primary/5";
          return (
            <span
              key={i}
              className={
                "inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs " + cls
              }
            >
              {label}
              {!p.developer_id && (
                <span className="text-[9px] text-muted-foreground">(외부)</span>
              )}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })}
        {participants.length === 0 && (
          <span className="text-[11px] text-muted-foreground">참석자 없음</span>
        )}
      </div>

      {!readOnly && pickerOpen && (
        <div className="rounded-md border border-border p-3 bg-muted/10 space-y-2">
          <input
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            placeholder="사내 직원 검색..."
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            autoFocus
          />
          <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
            {filtered.map((d) => {
              const cls = d.gender === "F"
                ? "border-rose-300 bg-rose-100 text-rose-900 hover:bg-rose-200"
                : "border-border bg-background hover:bg-muted";
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    addDeveloper(d.id);
                    setPickerQuery("");
                  }}
                  className={"px-2 py-1 rounded border text-xs " + cls}
                >
                  {d.name}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <span className="text-[11px] text-muted-foreground">검색 결과 없음</span>
            )}
          </div>
        </div>
      )}

      {/* 외부 게스트 입력 — read-only 시 숨김. */}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <input
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addGuest();
              }
            }}
            placeholder="외부 참석자 이름 (Enter 로 추가)"
            className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          />
          <button
            type="button"
            onClick={addGuest}
            disabled={!guestName.trim()}
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
          >
            <Plus className="h-3 w-3" /> 추가
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  colSpan,
  tooltip,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  // 네이티브 브라우저 툴팁 — 라벨에 hover 하면 표시 (별도 JS 라이브러리 X).
  tooltip?: string;
  children: React.ReactNode;
}) {
  const cls = colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">
        {label}
        {tooltip ? (
          <span className="relative ml-1 text-muted-foreground/60">
            ⓘ
            <Tooltip label={tooltip} side="top" inline />
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function SmField({
  label,
  colSpan,
  tooltip,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const cls = colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-0.5 " + cls}>
      <span className="text-[10px] text-muted-foreground">
        {label}
        {tooltip ? (
          <span className="relative ml-1 text-muted-foreground/60">
            ⓘ
            <Tooltip label={tooltip} side="top" inline />
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}
