"use client";

import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { api } from "./api";

export type LeaveBalanceRow = {
  developer_id: string;
  name: string;
  tag?: string | null;
  employment_type: string;
  hire_date: string | null;
  initialized: boolean;
  accrual_strategy: "ANNUAL_15" | "MONTHLY_ACCRUAL" | null;
  statutory_granted: number;
  statutory_used: number;
  statutory_pending: number;
  statutory_remaining: number;
  reward_remaining: number;
  total_remaining: number;
  pending_request_count: number;
};

export type LeaveBalanceExport = {
  year: number;
  rows: LeaveBalanceRow[];
  company: {
    name?: string | null;
    logo_name?: string | null;
  };
};

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

const FALLBACK_LOGO_URL = "/logo.svg";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(1);
}

async function fetchUploadedLogoObjectUrl(): Promise<string | null> {
  try {
    const profile = (await api.get("/company-profile")).data as {
      logo_name?: string | null;
    };
    if (!profile.logo_name) return null;
    const res = await api.get(`/company-profile/logo/${profile.logo_name}`, {
      responseType: "blob",
    });
    return URL.createObjectURL(res.data);
  } catch {
    return null;
  }
}

function preloadImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

function rasterizeImage(src: string, targetWidth: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const ratio = img.naturalHeight / img.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = Math.round(targetWidth * ratio);
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
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

async function loadLogoDataUrl(targetWidth: number): Promise<string | null> {
  let sourceUrl: string | null = await fetchUploadedLogoObjectUrl();
  const isObjectUrl = sourceUrl !== null;
  if (!sourceUrl) {
    const ok = await preloadImage(FALLBACK_LOGO_URL);
    if (ok) sourceUrl = FALLBACK_LOGO_URL;
  }
  const dataUrl = sourceUrl ? await rasterizeImage(sourceUrl, targetWidth) : null;
  if (isObjectUrl && sourceUrl) URL.revokeObjectURL(sourceUrl);
  return dataUrl;
}

// ---------------------------------------------------------------------------
// HTML 빌드 (A4 portrait)
// ---------------------------------------------------------------------------

// 입사일 → "Y년 M개월" / "M개월" / "-".
function tenureLabel(hireDate: string | null | undefined): string {
  if (!hireDate) return "-";
  const m = hireDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "-";
  const hire = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(hire.getTime())) return "-";
  const now = new Date();
  let months =
    (now.getFullYear() - hire.getFullYear()) * 12 +
    (now.getMonth() - hire.getMonth());
  if (now.getDate() < hire.getDate()) months -= 1;
  if (months < 0) return "-";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${rem}개월`;
  if (rem === 0) return `${years}년`;
  return `${years}년 ${rem}개월`;
}

function strategyLabel(b: LeaveBalanceRow): string {
  if (!b.initialized) return "미초기화";
  return b.accrual_strategy === "ANNUAL_15" ? "15일 일괄" : "월 적립";
}

function buildHtml(d: LeaveBalanceExport, logoDataUrl: string | null): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const logoHeader = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="logo" style="height:36px;width:auto;display:block;" />`
    : "";

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
      <div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;">연차 현황</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">
          ${d.year}년 · ${d.rows.length}명 · 출력 ${today}
        </div>
      </div>
      <div>${logoHeader}</div>
    </div>
  `;

  const thStyle =
    "padding:6px 6px;border-bottom:2px solid #0f172a;background:#f1f5f9;color:#0f172a;font-weight:700;font-size:10px;text-align:center;";
  const tdStyle =
    "padding:6px 6px;border-bottom:1px solid #e2e8f0;font-size:10px;vertical-align:middle;";
  const numStyle = tdStyle + "text-align:right;font-variant-numeric:tabular-nums;";
  const centerStyle = tdStyle + "text-align:center;";

  const rows = d.rows
    .map((b) => {
      const tag = b.tag ? ` [${escapeHtml(b.tag)}]` : "";
      const strat = strategyLabel(b);
      const stratColor = !b.initialized ? "#b45309" : "#1f2937";
      return `
      <tr>
        <td style="${tdStyle}">
          <span style="font-weight:600;">${escapeHtml(b.name)}${tag}</span>
        </td>
        <td style="${centerStyle}color:#475569;">${escapeHtml(b.hire_date ?? "-")}</td>
        <td style="${centerStyle}color:#475569;">${escapeHtml(tenureLabel(b.hire_date))}</td>
        <td style="${centerStyle}color:${stratColor};">${strat}</td>
        <td style="${numStyle}">${fmt(b.statutory_granted)}</td>
        <td style="${numStyle}color:#64748b;">${fmt(b.statutory_used)}</td>
        <td style="${numStyle}color:#b45309;">${fmt(b.statutory_pending)}</td>
        <td style="${numStyle}">${fmt(b.statutory_remaining)}</td>
        <td style="${numStyle}color:#0369a1;">${fmt(b.reward_remaining)}</td>
        <td style="${numStyle}font-weight:700;color:#1d4ed8;">${fmt(b.total_remaining)}</td>
        <td style="${centerStyle}">${
          b.pending_request_count > 0 ? `${b.pending_request_count}건` : "-"
        }</td>
      </tr>
    `;
    })
    .join("");

  const footer = `
    <div style="margin-top:16px;font-size:9px;color:#64748b;display:flex;justify-content:space-between;">
      <span>${escapeHtml(d.company.name ?? "")}</span>
      <span>연차 현황 리포트 · ${d.year}</span>
    </div>
  `;

  return `
    <div style="padding:24px 28px;font-family:'Noto Sans KR',sans-serif;color:#0f172a;background:#ffffff;">
      ${header}
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="${thStyle}text-align:left;">직원</th>
            <th style="${thStyle}">입사일</th>
            <th style="${thStyle}">입사후 연차</th>
            <th style="${thStyle}">초기화</th>
            <th style="${thStyle}">법정 부여</th>
            <th style="${thStyle}">사용</th>
            <th style="${thStyle}">대기</th>
            <th style="${thStyle}">법정 잔여</th>
            <th style="${thStyle}">포상 잔여</th>
            <th style="${thStyle}">총 잔여</th>
            <th style="${thStyle}">대기 건수</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="10" style="${centerStyle}color:#94a3b8;padding:24px;">표시할 직원이 없습니다.</td></tr>`}
        </tbody>
      </table>
      ${footer}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// PDF 생성
// ---------------------------------------------------------------------------

export async function exportLeaveBalancePDF(d: LeaveBalanceExport): Promise<Blob> {
  const logo = await loadLogoDataUrl(200);
  const html = buildHtml(d, logo);
  const container = document.createElement("div");
  // A4 portrait 내부 폭 ~ 560pt → 740px 정도에서 라스터 후 축소.
  container.style.cssText =
    "position:fixed;top:-20000px;left:0;width:740px;background:#ffffff;font-family:'Noto Sans KR',sans-serif;color:#0f172a;";
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = await html2canvas(container, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
    });
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgH = (canvas.height * pageW) / canvas.width;
    const imgData = canvas.toDataURL("image/png");
    if (imgH <= pageH) {
      pdf.addImage(imgData, "PNG", 0, 0, pageW, imgH);
    } else {
      let y = 0;
      while (y < imgH) {
        pdf.addImage(imgData, "PNG", 0, -y, pageW, imgH);
        y += pageH;
        if (y < imgH) pdf.addPage();
      }
    }
    return pdf.output("blob");
  } finally {
    document.body.removeChild(container);
  }
}

export async function downloadLeaveBalancePDF(
  d: LeaveBalanceExport,
  filename?: string,
): Promise<void> {
  const blob = await exportLeaveBalancePDF(d);
  const fn = filename ?? `연차현황_${d.year}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
