"use client";

/**
 * 매입 인보이스 — 외부 vendor 가 우리에게 발행한 청구서 (수동 입력).
 *
 * 한국 전자세금계산서(/tax-invoices PURCHASE) 가 자동 수집되는 반면 이 화면은
 * 세금계산서가 아닌 모든 수신 청구 — 해외 SaaS, 호스팅, 외주비 등 — 를 수동
 * 입력. 영수증 1장 첨부, 카테고리·결제상태 필터.
 *
 * 그리드는 매출 인보이스(/invoices) 와 동일한 DataGrid 패턴.
 */

import { useMemo, useState } from "react";
import { ColDef } from "ag-grid-community";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Paperclip, X } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { DataGrid } from "@/components/data-grid/DataGrid";
import { Dialog } from "@/components/ui/Dialog";
import { AttachmentPreviewButton } from "@/components/preview/AttachmentPreview";
import { useDialog } from "@/components/ui/DialogProvider";
import { FileDropZone } from "@/components/ui/FileDropZone";

type Category =
  | "CLOUD" | "SAAS" | "SOFTWARE_SUBSCRIPTION" | "HOSTING" | "MARKETING"
  | "OUTSOURCING" | "OFFICE" | "TRAVEL" | "UTILITIES" | "LEGAL" | "OTHER";
type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";

const CATEGORY_LABEL: Record<Category, string> = {
  CLOUD: "클라우드",
  SAAS: "SaaS 구독",
  SOFTWARE_SUBSCRIPTION: "소프트웨어 구독",
  HOSTING: "호스팅·도메인",
  MARKETING: "마케팅",
  OUTSOURCING: "외주",
  OFFICE: "사무용품",
  TRAVEL: "출장",
  UTILITIES: "공과금",
  LEGAL: "법무·세무",
  OTHER: "기타",
};

const STATUS_LABEL: Record<PaymentStatus, string> = {
  UNPAID: "미결",
  PARTIAL: "부분",
  PAID: "완납",
};
const STATUS_BADGE: Record<PaymentStatus, string> = {
  UNPAID: "bg-amber-100 text-amber-700 border-amber-200",
  PARTIAL: "bg-sky-100 text-sky-700 border-sky-200",
  PAID: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

type Attachment = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
};

type TaxMode = "INCLUSIVE" | "EXCLUSIVE";

type Bill = {
  id: string;
  vendor_name: string;
  vendor_biz_no: string | null;
  customer_id: string | null;
  delivery_customer_id: string | null;
  quote_id: string | null;
  project_id: string | null;
  title: string | null;
  invoice_no: string | null;
  po_no: string | null;
  sales_order_no: string | null;
  bill_date: string;
  due_date: string | null;
  category: Category;
  currency: string;
  tax_mode: TaxMode;
  amount: string;
  tax_amount: string;
  total_amount: string;
  payment_status: PaymentStatus;
  paid_amount: string;
  paid_at: string | null;
  memo: string | null;
  attachments: Attachment[];
  created_at: string;
};

type Form = {
  id?: string;
  vendor_name: string;        // backend 필수 — customer 선택 시 자동 채움 (UI 입력 X)
  vendor_biz_no: string;      // 동상
  customer_id: string;
  delivery_customer_id: string;
  quote_id: string;
  project_id: string;
  title: string;
  invoice_no: string;
  po_no: string;
  sales_order_no: string;
  bill_date: string;
  due_date: string;
  category: Category;
  currency: string;
  tax_mode: TaxMode;
  amount: string;
  tax_amount: string;
  payment_status: PaymentStatus;
  paid_amount: string;
  paid_at: string;
  memo: string;
};

const BLANK: Form = {
  vendor_name: "",
  vendor_biz_no: "",
  customer_id: "",
  delivery_customer_id: "",
  quote_id: "",
  project_id: "",
  title: "",
  invoice_no: "",
  po_no: "",
  sales_order_no: "",
  bill_date: new Date().toISOString().slice(0, 10),
  due_date: "",
  category: "OTHER",
  currency: "USD",
  tax_mode: "EXCLUSIVE",
  amount: "0",
  tax_amount: "0",
  payment_status: "UNPAID",
  paid_amount: "0",
  paid_at: "",
  memo: "",
};

type Project = { id: string; name: string };

type Customer = { id: string; name: string; business_no?: string | null };
type Quote = {
  id: string;
  display_number: string | null;
  number: string;
  title: string;
  business_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  issue_date: string;
};

// 콤마 포맷 — 입력 표시용. 빈문자열이면 그대로.
function formatComma(raw: string): string {
  if (raw === "" || raw === "-") return raw;
  // raw 는 이미 정제된 numeric string (예: "1234.56" 또는 "1234.").
  const [intp, decp] = raw.split(".");
  const intFmt = intp ? Number(intp).toLocaleString("en-US", { useGrouping: true }) : "0";
  return decp !== undefined ? `${intFmt}.${decp}` : intFmt;
}

// 입력값 정제 — 숫자·점만 통과, 점은 1개만, 부호 없음. 빈문자열 → "0".
function sanitizeMoney(raw: string): string {
  let s = raw.replace(/[^0-9.]/g, "");
  // 첫번째 점만 유지.
  const firstDot = s.indexOf(".");
  if (firstDot >= 0) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  // 선행 0 제거 (단, "0." 또는 "0" 자체는 보존).
  if (s.length > 1 && s.startsWith("0") && s[1] !== ".") {
    s = s.replace(/^0+/, "") || "0";
  }
  return s;
}

function fmtMoney(amount: string | number, currency: string): string {
  const n = Number(amount) || 0;
  if (currency === "KRW") return n.toLocaleString("ko-KR") + "원";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + currency;
}

export default function VendorBillsPage() {
  const qc = useQueryClient();
  const dialog = useDialog();

  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<PaymentStatus | "">("");

  const { data: rows = [] } = useQuery<Bill[]>({
    queryKey: ["vendor-bills", year, customerFilter, filterStatus],
    queryFn: async () => {
      const params: Record<string, string> = {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      };
      if (customerFilter) params.customer_id = customerFilter;
      if (filterStatus) params.payment_status = filterStatus;
      return (await api.get("/vendor-bills", { params })).data;
    },
  });

  // 공급업체 picker — 고객사 마스터에서 선택 (vendor_name·biz_no 자동 채움).
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers-list"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 60_000,
  });

  // 견적서 picker — 우리가 발행한 quotes 중 선택. 선택 시 그 견적서의 customer
  // 를 자동으로 같이 set 해 vendor 입력 마찰 최소화.
  const { data: quotes = [] } = useQuery<Quote[]>({
    queryKey: ["quotes-all"],
    queryFn: async () => (await api.get("/quotes")).data,
    staleTime: 60_000,
  });

  // 프로젝트 picker — 비용을 프로젝트에 귀속해 원가/마진 분석에 사용.
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects-list"],
    queryFn: async () => (await api.get("/projects")).data,
    staleTime: 60_000,
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  // 신규 업로드 대기 파일들 — 저장 시 일괄 multipart POST.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  // 편집 모드일 때 화면에 표시되는 기존 첨부. 개별 X 버튼 누르면 즉시 DELETE.
  const [existingAttachments, setExistingAttachments] = useState<Attachment[]>([]);

  const saveM = useMutation({
    mutationFn: async () => {
      const body = {
        vendor_name: form.vendor_name,
        vendor_biz_no: form.vendor_biz_no || null,
        customer_id: form.customer_id || null,
        delivery_customer_id: form.delivery_customer_id || null,
        quote_id: form.quote_id || null,
        project_id: form.project_id || null,
        title: form.title || null,
        invoice_no: form.invoice_no || null,
        po_no: form.po_no || null,
        sales_order_no: form.sales_order_no || null,
        bill_date: form.bill_date,
        due_date: form.due_date || null,
        category: form.category,
        currency: form.currency,
        tax_mode: form.tax_mode,
        amount: form.amount,
        tax_amount: form.tax_amount,
        payment_status: form.payment_status,
        paid_amount: form.paid_amount,
        paid_at: form.paid_at || null,
        memo: form.memo || null,
      };
      let id: string;
      if (form.id) {
        await api.patch(`/vendor-bills/${form.id}`, body);
        id = form.id;
      } else {
        const { data } = await api.post("/vendor-bills", body);
        id = data.id;
      }
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        await api.post(`/vendor-bills/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      setOpen(false);
      setForm(BLANK);
      setPendingFiles([]);
      setExistingAttachments([]);
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패", { title: "오류" });
    },
  });

  // 기존 첨부 1건 즉시 삭제 (편집 다이얼로그에서). 다이얼로그 닫지 않고 진행.
  const deleteAttachM = useMutation({
    mutationFn: async ({ billId, attId }: { billId: string; attId: string }) => {
      await api.delete(`/vendor-bills/${billId}/attachments/${attId}`);
    },
    onSuccess: (_data, vars) => {
      setExistingAttachments((p) => p.filter((a) => a.id !== vars.attId));
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "첨부 삭제 실패", { title: "오류" });
    },
  });

  const deleteM = useMutation({
    mutationFn: async (ids: string[]) =>
      Promise.all(ids.map((id) => api.delete(`/vendor-bills/${id}`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-bills"] }),
  });

  async function handleDelete(sel: Bill[]) {
    if (!sel.length) return;
    const ok = await dialog.confirm(
      `${sel.length}건의 매입 인보이스를 삭제하시겠습니까?`,
      { destructive: true },
    );
    if (!ok) return;
    deleteM.mutate(sel.map((r) => r.id));
  }

  function startEdit(b: Bill) {
    setForm({
      id: b.id,
      vendor_name: b.vendor_name,
      vendor_biz_no: b.vendor_biz_no ?? "",
      customer_id: b.customer_id ?? "",
      delivery_customer_id: b.delivery_customer_id ?? "",
      quote_id: b.quote_id ?? "",
      project_id: b.project_id ?? "",
      title: b.title ?? "",
      invoice_no: b.invoice_no ?? "",
      po_no: b.po_no ?? "",
      sales_order_no: b.sales_order_no ?? "",
      bill_date: b.bill_date,
      due_date: b.due_date ?? "",
      category: b.category,
      currency: b.currency,
      tax_mode: b.tax_mode ?? "EXCLUSIVE",
      amount: String(b.amount),
      tax_amount: String(b.tax_amount ?? "0"),
      payment_status: b.payment_status,
      paid_amount: String(b.paid_amount),
      paid_at: b.paid_at ?? "",
      memo: b.memo ?? "",
    });
    setPendingFiles([]);
    setExistingAttachments(b.attachments || []);
    setOpen(true);
  }

  async function downloadAttachment(billId: string, att: Attachment) {
    const res = await api.get(`/vendor-bills/${billId}/attachments/${att.id}`, { responseType: "blob" });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.file_name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 납품업체 컬럼에서 customer_id 를 이름으로 resolve. customers 가 비동기 로드라
  // 초기엔 ID 가 보일 수 있어 useMemo deps 에 포함.
  const customerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of customers) m.set(c.id, c.name);
    return m;
  }, [customers]);

  const columnDefs = useMemo<ColDef<Bill>[]>(
    () => [
      {
        field: "bill_date",
        headerName: "발행일",
        width: 120,
        flex: 0,
        pinned: "left",
      },
      {
        field: "vendor_name",
        headerName: "공급업체",
        flex: 50,
        minWidth: 160,
      },
      {
        colId: "delivery_customer",
        headerName: "납품업체",
        flex: 40,
        minWidth: 140,
        valueGetter: (p) =>
          p.data?.delivery_customer_id
            ? customerNameById.get(p.data.delivery_customer_id) ?? "—"
            : "—",
      },
      {
        field: "title",
        headerName: "제목",
        flex: 50,
        minWidth: 180,
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "invoice_no",
        headerName: "인보이스 번호",
        flex: 30,
        minWidth: 140,
        valueFormatter: (p) => p.value || "—",
      },
      {
        field: "amount",
        headerName: "공급가액",
        width: 140,
        flex: 0,
        cellClass: "text-right tabular-nums",
        valueFormatter: (p) =>
          fmtMoney(p.value ?? 0, (p.data?.currency ?? "USD") as string),
      },
      {
        field: "tax_amount",
        headerName: "부가세",
        width: 120,
        flex: 0,
        cellClass: "text-right tabular-nums",
        valueFormatter: (p) =>
          fmtMoney(p.value ?? 0, (p.data?.currency ?? "USD") as string),
      },
      {
        field: "payment_status",
        headerName: "결제",
        width: 90,
        flex: 0,
        headerClass: "ag-center-aligned-header",
        cellStyle: { textAlign: "center" } as any,
        cellRenderer: (p: any) =>
          p.value ? (
            <span
              className={
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold " +
                STATUS_BADGE[p.value as PaymentStatus]
              }
            >
              {STATUS_LABEL[p.value as PaymentStatus]}
            </span>
          ) : null,
      },
      {
        field: "due_date",
        headerName: "지급기일",
        width: 120,
        flex: 0,
        valueFormatter: (p) => p.value || "—",
      },
      {
        colId: "attachments",
        headerName: "첨부",
        width: 90,
        flex: 0,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => {
          const atts: Attachment[] = p.data?.attachments ?? [];
          if (atts.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startEdit(p.data);
              }}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              title={atts.map((a) => a.file_name).join("\n")}
            >
              <Paperclip className="h-3 w-3" />
              {atts.length}개
            </button>
          );
        },
      },
    ],
    [customerNameById],
  );

  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

  return (
    <>
      <DashboardHeader
        title="매입 인보이스"
        actions={
          <div className="flex gap-2 items-center">
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-card shadow-sm px-2 text-sm max-w-[200px]"
              title="회사로 필터"
            >
              <option value="">전체 회사</option>
              {customers
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, "ko"))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as PaymentStatus | "")}
              className="h-8 rounded-md border border-border bg-card shadow-sm px-2 text-sm"
              title="결제 상태 필터"
            >
              <option value="">전체 상태</option>
              {(Object.keys(STATUS_LABEL) as PaymentStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y - 1)}
              aria-label="이전 연도"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="h-8 px-4 inline-flex items-center rounded-md border border-border bg-card shadow-sm text-sm">
              {year}년
            </span>
            <button
              className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-card shadow-sm"
              onClick={() => setYear((y) => y + 1)}
              aria-label="다음 연도"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4">
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(r) => r.id}
          onRowDoubleClicked={(r) => startEdit(r)}
          onAdd={() => {
            setForm(BLANK);
            setPendingFiles([]);
            setExistingAttachments([]);
            setOpen(true);
          }}
          onDelete={handleDelete}
          enableCheckbox
          autoSizeStrategy={{ type: "fitCellContents", colIds: [] }}
        />
      </div>

      {/* 추가/편집 다이얼로그 */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width="max-w-3xl"
        title={form.id ? "매입 인보이스 편집" : "새 매입 인보이스"}
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => saveM.mutate()}
              disabled={saveM.isPending || !form.vendor_name.trim() || !form.bill_date}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              {saveM.isPending ? "저장 중..." : "저장"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-3">
          {/* 견적서 — 우리가 발행한 quotes 중 선택. 선택 시 그 견적서의 customer 를
              같이 자동 채움 (vendor 입력 마찰 최소화). */}
          <Field label="견적서" colSpan={3}>
            <select
              value={form.quote_id}
              onChange={(e) => {
                const qid = e.target.value;
                const q = quotes.find((x) => x.id === qid);
                if (!q) {
                  setForm({ ...form, quote_id: "" });
                  return;
                }
                // 견적서의 customer 를 같이 set — 그 고객사의 name/biz 를
                // vendor_* 에도 자동 채움 (backend 가 vendor_name 을 요구).
                const c = q.customer_id ? customers.find((x) => x.id === q.customer_id) : null;
                setForm({
                  ...form,
                  quote_id: qid,
                  customer_id: q.customer_id ?? form.customer_id,
                  vendor_name: c?.name ?? q.customer_name ?? form.vendor_name,
                  vendor_biz_no: c?.business_no ?? form.vendor_biz_no,
                });
              }}
              className={input}
            >
              <option value="">— 견적서 미연결 —</option>
              {quotes.map((q) => {
                const customer = q.customer_name ?? "—";
                const tail = q.business_name || q.title || q.display_number || q.number;
                return (
                  <option key={q.id} value={q.id}>
                    {customer} - {tail}
                  </option>
                );
              })}
            </select>
          </Field>

          {/* 공급업체 + 납품업체 — 한 행에 50/50 split. 같은 업체일 땐 납품업체 빈값. */}
          <div className="col-span-3 grid grid-cols-2 gap-3">
            <Field label="공급업체">
              <select
                value={form.customer_id}
                onChange={(e) => {
                  const cid = e.target.value;
                  const c = customers.find((x) => x.id === cid);
                  setForm({
                    ...form,
                    customer_id: cid,
                    vendor_name: c?.name ?? "",
                    vendor_biz_no: c?.business_no ?? "",
                  });
                }}
                className={input}
              >
                <option value="">— 공급업체 선택 —</option>
                {customers
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name, "ko"))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.business_no ? ` (${c.business_no})` : ""}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="납품업체">
              <select
                value={form.delivery_customer_id}
                onChange={(e) =>
                  setForm({ ...form, delivery_customer_id: e.target.value })
                }
                className={input}
              >
                <option value="">— 납품업체 선택 —</option>
                {customers
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name, "ko"))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.business_no ? ` (${c.business_no})` : ""}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          {/* 인보이스 메타 — 3개 번호 */}
          <Field label="Invoice No.">
            <input
              value={form.invoice_no}
              onChange={(e) => setForm({ ...form, invoice_no: e.target.value })}
              className={input}
            />
          </Field>
          <Field label="PO No.">
            <input
              value={form.po_no}
              onChange={(e) => setForm({ ...form, po_no: e.target.value })}
              className={input}
            />
          </Field>
          <Field label="Sales Order No.">
            <input
              value={form.sales_order_no}
              onChange={(e) => setForm({ ...form, sales_order_no: e.target.value })}
              className={input}
            />
          </Field>

          {/* 제목 + 프로젝트 */}
          <Field label="제목" colSpan={3}>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="예: Slack Pro 11월 구독료"
              className={input}
            />
          </Field>
          <Field label="프로젝트" colSpan={3}>
            <select
              value={form.project_id}
              onChange={(e) => setForm({ ...form, project_id: e.target.value })}
              className={input}
            >
              <option value="">— 프로젝트 미연결 —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>

          {/* 일자·카테고리 */}
          <Field label="발행일 *">
            <input type="date" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} className={input} />
          </Field>
          <Field label="지급기일">
            <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className={input} />
          </Field>
          <Field label="카테고리">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Category })} className={input}>
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
              ))}
            </select>
          </Field>

          {/* 통화 + 부가세 모드 (한 행, 50/50) */}
          <div className="col-span-3 grid grid-cols-2 gap-3">
            <Field label="통화">
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className={input}>
                <option value="USD">USD</option>
                <option value="KRW">KRW</option>
                <option value="EUR">EUR</option>
                <option value="JPY">JPY</option>
              </select>
            </Field>
            <Field label="부가세 모드">
              <select
                value={form.tax_mode}
                onChange={(e) => setForm({ ...form, tax_mode: e.target.value as TaxMode })}
                className={input}
              >
                <option value="EXCLUSIVE">EXCLUSIVE (별도)</option>
                <option value="INCLUSIVE">INCLUSIVE (포함)</option>
              </select>
            </Field>
          </div>

          {/* 공급가액 + 부가세 + 합계(자동) — 한 행 */}
          <Field label="공급가액">
            <MoneyInput
              value={form.amount}
              onChange={(v) => setForm({ ...form, amount: v })}
              className={input}
            />
          </Field>
          <Field label="부가세">
            <MoneyInput
              value={form.tax_amount}
              onChange={(v) => setForm({ ...form, tax_amount: v })}
              className={input}
            />
          </Field>
          <Field label="합계 (자동)">
            <input
              readOnly
              value={fmtMoney(
                (Number(form.amount) || 0) + (Number(form.tax_amount) || 0),
                form.currency,
              )}
              className={input + " text-right tabular-nums bg-muted/30"}
              title="공급가액 + 부가세"
            />
          </Field>

          {/* 결제 정보 */}
          <Field label="결제 상태">
            <select value={form.payment_status} onChange={(e) => setForm({ ...form, payment_status: e.target.value as PaymentStatus })} className={input}>
              {(Object.keys(STATUS_LABEL) as PaymentStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </Field>
          <Field label="결제일">
            <input type="date" value={form.paid_at} onChange={(e) => setForm({ ...form, paid_at: e.target.value })} className={input} />
          </Field>
          <Field label="결제 금액">
            <MoneyInput
              value={form.paid_amount}
              onChange={(v) => setForm({ ...form, paid_amount: v })}
              className={input}
            />
          </Field>

          <Field label="메모" colSpan={3}>
            <textarea
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </Field>
          <Field label="첨부 (영수증·청구서 PDF/이미지)" colSpan={3}>
            <FileDropZone
              multiple
              label="파일을 여기로 끌어놓거나 클릭해서 선택 (여러 파일 가능)"
              onFiles={(files) =>
                setPendingFiles((p) => [...p, ...files])
              }
            />

            {/* 기존 첨부 — 편집 모드에서만 표시. X 버튼은 즉시 DELETE. */}
            {existingAttachments.length > 0 && (
              <ul className="mt-2 space-y-1">
                {existingAttachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
                  >
                    <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                    <button
                      type="button"
                      onClick={() => form.id && downloadAttachment(form.id, a)}
                      className="flex-1 truncate text-left text-primary hover:underline"
                    >
                      {a.file_name}
                    </button>
                    <span className="text-muted-foreground tabular-nums">
                      {a.size ? `${(a.size / 1024).toFixed(1)} KB` : ""}
                    </span>
                    {form.id && (
                      <AttachmentPreviewButton
                        filename={a.file_name}
                        mime={a.mime_type ?? null}
                        downloadPath={`/vendor-bills/${form.id}/attachments/${a.id}`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        if (!form.id) return;
                        const ok = await dialog.confirm("이 첨부를 삭제하시겠습니까?", {
                          destructive: true,
                        });
                        if (ok) deleteAttachM.mutate({ billId: form.id, attId: a.id });
                      }}
                      className="text-destructive hover:underline inline-flex items-center gap-0.5"
                    >
                      <X className="h-3 w-3" />
                      삭제
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* 신규 업로드 대기 파일 — 저장 시 일괄 multipart POST. */}
            {pendingFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pendingFiles.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-xs border-b border-border/50 py-1"
                  >
                    <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {(f.size / 1024).toFixed(1)} KB
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setPendingFiles((p) => p.filter((_, idx) => idx !== i))
                      }
                      className="text-destructive hover:underline inline-flex items-center gap-0.5"
                    >
                      <X className="h-3 w-3" />
                      제거
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      </Dialog>
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
  const cls = colSpan === 4 ? "col-span-4" : colSpan === 3 ? "col-span-3" : colSpan === 2 ? "col-span-2" : "";
  return (
    <label className={"flex flex-col gap-1 " + cls}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * 통화 금액 입력 — 화면엔 3-digit 콤마 + 소수점 유지, 외부 state 엔 raw numeric 문자열.
 *
 * 입력 중 점(.) 입력 직후·끝의 점도 허용 (사용자가 "1.5" 를 점진적으로 타이핑할 때
 * 끊기지 않게). 점이 끝에 있으면 콤마 포맷도 그대로 유지.
 */
function MoneyInput({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (raw: string) => void;
  className?: string;
}) {
  const display = formatComma(value || "0");
  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      onChange={(e) => onChange(sanitizeMoney(e.target.value))}
      className={"text-right tabular-nums " + className}
    />
  );
}
