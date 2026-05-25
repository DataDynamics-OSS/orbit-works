"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Download, GitBranch, Lock, Save, Trash2, Undo2, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import { LineItemsEditor } from "@/components/billing/LineItemsEditor";
import {
  Currency,
  Document,
  LineItem,
  TaxMode,
  computeTotals,
  formatCurrency,
  taxLabel,
} from "@/lib/billing";
import { exportDocumentPDF } from "@/lib/billing-export";

type Customer = { id: string; name: string; is_overseas?: boolean };

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();

  const { data: inv } = useQuery<Document>({
    queryKey: ["invoice", id],
    queryFn: async () => (await api.get(`/invoices/${id}`)).data,
    staleTime: 0,
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  type VersionRow = {
    id: string;
    version: number;
    header: Record<string, any>;
    items: LineItem[];
    created_at: string | null;
  };
  const { data: versions = [] } = useQuery<VersionRow[]>({
    queryKey: ["invoice-versions", id],
    queryFn: async () => (await api.get(`/invoices/${id}/versions`)).data,
  });

  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [isNewVersionMode, setIsNewVersionMode] = useState(false);

  const [form, setForm] = useState<Partial<Document>>({});
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (inv) {
      setForm(inv);
      setDirty(false);
    }
  }, [inv?.id, inv?.updated_at as any]);

  useEffect(() => {
    if (!inv || isNewVersionMode) return;
    if (viewingVersion === null) {
      setForm(inv);
      setDirty(false);
      return;
    }
    const v = versions.find((x) => x.version === viewingVersion);
    if (v) {
      setForm({
        ...inv,
        ...v.header,
        items: v.items as any,
      } as Partial<Document>);
      setDirty(false);
    }
  }, [viewingVersion, versions, inv?.id, isNewVersionMode]);

  function upd<K extends keyof Document>(k: K, v: Document[K]) {
    setForm((p) => ({ ...p, [k]: v }));
    setDirty(true);
  }

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === form.customer_id),
    [customers, form.customer_id],
  );

  const saveM = useMutation({
    mutationFn: async () => {
      const source = form.items ?? inv?.items ?? [];
      const items = source.map((it, idx) => ({ ...it, position: idx }));
      const payload = {
        customer_id: form.customer_id ?? null,
        title: form.title,
        business_name: form.business_name ?? null,
        attention: form.attention ?? null,
        po_no: form.po_no ?? null,
        issue_date: form.issue_date,
        due_date: form.due_date || null,
        currency: form.currency,
        tax_mode: form.tax_mode,
        tax_rate: form.tax_rate,
        payment_status: (form as any).payment_status ?? null,
        paid_at: (form as any).paid_at ?? null,
        linked_bank_transaction_id: (form as any).linked_bank_transaction_id ?? null,
        memo: form.memo ?? null,
        terms: form.terms ?? null,
        items,
        new_version: isNewVersionMode,
      };
      return (await api.post(`/invoices/${id}/save`, payload)).data;
    },
    onSuccess: (data: any) => {
      qc.setQueryData(["invoice", id], data);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice-versions", id] });
      setForm(data);
      setDirty(false);
      setSavedAt(Date.now());
      setIsNewVersionMode(false);
    },
    onError: (e: any) => {
      const msg =
        e?.response?.data?.detail ?? e?.message ?? "저장에 실패했습니다.";
      dialog.alert(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const copyM = useMutation({
    mutationFn: async () => (await api.post(`/invoices/${id}/copy`)).data,
    onSuccess: (data: any) => router.push(`/invoices/${data.id}`),
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/invoices/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      router.push("/invoices");
    },
  });

  const finalizeM = useMutation({
    mutationFn: async () => (await api.post(`/invoices/${id}/finalize`)).data,
    onSuccess: (data: any) => {
      qc.setQueryData(["invoice", id], data);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setForm(data);
    },
  });

  const unfinalizeM = useMutation({
    mutationFn: async () => (await api.post(`/invoices/${id}/unfinalize`)).data,
    onSuccess: (data: any) => {
      qc.setQueryData(["invoice", id], data);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setForm(data);
    },
  });

  if (!inv) {
    return (
      <>
        <DashboardHeader title="매출 인보이스" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  const viewingOlder =
    viewingVersion !== null && viewingVersion !== inv.version;

  const effectiveVersion = isNewVersionMode
    ? inv.version + 1
    : viewingOlder
      ? (viewingVersion as number)
      : inv.version;

  const doc: Document = {
    ...inv,
    ...form,
    items: (form.items ?? inv.items) as any,
    version: effectiveVersion,
    display_number: `${inv.number}-${effectiveVersion}`,
  } as Document;

  const readOnly = viewingOlder || inv.status === "FINAL";
  const totals = computeTotals(doc.items, doc.tax_mode as TaxMode, doc.tax_rate);

  return (
    <>
      <DashboardHeader
        title={`매출 인보이스 ${doc.display_number || inv.display_number || inv.number}`}
        actions={
          <div className="flex gap-2 items-center flex-wrap">
            <Tooltip label="매출 인보이스 목록으로 이동합니다." side="bottom">
              <Link
                href="/invoices"
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                목록
              </Link>
            </Tooltip>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            <span
              className={
                "inline-flex items-center h-7 rounded-md border px-2 text-[11px] font-medium " +
                (inv.status === "FINAL"
                  ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                  : "bg-amber-50 border-amber-400 text-amber-800 animate-status-draft")
              }
            >
              {inv.status === "FINAL" ? "최종 제출" : "● 진행중"}
            </span>

            <Tooltip label="보기용 버전 선택 (최신만 편집 가능)" side="bottom">
              <select
                value={viewingVersion ?? ""}
                onChange={(e) =>
                  setViewingVersion(e.target.value ? Number(e.target.value) : null)
                }
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">
                  {`v${inv.version}`}
                  {inv.updated_at
                    ? ` · ${new Date(inv.updated_at).toLocaleDateString("ko-KR")}`
                    : ""}
                  {" · 최신(편집)"}
                </option>
                {versions
                  .filter((v) => v.version !== inv.version)
                  .map((v) => (
                    <option key={v.id} value={v.version}>
                      {`v${v.version}`}
                      {v.created_at
                        ? ` · ${new Date(v.created_at).toLocaleDateString("ko-KR")}`
                        : ""}
                    </option>
                  ))}
              </select>
            </Tooltip>

            <Tooltip
              side="bottom"
              label={
                readOnly
                  ? inv.status === "FINAL"
                    ? "최종 제출 상태에서는 저장할 수 없습니다"
                    : "과거 버전은 읽기 전용입니다"
                  : "현재 변경한 매출 인보이스를 저장합니다."
              }
            >
              <button
                type="button"
                disabled={!dirty || saveM.isPending || readOnly}
                onClick={() => saveM.mutate()}
                className={
                  "h-8 inline-flex items-center gap-1 rounded-md px-3 text-xs disabled:opacity-50 " +
                  (isNewVersionMode
                    ? "bg-sky-600 text-white hover:bg-sky-700"
                    : "bg-primary text-primary-foreground hover:bg-brand-dark")
                }
              >
                <Save className="h-3.5 w-3.5" />
                {saveM.isPending
                  ? "저장 중..."
                  : isNewVersionMode
                    ? `저장 (신규 v${inv.version + 1})`
                    : "저장"}
              </button>
            </Tooltip>

            <Tooltip
              side="bottom"
              label={
                readOnly
                  ? "편집 가능한 상태에서만 신규 버전을 시작할 수 있습니다"
                  : isNewVersionMode
                    ? "이미 신규 버전 편집 중입니다"
                    : "현재 매출 인보이스에 새로운 버전으로 생성합니다. 저장하기 전까지 저장되지 않습니다."
              }
            >
              <button
                type="button"
                disabled={readOnly || isNewVersionMode}
                onClick={async () => {
                  if (
                    !(await dialog.confirm(
                      "현재 매출 인보이스로 새로운 버전의 매출 인보이스를 생성하시겠습니까?",
                    ))
                  ) {
                    return;
                  }
                  setIsNewVersionMode(true);
                  setDirty(true);
                  setViewingVersion(null);
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-50 px-3 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
              >
                <GitBranch className="h-3.5 w-3.5" />
                {isNewVersionMode
                  ? `신규 v${inv.version + 1}`
                  : "신규 버전 생성"}
              </button>
            </Tooltip>

            {isNewVersionMode && (
              <Tooltip label="신규 버전 생성을 취소합니다 (편집 내용은 유지)" side="bottom">
                <button
                  type="button"
                  onClick={() => {
                    setIsNewVersionMode(false);
                    setDirty(false);
                  }}
                  className="h-7 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                  신규 취소
                </button>
              </Tooltip>
            )}

            {savedAt && !dirty && !readOnly && !isNewVersionMode && (
              <span className="text-[11px] text-emerald-600">저장됨</span>
            )}

            {inv.status === "FINAL" ? (
              <Tooltip
                side="bottom"
                label={
                  viewingOlder
                    ? "과거 버전 보기 중입니다. 최신 버전으로 이동 후 실행하세요."
                    : "최종 제출을 취소하고 편집 가능한 진행중 상태로 되돌립니다."
                }
              >
                <button
                  type="button"
                  disabled={viewingOlder}
                  onClick={async () => {
                    if (
                      await dialog.confirm(
                        "최종 제출을 취소하고 편집 가능한 진행중 상태로 되돌릴까요?",
                      )
                    ) {
                      unfinalizeM.mutate();
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-50 px-3 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  최종 제출 취소
                </button>
              </Tooltip>
            ) : (
              <Tooltip
                side="bottom"
                label={
                  viewingOlder
                    ? "과거 버전 보기 중입니다. 최신 버전으로 이동 후 실행하세요."
                    : dirty
                      ? "저장되지 않은 변경이 있습니다. 먼저 저장하세요."
                      : "현재 매출 인보이스를 최종 제출한 매출 인보이스로 확정합니다."
                }
              >
                <button
                  type="button"
                  disabled={dirty || viewingOlder}
                  onClick={async () => {
                    if (
                      await dialog.confirm(
                        "현재 매출 인보이스를 최종 제출 매출 인보이스로 생성하시겠습니까?",
                      )
                    ) {
                      finalizeM.mutate();
                    }
                  }}
                  className="h-8 inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-50 px-3 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  최종 제출로 확정
                </button>
              </Tooltip>
            )}

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            <button
              type="button"
              onClick={() => exportDocumentPDF(doc, "invoice")}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              PDF
            </button>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            <Tooltip label="현재 매출 인보이스를 복제하여 완전히 새로운 매출 인보이스를 생성합니다." side="bottom">
              <button
                type="button"
                onClick={async () => {
                  if (
                    await dialog.confirm(
                      "현재 매출 인보이스를 복제하여 완전히 새로운 매출 인보이스를 생성하시겠습니까? 새로운 v1 버전 부터 시작합니다.",
                    )
                  ) {
                    copyM.mutate();
                  }
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
              >
                <Copy className="h-3.5 w-3.5" />
                복제
              </button>
            </Tooltip>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            <button
              type="button"
              onClick={async () => {
                if (
                  await dialog.confirm("이 매출 인보이스를 삭제하시겠습니까?", {
                    destructive: true,
                  })
                ) {
                  deleteM.mutate();
                }
              }}
              className="h-8 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-red-50 px-3 text-xs text-destructive hover:bg-red-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
              삭제
            </button>
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-4 p-4 overflow-auto">
        {inv.source_quote_id && (
          <div className="text-xs text-muted-foreground">
            <Link
              href={`/quotes/${inv.source_quote_id}`}
              className="text-primary hover:underline"
            >
              ← 원본 견적서 열기
            </Link>
          </div>
        )}

        {readOnly && (
          <div
            className={
              "text-xs rounded-md border px-3 py-2 " +
              (inv.status === "FINAL" && !viewingOlder
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-amber-300 bg-amber-50 text-amber-800")
            }
          >
            {viewingOlder
              ? `📜 과거 버전 v${viewingVersion} 보기 중입니다 (읽기 전용). 편집하려면 상단에서 "최신 v${inv.version}" 을 선택하세요.`
              : "🔒 최종 제출 상태입니다. 편집하려면 '최종 제출 취소' 를 클릭하세요."}
          </div>
        )}

        {isNewVersionMode && (
          <div className="text-xs rounded-md border border-sky-300 bg-sky-50 text-sky-800 px-3 py-2">
            ✨ 신규 버전 v{inv.version + 1} 편집 중 (저장 전). 내용은 현재
            v{inv.version} 에서 복사된 상태입니다. 저장을 누르면 v
            {inv.version + 1} 로 기록되고 v{inv.version} 은 이력에 보존됩니다.
          </div>
        )}

        <fieldset disabled={readOnly} className="contents">
          <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="grid grid-cols-4 gap-3">
              <Field label="제목 (PDF 상단 큰 글자)" colSpan={2}>
                <input
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={form.title ?? ""}
                  onChange={(e) => upd("title", e.target.value)}
                  placeholder="예) 2026-04 납품분 청구"
                />
              </Field>
              <Field label="사업명" colSpan={2}>
                <input
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={form.business_name ?? ""}
                  onChange={(e) => upd("business_name", e.target.value as any)}
                />
              </Field>
              <Field label="수신" colSpan={2}>
                <input
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={form.attention ?? ""}
                  onChange={(e) => upd("attention", e.target.value as any)}
                  placeholder="예) 홍길동 대표이사 귀하 / OOO 부서장 귀하"
                />
              </Field>
              <Field label="PO Number (customer)" colSpan={2}>
                <input
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={form.po_no ?? ""}
                  onChange={(e) => upd("po_no", e.target.value as any)}
                  placeholder="예) PO-2026-0012"
                />
              </Field>
              <Field label="고객사">
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={form.customer_id ?? ""}
                  onChange={(e) => upd("customer_id", e.target.value || null)}
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
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={form.currency ?? "KRW"}
                  onChange={(e) => upd("currency", e.target.value as Currency)}
                >
                  <option value="KRW">KRW (원)</option>
                  <option value="USD">USD ($)</option>
                </select>
              </Field>
              <Field label="발행일">
                <DateInput
                  value={form.issue_date ?? ""}
                  onChange={(v) => upd("issue_date", v)}
                />
              </Field>
              <Field label="지급기일">
                <DateInput
                  value={form.due_date ?? ""}
                  onChange={(v) => upd("due_date", v as any)}
                />
              </Field>
              <Field label="과세 방식">
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={form.tax_mode ?? "EXCLUSIVE"}
                  onChange={(e) => upd("tax_mode", e.target.value as TaxMode)}
                >
                  <option value="EXCLUSIVE">별도 (EXCLUSIVE)</option>
                  <option value="INCLUSIVE">포함 (INCLUSIVE)</option>
                </select>
              </Field>
              <Field label="세율(%)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={form.tax_rate ?? "0"}
                  onChange={(e) => upd("tax_rate", e.target.value)}
                />
                <div className="text-[11px] text-muted-foreground mt-1">
                  {selectedCustomer?.is_overseas && form.currency === "USD"
                    ? "해외 법인 + USD → 영세율 0% 권장"
                    : "매출 인보이스 기본 0% — 부가세가 필요하면 10% 입력"}
                </div>
              </Field>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="font-semibold">견적 항목</h2>
              <span className="text-xs text-muted-foreground">
                제품·컨설팅·기술지원·개발·운영/유지보수·기타 중 선택해서 추가
              </span>
            </div>
            <LineItemsEditor
              items={doc.items}
              currency={doc.currency as Currency}
              onChange={(next) => upd("items", next as any)}
            />
          </section>

          <section className="rounded-lg border border-border bg-card p-4 shadow-sm max-w-md ml-auto w-full">
            <h3 className="font-semibold mb-2">합계</h3>
            <div className="text-sm space-y-1 tabular-nums">
              <div className="flex justify-between">
                <span className="text-muted-foreground">공급가액</span>
                <span>
                  {formatCurrency(totals.taxable, doc.currency as Currency)}
                </span>
              </div>
              {totals.discount_total > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>할인합계</span>
                  <span>
                    - {formatCurrency(totals.discount_total, doc.currency as Currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {taxLabel(doc.tax_rate, doc.tax_mode as TaxMode)}
                </span>
                <span>
                  {formatCurrency(totals.tax_amount, doc.currency as Currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-border pt-2 mt-2 font-bold text-base">
                <span>합계</span>
                <span>
                  {formatCurrency(totals.total_amount, doc.currency as Currency)}
                </span>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <h3 className="text-sm font-semibold mb-3">수금</h3>
            <div className="grid grid-cols-3 gap-3">
              <Field label="결제 상태">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={(form as any).payment_status ?? "UNPAID"}
                  onChange={(e) => upd("payment_status" as any, e.target.value as any)}
                >
                  <option value="UNPAID">미결</option>
                  <option value="PARTIAL">부분</option>
                  <option value="PAID">완납</option>
                </select>
              </Field>
              <Field label="수금일">
                <input
                  type="date"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={(form as any).paid_at ?? ""}
                  onChange={(e) => upd("paid_at" as any, e.target.value as any)}
                />
              </Field>
              <Field label="수금액">
                <input
                  type="number" step="0.01"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-right tabular-nums"
                  value={(form as any).paid_amount ?? "0"}
                  readOnly
                  title="수금 금액 — 별도 결제 등록 API 로 누적됩니다."
                />
              </Field>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="메모 (내부)" colSpan={2}>
                <textarea
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.memo ?? ""}
                  onChange={(e) => upd("memo", e.target.value as any)}
                />
              </Field>
              <Field label="약관 / 비고 (PDF에 노출)" colSpan={2}>
                <textarea
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.terms ?? ""}
                  onChange={(e) => upd("terms", e.target.value as any)}
                  placeholder="예) 발행일로부터 30일 이내 지정 계좌로 입금해 주시기 바랍니다."
                />
              </Field>
            </div>
          </section>
        </fieldset>
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
