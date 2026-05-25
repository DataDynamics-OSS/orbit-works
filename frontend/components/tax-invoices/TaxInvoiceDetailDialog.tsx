"use client";

/**
 * 세금계산서 상세 다이얼로그 — 여러 화면에서 공용.
 *
 * 사용처:
 * - /tax-invoices 목록 페이지 (행 클릭)
 * - /projects/[id] 상세 페이지의 매출 세금계산서 섹션 (승인번호 클릭)
 *
 * `invoiceId` 만 받아서 내부에서 `GET /tax-invoices/{id}` 로 전체 데이터 (items 포함)
 * 를 조회하므로 호출자는 id 만 들고 있으면 된다. 저장 시 tax-invoices /
 * project-sales-tax-invoices 두 캐시를 모두 invalidate.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, Save, X } from "lucide-react";
import { api } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useDialog } from "@/components/ui/DialogProvider";

type TaxInvoiceItem = {
  id: string;
  position: number;
  item_name: string | null;
  spec: string | null;
  quantity: number | null;
  unit_price: number | null;
  supply_amount: number | null;
  tax_amount: number | null;
  memo: string | null;
};

type TaxInvoice = {
  id: string;
  kind: "SALES" | "PURCHASE";
  status: string;
  approval_no: string;
  mgt_key: string | null;
  issue_date: string;
  written_date: string | null;
  supplier_biz_no: string | null;
  supplier_name: string | null;
  supplier_ceo: string | null;
  buyer_biz_no: string | null;
  buyer_name: string | null;
  buyer_ceo: string | null;
  supply_amount: number;
  tax_amount: number;
  total_amount: number;
  tax_type: string | null;
  issue_type: string | null;
  source: string;
  has_pdf: boolean;
  linked_customer_id: string | null;
  linked_customer_name: string | null;
  linked_invoice_id: string | null;
  linked_invoice_number: string | null;
  linked_project_id: string | null;
  linked_project_name: string | null;
  memo: string | null;
  items: TaxInvoiceItem[];
};

const KRW = (n: number) => (n || 0).toLocaleString("ko-KR");

export function TaxInvoiceDetailDialog({
  invoiceId,
  onClose,
  readOnly = false,
}: {
  invoiceId: string | null;
  onClose: () => void;
  /** true 면 '저장' 버튼·편집 입력을 숨기고 읽기 전용 뷰어로 동작. */
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();

  const { data: invoice } = useQuery<TaxInvoice>({
    queryKey: ["tax-invoice-detail", invoiceId],
    queryFn: async () => (await api.get(`/tax-invoices/${invoiceId}`)).data,
    enabled: !!invoiceId,
  });

  const [memo, setMemo] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [invoiceRefId, setInvoiceRefId] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (invoice) {
      setMemo(invoice.memo ?? "");
      setCustomerId(invoice.linked_customer_id ?? "");
      setInvoiceRefId(invoice.linked_invoice_id ?? "");
      setProjectId(invoice.linked_project_id ?? "");
    }
  }, [invoice]);

  const { data: customers = [] } = useQuery<
    { id: string; name: string; business_no: string | null }[]
  >({
    queryKey: ["customers-min-for-tax-invoice"],
    queryFn: async () => (await api.get("/customers")).data,
    staleTime: 5 * 60 * 1000,
  });

  const { data: projects = [] } = useQuery<
    { id: string; name: string; customer_id: string | null }[]
  >({
    queryKey: ["projects-min-for-tax-invoice"],
    queryFn: async () => (await api.get("/projects")).data,
    staleTime: 5 * 60 * 1000,
  });
  const filteredProjects = useMemo(() => {
    if (!customerId) return projects;
    const hits = projects.filter((p) => p.customer_id === customerId);
    return hits.length > 0 ? hits : projects;
  }, [projects, customerId]);

  const saveM = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/tax-invoices/${invoiceId}`, {
          memo: memo || null,
          linked_customer_id: customerId || null,
          linked_invoice_id: invoiceRefId || null,
          linked_project_id: projectId || null,
        })
      ).data,
    onSuccess: () => {
      // tax-invoices 계열 + project-scoped 캐시 모두 갱신.
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey?.[0];
          return (
            k === "tax-invoices" ||
            k === "tax-invoices-summary" ||
            k === "tax-invoice-detail" ||
            k === "project-sales-tax-invoices"
          );
        },
      });
      onClose();
    },
    onError: async (e: any) => {
      await dialog.alert(e?.response?.data?.detail ?? "저장 실패");
    },
  });

  async function downloadPdf() {
    if (!invoice) return;
    try {
      const res = await api.get(`/tax-invoices/${invoice.id}/pdf`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${invoice.approval_no}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      await dialog.alert(
        e?.response?.data?.detail ?? "PDF 가 아직 수집되지 않았습니다.",
      );
    }
  }

  if (!invoiceId) return null;
  if (!invoice) {
    return (
      <Dialog open onClose={onClose} title="세금계산서" width="max-w-[57.6rem]">
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      </Dialog>
    );
  }

  const itemsSum = invoice.items.reduce(
    (acc, it) => ({
      supply: acc.supply + (it.supply_amount || 0),
      tax: acc.tax + (it.tax_amount || 0),
    }),
    { supply: 0, tax: 0 },
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`세금계산서 ${invoice.approval_no}`}
      width="max-w-[57.6rem]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            닫기
          </button>
          <button
            type="button"
            onClick={downloadPdf}
            disabled={!invoice.has_pdf}
            className="h-9 inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" />
            PDF
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={() => saveM.mutate()}
              disabled={saveM.isPending}
              className="h-9 inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="rounded-md border border-border p-3 space-y-1">
          <div className="text-sm font-semibold text-muted-foreground mb-1">
            {invoice.kind === "SALES" ? "매출 (Issuer)" : "매입 (Receiver)"}
          </div>
          <Row label="발행일" value={invoice.issue_date} />
          <Row label="작성일" value={invoice.written_date || "-"} />
          <Row
            label="유형"
            value={`${invoice.tax_type || "-"} / ${invoice.issue_type || "-"}`}
          />
          <Row label="상태" value={invoice.status} />
          <Row label="원본" value={invoice.source} />
        </div>
        <div className="rounded-md border border-border p-3 space-y-1">
          <div className="text-sm font-semibold text-muted-foreground mb-1">
            금액
          </div>
          <Row
            label="공급가액"
            value={KRW(invoice.supply_amount) + " 원"}
            right
          />
          <Row label="부가세" value={KRW(invoice.tax_amount) + " 원"} right />
          <Row
            label="합계"
            value={KRW(invoice.total_amount) + " 원"}
            bold
            right
          />
        </div>
        <div className="rounded-md border border-border p-3 space-y-1 col-span-2">
          <div className="text-sm font-semibold text-muted-foreground mb-1">
            당사자
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-muted-foreground">공급자</div>
              <div>{invoice.supplier_name || "-"}</div>
              <div className="text-sm font-mono text-muted-foreground">
                {invoice.supplier_biz_no || ""}
                {invoice.supplier_ceo
                  ? ` · 대표 ${invoice.supplier_ceo}`
                  : ""}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">공급받는자</div>
              <div>{invoice.buyer_name || "-"}</div>
              <div className="text-sm font-mono text-muted-foreground">
                {invoice.buyer_biz_no || ""}
                {invoice.buyer_ceo ? ` · 대표 ${invoice.buyer_ceo}` : ""}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-sm font-semibold text-muted-foreground mb-1">
          품목
        </div>
        <div className="rounded-md border border-border overflow-auto max-h-48">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-1 text-left">#</th>
                <th className="px-2 py-1 text-left">품명</th>
                <th className="px-2 py-1 text-left">규격</th>
                <th className="px-2 py-1 text-right">수량</th>
                <th className="px-2 py-1 text-right">단가</th>
                <th className="px-2 py-1 text-right">공급가액</th>
                <th className="px-2 py-1 text-right">부가세</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-2 py-4 text-center text-muted-foreground"
                  >
                    품목 정보 없음
                  </td>
                </tr>
              ) : (
                invoice.items.map((it) => (
                  <tr
                    key={it.id}
                    className="border-t border-border/60 tabular-nums"
                  >
                    <td className="px-2 py-1">{it.position}</td>
                    <td className="px-2 py-1">{it.item_name || "-"}</td>
                    <td className="px-2 py-1">{it.spec || "-"}</td>
                    <td className="px-2 py-1 text-right">
                      {it.quantity ?? "-"}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {it.unit_price != null ? KRW(it.unit_price) : "-"}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {it.supply_amount != null ? KRW(it.supply_amount) : "-"}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {it.tax_amount != null ? KRW(it.tax_amount) : "-"}
                    </td>
                  </tr>
                ))
              )}
              {invoice.items.length > 0 && (
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={5} className="px-2 py-1 text-right">
                    소계
                  </td>
                  <td className="px-2 py-1 text-right">
                    {KRW(itemsSum.supply)}
                  </td>
                  <td className="px-2 py-1 text-right">{KRW(itemsSum.tax)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="w-24 text-sm text-muted-foreground">고객사 매칭</span>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={readOnly}
            className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-70"
          >
            <option value="">— 미매칭 —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.business_no ? ` (${c.business_no})` : ""}
              </option>
            ))}
          </select>
          {customerId && !readOnly && (
            <button
              type="button"
              onClick={() => setCustomerId("")}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md hover:bg-muted"
              title="매칭 해제"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-24 text-sm text-muted-foreground">프로젝트 매칭</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={readOnly}
            className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-70"
          >
            <option value="">— 미매칭 —</option>
            {filteredProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectId && !readOnly && (
            <button
              type="button"
              onClick={() => setProjectId("")}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md hover:bg-muted"
              title="매칭 해제"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        <label className="flex items-start gap-2 text-sm">
          <span className="w-24 text-sm text-muted-foreground pt-2">메모</span>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            readOnly={readOnly}
            className="flex-1 min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm read-only:opacity-70"
          />
        </label>
      </div>
    </Dialog>
  );
}

function Row({
  label,
  value,
  bold,
  right,
}: {
  label: string;
  value: string;
  bold?: boolean;
  right?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-20 text-sm text-muted-foreground shrink-0">{label}</span>
      <span
        className={
          "flex-1 tabular-nums " +
          (bold ? "font-semibold " : "") +
          (right ? "text-right" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}
