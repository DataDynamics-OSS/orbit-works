"use client";

/**
 * 고객 / 협력사 주소록을 회사별로 그룹핑해 A4 portrait PDF 로 출력.
 * 패턴은 `leave-export.ts` 와 동일 — html2canvas + jsPDF, 로고는
 * Settings 에 업로드된 회사 자산이 있으면 사용, 없으면 기본 SVG.
 */

import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { api } from "./api";

export type ContactsExportRow = {
  id: string;
  name: string;
  company_name?: string | null;
  title?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  memo?: string | null;
};

export type ContactsExportInput = {
  kind: "CUSTOMER" | "PARTNER";
  rows: ContactsExportRow[];
};

const FALLBACK_LOGO_URL = "/logo.svg";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// 회사명 → row 배열로 그룹핑. 회사명이 비어있으면 "(미지정)" 그룹으로 묶는다.
// 그룹은 한국어 로케일로 정렬, 그룹 내 row 는 이름 기준 정렬.
function groupByCompany(rows: ContactsExportRow[]): Array<[string, ContactsExportRow[]]> {
  const map = new Map<string, ContactsExportRow[]>();
  for (const r of rows) {
    const key = r.company_name?.trim() || "(미지정)";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  const groups = Array.from(map.entries());
  groups.sort((a, b) => a[0].localeCompare(b[0], "ko"));
  for (const [, list] of groups) {
    list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }
  return groups;
}

function buildHtml(d: ContactsExportInput, logoDataUrl: string | null): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const kindLabel = d.kind === "PARTNER" ? "협력사" : "고객";

  const logoHeader = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="logo" style="height:36px;width:auto;display:block;" />`
    : "";

  const groups = groupByCompany(d.rows);

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
      <div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;">주소록 · ${kindLabel}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">
          ${groups.length}개 회사 · ${d.rows.length}명 · 출력 ${today}
        </div>
      </div>
      <div>${logoHeader}</div>
    </div>
  `;

  const thStyle =
    "padding:6px 8px;border-bottom:2px solid #0f172a;background:#f1f5f9;color:#0f172a;font-weight:700;font-size:10px;text-align:left;";
  const tdStyle =
    "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;vertical-align:middle;color:#0f172a;";
  const centerStyle = tdStyle + "text-align:center;color:#94a3b8;";

  const groupHtml = groups
    .map(([company, list]) => {
      const rows = list
        .map((c) => {
          return `
            <tr data-block="row">
              <td style="${tdStyle}font-weight:600;width:18%;">${escapeHtml(c.name)}</td>
              <td style="${tdStyle}width:14%;color:#475569;">${escapeHtml(c.title ?? "")}</td>
              <td style="${tdStyle}width:16%;font-variant-numeric:tabular-nums;">${escapeHtml(c.phone ?? "")}</td>
              <td style="${tdStyle}width:16%;font-variant-numeric:tabular-nums;">${escapeHtml(c.mobile ?? "")}</td>
              <td style="${tdStyle}width:22%;">${escapeHtml(c.email ?? "")}</td>
              <td style="${tdStyle}width:14%;color:#64748b;white-space:pre-wrap;">${escapeHtml(c.memo ?? "")}</td>
            </tr>`;
        })
        .join("");
      return `
        <div data-block="group" style="margin-top:14px;page-break-inside:avoid;">
          <div style="font-size:12px;font-weight:700;color:#1d4ed8;border-bottom:1px solid #cbd5e1;padding:4px 0;margin-bottom:4px;">
            ${escapeHtml(company)} <span style="color:#64748b;font-weight:500;">· ${list.length}명</span>
          </div>
          <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
            <thead>
              <tr>
                <th style="${thStyle}">이름</th>
                <th style="${thStyle}">직함</th>
                <th style="${thStyle}">전화</th>
                <th style="${thStyle}">휴대전화</th>
                <th style="${thStyle}">이메일</th>
                <th style="${thStyle}">메모</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    })
    .join("");

  const empty = `
    <div style="margin-top:48px;text-align:center;font-size:11px;color:#94a3b8;">
      등록된 ${kindLabel} 주소가 없습니다.
    </div>
  `;

  const footer = `
    <div style="margin-top:24px;font-size:9px;color:#64748b;display:flex;justify-content:space-between;">
      <span>주소록 · ${kindLabel}</span>
      <span>출력 ${today}</span>
    </div>
  `;

  return `
    <div style="padding:24px 28px;font-family:'Noto Sans KR',sans-serif;color:#0f172a;background:#ffffff;">
      ${header}
      ${groups.length > 0 ? groupHtml : empty}
      ${footer}
    </div>
  `;
}

export async function exportContactsPDF(d: ContactsExportInput): Promise<Blob> {
  const logo = await loadLogoDataUrl(200);
  const html = buildHtml(d, logo);
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:-20000px;left:0;width:740px;background:#ffffff;font-family:'Noto Sans KR',sans-serif;color:#0f172a;";
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    if (document.fonts?.ready) await document.fonts.ready;

    // 페이지 분할이 row / 그룹 경계를 자르지 않도록 각 data-block 의 bottom 좌표를 미리 측정.
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
    const blockBottoms = blockBottomsCss.map((y) => Math.round(y * scale));

    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const bottomMargin = 24;
    const usableH = pageH - bottomMargin;
    const pxToPt = pageW / canvas.width;
    const usableCanvasH = usableH / pxToPt;

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
        const candidates = blockBottoms.filter(
          (b) => b > startY && b <= hardEnd,
        );
        if (candidates.length > 0 && hardEnd < canvas.height) {
          endY = candidates[candidates.length - 1];
        }
        if (endY <= startY) endY = hardEnd;
        addSlice(startY, endY, first);
        first = false;
        startY = endY;
      }
    }

    const total = (pdf as any).internal.pages.length - 1;
    for (let p = 1; p <= total; p++) {
      pdf.setPage(p);
      pdf.setFontSize(9);
      pdf.setTextColor(0, 0, 0);
      pdf.text(`${p} / ${total}`, pageW / 2, pageH - 10, { align: "center" });
    }

    return pdf.output("blob");
  } finally {
    document.body.removeChild(container);
  }
}

export async function downloadContactsPDF(
  d: ContactsExportInput,
  filename?: string,
): Promise<void> {
  const blob = await exportContactsPDF(d);
  const kindLabel = d.kind === "PARTNER" ? "협력사" : "고객";
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const fn = filename ?? `주소록_${kindLabel}_${stamp}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
