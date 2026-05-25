"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Paperclip, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";

type LicenseQuote = {
  id: string;
  license_id: string;
  quote_type: string;
  file_name: string;
  mime_type?: string | null;
  size?: number | null;
  description?: string | null;
};

type License = {
  id: string;
  customer_id: string;
  product_name: string;
  vendor?: string | null;
  currency: "KRW" | "USD";
  amount: string;
  applied_fx_rate?: string | null;
  amount_krw?: string | null;
  purchase_amount?: string | null;
  purchase_currency?: "KRW" | "USD" | null;
  purchase_supplier?: string | null;
  sales_currency?: "KRW" | "USD" | null;
  sales_customer?: string | null;
  start_date: string;
  end_date: string;
  renewal_prep_date?: string | null;
  status: string;
  description?: string | null;
  memo?: string | null;
  quotes: LicenseQuote[];
};

type QuoteItem = {
  id?: string;
  license_id?: string;
  product_name: string;
  product_code: string;
  description?: string | null;
  sales_price: string;
  qty: string;
  start_date?: string | null;
  end_date?: string | null;
  discount_rate: string;
  // "" (empty) means auto-compute; otherwise manual override.
  net_total: string;
  position?: number;
};

type Customer = { id: string; name: string };

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "활성",
  EXPIRED: "만료",
  CANCELLED: "해지",
};

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-700 border-emerald-200",
  EXPIRED: "bg-slate-200 text-slate-700 border-slate-300",
  CANCELLED: "bg-red-100 text-red-700 border-red-200",
};

function daysUntil(iso?: string | null) {
  if (!iso) return null;
  const end = new Date(`${iso}T00:00:00`).getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end - today.getTime()) / 86_400_000);
}

export default function LicenseDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: license } = useQuery<License>({
    queryKey: ["license", id],
    queryFn: async () => (await api.get(`/licenses/${id}`)).data,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
  });

  const { data: fx } = useQuery<{ rate: string; as_of: string }>({
    queryKey: ["fx"],
    queryFn: async () => (await api.get("/exchange/current")).data,
  });

  // Totals reported up from each editor for margin calculation.
  const [purchaseTotal, setPurchaseTotal] = useState<{
    amount: number;
    currency: "KRW" | "USD";
  }>({ amount: 0, currency: "KRW" });
  const [salesTotal, setSalesTotal] = useState<{
    amount: number;
    currency: "KRW" | "USD";
  }>({ amount: 0, currency: "KRW" });

  const onPurchaseTotal = useCallback(
    (amount: number, currency: "KRW" | "USD") =>
      setPurchaseTotal({ amount, currency }),
    [],
  );
  const onSalesTotal = useCallback(
    (amount: number, currency: "KRW" | "USD") =>
      setSalesTotal({ amount, currency }),
    [],
  );

  if (!license) {
    return (
      <>
        <DashboardHeader
          title="라이센스"
          actions={
            <Link
              href="/licenses"
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              목록
            </Link>
          }
        />
        <div className="flex flex-1 flex-col gap-4 p-4">로딩 중...</div>
      </>
    );
  }

  const custName =
    customers.find((c) => c.id === license.customer_id)?.name ?? "-";
  const remaining = daysUntil(license.end_date);
  const statusCls = STATUS_BADGE[license.status] ?? "bg-muted";

  const title =
    custName && custName !== "-"
      ? `${custName} - ${license.product_name}`
      : license.product_name;

  // Margin = sales - purchase, converted to both USD and KRW via applied_fx_rate
  // (falling back to the current live rate).
  const fxRate = Number(license.applied_fx_rate) || Number(fx?.rate) || 0;
  const toKrw = (amount: number, ccy: "KRW" | "USD") =>
    ccy === "KRW" ? amount : fxRate > 0 ? amount * fxRate : NaN;
  const toUsd = (amount: number, ccy: "KRW" | "USD") =>
    ccy === "USD" ? amount : fxRate > 0 ? amount / fxRate : NaN;

  const salesKrw = toKrw(salesTotal.amount, salesTotal.currency);
  const salesUsd = toUsd(salesTotal.amount, salesTotal.currency);
  const purchaseKrw = toKrw(purchaseTotal.amount, purchaseTotal.currency);
  const purchaseUsd = toUsd(purchaseTotal.amount, purchaseTotal.currency);
  const marginKrw = salesKrw - purchaseKrw;
  const marginUsd = salesUsd - purchaseUsd;

  return (
    <>
      <DashboardHeader
        title={title}
        actions={
          <Link
            href="/licenses"
            className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            목록
          </Link>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        <MarginCard
          marginKrw={marginKrw}
          marginUsd={marginUsd}
          salesKrw={salesKrw}
          purchaseKrw={purchaseKrw}
          hasFx={fxRate > 0}
        />
        <div
          className={`grid gap-4 ${
            license.currency === "USD" ? "grid-cols-4" : "grid-cols-3"
          }`}
        >
          {license.currency === "USD" ? (
            <>
              <Card label="금액 (USD)">
                <div className="text-2xl font-bold">
                  {formatMoney(license.amount, "USD")}
                </div>
                {license.applied_fx_rate && (
                  <div className="text-xs text-muted-foreground mt-1">
                    적용환율 {Number(license.applied_fx_rate).toLocaleString()}
                  </div>
                )}
              </Card>
              <Card label="금액 (KRW)">
                <div className="text-2xl font-bold">
                  {license.amount_krw
                    ? formatMoney(license.amount_krw, "KRW")
                    : "-"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  원화 환산
                </div>
              </Card>
            </>
          ) : (
            <Card label="금액 (KRW)">
              <div className="text-2xl font-bold">
                {formatMoney(license.amount, "KRW")}
              </div>
            </Card>
          )}
          <Card label="만료까지">
            <div
              className={`text-2xl font-bold ${
                remaining != null && remaining < 0
                  ? "text-red-600"
                  : remaining != null && remaining < 30
                    ? "text-amber-600"
                    : ""
              }`}
            >
              {remaining == null
                ? "-"
                : remaining < 0
                  ? `${-remaining}일 경과`
                  : `${remaining}일 남음`}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              종료일 {license.end_date}
            </div>
          </Card>
          <Card label="상태">
            <span
              className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${statusCls}`}
            >
              {STATUS_LABEL[license.status] ?? license.status}
            </span>
          </Card>
        </div>

        <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <h2 className="font-semibold mb-3">기본 정보</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <InfoRow label="제품명" value={license.product_name} />
            <InfoRow label="공급사" value={license.vendor || "-"} />
            <InfoRow
              label="고객사"
              value={
                <Link
                  href={`/customers`}
                  className="text-primary hover:underline"
                >
                  {custName}
                </Link>
              }
            />
            <InfoRow label="통화" value={license.currency} />
            <InfoRow label="시작일" value={license.start_date} />
            <InfoRow label="종료일" value={license.end_date} />
            <InfoRow
              label="연장 준비일"
              value={license.renewal_prep_date || "-"}
            />
          </dl>
          {license.description && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-xs text-muted-foreground mb-1">설명</div>
              <div className="text-sm whitespace-pre-wrap">
                {license.description}
              </div>
            </div>
          )}
        </section>

        <QuoteItemsEditor
          licenseId={id}
          kind="PURCHASE"
          title="매입 견적서"
          supplierLabel="매입처"
          initialSupplier={license.purchase_supplier ?? ""}
          initialCurrency={license.purchase_currency ?? "KRW"}
          onTotalChange={onPurchaseTotal}
        />

        <QuoteItemsEditor
          licenseId={id}
          kind="SALES"
          title="매출 견적서"
          supplierLabel="매출처"
          initialSupplier={
            license.sales_customer ?? (custName !== "-" ? custName : "")
          }
          initialCurrency={license.sales_currency ?? license.currency ?? "KRW"}
          onTotalChange={onSalesTotal}
        />

        <AttachmentsSection licenseId={id} files={license.quotes ?? []} />

        <MemoEditor licenseId={id} initialMemo={license.memo ?? ""} />
      </div>
    </>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function MarginCard({
  marginKrw,
  marginUsd,
  salesKrw,
  purchaseKrw,
  hasFx,
}: {
  marginKrw: number;
  marginUsd: number;
  salesKrw: number;
  purchaseKrw: number;
  hasFx: boolean;
}) {
  const color = (v: number) =>
    !Number.isFinite(v)
      ? "text-muted-foreground"
      : v < 0
        ? "text-red-600"
        : v > 0
          ? "text-emerald-700"
          : "";
  const fmtKrw = (v: number) =>
    Number.isFinite(v)
      ? (v < 0 ? "-" : "") +
        Math.abs(Math.round(v)).toLocaleString() +
        "원"
      : "-";
  const fmtUsd = (v: number) =>
    Number.isFinite(v)
      ? (v < 0 ? "-$" : "$") +
        Math.abs(v).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : "-";
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm text-muted-foreground">마진 (매출 − 매입)</div>
        {!hasFx && (
          <div className="text-xs text-amber-600">
            환율이 없어 교차통화 변환 불가
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-muted-foreground">KRW</div>
          <div className={`text-2xl font-bold ${color(marginKrw)}`}>
            {fmtKrw(marginKrw)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            매출 {fmtKrw(salesKrw)} − 매입 {fmtKrw(purchaseKrw)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">USD</div>
          <div className={`text-2xl font-bold ${color(marginUsd)}`}>
            {fmtUsd(marginUsd)}
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex-1">{value}</dd>
    </div>
  );
}

const BLANK_QUOTE_ITEM: QuoteItem = {
  product_name: "",
  product_code: "",
  description: "",
  sales_price: "",
  qty: "1",
  start_date: "",
  end_date: "",
  discount_rate: "0",
  net_total: "",
};

function formatNumberInput(v: string): string {
  if (!v) return "";
  const digits = v.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}

function netTotal(r: QuoteItem): number {
  if (r.net_total !== "" && r.net_total != null) {
    const n = Number(r.net_total);
    if (Number.isFinite(n)) return n;
  }
  const p = Number(r.sales_price) || 0;
  const q = Number(r.qty) || 0;
  const d = Number(r.discount_rate) || 0;
  return p * (1 - d / 100) * q;
}

function QuoteItemsEditor({
  licenseId,
  kind,
  title,
  initialSupplier,
  initialCurrency,
  supplierLabel,
  supplierReadOnly,
  onTotalChange,
}: {
  licenseId: string;
  kind: "PURCHASE" | "SALES";
  title: string;
  initialSupplier: string;
  initialCurrency: "KRW" | "USD";
  supplierLabel: string;
  supplierReadOnly?: boolean;
  onTotalChange?: (total: number, currency: "KRW" | "USD") => void;
}) {
  const qc = useQueryClient();
  const [items, setItems] = useState<QuoteItem[]>([]);
  const [initialKey, setInitialKey] = useState<string>("");
  const [supplier, setSupplier] = useState(initialSupplier);
  const [currency, setCurrency] = useState<"KRW" | "USD">(initialCurrency);

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  useEffect(() => {
    setSupplier(initialSupplier);
  }, [initialSupplier]);

  useEffect(() => {
    setCurrency(initialCurrency);
  }, [initialCurrency]);

  const { data } = useQuery<QuoteItem[]>({
    queryKey: ["license-quote-items", licenseId, kind],
    queryFn: async () =>
      (
        await api.get(`/licenses/${licenseId}/quote-items`, {
          params: { kind },
        })
      ).data,
  });

  useEffect(() => {
    if (!data) return;
    const strip = (v: unknown, fb = "") => {
      if (v == null || v === "") return fb;
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : fb;
    };
    // USD 금액은 소수 2자리 고정, KRW는 정수 표기.
    const stripMoney = (v: unknown, fb = "") => {
      if (v == null || v === "") return fb;
      const n = Number(v);
      if (!Number.isFinite(n)) return fb;
      return initialCurrency === "USD" ? n.toFixed(2) : String(Math.round(n));
    };
    const rows: QuoteItem[] = data.map((r) => ({
      ...r,
      product_name: r.product_name ?? "",
      product_code: r.product_code ?? "",
      description: r.description ?? "",
      sales_price: stripMoney(r.sales_price, ""),
      qty: strip(r.qty, "1"),
      start_date: r.start_date ?? "",
      end_date: r.end_date ?? "",
      discount_rate: strip(r.discount_rate, "0"),
      net_total:
        r.net_total == null || r.net_total === ""
          ? ""
          : stripMoney(r.net_total, ""),
    }));
    setItems(rows);
    setInitialKey(JSON.stringify(rows));
  }, [data, initialCurrency]);

  const saveM = useMutation({
    mutationFn: async () => {
      const licensePatch: Record<string, unknown> = {};
      if (kind === "PURCHASE") {
        licensePatch.purchase_supplier = supplier || null;
        licensePatch.purchase_currency = currency;
      } else {
        licensePatch.sales_customer = supplier || null;
        licensePatch.sales_currency = currency;
      }
      await api.patch(`/licenses/${licenseId}`, licensePatch);
      const payload = {
        items: items.map((r) => ({
          id: r.id ?? undefined,
          product_name: r.product_name,
          product_code: r.product_code,
          description: r.description || null,
          sales_price: r.sales_price === "" ? "0" : r.sales_price,
          qty: r.qty === "" ? "0" : r.qty,
          start_date: r.start_date || null,
          end_date: r.end_date || null,
          discount_rate: r.discount_rate === "" ? "0" : r.discount_rate,
          net_total: r.net_total === "" ? null : r.net_total,
        })),
      };
      return (
        await api.put(`/licenses/${licenseId}/quote-items`, payload, {
          params: { kind },
        })
      ).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["license-quote-items", licenseId, kind],
      });
      qc.invalidateQueries({ queryKey: ["license", licenseId] });
    },
  });

  const itemsDirty = JSON.stringify(items) !== initialKey;
  const headerDirty =
    (!supplierReadOnly && supplier !== initialSupplier) ||
    currency !== initialCurrency;
  const dirty = itemsDirty || headerDirty;
  const grandTotal = items.reduce((acc, r) => acc + netTotal(r), 0);

  useEffect(() => {
    if (onTotalChange) onTotalChange(grandTotal, currency);
  }, [grandTotal, currency, onTotalChange]);
  const currencySuffix = currency === "USD" ? "" : "원";
  const currencyPrefix = currency === "USD" ? "$" : "";
  const fmtAmount = (n: number) =>
    currency === "USD"
      ? n.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : Math.round(n).toLocaleString();
  // For <input type=number>: no grouping separators, fixed decimals.
  const fmtPlain = (n: number) =>
    currency === "USD" ? n.toFixed(2) : String(Math.round(n));

  const updateRow = (idx: number, patch: Partial<QuoteItem>) =>
    setItems((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addRow = () => setItems((prev) => [...prev, { ...BLANK_QUOTE_ITEM }]);
  const removeRow = (idx: number) =>
    setItems((prev) => prev.filter((_, i) => i !== idx));

  const input =
    "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">{title}</h2>
        <button
          type="button"
          onClick={() => saveM.mutate()}
          disabled={!dirty || saveM.isPending}
          className={`h-8 rounded-md px-3 text-sm ${
            dirty
              ? "bg-primary text-primary-foreground hover:bg-brand-dark"
              : "border border-border bg-background text-muted-foreground"
          } disabled:opacity-50`}
        >
          {saveM.isPending ? "저장 중..." : dirty ? "저장" : "변경 없음"}
        </button>
      </div>

      <div className="flex gap-3 mb-3">
        <label className="flex flex-col gap-1" style={{ width: 300 }}>
          <span className="text-xs text-muted-foreground">{supplierLabel}</span>
          {supplierReadOnly ? (
            <input
              value={supplier}
              readOnly
              className="w-full rounded-md border border-input bg-muted/40 px-3 py-2 text-sm"
            />
          ) : (
            <select
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">선택</option>
              {customers.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
              {supplier && !customers.some((c) => c.name === supplier) && (
                <option value={supplier}>{supplier} (사용자 지정)</option>
              )}
            </select>
          )}
        </label>
        <label className="flex flex-col gap-1" style={{ width: "5rem" }}>
          <span className="text-xs text-muted-foreground">통화</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as "KRW" | "USD")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="KRW">KRW</option>
            <option value="USD">USD</option>
          </select>
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse border border-border table-fixed">
          <colgroup>
            <col style={{ width: "2.5rem" }} />
            <col />
            <col style={{ width: "8rem" }} />
            <col style={{ width: "14rem" }} />
            <col style={{ width: "9rem" }} />
            <col style={{ width: "5rem" }} />
            <col style={{ width: "9rem" }} />
            <col style={{ width: "9rem" }} />
            <col style={{ width: "5rem" }} />
            <col style={{ width: "10rem" }} />
            <col style={{ width: "2.5rem" }} />
          </colgroup>
          <thead className="text-sm text-muted-foreground">
            <tr>
              <th className="border border-border bg-muted/30 px-2 py-1 text-center">
                #
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-left">
                Product Name
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-left">
                Product Code
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-left">
                Description
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-right">
                Sales Price
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-right">
                Qty
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-center">
                Start Date
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-center">
                End Date
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-right">
                Discount %
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-right">
                Net Total
              </th>
              <th className="border border-border bg-muted/30 px-2 py-1 text-center">
                —
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((r, idx) => (
              <tr key={idx}>
                <td className="border border-border text-center text-muted-foreground">
                  {idx + 1}
                </td>
                <td className="border border-border p-1">
                  <input
                    value={r.product_name}
                    onChange={(e) =>
                      updateRow(idx, { product_name: e.target.value })
                    }
                    className={input}
                  />
                </td>
                <td className="border border-border p-1">
                  <input
                    value={r.product_code}
                    onChange={(e) =>
                      updateRow(idx, { product_code: e.target.value })
                    }
                    className={input}
                  />
                </td>
                <td className="border border-border p-1 align-top">
                  <textarea
                    value={r.description ?? ""}
                    onChange={(e) =>
                      updateRow(idx, { description: e.target.value })
                    }
                    rows={2}
                    className={`${input} resize-y`}
                  />
                </td>
                <td className="border border-border p-1">
                  <input
                    type="number"
                    step={currency === "USD" ? "0.01" : "1"}
                    min={0}
                    value={r.sales_price}
                    onChange={(e) =>
                      updateRow(idx, {
                        sales_price:
                          currency === "USD"
                            ? e.target.value
                            : e.target.value.replace(/[^0-9]/g, ""),
                        net_total: "",
                      })
                    }
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v === "") return;
                      const n = Number(v);
                      if (!Number.isFinite(n)) return;
                      updateRow(idx, {
                        sales_price:
                          currency === "USD"
                            ? n.toFixed(2)
                            : String(Math.round(n)),
                      });
                    }}
                    placeholder="0"
                    className={`${input} text-right`}
                  />
                </td>
                <td className="border border-border p-1">
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={r.qty}
                    onChange={(e) =>
                      updateRow(idx, { qty: e.target.value, net_total: "" })
                    }
                    className={`${input} text-right`}
                  />
                </td>
                <td className="border border-border p-1">
                  <DateInput
                    value={r.start_date ?? ""}
                    onChange={(v) => updateRow(idx, { start_date: v })}
                  />
                </td>
                <td className="border border-border p-1">
                  <DateInput
                    value={r.end_date ?? ""}
                    onChange={(v) => updateRow(idx, { end_date: v })}
                  />
                </td>
                <td className="border border-border p-1">
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={100}
                    value={r.discount_rate}
                    onChange={(e) =>
                      updateRow(idx, {
                        discount_rate: e.target.value,
                        net_total: "",
                      })
                    }
                    className={`${input} text-right`}
                  />
                </td>
                <td
                  className={`group/tt relative border border-border p-1 ${
                    r.net_total !== "" ? "bg-amber-50" : ""
                  }`}
                >
                  <input
                    type="number"
                    step={currency === "USD" ? "0.01" : "1"}
                    min={0}
                    value={r.net_total === "" ? fmtPlain(netTotal(r)) : r.net_total}
                    onChange={(e) =>
                      updateRow(idx, { net_total: e.target.value })
                    }
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v === "" || r.net_total === "") return;
                      const n = Number(v);
                      if (!Number.isFinite(n)) return;
                      updateRow(idx, {
                        net_total:
                          currency === "USD"
                            ? n.toFixed(2)
                            : String(Math.round(n)),
                      });
                    }}
                    className={`${input} text-right tabular-nums ${
                      r.net_total === "" ? "text-muted-foreground" : "font-medium"
                    }`}
                  />
                  <Tooltip
                    label={
                      r.net_total !== ""
                        ? "수동 입력값 사용 중 — 비우면 자동 계산"
                        : "자동 계산값 — 직접 입력 시 수동 입력값으로 대체"
                    }
                    side="top"
                    inline
                  />
                </td>
                <td className="border border-border text-center">
                  <Tooltip label="삭제" side="top">
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </Tooltip>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="border border-border px-2 py-4 text-center text-muted-foreground text-sm"
                >
                  등록된 라인이 없습니다. 아래 "+ 행 추가"를 눌러 시작하세요.
                </td>
              </tr>
            )}
            <tr>
              <td
                colSpan={9}
                className="border border-border bg-muted/40 px-2 py-1.5 font-semibold"
              >
                Grand Total
              </td>
              <td className="border border-border bg-muted/40 px-2 py-1.5 text-right tabular-nums font-bold">
                {currencyPrefix}
                {fmtAmount(grandTotal)}
                {currencySuffix}
              </td>
              <td className="border border-border bg-muted/40" />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex">
        <button
          type="button"
          onClick={addRow}
          className="h-8 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark"
        >
          <Plus className="h-4 w-4" />
          행 추가
        </button>
      </div>
    </section>
  );
}

function AttachmentsSection({
  licenseId,
  files,
}: {
  licenseId: string;
  files: LicenseQuote[];
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadM = useMutation({
    mutationFn: async (list: File[]) => {
      for (const f of list) {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("quote_type", "ATTACHMENT");
        await api.post(`/licenses/${licenseId}/quotes`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license", licenseId] });
      setError(null);
    },
    onError: (e: any) =>
      setError(
        e?.response?.data?.detail?.[0]?.msg ??
          e?.response?.data?.detail ??
          "업로드 실패",
      ),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => api.delete(`/licenses/quotes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license", licenseId] });
    },
  });

  const renameM = useMutation({
    mutationFn: async (args: { id: string; file_name: string }) =>
      api.patch(`/licenses/quotes/${args.id}`, { file_name: args.file_name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["license", licenseId] }),
  });

  const onFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const arr = Array.from(list);
    if (arr.length > 0) uploadM.mutate(arr);
  };

  const fmtSize = (n?: number | null) => {
    if (!n || n <= 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">첨부 파일</h2>
        <label className="h-8 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted inline-flex items-center gap-1 cursor-pointer">
          <Paperclip className="h-3.5 w-3.5" />
          파일 선택
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={`rounded-md border-2 border-dashed text-center text-sm py-8 mb-3 transition-colors ${
          dragging
            ? "border-primary bg-primary/5 text-primary"
            : "border-border text-muted-foreground"
        }`}
      >
        {uploadM.isPending
          ? "업로드 중..."
          : dragging
            ? "여기에 파일을 놓으세요"
            : "파일을 드래그해서 놓거나 우측 상단의 \"+ 파일 선택\"을 눌러 업로드하세요"}
      </div>
      {error && <div className="text-xs text-destructive mb-2">{error}</div>}

      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          업로드된 파일이 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2">
              <button
                type="button"
                onClick={async () => {
                  // 인증 토큰이 필요한 다운로드 — api 인스턴스로 blob 받아 로컬 앵커로 저장.
                  try {
                    const res = await api.get(
                      `/licenses/quotes/${f.id}/download`,
                      { responseType: "blob" },
                    );
                    const url = URL.createObjectURL(res.data as Blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = f.file_name;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 0);
                  } catch (e: any) {
                    dialog.alert(
                      e?.response?.data?.detail ??
                        e?.message ??
                        "다운로드에 실패했습니다.",
                    );
                  }
                }}
                className="font-medium text-primary hover:underline truncate text-left"
              >
                {f.file_name}
              </button>
              <span className="text-xs text-muted-foreground">
                {fmtSize(f.size)}
              </span>
              {f.description && (
                <span className="text-xs text-muted-foreground truncate max-w-md">
                  {f.description}
                </span>
              )}
              <button
                type="button"
                onClick={async () => {
                  const next = await dialog.prompt("파일 표시명 변경", {
                    defaultValue: f.file_name,
                  });
                  if (next && next.trim() && next !== f.file_name) {
                    renameM.mutate({ id: f.id, file_name: next.trim() });
                  }
                }}
                className="group/tt relative ml-auto inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:underline"
              >
                <Pencil className="h-3 w-3" />
                이름 변경
                <Tooltip label="이름 변경" side="top" inline />
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (
                    await dialog.confirm(
                      `"${f.file_name}"을(를) 삭제하시겠습니까?`,
                      { destructive: true },
                    )
                  ) {
                    deleteM.mutate(f.id);
                  }
                }}
                className="inline-flex items-center gap-0.5 text-xs text-destructive hover:underline"
              >
                <Trash2 className="h-3 w-3" />
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoEditor({
  licenseId,
  initialMemo,
}: {
  licenseId: string;
  initialMemo: string;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(initialMemo);
  const [saved, setSaved] = useState<string>(initialMemo);

  useEffect(() => {
    setValue(initialMemo);
    setSaved(initialMemo);
  }, [initialMemo]);

  const saveM = useMutation({
    mutationFn: async () =>
      (await api.patch(`/licenses/${licenseId}`, { memo: value })).data,
    onSuccess: () => {
      setSaved(value);
      qc.invalidateQueries({ queryKey: ["license", licenseId] });
    },
  });

  const dirty = value !== saved;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold">메모</h2>
        <div className="flex items-center gap-2">
          {saveM.isSuccess && !dirty && (
            <span className="text-xs text-emerald-600">저장됨</span>
          )}
          <button
            type="button"
            onClick={() => saveM.mutate()}
            disabled={!dirty || saveM.isPending}
            className={`h-8 rounded-md px-3 text-sm ${
              dirty
                ? "bg-primary text-primary-foreground hover:bg-brand-dark"
                : "border border-border bg-background text-muted-foreground"
            } disabled:opacity-50`}
          >
            {saveM.isPending ? "저장 중..." : dirty ? "저장" : "변경 없음"}
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={8}
        placeholder="라이센스 관련 메모를 자유롭게 입력하세요."
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
      />
    </section>
  );
}
