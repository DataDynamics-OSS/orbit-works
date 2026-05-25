"use client";

/**
 * 한 다이얼로그 안에서 여러 (product, version) 을 선택. CatalogTriple 이 단일
 * 입력을 위한 거라면 이건 다중. vendor 는 다이얼로그 측에서 단일로 들고 있고
 * 외부에서 prop 으로 받아 product 옵션 필터링에 사용.
 *
 * 백엔드는 이름 문자열로 lookup-or-create 하므로 클라이언트는 product / version
 * name 만 들고 다닌다.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "@/lib/api";
import { Combobox } from "@/components/ui/Combobox";

type Vendor = { id: string; name: string };
type Product = { id: string; vendor_id: string; name: string };
type Version = { id: string; product_id: string; name: string };

export type ProductItem = { product: string; version: string };

type Props = {
  /** vendor name. 비어 있으면 product 추가 비활성. 다이얼로그가 별도 필드로 관리. */
  vendor: string;
  items: ProductItem[];
  onChange: (items: ProductItem[]) => void;
};

export function MultiProductPicker({ vendor, items, onChange }: Props) {
  const [pendingProduct, setPendingProduct] = useState("");
  const [pendingVersion, setPendingVersion] = useState("");

  const vendors = useQuery<Vendor[]>({
    queryKey: ["catalog", "vendors", "active"],
    queryFn: async () => (await api.get("/catalog/vendors")).data,
    staleTime: 60_000,
  });
  const vendorId = useMemo(
    () => vendors.data?.find((v) => v.name === vendor)?.id ?? null,
    [vendors.data, vendor],
  );

  const products = useQuery<Product[]>({
    queryKey: ["catalog", "products", vendorId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/products", { params: { vendor_id: vendorId } })).data,
    enabled: !!vendorId,
    staleTime: 60_000,
  });
  const productId = useMemo(
    () => products.data?.find((p) => p.name === pendingProduct)?.id ?? null,
    [products.data, pendingProduct],
  );

  const versions = useQuery<Version[]>({
    queryKey: ["catalog", "versions", productId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/versions", { params: { product_id: productId } })).data,
    enabled: !!productId,
    staleTime: 60_000,
  });

  function addCurrent() {
    const name = pendingProduct.trim();
    if (!name) return;
    if (items.some((it) => it.product === name)) {
      // 중복 — 기존 항목의 version 만 업데이트.
      onChange(
        items.map((it) =>
          it.product === name ? { product: name, version: pendingVersion.trim() } : it,
        ),
      );
    } else {
      onChange([...items, { product: name, version: pendingVersion.trim() }]);
    }
    setPendingProduct("");
    setPendingVersion("");
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      {/* 선택된 chip 리스트 */}
      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {items.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">선택된 제품 없음</span>
        ) : (
          items.map((it, i) => (
            <span
              key={`${it.product}|${it.version}|${i}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-primary/30 bg-primary/5 text-xs"
            >
              {it.product}
              {it.version && (
                <span className="text-[10px] text-muted-foreground">· {it.version}</span>
              )}
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="제품 제거"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>

      {/* 추가 form — product Combobox + version Combobox + 추가 버튼 */}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">제품</div>
          <Combobox
            value={pendingProduct}
            onChange={setPendingProduct}
            options={products.data?.map((p) => p.name) ?? []}
            disabled={!vendor}
            placeholder={vendor ? "예: CDP" : "벤더를 먼저 선택"}
          />
        </div>
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">버전</div>
          <Combobox
            value={pendingVersion}
            onChange={setPendingVersion}
            options={versions.data?.map((v) => v.name) ?? []}
            disabled={!pendingProduct}
            placeholder={pendingProduct ? "예: 7.1.9" : "제품을 먼저 선택"}
          />
        </div>
        <button
          type="button"
          onClick={addCurrent}
          disabled={!pendingProduct.trim()}
          className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          추가
        </button>
      </div>
    </div>
  );
}
