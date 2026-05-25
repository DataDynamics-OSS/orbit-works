/**
 * G6 v5 커스텀 노드 — 조직도 카드.
 *
 * G6 의 기본 `html` 노드는 transform: scale 으로 zoom 되면 텍스트가 raster
 * 된 비트맵을 키우는 식이라 zoom level 별로 흐려진다. canvas 기반 Rect 노드는
 * zoom 시 매번 vector 로 re-paint 되므로 어떤 배율에서도 또렷하게 보임.
 *
 * 시각 디자인은 G6 fund-flow 예제 패턴 — 상단 색깔 띠 (보안등급 색) + 본문
 * 텍스트 라인 + 우하단 메타. React-Flow 시절 카드와 동일한 정보를 표시.
 */

import { ExtensionCategory, Rect, register } from "@antv/g6";

export type SecurityRole = "ADMIN" | "HR" | "SALES" | "SUPPORT" | "ETC";

export type OrgCardData = {
  id: string;
  name: string;
  employee_no: string | null;
  phone: string | null;
  email: string | null;
  rank_name: string | null;
  position_name: string | null;
  report_count: number;
  security_role: SecurityRole;
};

export const ORG_CARD_W = 280;
export const ORG_CARD_H = 116;
const HEADER_H = 28;
const PADX = 12;

const ROLE_COLOR: Record<SecurityRole, { header: string; bg: string }> = {
  ADMIN:   { header: "#a855f7", bg: "#faf5ff" },
  HR:      { header: "#10b981", bg: "#ecfdf5" },
  SALES:   { header: "#3b82f6", bg: "#eff6ff" },
  SUPPORT: { header: "#f59e0b", bg: "#fffbeb" },
  ETC:     { header: "#64748b", bg: "#f8fafc" },
};

// G6 의 attributes 객체는 style + 등록 시 받는 추가 prop 을 합쳐 들어옴.
// any 사용 — G6 v5 의 attributes 는 generic 으로 풀기엔 제네릭 시그니처가
// 깊어서 실용적으로 좁힘.
function pickColor(attributes: any) {
  const role: SecurityRole = attributes?.data?.security_role ?? "ETC";
  return ROLE_COLOR[role] ?? ROLE_COLOR.ETC;
}

// 텍스트 ellipsis — canvas 텍스트는 자동 자르기가 없어 직접 잘라야 함.
// fontSize 는 대략적이라 평균 글자 폭을 fontSize * 0.55 로 근사.
function ellipsize(text: string, maxWidth: number, fontSize: number): string {
  if (!text) return "";
  const avg = fontSize * 0.55;
  const max = Math.max(1, Math.floor(maxWidth / avg));
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "…";
}

export class OrgCardNode extends Rect {
  // 카드 본체 — 흰 배경 + 라이트 보더. 보안등급 색은 상단 띠로만 노출.
  protected getKeyStyle(attributes: any) {
    const base = super.getKeyStyle(attributes);
    return {
      ...base,
      width: ORG_CARD_W,
      height: ORG_CARD_H,
      fill: "#ffffff",
      stroke: "#e2e8f0",
      lineWidth: 1,
      radius: 8,
      shadowColor: "rgba(15, 23, 42, 0.08)",
      shadowBlur: 6,
      shadowOffsetY: 1,
    };
  }

  protected drawHeaderBgShape(attributes: any, container: any) {
    const c = pickColor(attributes);
    return this.upsert(
      "header-bg",
      "rect" as never,
      {
        x: -ORG_CARD_W / 2,
        y: -ORG_CARD_H / 2,
        width: ORG_CARD_W,
        height: HEADER_H,
        fill: c.header,
        radius: [8, 8, 0, 0],
      },
      container,
    );
  }

  protected drawHeaderNameShape(attributes: any, container: any) {
    const dev: OrgCardData | undefined = attributes?.data;
    return this.upsert(
      "header-name",
      "text" as never,
      {
        x: -ORG_CARD_W / 2 + PADX,
        y: -ORG_CARD_H / 2 + HEADER_H / 2,
        text: ellipsize(dev?.name ?? "", ORG_CARD_W * 0.55, 13),
        fontSize: 13,
        fontWeight: 600,
        fill: "#ffffff",
        textBaseline: "middle",
      },
      container,
    );
  }

  protected drawMetaShape(attributes: any, container: any) {
    const dev: OrgCardData | undefined = attributes?.data;
    const meta =
      [dev?.rank_name, dev?.position_name, dev?.employee_no]
        .filter(Boolean)
        .join(" · ") || "-";
    return this.upsert(
      "body-meta",
      "text" as never,
      {
        x: -ORG_CARD_W / 2 + PADX,
        y: -ORG_CARD_H / 2 + HEADER_H + 14,
        text: ellipsize(meta, ORG_CARD_W - PADX * 2, 12),
        fontSize: 12,
        fontWeight: 500,
        fill: "#0f172a",
        textBaseline: "middle",
      },
      container,
    );
  }

  protected drawPhoneShape(attributes: any, container: any) {
    const dev: OrgCardData | undefined = attributes?.data;
    return this.upsert(
      "body-phone",
      "text" as never,
      {
        x: -ORG_CARD_W / 2 + PADX,
        y: -ORG_CARD_H / 2 + HEADER_H + 36,
        text: `☎ ${dev?.phone ?? "-"}`,
        fontSize: 11,
        fill: "#52525b",
        textBaseline: "middle",
      },
      container,
    );
  }

  protected drawEmailShape(attributes: any, container: any) {
    const dev: OrgCardData | undefined = attributes?.data;
    return this.upsert(
      "body-email",
      "text" as never,
      {
        x: -ORG_CARD_W / 2 + PADX,
        y: -ORG_CARD_H / 2 + HEADER_H + 54,
        text: ellipsize(`✉ ${dev?.email ?? "-"}`, ORG_CARD_W - PADX * 2, 11),
        fontSize: 11,
        fill: "#52525b",
        textBaseline: "middle",
      },
      container,
    );
  }

  protected drawReportCountShape(attributes: any, container: any) {
    const dev: OrgCardData | undefined = attributes?.data;
    if (!dev || dev.report_count <= 0) {
      // upsert 로 등록된 shape 가 있으면 비움.
      return this.upsert(
        "body-reports",
        "text" as never,
        { text: "", x: 0, y: 0 },
        container,
      );
    }
    return this.upsert(
      "body-reports",
      "text" as never,
      {
        x: ORG_CARD_W / 2 - PADX,
        y: ORG_CARD_H / 2 - 10,
        text: `직속 ${dev.report_count}명`,
        fontSize: 10,
        fill: "#94a3b8",
        textBaseline: "bottom",
        textAlign: "right",
      },
      container,
    );
  }

  // G6 가 매 frame 호출 — super.render 가 base rect 를 그리고, 그 다음
  // 우리 sub-shape 들을 upsert. upsert 는 idempotent 라 여러 번 호출 OK.
  public render(attributes: any, container: any): void {
    super.render(attributes, container);
    this.drawHeaderBgShape(attributes, container);
    this.drawHeaderNameShape(attributes, container);
    this.drawMetaShape(attributes, container);
    this.drawPhoneShape(attributes, container);
    this.drawEmailShape(attributes, container);
    this.drawReportCountShape(attributes, container);
  }
}

// 모듈 로드 시 1회 등록. HMR 로 두 번째 호출되면 G6 가 throw 하므로 try/catch.
let _registered = false;
export function ensureOrgCardRegistered(): void {
  if (_registered) return;
  try {
    register(ExtensionCategory.NODE, "org-card", OrgCardNode);
    _registered = true;
  } catch {
    // 이미 등록되어 있으면 swallow — 개발 중 HMR 케이스.
    _registered = true;
  }
}
