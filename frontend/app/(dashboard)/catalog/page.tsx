"use client";

/**
 * 제품 카탈로그 관리 — 제조사 / 제품 / 버전 3-패널 master-detail.
 *
 * - 좌 vendor → 가운데 product → 우 version
 * - 각 패널: 목록 + 추가 / 이름 변경 / 삭제 / 활성·비활성 토글
 * - 삭제 실패(참조 존재) 시 409 → alert
 *
 * 권한: ADMIN 만 (메뉴 권한 + 백엔드 require_admin 가드).
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type Vendor = {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
};
type Product = {
  id: string;
  vendor_id: string;
  name: string;
  long_name: string | null;
  description: string | null;
  product_code: string | null;
  link: string | null;
  is_active: boolean;
  sort_order: number;
};
type Version = {
  id: string;
  name: string;
  product_id: string;
  is_active: boolean;
  sort_order: number;
  release_date: string | null;
  description: string | null;
  link: string | null;
};

function detail(e: unknown): string {
  return (
    (e as AxiosError<{ detail?: string }>)?.response?.data?.detail ||
    (e as Error)?.message ||
    "실패"
  );
}

export default function CatalogPage() {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  // Product 추가·편집 모달 — "new" 는 신규, Product 객체면 편집.
  const [productEdit, setProductEdit] = useState<Product | "new" | null>(null);
  const [versionEdit, setVersionEdit] = useState<Version | "new" | null>(null);

  const vendors = useQuery<Vendor[]>({
    queryKey: ["catalog", "vendors"],
    queryFn: async () =>
      (await api.get("/catalog/vendors", { params: { include_inactive: true } })).data,
    staleTime: 30_000,
  });

  const products = useQuery<Product[]>({
    queryKey: ["catalog", "products", vendorId],
    queryFn: async () =>
      (
        await api.get("/catalog/products", {
          params: { vendor_id: vendorId, include_inactive: true },
        })
      ).data,
    enabled: !!vendorId,
    staleTime: 30_000,
  });

  const versions = useQuery<Version[]>({
    queryKey: ["catalog", "versions", productId],
    queryFn: async () =>
      (
        await api.get("/catalog/versions", {
          params: { product_id: productId, include_inactive: true },
        })
      ).data,
    enabled: !!productId,
    staleTime: 30_000,
  });

  // 패널 mutation helpers (한 번에 정의해서 패널마다 inline 호출).
  const addVendor = useMutation({
    mutationFn: async (name: string) =>
      (await api.post("/catalog/vendors", { name })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog", "vendors"] }),
    onError: (e) => dialog.alert(detail(e)),
  });
  const renameVendor = useMutation({
    mutationFn: async (args: { id: string; name: string }) =>
      (await api.patch(`/catalog/vendors/${args.id}`, { name: args.name })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog", "vendors"] }),
    onError: (e) => dialog.alert(detail(e)),
  });
  const deleteVendor = useMutation({
    mutationFn: async (id: string) => api.delete(`/catalog/vendors/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "vendors"] });
      setVendorId(null);
      setProductId(null);
    },
    onError: (e) => dialog.alert(detail(e)),
  });

  type ProductPayload = {
    name: string;
    long_name?: string | null;
    description?: string | null;
    product_code?: string | null;
    link?: string | null;
  };
  const addProduct = useMutation({
    mutationFn: async (payload: ProductPayload) =>
      (
        await api.post("/catalog/products", { vendor_id: vendorId, ...payload })
      ).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["catalog", "products", vendorId] }),
    onError: (e) => dialog.alert(detail(e)),
  });
  const editProduct = useMutation({
    mutationFn: async (args: { id: string } & ProductPayload) => {
      const { id, ...payload } = args;
      return (await api.patch(`/catalog/products/${id}`, payload)).data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["catalog", "products", vendorId] }),
    onError: (e) => dialog.alert(detail(e)),
  });
  const deleteProduct = useMutation({
    mutationFn: async (id: string) => api.delete(`/catalog/products/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "products", vendorId] });
      setProductId(null);
    },
    onError: (e) => dialog.alert(detail(e)),
  });

  type VersionPayload = {
    name: string;
    release_date?: string | null;
    description?: string | null;
    link?: string | null;
  };
  const addVersion = useMutation({
    mutationFn: async (payload: VersionPayload) =>
      (
        await api.post("/catalog/versions", { product_id: productId, ...payload })
      ).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["catalog", "versions", productId] }),
    onError: (e) => dialog.alert(detail(e)),
  });
  const editVersion = useMutation({
    mutationFn: async (args: { id: string } & VersionPayload) => {
      const { id, ...payload } = args;
      return (await api.patch(`/catalog/versions/${id}`, payload)).data;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["catalog", "versions", productId] }),
    onError: (e) => dialog.alert(detail(e)),
  });
  const deleteVersion = useMutation({
    mutationFn: async (id: string) => api.delete(`/catalog/versions/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["catalog", "versions", productId] }),
    onError: (e) => dialog.alert(detail(e)),
  });

  async function promptAdd(label: string, run: (name: string) => void) {
    const name = await dialog.prompt(`${label} 이름`, {
      placeholder: "예: Cloudera, CDP, 7.1.9 …",
    });
    if (!name?.trim()) return;
    run(name.trim());
  }
  async function promptRename(
    label: string,
    current: string,
    run: (name: string) => void,
  ) {
    const name = await dialog.prompt(`${label} 이름 변경`, {
      defaultValue: current,
    });
    if (!name?.trim() || name.trim() === current) return;
    run(name.trim());
  }
  async function confirmDelete(label: string, name: string, run: () => void) {
    const ok = await dialog.confirm(`"${name}" ${label}을(를) 삭제할까요?`, {
      destructive: true,
    });
    if (ok) run();
  }

  return (
    <>
      <DashboardHeader title="제품 카탈로그" />
      <div className="flex flex-1 min-h-0 gap-3 p-4">
        {/* Vendor 패널 (고정 350px) */}
        <Panel
          title="제조사"
          rows={vendors.data ?? []}
          loading={vendors.isLoading}
          selectedId={vendorId}
          width={350}
          onSelect={(id) => {
            setVendorId(id);
            setProductId(null);
          }}
          onAdd={() => promptAdd("제조사", (n) => addVendor.mutate(n))}
          onRename={(r) =>
            promptRename("제조사", r.name, (n) =>
              renameVendor.mutate({ id: r.id, name: n }),
            )
          }
          onDelete={(r) =>
            confirmDelete("제조사", r.name, () => deleteVendor.mutate(r.id))
          }
        />
        {/* Product 패널 (flex 1 — 기본) — long_name 표시 + link 아이콘 */}
        <Panel
          title="제품"
          rows={(products.data ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            is_active: p.is_active,
            long_name: p.long_name,
            link: p.link,
          }))}
          loading={products.isLoading}
          disabled={!vendorId}
          selectedId={productId}
          onSelect={(id) => setProductId(id)}
          onAdd={() => setProductEdit("new")}
          onRename={(r) => {
            const full = products.data?.find((p) => p.id === r.id);
            if (full) setProductEdit(full);
          }}
          onDelete={(r) =>
            confirmDelete("제품", r.name, () => deleteProduct.mutate(r.id))
          }
        />
        {/* Version 패널 (고정 230px) — link 아이콘 */}
        <Panel
          title="버전"
          rows={(versions.data ?? []).map((v) => ({
            id: v.id,
            name: v.name,
            is_active: v.is_active,
            link: v.link,
          }))}
          loading={versions.isLoading}
          disabled={!productId}
          selectedId={null}
          width={230}
          onSelect={() => {}}
          onAdd={() => setVersionEdit("new")}
          onRename={(r) => {
            const full = versions.data?.find((v) => v.id === r.id);
            if (full) setVersionEdit(full);
          }}
          onDelete={(r) =>
            confirmDelete("버전", r.name, () => deleteVersion.mutate(r.id))
          }
        />
      </div>

      {/* Product 추가·편집 모달 */}
      <ProductFormDialog
        open={productEdit !== null}
        initial={productEdit === "new" ? null : productEdit}
        onClose={() => setProductEdit(null)}
        onSave={(payload) => {
          if (productEdit === "new" || productEdit === null) {
            addProduct.mutate(payload, {
              onSuccess: () => setProductEdit(null),
            });
          } else {
            editProduct.mutate(
              { id: productEdit.id, ...payload },
              { onSuccess: () => setProductEdit(null) },
            );
          }
        }}
        saving={addProduct.isPending || editProduct.isPending}
      />

      {/* Version 추가·편집 모달 */}
      <VersionFormDialog
        open={versionEdit !== null}
        initial={versionEdit === "new" ? null : versionEdit}
        onClose={() => setVersionEdit(null)}
        onSave={(payload) => {
          if (versionEdit === "new" || versionEdit === null) {
            addVersion.mutate(payload, {
              onSuccess: () => setVersionEdit(null),
            });
          } else {
            editVersion.mutate(
              { id: versionEdit.id, ...payload },
              { onSuccess: () => setVersionEdit(null) },
            );
          }
        }}
        saving={addVersion.isPending || editVersion.isPending}
      />
    </>
  );
}

function ProductFormDialog({
  open,
  initial,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  initial: Product | null;
  onClose: () => void;
  onSave: (p: {
    name: string;
    long_name: string | null;
    description: string | null;
    product_code: string | null;
    link: string | null;
  }) => void;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [longName, setLongName] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [link, setLink] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setLongName(initial?.long_name ?? "");
    setDescription(initial?.description ?? "");
    setCode(initial?.product_code ?? "");
    setLink(initial?.link ?? "");
  }, [open, initial?.id]);

  function reset() {
    setName("");
    setLongName("");
    setDescription("");
    setCode("");
    setLink("");
  }

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={initial ? "제품 편집" : "제품 추가"}
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            disabled={saving || !name.trim()}
            onClick={() => {
              onSave({
                name: name.trim(),
                long_name: longName.trim() || null,
                description: description.trim() || null,
                product_code: code.trim() || null,
                link: link.trim() || null,
              });
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="이름 (단축, 드롭다운 표시) *">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: CDP"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </Field>
        <Field label="풀네임">
          <input
            type="text"
            value={longName}
            onChange={(e) => setLongName(e.target.value)}
            placeholder="예: Cloudera Data Platform"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </Field>
        <Field label="제품 코드">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="예: CDP-PVC"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm font-mono"
          />
        </Field>
        <Field label="공식 페이지·문서 URL">
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://..."
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </Field>
        <Field label="설명">
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="제품에 대한 간략한 설명"
            className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
          />
        </Field>
      </div>
    </Dialog>
  );
}

function VersionFormDialog({
  open,
  initial,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  initial: Version | null;
  onClose: () => void;
  onSave: (p: {
    name: string;
    release_date: string | null;
    description: string | null;
    link: string | null;
  }) => void;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [releaseDate, setReleaseDate] = useState("");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setReleaseDate(initial?.release_date ?? "");
    setDescription(initial?.description ?? "");
    setLink(initial?.link ?? "");
  }, [open, initial?.id]);

  function reset() {
    setName("");
    setReleaseDate("");
    setDescription("");
    setLink("");
  }

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={initial ? "버전 편집" : "버전 추가"}
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            disabled={saving || !name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                release_date: releaseDate || null,
                description: description.trim() || null,
                link: link.trim() || null,
              })
            }
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="버전 이름 *">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 7.1.9 SP1"
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </Field>
        <Field label="릴리즈 일자">
          <input
            type="date"
            value={releaseDate}
            onChange={(e) => setReleaseDate(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </Field>
        <Field label="릴리즈 노트·다운로드 URL">
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://docs.cloudera.com/..."
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
        </Field>
        <Field label="기능 설명">
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="이 버전의 주요 변경·신규 기능"
            className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
          />
        </Field>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}

type Row = {
  id: string;
  name: string;
  is_active: boolean;
  long_name?: string | null;
  link?: string | null;
};

function Panel({
  title,
  rows,
  loading,
  disabled,
  selectedId,
  flex = 1,
  width,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: {
  title: string;
  rows: Row[];
  loading: boolean;
  disabled?: boolean;
  selectedId: string | null;
  /** flex-grow 값 (width 미지정 시). 기본 1. */
  flex?: number;
  /** 고정 width (px). 지정 시 flex 무시. */
  width?: number;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (r: Row) => void;
  onDelete: (r: Row) => void;
}) {
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-card flex flex-col"
      style={
        width != null
          ? { flex: `0 0 ${width}px`, width: `${width}px` }
          : { flex: `${flex} 1 0%` }
      }
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled}
          className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" /> 추가
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {disabled ? (
          <div className="px-3 py-6 text-xs text-muted-foreground text-center">
            상위 항목을 선택하세요.
          </div>
        ) : loading ? (
          <div className="px-3 py-6 text-xs text-muted-foreground">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground text-center">
            항목 없음
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li
                key={r.id}
                className={
                  "flex items-center gap-1 px-3 py-2 cursor-pointer " +
                  (selectedId === r.id ? "bg-muted/60" : "hover:bg-muted/30")
                }
                onClick={() => onSelect(r.id)}
              >
                <span
                  className={
                    "flex-1 truncate text-sm " +
                    (!r.is_active ? "text-muted-foreground line-through" : "")
                  }
                >
                  {r.name}
                  {r.long_name && (
                    <span className="text-muted-foreground"> ({r.long_name})</span>
                  )}
                </span>
                {r.link && (
                  <a
                    href={r.link}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:text-primary"
                    aria-label="링크 열기"
                    title={r.link}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(r);
                  }}
                  className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label="이름 변경"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(r);
                  }}
                  className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:text-destructive"
                  aria-label="삭제"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
