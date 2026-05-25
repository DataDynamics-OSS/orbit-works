"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, GitBranch, Lock, Save, Trash2, Undo2, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { useDialog } from "@/components/ui/DialogProvider";
import { DateInput } from "@/components/ui/DateInput";
import { Tooltip } from "@/components/ui/Tooltip";
import { LineItemsEditor } from "@/components/billing/LineItemsEditor";
import { ExportMenu } from "@/components/ui/ExportMenu";
import {
  Currency,
  Document,
  LineItem,
  TaxMode,
  computeTotals,
  formatCurrency,
  taxLabel,
} from "@/lib/billing";
import { exportDocumentExcel, exportDocumentPDF } from "@/lib/billing-export";

type Customer = { id: string; name: string; is_overseas?: boolean };

export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();

  const { data: quote } = useQuery<Document>({
    queryKey: ["quote", id],
    queryFn: async () => (await api.get(`/quotes/${id}`)).data,
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
    queryKey: ["quote-versions", id],
    queryFn: async () => (await api.get(`/quotes/${id}/versions`)).data,
  });

  // 보기 중인 버전. null = "최신 (편집 가능)".
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  // 신규 버전 모드 — 저장 시 version +1 + 이력 스냅샷. 서버 저장 전엔 UI 표시용.
  const [isNewVersionMode, setIsNewVersionMode] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);

  const [form, setForm] = useState<Partial<Document>>({});
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (quote) {
      setForm(quote);
      setDirty(false);
    }
  }, [quote?.id, quote?.updated_at as any]);

  // 버전 콤보박스 변경 시: 최신 선택 → 라이브 quote 로 복귀, 과거 선택 → 스냅샷으로.
  // 신규 버전 모드 중에는 form 덮어쓰지 않는다 (사용자 편집 유지).
  useEffect(() => {
    if (!quote || isNewVersionMode) return;
    if (viewingVersion === null) {
      setForm(quote);
      setDirty(false);
      return;
    }
    const v = versions.find((x) => x.version === viewingVersion);
    if (v) {
      setForm({
        ...quote,
        ...v.header,
        items: v.items as any,
      } as Partial<Document>);
      setDirty(false);
    }
  }, [viewingVersion, versions, quote?.id, isNewVersionMode]);

  function upd<K extends keyof Document>(k: K, v: Document[K]) {
    setForm((p) => ({ ...p, [k]: v }));
    setDirty(true);
  }

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === form.customer_id),
    [customers, form.customer_id],
  );

  // 스마트 기본값: tax_rate 가 아직 비어 있을 때에만 통화·해외법인 조합에 따라
  // 초기값 제안 ("10" 국내 기본 / "0" 해외+USD 영세율). 이미 서버에서 로드되었거나
  // 사용자가 입력한 값은 덮어쓰지 않는다 — 저장된 0 이 10 으로 되돌아가던 버그 방지.
  const [userTouchedTax, setUserTouchedTax] = useState(false);
  useEffect(() => {
    if (userTouchedTax) return;
    const current = form.tax_rate;
    if (current !== undefined && current !== null && String(current) !== "") return;
    const ccy = (form.currency as Currency) ?? "KRW";
    const overseas = !!selectedCustomer?.is_overseas;
    const suggested = ccy === "USD" && overseas ? "0" : "10";
    setForm((p) => ({ ...p, tax_rate: suggested }));
  }, [form.currency, selectedCustomer?.is_overseas, userTouchedTax, form.tax_rate]);

  const saveM = useMutation({
    mutationFn: async () => {
      // 통합 저장 — 한번의 POST /save 로 헤더+라인 + version +1 처리.
      const source = form.items ?? quote?.items ?? [];
      const items = source.map((it, idx) => ({ ...it, position: idx }));
      const payload = {
        customer_id: form.customer_id ?? null,
        title: form.title,
        business_name: form.business_name ?? null,
        attention: form.attention ?? null,
        issue_date: form.issue_date,
        valid_until: form.valid_until || null,
        currency: form.currency,
        locale: form.locale ?? "ko",
        tax_mode: form.tax_mode,
        tax_rate: form.tax_rate,
        memo: form.memo ?? null,
        terms: form.terms ?? null,
        items,
        new_version: isNewVersionMode,
      };
      return (await api.post(`/quotes/${id}/save`, payload)).data;
    },
    onSuccess: (data: any) => {
      qc.setQueryData(["quote", id], data);
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-versions", id] });
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
    mutationFn: async () => (await api.post(`/quotes/${id}/copy`)).data,
    onSuccess: (data: any) => router.push(`/quotes/${data.id}`),
  });

  const deleteM = useMutation({
    mutationFn: async () => api.delete(`/quotes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      router.push("/quotes");
    },
  });

  const finalizeM = useMutation({
    mutationFn: async () => (await api.post(`/quotes/${id}/finalize`)).data,
    onSuccess: (data: any) => {
      qc.setQueryData(["quote", id], data);
      qc.invalidateQueries({ queryKey: ["quotes"] });
      setForm(data);
    },
  });

  const unfinalizeM = useMutation({
    mutationFn: async () => (await api.post(`/quotes/${id}/unfinalize`)).data,
    onSuccess: (data: any) => {
      qc.setQueryData(["quote", id], data);
      qc.invalidateQueries({ queryKey: ["quotes"] });
      setForm(data);
    },
  });

  if (!quote) {
    return (
      <>
        <DashboardHeader title="견적서" />
        <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>
      </>
    );
  }

  // 과거 버전 보기 중인지 판정.
  const viewingOlder =
    viewingVersion !== null && viewingVersion !== quote.version;

  const effectiveVersion = isNewVersionMode
    ? quote.version + 1
    : viewingOlder
      ? (viewingVersion as number)
      : quote.version;

  const doc: Document = {
    ...quote,
    ...form,
    items: (form.items ?? quote.items) as any,
    version: effectiveVersion,
    display_number: `${quote.number}-${effectiveVersion}`,
  } as Document;

  const readOnly = viewingOlder || quote.status === "FINAL";
  const totals = computeTotals(doc.items, doc.tax_mode as TaxMode, doc.tax_rate);

  return (
    <>
      <DashboardHeader
        title={`견적서 ${doc.display_number || quote.display_number || quote.number}`}
        actions={
          <div className="flex gap-2 items-center flex-wrap">
            <Tooltip label="견적서 목록으로 이동합니다." side="bottom">
              <Link
                href="/quotes"
                className="h-8 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 text-xs hover:bg-muted"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                목록
              </Link>
            </Tooltip>

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            {/* 상태 배지 */}
            <span
              className={
                "inline-flex items-center h-7 rounded-md border px-2 text-[11px] font-medium " +
                (quote.status === "FINAL"
                  ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                  : "bg-amber-50 border-amber-400 text-amber-800 animate-status-draft")
              }
            >
              {quote.status === "FINAL" ? "최종 제출" : "● 진행중"}
            </span>

            {/* 버전 선택 콤보 */}
            <Tooltip label="보기용 버전 선택 (최신만 편집 가능)" side="bottom">
            <select
              value={viewingVersion ?? ""}
              onChange={(e) =>
                setViewingVersion(e.target.value ? Number(e.target.value) : null)
              }
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="">
                {`v${quote.version}`}
                {quote.updated_at
                  ? ` · ${new Date(quote.updated_at).toLocaleDateString("ko-KR")}`
                  : ""}
                {" · 최신(편집)"}
              </option>
              {versions
                .filter((v) => v.version !== quote.version)
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
                  ? quote.status === "FINAL"
                    ? "최종 제출 상태에서는 저장할 수 없습니다"
                    : "과거 버전은 읽기 전용입니다"
                  : "현재 변경한 견적서를 새로운 버전으로 저장합니다."
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
                    ? `저장 (신규 v${quote.version + 1})`
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
                    : "현재 견적서에 새로운 버전으로 생성합니다. 저장하기 전까지 저장되지 않습니다."
              }
            >
              <button
                type="button"
                disabled={readOnly || isNewVersionMode}
                onClick={async () => {
                  if (
                    !(await dialog.confirm(
                      "현재 견적서로 새로운 버전의 견적서를 생성하시겠습니까?",
                    ))
                  ) {
                    return;
                  }
                  setIsNewVersionMode(true);
                  setDirty(true);
                  // 최신으로 스냅을 맞춘다 (과거 버전 보기 상태 해제).
                  setViewingVersion(null);
                }}
                className="h-8 inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-50 px-3 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-50"
              >
                <GitBranch className="h-3.5 w-3.5" />
                {isNewVersionMode
                  ? `신규 v${quote.version + 1}`
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
                    // 혹시 모를 편집 내용은 그대로 남김 (취소는 저장만 안 할 뿐)
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

            {quote.status === "FINAL" ? (
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
                      : "현재 견적서를 최종 제출한 견적서로 확정합니다."
                }
              >
                <button
                  type="button"
                  disabled={dirty || viewingOlder}
                  onClick={async () => {
                    if (
                      await dialog.confirm(
                        "현재 견적서를 최종 제출 견적서로 생성하시겠습니까?",
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

            <ExportMenu
              disabled={false}
              exporting={false}
              open={downloadOpen}
              onOpenChange={setDownloadOpen}
              onPDF={() => exportDocumentPDF(doc, "quote")}
              onExcel={() => exportDocumentExcel(doc, "quote")}
              label="다운로드"
            />

            <div className="h-6 w-px bg-border mx-1" aria-hidden />

            <Tooltip label="현재 견적서를 완전히 새로운 견적서로 생성합니다. 새로운 견적번호를 부여합니다." side="bottom">
              <button
                type="button"
                onClick={async () => {
                  if (
                    await dialog.confirm(
                      "현재 견적서를 복제하여 완전히 새로운 견적서를 생성하시겠습니까? 새로운 v1 버전 부터 시작합니다.",
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
                  await dialog.confirm("이 견적서를 삭제하시겠습니까?", {
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
        {quote.converted_invoice_id && (
          <div className="text-xs text-muted-foreground">
            <Link
              href={`/invoices/${quote.converted_invoice_id}`}
              className="text-primary hover:underline"
            >
              → 전환된 매출 인보이스 열기
            </Link>
          </div>
        )}

        {readOnly && (
          <div
            className={
              "text-xs rounded-md border px-3 py-2 " +
              (quote.status === "FINAL" && !viewingOlder
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-amber-300 bg-amber-50 text-amber-800")
            }
          >
            {viewingOlder
              ? `📜 과거 버전 v${viewingVersion} 보기 중입니다 (읽기 전용). 편집하려면 상단에서 "최신 v${quote.version}" 을 선택하세요.`
              : "🔒 최종 제출 상태입니다. 편집하려면 '최종 제출 취소' 를 클릭하세요."}
          </div>
        )}

        {isNewVersionMode && (
          <div className="text-xs rounded-md border border-sky-300 bg-sky-50 text-sky-800 px-3 py-2">
            ✨ 신규 버전 v{quote.version + 1} 편집 중 (저장 전). 내용은 현재
            v{quote.version} 에서 복사된 상태입니다. 저장을 누르면 v
            {quote.version + 1} 로 기록되고 v{quote.version} 은 이력에 보존됩니다.
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
                placeholder="예) 시스템 구축 견적서"
              />
            </Field>
            <Field label="사업명" colSpan={2}>
              <input
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.business_name ?? ""}
                onChange={(e) => upd("business_name", e.target.value as any)}
                placeholder="예) OOO 시스템 구축 프로젝트"
              />
            </Field>
            <Field label="수신" colSpan={4}>
              <input
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.attention ?? ""}
                onChange={(e) => upd("attention", e.target.value as any)}
                placeholder="예) 홍길동 대표이사 귀하 / OOO 부서장 귀하"
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
            <Field label="언어">
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={form.locale ?? "ko"}
                onChange={(e) => upd("locale", e.target.value as "ko" | "en")}
              >
                <option value="ko">한국어</option>
                <option value="en">영문 (English)</option>
              </select>
            </Field>
            <Field label="발행일">
              <DateInput
                value={form.issue_date ?? ""}
                onChange={(v) => upd("issue_date", v)}
              />
            </Field>
            <Field label="유효기간">
              <DateInput
                value={form.valid_until ?? ""}
                onChange={(v) => upd("valid_until", v as any)}
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
                value={form.tax_rate ?? "10"}
                onChange={(e) => {
                  setUserTouchedTax(true);
                  upd("tax_rate", e.target.value);
                }}
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                {selectedCustomer?.is_overseas && form.currency === "USD"
                  ? "해외 법인 + USD → 영세율 0% 권장"
                  : "국내 청구 기본 10%"}
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
              <span>{formatCurrency(totals.taxable, doc.currency as Currency)}</span>
            </div>
            {totals.discount_total > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>할인합계</span>
                <span>- {formatCurrency(totals.discount_total, doc.currency as Currency)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {taxLabel(doc.tax_rate, doc.tax_mode as TaxMode)}
              </span>
              <span>{formatCurrency(totals.tax_amount, doc.currency as Currency)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 mt-2 font-bold text-base">
              <span>합계</span>
              <span>{formatCurrency(totals.total_amount, doc.currency as Currency)}</span>
            </div>
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
                placeholder="예) 유효기간 내 수락 시 본 견적이 효력을 가집니다. 부가세 별도."
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
