"use client";

/**
 * 도서 — 회사 도서 대장 + 임대 추적.
 *
 * - 모든 임직원 열람. CRUD 는 HR/ADMIN.
 * - 검색 (title/publisher/category/임대인 ilike) + 등록·편집·삭제.
 * - 1권 = 1 row. 임대 이력 보존하지 않음 — 현재 임대인만 컬럼.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";

import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, type DataGridHandle } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";
import { sortDevelopersKo } from "@/lib/sort-developers";
import { useRef } from "react";

type Book = {
  id: string;
  title: string;
  location: string | null;
  publisher: string | null;
  category: string | null;
  price: number | null;
  borrower_id: string | null;
  borrower_name: string | null;
  borrowed_at: string | null;
  due_date: string | null;
  registered_at: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type DevLite = {
  id: string;
  name: string;
  title?: string | null;
};

const BLANK_FORM = {
  title: "",
  location: "",
  publisher: "",
  category: "",
  price: "",
  borrower_id: "",
  due_date: "",
  registered_at: "",
  note: "",
};

function fmtKrw(v: number | null): string {
  if (v == null) return "-";
  return Number(v).toLocaleString("en-US") + "원";
}

export default function BooksPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<Book>>(null);

  const { data: me } = useQuery<{ role: string }>({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/auth/me")).data,
    staleTime: 60_000,
  });
  const canManage = me?.role === "ADMIN" || me?.role === "HR";

  const [q, setQ] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);

  const { data: rows = [], isLoading } = useQuery<Book[]>({
    queryKey: ["books", q],
    queryFn: async () =>
      (await api.get("/books", { params: q ? { q } : undefined })).data,
    staleTime: 30_000,
  });

  // 등록/편집 다이얼로그
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Book | null>(null);
  const [form, setForm] = useState({ ...BLANK_FORM });

  function openAdd() {
    setEditTarget(null);
    setForm({ ...BLANK_FORM });
    setEditOpen(true);
  }
  function openEdit(b: Book) {
    if (!canManage) return;
    setEditTarget(b);
    setForm({
      title: b.title,
      location: b.location ?? "",
      publisher: b.publisher ?? "",
      category: b.category ?? "",
      price: b.price != null ? String(b.price) : "",
      borrower_id: b.borrower_id ?? "",
      due_date: b.due_date ?? "",
      registered_at: b.registered_at ?? "",
      note: b.note ?? "",
    });
    setEditOpen(true);
  }

  const saveM = useMutation({
    mutationFn: async () => {
      if (!form.title.trim()) throw new Error("제목을 입력하세요.");
      const body = {
        title: form.title.trim(),
        location: form.location.trim() || null,
        publisher: form.publisher.trim() || null,
        category: form.category.trim() || null,
        price: form.price ? Number(form.price.replace(/[^\d]/g, "")) : null,
        borrower_id: form.borrower_id || null,
        // borrower_id 가 있는데 borrowed_at 없으면 now 자동.
        borrowed_at:
          form.borrower_id && !editTarget?.borrowed_at
            ? new Date().toISOString()
            : editTarget?.borrowed_at ?? null,
        due_date: form.due_date || null,
        registered_at: form.registered_at || null,
        note: form.note || null,
      };
      // borrower 가 빈 값이면 borrowed_at 도 같이 클리어 (반납).
      if (!form.borrower_id) body.borrowed_at = null;
      if (editTarget) {
        return (await api.patch(`/books/${editTarget.id}`, body)).data;
      }
      return (await api.post("/books", body)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["books"] });
      setEditOpen(false);
    },
    onError: async (e: any) =>
      dialog.alert(e?.response?.data?.detail ?? e?.message ?? "저장 실패", {
        title: "오류",
      }),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/books/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["books"] }),
  });

  async function handleDelete() {
    const sel = gridRef.current?.getSelectedRows() ?? [];
    if (sel.length === 0) return;
    const borrowed = sel.filter((b) => b.borrower_id).length;
    const msg =
      borrowed > 0
        ? `선택된 ${sel.length}권 중 ${borrowed}권이 임대 중입니다. 그래도 삭제하시겠습니까?`
        : `선택된 ${sel.length}권을 삭제하시겠습니까?`;
    const ok = await dialog.confirm(msg, {
      title: "도서 삭제",
      confirmText: "삭제",
    });
    if (!ok) return;
    await deleteM.mutateAsync(sel.map((b) => b.id));
  }

  // 임대인 picker 후보 — 정규직 directory.
  const { data: developers = [] } = useQuery<DevLite[]>({
    queryKey: ["developers", "directory", "FULL_TIME"],
    queryFn: async () =>
      (
        await api.get("/developers/directory", {
          params: { employment_type: "FULL_TIME" },
        })
      ).data,
    staleTime: 5 * 60_000,
    enabled: editOpen,
  });
  const sortedDevs = useMemo(
    () => sortDevelopersKo(developers),
    [developers],
  );

  const columnDefs = useMemo<ColDef<Book>[]>(
    () => [
      {
        field: "title",
        headerName: "제목",
        flex: 1.5,
        sortable: true,
        headerClass: "ag-center-aligned-header",
      },
      {
        field: "location",
        headerName: "위치",
        width: 160,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "publisher",
        headerName: "출판사",
        width: 160,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "category",
        headerName: "분야",
        width: 120,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => p.value ?? "-",
        cellStyle: { textAlign: "center" } as any,
      },
      {
        field: "price",
        headerName: "가격",
        width: 100,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => fmtKrw(p.value),
        cellStyle: { textAlign: "right" } as any,
      },
      {
        field: "borrower_name",
        headerName: "임대인",
        width: 120,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) => p.value ?? "—",
        cellStyle: (p: any) =>
          ({
            textAlign: "center",
            color: p.value ? undefined : "rgb(148 163 184)",
          }) as any,
      },
      {
        field: "registered_at",
        headerName: "등록일",
        width: 110,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        valueFormatter: (p) =>
          p.value ? String(p.value).slice(0, 10) : "-",
        cellStyle: { textAlign: "center" } as any,
      },
    ],
    [],
  );

  return (
    <>
      <DashboardHeader title="도서" />
      <div className="flex flex-1 flex-col p-4 min-h-0">
        <DataGrid<Book>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="제목·출판사·분야·임대인 검색"
          onSearch={(v) => setQ(v)}
          onAdd={canManage ? openAdd : undefined}
          onDelete={canManage ? handleDelete : undefined}
          onRowDoubleClicked={canManage ? openEdit : undefined}
          onSelectionChange={setSelectedCount}
        />
        {isLoading && (
          <div className="text-xs text-muted-foreground py-2">로딩 중…</div>
        )}
      </div>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editTarget ? "도서 수정" : "신규 도서 등록"}
        width="max-w-xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              disabled={saveM.isPending}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => saveM.mutate()}
              disabled={saveM.isPending}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="제목" colSpan={2}>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={inputCls}
              placeholder="도서 제목"
            />
          </Field>
          <Field label="위치" colSpan={2}>
            <input
              value={form.location}
              onChange={(e) =>
                setForm({ ...form, location: e.target.value })
              }
              className={inputCls}
              placeholder="비치 위치 (예: 회의실 책장 A-2)"
            />
          </Field>
          <Field label="출판사">
            <input
              value={form.publisher}
              onChange={(e) =>
                setForm({ ...form, publisher: e.target.value })
              }
              className={inputCls}
            />
          </Field>
          <Field label="분야">
            <input
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value })
              }
              className={inputCls}
              placeholder="자유 입력 (개발 / 경영 / 자기계발 등)"
            />
          </Field>
          <Field label="가격 (KRW)">
            <input
              value={
                form.price
                  ? Number(form.price.replace(/[^\d]/g, "")).toLocaleString(
                      "en-US",
                    )
                  : ""
              }
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d]/g, "");
                setForm({ ...form, price: raw });
              }}
              className={inputCls + " text-right tabular-nums"}
              placeholder="0"
              inputMode="numeric"
            />
          </Field>
          <Field label="등록일">
            <input
              type="date"
              value={form.registered_at}
              onChange={(e) =>
                setForm({ ...form, registered_at: e.target.value })
              }
              className={inputCls}
            />
          </Field>
          <Field label="임대인" colSpan={2}>
            <select
              value={form.borrower_id}
              onChange={(e) =>
                setForm({ ...form, borrower_id: e.target.value })
              }
              className={inputCls}
            >
              <option value="">— 미대여 —</option>
              {sortedDevs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.title ? ` · ${d.title}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="반납 예정일">
            <input
              type="date"
              value={form.due_date}
              onChange={(e) =>
                setForm({ ...form, due_date: e.target.value })
              }
              disabled={!form.borrower_id}
              className={inputCls + " disabled:opacity-50"}
            />
          </Field>
          <Field label="비고" colSpan={2}>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              className={inputCls + " resize-none"}
              placeholder="ISBN / 메모 등"
            />
          </Field>
        </div>
      </Dialog>

      {/* 미사용 변수 회피 (린트). */}
      {void selectedCount}
    </>
  );
}

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

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
