"use client";

/**
 * 단일 이벤트 → A4 portrait PDF.
 *
 * 패턴은 contacts-export.ts / leave-export.ts 와 동일 — 화면을 그대로
 * 캡처하지 않고 PDF 전용 HTML 을 임시로 만들어 html2canvas + jsPDF 로 출력.
 *
 * 포함: 기본 정보 / 비용 요약 / 참석자 / 항공권 / 숙박 / 메모(요약) / 상세 계획.
 * **제외: 첨부파일, 지도.** (사용자 명시)
 *
 * 페이지 분할 가이드:
 *   data-block 속성을 가진 요소들의 bottom 좌표를 미리 측정해 페이지가 그
 *   경계 안에서 잘리지 않도록 endY 를 보정. 항공권·숙박·참석자 같이 행이 많을
 *   수 있는 섹션은 row 단위로도 data-block 을 부여.
 */

import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { api } from "./api";

export type EventExportFlight = {
  airline?: string | null;
  booking_ref?: string | null;
  ticket_no?: string | null;
  flight_no?: string | null;
  departure_airport?: string | null;
  departure_terminal?: string | null;
  arrival_airport?: string | null;
  arrival_terminal?: string | null;
  seat_class?: string | null;
  departure_at?: string | null;
  arrival_at?: string | null;
  cost?: string | number | null;
  memo?: string | null;
};

export type EventExportLodging = {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  check_in_date?: string | null;
  check_out_date?: string | null;
  cost?: string | number | null;
  memo?: string | null;
};

export type EventExportParticipant = {
  developer_id?: string | null;
  guest_name?: string | null;
  display_name?: string | null;
  // 사내 직원의 전화번호 (developer.phone). 외부 게스트는 항상 null.
  phone?: string | null;
};

export type EventExportInput = {
  kind: "WORKSHOP" | "CONFERENCE" | "BUSINESS_TRIP";
  title: string;
  address?: string | null;
  start_date: string;
  end_date: string;
  budget?: string | number;
  actual_cost?: string | number;
  entry_fee?: string | number;
  expenses?: string | number;
  flights_total?: string | number;
  lodgings_total?: string | number;
  grand_total?: string | number;
  memo?: string | null;
  plan?: string | null;
  flights: EventExportFlight[];
  lodgings: EventExportLodging[];
  participants: EventExportParticipant[];
};

const KIND_LABEL: Record<EventExportInput["kind"], string> = {
  WORKSHOP: "워크샵",
  CONFERENCE: "컨퍼런스",
  BUSINESS_TRIP: "출장",
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

function fmtKRW(v: string | number | null | undefined): string {
  const n = Number(v ?? 0) || 0;
  return n.toLocaleString("ko-KR");
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  // datetime-local 또는 ISO. 'T' 와 'Z' 제거 후 분 단위까지.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  return iso;
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

function buildHtml(d: EventExportInput, logoDataUrl: string | null): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const kindLabel = KIND_LABEL[d.kind] ?? d.kind;

  const logoHeader = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="logo" style="height:36px;width:auto;display:block;" />`
    : "";

  const thStyle =
    "padding:6px 8px;border-bottom:2px solid #0f172a;background:#f1f5f9;color:#0f172a;font-weight:700;font-size:10px;text-align:left;";
  const tdStyle =
    "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;color:#0f172a;";
  const tdRight = tdStyle + "text-align:right;font-variant-numeric:tabular-nums;";
  // html2canvas 가 td 의 vertical-align: middle 을 무시 (CLAUDE.md gotcha #8).
  // 모든 td/th 안에 flex 컬럼 래퍼를 두어 multi-line cell 도 가운데 정렬.
  const VC = (content: string, align: "left" | "right" = "left") =>
    `<div style="display:flex;flex-direction:column;justify-content:center;min-height:18px;align-items:${align === "right" ? "flex-end" : "flex-start"};">${content}</div>`;
  const HC = (content: string, align: "left" | "right" = "left") =>
    `<div style="display:flex;align-items:center;min-height:18px;justify-content:${align === "right" ? "flex-end" : "flex-start"};">${content}</div>`;
  const sectionH =
    "font-size:12px;font-weight:700;color:#1d4ed8;border-bottom:1px solid #cbd5e1;padding:4px 0;margin:14px 0 6px;";

  // -- 헤더 (출력일 + 회사 로고) ---------------------------------------------
  const header = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
      <div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;">이벤트 상세</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">출력 ${today}</div>
      </div>
      <div>${logoHeader}</div>
    </div>
  `;

  // -- 기본 정보 카드 ----------------------------------------------------------
  const titleBlock = `
    <div data-block="title" style="page-break-inside:avoid;border:1px solid #cbd5e1;border-radius:8px;padding:10px 14px;background:#f8fafc;">
      <div style="display:flex;align-items:baseline;gap:8px;">
        <span style="font-size:11px;color:#64748b;">[${escapeHtml(kindLabel)}]</span>
        <span style="font-size:16px;font-weight:800;">${escapeHtml(d.title)}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:8px;">
        <tbody>
          <tr>
            <td style="${tdStyle}width:14%;color:#64748b;">${HC("기간")}</td>
            <td style="${tdStyle}width:36%;font-weight:600;">${HC(`${escapeHtml(d.start_date)} ~ ${escapeHtml(d.end_date)}`)}</td>
            <td style="${tdStyle}width:14%;color:#64748b;">${HC("장소")}</td>
            <td style="${tdStyle}width:36%;">${HC(escapeHtml(d.address ?? "—"))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  // -- 비용 요약 ---------------------------------------------------------------
  const overBudget =
    Number(d.actual_cost ?? 0) > 0 &&
    Number(d.budget ?? 0) > 0 &&
    Number(d.actual_cost) > Number(d.budget);
  const costBlock = `
    <div data-block="cost" style="page-break-inside:avoid;">
      <div style="${sectionH}">비용 요약 (KRW)</div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
        <thead>
          <tr>
            <th style="${thStyle}text-align:right;">예산</th>
            <th style="${thStyle}text-align:right;">소요금액</th>
            <th style="${thStyle}text-align:right;">참가비</th>
            <th style="${thStyle}text-align:right;">실비</th>
            <th style="${thStyle}text-align:right;">항공권 합계</th>
            <th style="${thStyle}text-align:right;">숙박 합계</th>
            <th style="${thStyle}text-align:right;">총 합계</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="${tdRight}">${HC(fmtKRW(d.budget), "right")}</td>
            <td style="${tdRight}${overBudget ? "color:#b91c1c;font-weight:700;" : ""}">${HC(fmtKRW(d.actual_cost), "right")}</td>
            <td style="${tdRight}">${HC(fmtKRW(d.entry_fee), "right")}</td>
            <td style="${tdRight}">${HC(fmtKRW(d.expenses), "right")}</td>
            <td style="${tdRight}">${HC(fmtKRW(d.flights_total), "right")}</td>
            <td style="${tdRight}">${HC(fmtKRW(d.lodgings_total), "right")}</td>
            <td style="${tdRight}font-weight:700;">${HC(fmtKRW(d.grand_total), "right")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  // -- 참석자 — 테이블 없이 한 줄로 콤마 구분.
  //    이름(전화번호) 형식. 외부 게스트(전화번호 없음)는 이름 (외부) 로 표기.
  const partLine = d.participants
    .map((p) => {
      const name = p.display_name ?? p.guest_name ?? "(이름 없음)";
      if (p.developer_id) {
        return p.phone
          ? `${escapeHtml(name)}(${escapeHtml(p.phone)})`
          : escapeHtml(name);
      }
      return `${escapeHtml(name)} (외부)`;
    })
    .join(", ");
  const partBlock = `
    <div data-block="participants" style="page-break-inside:avoid;">
      <div style="${sectionH}">참석자 (${d.participants.length}명)</div>
      <div style="font-size:10px;color:#0f172a;line-height:1.6;">
        ${d.participants.length === 0 ? `<span style="color:#94a3b8;">참석자 없음</span>` : partLine}
      </div>
    </div>
  `;

  // -- 항공권 ------------------------------------------------------------------
  const flightRows = d.flights
    .map((f, i) => {
      const dep = [f.departure_airport, f.departure_terminal].filter(Boolean).join(" / ");
      const arr = [f.arrival_airport, f.arrival_terminal].filter(Boolean).join(" / ");
      return `
        <tr data-block="row">
          <td style="${tdStyle}width:4%;color:#94a3b8;">${HC(String(i + 1))}</td>
          <td style="${tdStyle}width:14%;font-weight:600;">${HC(escapeHtml(f.airline ?? ""))}</td>
          <td style="${tdStyle}width:10%;">${HC(escapeHtml(f.flight_no ?? ""))}</td>
          <td style="${tdStyle}width:9%;color:#64748b;">${HC(escapeHtml(f.seat_class ?? ""))}</td>
          <td style="${tdStyle}width:18%;">${VC(`${escapeHtml(dep || "—")}<span style="color:#64748b;">${escapeHtml(fmtDateTime(f.departure_at))}</span>`)}</td>
          <td style="${tdStyle}width:18%;">${VC(`${escapeHtml(arr || "—")}<span style="color:#64748b;">${escapeHtml(fmtDateTime(f.arrival_at))}</span>`)}</td>
          <td style="${tdRight}width:11%;">${HC(fmtKRW(f.cost), "right")}</td>
          <td style="${tdStyle}width:16%;color:#64748b;">${HC(escapeHtml(f.memo ?? ""))}</td>
        </tr>`;
    })
    .join("");
  const flightBlock = `
    <div data-block="flights" style="page-break-inside:avoid;">
      <div style="${sectionH}">항공권 (${d.flights.length}건)</div>
      ${
        d.flights.length === 0
          ? `<div style="font-size:10px;color:#94a3b8;padding:6px 0;">항공권 없음</div>`
          : `<table style="width:100%;border-collapse:collapse;table-layout:fixed;">
              <thead>
                <tr>
                  <th style="${thStyle}">#</th>
                  <th style="${thStyle}">항공사</th>
                  <th style="${thStyle}">편명</th>
                  <th style="${thStyle}">좌석</th>
                  <th style="${thStyle}">출발</th>
                  <th style="${thStyle}">도착</th>
                  <th style="${thStyle}text-align:right;">비용</th>
                  <th style="${thStyle}">메모</th>
                </tr>
              </thead>
              <tbody>${flightRows}</tbody>
            </table>`
      }
    </div>
  `;

  // -- 숙박 -------------------------------------------------------------------
  const lodgingRows = d.lodgings
    .map((l, i) => {
      const contact = [l.phone, l.email].filter(Boolean).join(" · ");
      return `
        <tr data-block="row">
          <td style="${tdStyle}width:4%;color:#94a3b8;">${HC(String(i + 1))}</td>
          <td style="${tdStyle}width:22%;font-weight:600;">${HC(escapeHtml(l.name ?? ""))}</td>
          <td style="${tdStyle}width:24%;color:#475569;">${HC(escapeHtml(l.address ?? ""))}</td>
          <td style="${tdStyle}width:18%;">${HC(`${escapeHtml(l.check_in_date ?? "")} ~ ${escapeHtml(l.check_out_date ?? "")}`)}</td>
          <td style="${tdRight}width:12%;">${HC(fmtKRW(l.cost), "right")}</td>
          <td style="${tdStyle}width:20%;color:#64748b;">${VC(`${escapeHtml(contact)}${l.memo ? `<span>${escapeHtml(l.memo)}</span>` : ""}`)}</td>
        </tr>`;
    })
    .join("");
  const lodgingBlock = `
    <div data-block="lodgings" style="page-break-inside:avoid;">
      <div style="${sectionH}">숙박 (${d.lodgings.length}건)</div>
      ${
        d.lodgings.length === 0
          ? `<div style="font-size:10px;color:#94a3b8;padding:6px 0;">숙박 없음</div>`
          : `<table style="width:100%;border-collapse:collapse;table-layout:fixed;">
              <thead>
                <tr>
                  <th style="${thStyle}">#</th>
                  <th style="${thStyle}">호텔명</th>
                  <th style="${thStyle}">주소</th>
                  <th style="${thStyle}">체크인 ~ 체크아웃</th>
                  <th style="${thStyle}text-align:right;">비용</th>
                  <th style="${thStyle}">연락처 / 메모</th>
                </tr>
              </thead>
              <tbody>${lodgingRows}</tbody>
            </table>`
      }
    </div>
  `;

  // -- 메모 (요약) -------------------------------------------------------------
  const memoBlock = (d.memo ?? "").trim()
    ? `
      <div data-block="memo" style="page-break-inside:avoid;">
        <div style="${sectionH}">메모 (요약)</div>
        <div style="font-size:10px;color:#0f172a;white-space:pre-wrap;border:1px solid #e2e8f0;padding:8px 10px;border-radius:6px;background:#fafafa;">${escapeHtml(d.memo!.trim())}</div>
      </div>`
    : "";

  // -- 상세 계획 (마지막) ------------------------------------------------------
  const planBlock = (d.plan ?? "").trim()
    ? `
      <div data-block="plan">
        <div style="${sectionH}">상세 계획</div>
        <div style="font-size:10px;color:#0f172a;white-space:pre-wrap;line-height:1.5;border:1px solid #e2e8f0;padding:10px 12px;border-radius:6px;background:#fcfcfd;">${escapeHtml(d.plan!.trim())}</div>
      </div>`
    : "";

  const footer = `
    <div style="margin-top:20px;font-size:9px;color:#64748b;display:flex;justify-content:space-between;">
      <span>${escapeHtml(kindLabel)} · ${escapeHtml(d.title)}</span>
      <span>출력 ${today}</span>
    </div>
  `;

  return `
    <div style="padding:24px 28px;font-family:'Noto Sans KR',sans-serif;color:#0f172a;background:#ffffff;">
      ${header}
      ${titleBlock}
      ${costBlock}
      ${partBlock}
      ${flightBlock}
      ${lodgingBlock}
      ${memoBlock}
      ${planBlock}
      ${footer}
    </div>
  `;
}

export async function exportEventPDF(d: EventExportInput): Promise<Blob> {
  const logo = await loadLogoDataUrl(200);
  const html = buildHtml(d, logo);
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:-20000px;left:0;width:740px;background:#ffffff;font-family:'Noto Sans KR',sans-serif;color:#0f172a;";
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    if (document.fonts?.ready) await document.fonts.ready;

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
      ctx.drawImage(canvas, 0, startY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
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
        const candidates = blockBottoms.filter((b) => b > startY && b <= hardEnd);
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

export async function downloadEventPDF(
  d: EventExportInput,
  filename?: string,
): Promise<void> {
  const blob = await exportEventPDF(d);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const safe = (d.title || "이벤트").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  const fn = filename ?? `이벤트_${safe}_${stamp}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
