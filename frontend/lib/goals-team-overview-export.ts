"use client";

/**
 * 직원 현황 → 새 창 HTML 미리보기 + "PDF 인쇄" 버튼.
 *
 * 임직원 명부(developers-roster-export) 와 동일한 브라우저 print 기반.
 * 다만 자동 print() 트리거 X — 사용자가 미리보기 후 상단 "PDF 인쇄" 버튼
 * 클릭 시 window.print() 호출. 페이지 하단의 "닫기" 버튼은 창 종료.
 *
 * 인쇄 시 상단 컨트롤 bar 는 @media print 에서 hidden 처리 → 깨끗한 PDF.
 */

import { api } from "./api";

type SummaryOut = {
  total_developers: number;
  with_active_goals: number;
  avg_score: number;
  at_risk_developers: number;
  overdue_developers: number;
};

type GoalMini = {
  id: string;
  title: string;
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  difficulty: "ROUTINE" | "NORMAL" | "CHALLENGING" | "STRETCH";
  status: "DRAFT" | "IN_PROGRESS" | "AT_RISK" | "DONE" | "DROPPED";
  progress_pct: string | number;
  due_date: string | null;
};

type Dev = {
  id: string;
  name: string;
  tag: string | null;
  title: string | null;
  employment_type: string;
  goal_count: number;
  active_goal_count: number;
  score: number;
  grade: "S" | "A" | "B" | "C" | "D";
  at_risk_count: number;
  overdue_count: number;
  done_count: number;
  goals: GoalMini[];
};

const PRIORITY_LABEL: Record<GoalMini["priority"], string> = {
  HIGH: "상", MEDIUM: "중", LOW: "하",
};
const DIFFICULTY_LABEL: Record<GoalMini["difficulty"], string> = {
  ROUTINE: "일상", NORMAL: "표준", CHALLENGING: "도전", STRETCH: "도약",
};
const STATUS_LABEL: Record<GoalMini["status"], string> = {
  DRAFT: "초안", IN_PROGRESS: "진행중", AT_RISK: "위기", DONE: "완료", DROPPED: "중단",
};
const CATEGORY_LABEL: Record<string, string> = {
  BUSINESS: "사업", TECH: "기술", OPERATIONS: "운영",
  CAREER: "커리어", PERSONAL_GROWTH: "성장", OTHER: "기타",
};

type OverviewOut = {
  year: number;
  summary: SummaryOut;
  developers: Dev[];
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

function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return escapeHtml(String(v));
}

const EMP_LABEL: Record<string, string> = {
  FULL_TIME: "정규직",
  FREELANCER: "프리랜서",
  INSOURCED: "자사화",
};

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

function progressBar(pct: number, status: GoalMini["status"]): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const isOver = pct > 100;
  const color =
    isOver ? "#9333ea"            // 초과 달성 — 보라
    : status === "AT_RISK" ? "#dc2626"
    : status === "DONE" ? "#059669"
    : status === "DROPPED" ? "#94a3b8"
    : clamped >= 80 ? "#059669"
    : clamped >= 50 ? "#2563eb"
    : "#d97706";
  return `
    <div class="bar">
      <div class="bar-fill" style="width:${clamped}%;background:${color};"></div>
    </div>
  `;
}

function statusTone(status: GoalMini["status"]): string {
  if (status === "DONE") return "tone-done";
  if (status === "AT_RISK") return "tone-risk";
  if (status === "DROPPED") return "tone-dropped";
  if (status === "IN_PROGRESS") return "tone-progress";
  return "tone-draft";
}

function buildDeveloperGoalsHtml(d: Dev): string {
  const goalRows = d.goals
    .map((g) => {
      const pct = typeof g.progress_pct === "string"
        ? parseFloat(g.progress_pct)
        : g.progress_pct;
      const due = g.due_date ? `<span class="due">마감 ${g.due_date}</span>` : "";
      return `
        <tr>
          <td class="title-cell">
            <span class="prio prio-${g.priority}">${PRIORITY_LABEL[g.priority]}</span>
            <span class="diff diff-${g.difficulty}">${DIFFICULTY_LABEL[g.difficulty]}</span>
            <span class="cat">${CATEGORY_LABEL[g.category] ?? escapeHtml(g.category)}</span>
            <span class="title">${escapeHtml(g.title)}</span>
            ${due}
          </td>
          <td class="bar-cell">${progressBar(pct, g.status)}</td>
          <td class="pct">${pct.toFixed(0)}%${pct > 100 ? '<span class="over">✨+' + (pct - 100).toFixed(0) + '%</span>' : ''}</td>
          <td><span class="status ${statusTone(g.status)}">${STATUS_LABEL[g.status]}</span></td>
        </tr>
      `;
    })
    .join("");

  const meta = [
    d.title,
    d.employment_type !== "FULL_TIME"
      ? EMP_LABEL[d.employment_type] ?? d.employment_type
      : null,
  ].filter((v) => !!v).join(" · ");

  return `
    <section class="dev-block">
      <div class="dev-head">
        <span class="dev-name">${escapeHtml(d.name)}${d.tag ? ' <span class="tag">' + escapeHtml(d.tag) + '</span>' : ''}</span>
        ${meta ? `<span class="dev-meta">${escapeHtml(meta)}</span>` : ''}
        <span class="dev-summary">
          <span class="grade grade-${d.grade}">${d.grade}</span>
          <span class="dev-score">${d.score.toFixed(0)}점</span>
          <span class="dev-counts">활성 ${d.active_goal_count} · 완료 ${d.done_count}${d.at_risk_count ? ' · 위기 ' + d.at_risk_count : ''}${d.overdue_count ? ' · 지각 ' + d.overdue_count : ''}</span>
        </span>
      </div>
      <table class="goals">
        <colgroup>
          <col style="width:55%"/>
          <col style="width:23%"/>
          <col style="width:8%"/>
          <col style="width:14%"/>
        </colgroup>
        <tbody>${goalRows}</tbody>
      </table>
    </section>
  `;
}

function buildBodyHtml(data: OverviewOut, logoDataUrl: string | null): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const logoHeader = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="logo" style="height:30px;width:auto;display:block;" />`
    : "";

  const sumRows = `
    <tr>
      <td><div class="lbl">활성 직원</div><div class="val tabular">${data.summary.with_active_goals} / ${data.summary.total_developers}</div></td>
      <td><div class="lbl">평균 점수</div><div class="val tabular">${data.summary.avg_score.toFixed(1)}</div></td>
      <td><div class="lbl">위기 보유</div><div class="val tabular ${data.summary.at_risk_developers > 0 ? "danger" : ""}">${data.summary.at_risk_developers}명</div></td>
      <td><div class="lbl">지각 보유</div><div class="val tabular ${data.summary.overdue_developers > 0 ? "warn" : ""}">${data.summary.overdue_developers}명</div></td>
    </tr>
  `;

  const devRows = data.developers
    .map((d) => {
      const meta = [
        d.title,
        d.employment_type !== "FULL_TIME"
          ? EMP_LABEL[d.employment_type] ?? d.employment_type
          : null,
      ]
        .filter((v) => !!v)
        .join(" · ");
      const flags: string[] = [];
      if (d.at_risk_count > 0) flags.push(`<span class="flag danger">⚠ 위기 ${d.at_risk_count}</span>`);
      if (d.overdue_count > 0) flags.push(`<span class="flag warn">⏰ 지각 ${d.overdue_count}</span>`);
      return `
        <tr>
          <td><div class="name">${escapeHtml(d.name)}${d.tag ? ' <span class="tag">' + escapeHtml(d.tag) + '</span>' : ''}</div>${meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : ''}</td>
          <td class="tabular">${d.active_goal_count} / ${d.goal_count}</td>
          <td class="tabular score">${d.score.toFixed(1)}</td>
          <td><span class="grade grade-${d.grade}">${d.grade}</span></td>
          <td class="tabular">${d.done_count}</td>
          <td>${flags.length > 0 ? flags.join(" ") : '<span class="ok">—</span>'}</td>
        </tr>
      `;
    })
    .join("");

  const empty = `<tr><td colspan="6" class="empty">표시할 직원이 없습니다.</td></tr>`;

  return `
    <div class="page">
      <header>
        <div>
          <div class="title">직원 현황 보고서</div>
          <div class="meta">${data.year}년 · 출력 ${today} · 총 ${data.developers.length}명</div>
        </div>
        <div>${logoHeader}</div>
      </header>

      <h2 class="section">요약</h2>
      <table class="summary">
        <colgroup>
          <col style="width:25%"/>
          <col style="width:25%"/>
          <col style="width:25%"/>
          <col style="width:25%"/>
        </colgroup>
        ${sumRows}
      </table>

      <h2 class="section">직원별 점수</h2>
      <table class="devs">
        <colgroup>
          <col style="width:30%"/>
          <col style="width:13%"/>
          <col style="width:13%"/>
          <col style="width:9%"/>
          <col style="width:10%"/>
          <col style="width:25%"/>
        </colgroup>
        <thead>
          <tr>
            <th>이름</th>
            <th>활성 / 전체</th>
            <th>종합 점수</th>
            <th>등급</th>
            <th>완료</th>
            <th>이슈</th>
          </tr>
        </thead>
        <tbody>
          ${data.developers.length > 0 ? devRows : empty}
        </tbody>
      </table>

      ${
        data.developers.length > 0 && data.developers.some((d) => d.goals.length > 0)
          ? `
            <h2 class="section">직원별 목표 진척도</h2>
            ${data.developers
              .filter((d) => d.goals.length > 0)
              .map((d) => buildDeveloperGoalsHtml(d))
              .join("")}
          `
          : ""
      }

      <footer>
        <span>직원 현황 보고서 · ${data.year}년</span>
        <span>출력 ${today}</span>
      </footer>
    </div>
  `;
}

const PRINT_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: 'Noto Sans KR', 'Roboto Condensed', system-ui, sans-serif;
    color: #0f172a;
    background: #f8fafc;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @page { size: A4 landscape; margin: 10mm 10mm; }

  .controls {
    position: sticky;
    top: 0;
    background: #ffffff;
    border-bottom: 1px solid #e2e8f0;
    padding: 8px 16px;
    display: flex;
    gap: 8px;
    align-items: center;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    z-index: 100;
  }
  .controls .left { font-size: 13px; color: #64748b; flex: 1; }
  .controls button {
    height: 28px;
    padding: 0 12px;
    font-size: 12px;
    border: 1px solid #cbd5e1;
    background: #ffffff;
    color: #0f172a;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .controls button.primary {
    background: #2563eb;
    color: #ffffff;
    border-color: #2563eb;
  }
  .controls button:hover { filter: brightness(0.95); }
  @media print { .controls { display: none !important; } body { background: #ffffff; } }

  .page { padding: 16px 24px; max-width: 297mm; margin: 0 auto; background: #ffffff; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #e2e8f0;
  }
  .title { font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
  .meta  { font-size: 11px; color: #64748b; margin-top: 2px; }
  h2.section {
    font-size: 13px;
    font-weight: 700;
    margin: 14px 0 6px 0;
    color: #1e293b;
    border-left: 3px solid #2563eb;
    padding-left: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 11px;
  }
  table.summary td {
    padding: 8px 10px;
    border: 1px solid #e2e8f0;
    background: #f8fafc;
    vertical-align: top;
  }
  table.summary .lbl { color: #64748b; font-size: 10px; margin-bottom: 2px; }
  table.summary .val { font-size: 16px; font-weight: 700; }
  .tabular { font-variant-numeric: tabular-nums; }
  table.devs thead th {
    font-size: 10px;
    color: #475569;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    padding: 6px 8px;
    text-align: left;
    font-weight: 700;
  }
  table.devs tbody td {
    padding: 6px 8px;
    border: 1px solid #e2e8f0;
    vertical-align: middle;
  }
  table.devs tbody tr { page-break-inside: avoid; }
  .name { font-weight: 600; }
  .name .tag { font-size: 10px; color: #94a3b8; font-weight: 400; }
  .meta { font-size: 10px; color: #64748b; }
  td .score { font-weight: 700; }
  .grade {
    display: inline-block;
    width: 22px;
    text-align: center;
    border-radius: 3px;
    font-weight: 700;
    color: #ffffff;
    font-size: 11px;
    line-height: 1.5;
  }
  .grade-S { background: #9333ea; }
  .grade-A { background: #059669; }
  .grade-B { background: #2563eb; }
  .grade-C { background: #d97706; }
  .grade-D { background: #dc2626; }
  .flag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    margin-right: 4px;
    border: 1px solid;
  }
  .flag.danger { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
  .flag.warn { background: #fef3c7; color: #b45309; border-color: #fde68a; }
  .ok { color: #94a3b8; }
  .empty { text-align: center; padding: 24px; color: #94a3b8; }

  footer {
    margin-top: 16px;
    padding-top: 8px;
    border-top: 1px solid #e2e8f0;
    font-size: 10px;
    color: #64748b;
    display: flex;
    justify-content: space-between;
  }

  /* 직원별 목표 진척도 — 직원당 1 block, 페이지 분할 회피 */
  .dev-block {
    margin: 10px 0 12px 0;
    page-break-inside: avoid;
  }
  .dev-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    background: #eff6ff;
    border: 1px solid #dbeafe;
    border-radius: 4px 4px 0 0;
    border-bottom: none;
  }
  .dev-name { font-weight: 700; font-size: 12px; }
  .dev-name .tag { font-size: 10px; color: #94a3b8; font-weight: 400; }
  .dev-meta { font-size: 10px; color: #64748b; flex: 1; }
  .dev-summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .dev-summary .grade { width: 20px; height: 18px; line-height: 18px; }
  .dev-score { font-weight: 700; }
  .dev-counts { font-size: 10px; color: #64748b; }

  table.goals { border-radius: 0 0 4px 4px; overflow: hidden; }
  table.goals tbody td {
    padding: 5px 8px;
    border: 1px solid #e2e8f0;
    font-size: 10.5px;
    vertical-align: middle;
  }
  table.goals tbody tr { page-break-inside: avoid; }
  .title-cell { line-height: 1.5; }
  .title-cell .title {
    font-size: 14px;        /* text-sm */
    font-weight: 700;       /* bold */
    margin-left: 4px;
  }
  .title-cell .due { font-size: 9px; color: #94a3b8; margin-left: 6px; }

  /* 우선순위·난이도·분류 mini 배지 */
  .prio, .diff, .cat {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 2px;
    font-size: 9px;
    font-weight: 600;
    margin-right: 3px;
    border: 1px solid;
  }
  .prio-HIGH    { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
  .prio-MEDIUM  { background: #fef3c7; color: #92400e; border-color: #fde68a; }
  .prio-LOW     { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
  .diff-ROUTINE     { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
  .diff-NORMAL      { background: #dbeafe; color: #1e40af; border-color: #bfdbfe; }
  .diff-CHALLENGING { background: #fef3c7; color: #92400e; border-color: #fde68a; }
  .diff-STRETCH     { background: #ede9fe; color: #6b21a8; border-color: #ddd6fe; }
  .cat { background: #ffffff; color: #64748b; border-color: #e2e8f0; }

  /* 진행률 bar */
  .bar { width: 100%; height: 6px; background: #f1f5f9; border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-cell { padding: 5px 8px; }
  .pct { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .pct .over {
    display: inline-block;
    margin-left: 4px;
    color: #9333ea;
    font-size: 9px;
    font-weight: 700;
  }

  /* 상태 배지 */
  .status {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 2px;
    font-size: 9.5px;
    font-weight: 600;
  }
  .tone-done     { background: #d1fae5; color: #065f46; }
  .tone-progress { background: #fef3c7; color: #92400e; }
  .tone-risk     { background: #fee2e2; color: #b91c1c; }
  .tone-dropped  { background: #f1f5f9; color: #64748b; }
  .tone-draft    { background: #f1f5f9; color: #475569; }
`;

/**
 * 직원 현황 PDF — 새 창에 미리보기 + 상단 "PDF 인쇄" 버튼.
 * 자동 print() 호출 X. 사용자가 검토 후 인쇄 버튼 클릭으로 트리거.
 */
export async function printGoalsTeamOverview(year: number): Promise<void> {
  const data = (await api.get("/goals/score/team-overview", { params: { year } }))
    .data as OverviewOut;
  const logo = await loadLogoDataUrl(180);
  const body = buildBodyHtml(data, logo);

  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) {
    throw new Error("팝업이 차단되어 있습니다. 브라우저의 팝업 차단을 해제해 주세요.");
  }

  win.document.open();
  win.document.write(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>직원 현황 보고서 · ${data.year}년</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet" />
    <style>${PRINT_CSS}</style>
  </head>
  <body>
    <div class="controls">
      <div class="left">직원 현황 보고서 미리보기 — 검토 후 인쇄 버튼을 누르세요.</div>
      <button class="primary" onclick="window.print()">PDF 인쇄</button>
      <button onclick="window.close()">닫기</button>
    </div>
    ${body}
  </body>
</html>`);
  win.document.close();
}
