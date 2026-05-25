"use client";

/**
 * 제품 카탈로그 3-step 선택 — vendor → product → version.
 *
 * 모두 Combobox (드롭다운 + 자유 타이핑 + "+ 새로 추가").
 * 백엔드가 lookup-or-create 처리하므로 클라이언트는 name 문자열만 전달.
 *
 * - vendor 선택 시 product 옵션을 해당 vendor 의 자식으로 필터.
 * - product 선택 시 version 옵션을 해당 product 의 자식으로 필터.
 * - 상위가 비어 있으면 하위 입력 비활성.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Combobox } from "@/components/ui/Combobox";

type Vendor = { id: string; name: string };
type Product = { id: string; vendor_id: string; name: string };
type Version = { id: string; product_id: string; name: string };

type Props = {
  vendor: string;
  product: string;
  version: string;
  onVendor: (v: string) => void;
  onProduct: (p: string) => void;
  onVersion: (v: string) => void;
  /** 라벨에 * 표기. 기본 false. */
  required?: boolean;
  /** 버전을 숨기고 vendor/product 만 보여줌 (라이센스 등). */
  hideVersion?: boolean;
};

export function CatalogTriple({
  vendor,
  product,
  version,
  onVendor,
  onProduct,
  onVersion,
  required = false,
  hideVersion = false,
}: Props) {
  const vendors = useQuery<Vendor[]>({
    queryKey: ["catalog", "vendors", "active"],
    queryFn: async () => (await api.get("/catalog/vendors")).data,
    staleTime: 60_000,
  });

  // vendor 이름 → id 매핑.
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
    () => products.data?.find((p) => p.name === product)?.id ?? null,
    [products.data, product],
  );

  const versions = useQuery<Version[]>({
    queryKey: ["catalog", "versions", productId, "active"],
    queryFn: async () =>
      (await api.get("/catalog/versions", { params: { product_id: productId } })).data,
    enabled: !!productId,
    staleTime: 60_000,
  });

  return (
    <>
      <Field label={`벤더${required ? " *" : ""}`}>
        <Combobox
          value={vendor}
          onChange={onVendor}
          options={vendors.data?.map((v) => v.name) ?? []}
          placeholder="예: Cloudera"
        />
      </Field>
      <Field label="제품">
        <Combobox
          value={product}
          onChange={onProduct}
          options={products.data?.map((p) => p.name) ?? []}
          disabled={!vendor}
          placeholder={vendor ? "예: CDP" : "벤더를 먼저 선택"}
        />
      </Field>
      {!hideVersion && (
        <Field label="버전">
          <Combobox
            value={version}
            onChange={onVersion}
            options={versions.data?.map((v) => v.name) ?? []}
            disabled={!product}
            placeholder={product ? "예: 7.1.9" : "제품을 먼저 선택"}
          />
        </Field>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}
