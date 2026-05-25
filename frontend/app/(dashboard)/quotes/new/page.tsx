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

// DB 에 빈 견적서가 박히지 않도록 "생성" 버튼을 누르기 전까지는 순수 클라이언트
// 상태로만 유지한다. 생성 시 POST /quotes 한 번 → 상세 페이지로 이동.
export default function NewQuotePage() {
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  const today = new Date();
  const plus14 = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [form, setForm] = useState({
    title: "",
    customer_id: "" as string,
    issue_date: fmt(today),
    valid_until: fmt(plus14),
    currency: "KRW" as Currency,
    locale: "ko" as "ko" | "en",
    tax_mode: "EXCLUSIVE" as TaxMode,
    tax_rate: "10",
    business_name: "",
    attention: "",
    memo: "",
    terms: "",
  });

  const selected = customers.find((c) => c.id === form.customer_id);

  const createM = useMutation({
    mutationFn: async () => {
      // 해외 고객사 + USD 조합일 때 자동 영세율 0%.
      const taxRate =
        form.currency === "USD" && selected?.is_overseas ? "0" : form.tax_rate;
      const payload = {
        title: form.title || "(제목 없음)",
        customer_id: form.customer_id || null,
        business_name: form.business_name || null,
        attention: form.attention || null,
        issue_date: form.issue_date,
        valid_until: form.valid_until || null,
        currency: form.currency,
        locale: form.locale,
        tax_mode: form.tax_mode,
        tax_rate: taxRate,
        memo: form.memo || null,
        terms: form.terms || null,
      };
      return (await api.post("/quotes", payload)).data;
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      router.replace(`/quotes/${data.id}`);
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
        title="새 견적서"
        actions={
          <div className="flex gap-2 items-center">
            <Link
              href="/quotes"
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
          📝 아래 기본 정보만 채우고 "생성 & 편집" 을 눌러주세요. 상세 항목(라인·
          메모·약관 등)은 다음 화면에서 이어서 편집·저장할 수 있습니다.
          <br />이 화면에서 취소하고 돌아가도 DB 에는 아무 것도 저장되지 않습니다.
        </div>

        <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <div className="grid grid-cols-4 gap-3">
            <Field label="제목" colSpan={4}>
              <input
                className={inp}
                value={form.title}
                onChange={(e) => upd("title", e.target.value)}
                placeholder="예) 시스템 구축 견적서"
              />
            </Field>
            <Field label="사업명" colSpan={2}>
              <input
                className={inp}
                value={form.business_name}
                onChange={(e) => upd("business_name", e.target.value)}
                placeholder="예) OOO 시스템 구축 프로젝트"
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
            <Field label="언어">
              <select
                className={inp + " px-2"}
                value={form.locale}
                onChange={(e) => upd("locale", e.target.value as "ko" | "en")}
              >
                <option value="ko">한국어</option>
                <option value="en">영문 (English)</option>
              </select>
            </Field>
            <Field label="수신" colSpan={4}>
              <input
                className={inp}
                value={form.attention}
                onChange={(e) => upd("attention", e.target.value)}
                placeholder="예) 홍길동 대표이사 귀하"
              />
            </Field>
            <Field label="발행일">
              <DateInput
                value={form.issue_date}
                onChange={(v) => upd("issue_date", v)}
              />
            </Field>
            <Field label="유효기간">
              <DateInput
                value={form.valid_until}
                onChange={(v) => upd("valid_until", v)}
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
