"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColDef } from "ag-grid-community";
import { Plus, Save, QrCode } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid, type DataGridHandle } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { DateInput } from "@/components/ui/DateInput";
import { useDialog } from "@/components/ui/DialogProvider";
import { PrintQrDialog } from "@/components/assets/PrintQrDialog";
import { sortDevelopersKo } from "@/lib/sort-developers";
import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABEL,
  ASSET_STATUS_BADGE,
  ASSET_STATUS_LABEL,
  type AssetCategory,
  type AssetStatus,
} from "@/lib/asset-categories";

type Asset = {
  id: string;
  asset_no: string;
  category: AssetCategory;
  manufacturer: string | null;
  model_name: string | null;
  serial_no: string | null;
  spec: string | null;
  purchase_date: string | null;
  purchase_vendor: string | null;
  purchase_price: string | number | null;
  warranty_expires: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_tag: string | null;
  status: AssetStatus;
  location: string | null;
  memo: string | null;
  photo_name: string | null;
  has_photo: boolean;
  created_at: string;
  updated_at: string;
};

type AssetPage = {
  items: Asset[];
  total: number;
  page: number;
  page_size: number;
};

type DevOpt = { id: string; name: string; tag: string | null; email: string | null };

type AssetForm = {
  category: AssetCategory;
  manufacturer: string;
  model_name: string;
  serial_no: string;
  spec: string;
  purchase_date: string;
  purchase_vendor: string;
  purchase_price: string;
  warranty_expires: string;
  owner_id: string;
  status: AssetStatus;
  location: string;
  memo: string;
};

const BLANK: AssetForm = {
  category: "LAPTOP",
  manufacturer: "",
  model_name: "",
  serial_no: "",
  spec: "",
  purchase_date: "",
  purchase_vendor: "",
  purchase_price: "",
  warranty_expires: "",
  owner_id: "",
  status: "IN_USE",
  location: "",
  memo: "",
};

function formatKRW(v: string | number | null): string {
  if (v == null || v === "") return "-";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return "-";
  return n.toLocaleString("ko-KR");
}

function formatPriceInput(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? Number(digits).toLocaleString("ko-KR") : "";
}

function parsePriceInput(display: string): string {
  return display.replace(/[^\d]/g, "");
}

export default function AssetsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const gridRef = useRef<DataGridHandle<Asset>>(null);

  // 필터 상태
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory | "">("");
  const [statusFilter, setStatusFilter] = useState<AssetStatus | "ALL" | "">("");

  // QR 라벨 인쇄 — 선택된 자산을 담아 다이얼로그를 연다.
  const [printAssets, setPrintAssets] = useState<Asset[]>([]);
  const [printOpen, setPrintOpen] = useState(false);

  // 서버 페이지네이션 — 필터 변경 시 1페이지로 리셋.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const filterKey = `${q}|${categoryFilter}|${statusFilter}`;
  const lastFilterKeyRef = useRef(filterKey);
  if (lastFilterKeyRef.current !== filterKey) {
    lastFilterKeyRef.current = filterKey;
    if (page !== 1) setPage(1);
  }

  const { data: pageData } = useQuery<AssetPage>({
    queryKey: ["assets", q, categoryFilter, statusFilter, page, pageSize],
    queryFn: async () =>
      (
        await api.get("/assets", {
          params: {
            q: q || undefined,
            category: categoryFilter || undefined,
            status_: statusFilter === "ALL" ? undefined : statusFilter || undefined,
            include_disposed: statusFilter === "ALL",
            page,
            page_size: pageSize,
          },
        })
      ).data,
    placeholderData: (prev) => prev,
  });

  const rows: Asset[] = pageData?.items ?? [];

  // 소유자 픽커용 directory (활성 임직원 전체).
  const { data: devs = [] } = useQuery<DevOpt[]>({
    queryKey: ["devs-directory-all"],
    queryFn: async () => (await api.get("/developers/directory")).data,
    staleTime: 5 * 60 * 1000,
  });

  const columnDefs = useMemo<ColDef<Asset>[]>(
    () => [
      {
        field: "asset_no",
        headerName: "자산번호",
        pinned: "left",
        cellRenderer: (p: any) => (
          <Link
            href={`/assets/${p.data.id}`}
            className="text-primary hover:underline font-mono"
          >
            {p.value}
          </Link>
        ),
      },
      {
        field: "category",
        headerName: "카테고리",
        valueFormatter: (p: any) => ASSET_CATEGORY_LABEL[p.value as AssetCategory] ?? p.value,
      },
      { field: "manufacturer", headerName: "제조사" },
      { field: "model_name", headerName: "제품명" },
      { field: "serial_no", headerName: "일련번호" },
      {
        headerName: "소유자",
        valueGetter: (p: any) =>
          p.data.owner_name
            ? p.data.owner_name + (p.data.owner_tag ? ` [${p.data.owner_tag}]` : "")
            : "-",
      },
      { field: "location", headerName: "위치" },
      { field: "purchase_date", headerName: "구입일" },
      {
        field: "purchase_price",
        headerName: "구입가",
        valueFormatter: (p: any) => formatKRW(p.value),
        cellStyle: { textAlign: "right" } as any,
      },
      { field: "warranty_expires", headerName: "AS 만료" },
      {
        field: "status",
        headerName: "상태",
        cellRenderer: (p: any) => (
          <Badge className={ASSET_STATUS_BADGE[p.value as AssetStatus] ?? ""}>
            {ASSET_STATUS_LABEL[p.value as AssetStatus] ?? p.value}
          </Badge>
        ),
        cellStyle: { display: "flex", alignItems: "center" } as any,
      },
    ],
    [],
  );

  // Add dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AssetForm>(BLANK);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Asset | null>(null);
  const [editForm, setEditForm] = useState<AssetForm>(BLANK);
  const [editError, setEditError] = useState<string | null>(null);

  const createM = useMutation({
    mutationFn: async () => {
      const payload = toPayload(addForm);
      return (await api.post("/assets", payload)).data as Asset;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assets"] });
      setAddOpen(false);
      setAddForm(BLANK);
      setAddError(null);
    },
    onError: (e: any) => setAddError(e?.response?.data?.detail ?? "등록 실패"),
  });

  const updateM = useMutation({
    mutationFn: async () => {
      if (!editTarget) return null;
      const payload = toPayload(editForm);
      return (await api.patch(`/assets/${editTarget.id}`, payload)).data as Asset;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assets"] });
      setEditOpen(false);
      setEditTarget(null);
      setEditError(null);
    },
    onError: (e: any) => setEditError(e?.response?.data?.detail ?? "수정 실패"),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/assets/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assets"] }),
  });

  function openEdit(row: Asset) {
    setEditTarget(row);
    setEditForm({
      category: row.category,
      manufacturer: row.manufacturer ?? "",
      model_name: row.model_name ?? "",
      serial_no: row.serial_no ?? "",
      spec: row.spec ?? "",
      purchase_date: row.purchase_date ?? "",
      purchase_vendor: row.purchase_vendor ?? "",
      purchase_price: row.purchase_price == null ? "" : String(row.purchase_price),
      warranty_expires: row.warranty_expires ?? "",
      owner_id: row.owner_id ?? "",
      status: row.status,
      location: row.location ?? "",
      memo: row.memo ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  async function handleDelete(selected: Asset[]) {
    if (selected.length === 0) return;
    const active = selected.filter((a) => a.status !== "DISPOSED");
    if (active.length === 0) {
      await dialog.alert("이미 폐기 상태인 자산만 선택되었습니다.");
      return;
    }
    const ok = await dialog.confirm(
      `선택한 ${active.length}건을 폐기 상태로 변경합니다.\n(이력은 그대로 남습니다.)`,
      { destructive: true },
    );
    if (ok) deleteM.mutate(active.map((a) => a.id));
  }

  return (
    <>
      <DashboardHeader title="회사 자산" />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as AssetCategory | "")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">전체 카테고리</option>
            {ASSET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ASSET_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AssetStatus | "ALL" | "")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">미폐기만</option>
            <option value="IN_USE">사용중</option>
            <option value="IN_STORAGE">보관</option>
            <option value="ALL">전체 (폐기 포함)</option>
          </select>
          <div className="flex-1" />
          <button
            type="button"
            onClick={async () => {
              const rows = gridRef.current?.getSelectedRows() ?? [];
              if (rows.length === 0) {
                await dialog.alert(
                  "QR 라벨을 인쇄할 자산을 먼저 체크박스로 선택하세요.",
                );
                return;
              }
              setPrintAssets(rows);
              setPrintOpen(true);
            }}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <QrCode className="h-4 w-4" />
            QR 라벨 인쇄
          </button>
        </div>

        <DataGrid<Asset>
          ref={gridRef}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          searchPlaceholder="자산번호, 제조사, 제품명, 일련번호, 위치 검색"
          autoSizeStrategy={{ type: "fitCellContents" }}
          onSearch={setQ}
          onAdd={() => {
            setAddForm(BLANK);
            setAddError(null);
            setAddOpen(true);
          }}
          onDelete={handleDelete}
          onRowDoubleClicked={openEdit}
          serverPagination={{
            page,
            pageSize,
            totalCount: pageData?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: (n) => {
              setPageSize(n);
              setPage(1);
            },
            pageSizeOptions: [20, 50, 100, 200, 500],
          }}
        />
      </div>

      {/* Add Dialog */}
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="신규 자산 등록"
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
              onClick={() => createM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Plus className="h-4 w-4" />
              등록
            </button>
          </>
        }
      >
        <AssetFormBody
          form={addForm}
          setForm={setAddForm}
          devs={devs}
          error={addError}
          isCreate
        />
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`자산 수정 ${editTarget?.asset_no ?? ""}`}
        width="max-w-2xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => updateM.mutate()}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </>
        }
      >
        <AssetFormBody
          form={editForm}
          setForm={setEditForm}
          devs={devs}
          error={editError}
        />
      </Dialog>

      {/* QR 라벨 PDF 생성 다이얼로그 — 선택된 행의 asset_no 만 전달. */}
      <PrintQrDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        assets={printAssets}
      />
    </>
  );

  // --- payload helper ---
  function toPayload(f: AssetForm): Record<string, unknown> {
    return {
      category: f.category,
      manufacturer: f.manufacturer || null,
      model_name: f.model_name || null,
      serial_no: f.serial_no || null,
      spec: f.spec || null,
      purchase_date: f.purchase_date || null,
      purchase_vendor: f.purchase_vendor || null,
      purchase_price: f.purchase_price || null,
      warranty_expires: f.warranty_expires || null,
      owner_id: f.owner_id || null,
      status: f.status,
      location: f.location || null,
      memo: f.memo || null,
    };
  }
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center h-5 rounded border px-1.5 text-[11px] font-medium leading-none ${className}`}
    >
      {children}
    </span>
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
    <label className={`flex flex-col gap-1 ${colSpan === 2 ? "col-span-2" : ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function AssetFormBody({
  form,
  setForm,
  devs,
  error,
  isCreate,
}: {
  form: AssetForm;
  setForm: (f: AssetForm | ((prev: AssetForm) => AssetForm)) => void;
  devs: DevOpt[];
  error: string | null;
  isCreate?: boolean;
}) {
  const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="카테고리 *">
        <select
          value={form.category}
          onChange={(e) =>
            setForm((p) => ({ ...p, category: e.target.value as AssetCategory }))
          }
          className={input}
        >
          {ASSET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {ASSET_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="상태">
        <select
          value={form.status}
          onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as AssetStatus }))}
          className={input}
        >
          <option value="IN_USE">사용중</option>
          <option value="IN_STORAGE">보관</option>
          <option value="DISPOSED">폐기</option>
        </select>
      </Field>

      <Field label="제조사">
        <input
          value={form.manufacturer}
          onChange={(e) => setForm((p) => ({ ...p, manufacturer: e.target.value }))}
          placeholder="예: Apple / Samsung"
          className={input}
        />
      </Field>
      <Field label="제품명">
        <input
          value={form.model_name}
          onChange={(e) => setForm((p) => ({ ...p, model_name: e.target.value }))}
          placeholder='예: MacBook Pro 16"'
          className={input}
        />
      </Field>

      <Field label="일련번호" colSpan={2}>
        <input
          value={form.serial_no}
          onChange={(e) => setForm((p) => ({ ...p, serial_no: e.target.value }))}
          className={input}
        />
      </Field>

      <Field label="상세 사양" colSpan={2}>
        <textarea
          value={form.spec}
          onChange={(e) => setForm((p) => ({ ...p, spec: e.target.value }))}
          placeholder="예: 16GB RAM · 512GB SSD · M3 Pro"
          className={input + " min-h-[60px]"}
        />
      </Field>

      <Field label="구입일">
        <DateInput
          value={form.purchase_date}
          onChange={(v) => setForm((p) => ({ ...p, purchase_date: v }))}
        />
      </Field>
      <Field label="구입가 (원)">
        <input
          type="text"
          inputMode="numeric"
          value={formatPriceInput(form.purchase_price)}
          onChange={(e) =>
            setForm((p) => ({ ...p, purchase_price: parsePriceInput(e.target.value) }))
          }
          placeholder="예: 3,500,000"
          className={input + " tabular-nums"}
        />
      </Field>
      <Field label="구입처">
        <input
          value={form.purchase_vendor}
          onChange={(e) => setForm((p) => ({ ...p, purchase_vendor: e.target.value }))}
          className={input}
        />
      </Field>
      <Field label="AS 만료일">
        <DateInput
          value={form.warranty_expires}
          onChange={(v) => setForm((p) => ({ ...p, warranty_expires: v }))}
        />
      </Field>

      <Field label="소유자 (임직원)">
        <select
          value={form.owner_id}
          onChange={(e) => setForm((p) => ({ ...p, owner_id: e.target.value }))}
          className={input}
        >
          <option value="">— 없음 / 공용 —</option>
          {sortDevelopersKo(devs).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.tag ? ` [${d.tag}]` : ""}
              {d.email ? ` · ${d.email}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="위치 / 부서">
        <input
          value={form.location}
          onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))}
          placeholder="예: 본사 3층 개발실"
          className={input}
        />
      </Field>

      <Field label="메모" colSpan={2}>
        <textarea
          value={form.memo}
          onChange={(e) => setForm((p) => ({ ...p, memo: e.target.value }))}
          className={input + " min-h-[60px]"}
        />
      </Field>

      {error && <div className="col-span-2 text-xs text-destructive">{error}</div>}
      {isCreate && (
        <div className="col-span-2 text-[11px] text-muted-foreground">
          자산번호는 등록 시 자동 발번됩니다 (DDA-YYYY-NNNN).
        </div>
      )}
    </div>
  );
}
