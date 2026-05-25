"use client";

/**
 * 결재선 — 조직도 시각화 페이지.
 *
 * sidebar > 홈 > 결재선 메뉴의 라우팅 대상. 페이지 표준 레이아웃
 * (DashboardHeader + body) 안에서 OrgChartDialog 를 inline 모드로 마운트.
 * 다이얼로그 자체 헤더 / 닫기 버튼 / fixed 오버레이는 inline=true 가
 * 비활성화하고, 범례는 그래프 좌상단 floating chip 으로 노출된다.
 *
 * 임직원 그리드 / 주소록의 "결재선" 버튼이 띄우는 다이얼로그 모드와는
 * 동일 컴포넌트, 다른 chrome.
 */

import { DashboardHeader } from "@/components/layout/DashboardHeader";
import { OrgChartDialog } from "@/components/developers/OrgChartDialog";

export default function OrgChartPage() {
  return (
    <>
      <DashboardHeader title="결재선" />
      <OrgChartDialog open onClose={() => undefined} inline />
    </>
  );
}
