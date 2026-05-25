"use client";

/**
 * 회의록 PDF 내보내기 — html2canvas + jsPDF (다른 *-export.ts 와 동일 패턴).
 *
 * BlockNote 의 blocksToHTMLLossy 가 만들어준 본문 HTML 을 헤더(제목·고객사·
 * 프로젝트·작성자·작성일) 와 함께 off-screen 컨테이너에 렌더한 뒤 html2canvas
 * 로 캡처, jsPDF 의 A4 portrait 페이지로 분할 저장한다.
 *
 * PDF 의 한글 폰트는 시스템에 설치된 Noto Sans KR 가 있으면 그게 우선, 없으면
 * 페이지 stack (Pretendard / system-ui) 로 fallback. PDF.js 가 렌더할 시점에
 * 캡처가 이미 끝난 PNG 이미지라 폰트 임베드 이슈는 없다.
 */

import html2canvas from "html2canvas";
import jsPDF from "jspdf";

export type MeetingNoteForExport = {
  id: string;
  title: string;
  customer_name: string | null;
  project_name: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
};

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "회의록";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function buildHtml(note: MeetingNoteForExport, bodyHtml: string): string {
  const meta = [
    note.customer_name ? `<span><b>고객사</b> ${escapeHtml(note.customer_name)}</span>` : null,
    note.project_name ? `<span><b>프로젝트</b> ${escapeHtml(note.project_name)}</span>` : null,
    note.author_name ? `<span><b>작성자</b> ${escapeHtml(note.author_name)}</span>` : null,
    `<span><b>작성일</b> ${escapeHtml(fmtDate(note.created_at))}</span>`,
    note.updated_at && note.updated_at !== note.created_at
      ? `<span><b>수정일</b> ${escapeHtml(fmtDate(note.updated_at))}</span>`
      : null,
  ]
    .filter(Boolean)
    .join("<span style='color:#cbd5e1;'>·</span>");

  // BlockNote HTML 은 자체 class 만 있고 inline 스타일이 거의 없어서, PDF 캡처
  // 영역에 적용할 reset/타이포 규칙을 wrapper 안에 넣는다. (style 태그가 직접
  // 들어가도 html2canvas 가 잘 처리.)
  return `
    <style>
      .mn-pdf { padding:24px 28px; font-family:'Pretendard','Noto Sans KR',system-ui,sans-serif; color:#0f172a; background:#ffffff; }
      .mn-pdf .mn-head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid #0f172a; padding-bottom:8px; margin-bottom:12px; }
      .mn-pdf .mn-title { font-size:18px; font-weight:800; letter-spacing:-0.01em; line-height:1.3; }
      .mn-pdf .mn-stamp { font-size:10px; color:#64748b; white-space:nowrap; }
      .mn-pdf .mn-meta { font-size:10px; color:#475569; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px; }
      .mn-pdf .mn-meta b { color:#0f172a; margin-right:2px; }
      .mn-pdf .mn-body { font-size:11px; line-height:1.6; }
      /* 한글 + 영문 혼용 wrap — keep-all 로 어절 보존, anywhere 로 너무 긴
         단어/괄호도 강제 break. pre-wrap 으로 공백·줄바꿈 보존 + html2canvas
         의 text-shaping race 회피. <p> 등 block 요소엔 명시적 max-width/min-
         width 로 부모 폭을 강제. */
      .mn-pdf .mn-body, .mn-pdf .mn-body * {
        word-break: keep-all;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        max-width: 100%;
        box-sizing: border-box;
      }
      .mn-pdf .mn-body p { display:block; width:100%; }
      .mn-pdf .mn-body h1, .mn-pdf .mn-body h2, .mn-pdf .mn-body h3 { font-weight:700; line-height:1.3; margin:12px 0 6px; }
      .mn-pdf .mn-body h1 { font-size:16px; }
      .mn-pdf .mn-body h2 { font-size:14px; }
      .mn-pdf .mn-body h3 { font-size:12px; }
      .mn-pdf .mn-body p { margin:4px 0; }
      /* html2canvas 1.x 는 native list-style 의 ::marker 를 잘 못 그려 bullet
         이 사라진다. ::before 로 명시 표기. ol 은 list-style-position: inside
         로 숫자 카운터를 li 안쪽에 두면 정상 렌더. */
      .mn-pdf .mn-body ul { list-style: none; padding-left:24px; margin:4px 0; }
      .mn-pdf .mn-body ol { list-style: decimal inside; padding-left:24px; margin:4px 0; }
      .mn-pdf .mn-body ul > li { position:relative; padding-left:14px; margin:2px 0; }
      .mn-pdf .mn-body ul > li::before {
        content:"•";
        position:absolute;
        left:0;
        top:0;
        color:#0f172a;
      }
      .mn-pdf .mn-body ol > li { margin:2px 0; }
      /* 안전망 — BlockNote 의 textColor/backgroundColor 마크가 "흰색 계열" 일 때
         PDF 의 흰 배경 위에서 글자가 사라진다 (에디터는 inline color 를 미적용해
         사용자가 알아채지 못함). 흰색·near-white 만 본문 기본색으로 override
         하고, 다른 의도된 색·배경은 그대로 보존. */
      .mn-pdf .mn-body span[style*="rgb(255, 255, 255)"],
      .mn-pdf .mn-body span[style*="rgb(255,255,255)"],
      .mn-pdf .mn-body span[style*="#fff"],
      .mn-pdf .mn-body span[style*="#FFFFFF"],
      .mn-pdf .mn-body span[style*="#ffffff"],
      .mn-pdf .mn-body span[style*=":white"],
      .mn-pdf .mn-body span[style*=": white"] {
        color: #0f172a !important;
        background-color: transparent !important;
      }
      .mn-pdf .mn-body blockquote { border-left:3px solid #cbd5e1; padding-left:10px; margin:6px 0; color:#475569; }
      .mn-pdf .mn-body pre { background:#0f172a; color:#f8fafc; padding:10px 12px; border-radius:6px; font-size:10px; line-height:1.5; overflow:hidden; white-space:pre-wrap; word-break:break-all; font-family:'D2Coding',ui-monospace,Menlo,Consolas,monospace; }
      .mn-pdf .mn-body code { background:#f1f5f9; padding:0.1em 0.35em; border-radius:0.25em; font-size:10px; font-family:'D2Coding',ui-monospace,Menlo,Consolas,monospace; }
      .mn-pdf .mn-body table { border-collapse:collapse; width:100%; margin:6px 0; }
      .mn-pdf .mn-body th, .mn-pdf .mn-body td { border:1px solid #cbd5e1; padding:4px 6px; font-size:10px; vertical-align:top; }
      .mn-pdf .mn-body th { background:#f1f5f9; font-weight:700; }
      .mn-pdf .mn-body img { max-width:100%; height:auto; display:block; margin:6px 0; }
      .mn-pdf .mn-body a { color:#2563eb; text-decoration:underline; }
      .mn-pdf .mn-body hr { border:none; border-top:1px solid #cbd5e1; margin:10px 0; }
    </style>
    <div class="mn-pdf">
      <div class="mn-head">
        <div class="mn-title">${escapeHtml(note.title)}</div>
        <div class="mn-stamp">출력 ${escapeHtml(fmtDate(new Date().toISOString()))}</div>
      </div>
      <div class="mn-meta">${meta}</div>
      <div class="mn-body">${bodyHtml || "<p style='color:#94a3b8;'>본문이 비어 있습니다.</p>"}</div>
    </div>
  `;
}

/**
 * 회의록 PDF 다운로드. caller 가 본문 HTML(`bodyHtml`) 을 직접 넘긴다 (보통
 * MeetingNoteEditor 의 htmlRef.current() 결과). 호출 전 본문 즉시 저장 권장.
 */
export async function downloadMeetingNotePdf(
  note: MeetingNoteForExport,
  bodyHtml: string,
): Promise<void> {
  const html = buildHtml(note, bodyHtml);
  const container = document.createElement("div");
  // 너비 880px — 한글+괄호 같은 wrap-까다로운 라인이 한 줄에 충분히 들어가도록
  // 넉넉히. PDF 변환 시 A4 폭으로 다시 비율 맞춰지므로 가독성 손해 없음.
  container.style.cssText =
    "position:fixed;top:-20000px;left:0;width:880px;background:#ffffff;";
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = await html2canvas(container, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      // 글자 단위 렌더링 — Korean+latin 혼용 텍스트에서 일부 글자만 잘리는
      // html2canvas 회귀 (mixed-script shaping 실패) 회피. 약간 느리지만
      // 회의록 본문 분량 정도는 무시 가능.
      letterRendering: true,
    } as any);
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
    a.download = `${sanitize(note.title)}_${todayStamp()}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    document.body.removeChild(container);
  }
}
