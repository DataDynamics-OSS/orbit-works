"use client";

/**
 * 임직원 명부 (정규직 재직자) → 브라우저 print 기반 PDF.
 *
 * 다른 export lib (contacts/leave/event 등) 은 html2canvas + jsPDF 로 이미지
 * PDF 를 만들지만, 이 명부는 사용자가 개별 셀을 **Copy & Paste 하기 위해**
 * 텍스트가 선택되는 PDF 가 필요. 브라우저의 print → "Save as PDF" 를 쓰면
 * 별도 의존성 없이 한국어 native 렌더 + 텍스트 선택 가능한 진짜 PDF 생성.
 *
 * 레이아웃: 1인당 2 row.
 *   Row 1: 이름 / 연락처 / 이메일 / 입사일 / 생년월일 / 주소
 *   Row 2: 여권번호 / 영문성 / 영문이름 / 발급일 / 만료일 / 비상연락처
 */

import { api } from "./api";
import { ageFromBirthDate } from "./resident";

export type RosterPassport = {
  passport_number: string | null;
  surname_en: string | null;
  given_name_en: string | null;
  issue_date: string | null;
  expiry_date: string | null;
};

export type RosterEmergencyContact = {
  name: string | null;
  relation: string | null;
  phone: string | null;
};

export type RosterRow = {
  id: string;
  name: string;
  employee_no: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  hire_date: string | null;
  birth_date: string | null;
  gender: "M" | "F" | null;
  passport: RosterPassport | null;
  emergency_contacts: RosterEmergencyContact[];
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

function dash(v: string | null | undefined): string {
  return v && v.length > 0 ? escapeHtml(v) : "—";
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

function emergencyLine(contacts: RosterEmergencyContact[]): string {
  if (!contacts || contacts.length === 0) return "—";
  return contacts
    .map((c) => {
      const name = c.name ?? "";
      const rel = c.relation ? `(${c.relation})` : "";
      const phone = c.phone ?? "";
      return `${escapeHtml(name)}${escapeHtml(rel)} · ${escapeHtml(phone)}`;
    })
    .join("<br/>");
}

function buildHtml(rows: RosterRow[], logoDataUrl: string | null): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const logoHeader = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="logo" style="height:30px;width:auto;display:block;" />`
    : "";

  // 1인당 2 행 — <tbody> 로 묶어 page-break-inside:avoid 적용.
  const bodyHtml = rows
    .map((r) => {
      const p = r.passport;
      // 이름 + 나이/성별 + 사번 합성. 미상 항목은 생략.
      // 예: "홍길동 (35/남) / 00001" / "홍길동 (35) / 00001" / "홍길동 (남)" / "홍길동"
      const ageNum = ageFromBirthDate(r.birth_date);
      const ageStr = ageNum != null ? String(ageNum) : null;
      const genderStr =
        r.gender === "M" ? "남" : r.gender === "F" ? "여" : null;
      const metaParts = [ageStr, genderStr].filter((v): v is string => !!v);
      const metaPart = metaParts.length > 0 ? ` (${metaParts.join("/")})` : "";
      const noPart = r.employee_no ? ` / ${r.employee_no}` : "";
      const nameLabel = `${r.name}${metaPart}${noPart}`;
      return `
        <tbody class="person">
          <tr class="row1">
            <td><div class="lbl">이름 (나이/성별) / 사번</div><div class="val name">${dash(nameLabel)}</div></td>
            <td><div class="lbl">연락처</div><div class="val">${dash(r.phone)}</div></td>
            <td><div class="lbl">이메일</div><div class="val">${dash(r.email)}</div></td>
            <td><div class="lbl">입사일</div><div class="val">${dash(r.hire_date)}</div></td>
            <td><div class="lbl">생년월일</div><div class="val">${dash(r.birth_date)}</div></td>
            <td><div class="lbl">주소</div><div class="val">${dash(r.address)}</div></td>
          </tr>
          <tr class="row2">
            <td><div class="lbl">여권번호</div><div class="val">${dash(p?.passport_number ?? null)}</div></td>
            <td><div class="lbl">영문성</div><div class="val">${dash(p?.surname_en ?? null)}</div></td>
            <td><div class="lbl">영문이름</div><div class="val">${dash(p?.given_name_en ?? null)}</div></td>
            <td><div class="lbl">발급일</div><div class="val">${dash(p?.issue_date ?? null)}</div></td>
            <td><div class="lbl">만료일</div><div class="val">${dash(p?.expiry_date ?? null)}</div></td>
            <td><div class="lbl">비상연락처</div><div class="val">${emergencyLine(r.emergency_contacts)}</div></td>
          </tr>
        </tbody>
      `;
    })
    .join("");

  const empty = `
    <div class="empty">재직중인 정규직 임직원이 없습니다.</div>
  `;

  return `
    <div class="page">
      <header>
        <div>
          <div class="title">임직원 명부 (정규직 · 재직)</div>
          <div class="meta">총 ${rows.length}명 · 출력 ${today}</div>
        </div>
        <div>${logoHeader}</div>
      </header>
      ${
        rows.length > 0
          ? `<table>
              <colgroup>
                <col style="width:14%"/>
                <col style="width:13%"/>
                <col style="width:18%"/>
                <col style="width:11%"/>
                <col style="width:12%"/>
                <col style="width:32%"/>
              </colgroup>
              ${bodyHtml}
            </table>`
          : empty
      }
      <footer>
        <span>임직원 명부 (정규직 · 재직)</span>
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
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @page { size: A4 landscape; margin: 10mm 10mm; }
  .page { padding: 4px 0; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .title { font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }
  .meta  { font-size: 10px; color: #64748b; margin-top: 2px; }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 10px;
  }
  .person { page-break-inside: avoid; }
  /* 사람 단위 zebra — 짝수 번째 사람(.person) 의 td 배경을 #eeeeee.
     첫 사람=흰색, 두 번째=#eeeeee, 세 번째=흰색 ... 식으로 교대. */
  .person:nth-of-type(even) td { background-color: #eeeeee; }
  /* 검정 1px — table-collapse 가 인접 보더를 dedup 해 균일한 얇은 선이 됨. */
  td {
    border: 1px solid #000000;
    padding: 4px 6px;
    vertical-align: top;
    word-break: break-word;
  }
  .lbl { font-size: 8px; color: #64748b; font-weight: 600; }
  .val { font-size: 10px; color: #0f172a; margin-top: 1px; }
  .val.name { font-weight: 700; }
  .empty {
    margin-top: 48px;
    text-align: center;
    font-size: 11px;
    color: #94a3b8;
  }
  footer {
    display: flex;
    justify-content: space-between;
    margin-top: 10px;
    font-size: 8px;
    color: #64748b;
  }

  /* 인쇄 시 헤더 반복은 thead 가 있어야 동작 — 여기선 thead 없이 1인 2 row 라
     반복 헤더 대신 page-break-inside: avoid 로 사람 단위 페이지 밀림만 보장. */
`;

/**
 * 새 창 → HTML 렌더 → 폰트/이미지 로드 후 window.print() 자동 트리거.
 * 사용자는 "PDF 로 저장" 선택 시 텍스트 선택 가능한 진짜 PDF 다운로드.
 *
 * `selectedIds` 가 non-empty 면 그 사람들만, 비어 있으면 전체(정규직 재직자) 출력.
 */
export async function printDevelopersRoster(
  selectedIds?: string[],
): Promise<void> {
  const all = (await api.get("/developers/roster")).data as RosterRow[];
  const rows =
    selectedIds && selectedIds.length > 0
      ? all.filter((r) => selectedIds.includes(r.id))
      : all;
  const logo = await loadLogoDataUrl(180);
  const html = buildHtml(rows, logo);

  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) {
    throw new Error("팝업이 차단되어 있습니다. 브라우저의 팝업 차단을 해제해 주세요.");
  }

  // 새 창에 풀 HTML 작성. 폰트는 Google Fonts 의 Noto Sans KR (웹폰트) 사용해
  // 시스템 폰트 환경 차이를 줄이고 한국어 렌더링을 일관되게.
  win.document.open();
  win.document.write(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>임직원 명부 (정규직 · 재직)</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700&display=swap" rel="stylesheet" />
    <style>${PRINT_CSS}</style>
  </head>
  <body>
    ${html}
    <script>
      (async function () {
        try {
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
        } catch (_) {}
        // 약간 지연 → 이미지(로고) decode 대기.
        setTimeout(function () {
          try { window.focus(); window.print(); } catch (_) {}
        }, 350);
        // 인쇄 종료 후 창 자동 닫기 (선택).
        window.addEventListener('afterprint', function () { window.close(); });
      })();
    </script>
  </body>
</html>`);
  win.document.close();
}

// 기존 호출 시그니처 유지용 alias — 페이지에선 이 이름을 사용.
export const downloadDevelopersRosterPDF = printDevelopersRoster;
