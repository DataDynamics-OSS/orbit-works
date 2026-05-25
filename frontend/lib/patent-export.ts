"use client";

import html2canvas from "html2canvas";
import jsPDF from "jspdf";

type PatentStatus = "FILED" | "REGISTERED";

export type PatentExportRow = {
  status: PatentStatus;
  title: string;
  application_no: string | null;
  patent_no: string | null;
  filed_date: string | null;
  registered_date: string | null;
  patent_holder: string | null;
  inventors: string | null;
  country: string | null;
};

const STATUS_LABEL: Record<PatentStatus, string> = {
  FILED: "출원",
  REGISTERED: "등록",
};

const STATUS_COLOR: Record<PatentStatus, string> = {
  FILED: "#a16207",
  REGISTERED: "#047857",
};

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml(rows: PatentExportRow[], filterLabel: string): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const th =
    "padding:6px 8px;border-bottom:2px solid #0f172a;background:#f1f5f9;color:#0f172a;font-weight:700;font-size:10px;text-align:left;white-space:nowrap;";
  const td =
    "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;vertical-align:middle;";

  const body = rows.length
    ? rows
        .map((r) => {
          const numberCell =
            (r.patent_no
              ? `<div>등 ${escapeHtml(r.patent_no)}</div>`
              : "") +
            (r.application_no
              ? `<div style="color:#64748b;">출 ${escapeHtml(r.application_no)}</div>`
              : "") || "—";
          return `
        <tr data-block>
          <td style="${td}white-space:nowrap;font-weight:700;color:${STATUS_COLOR[r.status]};">${STATUS_LABEL[r.status]}</td>
          <td style="${td}font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;line-height:1.3;">${numberCell}</td>
          <td style="${td}font-weight:600;">${escapeHtml(r.title)}</td>
          <td style="${td}color:#475569;">${escapeHtml(r.inventors ?? "—")}</td>
          <td style="${td}color:#475569;">${escapeHtml(r.patent_holder ?? "—")}</td>
          <td style="${td}color:#475569;white-space:nowrap;">${escapeHtml(r.country ?? "—")}</td>
          <td style="${td}color:#475569;white-space:nowrap;">${escapeHtml(r.filed_date ?? "—")}</td>
          <td style="${td}color:#475569;white-space:nowrap;">${escapeHtml(r.registered_date ?? "—")}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="8" style="${td}color:#94a3b8;text-align:center;padding:24px;">데이터가 없습니다.</td></tr>`;

  const registered = rows.filter((r) => r.status === "REGISTERED").length;
  const filed = rows.filter((r) => r.status === "FILED").length;

  return `
    <div style="padding:18px 22px;font-family:'Noto Sans KR',sans-serif;color:#0f172a;background:#ffffff;">
      <div data-block style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:12px;border-bottom:2px solid #0f172a;padding-bottom:8px;">
        <div>
          <div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;">특허 목록</div>
          <div style="font-size:10px;color:#64748b;margin-top:3px;">필터: ${escapeHtml(filterLabel)} · 총 ${rows.length}건 (등록 ${registered} / 출원 ${filed})</div>
        </div>
        <div style="font-size:10px;color:#64748b;">출력 ${today}</div>
      </div>

      <table style="width:100%;border-collapse:collapse;table-layout:auto;">
        <thead>
          <tr data-block>
            <th style="${th}width:48px;">상태</th>
            <th style="${th}width:160px;">번호</th>
            <th style="${th}">발명의 명칭</th>
            <th style="${th}width:120px;">발명자</th>
            <th style="${th}width:120px;">특허권자</th>
            <th style="${th}width:40px;">국가</th>
            <th style="${th}width:80px;">출원일</th>
            <th style="${th}width:80px;">등록일</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

export async function downloadPatentsPdf(
  rows: PatentExportRow[],
  filterLabel: string,
): Promise<void> {
  const html = buildHtml(rows, filterLabel);
  const container = document.createElement("div");
  // A4 landscape (842×595 pt ≈ 1123×794 px @96dpi) 에 맞춰 1100px.
  container.style.cssText =
    "position:fixed;top:-20000px;left:0;width:1100px;background:#ffffff;font-family:'Noto Sans KR',sans-serif;color:#0f172a;";
  container.innerHTML = html;
  document.body.appendChild(container);

  try {
    if (document.fonts?.ready) {
      await document.fonts.ready;
      try {
        await (document as any).fonts.load?.("400 10px 'Noto Sans KR'");
        await (document as any).fonts.load?.("700 10px 'Noto Sans KR'");
      } catch {
        // ignore
      }
    }

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

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
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
        const limit = startY + usableCanvasH;
        // 이 페이지에 들어갈 수 있는 마지막 블록 경계를 찾는다.
        let cut = canvas.height;
        if (limit < canvas.height) {
          const candidates = blockBottoms.filter(
            (b) => b > startY && b <= limit,
          );
          if (candidates.length > 0) {
            cut = candidates[candidates.length - 1];
          } else {
            // 한 블록이 페이지보다 큰 비정상 케이스 — 그냥 잘라낸다.
            cut = limit;
          }
        }
        addSlice(startY, cut, first);
        first = false;
        startY = cut;
      }
    }

    // 페이지 번호.
    const total = pdf.getNumberOfPages();
    pdf.setFontSize(8);
    pdf.setTextColor(100);
    for (let i = 1; i <= total; i += 1) {
      pdf.setPage(i);
      pdf.text(`${i} / ${total}`, pageW - 32, pageH - 10);
    }

    const blob = pdf.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `특허목록_${todayStamp()}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    document.body.removeChild(container);
  }
}
