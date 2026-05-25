"use client";

/**
 * 목표 페이지 도움말 다이얼로그.
 *
 * 페이지 우측 상단의 [도움말] 버튼이 열며, 목표 시스템의 사용법과 지표
 * 의미를 11개 섹션 (HTML <details>) 으로 풀어 설명한다. 처음 열면 모든
 * 섹션이 펼쳐진 상태(`open` 속성). 정적 콘텐츠 — props 는 open/onClose.
 *
 * 시각: 표를 최대한 활용 (Key → Value 매핑 가독성). 코드/공식은 monospace
 * 박스. 섹션 사이는 border-t 로 구획.
 */

import { Dialog } from "@/components/ui/Dialog";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function GoalsHelpDialog({ open, onClose }: Props) {
  return (
    <Dialog open={open} onClose={onClose} title="목표 도움말" width="max-w-4xl">
      <div className="text-sm leading-relaxed space-y-1">
        <Section title="1. 목표 시스템이란?">
          <p>
            1년 단위로 <b>목표를 등록 → 진행 → 점수·등급으로 평가</b> 하는 기능입니다.
            회사 전체 목표(OKR)와 개인 목표를 연결(cascade)할 수 있고, 자동
            점수 계산·매니저 평가·마감 알림까지 한 화면에서 관리합니다.
          </p>
          <ul className="list-disc pl-5 mt-1 text-[13px] text-muted-foreground space-y-0.5">
            <li>회사 목표는 관리자가 만들고, 개인 목표는 본인이 직접 작성.</li>
            <li>개인 목표 작성 시 회사 목표 하나를 부모로 연결하면 연결율 ↑.</li>
            <li>점수는 진행률·난이도·우선순위·분류 가중치로 자동 계산.</li>
          </ul>
        </Section>

        <Section title="2. 세 탭 사용법">
          <Table
            headers={["탭", "보이는 내용", "권한"]}
            rows={[
              ["내 목표", "본인이 등록한 개인 목표", "본인이 추가·수정·삭제"],
              ["회사 목표", "전사 회사 목표 (전 직원 동일하게 보임)", "전 직원 읽기, 관리자만 작성·수정"],
              ["팀 목표", "내가 매니저인 임직원들의 개인 목표", "읽기 전용"],
            ]}
          />
        </Section>

        <Section title="3. 목표 만들기">
          <p className="mb-1.5">
            우측 상단 [+ 새 목표] 버튼으로 작성. 입력 항목:
          </p>
          <Table
            headers={["입력", "필수", "설명"]}
            rows={[
              ["제목", "✓", "목표를 한 문장으로 요약"],
              ["분류", "✓", "사업 / 기술 / 운영 / 커리어 / 성장 / 기타"],
              ["우선순위", "✓", "상 · 중 · 하"],
              ["난이도", "✓", "일상 / 표준 / 도전 / 도약 — 점수 배율에 직접 반영"],
              ["마감일", "✓", "이 날짜를 넘기면 '지연' 으로 집계"],
              ["부모 목표", "선택", "회사 목표 하나를 부모로 연결 (cascade) — '회사 목표 연결률' 에 반영"],
              ["본문 / 첨부", "선택", "에디터, 드래그앤드롭 첨부 N개"],
              ["진행률 0–100%", "—", "수시 갱신. 100% → 완료(DONE) 전환 시 매니저에게 자동 알림"],
            ]}
          />
        </Section>

        <Section title="4. 점수 계산 방식">
          <p className="mb-2">
            한 목표의 <b>환산 점수</b> 와 <b>가중치</b> 를 구해, 모든 목표의
            가중평균이 종합 점수가 됩니다.
          </p>
          <pre className="bg-muted/40 rounded p-3 font-mono text-xs whitespace-pre-wrap mb-2">
{`환산 점수 = 진행률(%) × 난이도 배율
가중치    = 우선순위 가중치 × 분류 가중치
종합 점수 = Σ(환산 점수 × 가중치) ÷ Σ(가중치)`}
          </pre>
          <Table
            headers={["요소", "값"]}
            rows={[
              ["난이도 배율", "일상 ×0.8 · 표준 ×1.0 · 도전 ×1.5 · 도약 ×2.0"],
              ["우선순위 가중치", "상 3 · 중 2 · 하 1"],
              ["분류 가중치", "관리자가 Settings 의 '목표 기준값' 에서 설정"],
              ["만점 / 등급", "200점 만점 — S ≥ 120 / A ≥ 90 / B ≥ 70 / C ≥ 50 / D < 50"],
            ]}
          />
          <p className="text-[13px] text-muted-foreground mt-2">
            <b>기준 가중치 하한</b> — 관리자가 정한 '최소 등록 가중치' 보다
            적게 등록한 직원은 분모가 그 기준으로 강제 고정되어 점수가 비례 하향.
            적게 등록해서 점수가 부풀려지는 것을 막는 안전장치입니다 (해당되면
            카드에 "하한 적용됨" 이 표시).
          </p>
        </Section>

        <Section title="5. KPI 카드 (지표) 설명">
          <Table
            headers={["카드", "값", "이런 뜻"]}
            rows={[
              ["종합 점수", "환산 점수의 가중평균 (200점 만점)", "올해 내 전반적 성과 — 등급 (S/A/B/C/D) 으로 표시"],
              ["평균 진행률", "모든 목표 진행률(%)의 단순 평균", "100% 에 가까울수록 페이스 정상"],
              ["지연", "마감일이 오늘 이전인데 완료/중단 안 된 목표 수", "0 이 정상. 0 보다 크면 빨간색 강조"],
              ["완료", "완료(DONE) 목표 수 / 전체 목표 수", "도넛 — 완료 비율 시각화"],
              ["회사 목표 연결률", "부모(회사 목표) 가 지정된 내 목표 ÷ 전체", "100% 에 가까울수록 회사 방향성과 정렬됨"],
              ["나의 현재 위치", "전 직원 종합 점수 분포 + 내 위치(▲)", "8개 구간 히스토그램. 익명 (이름 없이 점수만)"],
            ]}
          />
        </Section>

        <Section title="6. 분포 표 (우선순위 / 분류 / 난이도)">
          <p className="mb-2 text-[13px] text-muted-foreground">
            카드 영역 아래에 3개 표가 나옵니다. 각 표는 <b>해당 그룹별로 환산
            점수·진행률·건수</b> 를 모아서 어디가 강하고 어디가 부족한지 한눈에
            보여줍니다. 건수 0 인 항목은 표에서 자동 숨김.
          </p>
          <Table
            headers={["표", "행 (그룹)", "값"]}
            rows={[
              ["우선순위별 평균 점수", "상 · 중 · 하", "가중치 / 건수 / 평균 점수"],
              ["분류별 평균 점수", "사업/기술/운영/커리어/성장/기타", "분류 가중치 / 건수 / 평균 점수"],
              ["난이도별 평균 진행률", "일상/표준/도전/도약", "배율 / 건수 / 평균 진행률"],
            ]}
          />
          <p className="text-[13px] text-muted-foreground mt-2">
            평균 점수가 50점 미만이면 amber 색으로, 평균 진행률이 30% 미만이면
            amber 로 강조됩니다 (위험 신호).
          </p>
        </Section>

        <Section title="7. 상태 흐름">
          <pre className="bg-muted/40 rounded p-3 font-mono text-xs whitespace-pre-wrap mb-2">
{`초안(DRAFT) ─ 제출 ─▶ 진행중(IN_PROGRESS) ─┬─ 진행률 100% ─▶ 완료(DONE)
                                          ├─ 위기(AT_RISK) ⇄ 진행중(IN_PROGRESS)
                                          └─ 중단 ─▶ 중단(DROPPED) (평가 대상 제외)`}
          </pre>
          <Table
            headers={["상태", "의미", "평가 포함"]}
            rows={[
              ["초안(DRAFT)", "아직 제출 전", "✓ (점수 0 으로 가산)"],
              ["진행중(IN_PROGRESS)", "진행 중", "✓"],
              ["위기(AT_RISK)", "본인 또는 매니저가 표시", "✓"],
              ["완료(DONE)", "진행률 100%", "✓ (만점 가산)"],
              ["중단(DROPPED)", "평가 대상에서 제외", "✗"],
            ]}
          />
        </Section>

        <Section title="8. 평가 (자기 평가 + 매니저 평가)">
          <p className="mb-2">
            자동 점수와 <b>별도로</b> 정성 평가 입력 가능. 본인 자기 평가와
            매니저 평가는 각각 0~150점 + 코멘트.
          </p>
          <Table
            headers={["주체", "입력 시점", "내용"]}
            rows={[
              ["본인", "마감 후", "자기 평가 점수 (0~150) + 코멘트"],
              ["직속 매니저", "본인 자기 평가 후", "매니저 평가 점수 (0~150) + 코멘트"],
            ]}
          />
          <p className="text-[13px] text-muted-foreground mt-2">
            자동 종합 점수와 자기·매니저 평가는 별개로 보존 — 평가 회의의 정성
            보완 자료로 활용합니다.
          </p>
        </Section>

        <Section title="9. 마감 알림 (자동)">
          <p className="mb-2">
            매일 09:10 (KST) 시스템이 미완료 목표를 점검해 Slack/Mattermost DM 으로 알림.
          </p>
          <Table
            headers={["알림", "조건", "수신자"]}
            rows={[
              ["D-30", "마감 30일 전 (1회)", "개인 목표 = 본인 + 직속 매니저 / 회사 목표 = 관리자"],
              ["OVERDUE", "마감일 다음 영업일 (1회)", "개인 목표 = 본인 + 직속 매니저 / 회사 목표 = 관리자"],
            ]}
          />
          <p className="text-[13px] text-muted-foreground mt-2">
            같은 목표·같은 종류의 알림은 한 번만 발송됩니다.
            완료(DONE) / 중단(DROPPED) 목표는 알림 대상 제외.
          </p>
        </Section>

        <Section title="10. 첨부 / 코멘트">
          <Table
            headers={["기능", "설명", "권한"]}
            rows={[
              ["첨부", "드래그앤드롭으로 N개 업로드, 이름 변경·삭제", "목표 작성·수정자"],
              ["코멘트", "에디터로 본문 작성 (이미지·표 등)", "본인 + 관리자만 편집·삭제"],
            ]}
          />
        </Section>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 보조 — 섹션 / 표 컴포넌트
// ---------------------------------------------------------------------------

// HTML <details> 기반 — 자바스크립트 토글 불필요. open 속성으로 기본 펼침.
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details
      open
      className="border-t border-border first:border-t-0 py-2 group"
    >
      <summary className="text-sm font-semibold cursor-pointer py-1 select-none">
        {title}
      </summary>
      <div className="mt-2 pl-1 pr-1">{children}</div>
    </details>
  );
}

// 단순한 key/value 테이블 — 헤더 머리글 1행 + body N행. 셀은 좌측 정렬.
function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: (string | React.ReactNode)[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] text-muted-foreground font-medium border-b border-border bg-muted/30">
            {headers.map((h, i) => (
              <th key={i} className="text-left py-1.5 px-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/40 last:border-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={
                    "py-1.5 px-2 align-top " +
                    (j === 0 ? "font-medium text-foreground" : "text-foreground/90")
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
