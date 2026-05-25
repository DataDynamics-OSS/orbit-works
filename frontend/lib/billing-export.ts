"use client";

import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { api } from "./api";
import {
  Currency,
  Document,
  KIND_LABEL,
  LineItem,
  TaxMode,
  computeLine,
  computeTotals,
  formatCurrency,
  gradeLabel,
  taxLabel,
} from "./billing";

type DocKind = "quote" | "invoice";

const FALLBACK_LOGO_URL = "/logo.svg";

// html2canvas 는 CORS 로 불러온 이미지만 안전하게 캡처 가능. 미리 로드해서
// 실패 시 로고 없이 렌더.
async function preloadImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

// 업로드된 회사 자산(logo / stamp / seal)이 있으면 blob 으로 내려받아 object URL 로 반환.
// 404 (업로드 안 됨) 이거나 실패하면 null.
async function fetchUploadedAssetObjectUrl(
  kind: "logo" | "stamp" | "seal",
): Promise<string | null> {
  try {
    const res = await api.get(`/company-profile/${kind}`, {
      responseType: "blob",
    });
    return URL.createObjectURL(res.data as Blob);
  } catch {
    return null;
  }
}

// SVG → PNG data URL. html2canvas 는 SVG 의 CSS 크기 제어가 불안정해서
// (특히 viewBox 없는 SVG) 원본 크기로 렌더되어 잘리는 현상이 발생함.
// 미리 targetWidth 에 맞춰 PNG 로 래스터화하면 html2canvas 는 bitmap 으로만 인식.
async function rasterizeImage(
  src: string,
  targetWidth: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const w = img.naturalWidth || targetWidth;
      const h = img.naturalHeight || targetWidth;
      const ratio = h / w;
      const canvas = document.createElement("canvas");
      const dpr = window.devicePixelRatio || 1;
      // 2× 업스케일로 선명도 확보.
      const scale = 2 * dpr;
      canvas.width = Math.round(targetWidth * scale);
      canvas.height = Math.round(targetWidth * ratio * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 견적서(Quote)는 한글, 청구서(Invoice)는 영문을 기본 라벨로 사용.
// 영문 필드가 비어 있으면 한글 값으로 자동 폴백 (issuer).
type L = {
  title: string;
  supplier: string;
  customer: string;
  brand: string; // 상호 / Company
  bizNo: string;
  rep: string;
  addr: string;
  phone: string;
  fax: string;
  email: string;
  entity: string;
  overseas: string;
  domestic: string;
  hashCol: string;
  kindCol: string;
  itemCol: string;
  unitCol: string;
  startCol: string;
  endCol: string;
  qtyCol: string;
  priceCol: string;
  discCol: string;
  amountCol: string;
  supplyAmount: string;
  discountTotal: string;
  totalLabel: string;
  issueDate: string;
  validUntil: string;
  dueDate: string;
  currencyLabel: string;
  memoLabel: string;
  termsLabel: string;
  bank: string;
  accountLabel: string;
  holderLabel: string;
  emptyRow: string;
};

const LABELS_KO: L = {
  title: "견적서",
  supplier: "공급자",
  customer: "공급받는자",
  brand: "상호",
  bizNo: "사업자번호",
  rep: "대표자",
  addr: "주소",
  phone: "전화",
  fax: "팩스",
  email: "이메일",
  entity: "법인 구분",
  overseas: "해외 법인 (영세율 대상)",
  domestic: "국내 법인",
  hashCol: "#",
  kindCol: "구분",
  itemCol: "품명 / 규격",
  unitCol: "단위",
  startCol: "시작일",
  endCol: "종료일",
  qtyCol: "수량",
  priceCol: "단가",
  discCol: "할인",
  amountCol: "공급가액",
  supplyAmount: "공급가액",
  discountTotal: "할인합계",
  totalLabel: "합계",
  issueDate: "작성일",
  validUntil: "유효기간",
  dueDate: "지급기일",
  currencyLabel: "통화",
  memoLabel: "메모",
  termsLabel: "특이사항",
  bank: "입금 계좌",
  accountLabel: "",
  holderLabel: "예금주",
  emptyRow: "라인 항목 없음",
};

const LABELS_EN: L = {
  title: "TAX INVOICE",
  supplier: "Supplier",
  customer: "Bill To",
  brand: "Company",
  bizNo: "Business No.",
  rep: "Representative",
  addr: "Address",
  phone: "Tel",
  fax: "Fax",
  email: "Email",
  entity: "Entity",
  overseas: "Overseas (zero-rated)",
  domestic: "Domestic",
  hashCol: "#",
  kindCol: "Category",
  itemCol: "Description / Spec",
  unitCol: "Unit",
  startCol: "Start",
  endCol: "End",
  qtyCol: "Qty",
  priceCol: "Unit Price",
  discCol: "Disc.",
  amountCol: "Amount",
  supplyAmount: "Subtotal",
  discountTotal: "Discount",
  totalLabel: "Total",
  issueDate: "Issue Date",
  validUntil: "Valid Until",
  dueDate: "Due Date",
  currencyLabel: "Currency",
  memoLabel: "Memo",
  termsLabel: "Terms",
  bank: "Remittance",
  accountLabel: "",
  holderLabel: "Holder",
  emptyRow: "No line items",
};

const KIND_LABEL_EN: Record<LineItem["kind"], string> = {
  PRODUCT: "Product",
  CONSULTING: "Consulting",
  TECH_SUPPORT: "Tech Support",
  DEVELOPMENT: "Development",
  MAINTENANCE: "Maintenance",
  OTHER: "Other",
};

function pref<T extends string | null | undefined>(primary: T, fallback: T): T {
  const p = (primary ?? "") as string;
  return (p.trim() ? primary : fallback) as T;
}

export function buildDocumentHTML(
  doc: Document,
  kind: DocKind,
  opts: { logoUrl?: string | null } = {},
): string {
  // 언어 결정:
  //   invoice — 항상 EN (legacy 동작)
  //   quote   — doc.locale 가 'en' 이면 EN, 아니면 KO (default)
  const useEn = kind === "invoice" || (doc as any).locale === "en";
  const L = useEn ? LABELS_EN : LABELS_KO;
  const KLABEL = useEn ? KIND_LABEL_EN : KIND_LABEL;

  const issuer = doc.issuer_snapshot ?? {};
  // 영문 문서는 EN 필드 우선, 비어 있으면 한글로 폴백.
  const issuerName = useEn ? pref(issuer.name_en, issuer.name) : issuer.name;
  const issuerRep = useEn
    ? pref(issuer.representative_en, issuer.representative)
    : issuer.representative;
  const issuerAddr = useEn
    ? pref(issuer.address_en, issuer.address)
    : issuer.address;

  const cust = doc.customer_snapshot ?? {};
  const totals = computeTotals(doc.items, doc.tax_mode as TaxMode, doc.tax_rate);
  const ccy = doc.currency as Currency;

  const kv = (k: string, v: string | null | undefined) => `
    <tr>
      <td style="padding:3px 8px;color:#000;font-weight:600;width:92px;white-space:nowrap;">${escapeHtml(k)}</td>
      <td style="padding:3px 8px;">${escapeHtml(v ?? "-")}</td>
    </tr>`;

  const leftBox = `
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      ${kv(L.brand, issuerName)}
      ${kv(L.bizNo, issuer.business_no)}
      ${kv(L.rep, issuerRep)}
      ${kv(L.addr, issuerAddr)}
      ${kv(L.phone, issuer.phone)}
      ${issuer.fax ? kv(L.fax, issuer.fax) : ""}
      ${kv(L.email, issuer.email)}
    </table>`;

  // 청구서(invoice)는 Bill To 에 사업자번호/대표자 대신 PO No. 표기.
  const rightBox =
    kind === "invoice"
      ? `
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      ${kv(L.brand, cust.name)}
      ${kv(L.addr, cust.address)}
      ${kv("PO No.", doc.po_no)}
    </table>`
      : `
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      ${kv(L.brand, cust.name)}
      ${kv(L.bizNo, cust.business_no)}
      ${kv(L.rep, cust.representative)}
      ${kv(L.addr, cust.address)}
    </table>`;

  // 가로 방향 A4 (landscape) — 견적 항목을 표로 표시. 각 row 는 data-block="item" 로
  // 표식해 페이지 분할 시 경계로 사용.
  // 날짜/년수/M-M 컬럼은 실제 값이 있는 라인이 있을 때만 노출.
  const anyDates = doc.items.some((i) => i.period_start || i.period_end);
  const anyYears = doc.items.some(
    (i) => i.kind !== "DEVELOPMENT" && Number(i.years ?? 1) > 1,
  );
  const yearsLabel = useEn ? "Years" : "년수";
  const monthsLabel = "M/M";
  const anyMM = doc.items.some(
    (i) =>
      (i.kind === "CONSULTING" ||
        i.kind === "TECH_SUPPORT" ||
        i.kind === "DEVELOPMENT" ||
        i.kind === "MAINTENANCE") &&
      i.months != null &&
      i.months !== "",
  );

  // html2canvas 의 table-cell vertical-align 처리가 불안정해서 flex 래퍼로 강제 중앙정렬.
  const alignToJustify = (a: string) =>
    a === "right" ? "flex-end" : a === "left" ? "flex-start" : "center";
  const th = (label: string, width: string, align: string = "center") =>
    `<th style="padding:0;background:#f1f5f9;border-bottom:2px solid #cbd5e1;border-right:1px solid #e2e8f0;font-size:11px;font-weight:600;${width};">
       <div style="display:flex;align-items:center;justify-content:${alignToJustify(align)};min-height:32px;padding:6px 8px;">${label}</div>
     </th>`;

  const headRow = `
    <tr>
      ${th(L.hashCol, "width:32px")}
      ${th(L.kindCol, "width:80px")}
      ${th(L.itemCol, "", "left")}
      ${th(L.unitCol, "width:56px")}
      ${anyDates ? th(L.startCol, "width:84px") : ""}
      ${anyDates ? th(L.endCol, "width:84px") : ""}
      ${anyMM ? th(monthsLabel, "width:56px", "right") : ""}
      ${anyYears ? th(yearsLabel, "width:56px", "right") : ""}
      ${th(L.qtyCol, "width:64px", "right")}
      ${th(L.priceCol, "width:110px", "right")}
      ${th(L.discCol, "width:56px", "right")}
      ${th(L.amountCol, "width:130px", "right")}
    </tr>`;

  const td = (content: string, align: string = "center") =>
    `<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;border-right:1px solid #f1f5f9;text-align:${align};font-size:11px;vertical-align:top;">${content}</td>`;

  const itemRows = doc.items
    .map((i: LineItem, idx) => {
      const c = computeLine(i);
      const isHuman =
        i.kind === "CONSULTING" ||
        i.kind === "TECH_SUPPORT" ||
        i.kind === "DEVELOPMENT" ||
        i.kind === "MAINTENANCE";
      const nameWithGrade =
        isHuman && i.role
          ? `${i.name} [${gradeLabel(i.role, useEn)}]`
          : i.name;
      const spec = i.description ?? "";
      const manual = !!i.manual_total;
      const yearsVal = i.kind === "DEVELOPMENT" ? "-" : String(Number(i.years ?? 1) || 1);
      const mmVal = isHuman && i.months != null && i.months !== "" ? String(i.months) : "-";
      const nameCell = `
        <div style="font-weight:600;">${escapeHtml(nameWithGrade)}</div>
        ${spec ? `<div style="color:#000;font-size:10px;white-space:pre-wrap;margin-top:2px;">${escapeHtml(spec)}</div>` : ""}`;
      return `
        <tr data-block="item" style="page-break-inside:avoid;">
          ${td(String(idx + 1))}
          ${td(escapeHtml(KLABEL[i.kind]))}
          ${td(nameCell, "left")}
          ${td(escapeHtml(i.unit ?? "-"))}
          ${anyDates ? td(escapeHtml(i.period_start ?? "-")) : ""}
          ${anyDates ? td(escapeHtml(i.period_end ?? "-")) : ""}
          ${anyMM ? td(mmVal, "right") : ""}
          ${anyYears ? td(yearsVal, "right") : ""}
          ${td(Number(i.quantity).toLocaleString(), "right")}
          ${td(formatCurrency(i.unit_price, ccy), "right")}
          ${td(manual ? "-" : `${Number(i.discount_rate || 0)}%`, "right")}
          ${td(formatCurrency(c.total, ccy), "right")}
        </tr>`;
    })
    .join("");

  const colCount =
    8 +
    (anyDates ? 2 : 0) +
    (anyMM ? 1 : 0) +
    (anyYears ? 1 : 0);

  const itemsSection = `
    <table data-block="items-table" style="width:100%;border-collapse:collapse;table-layout:auto;margin-top:4px;border:1px solid #e2e8f0;">
      <thead>${headRow}</thead>
      <tbody>${
        itemRows ||
        `<tr data-block="item"><td colspan="${colCount}" style="padding:24px;text-align:center;color:#000;font-size:11px;">${L.emptyRow}</td></tr>`
      }</tbody>
    </table>`;

  const taxRowLabel = useEn
    ? (Number(doc.tax_rate) === 0
        ? "VAT (Zero-rated 0%)"
        : (doc.tax_mode === "INCLUSIVE"
            ? `VAT (incl. ${Number(doc.tax_rate)}%)`
            : `VAT (${Number(doc.tax_rate)}%)`))
    : taxLabel(doc.tax_rate, doc.tax_mode as TaxMode);

  const summary = `
    <table data-block="summary" style="width:320px;border-collapse:collapse;font-size:11px;margin-left:auto;margin-top:10px;">
      <tr>
        <td style="padding:4px 8px;color:#000;">${L.supplyAmount}</td>
        <td style="padding:4px 8px;text-align:right;">${formatCurrency(totals.taxable, ccy)}</td>
      </tr>
      ${
        totals.discount_total > 0
          ? `<tr><td style="padding:4px 8px;color:#000;">${L.discountTotal}</td><td style="padding:4px 8px;text-align:right;">- ${formatCurrency(totals.discount_total, ccy)}</td></tr>`
          : ""
      }
      <tr>
        <td style="padding:4px 8px;color:#000;">${escapeHtml(taxRowLabel)}</td>
        <td style="padding:4px 8px;text-align:right;">${formatCurrency(totals.tax_amount, ccy)}</td>
      </tr>
      <tr>
        <td style="padding:8px;border-top:2px solid #0f172a;font-weight:700;">${L.totalLabel}</td>
        <td style="padding:8px;border-top:2px solid #0f172a;font-weight:700;text-align:right;font-size:13px;">${formatCurrency(totals.total_amount, ccy)}</td>
      </tr>
    </table>`;

  // 견적서: "작성일 / 유효기간" 단일 라인. 청구서: 별도 2열 메타 블록으로 렌더.
  const secondaryDate = kind === "quote" ? doc.valid_until : doc.due_date;
  const secondaryLabel = kind === "quote" ? L.validUntil : L.dueDate;
  const dateLine =
    `${L.issueDate}: ${escapeHtml(doc.issue_date)}` +
    (secondaryDate
      ? ` / ${secondaryLabel}: ${escapeHtml(secondaryDate)}`
      : "");

  // 청구서 상단 메타 — Terms = 지급기일 - 발행일 일수 차이 (Net N).
  function diffDays(a: string | null | undefined, b: string | null | undefined): number | null {
    if (!a || !b) return null;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
    return Math.round((tb - ta) / (24 * 3600 * 1000));
  }
  const netDays = diffDays(doc.issue_date, doc.due_date ?? undefined);
  const termsText = netDays != null && netDays >= 0 ? `Net ${netDays}` : "-";
  const taxPct = Number(doc.tax_rate);
  const metaCell = (k: string, v: string) =>
    `<td style="padding:4px 8px;color:#000;font-weight:600;width:92px;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:4px 8px;">${escapeHtml(v)}</td>`;
  const invoiceMetaTable = `
    <table data-block="dateline" style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px;">
      <tr>
        ${metaCell("Issue Date", doc.issue_date ?? "-")}
        ${metaCell("Currency", doc.currency)}
      </tr>
      <tr>
        ${metaCell("Due Date", doc.due_date ?? "-")}
        ${metaCell("VAT", `${taxPct}%`)}
      </tr>
      <tr>
        ${metaCell("Terms", termsText)}
        <td></td><td></td>
      </tr>
    </table>`;

  const fullNumber = doc.display_number || doc.number;
  const numberLabel = useEn ? `Invoice No.: ${fullNumber}` : fullNumber;

  // 사용자가 입력한 제목(doc.title)을 큰 제목으로 사용. 비어있으면 기본값:
  //   invoice                — "INVOICE"
  //   quote (locale=en)      — "QUOTATION" (LABELS_EN.title 은 'TAX INVOICE'
  //                            라 견적서 부적절 → 별도 default)
  //   quote (locale=ko/null) — "견적서"
  const defaultTitle =
    kind === "invoice"
      ? "INVOICE"
      : useEn ? "QUOTATION" : "견적서";
  const heroTitle =
    doc.title && doc.title.trim() ? doc.title : defaultTitle;

  const attnLabel = useEn ? "Attn" : "수신";
  const projLabel = useEn ? "Project" : "사업명";
  const hasAttn = !!(doc.attention && doc.attention.trim());
  const hasProj = !!(doc.business_name && doc.business_name.trim());
  const contextRows =
    hasAttn || hasProj
      ? `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:12px;">
          ${hasAttn ? `<tr><td style="padding:3px 8px;color:#000;font-weight:600;width:92px;white-space:nowrap;">${attnLabel}</td><td style="padding:3px 8px;">${escapeHtml(doc.attention)}</td></tr>` : ""}
          ${hasProj ? `<tr><td style="padding:3px 8px;color:#000;font-weight:600;width:92px;white-space:nowrap;">${projLabel}</td><td style="padding:3px 8px;">${escapeHtml(doc.business_name)}</td></tr>` : ""}
        </table>`
      : "";

  // exportDocumentPDF 에서 이미 PNG 로 래스터화된 data URL 이 전달됨.
  const logoHtml = opts.logoUrl
    ? `<img src="${escapeHtml(opts.logoUrl)}" alt="logo" style="width:200px;height:auto;display:block;" />`
    : "";

  return `
    <div style="padding:8px 16px;">
      <div style="text-align:center;margin-bottom:18px;">
        <div style="font-size:24px;font-weight:800;letter-spacing:${useEn ? "4px" : "4px"};">${escapeHtml(heroTitle)}</div>
        <div style="font-size:12px;color:#000;margin-top:4px;">${escapeHtml(numberLabel)}</div>
      </div>
      ${contextRows}
      <div data-block="parties" style="display:flex;gap:16px;margin-bottom:16px;">
        <div style="flex:1;border:1px solid #e2e8f0;border-radius:6px;padding:10px;">
          <div style="font-size:11px;font-weight:700;color:#000;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin-bottom:6px;">${L.supplier}</div>
          ${leftBox}
        </div>
        <div style="flex:1;border:1px solid #e2e8f0;border-radius:6px;padding:10px;">
          <div style="font-size:11px;font-weight:700;color:#000;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin-bottom:6px;">${L.customer}</div>
          ${rightBox}
        </div>
      </div>
      ${
        kind === "invoice"
          ? invoiceMetaTable
          : `<div data-block="dateline" style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#000;margin-bottom:8px;">
              <div>${dateLine}</div>
              <div>${L.currencyLabel}: ${doc.currency}</div>
            </div>`
      }
      ${itemsSection}
      ${summary}
      ${
        doc.memo || doc.terms
          ? `<div data-block="memo" style="margin-top:16px;font-size:10px;color:#000;white-space:pre-wrap;">
              ${doc.memo ? `<div style="font-weight:600;margin-top:6px;">${L.memoLabel}</div><div>${escapeHtml(doc.memo)}</div>` : ""}
              ${doc.terms ? `<div style="font-weight:600;margin-top:6px;">${L.termsLabel}</div><div>${escapeHtml(doc.terms)}</div>` : ""}
            </div>`
          : ""
      }
      ${
        logoHtml
          ? `<div data-block="logo" style="margin-top:24px;display:flex;justify-content:flex-end;">${logoHtml}</div>`
          : ""
      }
    </div>
  `;
}

export async function exportDocumentPDF(
  doc: Document,
  kind: DocKind,
): Promise<void> {
  // 1순위: 사용자가 Settings 에서 업로드한 로고 (blob → object URL)
  // 2순위: 기본 외부 URL (CORS 프리로드 성공 시)
  // 둘 다 실패하면 로고 생략.
  let sourceLogoUrl: string | null = await fetchUploadedAssetObjectUrl("logo");
  const logoIsObjectUrl = sourceLogoUrl !== null;
  if (!sourceLogoUrl) {
    const ok = await preloadImage(FALLBACK_LOGO_URL);
    if (ok) sourceLogoUrl = FALLBACK_LOGO_URL;
  }
  // html2canvas 가 SVG 의 CSS 크기를 신뢰하지 못하므로 목표 폭(200px)에 맞춰 PNG 로 변환.
  const logoUrl = sourceLogoUrl
    ? await rasterizeImage(sourceLogoUrl, 200)
    : null;
  if (logoIsObjectUrl && sourceLogoUrl) URL.revokeObjectURL(sourceLogoUrl);

  const html = buildDocumentHTML(doc, kind, { logoUrl });
  const container = document.createElement("div");
  // A4 landscape 비율 (842×595 pt ≈ 1123×794 px @96dpi) 에 맞춰 폭을 넓힘.
  container.style.cssText =
    "position: fixed; top: -20000px; left: 0; width: 1100px; padding: 24px; background: #ffffff; font-family: 'Noto Sans KR', sans-serif; color: #000;";
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
      try {
        await (document as any).fonts.load?.("400 12px 'Noto Sans KR'");
        await (document as any).fonts.load?.("700 12px 'Noto Sans KR'");
      } catch {
        // ignore
      }
    }
    // 페이지 분할을 블록 경계에서 자르기 위해 각 data-block 의 bottom 을 미리 측정.
    const scale = 2;
    const containerTop = container.getBoundingClientRect().top;
    const blockBottomsCss = Array.from(
      container.querySelectorAll<HTMLElement>("[data-block]"),
    ).map((el) => el.getBoundingClientRect().bottom - containerTop);

    const canvas = await html2canvas(container, {
      scale,
      backgroundColor: "#ffffff",
      useCORS: true,
    });
    // CSS px → canvas px.
    const blockBottoms = blockBottomsCss.map((y) => Math.round(y * scale));

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    // 페이지 번호 영역 확보를 위해 실제 본문은 bottomMargin 만큼 위까지만 사용.
    const bottomMargin = 24;
    const usableH = pageH - bottomMargin;
    // canvas px ↔ PDF pt 비율.
    const pxToPt = pageW / canvas.width;
    const usableCanvasH = usableH / pxToPt;

    // [startY, endY] 구간을 잘라 새 canvas 로 만들고 PDF 에 추가.
    function addSlice(startY: number, endY: number, first: boolean) {
      const sliceH = endY - startY;
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceH;
      const ctx = sliceCanvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(
        canvas,
        0,
        startY,
        canvas.width,
        sliceH,
        0,
        0,
        canvas.width,
        sliceH,
      );
      const data = sliceCanvas.toDataURL("image/png");
      if (!first) pdf.addPage();
      pdf.addImage(data, "PNG", 0, 0, pageW, sliceH * pxToPt);
    }

    if (canvas.height <= usableCanvasH) {
      addSlice(0, canvas.height, true);
    } else {
      let startY = 0;
      let first = true;
      while (startY < canvas.height) {
        const hardEnd = Math.min(startY + usableCanvasH, canvas.height);
        let endY = hardEnd;
        // 가능하면 [startY, hardEnd] 안에서 가장 큰 블록 bottom 을 컷 지점으로.
        const candidates = blockBottoms.filter(
          (b) => b > startY && b <= hardEnd,
        );
        if (candidates.length > 0 && hardEnd < canvas.height) {
          endY = candidates[candidates.length - 1];
        }
        // 극단 케이스 — 블록 하나가 페이지보다 큼. 그냥 하드 컷.
        if (endY <= startY) endY = hardEnd;
        addSlice(startY, endY, first);
        first = false;
        startY = endY;
      }
    }

    // 페이지 번호 — 하단 중앙. 내부 pages 배열은 [_blank, page1, page2, ...].
    const total = (pdf as any).internal.pages.length - 1;
    for (let p = 1; p <= total; p++) {
      pdf.setPage(p);
      pdf.setFontSize(9);
      pdf.setTextColor(0, 0, 0);
      pdf.text(`${p} / ${total}`, pageW / 2, pageH - 10, { align: "center" });
    }

    pdf.save(`${doc.display_number || doc.number}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}

export function exportDocumentExcel(doc: Document, kind: DocKind): void {
  const ccy = doc.currency as Currency;
  const totals = computeTotals(doc.items, doc.tax_mode as TaxMode, doc.tax_rate);
  // invoice 는 항상 EN. quote 는 doc.locale 가 'en' 이면 EN, 아니면 KO.
  const useEn = kind === "invoice" || (doc as any).locale === "en";

  // KIND 라벨 (영문 invoice 용).
  const KIND_LABEL_EN: Record<LineItem["kind"], string> = {
    PRODUCT: "Product",
    CONSULTING: "Consulting",
    TECH_SUPPORT: "Tech Support",
    DEVELOPMENT: "Development",
    MAINTENANCE: "Maintenance",
    OTHER: "Other",
  };
  const kindLabel = (k: LineItem["kind"]) =>
    (useEn ? KIND_LABEL_EN : KIND_LABEL)[k];

  // 견적서 (한글) / 청구서 (영문) 시트 헤더.
  const header: Array<Record<string, string | number>> = useEn
    ? [
        { Field: "Document No.", Value: doc.display_number || doc.number },
        { Field: "Document Type", Value: "TAX INVOICE" },
        { Field: "Title", Value: doc.title },
        { Field: "Bill To", Value: doc.customer_snapshot?.name ?? "-" },
        { Field: "PO Number", Value: doc.po_no ?? "-" },
        { Field: "Currency", Value: ccy },
        { Field: "Issue Date", Value: doc.issue_date },
        { Field: "Due Date", Value: doc.due_date ?? "-" },
        { Field: "Tax Mode", Value: doc.tax_mode },
        { Field: "Tax Rate (%)", Value: Number(doc.tax_rate) },
        { Field: "Subtotal", Value: Math.round(totals.taxable) },
        { Field: "Discount", Value: Math.round(totals.discount_total) },
        { Field: "VAT", Value: Math.round(totals.tax_amount) },
        { Field: "Total", Value: Math.round(totals.total_amount) },
      ]
    : [
        { 항목: "문서 번호", 값: doc.display_number || doc.number },
        { 항목: "문서 종류", 값: "견적서" },
        { 항목: "제목", 값: doc.title },
        { 항목: "고객사", 값: doc.customer_snapshot?.name ?? "-" },
        { 항목: "통화", 값: ccy },
        { 항목: "발행일", 값: doc.issue_date },
        { 항목: "유효기간", 값: doc.valid_until ?? "-" },
        { 항목: "과세방식", 값: doc.tax_mode },
        { 항목: "세율(%)", 값: Number(doc.tax_rate) },
        { 항목: "공급가액", 값: Math.round(totals.taxable) },
        { 항목: "할인합계", 값: Math.round(totals.discount_total) },
        { 항목: "부가세", 값: Math.round(totals.tax_amount) },
        { 항목: "합계", 값: Math.round(totals.total_amount) },
      ];

  const itemRows = doc.items.map((i, idx) => {
    const c = computeLine(i);
    const manual = !!i.manual_total;
    const isHuman =
      i.kind === "CONSULTING" ||
      i.kind === "TECH_SUPPORT" ||
      i.kind === "DEVELOPMENT" ||
      i.kind === "MAINTENANCE";
    const nameWithGrade =
      isHuman && i.role
        ? `${i.name} [${gradeLabel(i.role, useEn)}]`
        : i.name;
    if (useEn) {
      return {
        "#": idx + 1,
        Category: kindLabel(i.kind),
        Description: nameWithGrade,
        Spec: i.description ?? "",
        Unit: i.unit ?? "",
        Start: i.period_start ?? "",
        End: i.period_end ?? "",
        Qty: Number(i.quantity),
        "Unit Price": Number(i.unit_price),
        "Disc. (%)": manual ? "" : Number(i.discount_rate || 0),
        Years:
          i.kind === "DEVELOPMENT"
            ? ""
            : Number(i.years ?? 1) || 1,
        Amount: Math.round(c.total),
        Input: manual ? "Manual" : "Auto",
      } as Record<string, string | number>;
    }
    return {
      순번: idx + 1,
      구분: kindLabel(i.kind),
      품명: nameWithGrade,
      규격: i.description ?? "",
      단위: i.unit ?? "",
      시작일: i.period_start ?? "",
      종료일: i.period_end ?? "",
      수량: Number(i.quantity),
      단가: Number(i.unit_price),
      "할인율(%)": manual ? "" : Number(i.discount_rate || 0),
      년수: i.kind === "DEVELOPMENT" ? "" : Number(i.years ?? 1) || 1,
      공급가액: Math.round(c.total),
      "금액입력": manual ? "수동" : "자동",
    };
  });

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(header);
  ws1["!cols"] = [{ wch: 18 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws1, useEn ? "Summary" : "요약");
  const ws2 = XLSX.utils.json_to_sheet(
    itemRows.length
      ? itemRows
      : [useEn ? { "#": "-" } : { 순번: "-" }],
  );
  ws2["!cols"] = useEn
    ? [
        { wch: 6 },   // #
        { wch: 12 },  // Category
        { wch: 32 },  // Description
        { wch: 28 },  // Spec
        { wch: 8 },   // Unit
        { wch: 12 },  // Start
        { wch: 12 },  // End
        { wch: 10 },  // Qty
        { wch: 14 },  // Unit Price
        { wch: 10 },  // Disc
        { wch: 8 },   // Years
        { wch: 14 },  // Amount
        { wch: 10 },  // Input
      ]
    : [
        { wch: 6 },  // 순번
        { wch: 10 }, // 구분
        { wch: 32 }, // 품명
        { wch: 28 }, // 규격
        { wch: 8 },  // 단위
        { wch: 12 }, // 시작일
        { wch: 12 }, // 종료일
        { wch: 10 }, // 수량
        { wch: 14 }, // 단가
        { wch: 10 }, // 할인율
        { wch: 8 },  // 년수
        { wch: 14 }, // 공급가액
        { wch: 10 }, // 금액입력
      ];
  XLSX.utils.book_append_sheet(wb, ws2, useEn ? "Lines" : "라인");
  XLSX.writeFile(wb, `${doc.display_number || doc.number}.xlsx`);
}
