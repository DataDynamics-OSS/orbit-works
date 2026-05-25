// 견적서/청구서 공통 타입·계산 헬퍼.

export type ItemKind =
  | "PRODUCT"
  | "CONSULTING"
  | "TECH_SUPPORT"
  | "DEVELOPMENT"
  | "MAINTENANCE"
  | "OTHER";

// 인력이 투입되는(인건비 성격) 종류 — 라인 에디터에서 등급 dropdown을 노출한다.
// 시작일/종료일 입력은 없으며 수량(MM) 으로 분량을 표현.
export const HUMAN_SERVICE_KINDS: ReadonlyArray<ItemKind> = [
  "CONSULTING",
  "TECH_SUPPORT",
  "DEVELOPMENT",
  "MAINTENANCE",
];

export function isHumanService(k: ItemKind): boolean {
  return HUMAN_SERVICE_KINDS.includes(k);
}

// 기술 등급 (컨설팅 > 특급 > 고급 > 중급 > 초급). role 컬럼에 enum 값으로 저장된다.
export type Grade = "CONSULTANT" | "PREMIUM" | "HIGH" | "MID" | "JUNIOR";

export const GRADE_ORDER: ReadonlyArray<Grade> = [
  "CONSULTANT",
  "PREMIUM",
  "HIGH",
  "MID",
  "JUNIOR",
];

export const GRADE_LABEL: Record<Grade, string> = {
  CONSULTANT: "컨설팅",
  PREMIUM: "특급",
  HIGH: "고급",
  MID: "중급",
  JUNIOR: "초급",
};

export const GRADE_LABEL_EN: Record<Grade, string> = {
  CONSULTANT: "Consultant",
  PREMIUM: "Premium",
  HIGH: "Senior",
  MID: "Mid",
  JUNIOR: "Junior",
};

export function gradeLabel(v: string | null | undefined, en = false): string {
  if (!v) return "";
  return (en ? GRADE_LABEL_EN : GRADE_LABEL)[v as Grade] ?? v;
}
export type TaxMode = "EXCLUSIVE" | "INCLUSIVE";
export type Currency = "KRW" | "USD";

export const KIND_LABEL: Record<ItemKind, string> = {
  PRODUCT: "제품",
  CONSULTING: "컨설팅",
  TECH_SUPPORT: "기술지원",
  DEVELOPMENT: "개발",
  MAINTENANCE: "운영/유지보수",
  OTHER: "기타",
};

export const KIND_UNIT_DEFAULT: Record<ItemKind, string> = {
  PRODUCT: "EA",
  CONSULTING: "MM",
  TECH_SUPPORT: "MM",
  DEVELOPMENT: "MM",
  MAINTENANCE: "MM",
  OTHER: "EA",
};

export type LineItem = {
  id?: string;
  position?: number;
  kind: ItemKind;
  name: string;
  description?: string | null;
  unit?: string | null;
  quantity: string;
  unit_price: string;
  discount_rate: string;
  role?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  months?: string | null;
  // 다년 계약 배수. 양수, 최소 1 (검증은 컴포넌트 레벨).
  years?: string | null;
  line_subtotal?: string;
  line_discount?: string;
  line_total?: string;
  // 공급가액 수동 입력. true 면 line_total 을 그대로 사용.
  manual_total?: boolean;
};

export type Document = {
  id: string;
  number: string;
  version: number;
  display_number: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_snapshot: CustomerSnapshot | null;
  issuer_snapshot: IssuerSnapshot | null;
  title: string;
  business_name?: string | null;
  attention?: string | null;
  po_no?: string | null;
  issue_date: string;
  valid_until?: string | null;
  due_date?: string | null;
  currency: Currency;
  locale?: "ko" | "en";   // Quote 만 사용. Invoice 는 항상 EN.
  tax_mode: TaxMode;
  tax_rate: string;
  subtotal: string;
  discount_total: string;
  tax_amount: string;
  total_amount: string;
  memo?: string | null;
  terms?: string | null;
  items: LineItem[];
  paid_amount?: string;
  status?: "DRAFT" | "FINAL";  // 견적서 전용 — 청구서는 사용 안 함
  updated_at?: string;
  created_at?: string;
  // Quote → Invoice 전환 시 링크.
  converted_invoice_id?: string | null;
  source_quote_id?: string | null;
  source_invoice_id?: string | null;
};

export type CustomerSnapshot = {
  id?: string;
  name?: string;
  business_no?: string | null;
  representative?: string | null;
  address?: string | null;
  is_overseas?: boolean;
};

export type IssuerSnapshot = {
  // 한글
  name?: string | null;
  business_no?: string | null;
  representative?: string | null;
  address?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  bank_holder?: string | null;
  // 영문 (Invoice PDF 에서 우선 사용)
  name_en?: string | null;
  representative_en?: string | null;
  address_en?: string | null;
  bank_name_en?: string | null;
  bank_holder_en?: string | null;
};

export function toNum(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
}

export function computeLine(i: LineItem): {
  subtotal: number;
  discount: number;
  total: number;
} {
  if (i.manual_total) {
    // 사용자가 공급가액을 직접 입력한 경우 qty/price/discount 를 무시하고 입력값 그대로.
    const total = toNum(i.line_total);
    return { subtotal: total, discount: 0, total };
  }
  const q = toNum(i.quantity);
  const u = toNum(i.unit_price);
  const d = toNum(i.discount_rate);
  // years 는 최소 1. 빈 값이거나 1 미만이면 1 로 보정.
  const yRaw = toNum(i.years);
  const y = yRaw >= 1 ? yRaw : 1;
  const subtotal = q * u * y;
  const discount = (subtotal * d) / 100;
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

export function computeTotals(
  items: LineItem[],
  tax_mode: TaxMode,
  tax_rate: string | number,
): {
  subtotal: number;
  discount_total: number;
  taxable: number;
  tax_amount: number;
  total_amount: number;
} {
  let subtotal = 0;
  let discount_total = 0;
  for (const it of items) {
    const { subtotal: s, discount: d } = computeLine(it);
    subtotal += s;
    discount_total += d;
  }
  const taxable = subtotal - discount_total;
  const rate = toNum(tax_rate);
  let tax_amount: number;
  let total_amount: number;
  if (tax_mode === "INCLUSIVE") {
    const denom = 100 + rate;
    tax_amount = denom > 0 ? (taxable * rate) / denom : 0;
    total_amount = taxable;
  } else {
    tax_amount = (taxable * rate) / 100;
    total_amount = taxable + tax_amount;
  }
  return { subtotal, discount_total, taxable, tax_amount, total_amount };
}

// 부가세 라벨 — 0% 면 영세율 표기.
export function taxLabel(rate: string | number, mode: TaxMode): string {
  const r = toNum(rate);
  if (r === 0) return "부가세(영세율)";
  return mode === "INCLUSIVE" ? `부가세(포함, ${r}%)` : `부가세(${r}%)`;
}

// 사용자 입력 필드용 — 천 단위 comma 를 달아 표시하고, 스트립해서 원본 숫자로 보존.
export function formatNumberInput(raw: string | number | null | undefined): string {
  if (raw == null) return "";
  const s = String(raw);
  if (s === "") return "";
  // 사용자가 '-' 나 공백 같은 부분 입력 중일 때는 그대로 둔다.
  if (s === "-" || s === ".") return s;
  // 숫자 + '.' 이외는 허용하지 않음.
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return "";
  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  const [intPart, ...decParts] = body.split(".");
  const decPart = decParts.join("");
  const intWithCommas = intPart
    ? Number(intPart).toLocaleString("en-US")
    : "0";
  const prefix = negative ? "-" : "";
  if (s.endsWith(".") && decParts.length === 0) return `${prefix}${intWithCommas}.`;
  return decParts.length > 0
    ? `${prefix}${intWithCommas}.${decPart}`
    : `${prefix}${intWithCommas}`;
}

export function stripCommas(s: string): string {
  return s.replace(/,/g, "");
}

export function formatCurrency(v: number | string, ccy: Currency): string {
  const n = toNum(v);
  if (ccy === "USD") {
    return (
      "$" +
      n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return Math.round(n).toLocaleString("ko-KR") + "원";
}
