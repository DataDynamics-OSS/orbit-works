"use client";

import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";

export type ResumeProfile = {
  birth_date?: string | null;
  school?: string | null;
  major?: string | null;
  graduation_year?: number | null;
};

export type ResumeCertification = {
  id: string;
  name: string;
  issuer?: string | null;
  acquired_on?: string | null;
};

export type ResumeExperience = {
  id: string;
  start_date: string;
  end_date?: string | null;
  company: string;
  role: string;
  description?: string | null;
};

export type ResumeBundle = {
  developer_id: string;
  name: string;
  profile: ResumeProfile | null;
  certifications: ResumeCertification[];
  experiences: ResumeExperience[];
};

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export function downloadResumeXlsx(bundle: ResumeBundle): void {
  const wb = XLSX.utils.book_new();

  const profileRows: (string | number)[][] = [
    ["이름", bundle.name],
    ["생년월일", bundle.profile?.birth_date ?? ""],
    ["학교", bundle.profile?.school ?? ""],
    ["학과", bundle.profile?.major ?? ""],
    ["졸업년도", bundle.profile?.graduation_year ?? ""],
  ];
  const certHeader = ["자격증명", "발급기관", "취득일"];
  const certRows = bundle.certifications.map((c) => [
    c.name,
    c.issuer ?? "",
    c.acquired_on ?? "",
  ]);
  const expHeader = ["시작일", "종료일", "기업/프로젝트", "역할", "설명"];
  const expRows = bundle.experiences.map((e) => [
    e.start_date,
    e.end_date ?? "재직중",
    e.company,
    e.role,
    e.description ?? "",
  ]);

  const aoa: (string | number)[][] = [
    ["[기본정보]"],
    ...profileRows,
    [""],
    ["[자격증]"],
    certHeader,
    ...(certRows.length ? certRows : [["(없음)", "", ""]]),
    [""],
    ["[이력]"],
    expHeader,
    ...(expRows.length ? expRows : [["(없음)", "", "", "", ""]]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 14 },
    { wch: 14 },
    { wch: 22 },
    { wch: 18 },
    { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "이력서");
  XLSX.writeFile(
    wb,
    `${sanitize(bundle.name)}_이력서_${todayStamp()}.xlsx`,
  );
}

// ---------------------------------------------------------------------------
// PDF (client-side, via html2canvas + jsPDF)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildResumeHtml(bundle: ResumeBundle): string {
  const p = bundle.profile;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const th =
    "padding:6px 8px;border-bottom:2px solid #0f172a;background:#f1f5f9;color:#0f172a;font-weight:700;font-size:10px;text-align:left;";
  const td =
    "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:10px;vertical-align:middle;";

  const profileRows = [
    ["이름", bundle.name],
    ["생년월일", p?.birth_date ?? "-"],
    ["학교", p?.school ?? "-"],
    ["학과", p?.major ?? "-"],
    ["졸업년도", p?.graduation_year != null ? String(p.graduation_year) : "-"],
  ]
    .map(
      ([k, v]) => `
      <tr>
        <td style="${td}width:120px;color:#475569;">${escapeHtml(k)}</td>
        <td style="${td}font-weight:600;">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join("");

  const certRows = bundle.certifications.length
    ? bundle.certifications
        .map(
          (c) => `
        <tr>
          <td style="${td}"><div style="display:flex;align-items:center;">${escapeHtml(c.name)}</div></td>
          <td style="${td}color:#475569;">${escapeHtml(c.issuer ?? "-")}</td>
          <td style="${td}color:#475569;">${escapeHtml(c.acquired_on ?? "-")}</td>
        </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" style="${td}color:#94a3b8;text-align:center;padding:16px;">자격증이 없습니다.</td></tr>`;

  const expRows = bundle.experiences.length
    ? bundle.experiences
        .map(
          (e) => `
        <tr>
          <td style="${td}color:#475569;white-space:nowrap;">
            <div style="display:flex;align-items:center;">
              ${escapeHtml(e.start_date)} ~ ${escapeHtml(e.end_date ?? "현재")}
            </div>
          </td>
          <td style="${td}">
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-weight:700;">${escapeHtml(e.company)}</span>
              <span style="color:#475569;">${escapeHtml(e.role)}</span>
              ${e.description ? `<span style="color:#64748b;font-size:9px;">${escapeHtml(e.description)}</span>` : ""}
            </div>
          </td>
        </tr>`,
        )
        .join("")
    : `<tr><td colspan="2" style="${td}color:#94a3b8;text-align:center;padding:16px;">이력이 없습니다.</td></tr>`;

  return `
    <div style="padding:24px 28px;font-family:'Noto Sans KR',sans-serif;color:#0f172a;background:#ffffff;">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px;border-bottom:2px solid #0f172a;padding-bottom:8px;">
        <div style="font-size:22px;font-weight:800;letter-spacing:-0.01em;">이력서</div>
        <div style="font-size:10px;color:#64748b;">출력 ${today}</div>
      </div>

      <div style="font-size:11px;font-weight:700;margin:8px 0 4px;">기본정보</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
        <tbody>${profileRows}</tbody>
      </table>

      <div style="font-size:11px;font-weight:700;margin:8px 0 4px;">자격증</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
        <thead>
          <tr>
            <th style="${th}">자격증명</th>
            <th style="${th}">발급기관</th>
            <th style="${th}">취득일</th>
          </tr>
        </thead>
        <tbody>${certRows}</tbody>
      </table>

      <div style="font-size:11px;font-weight:700;margin:8px 0 4px;">이력</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="${th}width:180px;">기간</th>
            <th style="${th}">기업/프로젝트 · 역할</th>
          </tr>
        </thead>
        <tbody>${expRows}</tbody>
      </table>
    </div>
  `;
}

export async function downloadResumePdf(bundle: ResumeBundle): Promise<void> {
  const html = buildResumeHtml(bundle);
  const container = document.createElement("div");
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
    const blob = pdf.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitize(bundle.name)}_이력서_${todayStamp()}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    document.body.removeChild(container);
  }
}
