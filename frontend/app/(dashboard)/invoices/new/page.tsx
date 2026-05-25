"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import type { Currency, TaxMode } from "@/lib/billing";

type Customer = { id: string; name: string; is_overseas?: boolean };

export default function NewInvoicePage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  const today = new Date();
  const plus30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [form, setForm] = useState({
    title: "",
    customer_id: "" as string,
    // 발행일 기준 +30일 기본.
    issue_date: fmt(today),
    due_date: fmt(plus30),
    // 청구서 기본값: USD / INCLUSIVE / 0% (해외 B2B 청구 중심).
    currency: "USD" as Currency,
    tax_mode: "INCLUSIVE" as TaxMode,
    tax_rate: "0",
    business_name: "",
    attention: "",
    po_no: "",
    memo: "",
    terms: "",
  });

  const createM = useMutation({
    mutationFn: async () => {
      const taxRate = form.tax_rate;
      const payload = {
        title: form.title || "(제목 없음)",
        customer_id: form.customer_id || null,
        business_name: form.business_name || null,
        attention: form.attention || null,
        po_no: form.po_no || null,
        issue_date: form.issue_date,
        due_date: form.due_date || null,
        currency: form.currency,
        tax_mode: form.tax_mode,
        tax_rate: taxRate,
        memo: form.memo || null,
        terms: form.terms || null,
      };
      return (await api.post("/invoices", payload)).data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      router.replace(`/invoices/${data.id}`);
    },
    onError: (e: any) => {
      const msg =
        e?.response?.data?.detail ?? e?.message ?? "생성에 실패했습니다.";
      dialog.alert(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  const inp = "w-full h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <>
      <DashboardHeader
        title="새 매출 인보이스"
        actions={
          <div className="flex gap-2 items-center">
            <Link
              href="/invoices"
              className="h-8 inline-flex items-center rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
            >
              ← 목록
            </Link>
            <button
              type="button"
              disabled={createM.isPending}
              onClick={() => createM.mutate()}
              className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {createM.isPending ? "생성 중..." : "생성 & 편집"}
            </button>
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        <div className="text-xs rounded-md border border-sky-300 bg-sky-50 text-sky-800 px-3 py-2">
          📝 기본 정보만 채우고 "생성 & 편집" 을 누르세요. 상세 항목은 다음 화면에서
          이어서 편집합니다. 이 화면에서 취소하면 DB 에 아무 것도 남지 않습니다.
        </div>

        <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="grid grid-cols-4 gap-3">
            <Field label="제목" colSpan={4}>
              <input
                className={inp}
                value={form.title}
                onChange={(e) => upd("title", e.target.value)}
                placeholder="예) 2026-04 납품분 청구"
              />
            </Field>
            <Field label="사업명" colSpan={2}>
              <input
                className={inp}
                value={form.business_name}
                onChange={(e) => upd("business_name", e.target.value)}
              />
            </Field>
            <Field label="고객사">
              <select
                className={inp + " px-2"}
                value={form.customer_id}
                onChange={(e) => upd("customer_id", e.target.value)}
              >
                <option value="">선택</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_overseas ? " (해외)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="통화">
              <select
                className={inp + " px-2"}
                value={form.currency}
                onChange={(e) => upd("currency", e.target.value as Currency)}
              >
                <option value="KRW">KRW (원)</option>
                <option value="USD">USD ($)</option>
              </select>
            </Field>
            <Field label="수신" colSpan={2}>
              <input
                className={inp}
                value={form.attention}
                onChange={(e) => upd("attention", e.target.value)}
              />
            </Field>
            <Field label="PO Number (customer)" colSpan={2}>
              <input
                className={inp}
                value={form.po_no}
                onChange={(e) => upd("po_no", e.target.value)}
                placeholder="예) PO-2026-0012"
              />
            </Field>
            <Field label="발행일">
              <DateInput
                value={form.issue_date}
                onChange={(v) => upd("issue_date", v)}
              />
            </Field>
            <Field label="지급기일">
              <DateInput
                value={form.due_date}
                onChange={(v) => upd("due_date", v)}
              />
            </Field>
          </div>
        </section>
      </div>
    </>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 1 | 2 | 3 | 4;
  children: React.ReactNode;
}) {
  const cls =
    colSpan === 4
      ? "col-span-4"
      : colSpan === 3
        ? "col-span-3"
        : colSpan === 2
          ? "col-span-2"
          : "";
  return (
    <label className={`flex flex-col gap-1 ${cls}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
