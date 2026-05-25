"use client";

/**
 * 도움말 콘텐츠 manifest.
 *
 * 각 섹션의 `key` 는 `components/layout/menu-registry.ts` 의 menu `key` 와
 * 1:1 동일. DashboardHeader 의 도움말 아이콘이 현재 pathname → menu_key 로
 * 매핑한 뒤 `/help/<key>` 로 직접 deep link 한다.
 *
 * 단일 파일에 모든 섹션 — 인덱스(/help) 와 상세(/help/[key]) 가 같은
 * manifest 를 import 하지만, 실제 콘텐츠는 dynamic route 단위로 split 되어
 * 네트워크 트래픽이 분산된다.
 *
 * 이미지를 넣을 때는 `next/image` 사용 권장 (자동 lazy + WebP/AVIF 변환).
 */

import type { ReactNode } from "react";

export type HelpSection = {
  key: string;
  title: string;
  group: string;
  summary?: string;
  content: ReactNode;
};

// 공용 단축 components — 본문 작성 효율.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h3>{title}</h3>
      {children}
    </>
  );
}

function Perm({ children }: { children: ReactNode }) {
  return (
    <p>
      <b>권한</b> — {children}
    </p>
  );
}

export const HELP_SECTIONS: HelpSection[] = [
  // -------------------------------------------------------------------- 홈
  {
    key: "dashboard",
    title: "대시보드",
    group: "홈",
    summary: "연도별 KPI · 영업/프로젝트 차트 · 환율 · 마감 임박 항목을 한 화면에 요약.",
    content: (
      <>
        <Section title="핵심 위젯">
          <ul>
            <li>연도별 KPI 5종 — 수주(KRW/USD) · 전년대비 · 진행 영업기회 · 이번 달 원가/수익 · 만료 임박 라이센스</li>
            <li>막대 차트 — 영업 실적 / 프로젝트 수익성 (월별)</li>
            <li>단계별 영업 깔때기 + USD/KRW 환율</li>
            <li>다음 급여일 (Settings → 급여 의 설정 + 휴일 보정 자동 계산)</li>
            <li>마감 임박 영업기회/라이센스, 적자 프로젝트, 유휴 인력</li>
          </ul>
        </Section>
        <Perm>로그인한 모든 사용자.</Perm>
      </>
    ),
  },
  {
    key: "notice",
    title: "공지사항",
    group: "홈",
    summary: "ADMIN 이 작성하는 전사 공지. TipTap 본문 + 첨부 + 코멘트 + 사이드 TOC.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>TipTap 풀 toolbar 본문 (이미지·표·체크리스트·코드블록)</li>
            <li>20색 글자색 + 사용자 지정 색 + 이모지/특수문자 picker</li>
            <li>드래그 가능한 사이드 TOC (h1~h6 자동 추출)</li>
            <li>PWA Push 자동 발행 — 사용자가 토글한 경우 모바일로 푸시</li>
          </ul>
        </Section>
        <Perm>작성·삭제 ADMIN, 조회 전사. 코멘트는 누구나 작성, 수정/삭제 작성자+ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "board",
    title: "게시판",
    group: "홈",
    summary: "전사 자유 게시판. 공지와 동일한 에디터, 권한만 완화.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>TipTap 풀 toolbar + 첨부 + 사이드 TOC + 답글식 코멘트</li>
            <li>📌 고정 / 🔒 관리자만 컬럼 (visible_roles 지정 시)</li>
            <li>드래그 separator 로 TOC 폭 조절, localStorage 영속</li>
          </ul>
        </Section>
        <Perm>조회·작성 전사. 글 편집·삭제는 작성자+ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "meetings",
    title: "회의실 예약",
    group: "홈",
    summary: "회의실 시간대 EXCLUDE 제약으로 겹침 방지. 모바일 빠른 예약 지원.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>시간대 겹침 시 DB constraint 가 거부 (race condition 안전)</li>
            <li>참석자 다중 선택, 반복/수정/취소 지원</li>
            <li>모바일 PWA 에서 빠른 예약</li>
          </ul>
        </Section>
        <Perm>전사. 본인 예약은 본인이, 그 외 ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "meeting_notes",
    title: "회의록",
    group: "홈",
    summary: "BlockNote 본문 + 마인드맵 + drawio 다이어그램 + 첨부 + 액션 아이템. 풀 toolbar + 특수부호.",
    content: (
      <>
        <Section title="탭 5종">
          <ul>
            <li>본문 — BlockNote, 5초 autosave. 상단 풀 toolbar (B/I/U/S, 색상, 정렬, 리스트, 링크, 특수부호) + 사이드 TOC</li>
            <li>마인드맵 — reactflow, 노드 색·레이아웃 보존</li>
            <li>다이어그램 — 자체 호스팅 drawio iframe</li>
            <li>첨부 / 액션 아이템(TODO)</li>
          </ul>
        </Section>
        <Section title="공유와 이메일">
          <p>직원 picker 로 공유하면 Slack/Mattermost DM. "이메일 발송" 으로 본문 HTML + 메타를 메일 + DM 동시 발송.</p>
        </Section>
        <Perm>작성자/공유자/ADMIN. 메타 변경·삭제는 작성자만.</Perm>
      </>
    ),
  },
  {
    key: "weekly_reports",
    title: "주간보고",
    group: "홈",
    summary: "ISO 주 × 직원 = 1 row. 양식 2종(매니저/일반) 자동 선택, 13주 매트릭스로 한눈에.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>본문 = TipTap HTML, 5초 autosave. 상태 DRAFT → SUBMITTED 토글</li>
            <li>13주 매트릭스 — anchor 이동, 미작성/DRAFT/SUBMITTED 아이콘</li>
            <li>3 탭 — 내 보고서 / 팀 보고서(직속 후손 chain) / 전체(HR·ADMIN)</li>
            <li>본문 편집은 본인+ADMIN+SUPER_ADMIN. 코멘트는 SUBMITTED 후.</li>
          </ul>
        </Section>
        <Perm>본인 R/W, 직속 매니저 chain R, HR/ADMIN R.</Perm>
      </>
    ),
  },
  {
    key: "my_actions",
    title: "내 액션",
    group: "홈",
    summary: "회의록 + standalone 액션 통합. 마감일 기준 그룹 + 매일 09:05 미완료 DM.",
    content: (
      <>
        <Section title="3 탭">
          <ul>
            <li>내 액션 — 본인 mapped_developer 가 assignee</li>
            <li>팀 액션 — 직속 부하 chain (매니저인 경우 자동)</li>
            <li>전체 액션 — HR/ADMIN/SUPER_ADMIN</li>
          </ul>
        </Section>
        <Section title="자동 알림">
          <p>매일 09:05 KST cron 이 D-3/D-1/D-Day 미완료 항목을 담당자별로 Slack DM. 외부 게스트는 자동 skip.</p>
        </Section>
        <Perm>본인은 항상. 팀은 매니저 자동, 전체는 HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "goals",
    title: "목표",
    group: "홈",
    summary: "개인·회사 연간 목표. 3축 가중(난이도×우선순위×분류) → S~D 등급.",
    content: (
      <>
        <Section title="점수 모델">
          <p>진행률(0~100) × 난이도(일상 0.8 ~ 도약 2.0) × 우선순위 가중(상 3, 중 2, 하 1) × 분류 가중. 가중평균 0~200, 등급 S/A/B/C/D.</p>
        </Section>
        <Section title="3 탭">
          <ul>
            <li>내 목표 — 본인</li>
            <li>회사 목표 — 전사 readonly, ADMIN 만 작성</li>
            <li>팀 목표 — 매니저 chain 후손</li>
          </ul>
        </Section>
        <Section title="알림 & 평가">
          <p>09:10 KST cron 으로 D-30 / 영업일 OVERDUE 발송. 자기 평가 + 매니저 평가(0~150) + 코멘트.</p>
        </Section>
        <Perm>PERSONAL = 본인+직속매니저+HR/ADMIN. COMPANY = ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "org_chart",
    title: "결재선",
    group: "홈",
    summary: "AntV G6 기반 조직도. 마인드맵 레이아웃 + 서브트리 드래그 + 노드 클릭 사이드 패널.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>canvas 기반 노드 — 모든 zoom 배율에서 또렷</li>
            <li>서브트리 드래그 — 부모 끌면 후손 함께 이동</li>
            <li>플로팅 zoom 컨트롤 (+, 100%, −, fit)</li>
            <li>카드 색띠 = security_role (관리자/인사/영업/지원/일반)</li>
            <li>노드 클릭 → 우측 패널 (사번/직위/근무기간/총경력/연락처/참여 프로젝트)</li>
          </ul>
        </Section>
        <Perm>전사. 민감 정보(보안등급·주소·비상연락처·프로젝트 이동)는 HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "calendar",
    title: "일정",
    group: "홈",
    summary: "공휴일(법정/임시/회사) + 일정(공개/비공개) + 사내 이벤트 + 급여일 통합 캘린더.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>2024~2030 법정 공휴일 자동 시드</li>
            <li>비공개 일정은 HR/ADMIN/SUPER_ADMIN 만 보임</li>
            <li>급여일(💰) — Settings 급여 설정으로 매월 합성 row 자동 생성</li>
            <li>사내 이벤트(워크샵/컨퍼런스/출장) 자동 표시</li>
          </ul>
        </Section>
        <Perm>전사. 일정 추가 본인. 임시 휴일 ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "books",
    title: "도서",
    group: "홈",
    summary: "회사 도서 대장 + 임대 추적. 1권=1 row.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>제목·출판사·분야·임대인 ilike 검색</li>
            <li>임대 중 도서 삭제 시 confirm 한 번 더</li>
            <li>임대인 퇴사해도 도서는 보존 (FK SET NULL)</li>
          </ul>
        </Section>
        <Perm>조회 전사 / CRUD HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "trips",
    title: "해외출장 일정표",
    group: "홈",
    summary: "출장 일정 + 항공권 + 숙박 + 참석자 + 비용을 한 row 로 묶어 PDF 출력.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>일정·장소(지도) · 항공편(편명/좌석/시간) · 숙박(주소·전화·이메일)</li>
            <li>예산 / 소요금액 / 참가비 / 실비</li>
            <li>참석자(사내+게스트) · 첨부 N건 · 상세 계획 메모</li>
            <li>이벤트 1건 단위 PDF — 비용 요약 / 참석자 / 항공권 / 숙박 / 메모</li>
          </ul>
        </Section>
        <Perm>조회 전사, CRUD ADMIN/HR/SUPER_ADMIN.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 영업
  {
    key: "opportunities",
    title: "영업기회",
    group: "영업",
    summary: "연도별 Gantt + 단계(발굴/검증/제안/협상) × 상태(진행/수주/실주/중단) + 사업구분 prefix.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>활동 기록 — 미팅/전화/메일/제안/메모</li>
            <li>단계 변경 이력 자동 기록</li>
            <li>라이센스 / 프로젝트 / 견적서로 한 클릭 전환</li>
            <li>사업구분 prefix `[연구]`·`[민간]`·`[공공]`</li>
          </ul>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "announcements",
    title: "사업공고",
    group: "영업",
    summary: "글로벌 공고 데이터 + tenant 별 북마크. 6개 소스(G2B·NTIS·BizInfo·K-Startup·IRIS·NIPA·KEIT) 자동 수집.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>매일 03:00 source priority 순서로 수집</li>
            <li>필터·북마크·"영업기회 전환"</li>
            <li>서버 페이지네이션 (DataGrid serverPagination)</li>
          </ul>
        </Section>
        <Section title="API 키 설정">
          <p>Settings → 사업공고 탭에서 소스별 키 입력. 미설정 소스만 SKIPPED 로 건너뜀 (전체 job 계속).</p>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "quotes",
    title: "견적서",
    group: "영업",
    summary: "버전 이력 + DRAFT/FINAL 잠금 + A4 가로 PDF + Excel.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>{`<prefix>Q-YYYYMMDD-XXXX 자동 발번`}</li>
            <li>header + items 스냅샷 버전 이력</li>
            <li>블록 경계 분할 + 페이지 번호의 A4 가로 PDF</li>
            <li>영문 인보이스 → 매출 인보이스 자동 전환</li>
          </ul>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "invoices",
    title: "매출 인보이스",
    group: "영업",
    summary: "고객사 발행 인보이스. 결제 상태 + 수금일 + 통장 거래 매칭.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>{`<prefix>I-YYYYMMDD-XXXX 자동 발번`}</li>
            <li>버전 이력, A4 PDF, Excel, 영문 인보이스 (Bill To + PO + Net N)</li>
            <li>결제 상태 enum (UNPAID/PARTIAL/PAID) + 수금일 매칭</li>
          </ul>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "vendor_bills",
    title: "매입 인보이스",
    group: "영업",
    summary: "외부 vendor 가 우리에게 발행한 청구서 수동 입력. 카테고리 11종.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>공급업체·납품업체 분리 (고객사 마스터 picker)</li>
            <li>견적서/프로젝트 연결, Invoice/PO/Sales Order No</li>
            <li>카테고리 — CLOUD/SAAS/SOFTWARE_SUBSCRIPTION/HOSTING/MARKETING/...</li>
            <li>부가세 모드 + total_amount(GENERATED column)</li>
            <li>다중 영수증 첨부 (드래그앤드롭), USD 기본 + 콤마 머니</li>
          </ul>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "projects",
    title: "프로젝트",
    group: "영업",
    summary: "견적 라인 + 비용 매트릭스 + 투입 Gantt + 수익성 자동 계산.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>그리드 컬럼 — 총 사업비 / 총 투입원가 / 마진율(색상 신호) / 총 마진</li>
            <li>비용 매트릭스 — 월별 인력 비용 + 매출 + 수익</li>
            <li>프리랜서 비용 fallback 우선순위: per-row override → 연봉 이력 → developers.salary</li>
            <li>PDF / Excel 다운로드</li>
          </ul>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "assignments",
    title: "인력 투입",
    group: "영업",
    summary: "연간 사람별 프로젝트 Gantt (읽기 전용).",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>프로젝트별 색상 분리</li>
            <li>월 헤더 sticky</li>
            <li>수정은 각 프로젝트 상세 페이지에서</li>
          </ul>
        </Section>
        <Perm>SALES/ADMIN/HR.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 기술지원
  {
    key: "support_cases",
    title: "케이스",
    group: "기술지원",
    summary: "고객사 제품에서 발생한 문제·문의 추적. 상태·심각도·유형 필수.",
    content: (
      <>
        <Section title="핵심 흐름">
          <ol>
            <li>등록 — 제목 / 고객사 / 벤더·제품 / 심각도 / <b>유형</b> 필수, 상태 기본 OPEN</li>
            <li>처리 — IN_PROGRESS 로 전환, TipTap 코멘트 / 첨부</li>
            <li>종료 — "종료" 버튼 또는 상태 드롭다운 → CLOSED. <b>종료일·종료자 자동 기록</b> + 시스템 코멘트 추가</li>
            <li>재오픈 — "다시 열기" → 종료 메타 NULL reset</li>
          </ol>
        </Section>
        <Section title="유형 (필수, 8종)">
          <p>성능 / 기능 오동작 / 보안(인증·권한·암호화) / 데이터 손실 / 튜닝·최적화 / 작업 실패 / 서비스 다운 / 기타. 분포는 목록 상단 5번째 파이 차트.</p>
        </Section>
        <Section title="심각도 (AWS-style)">
          <p>S1(긴급) / S2(높음) / S3(보통) / S4(낮음) / S5(정보).</p>
        </Section>
        <Perm>SALES/HR/SUPPORT/ADMIN. 코멘트 수정/삭제 작성자+ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "support_logs",
    title: "기술지원",
    group: "기술지원",
    summary: "코멘트 단위 세션 모델 — 시작일/종료일/지원시간(분) 각 코멘트마다.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>코멘트 추가/편집 form 에 시작일/종료일/지원시간 입력</li>
            <li>부모 로그의 동일 컬럼은 SUM/MIN/MAX 로 자동 재계산</li>
            <li>월별 12 칸 + 엔지니어별 stacked series, 4 차트 1 row</li>
          </ul>
        </Section>
        <Perm>SALES/HR/SUPPORT/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "customer-status",
    title: "라이센스 현황",
    group: "기술지원",
    summary: "고객사 × 프로젝트(선택) × 시스템 단위로 라이센스·담당자·운영 메타를 카드 1장에 묶어 관리.",
    content: (
      <>
        <Section title="식별 단위">
          <ul>
            <li>(customer × project(선택) × system_name) — 같은 프로젝트라도 시스템(DataLake / Search / Gateway 등) 마다 별도 카드</li>
            <li>environment: PROD / STAGING / DEV (기본 PROD)</li>
            <li>runtime_type: VM / BAREMETAL / KUBERNETES / DOCKER (기본 BAREMETAL)</li>
          </ul>
        </Section>
        <Section title="라이센스 결합">
          <p>license_id 가 있으면 sidebar &gt; 라이센스 마스터와 연결. 라이센스 선택 시 master 의 start/end_date 가 비어 있는 슬롯에 자동 채워짐 (override 가능). 수량은 마스터에 없어 카드 자체 컬럼.</p>
        </Section>
        <Section title="담당자">
          <ul>
            <li>고객 담당자 — customer_contacts 마스터 (해당 고객사 한정)</li>
            <li>기술지원 담당자 — 내부 직원 (FULL_TIME + ACTIVE) picker, 가나다 정렬</li>
          </ul>
        </Section>
        <Section title="본문/첨부">
          <p>TipTap 본문 + TOC. 첨부 다중 업로드 / 이름 변경 / 이미지·PDF inline 미리보기 / 삭제 / 다운로드. 카드 삭제 시 첨부 디스크 정리.</p>
        </Section>
        <Perm>조회 — 모든 임직원. 작성·편집 — customer-status.write (SUPPORT/HR/ADMIN). 삭제 — customer-status.delete (HR/ADMIN) 또는 작성자 본인.</Perm>
      </>
    ),
  },
  {
    key: "kb",
    title: "지식 베이스",
    group: "기술지원",
    summary: "벤더 자료(DOC) + 사내 트러블슈팅 노하우(KB) 통합 — 카탈로그 / 태그 / TipTap 본문 / 외부 자료 링크 / 첨부.",
    content: (
      <>
        <Section title="두 종류 컨텐츠">
          <ul>
            <li><b>벤더 자료 (DOC)</b> — 외부 PDF·매뉴얼·release note 등 archive 중심</li>
            <li><b>노하우 (KB)</b> — 사내 트러블슈팅 / 비교 / 가이드 등 TipTap 긴 본문</li>
          </ul>
        </Section>
        <Section title="메타">
          <ul>
            <li>벤더 / 제품 / 버전 — 카탈로그 마스터 FK (NULL 허용 — 벤더 무관 가이드)</li>
            <li>자유 태그 (최대 3개) — 검색·분류</li>
            <li>외부 자료 링크 — 표시명 + URL, 최대 2개</li>
            <li>가시성 — all (전체) / manager / admin. 승격은 kb.publish_admin</li>
          </ul>
        </Section>
        <Section title="작성·편집">
          <p>TipTap 본문 + 사이드 TOC (heading 추출, 폭 드래그 조절, localStorage 영속). 첨부 다중 업로드 + 이름 변경 + 삭제. 검색용 plain_text 캐시.</p>
        </Section>
        <Perm>조회 — 모든 임직원 (visibility 제한). 작성·편집 — kb.write (SUPPORT/HR/ADMIN) 또는 작성자 본인. 삭제 — kb.delete (HR/ADMIN) 또는 작성자 본인.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 라이센스
  {
    key: "licenses",
    title: "SW 라이센스",
    group: "라이센스",
    summary: "고객사·프로젝트 연결, KRW/USD 환율, 매입·매출 견적 라인, 만료 추적.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>매입·매출 견적 라인 (벤더 ↔ 자사 ↔ 고객사)</li>
            <li>드래그앤드롭 첨부 (계약서·견적서·라이센스 키)</li>
            <li>상태 자동 (시작/종료 일자 기준)</li>
            <li>D-30 자동 알림 (매일 01:00 cron → Slack)</li>
          </ul>
        </Section>
        <Perm>SALES/HR/SUPPORT/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "licenses.calendar",
    title: "연간 캘린더",
    group: "라이센스",
    summary: "시작=파랑, 종료=빨강 색으로 연간 흐름 한눈에.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>연도 선택 → 12개월 캘린더에 라이센스 시작/종료 점 표시</li>
            <li>점 클릭 → 라이센스 상세로 이동</li>
          </ul>
        </Section>
        <Perm>SALES/HR/SUPPORT/ADMIN.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 자원
  {
    key: "developers",
    title: "임직원",
    group: "자원",
    summary: "정규직/프리랜서/자사화 통합 명부. 연봉·역할·기술·보안등급·여권 암호화.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>연봉 이력 + 4대보험 추정 + 상승률</li>
            <li>여권정보 탭 (Fernet 암호화) · 비상연락처 탭 — 본인/HR/ADMIN 만</li>
            <li>정규직 지표 패널 — KPI 7종 (성별/직급/연봉/나이/경력/근무기간)</li>
            <li>직위 분포 Gantt + 급여 분포 Scatter (HR/ADMIN)</li>
            <li>퇴사 처리 시 ACTIVE → INACTIVE</li>
          </ul>
        </Section>
        <Perm>조회 — 본인/매니저/HR/ADMIN. 민감 정보는 본인/HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "tax_invoices",
    title: "세금계산서",
    group: "자원",
    summary: "바로빌 API 로 매입·매출 자동 수집. approval_no UNIQUE upsert + PDF 자동 저장.",
    content: (
      <>
        <Section title="핵심 흐름">
          <ol>
            <li>자동 수집 — 매일 03:00 cron, 어제~7일 catchup. approval_no UNIQUE 라 중복 방지</li>
            <li>수동 수집 — "지금 수집" 버튼 (어제 기준 7일치 재조회)</li>
            <li>품목 — list API 응답의 ItemName 으로 1줄 자동 합성, detail API 가능 시 다품목 라인 갱신</li>
            <li>품목 백필 — "품목 백필" 버튼으로 비어있는 row 일괄 보강</li>
            <li>매칭 — 상세 다이얼로그에서 고객사·프로젝트 연결</li>
          </ol>
        </Section>
        <Section title="매출처 집계">
          <p>"매출처 집계" 버튼 → 도넛 차트 + 상위 N 순위 표 (buyer_biz_no 기준).</p>
        </Section>
        <Section title="알려진 제약">
          <ul>
            <li>바로빌 list API 는 5~6개월 이상 지난 작성일 데이터를 응답하지 않음</li>
            <li>detail API 호출은 자사 MgtNum 필요. 우리 키는 대부분 NTSSendKey 라 detail 빈 응답 → ItemName 폴백</li>
          </ul>
        </Section>
        <Perm>조회 tax_invoices.read, 매칭·백필 tax_invoices.manage — HR/ADMIN/SALES.</Perm>
      </>
    ),
  },
  {
    key: "tax_invoices.dashboard",
    title: "매입/매출 현황",
    group: "영업",
    summary: "수집된 매입·매출 세금계산서를 월별·연도별로 한눈에. KPI 카드 + 월별 추이 + 상위 매출처.",
    content: (
      <>
        <Section title="구성">
          <ul>
            <li>KPI 카드 — 이번 달/연도 매출·매입 합계, 전년 동기 대비 증감</li>
            <li>월별 추이 차트 (12개월) — 매출/매입 stacked</li>
            <li>상위 매출처 도넛 — buyer_biz_no 기준 비중</li>
            <li>매입·매출 분기·월 비교 — 올해 vs 작년</li>
          </ul>
        </Section>
        <Section title="데이터 소스">
          <p>tax_invoices 테이블 — 바로빌 자동 수집(03:00 cron) 결과. dashboard 는 실시간 집계.</p>
        </Section>
        <Perm>조회 tax_invoices.read — HR/ADMIN/SALES.</Perm>
      </>
    ),
  },
  {
    key: "cloud_costs",
    title: "클라우드 비용",
    group: "자원",
    summary: "AWS / Azure / GCP 일별 service-level 비용 자동 수집. USD/KRW 환산, 알람 5종.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>매일 04:00 단일 range 호출 (catchup_days 기간)</li>
            <li>provider 별 stacked bar + service Top 20 트리</li>
            <li>자격증명 Fernet 암호화 저장</li>
          </ul>
        </Section>
        <Section title="알람 5종">
          <p>일별 임계 / 월말 추정 / 수집 실패 / 전일 대비 급증 / 신규 서비스. 규칙별 Slack/Mattermost 수신자 override.</p>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "assets",
    title: "자산",
    group: "자원",
    summary: "회사 자산 19종 카테고리. 자산번호 Crockford base32 자동 발번 + QR 라벨.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>자산번호 <code>{`<prefix>-YYYY-XXXX`}</code> 자동 발번</li>
            <li>QR 라벨 PDF 인쇄 (Formtec QR-3111)</li>
            <li>모바일 QR 스캔으로 자산 위치 추적</li>
            <li>서버 페이지네이션</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "cars",
    title: "차량",
    group: "자원",
    summary: "리스/렌트/소유. 보험사·기간·관리자, slot 단위 첨부.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>차량 유형 (LEASE / RENT / OWN)</li>
            <li>보험 정보 + 만료 추적</li>
            <li>관리자 지정, slot 별 첨부 (계약서·면허증·차량등록증)</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "insurances",
    title: "보험",
    group: "자원",
    summary: "회사 보험 원장. 만료 D-30 자동 알림.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>보험사·증권번호·보장 내용</li>
            <li>시작·종료일 + 만료 D-30 Slack 알림</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "customers",
    title: "고객사",
    group: "자원",
    summary: "단일 담당자, 사업자등록증·통장 첨부, 활동 로그.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>대표이사 정보, 사업자등록번호 중복 등록 방지 (정규화 검증)</li>
            <li>활동 로그 (customer_interactions)</li>
            <li>고객사 ↔ 협력사 두 타입 통합 관리</li>
          </ul>
        </Section>
        <Perm>조회 전사 / 추가·삭제 ADMIN/HR/SALES/SUPPORT — ETC 차단.</Perm>
      </>
    ),
  },
  {
    key: "contacts",
    title: "주소록",
    group: "자원",
    summary: "4-tab(직원·프리랜서·고객·협력사) 통합 검색.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>이름·연락처·이메일·소속 통합 검색</li>
            <li>탭별로 다른 마스터 (직원→developers, 고객→customer_contacts)</li>
          </ul>
        </Section>
        <Perm>전사 조회. 편집은 각 마스터의 권한 따름.</Perm>
      </>
    ),
  },
  {
    key: "bank_accounts",
    title: "은행계좌",
    group: "자원",
    summary: "계좌별 CSV 거래내역 업로드. 매출 인보이스 매칭에 사용.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>계좌 등록 + CSV 거래내역 업로드 (월 네비)</li>
            <li>거래 메모 편집</li>
            <li>매출 인보이스 수금일 자동 매칭 후보로 사용</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "loans",
    title: "대출",
    group: "자원",
    summary: "회사 대출 원장 + 상환 일정.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>대출 종류 / 원금 / 이율 / 기간</li>
            <li>월별 상환 일정 + 잔액 추적</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "patents",
    title: "특허",
    group: "자원",
    summary: "자사가 보유하고 있는 특허의 출원/등록 정보를 관리합니다.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>등록/출원 prefix 자동 표시</li>
            <li>다중 첨부 (출원서·등록증·도면)</li>
            <li>현재 필터 적용된 landscape A4 PDF</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 인사
  {
    key: "payroll",
    title: "급여",
    group: "인사",
    summary: "월별 회차 급여. 4대보험·원천징수 자동 + 간이세액표 매트릭스.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>월별 회차 단위 (한 달에 여러 회차 가능)</li>
            <li>4대보험 (건보·국민·고용·산재) 자동 계산</li>
            <li>원천징수 = 월급여 × 부양가족(1~11) 매트릭스 lookup</li>
            <li>간이세액표 Excel 업로드</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "leaves",
    title: "연차",
    group: "인사",
    summary: "법정 연차 자동 산정 + 포상 연차 별도 원장 + 단일 승인.",
    content: (
      <>
        <Section title="자동 산정 규칙">
          <ul>
            <li>1년 미만 — 월 1일, 최대 11일</li>
            <li>12개월+ — 15일 일괄 + 매 2년 +1 (한도 25일)</li>
            <li>포상 연차 — FIFO 별도 원장에서 우선 소진</li>
            <li>연도 경계 신청 자동 분할</li>
          </ul>
        </Section>
        <Section title="기타">
          <p>반차(0.5) · 예비군/민방위 등 공가(잔여 무관). 지정 승인자/ADMIN 단일 승인. Slack DM 자동.</p>
        </Section>
        <Perm>본인 신청. 승인은 지정 승인자 또는 ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "approvals",
    title: "결재",
    group: "인사",
    summary: "11종 양식 (지출결의서/휴가/출장/물품구매/재택근무/야근/카드/SaaS구독/외주/인사/접대비).",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>rjsf 기반 동적 폼 (JSON Schema + UI Schema + Tailwind 한국식 결재서 2-열)</li>
            <li>전용 widget — money(콤마) / customerPicker / richText</li>
            <li>룰 엔진 — when 8 연산자 + 5 resolver (manager / rank_min_level / title_min_level / rank_in / title_in / specific_user)</li>
            <li>제출 시점 결재선 snapshot (매니저 변경 영향 X)</li>
            <li>워크플로 — DRAFT → SUBMITTED → IN_PROGRESS → APPROVED|REJECTED|CANCELLED</li>
          </ul>
        </Section>
        <Perm>전사. 양식 수정 ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "evaluations",
    title: "평가",
    group: "인사",
    summary: "반기 cycle (1H/2H). 자기 → 매니저 → HR calibration → FINALIZED 7단계.",
    content: (
      <>
        <Section title="워크플로 7단계">
          <p>NOT_STARTED → SELF_DRAFT → SELF_SUBMITTED → MGR_DRAFT → MGR_SUBMITTED → CALIBRATED → FINALIZED</p>
        </Section>
        <Section title="2축 평가">
          <ul>
            <li>목표 달성도 — cycle.year 의 PERSONAL goal 진행률 평균 (1.0~5.0)</li>
            <li>역량 (competency_dimensions, tenant 별 편집) — 1~5점, 기본 7종 시드</li>
          </ul>
        </Section>
        <Section title="알림">
          <p>cycle OPEN / 단계 진행 / FINALIZED 시 Slack/Mattermost DM. D-3 마감 임박 reminder cron.</p>
        </Section>
        <Perm>본인 self / 매니저 직속부하 / HR/ADMIN 전부.</Perm>
      </>
    ),
  },
  {
    key: "events",
    title: "이벤트",
    group: "인사",
    summary: "워크샵 / 컨퍼런스 / 출장 통합. 1건당 PDF.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>일정·장소(Kakao/Google Map 지도)</li>
            <li>비용 — 예산/소요금액/참가비/실비</li>
            <li>항공권 N건, 숙박 N건 (각 지도·전화·이메일)</li>
            <li>참석자(사내+게스트) · 첨부 N건 · 상세 계획 메모</li>
            <li>이벤트 1건 단위 PDF</li>
            <li>연도 필터는 overlap 방식 (연말~연초 이벤트 양쪽 노출)</li>
          </ul>
        </Section>
        <Perm>조회 전사 / CRUD ADMIN/HR/SUPER_ADMIN.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 근태
  {
    key: "worksites",
    title: "근무지",
    group: "근태",
    summary: "본사·클라이언트 사이트. GPS + 반경 + 직원 매핑(M:N).",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>위치(Kakao Map) + 반경 시각화</li>
            <li>업무 시작/종료 시간</li>
            <li>직원 매핑 (다중) + primary 지정</li>
            <li>프로젝트 연결</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "leave_types",
    title: "휴가 유형",
    group: "근태",
    summary: "연차/반차/예비군/민방위 등 휴가 유형 카탈로그.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>유형별 잔여 차감 여부 / 근무일 인정 여부</li>
            <li>색상 + 라벨 (캘린더 / 그리드에서 사용)</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "attendance.admin",
    title: "출퇴근 기록",
    group: "근태",
    summary: "일/주/월 통합 뷰. 시간축 Gantt + 9색 (외근/반차/연차/공가/결근/공휴일/주말).",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>진행중 일정은 사선 패턴 + 60초 라이브 갱신</li>
            <li>모바일 GPS 체크인 (Kakao Map 반경 시각화)</li>
            <li>색상 9 종 — 정상/외근/반차/연차/공가/결근/공휴일/주말</li>
          </ul>
        </Section>
        <Perm>전사. 본인 외 데이터는 HR/ADMIN.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 예산
  {
    key: "budget.calc",
    title: "예산",
    group: "예산",
    summary: "연도별 12개월 비목별 지출 예산. 작년 비교 + 도넛 차트.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>account_codes(EXPENSE) 비목별 라인, m1~m12 컬럼</li>
            <li>비목 카테고리별 자동 소계 + 총합</li>
            <li>"선택 행 12개월 채우기" — 매월 고정비 빠른 입력</li>
            <li>비목별 비중 도넛 (Highcharts)</li>
            <li>작년 비교 (카테고리별 차액·증감률)</li>
            <li>A3 가로 PDF</li>
          </ul>
        </Section>
        <Perm>ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "budget.rnd",
    title: "정부 R&D",
    group: "예산",
    summary: "정부 R&D 과제 예산서. 비목·세목·항목·단가 라인 + 인건비 인력.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>시드 JSON 으로 행 자동 생성</li>
            <li>기업규모(중소/중견/대기업) → 정부지원금/기관부담금/현금/현물 cascade</li>
            <li>인건비 인력 — 정규직 선택 시 직급·월급여·4대보험·퇴직금 자동</li>
            <li>산정 기준 패널 — 적용대상/공식/기준/예외/세부항목 노출</li>
            <li>A4 인쇄 미리보기 + 예산서 복제</li>
          </ul>
        </Section>
        <Perm>ADMIN/HR.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 관리
  {
    key: "catalog.products",
    title: "제품 카탈로그",
    group: "관리",
    summary: "vendors / products / product_versions 3 단계 마스터. lookup-or-create 자동.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>3 패널 master-detail (제조사 / 제품 / 버전)</li>
            <li>케이스·로그·라이센스 등록 시 자유 타이핑한 신규 항목이 자동 등록</li>
            <li>각 row 의 link(외부 URL) → ExternalLink 아이콘으로 열기</li>
          </ul>
        </Section>
        <Perm>catalog.manage (ADMIN).</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 마케팅
  {
    key: "marketing.dashboard",
    title: "마케팅 대시보드",
    group: "마케팅",
    summary: "캠페인 / 이메일 발송 / Google Ads 의 KPI 와 추이를 한 화면에 통합.",
    content: (
      <>
        <Section title="구성">
          <ul>
            <li>활성 캠페인 / 발송 수 / 오픈·클릭률 / 수신거부 KPI 카드</li>
            <li>월별 발송·오픈·클릭 추이 차트</li>
            <li>채널별 비교 (이메일 vs Google Ads)</li>
            <li>최근 발송·예약 캠페인 목록</li>
          </ul>
        </Section>
        <Perm>marketing.dashboard — MARKETING/SALES.</Perm>
      </>
    ),
  },
  {
    key: "marketing.campaigns",
    title: "캠페인",
    group: "마케팅",
    summary: "EMAIL / GOOGLE_ADS 채널 공통 베이스. 세그먼트 + 이메일 템플릿 + 예약 발송.",
    content: (
      <>
        <Section title="채널 분기">
          <ul>
            <li><b>EMAIL</b> — email_template_id, scheduled_at, from_address/name, reply_to</li>
            <li><b>GOOGLE_ADS</b> — ga_customer_id, ga_external_id, ga_campaign_type, ga_daily_budget</li>
          </ul>
        </Section>
        <Section title="상태 전환">
          <p>PLANNED → RUNNING → PAUSED / COMPLETED / ARCHIVED. 발송 트리거 시 send_started_at·send_finished_at 자동 기록.</p>
        </Section>
        <Section title="발송 흐름">
          <ol>
            <li>세그먼트 → 수신자 추출 (수신거부·고객 종류 필터)</li>
            <li>템플릿 머지필드 치환 ({"{{customer_name}}"} 등) + 트래킹 픽셀·수신거부 링크 부착</li>
            <li>본문 안 data URL 이미지는 cid: 로 자동 변환 (multipart/related)</li>
            <li>SMTP 발송, marketing_email_sends 에 row 별 상태 기록</li>
          </ol>
        </Section>
        <Perm>marketing.campaigns — MARKETING/SALES.</Perm>
      </>
    ),
  },
  {
    key: "marketing.emails",
    title: "이메일 발송",
    group: "마케팅",
    summary: "본문 입력 3가지 — HTML 직접 / 회의록 에디터(BlockNote) / URL 가져오기. cid 인라인 이미지 자산 관리.",
    content: (
      <>
        <Section title="템플릿 생성 흐름">
          <ol>
            <li>"새 템플릿" — 이름·설명만 입력 → 전용 편집 페이지로 이동 (외부 클릭으로 작업 분실 방지)</li>
            <li>편집 — 제목 / 머지필드 chip / 본문 입력 3-탭</li>
            <li>그리드의 이름 클릭 = 편집 페이지로 이동</li>
          </ol>
        </Section>
        <Section title="본문 입력 방식 (body_kind)">
          <ul>
            <li><b>HTML</b> — textarea 직접</li>
            <li><b>EDITOR</b> — BlockNote 에디터 (회의록과 동일). 저장 시 backend 가 typography CSS 를 inline 처리해 메일 클라이언트 호환</li>
            <li><b>IMPORT</b> — 외부 URL fetch → sanitize → premailer CSS 인라인 → HTML 탭으로</li>
          </ul>
        </Section>
        <Section title="자산 (cid 인라인 이미지)">
          <p>업로드 시 content_id 발급, 본문 <code>&lt;img src="cid:..."&gt;</code>. 발송 시 multipart/related 로 메일 자체에 임베드 (Gmail 102KB 본문 잘림 회피 + data URL 차단 환경 대응).</p>
        </Section>
        <Section title="머지필드">
          <p>{`{{customer_name}}`} / {`{{contact_name}}`} / {`{{contact_email}}`} / {`{{contact_title}}`} / {`{{customer_representative}}`} — 캠페인 발송 시 자동 치환.</p>
        </Section>
        <Section title="수신거부">
          <p>발송 시 푸터에 자동 부착. 별도 수신거부 탭에서 master 관리.</p>
        </Section>
        <Perm>marketing.emails — MARKETING.</Perm>
      </>
    ),
  },
  {
    key: "marketing.segments",
    title: "고객 세그먼트",
    group: "마케팅",
    summary: "캠페인 수신자 풀 정의 — 명시적 customer_ids + (옵션) contact_ids + include_kinds.",
    content: (
      <>
        <Section title="구조">
          <ul>
            <li><b>customer_ids</b> — 특정 고객사 명시. 빈 배열 = 전체 (include_kinds 필터만 적용)</li>
            <li><b>contact_ids</b> — 특정 contact 명시 (optional)</li>
            <li><b>include_kinds</b> — CUSTOMER / PARTNER 등 contact kind</li>
          </ul>
        </Section>
        <Section title="발송 시 동작">
          <p>resolve_recipients() 가 세그먼트 → (contact, customer) 페어 목록 추출. 수신거부 lower(email) 매칭으로 SKIPPED 처리.</p>
        </Section>
        <Perm>marketing.segments — MARKETING/SALES.</Perm>
      </>
    ),
  },
  {
    key: "marketing.google_ads",
    title: "Google Ads",
    group: "마케팅",
    summary: "Google Ads 캠페인 메트릭 동기화 — 외부 Ads 계정의 노출·클릭·비용을 끌어와 캠페인과 매칭.",
    content: (
      <>
        <Section title="동기화">
          <ul>
            <li>ga_customer_id + ga_external_id 로 외부 Google Ads 캠페인 식별</li>
            <li>주기적 cron — marketing_google_ads_metrics 에 일별 노출·클릭·비용 row 적재</li>
            <li>ga_last_synced_at 으로 마지막 동기 시각 추적</li>
          </ul>
        </Section>
        <Section title="대시보드">
          <p>marketing.dashboard 의 채널 비교에 이메일과 나란히 표시.</p>
        </Section>
        <Perm>marketing.google_ads — MARKETING/SALES.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 관리
  {
    key: "alarms",
    title: "알람",
    group: "관리",
    summary: "단발/매일/매주/매월/매년 Slack 알람. 영업일 시프트 + 발송 이력.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>유형 — 단발 / 매일 / 매주 / 매월 / 매년</li>
            <li>채널 + DM 다중 수신자</li>
            <li>영업일 시프트 (공휴일/주말 자동 회피)</li>
            <li>"즉시 테스트" + 발송 이력 7일</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "settings.bookmarks",
    title: "북마크",
    group: "관리",
    summary: "헤더 도구의 북마크 드로어에 노출될 항목 관리.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>그룹 + URL + 아이콘 (외부 / 내부 양쪽)</li>
            <li>tenant 단위 공유, 전사 화면에서 동일하게 보임</li>
          </ul>
        </Section>
        <Perm>HR/ADMIN.</Perm>
      </>
    ),
  },
  {
    key: "settings.accounts",
    title: "계정과목",
    group: "관리",
    summary: "account_codes 마스터. 예산/매입 인보이스/지출결의서에서 참조.",
    content: (
      <>
        <Section title="핵심 기능">
          <ul>
            <li>코드 + 라벨 + 카테고리(INCOME/EXPENSE/...) + 정렬</li>
            <li>비활성화 토글 (기존 데이터 보존)</li>
          </ul>
        </Section>
        <Perm>ADMIN/HR.</Perm>
      </>
    ),
  },
  {
    key: "settings",
    title: "설정",
    group: "관리",
    summary: "tenant 범위 전반 설정 — 회사 프로필, 외부 연동, 메뉴 권한, 양식, 정책.",
    content: (
      <>
        <Section title="주요 탭">
          <ul>
            <li>회사 프로필 — 로고 / 도장 / 직인 / 영문명</li>
            <li>4대보험 요율 이력 + 간이세액표</li>
            <li>메뉴 권한 — role × menu 매트릭스</li>
            <li>알림·스케줄 (Slack/Mattermost · Mail · 알람 cron)</li>
            <li>외부 연동 — Slack / Mail / Kakao Map / 바로빌</li>
            <li>사업공고 — 6개 source API 키</li>
            <li>결재 양식 — JSON Schema/UI Schema/Rules/Slots Monaco 편집</li>
            <li>주간보고 양식 + 직위·직책 + 평가 dimension</li>
            <li>고급 — 디렉터리 제외 리스트 등</li>
          </ul>
        </Section>
        <Perm>ADMIN/HR.</Perm>
      </>
    ),
  },
  // -------------------------------------------------------------------- 도움말
  {
    key: "help",
    title: "도움말",
    group: "도움말",
    summary: "이 페이지. 각 메뉴의 사용 방법 통합 안내.",
    content: (
      <>
        <Section title="이용 방법">
          <ul>
            <li>각 메뉴 페이지 상단 우측의 <b>? 아이콘</b> 을 누르면 해당 메뉴 도움말로 바로 이동.</li>
            <li>좌측 목차에서 그룹별로 모든 항목 탐색.</li>
            <li>전체 인덱스(<code>/help</code>) 는 그룹별 요약 카드 리스트.</li>
          </ul>
        </Section>
        <Section title="도움말 작성">
          <p>
            <code>frontend/lib/help-content.tsx</code> 의 <code>HELP_SECTIONS</code>{" "}
            배열에 항목 추가. <code>key</code> 는 메뉴 레지스트리의{" "}
            <code>key</code> 와 동일하게 유지.
          </p>
        </Section>
      </>
    ),
  },
];

/** 빠른 lookup 용 맵. DashboardHeader 가 menu_key 기반 조회에 사용. */
export const HELP_KEYS = new Set(HELP_SECTIONS.map((s) => s.key));
