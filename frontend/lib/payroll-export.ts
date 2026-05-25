"use client";

// Vector-based 급여명세서 PDF
// - jsPDF native API + jspdf-autotable + Noto Sans KR 폰트 임베드
// - 기존 html2canvas 래스터 방식의 한계(검색 불가/인쇄 흐림/페이지 분할 잘림)를
//   해결. 좌표는 pt 단위 절대 위치(헤더·푸터·실수령액 박스).

import jsPDF from "jspdf";
import autoTable, { type CellInput, type RowInput } from "jspdf-autotable";
import { api } from "./api";

type Company = {
  name?: string | null;
  business_no?: string | null;
  representative?: string | null;
  address?: string | null;
  logo_name?: string | null;
};

export type PayStubData = {
  company: Company;
  year: number;
  month: number;
  pay_date?: string | null;
  is_year_end_adjustment: boolean;
  employee: {
    id: string;
    name: string;
    employment_type?: string | null;
    department?: string | null;
  };
  mode: "PAYROLL" | "WITHHOLDING";
  // 과세
  base_salary: number;
  position_allowance: number;
  overtime_pay: number;
  holiday_pay: number;
  annual_leave_pay: number;
  family_allowance: number;
  bonus: number;
  holiday_bonus: number;
  other_taxable: number;
  // 비과세
  meal_allowance: number;
  car_allowance: number;
  childcare_allowance: number;
  research_allowance: number;
  expense_reimbursement: number;
  tuition: number;
  other_nontax: number;
  // 공제
  pension: number;
  health: number;
  long_term_care: number;
  employment_insurance: number;
  income_tax: number;
  local_tax: number;
  year_end_income_tax: number;
  year_end_local_tax: number;
  other_deduction: number;
  // 프리랜서
  freelancer_gross: number;
  // 합계
  gross_taxable: number;
  gross_nontax: number;
  total_deduction: number;
  net_pay: number;
  memo?: string | null;
  // PDF 비밀번호 — 주민등록번호 앞 6자리(생년월일). null 이면 비밀번호 없이 발행.
  pdf_password?: string | null;
};

// ─────────────────────────────────────────────────────────────
// 폰트 로딩 — 첫 호출 시 fetch → base64 캐시 → 같은 탭에서 재사용
// ─────────────────────────────────────────────────────────────

const FONT_FAMILY = "NotoSansKR";

let fontCache: { regular: string; bold: string } | null = null;
let fontPromise: Promise<{ regular: string; bold: string }> | null = null;

async function fetchFontBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font load failed: ${url} ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(s);
}

async function loadFonts(): Promise<{ regular: string; bold: string }> {
  if (fontCache) return fontCache;
  if (!fontPromise) {
    fontPromise = Promise.all([
      fetchFontBase64("/fonts/NotoSansKR-Regular.ttf"),
      fetchFontBase64("/fonts/NotoSansKR-Bold.ttf"),
    ]).then(([regular, bold]) => {
      fontCache = { regular, bold };
      return fontCache;
    });
  }
  return fontPromise;
}

function registerFonts(
  pdf: jsPDF,
  fonts: { regular: string; bold: string },
): void {
  pdf.addFileToVFS("NotoSansKR-Regular.ttf", fonts.regular);
  pdf.addFont("NotoSansKR-Regular.ttf", FONT_FAMILY, "normal");
  pdf.addFileToVFS("NotoSansKR-Bold.ttf", fonts.bold);
  pdf.addFont("NotoSansKR-Bold.ttf", FONT_FAMILY, "bold");
  pdf.setFont(FONT_FAMILY, "normal");
}

// ─────────────────────────────────────────────────────────────
// 로고 (raster) — vector 본문 안에 PNG 이미지로만 사용
// ─────────────────────────────────────────────────────────────

async function fetchLogoDataUrl(): Promise<string | null> {
  try {
    const res = await api.get("/company-profile/logo", { responseType: "blob" });
    const blob = res.data as Blob;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 포맷터
// ─────────────────────────────────────────────────────────────

function fmt(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "-";
  const sign = v < 0 ? "- " : "";
  return sign + Math.abs(Math.round(v)).toLocaleString("ko-KR");
}

// 실수령액 — 10원 미만 절사
function fmtNet(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "-";
  const sign = v < 0 ? "- " : "";
  const t = Math.trunc(Math.abs(v) / 10) * 10;
  return sign + t.toLocaleString("ko-KR");
}

// ─────────────────────────────────────────────────────────────
// 페이지 좌표계 — A4 portrait, pt 단위
// ─────────────────────────────────────────────────────────────

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 48;
const HEADER_H = 80; // 회사명/타이틀/연월/로고 영역
const FOOTER_RESERVE = 32; // 푸터 공간 (사업자번호/페이지번호)
const CONTENT_W = PAGE_W - MARGIN_X * 2; // 499.28
const TABLE_TOP = MARGIN_TOP + HEADER_H;

// 6열 표 폭: label/value × 3
const LABEL_W = 75;
const VALUE_W = (CONTENT_W - LABEL_W * 3) / 3; // ≈ 91.4

// ─────────────────────────────────────────────────────────────
// 컬러 팔레트 (Tailwind slate / sky 톤과 일치)
// ─────────────────────────────────────────────────────────────

const C_TEXT: [number, number, number] = [15, 23, 42]; // slate-900
const C_MUTED: [number, number, number] = [100, 116, 139]; // slate-500
const C_LABEL_TX: [number, number, number] = [71, 85, 105]; // slate-600
const C_LABEL_BG: [number, number, number] = [248, 250, 252]; // slate-50
const C_SECTION_BG: [number, number, number] = [241, 245, 249]; // slate-100
const C_SUBTOTAL_BG: [number, number, number] = [254, 249, 195]; // amber-100
const C_NONTAX: [number, number, number] = [3, 105, 161]; // sky-700
const C_BORDER: [number, number, number] = [203, 213, 225]; // slate-300
const C_NET_BG: [number, number, number] = [15, 23, 42];
const C_NET_TX: [number, number, number] = [255, 255, 255];

// ─────────────────────────────────────────────────────────────
// 페이지 chrome (header / footer)
// ─────────────────────────────────────────────────────────────

function drawPageChrome(
  pdf: jsPDF,
  d: PayStubData,
  logoDataUrl: string | null,
): void {
  // 회사명
  pdf.setFont(FONT_FAMILY, "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(...C_MUTED);
  pdf.text(d.company.name ?? "", MARGIN_X, MARGIN_TOP + 4);

  // "급여명세서"
  pdf.setFont(FONT_FAMILY, "bold");
  pdf.setFontSize(20);
  pdf.setTextColor(...C_TEXT);
  pdf.text("급여명세서", MARGIN_X, MARGIN_TOP + 28);

  // 연월 / 보조 라벨
  pdf.setFont(FONT_FAMILY, "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(51, 65, 85);
  const sub =
    `${d.year}년 ${String(d.month).padStart(2, "0")}월` +
    (d.is_year_end_adjustment ? " · 연말정산" : "") +
    (d.mode === "WITHHOLDING" ? " · 사업소득" : "");
  pdf.text(sub, MARGIN_X, MARGIN_TOP + 44);

  // 우측 상단 — 직원/지급일
  pdf.setFont(FONT_FAMILY, "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(...C_MUTED);
  pdf.text("성명", PAGE_W - MARGIN_X - 200, MARGIN_TOP + 16);
  pdf.text("지급일", PAGE_W - MARGIN_X - 200, MARGIN_TOP + 32);
  pdf.setFont(FONT_FAMILY, "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(...C_TEXT);
  pdf.text(d.employee.name, PAGE_W - MARGIN_X - 160, MARGIN_TOP + 16);
  pdf.setFont(FONT_FAMILY, "normal");
  pdf.text(d.pay_date ?? "-", PAGE_W - MARGIN_X - 160, MARGIN_TOP + 32);

  // 로고 (있을 때 우측 상단 코너)
  if (logoDataUrl) {
    try {
      const W = 80;
      const H = 22;
      pdf.addImage(
        logoDataUrl,
        "PNG",
        PAGE_W - MARGIN_X - W,
        MARGIN_TOP + 44,
        W,
        H,
        undefined,
        "FAST",
      );
    } catch {
      // logo render error는 무시 — 본문에는 영향 없음
    }
  }

  // 헤더 구분선
  pdf.setDrawColor(...C_TEXT);
  pdf.setLineWidth(1);
  pdf.line(
    MARGIN_X,
    MARGIN_TOP + HEADER_H - 8,
    PAGE_W - MARGIN_X,
    MARGIN_TOP + HEADER_H - 8,
  );

  // 푸터
  pdf.setFont(FONT_FAMILY, "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(...C_MUTED);
  const footerY = PAGE_H - MARGIN_BOTTOM + 16;
  const left = `${d.company.name ?? ""}${
    d.company.business_no ? `  ·  사업자번호 ${d.company.business_no}` : ""
  }`;
  pdf.text(left, MARGIN_X, footerY);
  const totalPages =
    typeof (pdf as unknown as { getNumberOfPages?: () => number })
      .getNumberOfPages === "function"
      ? (pdf as unknown as { getNumberOfPages: () => number }).getNumberOfPages()
      : 1;
  const pageNo = pdf.getCurrentPageInfo().pageNumber;
  pdf.text(
    `${pageNo} / ${totalPages}`,
    PAGE_W - MARGIN_X,
    footerY,
    { align: "right" },
  );
}

// ─────────────────────────────────────────────────────────────
// 표 행 빌더
// ─────────────────────────────────────────────────────────────

type Item = { label: string; value: number; nontax?: boolean };

function gridRows(items: Item[]): RowInput[] {
  const rows: RowInput[] = [];
  for (let i = 0; i < items.length; i += 3) {
    const trio: (Item | undefined)[] = [
      items[i],
      items[i + 1],
      items[i + 2],
    ];
    const cells: CellInput[] = [];
    for (const it of trio) {
      if (!it) {
        cells.push({ content: "", styles: { fillColor: C_LABEL_BG } });
        cells.push({ content: "" });
      } else {
        cells.push({
          content: it.label + (it.nontax ? " (비과세)" : ""),
          styles: {
            fillColor: C_LABEL_BG,
            textColor: it.nontax ? C_NONTAX : C_LABEL_TX,
            fontStyle: "bold",
          },
        });
        cells.push({
          content: fmt(it.value),
          styles: {
            halign: "right",
            textColor: it.nontax ? C_NONTAX : C_TEXT,
            fontStyle: "bold",
          },
        });
      }
    }
    rows.push(cells);
  }
  return rows;
}

function sectionHeader(title: string): RowInput {
  return [
    {
      content: title,
      colSpan: 6,
      styles: {
        fillColor: C_SECTION_BG,
        textColor: C_TEXT,
        fontStyle: "bold",
        fontSize: 10,
        halign: "left",
        cellPadding: { top: 6, right: 8, bottom: 6, left: 8 },
      },
    },
  ];
}

function subtotalRow(
  parts: { label: string; value: number; nontax?: boolean }[],
): RowInput {
  const cells: CellInput[] = [];
  for (let i = 0; i < 3; i++) {
    const p = parts[i];
    if (!p) {
      cells.push({ content: "", styles: { fillColor: C_SUBTOTAL_BG } });
      cells.push({ content: "", styles: { fillColor: C_SUBTOTAL_BG } });
    } else {
      cells.push({
        content: p.label,
        styles: {
          fillColor: C_SUBTOTAL_BG,
          textColor: p.nontax ? C_NONTAX : C_TEXT,
          fontStyle: "bold",
          halign: "right",
        },
      });
      cells.push({
        content: fmt(p.value),
        styles: {
          fillColor: C_SUBTOTAL_BG,
          textColor: p.nontax ? C_NONTAX : C_TEXT,
          fontStyle: "bold",
          halign: "right",
        },
      });
    }
  }
  return cells;
}

function netRow(label: string, value: number): RowInput {
  return [
    {
      content: label,
      colSpan: 4,
      styles: {
        fillColor: C_NET_BG,
        textColor: C_NET_TX,
        fontStyle: "bold",
        fontSize: 11,
        halign: "right",
        cellPadding: { top: 12, right: 10, bottom: 12, left: 10 },
      },
    },
    {
      content: fmtNet(value) + " 원",
      colSpan: 2,
      styles: {
        fillColor: C_NET_BG,
        textColor: C_NET_TX,
        fontStyle: "bold",
        fontSize: 14,
        halign: "right",
        cellPadding: { top: 12, right: 10, bottom: 12, left: 10 },
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// PDF 빌드
// ─────────────────────────────────────────────────────────────

export async function exportPayStubPDF(d: PayStubData): Promise<Blob> {
  const [fonts, logoDataUrl] = await Promise.all([
    loadFonts(),
    fetchLogoDataUrl(),
  ]);

  // 비밀번호가 지정되면 PDF 를 암호화. 직원이 PDF 를 열 때만 비번을 요구하고
  // 인쇄·복사는 허용 (수정·주석은 비번 없이는 불가).
  const password = (d.pdf_password ?? "").trim() || null;
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4",
    ...(password
      ? {
          encryption: {
            userPassword: password,
            ownerPassword: password,
            userPermissions: ["print", "copy"],
          },
        }
      : {}),
  });
  registerFonts(pdf, fonts);

  // 첫 페이지 chrome
  drawPageChrome(pdf, d, logoDataUrl);

  // 표 데이터 조립
  const body: RowInput[] = [];

  if (d.mode === "WITHHOLDING") {
    const items: Item[] = [
      { label: "용역비 (지급액)", value: d.freelancer_gross },
      { label: "소득세 (3%)", value: d.income_tax },
      { label: "지방소득세 (0.3%)", value: d.local_tax },
      { label: "기타공제", value: d.other_deduction },
    ].filter((i) => i.value !== 0);

    body.push(sectionHeader("지급 · 공제 내역"));
    if (items.length === 0) {
      body.push([
        {
          content: "지급/공제 내역이 없습니다.",
          colSpan: 6,
          styles: {
            halign: "center",
            textColor: [148, 163, 184],
            cellPadding: 12,
          },
        },
      ]);
    } else {
      body.push(...gridRows(items));
    }
    body.push(subtotalRow([{ label: "공제합계", value: d.total_deduction }]));
    body.push(netRow("실수령액", d.net_pay));
  } else {
    // 지급 내역
    const earnItems: Item[] = (
      [
        { label: "기본급", value: d.base_salary },
        { label: "직책수당", value: d.position_allowance },
        { label: "연장근로수당", value: d.overtime_pay },
        { label: "휴일근로수당", value: d.holiday_pay },
        { label: "연차수당", value: d.annual_leave_pay },
        { label: "가족수당", value: d.family_allowance },
        { label: "상여금", value: d.bonus },
        { label: "명절상여", value: d.holiday_bonus },
        { label: "기타과세", value: d.other_taxable },
        { label: "식대", value: d.meal_allowance, nontax: true },
        { label: "차량유지비", value: d.car_allowance, nontax: true },
        { label: "육아수당", value: d.childcare_allowance, nontax: true },
        { label: "연구수당", value: d.research_allowance, nontax: true },
        { label: "경비", value: d.expense_reimbursement, nontax: true },
        { label: "학자금", value: d.tuition, nontax: true },
        { label: "기타 비과세", value: d.other_nontax, nontax: true },
      ] as Item[]
    ).filter((i) => i.value !== 0);

    body.push(sectionHeader("지급 내역"));
    if (earnItems.length === 0) {
      body.push([
        {
          content: "지급 항목이 없습니다.",
          colSpan: 6,
          styles: {
            halign: "center",
            textColor: [148, 163, 184],
            cellPadding: 12,
          },
        },
      ]);
    } else {
      body.push(...gridRows(earnItems));
    }
    body.push(
      subtotalRow([
        { label: "과세합계", value: d.gross_taxable },
        { label: "비과세합계", value: d.gross_nontax, nontax: true },
        { label: "지급합계", value: d.gross_taxable + d.gross_nontax },
      ]),
    );

    // 공제 내역
    const dedItems: Item[] = (
      [
        { label: "국민연금", value: d.pension },
        { label: "건강보험", value: d.health },
        { label: "장기요양", value: d.long_term_care },
        { label: "고용보험", value: d.employment_insurance },
        { label: "근로소득세", value: d.income_tax },
        { label: "지방소득세", value: d.local_tax },
        { label: "연말 소득세", value: d.year_end_income_tax },
        { label: "연말 지방세", value: d.year_end_local_tax },
        { label: "기타공제", value: d.other_deduction },
      ] as Item[]
    ).filter((i) => i.value !== 0);

    body.push(sectionHeader("공제 내역"));
    if (dedItems.length === 0) {
      body.push([
        {
          content: "공제 항목이 없습니다.",
          colSpan: 6,
          styles: {
            halign: "center",
            textColor: [148, 163, 184],
            cellPadding: 12,
          },
        },
      ]);
    } else {
      body.push(...gridRows(dedItems));
    }
    body.push(subtotalRow([{ label: "공제합계", value: d.total_deduction }]));

    body.push(netRow("실수령액", d.net_pay));
  }

  autoTable(pdf, {
    startY: TABLE_TOP,
    margin: {
      top: TABLE_TOP,
      left: MARGIN_X,
      right: MARGIN_X,
      bottom: MARGIN_BOTTOM + FOOTER_RESERVE,
    },
    body,
    theme: "grid",
    styles: {
      font: FONT_FAMILY,
      fontStyle: "normal",
      fontSize: 9.5,
      textColor: C_TEXT,
      lineColor: C_BORDER,
      lineWidth: 0.5,
      cellPadding: { top: 5, right: 8, bottom: 5, left: 8 },
      overflow: "linebreak",
      valign: "middle",
    },
    columnStyles: {
      0: { cellWidth: LABEL_W },
      1: { cellWidth: VALUE_W },
      2: { cellWidth: LABEL_W },
      3: { cellWidth: VALUE_W },
      4: { cellWidth: LABEL_W },
      5: { cellWidth: VALUE_W },
    },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawPageChrome(pdf, d, logoDataUrl);
      }
    },
  });

  // 메모 (있을 때만, 표 종료 직후)
  if (d.memo && d.memo.trim()) {
    const finalY =
      (pdf as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
        ?.finalY ?? TABLE_TOP;
    let y = finalY + 18;
    const lineHeight = 12;

    pdf.setFont(FONT_FAMILY, "normal");
    pdf.setFontSize(9);
    const lines = pdf.splitTextToSize(d.memo.trim(), CONTENT_W);
    const blockHeight = 14 + lines.length * lineHeight;

    if (y + blockHeight > PAGE_H - MARGIN_BOTTOM - FOOTER_RESERVE) {
      pdf.addPage();
      drawPageChrome(pdf, d, logoDataUrl);
      y = TABLE_TOP + 8;
    }
    pdf.setFont(FONT_FAMILY, "bold");
    pdf.setFontSize(9);
    pdf.setTextColor(...C_LABEL_TX);
    pdf.text("메모", MARGIN_X, y);
    pdf.setFont(FONT_FAMILY, "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(51, 65, 85);
    pdf.text(lines, MARGIN_X, y + 14);
  }

  return pdf.output("blob");
}

export async function downloadPayStubPDF(
  d: PayStubData,
  filename?: string,
): Promise<void> {
  const blob = await exportPayStubPDF(d);
  const fn =
    filename ??
    `급여명세서_${d.year}-${String(d.month).padStart(2, "0")}_${d.employee.name}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
