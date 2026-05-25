-- =============================================================================
-- Orbit Works — PostgreSQL 스키마
-- -----------------------------------------------------------------------------
-- 본 파일은 애플리케이션이 사용하는 모든 테이블/인덱스/제약을 정의합니다.
-- 빈 데이터베이스에 그대로 실행하면 전체 스키마가 생성되고, 기존 스키마가
-- 존재하면 상단의 DROP 구문이 순서대로 정리한 뒤 다시 만듭니다.
--
-- 사용 예
--   createdb orbit
--   psql -U orbit -d orbit -f db.sql
--
-- 주요 도메인
--   1) 사용자/인증              : users (admin 부트스트랩 · FK 호환용 proxy)
--   2) 고객사/연락처            : customers, license_contacts
--   3) 외환/HR 요율             : exchange_rates, hr_insurance_rates
--   4) 임직원/연봉/이력서       : developers (+ hashed_password · security_role),
--                                 developer_approvers, developer_*
--   5) 프로젝트/투입/견적       : projects, project_*, assignments
--   6) 라이센스/견적/첨부       : licenses, license_quote*, license_quotes
--   7) 영업기회                 : opportunities, opportunity_*
--   8) 발행자/견적·청구         : 발행자(=tenants), quotes·invoices (+ items/versions)
--   9) 게시판/공지              : board_posts (+ attachments)
--  10) 회의실 예약              : meeting_rooms, meeting_reservations (+ participants)
--  11) 연차 관리                : leave_balances, leave_accruals, leave_reward_grants,
--                                 leave_requests, leave_request_allocations,
--                                 leave_reset_history
--  12) 급여 · 원천세            : payroll_runs, payroll_items, developer_tax_profile,
--                                 withholding_tax_tables, withholding_tax_rows,
--                                 payroll_distributions
--  13) 공휴일                   : holidays
--  14) 권한 매트릭스 (2종)      : menu_permissions   — 사이드바 노출 + URL 가드
--                                 feature_permissions — 페이지 내 버튼·필드·탭 통제
--                                 (둘 다 tenant 별, ADMIN 자동 허용, 첫 GET 시 DEFAULT seed)
--  15) 회사 자산                : company_assets (DDA-YYYY-XXXX, QR 라벨 인쇄용)
--  16) 런타임 설정 override     : app_settings (config.yaml override JSONB)
--  17) 전자세금계산서           : tax_invoices (+ items, fetches). 바로빌 수집.
--  18) 클라우드 비용 수집       : cloud_costs (+ fetches), cloud_cost_alert_rules,
--                                 cloud_cost_alert_events. AWS Cost Explorer ·
--                                 Azure Cost Management · GCP BigQuery export.
--  19) 매입 인보이스            : vendor_bills (+ vendor_bill_attachments).
--                                 vendor 가 우리에게 발행한 청구서 (수동 입력).
--  20) 사업공고 수집            : announcements (+ sources, fetch_runs, bookmarks).
--                                 G2B / NTIS / IRIS / BizInfo / K-Startup.
--  21) 멀티 테넌트 인프라       : tenants, tenant_audits + 모든 도메인 테이블의
--                                 tenant_id 컬럼 / RLS 정책 (tenant_iso) /
--                                 fn_auto_tenant_id 트리거 (방어 layer).
--  22) 회의록 / 액션 아이템     : meeting_notes (BlockNote JSON + plain_text 캐시),
--                                 meeting_note_shares (1:N + read receipt),
--                                 meeting_note_attachments, meeting_note_action_items.
--                                 이메일/DM 발송 이력은 별도 테이블 미저장 (요청 사항).
--  23) 결재                     : approval_templates (form_schema/ui_schema/
--                                 approval_rules/attachment_slots), approval_requests
--                                 (snapshot 컬럼들로 진행중 결재 보호), approval_steps,
--                                 approval_history (감사 로그), approval_attachments.
--  24) 목표 (Goals)             : goals (3축 가중 점수, parent_goal_id cascade),
--                                 goal_due_alerts (UNIQUE dedup), goal_comments,
--                                 goal_attachments.
--  25) 이벤트                   : events (워크샵/컨퍼런스/출장 통합 — 항공·숙박·
--                                 참석자·예산 + 첨부).
--  26) 기술지원                 : support_cases (+ comments, attachments),
--                                 support_logs (활동 로그) + support_log_comments
--                                 (코멘트 = 지원 세션. duration_minutes/start_date/
--                                 end_date 가 부모 로그에 SUM/MIN/MAX 로 자동 집계).
--  27) 정부 R&D 예산            : rnd_budgets (+ lines, personnel),
--                                 rnd_cost_standard_seeds (시드 산정 기준).
--  28) 운영 예산 계획           : budget_calc_plans (+ lines).
--  29) 회사 차량/보험           : company_cars (+ attachments), company_insurances.
--  30) 제품 카탈로그            : vendors, products (+ long_name/description/
--                                 product_code/link), product_versions (+ description/
--                                 link). support_cases/support_logs/licenses 의
--                                 vendor_id/product_id/version_id FK 가 이 카탈로그를
--                                 참조. lookup-or-create 패턴으로 자유 타이핑 입력도
--                                 자동 등록.
-- =============================================================================

-- 안전한 기본 설정 (pg_dump 기본값 기준)
SET client_encoding        = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages    = warning;
SET row_security           = off;


-- -----------------------------------------------------------------------------
-- 확장 : UUID 기본값 생성을 위해 pgcrypto 를 사용
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- btree_gist: 회의 예약 EXCLUDE 제약에서 uuid(room_id) 와 tstzrange 를 함께 사용.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- =============================================================================
-- 기존 스키마 정리 (재실행 안전)
-- -----------------------------------------------------------------------------
-- 외래키 제약을 먼저 제거하고 (순환 참조를 깰 수 있도록), 이어서 테이블을
-- 자식 → 부모 순으로 DROP 합니다. 모두 IF EXISTS 이므로 빈 DB에서는 no-op.
-- =============================================================================

DROP TABLE IF EXISTS public.alarm_sends                  CASCADE;
DROP TABLE IF EXISTS public.alarms                       CASCADE;
DROP TABLE IF EXISTS public.leave_types                  CASCADE;
DROP TABLE IF EXISTS public.evaluation_competency_scores CASCADE;
DROP TABLE IF EXISTS public.evaluations                  CASCADE;
DROP TABLE IF EXISTS public.competency_dimensions        CASCADE;
DROP TABLE IF EXISTS public.evaluation_cycles            CASCADE;
DROP TABLE IF EXISTS public.weekly_report_comments       CASCADE;
DROP TABLE IF EXISTS public.weekly_report_attachments    CASCADE;
DROP TABLE IF EXISTS public.weekly_reports               CASCADE;
DROP TABLE IF EXISTS public.weekly_report_assignments    CASCADE;
DROP TABLE IF EXISTS public.weekly_report_templates      CASCADE;
DROP TABLE IF EXISTS public.trip_events                  CASCADE;
DROP TABLE IF EXISTS public.trips                        CASCADE;
DROP TABLE IF EXISTS public.books                        CASCADE;
DROP TABLE IF EXISTS public.loan_attachments             CASCADE;
DROP TABLE IF EXISTS public.loans                        CASCADE;
DROP TABLE IF EXISTS public.bank_accounts                CASCADE;
DROP TABLE IF EXISTS public.worksite_projects            CASCADE;
DROP TABLE IF EXISTS public.worksite_assignments         CASCADE;
DROP TABLE IF EXISTS public.worksites                    CASCADE;

DROP TABLE IF EXISTS public.announcement_bookmarks       CASCADE;
DROP TABLE IF EXISTS public.announcement_fetch_runs      CASCADE;
DROP TABLE IF EXISTS public.announcements                CASCADE;
DROP TABLE IF EXISTS public.announcement_sources         CASCADE;

DROP TABLE IF EXISTS public.tax_invoice_items            CASCADE;
DROP TABLE IF EXISTS public.tax_invoice_fetches          CASCADE;
DROP TABLE IF EXISTS public.tax_invoices                 CASCADE;
DROP TABLE IF EXISTS public.event_attachments            CASCADE;
DROP TABLE IF EXISTS public.event_participants           CASCADE;
DROP TABLE IF EXISTS public.event_lodgings               CASCADE;
DROP TABLE IF EXISTS public.event_flights                CASCADE;
DROP TABLE IF EXISTS public.events                       CASCADE;

DROP TABLE IF EXISTS public.kb_entry_attachments         CASCADE;
DROP TABLE IF EXISTS public.kb_entries                   CASCADE;
DROP TABLE IF EXISTS public.support_log_attachments      CASCADE;
DROP TABLE IF EXISTS public.support_log_comments         CASCADE;
DROP TABLE IF EXISTS public.support_log_products         CASCADE;
DROP TABLE IF EXISTS public.support_logs                 CASCADE;
DROP TABLE IF EXISTS public.support_case_attachments     CASCADE;
DROP TABLE IF EXISTS public.support_case_comments        CASCADE;
DROP TABLE IF EXISTS public.support_case_counters        CASCADE;
DROP TABLE IF EXISTS public.support_case_products        CASCADE;
DROP TABLE IF EXISTS public.support_cases                CASCADE;
DROP TABLE IF EXISTS public.product_versions             CASCADE;
DROP TABLE IF EXISTS public.products                     CASCADE;
DROP TABLE IF EXISTS public.vendors                      CASCADE;
DROP TABLE IF EXISTS public.vendor_bill_attachments      CASCADE;
DROP TABLE IF EXISTS public.vendor_bills                 CASCADE;
DROP TABLE IF EXISTS public.cloud_cost_alert_events      CASCADE;
DROP TABLE IF EXISTS public.cloud_cost_alert_rules       CASCADE;
DROP TABLE IF EXISTS public.cloud_cost_fetches           CASCADE;
DROP TABLE IF EXISTS public.cloud_costs                  CASCADE;
DROP TABLE IF EXISTS public.app_settings                 CASCADE;
DROP TABLE IF EXISTS public.company_assets               CASCADE;
DROP TABLE IF EXISTS public.company_car_attachments      CASCADE;
DROP TABLE IF EXISTS public.company_cars                 CASCADE;
DROP TABLE IF EXISTS public.company_insurance_attachments CASCADE;
DROP TABLE IF EXISTS public.company_insurances           CASCADE;
DROP TABLE IF EXISTS public.menu_permissions             CASCADE;
DROP TABLE IF EXISTS public.feature_permissions          CASCADE;
DROP TABLE IF EXISTS public.user_feature_grants          CASCADE;

DROP TABLE IF EXISTS public.leave_reset_history          CASCADE;
DROP TABLE IF EXISTS public.leave_request_allocations    CASCADE;
DROP TABLE IF EXISTS public.leave_requests               CASCADE;
DROP TABLE IF EXISTS public.leave_reward_grants          CASCADE;
DROP TABLE IF EXISTS public.leave_accruals               CASCADE;
DROP TABLE IF EXISTS public.leave_balances               CASCADE;

DROP TABLE IF EXISTS public.payroll_distributions        CASCADE;
DROP TABLE IF EXISTS public.withholding_tax_rows         CASCADE;
DROP TABLE IF EXISTS public.withholding_tax_tables       CASCADE;
DROP TABLE IF EXISTS public.developer_tax_profile        CASCADE;
DROP TABLE IF EXISTS public.payroll_items                CASCADE;
DROP TABLE IF EXISTS public.payroll_runs                 CASCADE;

DROP TABLE IF EXISTS public.bookmarks                    CASCADE;

DROP TABLE IF EXISTS public.board_comments               CASCADE;
DROP TABLE IF EXISTS public.board_attachments            CASCADE;
DROP TABLE IF EXISTS public.board_posts                  CASCADE;

DROP TABLE IF EXISTS public.holiday_alarm_recipients     CASCADE;
DROP TABLE IF EXISTS public.holidays                     CASCADE;

DROP TABLE IF EXISTS public.invoice_versions             CASCADE;
DROP TABLE IF EXISTS public.invoice_items                CASCADE;
DROP TABLE IF EXISTS public.invoices                     CASCADE;
DROP TABLE IF EXISTS public.quote_versions               CASCADE;
DROP TABLE IF EXISTS public.quote_items                  CASCADE;
DROP TABLE IF EXISTS public.quotes                       CASCADE;

DROP TABLE IF EXISTS public.opportunity_activities       CASCADE;
DROP TABLE IF EXISTS public.opportunity_attachments      CASCADE;
DROP TABLE IF EXISTS public.opportunity_stage_history    CASCADE;
DROP TABLE IF EXISTS public.opportunities                CASCADE;

DROP TABLE IF EXISTS public.license_quote_items          CASCADE;
DROP TABLE IF EXISTS public.license_quotes               CASCADE;
DROP TABLE IF EXISTS public.licenses                     CASCADE;
DROP TABLE IF EXISTS public.license_contacts             CASCADE;

DROP TABLE IF EXISTS public.project_procurements         CASCADE;
DROP TABLE IF EXISTS public.assignments                  CASCADE;
DROP TABLE IF EXISTS public.project_estimate_items       CASCADE;
DROP TABLE IF EXISTS public.project_comments             CASCADE;
DROP TABLE IF EXISTS public.project_attachments          CASCADE;
DROP TABLE IF EXISTS public.project_quotes               CASCADE;
DROP TABLE IF EXISTS public.projects                     CASCADE;

DROP TABLE IF EXISTS public.meeting_reservation_participants CASCADE;
DROP TABLE IF EXISTS public.meeting_reservations         CASCADE;
DROP TABLE IF EXISTS public.meeting_rooms                CASCADE;

DROP TABLE IF EXISTS public.meeting_note_action_items    CASCADE;
DROP TABLE IF EXISTS public.meeting_note_attachments     CASCADE;
DROP TABLE IF EXISTS public.meeting_note_shares          CASCADE;
DROP TABLE IF EXISTS public.meeting_notes                CASCADE;

DROP TABLE IF EXISTS public.account_codes                CASCADE;

DROP TABLE IF EXISTS public.budget_calc_lines            CASCADE;
DROP TABLE IF EXISTS public.budget_calc_plans            CASCADE;

DROP TABLE IF EXISTS public.rnd_budget_personnel         CASCADE;
DROP TABLE IF EXISTS public.rnd_budget_lines             CASCADE;
DROP TABLE IF EXISTS public.rnd_budget_plans             CASCADE;

DROP TABLE IF EXISTS public.developer_approvers          CASCADE;
DROP TABLE IF EXISTS public.developer_research_grants    CASCADE;
DROP TABLE IF EXISTS public.developer_salaries           CASCADE;
DROP TABLE IF EXISTS public.developer_passports          CASCADE;
DROP TABLE IF EXISTS public.developer_emergency_contacts CASCADE;
DROP TABLE IF EXISTS public.developer_interviews         CASCADE;
DROP TABLE IF EXISTS public.developer_resumes            CASCADE;
DROP TABLE IF EXISTS public.developer_experiences        CASCADE;
DROP TABLE IF EXISTS public.developer_certifications     CASCADE;
DROP TABLE IF EXISTS public.developer_profiles           CASCADE;
DROP TABLE IF EXISTS public.developers                   CASCADE;

DROP TABLE IF EXISTS public.hr_insurance_rates           CASCADE;
DROP TABLE IF EXISTS public.stock_prices                 CASCADE;
DROP TABLE IF EXISTS public.interest_rates               CASCADE;
DROP TABLE IF EXISTS public.exchange_rates               CASCADE;

DROP TABLE IF EXISTS public.customer_interaction_attachments CASCADE;
DROP TABLE IF EXISTS public.customer_interactions        CASCADE;
DROP TABLE IF EXISTS public.customer_contacts            CASCADE;
DROP TABLE IF EXISTS public.customers                    CASCADE;
DROP TABLE IF EXISTS public.users                        CASCADE;
DROP TABLE IF EXISTS public.tenants                      CASCADE;


-- =============================================================================
-- 1) 사용자 / 인증
-- =============================================================================

-- 시스템 로그인 계정.
--
-- 실제 임직원 로그인 정보(비밀번호/권한)는 `developers` 테이블이 권위를 갖는다.
-- 이 테이블은 다음 두 가지 역할만 수행한다:
--   1) 부트스트랩 관리자 계정 (`email = 'admin'`) — 최초 설치 직후 한 명의
--      임직원을 지정(`mapped_developer_id`)해 시스템 ADMIN 역할을 이양.
--   2) 여타 도메인 테이블(FK `users.id`) 호환용 세션 프록시 — 임직원이 로그인하면
--      `developers.company_email` 과 동일한 email 의 users 행을 자동 생성/동기화.
--      이 proxy 행의 `hashed_password` 는 항상 빈 문자열(`''`) 로 유지되어
--      인증 경로에서 사용되지 않는다.
--
-- 멀티 테넌트(다중 회사) 단위. 이메일 도메인으로 사용자→tenant 매핑.
-- SUPER_ADMIN 만 CRUD. 회사 프로필(사업자번호·대표자·주소 등) 메타데이터를 함께 보관.
CREATE TABLE public.tenants (
    id                  uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                varchar(60)             NOT NULL,                       -- 시스템 식별자 (영숫자+하이픈)
    name                varchar(200)            NOT NULL,                       -- 화면 표시 이름
    domains             varchar(120)[]          NOT NULL DEFAULT '{}',          -- 이메일 도메인(들). app 단에서 충돌 검증
    is_active           boolean                 NOT NULL DEFAULT true,
    -- 회사 프로필 (한글)
    business_no         varchar(20),
    representative      varchar(100),
    address             text,
    phone               varchar(50),
    fax                 varchar(50),
    contact_email       varchar(200),
    -- 회사 프로필 (영문)
    name_en             varchar(200),
    representative_en   varchar(100),
    address_en          text,
    -- 견적·청구 발번 prefix.
    number_prefix       varchar(12)             NOT NULL DEFAULT 'DD',
    created_at          timestamptz             NOT NULL DEFAULT now(),
    updated_at          timestamptz             NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_tenants_slug ON public.tenants (slug);


-- 역할(role) 값은 6단계 — SUPER_ADMIN | ADMIN | SALES | HR | SUPPORT | ETC.
-- SUPER_ADMIN 은 멀티 테넌트 운영자 (tenant 관리만 가능, 도메인 데이터 비노출).
-- ADMIN 은 한 tenant 내의 모든 권한의 superset.
CREATE TABLE public.users (
    id                  uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    email               varchar(200)            NOT NULL,                       -- 로그인 ID 겸 이메일
    hashed_password     varchar(255)            NOT NULL,
    name                varchar(100)            NOT NULL DEFAULT '',
    role                varchar(20)             NOT NULL DEFAULT 'ETC',         -- SUPER_ADMIN | ADMIN | SALES | HR | SUPPORT | ETC
    is_active           boolean                 NOT NULL DEFAULT true,
    memo                text,
    memo_updated_at     timestamptz,
    last_notice_seen_at timestamptz,
    mapped_developer_id uuid,
    -- 멀티 테넌트. SUPER_ADMIN 은 NULL. Stage 2 에서 NOT NULL 로 전환 예정.
    tenant_id           uuid                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
    created_at          timestamptz             NOT NULL DEFAULT now(),
    updated_at          timestamptz             NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_users_email ON public.users (email);
CREATE INDEX ix_users_mapped_developer ON public.users (mapped_developer_id);
CREATE INDEX ix_users_tenant ON public.users (tenant_id);


-- =============================================================================
-- 2) 고객사 / 연락처
-- =============================================================================

-- 고객사 및 협력사. 라이센스 · 프로젝트 · 영업기회에서 공유.
CREATE TABLE public.customers (
    id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  varchar(200)   NOT NULL,                              -- 고객사 명 (UNIQUE)
    representative        varchar(100),                                         -- 대표자
    business_no           varchar(20),                                          -- 사업자등록번호
    address               text,
    memo                  text,
    -- 사업자등록증 첨부 (파일은 data/customers/<id>/ 아래 저장)
    business_license_name varchar(255),
    business_license_path varchar(1024),
    business_license_mime varchar(120),
    business_license_size integer,
    -- 통장 사본 첨부
    bank_account_name     varchar(255),
    bank_account_path     varchar(1024),
    bank_account_mime     varchar(120),
    bank_account_size     integer,
    -- 해외 법인 여부 — USD 청구 시 영세율(0%) 기본 적용
    is_overseas           boolean        NOT NULL DEFAULT false,
    -- Account Owner — 회사를 책임지는 우리 측 직원. 퇴사·삭제로 회사 row 가
    -- 사라지면 안 되므로 SET NULL.
    owner_id              uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    created_at            timestamptz    NOT NULL DEFAULT now(),
    updated_at            timestamptz    NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_customers_name     ON public.customers (name);
CREATE INDEX        ix_customers_owner_id ON public.customers (owner_id);


-- 고객사별 라이센스 담당자. 고객사 하나당 보통 1명만 사용.
CREATE TABLE public.license_contacts (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid          NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    name        varchar(100)  NOT NULL,
    phone       varchar(50),
    email       varchar(200),
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);


-- 외부 주소록 (/contacts 의 "고객" · "협력사" 탭). kind 로 구분.
-- 회사 식별은 customer_id FK 로만 — 자유 문자열 회사명은 받지 않는다.
-- 회사 미배정(개인 담당자)은 customer_id NULL 로 표현.
-- 회사 삭제 시 SET NULL — 담당자 정보는 보존.
CREATE TABLE public.customer_contacts (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         varchar(20)   NOT NULL DEFAULT 'CUSTOMER',        -- CUSTOMER | PARTNER
    name         varchar(100)  NOT NULL,
    customer_id  uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    title        varchar(100),                                     -- 직함/부서 ("차장", "영업본부" 등)
    phone        varchar(50),
    mobile       varchar(50),
    email        varchar(200),
    memo         text,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_customer_contacts_kind        ON public.customer_contacts (kind);
CREATE INDEX ix_customer_contacts_name        ON public.customer_contacts (name);
CREATE INDEX ix_customer_contacts_customer_id ON public.customer_contacts (customer_id);
-- 같은 회사에 동일 이메일 중복 입력 방어. NULL 들은 부분 인덱스로 허용.
CREATE UNIQUE INDEX uq_contact_company_email
    ON public.customer_contacts (customer_id, email)
    WHERE customer_id IS NOT NULL AND email IS NOT NULL;


-- 회사 단위 인터랙션 로그 (통화·미팅·이메일·기타). 자유 노트 + 첨부 1:N.
-- 영업기회(Opportunity) 와 무관한 일반 미팅·통화도 같이 모인다.
CREATE TABLE public.customer_interactions (
    id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id   uuid           NOT NULL REFERENCES public.customers(id)  ON DELETE CASCADE,
    type          varchar(20)    NOT NULL DEFAULT 'OTHER',          -- CALL | MEETING | EMAIL | OTHER
    occurred_at   timestamptz    NOT NULL,                          -- 활동 실제 일시
    author_id     uuid           REFERENCES public.developers(id)    ON DELETE SET NULL,
    title         varchar(200)   NOT NULL,
    body          text,                                              -- markdown 허용 자유 노트
    participants  text,                                              -- 동석자 자유 텍스트
    follow_up_at  date,                                              -- 후속 조치 일자(선택)
    created_at    timestamptz    NOT NULL DEFAULT now(),
    updated_at    timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_customer_interactions_customer ON public.customer_interactions (customer_id, occurred_at DESC);
CREATE INDEX ix_customer_interactions_author   ON public.customer_interactions (author_id);
CREATE INDEX ix_customer_interactions_followup ON public.customer_interactions (follow_up_at) WHERE follow_up_at IS NOT NULL;


-- 인터랙션 첨부. 디스크는 data/customers/{cid}/interactions/{iid}/<uuid>.<ext>.
CREATE TABLE public.customer_interaction_attachments (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    interaction_id  uuid          NOT NULL REFERENCES public.customer_interactions(id) ON DELETE CASCADE,
    file_name       varchar(300)  NOT NULL,
    file_path       varchar(1024) NOT NULL,
    mime_type       varchar(120),
    size            bigint,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_customer_interaction_attachments_interaction
    ON public.customer_interaction_attachments (interaction_id);


-- =============================================================================
-- 3) 외환 / HR 요율
-- =============================================================================

-- 일자별 환율. (base, target, date) 복합 PK. KRW↔USD 기준으로 사용.
CREATE TABLE public.exchange_rates (
    date       date           NOT NULL,
    base       varchar(3)     NOT NULL DEFAULT 'USD',
    target     varchar(3)     NOT NULL DEFAULT 'KRW',
    rate       numeric(12, 4) NOT NULL,
    created_at timestamptz    NOT NULL DEFAULT now(),
    updated_at timestamptz    NOT NULL DEFAULT now(),
    PRIMARY KEY (date, base, target)
);


-- ECOS(한국은행) 에서 수집한 국내 금리 시계열. series_code 는 Orbit Works 내부 명명
-- (BASE_RATE, CD_91, TB_3Y 등). 외부 ECOS stat_code+item_code 매핑은
-- backend/app/services/interest.py 의 SERIES 카탈로그에서 관리.
CREATE TABLE public.interest_rates (
    date        date          NOT NULL,
    series_code varchar(32)   NOT NULL,
    rate        numeric(8, 4) NOT NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (date, series_code)
);


-- 주가지수 일별 종가. 한국은 ECOS(802Y001), 미국은 FRED(SP500/NASDAQCOM/DJIA)
-- 에서 수집. series_code 는 Orbit Works 내부 식별자 (KOSPI, KOSDAQ, SP500, ...),
-- 매핑은 backend/app/services/stock.py SERIES 카탈로그에서 관리.
CREATE TABLE public.stock_prices (
    date        date           NOT NULL,
    series_code varchar(32)    NOT NULL,
    close       numeric(14, 4) NOT NULL,
    created_at  timestamptz    NOT NULL DEFAULT now(),
    updated_at  timestamptz    NOT NULL DEFAULT now(),
    PRIMARY KEY (date, series_code)
);


-- 4대보험 요율 이력. effective_from 기준으로 해당 시점에 적용된 행을 조회.
CREATE TABLE public.hr_insurance_rates (
    id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    effective_from                date          NOT NULL,                       -- 적용 시작일
    year                          integer       NOT NULL,                       -- 편의 조회용 연도
    national_pension_rate         numeric(6, 4) NOT NULL,                       -- 국민연금 요율 (사업주)
    national_pension_ceiling      integer       NOT NULL,                       -- 기준소득월액 상한
    national_pension_floor        integer,                                      -- 기준소득월액 하한
    health_rate                   numeric(6, 4) NOT NULL,                       -- 건강보험 요율
    long_term_care_rate_on_health numeric(6, 4) NOT NULL,                       -- 장기요양 (건강보험료 × %)
    employment_unemployment_rate  numeric(6, 4) NOT NULL,                       -- 고용보험 실업급여
    employment_stability_rate     numeric(6, 4) NOT NULL,                       -- 고용안정/직업능력
    industrial_accident_rate      numeric(6, 4) NOT NULL,                       -- 산재보험
    company_size_tier             varchar(30),                                  -- 기업규모 구간 표시용
    industry_note                 text,
    updated_by                    uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at                    timestamptz   NOT NULL DEFAULT now(),
    updated_at                    timestamptz   NOT NULL DEFAULT now()
);


-- =============================================================================
-- 4) 임직원 (정규직 / 프리랜서 / 자사화)
-- =============================================================================

-- 임직원 기본 정보. 고용형태에 따라 연봉 / 단가 입력 항목이 달라짐.
--
-- 비밀번호/보안등급은 임직원 테이블이 권위를 가진다:
--   - hashed_password : bcrypt 해시. 신규 등록 시 주민번호 앞 6자리(생년월일) 기반
--                        으로 자동 생성되며, 첫 로그인 후 강제 변경 흐름이 있음.
--   - security_role    : 5단계 권한 매트릭스 (app/core/roles.py).
CREATE TABLE public.developers (
    id                      uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    varchar(100)   NOT NULL,
    tag                     varchar(8),                                         -- 동명이인 식별 뱃지 A/B/C... (서버 자동 관리)
    employee_no             varchar(8),                                         -- 사번 (정규직만, 5자리 zero-padded "00001"~). 한 번 부여되면 영구.
    employment_type         varchar(20)    NOT NULL,                            -- FULL_TIME | FREELANCER | INSOURCED
    status                  varchar(20)    NOT NULL DEFAULT 'ACTIVE',           -- ACTIVE | INACTIVE
    title                   varchar(100),                                       -- 직급
    phone                   varchar(50),
    address                 varchar(500),
    personal_email          varchar(200),
    company_email           varchar(200),
    tax_invoice_email       varchar(200),                                       -- 세금계산서 수신용
    resident_number         varchar(14),                                        -- 주민등록번호 "XXXXXX-XXXXXXX"
    payment_method          varchar(20)    NOT NULL DEFAULT 'PAYROLL',          -- PAYROLL | TAX_INVOICE | HOURLY (시간당)
    business_no             varchar(50),                                        -- 프리랜서/세금계산서의 경우
    business_address        varchar(500),
    salary                  numeric(14, 2),                                     -- 프리랜서의 연봉(또는 계약 금액)
    hourly_rate             numeric(10, 2),                                     -- 시간당 금액 (payment_method = HOURLY)
    roles                   varchar(30)[],                                      -- 역할 태그 (배열)
    skills                  varchar(50)[],                                      -- 기술 태그 (배열)
    hire_date               date,
    career_months_at_hire   integer,                                            -- 입사 시점의 타사 경력 개월
    resigned_date           date,
    resignation_reason      text,
    -- 비상연락망 (임직원 본인이 모바일 프로필에서 편집)
    emergency_contact_name  varchar(100),
    emergency_contact_phone varchar(50),
    -- 인증 관련 — company_email + hashed_password 로 직접 로그인.
    hashed_password         varchar(255),                                       -- bcrypt 해시. NULL 이면 주민번호 폴백 허용.
    security_role           varchar(16)    NOT NULL DEFAULT 'ETC',              -- ADMIN | SALES | HR | SUPPORT | ETC
    password_reset_required boolean        NOT NULL DEFAULT false,              -- 관리자 재설정 → 첫 로그인 시 변경 강제
    memo                    text,
    color                   varchar(7),                                         -- Gantt 등 UI 색상
    -- 1차 결재자(상위 관리자) — self-FK. 결재 모듈이 휴가·출장·경비 신청의 첫 승인자로 사용.
    -- HR/ADMIN 만 변경 가능. 자기 자신·하위 트리 사이클은 앱에서 검증 (깊이 10 제한).
    -- ON DELETE SET NULL — 매니저 삭제 시 하위 자동 분리.
    manager_id              uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    -- 직위(Rank) / 직책(Position) — 결재선 라우팅. 마스터 테이블이 뒤에 정의되어
    -- ALTER 로 FK 추가됨.
    rank_id                 uuid,
    position_id             uuid,
    created_at              timestamptz    NOT NULL DEFAULT now(),
    updated_at              timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_developers_name  ON public.developers (name);
CREATE INDEX ix_developers_email ON public.developers (company_email);
CREATE INDEX ix_developers_employee_no ON public.developers (employee_no) WHERE employee_no IS NOT NULL;
CREATE INDEX ix_developers_manager_id   ON public.developers (manager_id);
CREATE INDEX ix_developers_rank_id      ON public.developers (rank_id);
CREATE INDEX ix_developers_position_id  ON public.developers (position_id);

-- 직위(Rank) — 모든 임직원이 1개씩 보유. 결재선의 기본 hierarchy.
-- level 이 높을수록 상위. NUMERIC(8,2) 로 사이 무제한 삽입 (예: 250.5).
CREATE TABLE public.job_ranks (
    id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid           NOT NULL,
    name        varchar(50)    NOT NULL,                       -- "선임연구원", "이사", ...
    level       numeric(8, 2)  NOT NULL,
    description text,
    is_active   boolean        NOT NULL DEFAULT true,
    sort_order  integer        NOT NULL DEFAULT 0,
    -- 진급 기준 연차 — 「직위별 총 경력 분포」 차트의 가이드 라인. NULL = 미표시.
    years       integer,
    created_at  timestamptz    NOT NULL DEFAULT now(),
    updated_at  timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_job_ranks_tenant_name UNIQUE (tenant_id, name)
);
CREATE INDEX ix_job_ranks_name  ON public.job_ranks (name);
CREATE INDEX ix_job_ranks_level ON public.job_ranks (level);

-- 직책(Position) — 선택적 job role. 임직원이 가질 수도, 없을 수도 있음.
CREATE TABLE public.job_positions (
    id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid           NOT NULL,
    name        varchar(50)    NOT NULL,                       -- "팀장", "본부장", "CEO", ...
    level       numeric(8, 2)  NOT NULL,
    description text,
    is_active   boolean        NOT NULL DEFAULT true,
    sort_order  integer        NOT NULL DEFAULT 0,
    -- 연차 — 직위와 동일 컬럼 (스키마 통일). 현재 차트 미사용, metadata 보유용.
    years       integer,
    created_at  timestamptz    NOT NULL DEFAULT now(),
    updated_at  timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_job_positions_tenant_name UNIQUE (tenant_id, name)
);
CREATE INDEX ix_job_positions_name  ON public.job_positions (name);
CREATE INDEX ix_job_positions_level ON public.job_positions (level);

ALTER TABLE public.developers
    ADD CONSTRAINT fk_developers_rank
    FOREIGN KEY (rank_id) REFERENCES public.job_ranks(id) ON DELETE SET NULL;
ALTER TABLE public.developers
    ADD CONSTRAINT fk_developers_position
    FOREIGN KEY (position_id) REFERENCES public.job_positions(id) ON DELETE SET NULL;

-- 직위(Rank) 시드 — 모든 ACTIVE tenant 에 10단계 (sparse 100 단위).
-- 신규 tenant 추가 시 동일 시드를 services/tenant_seed.py 가 자동 적용.
INSERT INTO public.job_ranks (tenant_id, name, level, sort_order, is_active)
SELECT t.id, v.name, v.level, v.so, true
FROM public.tenants t
CROSS JOIN (VALUES
  ('연구원',         100,  1),
  ('주임연구원',     200,  2),
  ('선임연구원',     300,  3),
  ('책임연구원',     400,  4),
  ('수석연구원',     500,  5),
  ('이사',           600,  6),
  ('상무이사',       700,  7),
  ('전무이사',       800,  8),
  ('부대표',         900,  9),
  ('대표이사',      1000, 10)
) AS v(name, level, so)
ON CONFLICT (tenant_id, name) DO NOTHING;

-- 직책(Position) 시드 — 12개 (전문위원 650 포함).
INSERT INTO public.job_positions (tenant_id, name, level, sort_order, is_active)
SELECT t.id, v.name, v.level, v.so, true
FROM public.tenants t
CROSS JOIN (VALUES
  ('파트장',     100,  1),
  ('팀장',       200,  2),
  ('실장',       300,  3),
  ('본부장',     400,  4),
  ('사업부장',   500,  5),
  ('연구소장',   600,  6),
  ('전문위원',   650,  7),
  ('사업총괄',   700,  8),
  ('CIO',        800,  9),
  ('CDO',        850, 10),
  ('CFO',        900, 11),
  ('CEO',       1000, 12)
) AS v(name, level, so)
ON CONFLICT (tenant_id, name) DO NOTHING;


-- ===========================================================================
-- 결재(Approval) 시스템 — 5 테이블.
--
-- 결재 종류(kind) 는 시드 JSON (backend/app/data/approval_templates_seed.json)
-- 에 정의된 13종:
--   EXPENSE / LEAVE / BUSINESS_TRIP / PURCHASE / REMOTE_WORK / OVERTIME /
--   CARD_USAGE / SUBSCRIPTION / OUTSOURCING / PERSONNEL / BIZ_HOSPITALITY (접대비) /
--   POC (PoC 수행) / ETC (기타 — 자유 형식)
--
-- ─ 변경 영향 격리 ─
-- template 의 form_schema / ui_schema / approval_rules / attachment_slots 가
-- 변경되면 version 이 +1 되며, 진행중 요청은 자체 snapshot (form_schema_snapshot
-- 등) 으로 옛 정의를 보존. 결재선 평가도 이미 체결된 step row 의 approver_id 를
-- 그대로 사용하므로 매니저 이동·퇴사가 진행중 결재에 영향 X.
--
-- ─ 결재선 평가 ─
-- backend/app/services/approval_engine.py 가 approval_rules.rules 의 when 조건
-- (8 연산자: eq/ne/lt/lte/gt/gte/in/nin, AND only) 을 form_data 와 매칭해
-- first-match-wins 으로 1개 룰을 선택하고, 그 룰의 approvers 배열 (5종 타입:
-- manager / rank_min_level / title_min_level / rank_in / title_in /
-- specific_user) 을 신청자의 매니저 chain 에 따라 순차 평가해 ApprovalStep
-- snapshot 을 생성. 매니저 chain 은 developers.manager_id 재귀 (최대 10단계).
--
-- ─ 첨부 슬롯 ─
-- attachment_slots JSONB 에 정의된 slug 별로 ApprovalAttachment.slot 컬럼이
-- 매핑. 매 단계 승인 + 제출 시점에 required 슬롯의 min_count 미달이면 400.
-- 슬롯 외 자유 첨부 (slot=NULL) 도 허용. 결재자(non-requester, non-HR/ADMIN)
-- 는 첨부 추가 불가.
-- ===========================================================================

-- 결재 양식 마스터. (tenant, kind) UNIQUE — tenant 당 종류별 1 개.
-- form_schema  : rjsf 가 렌더링하는 JSON Schema (Draft 7).
-- ui_schema    : rjsf UI 힌트 (필드별 ui:widget 등). 우리는 frontend 에서
--                money / customerPicker / richText / textarea 같은 전용
--                widget 을 추가 등록 (components/approvals/RjsfTableTheme.tsx).
-- approval_rules: { "rules": [ { "name": "...", "when": {…} | null,
--                  "approvers": [{ "type": "manager"|... , "step_name": "..." }] } ] }
-- attachment_slots: { "slots": [ { "slug": "quote", "label": "견적서",
--                  "required": false, "min_count": 0, "max_count": null,
--                  "description": "..." } ] } — NULL/빈객체 = 자유 첨부만.
-- version      : form/ui/rules/slots 변경 시 자동 +1 (api/v1/approval_templates.py).
CREATE TABLE public.approval_templates (
    id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid           NOT NULL,
    kind               varchar(30)    NOT NULL,        -- EXPENSE, LEAVE, ...
    name               varchar(100)   NOT NULL,
    icon               varchar(40),                    -- lucide-react icon key
    form_schema        jsonb          NOT NULL DEFAULT '{}',
    ui_schema          jsonb,
    approval_rules     jsonb          NOT NULL DEFAULT '{}',
    attachment_slots   jsonb,
    version            integer        NOT NULL DEFAULT 1,
    is_active          boolean        NOT NULL DEFAULT true,
    description        text,
    created_at         timestamptz    NOT NULL DEFAULT now(),
    updated_at         timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_approval_templates_tenant_kind UNIQUE (tenant_id, kind)
);
CREATE INDEX ix_approval_templates_kind ON public.approval_templates (kind);

-- 결재 요청 — source of truth.
-- 상태 전이: DRAFT → SUBMITTED|IN_PROGRESS → APPROVED|REJECTED|CANCELLED
--            (SUBMITTED 는 step 평가 결과가 0 단계인 케이스를 위해 예약된 중간 상태,
--             현재는 제출 즉시 IN_PROGRESS 로 진행되어 사실상 미사용)
-- requester_id 는 developers.id (User → mapped_developer_id 로 해석).
-- snapshot 컬럼 3 종 — template 변경 시에도 진행중 결재의 폼/룰/슬롯 정의를 고정.
CREATE TABLE public.approval_requests (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid           NOT NULL,
    template_id              uuid           NOT NULL REFERENCES public.approval_templates(id) ON DELETE RESTRICT,
    kind                     varchar(30)    NOT NULL,
    title                    varchar(300)   NOT NULL,
    requester_id             uuid           NOT NULL REFERENCES public.developers(id) ON DELETE RESTRICT,
    -- DRAFT | SUBMITTED | IN_PROGRESS | APPROVED | REJECTED | CANCELLED
    status                   varchar(20)    NOT NULL DEFAULT 'DRAFT',
    form_data                jsonb          NOT NULL DEFAULT '{}',
    -- 진행중 결재 보호 — schema 변경 시에도 이 row 의 표시·룰 평가는 snapshot 우선.
    template_version         integer        NOT NULL DEFAULT 1,
    form_schema_snapshot     jsonb,
    approval_rules_snapshot  jsonb,
    -- 제출 시점 attachment_slots snapshot (template 이 나중에 변경되어도 진행중 결재
    -- 의 기대 첨부 정의는 고정).
    attachment_slots_snapshot jsonb,
    submitted_at             timestamptz,
    completed_at             timestamptz,
    cancelled_reason         text,
    created_at               timestamptz    NOT NULL DEFAULT now(),
    updated_at               timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_approval_requests_kind        ON public.approval_requests (kind);
CREATE INDEX ix_approval_requests_status      ON public.approval_requests (status);
CREATE INDEX ix_approval_requests_requester   ON public.approval_requests (requester_id);
CREATE INDEX ix_approval_requests_template    ON public.approval_requests (template_id);

-- 결재 단계 — 제출 시 룰 평가 결과 snapshot.
-- 동일 request_id 안에서 step_no 오름차순으로 진행. 한 PENDING step 처리 후 다음 step
-- 이 PENDING 으로 활성화. 위임(DELEGATED) 시 기존 step 은 닫히고 step_no+1 위치에
-- 새 step 추가 (이후 step_no 가 모두 +1 shift, delegated_from_step_id 로 추적).
-- approver_id 가 NULL 인 step (룰 평가 시 매니저 chain 에서 후보 못 찾음) 은
-- UI 에 "결재자 미정" 으로 노출되며 진행이 막힌다 → 운영자가 매니저 등록 후 재제출.
CREATE TABLE public.approval_steps (
    id                        uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid           NOT NULL,
    request_id                uuid           NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
    step_no                   integer        NOT NULL,
    step_name                 varchar(100)   NOT NULL,
    rule_index                integer,
    approver_index            integer,
    approver_id               uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    -- PENDING | APPROVED | REJECTED | DELEGATED | SKIPPED
    status                    varchar(20)    NOT NULL DEFAULT 'PENDING',
    decision_comment          text,
    decided_at                timestamptz,
    delegated_from_step_id    uuid           REFERENCES public.approval_steps(id) ON DELETE SET NULL,
    created_at                timestamptz    NOT NULL DEFAULT now(),
    updated_at                timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_approval_steps_request   ON public.approval_steps (request_id);
CREATE INDEX ix_approval_steps_approver  ON public.approval_steps (approver_id);
CREATE INDEX ix_approval_steps_status    ON public.approval_steps (status);

-- 결재 감사 로그.
CREATE TABLE public.approval_history (
    id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid           NOT NULL,
    request_id   uuid           NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
    step_id      uuid           REFERENCES public.approval_steps(id) ON DELETE SET NULL,
    -- CREATED | SUBMITTED | APPROVED | REJECTED | CANCELLED | DELEGATED | TIMEOUT | COMMENTED | SKIPPED
    -- SKIPPED: 등급 자동 SKIP — 상위 결재자 승인 또는 매니저 chain 부족으로 미해결 step 을
    --   자동 건너뜀 (api/v1/approvals.py _auto_skip_downstream + services/approval_engine.py).
    event        varchar(20)    NOT NULL,
    actor_id     uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    payload      jsonb,
    occurred_at  timestamptz    NOT NULL,
    created_at   timestamptz    NOT NULL DEFAULT now(),
    updated_at   timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_approval_history_request   ON public.approval_history (request_id);
CREATE INDEX ix_approval_history_event     ON public.approval_history (event);
CREATE INDEX ix_approval_history_occurred  ON public.approval_history (occurred_at);

-- 결재 첨부 파일.
-- 저장 경로: data/<tenant_prefix>/approvals/<request_id>/<uuid>.<ext>
-- (services/storage.py 의 save_upload 가 tenant prefix 자동 합성).
-- slot 컬럼 = template.attachment_slots.slots[].slug 와 매칭. NULL 은 "기타".
-- 결재자(approver) 는 첨부 추가 불가 — 신청자 + ADMIN/HR 만 (api/v1/approvals.py
-- 의 _can_modify_attachments). 종결(APPROVED/REJECTED/CANCELLED) 후에는 신청자도
-- 수정 불가.
CREATE TABLE public.approval_attachments (
    id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid           NOT NULL,
    request_id      uuid           NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
    -- 첨부 슬롯 식별자 (attachment_slots.slots[].slug). NULL = 기타 자유 첨부.
    slot            varchar(40),
    file_name       varchar(300)   NOT NULL,
    mime_type       varchar(120),
    size            integer        NOT NULL DEFAULT 0,
    file_path       varchar(1024)  NOT NULL,
    uploaded_by_id  uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    created_at      timestamptz    NOT NULL DEFAULT now(),
    updated_at      timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_approval_attachments_request ON public.approval_attachments (request_id);
CREATE INDEX ix_approval_attachments_slot    ON public.approval_attachments (request_id, slot);


-- ===========================================================================
-- 목표(Goals) — 개인/회사 연간 목표 + 점수 평가 + 마감 알림 + 코멘트 + 첨부.
--
-- scope 두 종:
--   PERSONAL — owner_id 가 임직원. 본인 + 직속 매니저 + 매니저 chain 위 +
--              HR/ADMIN 조회. 본인 + 직속 매니저 + HR/ADMIN 작성·편집·삭제.
--   COMPANY  — owner_id NULL. 전직원 readonly, ADMIN 만 작성·편집·삭제 (HR 제외).
--
-- ─ 3축 가중 점수 모델 (services/goal_scoring.py) ─
--   환산 점수 = 진행률 × 난이도 배율
--   가중치   = 우선순위 가중치 × 분류 가중치 (관리자 설정, default 1.0)
--   종합 점수 = Σ(환산 × 가중치) / Σ(가중치)        (가중평균, 0~200)
--
--   난이도 배율: ROUTINE 0.8 / NORMAL 1.0 / CHALLENGING 1.5 / STRETCH 2.0
--   우선순위 가중치: HIGH 3 / MEDIUM 2 / LOW 1
--   등급: S ≥ 120 / A ≥ 90 / B ≥ 70 / C ≥ 50 / D
--
-- ─ Cascade ─
--   parent_goal_id 로 회사 목표 → 개인 목표 link. 회사 목표 삭제 시 자식 link 만
--   끊김(SET NULL). MVP 는 parent=COMPANY 만 허용 (앱 레이어 검증).
--
-- ─ 평가 분리 ─
--   self_score (본인 입력) + manager_score (직속 매니저 입력). 0~150 점수 +
--   코멘트. auto_score 는 progress×difficulty 로 서버 계산해 응답에만 포함
--   (저장 X). 매니저 평가 시 manager_score_by_id + manager_score_at 동기.
--
-- ─ 마감 알림 (services/goal_due.py + scheduler.py 09:10 KST) ─
--   D-30 (정확) + D-Day 후 첫 영업일 (휴일 자동 시프트, 기존 alarm.py 정책 사용)
--   = 1회씩 발송. goal_due_alerts (goal_id, alert_kind) UNIQUE 로 dedup.
--   수신자: PERSONAL = owner + owner.manager / COMPANY = ADMIN role.
--
-- ─ 코멘트 (goal_comments) ─
--   조회 권한자(_can_view 통과) 누구나 작성 가능. 편집·삭제는 작성자 + HR/ADMIN.
--   developer 삭제 시 author_id NULL (감사 로그로 보존). TipTap HTML 본문.
--
-- ─ 첨부 (goal_attachments) ─
--   N개. 본인 + 직속 매니저 + HR/ADMIN 만 업로드/삭제/이름변경. 다운로드는
--   조회 권한자 모두. 저장: data/<tenant>/goals/<goal_id>/<uuid>.<ext>.
--
-- phase 2 예약: goal_key_results (Objective+KR), goal_check_ins (Q1~Q4),
-- 분류 가중치 운영자 정의 UI (현재는 코드 default 1.0).
-- ===========================================================================

CREATE TABLE public.goals (
    id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid           NOT NULL,
    -- PERSONAL | COMPANY
    scope           varchar(16)    NOT NULL,
    year            integer        NOT NULL,
    -- PERSONAL 일 때 NOT NULL, COMPANY 일 때 NULL (체크는 앱 레이어).
    owner_id        uuid           REFERENCES public.developers(id) ON DELETE CASCADE,
    -- cascade — 회사 목표 → 개인 목표 link. 부모 삭제 시 자식의 link 만 끊김.
    parent_goal_id  uuid           REFERENCES public.goals(id) ON DELETE SET NULL,
    title           varchar(300)   NOT NULL,
    -- TipTap HTML. NULL 또는 빈 문자열 허용.
    description     text,
    -- BUSINESS | TECH | CAREER | OPERATIONS | PERSONAL_GROWTH | OTHER
    category        varchar(30)    NOT NULL DEFAULT 'BUSINESS',
    priority        varchar(8)     NOT NULL DEFAULT 'MEDIUM',     -- HIGH | MEDIUM | LOW
    -- 난이도 — 점수 multiplier 적용. ROUTINE 0.8 / NORMAL 1.0 / CHALLENGING 1.5 / STRETCH 2.0
    difficulty      varchar(16)    NOT NULL DEFAULT 'NORMAL',
    status          varchar(16)    NOT NULL DEFAULT 'DRAFT',
    -- DRAFT | IN_PROGRESS | AT_RISK | DONE | DROPPED
    progress_pct    numeric(5,2)   NOT NULL DEFAULT 0,
    due_date        date,
    -- 평가 — 자기 평가 (본인 입력) + 매니저 평가 (직속 매니저 입력). 0~150.
    self_score              numeric(5,2),
    self_score_comment      text,
    manager_score           numeric(5,2),
    manager_score_comment   text,
    manager_score_by_id     uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    manager_score_at        timestamptz,
    created_at      timestamptz    NOT NULL DEFAULT now(),
    updated_at      timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_goals_tenant_year_scope ON public.goals (tenant_id, year, scope);
CREATE INDEX ix_goals_owner             ON public.goals (owner_id);
CREATE INDEX ix_goals_parent            ON public.goals (parent_goal_id);


-- 마감일 알림 dedup — D-30 / OVERDUE (D-Day 후 첫 영업일) 1회씩.
-- cron (services/scheduler.py 의 09:10 KST) 이 매일 활성 goal 을 순회하며
-- 트리거 시점에 INSERT … ON CONFLICT DO NOTHING 으로 중복 발송 차단.
-- alert_kind: D_30 | OVERDUE
-- 수신자: PERSONAL → owner + owner.manager / COMPANY → ADMIN role 사용자들.
CREATE TABLE public.goal_due_alerts (
    id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid           NOT NULL,
    goal_id      uuid           NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
    alert_kind   varchar(16)    NOT NULL,
    notified_at  timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_goal_due_alerts_goal_kind UNIQUE (goal_id, alert_kind)
);
CREATE INDEX ix_goal_due_alerts_goal ON public.goal_due_alerts (goal_id);


-- 목표 코멘트 — 조회 권한자(_can_view 통과) 누구나 작성 가능.
-- 편집·삭제는 작성자(author) + HR/ADMIN.
CREATE TABLE public.goal_comments (
    id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid           NOT NULL,
    goal_id      uuid           NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
    -- developer 삭제 시 코멘트는 보존 (감사 로그). 표시는 "작성자 없음".
    author_id    uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    -- developer 미매핑 사용자 (ADMIN 부트스트랩 등) 의 경우 fallback. user 가
    -- 삭제되면 NULL. 표시 우선순위: author_id (developer name) → author_user_id
    -- (user name) → '(작성자 없음)'.
    author_user_id uuid         REFERENCES public.users(id) ON DELETE SET NULL,
    body         text           NOT NULL,   -- TipTap HTML
    created_at   timestamptz    NOT NULL DEFAULT now(),
    updated_at   timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_goal_comments_goal ON public.goal_comments (goal_id, created_at DESC);


-- 목표 첨부 파일 — N 개. 작성자 + 직속 매니저 + HR/ADMIN 만 업로드/삭제/이름변경.
-- 다운로드는 조회 권한자(_can_view) 모두.
-- 저장 경로: data/<tenant>/goals/<goal_id>/<uuid>.<ext>
CREATE TABLE public.goal_attachments (
    id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid           NOT NULL,
    goal_id         uuid           NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
    file_name       varchar(300)   NOT NULL,
    mime_type       varchar(120),
    size            integer        NOT NULL DEFAULT 0,
    file_path       varchar(1024)  NOT NULL,
    uploaded_by_id  uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    created_at      timestamptz    NOT NULL DEFAULT now(),
    updated_at      timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_goal_attachments_goal ON public.goal_attachments (goal_id);


-- 연도별 종합 점수 가중치 하한 (Settings > 목표 기준값 에서 ADMIN 이 설정).
--
-- 효과:
--   본인 등록 목표들의 Σ(priority_weight × category_weight) 가
--   `min_total_weight` 미만이면 종합 점수 가중평균의 **분모를 그 값으로
--   강제 고정** → 등록 가중치가 적은 직원의 점수 부풀림 방지.
--   분자는 그대로 두므로 점수가 비례하여 낮아진다 (응답에 floor_applied=true).
--
-- min_goal_count: 페널티 없는 권장값 — UI 가 "권장 N 개 이상" 으로만 표시,
--   계산엔 영향 없음.
--
-- 1년 1행 — (tenant_id, year) UNIQUE. 미설정이면 baseline 미적용 (분모 = 등록 합계).
CREATE TABLE IF NOT EXISTS public.goal_score_baselines (
    id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid           NOT NULL,
    year              integer        NOT NULL,
    min_total_weight  numeric(8,2)   NOT NULL,                -- 분모 하한 (이상이면 미적용)
    min_goal_count    integer,                                -- 권장 목표 수 (안내용)
    note              text,                                   -- 운영 메모 (예: 정책 변경 사유)
    created_at        timestamptz    NOT NULL DEFAULT now(),
    updated_at        timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_goal_score_baselines_year UNIQUE (tenant_id, year)
);
CREATE INDEX IF NOT EXISTS ix_goal_score_baselines_year ON public.goal_score_baselines (year);
-- tenant_id / RLS / fn_auto_tenant_id 트리거는 파일 끝의 일괄 부여 블록이 처리.


-- tenant 단위 사번 UNIQUE — NULL row (프리랜서/자사화) 다수 허용을 위한 부분 인덱스.
CREATE UNIQUE INDEX uq_developers_tenant_employee_no
    ON public.developers (tenant_id, employee_no)
 WHERE employee_no IS NOT NULL;

-- users.mapped_developer_id → developers.id (users 테이블 정의 시점에 developers 가
-- 아직 존재하지 않아 ALTER TABLE 로 제약을 추가).
ALTER TABLE public.users
    ADD CONSTRAINT fk_users_mapped_developer
    FOREIGN KEY (mapped_developer_id) REFERENCES public.developers(id) ON DELETE SET NULL;

-- 임직원별 연차 승인자 지정 (1~N명, primary 최대 1명).
CREATE TABLE public.developer_approvers (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id     uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    approver_user_id uuid          NOT NULL REFERENCES public.users(id)      ON DELETE CASCADE,
    is_primary       boolean       NOT NULL DEFAULT false,
    position         integer       NOT NULL DEFAULT 0,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_dev_approver UNIQUE (developer_id, approver_user_id)
);
CREATE UNIQUE INDEX uq_dev_primary_approver
    ON public.developer_approvers(developer_id) WHERE is_primary;
CREATE INDEX ix_dev_approvers_dev      ON public.developer_approvers(developer_id);
CREATE INDEX ix_dev_approvers_approver ON public.developer_approvers(approver_user_id);


-- 임직원 이력서 파일 (다건).
CREATE TABLE public.developer_resumes (
    id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id uuid           NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    file_name    varchar(255)   NOT NULL,
    file_path    varchar(1024)  NOT NULL,
    mime_type    varchar(120),
    size         integer        NOT NULL,
    description  text,
    created_at   timestamptz    NOT NULL DEFAULT now(),
    updated_at   timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_developer_resumes_developer_id ON public.developer_resumes (developer_id);


-- 구조화 이력서 — 임직원 1명당 1 row (생년월일/학력).
-- 이력서 모달에서 이름은 developers.name 을 그대로 사용.
CREATE TABLE public.developer_profiles (
    developer_id     uuid          PRIMARY KEY REFERENCES public.developers(id) ON DELETE CASCADE,
    birth_date       date,
    school           varchar(200),
    major            varchar(200),
    graduation_year  smallint,
    updated_at       timestamptz   NOT NULL DEFAULT now()
);


-- 자격증 (1:N).
CREATE TABLE public.developer_certifications (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    name         varchar(200)  NOT NULL,
    issuer       varchar(200),
    acquired_on  date,
    position     integer       NOT NULL DEFAULT 0,
    created_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_developer_certifications_developer_id ON public.developer_certifications (developer_id);


-- 이력 (경력) (1:N). 시작일/종료일, 기업 또는 프로젝트명, 역할.
-- end_date NULL = 재직중.
CREATE TABLE public.developer_experiences (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    start_date   date          NOT NULL,
    end_date     date,
    company      varchar(200)  NOT NULL,
    role         varchar(200)  NOT NULL,
    description  text,
    position     integer       NOT NULL DEFAULT 0,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_developer_experiences_developer_id ON public.developer_experiences (developer_id);


-- 임직원 여권정보 (1:1). 여권번호는 Fernet 암호화 저장 (passport_number_enc 의 'enc:' prefix).
-- 본인 / HR / ADMIN 만 조회·수정 가능 (앱 가드).
CREATE TABLE public.developer_passports (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid          NOT NULL,
    developer_id        uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    passport_number_enc text,
    gender              varchar(1),                                       -- 'M' | 'F'
    surname_en          varchar(100),
    given_name_en       varchar(100),
    nationality         varchar(3),
    issue_date          date,
    expiry_date         date,
    issue_country       varchar(60),
    passport_type       varchar(20),                                     -- REGULAR | OFFICIAL | DIPLOMATIC
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_developer_passports_dev UNIQUE (developer_id)
);
CREATE INDEX ix_developer_passports_developer_id ON public.developer_passports (developer_id);


-- 임직원 비상연락처 (1:N). UI 는 2 슬롯만 노출, 모델은 N 개 허용.
-- 본인 / HR / ADMIN 만 조회·수정 가능 (앱 가드).
CREATE TABLE public.developer_emergency_contacts (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid          NOT NULL,
    developer_id uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    position     integer       NOT NULL DEFAULT 0,
    name         varchar(100),
    relation     varchar(50),
    phone        varchar(50),
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_developer_emergency_contacts_developer_id ON public.developer_emergency_contacts (developer_id);


-- 임직원 면담 기록 (1:N). HR 가 직원과 했던 면담을 시간순으로 누적.
-- HR/ADMIN/SUPER_ADMIN 만 열람·작성 (앱 가드 + 백엔드 가드). 본인이라도 차단.
-- 본인(작성자) + ADMIN 만 수정·삭제.
CREATE TABLE public.developer_interviews (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL,
    developer_id    uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    author_user_id  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    body            text          NOT NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_developer_interviews_developer_id ON public.developer_interviews (developer_id);
CREATE INDEX ix_developer_interviews_author       ON public.developer_interviews (author_user_id);


-- 연봉 이력 (effective_from / _to 윈도우). 4대보험 추정치/실제치를 함께 저장.
CREATE TABLE public.developer_salaries (
    id                                      uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id                            uuid           NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    annual_salary                           numeric(14, 2) NOT NULL,
    effective_from                          date           NOT NULL,
    effective_to                            date,                                         -- NULL = 현재 진행중
    note                                    text,
    estimated_employee_insurance_monthly    numeric(14, 2),                               -- 4대보험 근로자 부담 (자동 계산)
    estimated_employer_insurance_monthly    numeric(14, 2),                               -- 4대보험 회사 부담
    actual_employee_insurance_monthly       numeric(14, 2),                               -- 실제 납부액 (수기 입력)
    actual_employer_insurance_monthly       numeric(14, 2),
    created_by                              uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at                              timestamptz    NOT NULL DEFAULT now(),
    updated_at                              timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_dev_sal_dev_eff ON public.developer_salaries (developer_id, effective_from DESC);


-- 정부 연구과제 지원 이력 (연구개발비 일부를 인건비로 지원받는 경우).
CREATE TABLE public.developer_research_grants (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id        uuid           NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    name                varchar(200),
    start_date          date           NOT NULL,
    end_date            date           NOT NULL,
    total_amount        numeric(14, 2) NOT NULL,                                -- 총 지원금
    participation_rate  numeric(5, 2)  NOT NULL,                                -- 참여율 %
    note                text,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_dev_grants_dev_id ON public.developer_research_grants (developer_id);


-- =============================================================================
-- 5) 프로젝트 / 견적 / 투입
-- =============================================================================

-- 프로젝트 메타. 총 사업비는 견적 라인 합으로 자동 동기화됨.
CREATE TABLE public.projects (
    id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  varchar(200)   NOT NULL,
    customer_id           uuid           REFERENCES public.customers(id) ON DELETE SET NULL,
    orderer_id            uuid           REFERENCES public.customers(id) ON DELETE SET NULL,  -- 발주사
    start_date            date           NOT NULL,
    end_date              date           NOT NULL,
    total_contract_amount numeric(18, 2) NOT NULL DEFAULT 0,
    contract_currency     varchar(10)    NOT NULL DEFAULT 'KRW',
    contract_type         varchar(30),                                          -- SOLO | CONSORTIUM | SUBCONTRACT
    business_type         varchar(30),                                          -- RESEARCH | PUBLIC | PRIVATE
    project_nature        varchar(30),                                          -- 프로젝트 성격(컨설팅/개발/운영/기술지원)
    alarm_days_before     integer[],                                            -- 종료 전 알람 시점 (예: [90,30,7])
    ended_at              timestamptz,                                          -- 수동 종료 타임스탬프 (NULL = 미종료)
    description           text,
    memo                  text,
    created_at            timestamptz    NOT NULL DEFAULT now(),
    updated_at            timestamptz    NOT NULL DEFAULT now()
);


-- 프로젝트 견적서 라인. 합계는 저장하지 않고 표시 시 계산: unit_rate × months × (1 − discount/100)
CREATE TABLE public.project_estimate_items (
    id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid           NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    name          varchar(200)   NOT NULL DEFAULT '',
    grade         varchar(20)    NOT NULL DEFAULT 'MID',                        -- PREMIUM | HIGH | MID | JUNIOR
    unit_rate     numeric(18, 2) NOT NULL DEFAULT 0,                            -- 월 단가
    months        numeric(6, 2)  NOT NULL DEFAULT 1,
    discount_rate numeric(5, 2)  NOT NULL DEFAULT 0,                            -- %
    start_date    date,                                                         -- (구)라인별 시작일 — 현재 UI 미노출
    "position"    integer        NOT NULL DEFAULT 0,                            -- 표시 순서
    created_at    timestamptz    NOT NULL DEFAULT now(),
    updated_at    timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_estimate_items_project        ON public.project_estimate_items (project_id);
CREATE INDEX ix_project_estimate_items_project_id ON public.project_estimate_items (project_id);


-- 프로젝트 견적서 파일. 파일은 data/projects/<project_id>/ 아래 저장.
CREATE TABLE public.project_quotes (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid          NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    file_name   varchar(300)  NOT NULL,
    file_path   varchar(500)  NOT NULL,
    mime_type   varchar(100),
    size        bigint,
    description text,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);


-- 프로젝트 단일 슬롯 첨부 (계약서/견적서/제안서/기술협상/기타).
CREATE TABLE public.project_attachments (
    id         uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid           NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    slot       varchar(30)    NOT NULL,                                         -- CONTRACT | QUOTE | PROPOSAL | TECH_NEGOTIATION | OTHER
    file_name  varchar(300)   NOT NULL,
    file_path  varchar(1024)  NOT NULL,
    mime_type  varchar(120),
    size       integer,
    created_at timestamptz    NOT NULL DEFAULT now(),
    updated_at timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_project_attachment_slot UNIQUE (project_id, slot)
);
CREATE INDEX ix_project_attachments_project_id ON public.project_attachments (project_id);


-- 프로젝트 댓글 (현재 UI에서는 메모로 대체됐지만 테이블은 유지).
CREATE TABLE public.project_comments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid          NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    author_id   uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    author_name varchar(100),
    content     text          NOT NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);


-- 프로젝트 × 임직원 투입 배정. 견적 라인과 매핑되면 estimate_item_id 지정.
CREATE TABLE public.assignments (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid           NOT NULL REFERENCES public.projects(id)   ON DELETE CASCADE,
    developer_id        uuid           NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    estimate_item_id    uuid           REFERENCES public.project_estimate_items(id) ON DELETE SET NULL,
    start_date          date           NOT NULL,
    end_date            date           NOT NULL,
    monthly_rate        numeric(18, 2) NOT NULL,                                -- 집계용 월 총액 스냅샷
    base_monthly        numeric(18, 2),                                         -- 월 보수
    insurance_monthly   numeric(18, 2),                                         -- 월 4대보험 회사부담
    overhead_monthly    numeric(18, 2),                                         -- 월 경비
    freelancer_monthly  numeric(18, 2),                                         -- 프리랜서 월 단가
    is_insourced        boolean        NOT NULL DEFAULT false,                  -- 자사화 여부
    allocation_percent  numeric(5, 2)  NOT NULL DEFAULT 100,                    -- 투입 공수(%) — 원가 계산 시 월 비용에 곱함
    color               varchar(7),                                             -- 수동 색상 지정
    memo                text,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);

-- 프로젝트 매입 — 파트너 기업에게 위탁/지급하는 KRW 금액. 한 프로젝트에
-- 다건 등록 가능. 원가(total_cost)에 포함되어 마진 계산에 반영된다.
CREATE TABLE public.project_procurements (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid           NOT NULL REFERENCES public.projects(id)   ON DELETE CASCADE,
    supplier_id         uuid           NOT NULL REFERENCES public.customers(id)  ON DELETE RESTRICT,
    amount              numeric(18, 2) NOT NULL DEFAULT 0,                       -- KRW 고정
    description         text,                                                    -- 위탁 내용
    memo                text,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);


-- =============================================================================
-- 6) 라이센스 / 견적 / 첨부
-- =============================================================================

-- SW 라이센스. USD 도입/원화 청구의 환율 차이를 기록 지원.
CREATE TABLE public.licenses (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         uuid           NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    contact_id          uuid           REFERENCES public.license_contacts(id) ON DELETE SET NULL,
    product_name        varchar(200)   NOT NULL,
    -- 제조사 — vendors 카탈로그 FK. (라이센스는 product/version 별도 컬럼 없음 —
    -- product_name 자유 텍스트 유지.)
    vendor_id           uuid           REFERENCES public.vendors(id) ON DELETE RESTRICT,
    currency            varchar(3)     NOT NULL DEFAULT 'KRW',                  -- KRW | USD
    amount              numeric(18, 2) NOT NULL DEFAULT 0,
    applied_fx_rate     numeric(10, 4),                                         -- 청구 시 적용된 환율
    amount_krw          numeric(18, 2),                                         -- amount × fx (캐시)
    -- 매입(Purchase)
    purchase_supplier   varchar(200),                                           -- 매입처 (고객사 리스트에서 선택)
    purchase_currency   varchar(3),
    purchase_amount     numeric(18, 2),
    purchase_fx_rate    numeric(10, 4),
    -- 매출(Sales)
    sales_customer      varchar(200),                                           -- 매출처 (고객사 리스트에서 선택)
    sales_currency      varchar(3),
    start_date          date           NOT NULL,
    end_date            date           NOT NULL,
    renewal_prep_date   date,                                                   -- 연장 준비일
    status              varchar(30)    NOT NULL DEFAULT 'ACTIVE',               -- ACTIVE | EXPIRED | CANCELLED
    description         text,
    memo                text,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);


-- 라이센스 첨부 파일 (다건). 파일은 data/licenses/<license_id>/ 아래.
CREATE TABLE public.license_quotes (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id  uuid          NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
    quote_type  varchar(20)   NOT NULL DEFAULT 'SALES',                         -- SALES | PURCHASE | ATTACHMENT
    file_name   varchar(300)  NOT NULL,
    file_path   varchar(500)  NOT NULL,
    mime_type   varchar(100),
    size        bigint,
    description text,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);


-- 라이센스 견적서 라인 (매입/매출 공용, kind 로 구분).
CREATE TABLE public.license_quote_items (
    id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    license_id     uuid           NOT NULL REFERENCES public.licenses(id) ON DELETE CASCADE,
    kind           varchar(10)    NOT NULL DEFAULT 'PURCHASE',                  -- PURCHASE | SALES
    product_name   varchar(200)   NOT NULL DEFAULT '',
    product_code   varchar(100)   NOT NULL DEFAULT '',
    description    text,
    sales_price    numeric(18, 2) NOT NULL DEFAULT 0,
    qty            numeric(12, 2) NOT NULL DEFAULT 1,
    start_date     date,
    end_date       date,
    discount_rate  numeric(5, 2)  NOT NULL DEFAULT 0,                           -- %
    net_total      numeric(18, 2),                                              -- 수동 오버라이드(있으면 사용, 없으면 계산)
    "position"     integer        NOT NULL DEFAULT 0,
    created_at     timestamptz    NOT NULL DEFAULT now(),
    updated_at     timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_license_quote_items_license_id ON public.license_quote_items (license_id);


-- =============================================================================
-- 7) 영업기회 (Sales Opportunities)
-- =============================================================================

-- 영업기회. 연도별 필터는 expected_close_date 의 year 기준.
CREATE TABLE public.opportunities (
    id                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   varchar(200)   NOT NULL,
    customer_id            uuid           REFERENCES public.customers(id)  ON DELETE SET NULL,
    owner_id               uuid           REFERENCES public.users(id)      ON DELETE SET NULL,   -- (구)시스템 오너
    sales_rep_id           uuid           REFERENCES public.developers(id) ON DELETE SET NULL,   -- 영업대표 (임직원)
    stage                  varchar(20)    NOT NULL DEFAULT 'LEAD',          -- LEAD | QUALIFIED | PROPOSAL | NEGOTIATION
    status                 varchar(20)    NOT NULL DEFAULT 'OPEN',          -- OPEN | WON | LOST | ABANDONED
    probability            smallint       NOT NULL DEFAULT 10,              -- 0~100
    expected_amount        numeric(18, 2) NOT NULL DEFAULT 0,
    currency               varchar(3)     NOT NULL DEFAULT 'KRW',           -- KRW | USD
    registered_at          date,                                            -- 업무상 등록일 (사용자 편집 가능, NULL 이면 created_at 로 폴백)
    expected_close_date    date,
    closed_at              timestamptz,                                     -- WON/LOST/ABANDONED 전환 시 자동 세팅
    business_type          varchar(20),                                     -- RESEARCH | PRIVATE | PUBLIC
    source                 varchar(50),                                     -- 소스/채널 (예: 인바운드, 소개, RFP)
    description            text,
    memo                   text,
    -- 고객사 측 담당자 정보
    contact_name           varchar(100),
    contact_department     varchar(100),
    contact_phone          varchar(50),
    contact_email          varchar(200),
    -- 전환 링크 (수주 시 license/project 로 연결, FK 아님 — 삭제 안전)
    converted_license_id   uuid,
    converted_project_id   uuid,
    created_at             timestamptz    NOT NULL DEFAULT now(),
    updated_at             timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_opportunities_customer_id ON public.opportunities (customer_id);
CREATE INDEX ix_opportunities_owner_id    ON public.opportunities (owner_id);
CREATE INDEX ix_opportunities_close       ON public.opportunities (expected_close_date);


-- 영업기회 활동 기록 (미팅/전화/메일/제안/메모/기타).
CREATE TABLE public.opportunity_activities (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id uuid          NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE,
    activity_type  varchar(20)   NOT NULL DEFAULT 'NOTE',                   -- MEETING | CALL | EMAIL | PROPOSAL | NOTE | OTHER
    happened_at    timestamptz   NOT NULL DEFAULT now(),
    summary        text          NOT NULL DEFAULT '',
    owner_id       uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_opportunity_activities_opp ON public.opportunity_activities (opportunity_id);


-- 단계/상태 변경 이력 (자동 로깅).
CREATE TABLE public.opportunity_stage_history (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id uuid          NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE,
    from_stage     varchar(20),
    to_stage       varchar(20)   NOT NULL,
    from_status    varchar(20),
    to_status      varchar(20)   NOT NULL,
    changed_at     timestamptz   NOT NULL DEFAULT now(),
    changed_by     uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    note           text,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_opportunity_stage_history_opp ON public.opportunity_stage_history (opportunity_id);


-- 영업기회 첨부 파일. 파일은 data/opportunities/<opp_id>/ 아래.
CREATE TABLE public.opportunity_attachments (
    id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id uuid           NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE,
    file_name      varchar(300)   NOT NULL,
    file_path      varchar(1024)  NOT NULL,
    mime_type      varchar(120),
    size           bigint,
    description    text,
    created_at     timestamptz    NOT NULL DEFAULT now(),
    updated_at     timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_opportunity_attachments_opp ON public.opportunity_attachments (opportunity_id);


-- =============================================================================
-- 8) 견적서(Quotes) / 청구서(Invoices) / 회사 프로필
-- =============================================================================

-- (구) company_profile 테이블은 Stage 6 에서 tenants 테이블로 통합되어 제거됨.
-- 자사 발행자 정보는 이제 `public.tenants` 의 컬럼들 (name, name_en, business_no,
-- representative, address, address_en, phone, fax, contact_email, number_prefix,
-- 회사 프로필 자산 메타) 로 단일화. billing.py 의 _tenant_to_profile_out 가
-- Tenant → 기존 CompanyProfileOut 응답 형식으로 매핑.

-- 견적서. number = '<prefix>Q-<year>-<seq:04>'. 연도별 순번.
CREATE TABLE public.quotes (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    number              varchar(40)    NOT NULL UNIQUE,                          -- '{prefix}{Q|I}-YYYYMMDD-XXXX' (4자 base32)
    year                integer        NOT NULL,
    seq                 integer,                                                  -- 구 포맷 전용. 신규 포맷은 NULL.
    version             integer        NOT NULL DEFAULT 1,                       -- 저장 시마다 +1
    customer_id         uuid           REFERENCES public.customers(id) ON DELETE RESTRICT,
    customer_snapshot   jsonb,
    issuer_snapshot     jsonb,
    title               varchar(200)   NOT NULL,
    issue_date          date           NOT NULL,
    valid_until         date,
    currency            varchar(3)     NOT NULL DEFAULT 'KRW',
    -- 'ko' (default) / 'en'. 영문 견적서는 라벨·열헤더·발행자명 등 모두 영문.
    -- billing-export.ts 의 LABELS_EN 사용. 자유 텍스트 (item 명·메모·terms) 는
    -- 사용자 입력 그대로. 통화는 별도 컬럼 — locale 과 자동 매핑 X.
    locale              varchar(2)     NOT NULL DEFAULT 'ko',
    tax_mode            varchar(16)    NOT NULL DEFAULT 'EXCLUSIVE',            -- EXCLUSIVE | INCLUSIVE
    tax_rate            numeric(5, 2)  NOT NULL DEFAULT 10,                     -- 10 = 부가세, 0 = 영세율
    subtotal            numeric(18, 2) NOT NULL DEFAULT 0,
    discount_total      numeric(18, 2) NOT NULL DEFAULT 0,
    tax_amount          numeric(18, 2) NOT NULL DEFAULT 0,
    total_amount        numeric(18, 2) NOT NULL DEFAULT 0,
    project_id          uuid           REFERENCES public.projects(id) ON DELETE SET NULL,
    opportunity_id      uuid           REFERENCES public.opportunities(id) ON DELETE SET NULL,
    status              varchar(16)    NOT NULL DEFAULT 'DRAFT',                -- DRAFT(진행중) / FINAL(최종 제출)
    converted_invoice_id uuid,                                                   -- FK 는 invoices 생성 후 ALTER
    source_quote_id     uuid           REFERENCES public.quotes(id) ON DELETE SET NULL,
    business_name       varchar(200),                                            -- 사업명
    attention           varchar(200),                                            -- 수신
    memo                text,
    terms               text,
    created_by          uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_quotes_number ON public.quotes (number);
CREATE INDEX ix_quotes_year_seq ON public.quotes (year, seq);

-- 견적 라인. kind = PRODUCT | STAFFING | SERVICE | EXPENSE | OTHER
CREATE TABLE public.quote_items (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id            uuid           NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    position            integer        NOT NULL DEFAULT 0,
    kind                varchar(16)    NOT NULL DEFAULT 'PRODUCT',
    name                varchar(200)   NOT NULL,
    description         text,
    unit                varchar(32),
    quantity            numeric(12, 2) NOT NULL DEFAULT 1,
    unit_price          numeric(18, 2) NOT NULL DEFAULT 0,
    discount_rate       numeric(5, 2)  NOT NULL DEFAULT 0,
    -- STAFFING 전용
    role                varchar(60),
    period_start        date,
    period_end          date,
    months              numeric(6, 2),
    years               numeric(5, 2)  NOT NULL DEFAULT 1,                        -- 다년 배수 (최소 1)
    -- 금액 스냅샷
    line_subtotal       numeric(18, 2) NOT NULL DEFAULT 0,
    line_discount       numeric(18, 2) NOT NULL DEFAULT 0,
    line_total          numeric(18, 2) NOT NULL DEFAULT 0,
    manual_total        boolean        NOT NULL DEFAULT false,                   -- 공급가액 수동 입력
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_quote_items_quote ON public.quote_items (quote_id, position);

-- 청구서. number = '<prefix>I-<year>-<seq:04>'.
CREATE TABLE public.invoices (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    number              varchar(40)    NOT NULL UNIQUE,                          -- '{prefix}{Q|I}-YYYYMMDD-XXXX' (4자 base32)
    year                integer        NOT NULL,
    seq                 integer,                                                  -- 구 포맷 전용. 신규 포맷은 NULL.
    version             integer        NOT NULL DEFAULT 1,                       -- 저장 시마다 +1
    status              varchar(16)    NOT NULL DEFAULT 'DRAFT',                 -- DRAFT | FINAL
    customer_id         uuid           REFERENCES public.customers(id) ON DELETE RESTRICT,
    customer_snapshot   jsonb,
    issuer_snapshot     jsonb,
    title               varchar(200)   NOT NULL,
    issue_date          date           NOT NULL,
    due_date            date,
    currency            varchar(3)     NOT NULL DEFAULT 'USD',                   -- 청구서 기본 USD
    tax_mode            varchar(16)    NOT NULL DEFAULT 'INCLUSIVE',             -- 기본 INCLUSIVE (포함)
    tax_rate            numeric(5, 2)  NOT NULL DEFAULT 0,                       -- 청구서 기본 0%
    subtotal            numeric(18, 2) NOT NULL DEFAULT 0,
    discount_total      numeric(18, 2) NOT NULL DEFAULT 0,
    tax_amount          numeric(18, 2) NOT NULL DEFAULT 0,
    total_amount        numeric(18, 2) NOT NULL DEFAULT 0,
    project_id          uuid           REFERENCES public.projects(id) ON DELETE SET NULL,
    opportunity_id      uuid           REFERENCES public.opportunities(id) ON DELETE SET NULL,
    paid_amount         numeric(18, 2) NOT NULL DEFAULT 0,                       -- 부분수금 지원
    payment_status      varchar(16)    NOT NULL DEFAULT 'UNPAID',                -- UNPAID | PARTIAL | PAID
    paid_at             date,
    linked_bank_transaction_id uuid    REFERENCES public.bank_transactions(id) ON DELETE SET NULL,
    source_quote_id     uuid           REFERENCES public.quotes(id) ON DELETE SET NULL,
    source_invoice_id   uuid           REFERENCES public.invoices(id) ON DELETE SET NULL,
    business_name       varchar(200),                                            -- 사업명
    attention           varchar(200),                                            -- 수신
    po_no               varchar(100),                                            -- 고객 발행 PO 번호 (vendor_bills.po_no 와 명명 통일)
    memo                text,
    terms               text,
    created_by          uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_invoices_number ON public.invoices (number);
CREATE INDEX ix_invoices_year_seq ON public.invoices (year, seq);
CREATE INDEX ix_invoices_payment_status ON public.invoices (payment_status);
CREATE INDEX ix_invoices_linked_bank_transaction ON public.invoices (linked_bank_transaction_id);

ALTER TABLE public.quotes
    ADD CONSTRAINT fk_quotes_converted_invoice
    FOREIGN KEY (converted_invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;

CREATE TABLE public.invoice_items (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          uuid           NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    position            integer        NOT NULL DEFAULT 0,
    kind                varchar(16)    NOT NULL DEFAULT 'PRODUCT',
    name                varchar(200)   NOT NULL,
    description         text,
    unit                varchar(32),
    quantity            numeric(12, 2) NOT NULL DEFAULT 1,
    unit_price          numeric(18, 2) NOT NULL DEFAULT 0,
    discount_rate       numeric(5, 2)  NOT NULL DEFAULT 0,
    role                varchar(60),
    period_start        date,
    period_end          date,
    months              numeric(6, 2),
    years               numeric(5, 2)  NOT NULL DEFAULT 1,                        -- 다년 배수 (최소 1, quote_items 와 동일 의미)
    line_subtotal       numeric(18, 2) NOT NULL DEFAULT 0,
    line_discount       numeric(18, 2) NOT NULL DEFAULT 0,
    line_total          numeric(18, 2) NOT NULL DEFAULT 0,
    manual_total        boolean        NOT NULL DEFAULT false,                   -- 공급가액 수동 입력
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_invoice_items_invoice ON public.invoice_items (invoice_id, position);


-- 견적서 / 청구서 버전 이력 — 저장(Save) 1회마다 1 row. header + items 전체 스냅샷.
CREATE TABLE public.quote_versions (
    id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id    uuid           NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    version     integer        NOT NULL,
    header      jsonb          NOT NULL,
    items       jsonb          NOT NULL,
    created_by  uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz    NOT NULL DEFAULT now(),
    UNIQUE (quote_id, version)
);
CREATE INDEX ix_quote_versions_quote ON public.quote_versions (quote_id, version DESC);

CREATE TABLE public.invoice_versions (
    id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id  uuid           NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    version     integer        NOT NULL,
    header      jsonb          NOT NULL,
    items       jsonb          NOT NULL,
    created_by  uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz    NOT NULL DEFAULT now(),
    UNIQUE (invoice_id, version)
);
CREATE INDEX ix_invoice_versions_invoice ON public.invoice_versions (invoice_id, version DESC);


-- =============================================================================
-- 10) 급여관리 (payroll_runs, payroll_items, developer_tax_profile,
--     withholding_tax_tables/rows, payroll_distributions)
-- =============================================================================

CREATE TABLE public.payroll_runs (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    year                     integer        NOT NULL,
    month                    smallint       NOT NULL,                       -- 1..12
    status                   varchar(16)    NOT NULL DEFAULT 'DRAFT',       -- DRAFT | FINAL | PAID
    pay_date                 date,
    is_year_end_adjustment   boolean        NOT NULL DEFAULT false,         -- true=연말정산 회차
    memo                     text,
    created_by               uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at               timestamptz    NOT NULL DEFAULT now(),
    updated_at               timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_payroll_runs_year_month UNIQUE (year, month)
);

-- 회차 × 직원. mode=PAYROLL(정규직/자사화 월급제) | WITHHOLDING(프리랜서 3.3%).
CREATE TABLE public.payroll_items (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                   uuid           NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
    developer_id             uuid           NOT NULL REFERENCES public.developers(id) ON DELETE RESTRICT,
    mode                     varchar(16)    NOT NULL DEFAULT 'PAYROLL',
    -- 지급 - 과세
    base_salary              numeric(14,2)  NOT NULL DEFAULT 0,
    position_allowance       numeric(14,2)  NOT NULL DEFAULT 0,             -- 직책수당
    overtime_pay             numeric(14,2)  NOT NULL DEFAULT 0,             -- 연장근로수당
    holiday_pay              numeric(14,2)  NOT NULL DEFAULT 0,             -- 휴일근로수당
    annual_leave_pay         numeric(14,2)  NOT NULL DEFAULT 0,             -- 연차수당
    family_allowance         numeric(14,2)  NOT NULL DEFAULT 0,             -- 가족수당
    bonus                    numeric(14,2)  NOT NULL DEFAULT 0,             -- 상여금/인센티브
    holiday_bonus            numeric(14,2)  NOT NULL DEFAULT 0,             -- 명절상여
    other_taxable            numeric(14,2)  NOT NULL DEFAULT 0,
    -- 지급 - 비과세
    meal_allowance           numeric(14,2)  NOT NULL DEFAULT 0,             -- 식대 (월 20만 한도)
    car_allowance            numeric(14,2)  NOT NULL DEFAULT 0,             -- 차량유지비
    childcare_allowance      numeric(14,2)  NOT NULL DEFAULT 0,             -- 육아수당
    research_allowance       numeric(14,2)  NOT NULL DEFAULT 0,             -- 연구수당
    expense_reimbursement    numeric(14,2)  NOT NULL DEFAULT 0,             -- 경비
    tuition                  numeric(14,2)  NOT NULL DEFAULT 0,             -- 학자금
    other_nontax             numeric(14,2)  NOT NULL DEFAULT 0,
    -- 공제 - 4대보험 (근로자 부담분)
    pension                  numeric(14,2)  NOT NULL DEFAULT 0,
    health                   numeric(14,2)  NOT NULL DEFAULT 0,
    long_term_care           numeric(14,2)  NOT NULL DEFAULT 0,
    employment_insurance     numeric(14,2)  NOT NULL DEFAULT 0,
    -- 공제 - 세금
    income_tax               numeric(14,2)  NOT NULL DEFAULT 0,             -- 근로소득세 (간이세액표)
    local_tax                numeric(14,2)  NOT NULL DEFAULT 0,             -- 지방소득세 = income_tax × 10%
    year_end_income_tax      numeric(14,2)  NOT NULL DEFAULT 0,             -- 연말정산 소득세 (환급 시 음수)
    year_end_local_tax       numeric(14,2)  NOT NULL DEFAULT 0,             -- 연말정산 지방소득세
    other_deduction          numeric(14,2)  NOT NULL DEFAULT 0,             -- 노조비·가불금 등
    -- 프리랜서 전용 (mode=WITHHOLDING)
    freelancer_gross         numeric(14,2)  NOT NULL DEFAULT 0,             -- 용역비 총액
    -- 스냅샷 합계
    gross_taxable            numeric(14,2)  NOT NULL DEFAULT 0,
    gross_nontax             numeric(14,2)  NOT NULL DEFAULT 0,
    total_deduction          numeric(14,2)  NOT NULL DEFAULT 0,
    net_pay                  numeric(14,2)  NOT NULL DEFAULT 0,
    memo                     text,
    created_at               timestamptz    NOT NULL DEFAULT now(),
    updated_at               timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_payroll_items_rd UNIQUE (run_id, developer_id)
);
CREATE INDEX ix_payroll_items_run ON public.payroll_items (run_id);
CREATE INDEX ix_payroll_items_dev ON public.payroll_items (developer_id);

-- 직원별 세액계산 옵션 (1:1, 부양가족 수 등).
CREATE TABLE public.developer_tax_profile (
    developer_id             uuid           PRIMARY KEY REFERENCES public.developers(id) ON DELETE CASCADE,
    dependents_count         smallint       NOT NULL DEFAULT 1,             -- 본인 포함
    elderly_dependents_count smallint       NOT NULL DEFAULT 0,
    child_dependents_count   smallint       NOT NULL DEFAULT 0,
    tax_reduction_rate       smallint       NOT NULL DEFAULT 100,           -- 80 | 100 | 120
    created_at               timestamptz    NOT NULL DEFAULT now(),
    updated_at               timestamptz    NOT NULL DEFAULT now()
);

-- 간이세액표 업로드 회차 (효력시점 버전관리).
CREATE TABLE public.withholding_tax_tables (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    effective_from           date           NOT NULL,
    source_filename          varchar(255),
    note                     varchar(500),
    created_by               uuid           REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE INDEX ix_withholding_tax_tables_eff ON public.withholding_tax_tables (effective_from DESC);

-- 세액표 1행 = (월급구간 min~max) × 부양가족수. 공제율 80/100/120%.
CREATE TABLE public.withholding_tax_rows (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id                 uuid           NOT NULL REFERENCES public.withholding_tax_tables(id) ON DELETE CASCADE,
    bracket_min              numeric(14,2)  NOT NULL,
    bracket_max              numeric(14,2)  NOT NULL,
    dependents               smallint       NOT NULL,
    tax_80                   numeric(14,2)  NOT NULL DEFAULT 0,
    tax_100                  numeric(14,2)  NOT NULL DEFAULT 0,
    tax_120                  numeric(14,2)  NOT NULL DEFAULT 0
);
CREATE INDEX ix_withholding_tax_rows_table
    ON public.withholding_tax_rows (table_id, dependents, bracket_min);

-- 명세서 배포 이력.
CREATE TABLE public.payroll_distributions (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                   uuid           NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
    developer_id             uuid           NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    method                   varchar(16)    NOT NULL DEFAULT 'EMAIL',       -- EMAIL | DOWNLOAD
    to_email                 varchar(200),
    pdf_size_bytes           integer,
    status                   varchar(16)    NOT NULL DEFAULT 'SENT',        -- SENT | FAILED
    error_msg                text,
    delivered_at             date,
    delivered_by             uuid           REFERENCES public.users(id) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
-- 게시판 (board) — 제목/내용/작성자/조회수/고정 + 첨부파일.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.board_comments     CASCADE;
DROP TABLE IF EXISTS public.board_attachments CASCADE;
DROP TABLE IF EXISTS public.board_posts       CASCADE;

CREATE TABLE public.board_posts (
    id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    title         varchar(500)   NOT NULL,
    content       text           NOT NULL DEFAULT '',
    category      varchar(20)    NOT NULL DEFAULT 'BOARD',  -- BOARD | NOTICE
    author_id     uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    is_pinned     boolean        NOT NULL DEFAULT false,
    view_count    integer        NOT NULL DEFAULT 0,
    -- 보안 역할 제한 — NULL/빈 배열 = 전체 공개. 값 있으면 그 role 만 볼 수 있음.
    -- ADMIN·작성자는 항상 통과 (API 가드).
    visible_roles varchar(20)[],
    created_at    timestamptz    NOT NULL DEFAULT now(),
    updated_at    timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_board_posts_created
    ON public.board_posts (is_pinned DESC, created_at DESC);

CREATE TABLE public.board_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id     uuid          NOT NULL REFERENCES public.board_posts(id) ON DELETE CASCADE,
    file_name   varchar(255)  NOT NULL,
    file_path   varchar(1024) NOT NULL,                   -- upload.dir 기준 상대경로
    mime_type   varchar(120),
    size        integer       NOT NULL DEFAULT 0,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_board_attachments_post ON public.board_attachments (post_id);

-- 코멘트 — TipTap HTML. 글을 볼 수 있는 사용자 누구나 작성·열람.
-- 편집/삭제는 작성자 + ADMIN. user 삭제 시 author_id NULL (코멘트 보존).
-- parent_id — 답글(대댓글) 자기참조. NULL = 루트, 값 있으면 답글. 같은
-- post 안에서만 부모 지정 가능 (API 단계 검증). N 레벨 트리 (깊이 무제한).
-- 부모 삭제 시 자식 cascade.
CREATE TABLE public.board_comments (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id     uuid        NOT NULL REFERENCES public.board_posts(id) ON DELETE CASCADE,
    parent_id   uuid                 REFERENCES public.board_comments(id) ON DELETE CASCADE,
    author_id   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
    body        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_board_comments_post   ON public.board_comments (post_id);
CREATE INDEX ix_board_comments_parent ON public.board_comments (parent_id);
CREATE INDEX ix_board_comments_author ON public.board_comments (author_id);
CREATE INDEX ix_board_comments_created ON public.board_comments (created_at);


-- -----------------------------------------------------------------------------
-- 북마크 (`bookmarks`) — 헤더 빠른 도구의 "북마크" 패널.
--
-- scope 두 가지를 한 테이블에서:
--   PERSONAL — owner_user_id 채워짐. 본인만 조회/편집.
--   COMPANY  — owner_user_id NULL. ADMIN/HR 가 Settings 에서 관리.
--              visible_roles 가 NULL/빈배열 = 전직원, 값 있으면 그 role + ADMIN.
--              (`board_posts.visible_roles` 와 동일 패턴.)
-- info 는 자유 메모 (로그인 정보 등) — 평문 저장. UI 에서 기본 마스킹 + 복사 버튼.
CREATE TABLE public.bookmarks (
    id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid           NOT NULL,
    scope          varchar(10)    NOT NULL CHECK (scope IN ('PERSONAL','COMPANY')),
    owner_user_id  uuid           REFERENCES public.users(id) ON DELETE CASCADE,
    category       varchar(50),
    label          varchar(200)   NOT NULL,
    url            text           NOT NULL,
    info           text,
    visible_roles  varchar(20)[],
    -- 정보(info) 가시성 — visible_roles 와 동일 의미 체계.
    -- NULL = row 가시 사용자 전원에게 정보 노출 (전직원 공개와 짝)
    -- [] (빈 배열) = 아무에게도 정보 미노출 (default OFF)
    -- ["HR"] = HR + ADMIN 만 정보 노출. 그 외 role 은 row 는 보되 ⓘ 없음.
    -- info_visible_roles ⊆ visible_roles ∪ {ADMIN} (UI 단계 강제).
    info_visible_roles varchar(20)[],
    sort_order     integer        NOT NULL DEFAULT 0,
    created_at     timestamptz    NOT NULL DEFAULT now(),
    updated_at     timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_bookmarks_owner    ON public.bookmarks (tenant_id, scope, owner_user_id);
CREATE INDEX ix_bookmarks_category ON public.bookmarks (tenant_id, scope, category);


-- -----------------------------------------------------------------------------
-- 캘린더 (`holidays`) — 휴일 + 일정 통합. 사이드바 "개요 > 일정" 메뉴.
-- API path 는 /calendar 이지만 테이블명은 도메인 의미("holidays") 를 유지.
-- 토/일 주말은 요일 규칙으로 판단하므로 저장하지 않음.
--
-- type 5종:
--   STATUTORY    = 법정 공휴일 (근무일 차감, 모두 공개, 시스템 시드)
--   TEMPORARY    = 임시 공휴일 (근무일 차감, 모두 공개)
--   COMPANY      = 회사 휴일   (근무일 차감, 모두 공개)
--   EVENT_PUBLIC = 공개 일정   (근무일 비차감, 모두 공개)
--   EVENT_PRIVATE= 비공개 일정 (근무일 비차감, HR/ADMIN/SUPER_ADMIN 만 가시 — 백엔드 필터)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.holidays CASCADE;

-- tenant 별 독립 — 같은 날짜라도 tenant 별로 다른 라벨 가능. 법정 공휴일은
-- 신규 tenant 생성 시 tenant_seed 가 시드, 그 외는 ADMIN/HR 이 등록.
CREATE TABLE public.holidays (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    date        date          NOT NULL,
    name        varchar(100)  NOT NULL,
    type        varchar(16)   NOT NULL DEFAULT 'TEMPORARY'
                              CHECK (type IN ('STATUTORY','TEMPORARY','COMPANY','EVENT_PUBLIC','EVENT_PRIVATE','EVENT_PERSONAL')),
    description text,
    created_by  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_holidays_date   ON public.holidays (date);
CREATE INDEX ix_holidays_tenant ON public.holidays (tenant_id);
-- broad UNIQUE 는 EVENT_PUBLIC/EVENT_PRIVATE 일정이 들어오면서 너무
-- 좁아짐 (같은 날 등록 1개로 막힘). 휴일 3종 (STATUTORY/TEMPORARY/COMPANY)
-- 만 partial unique index 로 (tenant, date) 중복 방지. 일정은 multiple OK.
CREATE UNIQUE INDEX uq_holidays_tenant_date_holiday
    ON public.holidays (tenant_id, date)
    WHERE type IN ('STATUTORY', 'TEMPORARY', 'COMPANY');

-- RLS — `app.tenant_id` 기반 격리.
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.holidays;
CREATE POLICY tenant_iso ON public.holidays
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

-- 비공개 일정 알람 수신자 (1:N) — EVENT_PRIVATE 일정에 등록된 직원에게
-- 매일 09:00 cron 이 Slack DM 발송. notified_at 채워 중복 발송 차단.
CREATE TABLE public.holiday_alarm_recipients (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL,
    holiday_id    uuid          NOT NULL REFERENCES public.holidays(id) ON DELETE CASCADE,
    developer_id  uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    notified_at   timestamptz,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_holiday_alarm_recipient UNIQUE (holiday_id, developer_id)
);
CREATE INDEX ix_har_holiday_id   ON public.holiday_alarm_recipients (holiday_id);
CREATE INDEX ix_har_developer_id ON public.holiday_alarm_recipients (developer_id);


-- 한국 법정 공휴일 seed (2024-2030, 설날/추석/부처님오신날 포함).
-- 신규 deployment 의 default tenant 에 삽입. 신규 tenant 추가 시 동일 시드를
-- tenant_seed.py 가 자동 적용.
INSERT INTO public.holidays (tenant_id, date, name, type)
SELECT t.id, v.date, v.name, v.type FROM (
  SELECT date::date, name, type FROM (VALUES
  -- 2024
  ('2024-01-01', '신정',            'STATUTORY'),
  ('2024-02-09', '설 연휴',         'STATUTORY'),
  ('2024-02-10', '설날',            'STATUTORY'),
  ('2024-02-11', '설 연휴',         'STATUTORY'),
  ('2024-02-12', '대체공휴일(설)',  'STATUTORY'),
  ('2024-03-01', '3·1절',           'STATUTORY'),
  ('2024-05-05', '어린이날',        'STATUTORY'),
  ('2024-05-06', '대체공휴일(어린이날)', 'STATUTORY'),
  ('2024-05-15', '부처님오신날',    'STATUTORY'),
  ('2024-06-06', '현충일',          'STATUTORY'),
  ('2024-08-15', '광복절',          'STATUTORY'),
  ('2024-09-16', '추석 연휴',       'STATUTORY'),
  ('2024-09-17', '추석',            'STATUTORY'),
  ('2024-09-18', '추석 연휴',       'STATUTORY'),
  ('2024-10-01', '국군의 날',       'STATUTORY'),
  ('2024-10-03', '개천절',          'STATUTORY'),
  ('2024-10-09', '한글날',          'STATUTORY'),
  ('2024-12-25', '성탄절',          'STATUTORY'),
  -- 2025
  ('2025-01-01', '신정',            'STATUTORY'),
  ('2025-01-28', '설 연휴',         'STATUTORY'),
  ('2025-01-29', '설날',            'STATUTORY'),
  ('2025-01-30', '설 연휴',         'STATUTORY'),
  ('2025-03-01', '3·1절',           'STATUTORY'),
  ('2025-03-03', '대체공휴일(3·1절)', 'STATUTORY'),
  ('2025-05-05', '어린이날/부처님오신날', 'STATUTORY'),
  ('2025-05-06', '대체공휴일',      'STATUTORY'),
  ('2025-06-06', '현충일',          'STATUTORY'),
  ('2025-08-15', '광복절',          'STATUTORY'),
  ('2025-10-03', '개천절',          'STATUTORY'),
  ('2025-10-05', '추석 연휴',       'STATUTORY'),
  ('2025-10-06', '추석',            'STATUTORY'),
  ('2025-10-07', '추석 연휴',       'STATUTORY'),
  ('2025-10-08', '대체공휴일(추석)', 'STATUTORY'),
  ('2025-10-09', '한글날',          'STATUTORY'),
  ('2025-12-25', '성탄절',          'STATUTORY'),
  -- 2026
  ('2026-01-01', '신정',            'STATUTORY'),
  ('2026-02-16', '설 연휴',         'STATUTORY'),
  ('2026-02-17', '설날',            'STATUTORY'),
  ('2026-02-18', '설 연휴',         'STATUTORY'),
  ('2026-03-01', '3·1절',           'STATUTORY'),
  ('2026-03-02', '대체공휴일(3·1절)', 'STATUTORY'),
  ('2026-05-05', '어린이날',        'STATUTORY'),
  ('2026-05-24', '부처님오신날',    'STATUTORY'),
  ('2026-05-25', '대체공휴일(부처님오신날)', 'STATUTORY'),
  ('2026-06-06', '현충일',          'STATUTORY'),
  ('2026-08-15', '광복절',          'STATUTORY'),
  ('2026-08-17', '대체공휴일(광복절)', 'STATUTORY'),
  ('2026-09-24', '추석 연휴',       'STATUTORY'),
  ('2026-09-25', '추석',            'STATUTORY'),
  ('2026-09-26', '추석 연휴',       'STATUTORY'),
  ('2026-10-03', '개천절',          'STATUTORY'),
  ('2026-10-05', '대체공휴일(개천절)', 'STATUTORY'),
  ('2026-10-09', '한글날',          'STATUTORY'),
  ('2026-12-25', '성탄절',          'STATUTORY'),
  -- 2027
  ('2027-01-01', '신정',            'STATUTORY'),
  ('2027-02-06', '설 연휴',         'STATUTORY'),
  ('2027-02-07', '설날',            'STATUTORY'),
  ('2027-02-08', '설 연휴',         'STATUTORY'),
  ('2027-02-09', '대체공휴일(설)',  'STATUTORY'),
  ('2027-03-01', '3·1절',           'STATUTORY'),
  ('2027-05-05', '어린이날',        'STATUTORY'),
  ('2027-05-13', '부처님오신날',    'STATUTORY'),
  ('2027-06-06', '현충일',          'STATUTORY'),
  ('2027-06-07', '대체공휴일(현충일)', 'STATUTORY'),
  ('2027-08-15', '광복절',          'STATUTORY'),
  ('2027-08-16', '대체공휴일(광복절)', 'STATUTORY'),
  ('2027-09-14', '추석 연휴',       'STATUTORY'),
  ('2027-09-15', '추석',            'STATUTORY'),
  ('2027-09-16', '추석 연휴',       'STATUTORY'),
  ('2027-10-03', '개천절',          'STATUTORY'),
  ('2027-10-04', '대체공휴일(개천절)', 'STATUTORY'),
  ('2027-10-09', '한글날',          'STATUTORY'),
  ('2027-12-25', '성탄절',          'STATUTORY')
  ) AS x(date, name, type)
) v
CROSS JOIN public.tenants t
WHERE t.slug = 'default'
ON CONFLICT (tenant_id, date) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 회의실 예약 (meetings)
--   - meeting_rooms                  : 관리자 CRUD 회의실 마스터
--   - meeting_reservations           : 일반 사용자가 생성하는 예약 (시간대 충돌
--                                      방지 EXCLUDE 제약)
--   - meeting_reservation_participants: 예약-임직원(developers) 다대다
--                                        (Slack 알림 대상)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.meeting_reservation_participants CASCADE;
DROP TABLE IF EXISTS public.meeting_reservations             CASCADE;
DROP TABLE IF EXISTS public.meeting_rooms                    CASCADE;

CREATE TABLE public.meeting_rooms (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    -- tenant_id 는 stage2a 부록에서 추가. 같은 이름 회의실을 tenant 별로 따로
    -- 둘 수 있도록 (tenant_id, name) 복합 UNIQUE — stage2a 부록에서 추가.
    name        varchar(100)  NOT NULL,
    location    varchar(200),
    capacity    integer,
    description text,
    is_active   boolean       NOT NULL DEFAULT true,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE public.meeting_reservations (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id      uuid          NOT NULL REFERENCES public.meeting_rooms(id) ON DELETE RESTRICT,
    organizer_id uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    title        varchar(200)  NOT NULL,
    description  text,
    start_at     timestamptz   NOT NULL,
    end_at       timestamptz   NOT NULL,
    status       varchar(16)   NOT NULL DEFAULT 'CONFIRMED',       -- CONFIRMED | CANCELLED
    notified_at  timestamptz,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT meeting_reservations_time_ck CHECK (end_at > start_at),
    -- 동일 회의실의 CONFIRMED 예약 시간대 겹침 방지 (race condition-safe).
    CONSTRAINT meeting_reservations_no_overlap EXCLUDE USING gist (
        room_id WITH =,
        tstzrange(start_at, end_at, '[)') WITH &&
    ) WHERE (status = 'CONFIRMED')
);
CREATE INDEX ix_meeting_reservations_room_time
    ON public.meeting_reservations (room_id, start_at);
CREATE INDEX ix_meeting_reservations_organizer
    ON public.meeting_reservations (organizer_id, start_at);

CREATE TABLE public.meeting_reservation_participants (
    reservation_id uuid NOT NULL REFERENCES public.meeting_reservations(id) ON DELETE CASCADE,
    developer_id   uuid NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    PRIMARY KEY (reservation_id, developer_id)
);
CREATE INDEX ix_meeting_participants_developer
    ON public.meeting_reservation_participants (developer_id);


-- -----------------------------------------------------------------------------
-- 회의록 (MeetingNote) — 본문(BlockNote JSON) + 공유 + 첨부.
--   P1: 단일 사용자 autosave. P2/P3 에서 Yjs 본문/마인드맵 collab 추가 예정.
-- -----------------------------------------------------------------------------
CREATE TABLE public.meeting_notes (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    title         varchar(300)  NOT NULL,
    customer_id   uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    project_id    uuid          REFERENCES public.projects(id)  ON DELETE SET NULL,
    -- 표시용 — 매핑된 developer (없는 admin 은 NULL).
    author_id     uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    -- 권한 판정·"내 회의록" 필터용. 매핑 유무 무관 항상 set.
    author_user_id uuid         NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    body          text,                                            -- BlockNote JSON 직렬화
    plain_text    text,                                            -- 검색용 평문 캐시
    body_yjs      bytea,                                           -- P2 협업 본문 (현재는 NULL)
    mindmap_data  jsonb,                                            -- P3-Lite 마인드맵 (reactflow nodes/edges)
    mindmap_yjs   bytea,                                           -- P3-Full 마인드맵 (현재는 NULL)
    drawio_xml    text,                                            -- 자체 호스팅 drawio iframe 의 native mxfile XML
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_meeting_notes_tenant     ON public.meeting_notes (tenant_id);
CREATE INDEX ix_meeting_notes_customer   ON public.meeting_notes (customer_id);
CREATE INDEX ix_meeting_notes_project    ON public.meeting_notes (project_id);
CREATE INDEX ix_meeting_notes_author     ON public.meeting_notes (author_id);
CREATE INDEX ix_meeting_notes_author_user ON public.meeting_notes (author_user_id);
CREATE INDEX ix_meeting_notes_updated_at ON public.meeting_notes (updated_at DESC);

ALTER TABLE public.meeting_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_notes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.meeting_notes;
CREATE POLICY tenant_iso ON public.meeting_notes
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

-- 공유 대상 — 작성자 외에 회의록을 자기 목록에서 볼 수 있는 직원.
CREATE TABLE public.meeting_note_shares (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid         NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    meeting_note_id uuid         NOT NULL REFERENCES public.meeting_notes(id) ON DELETE CASCADE,
    developer_id    uuid         NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    notified_at     timestamptz,                                    -- Slack/MM 발송 완료
    last_seen_at    timestamptz,                                    -- 마지막 열람
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_meeting_note_share UNIQUE (meeting_note_id, developer_id)
);
CREATE INDEX ix_meeting_note_shares_developer ON public.meeting_note_shares (developer_id);

ALTER TABLE public.meeting_note_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_note_shares FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.meeting_note_shares;
CREATE POLICY tenant_iso ON public.meeting_note_shares
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

-- 첨부. 디스크: data/<tenant_id>/meeting-notes/{note_id}/<uuid>.<ext>.
CREATE TABLE public.meeting_note_attachments (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    meeting_note_id uuid          NOT NULL REFERENCES public.meeting_notes(id) ON DELETE CASCADE,
    file_name       varchar(300)  NOT NULL,
    file_path       varchar(1024) NOT NULL,
    mime_type       varchar(120),
    size            bigint,
    uploaded_by     uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_meeting_note_attachments_note ON public.meeting_note_attachments (meeting_note_id);

ALTER TABLE public.meeting_note_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_note_attachments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.meeting_note_attachments;
CREATE POLICY tenant_iso ON public.meeting_note_attachments
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

-- 회의록 액션 아이템 (TODO) — 1:N. 담당자(developer) + 마감일 + 상태.
--   * 매일 09:05 KST cron(action_item_notify.cron_run_action_item_alerts) 이
--     due_date D-3 / D-1 / D-Day 미완료 항목을 담당자별로 그루핑해 Slack DM.
--   * 외부 게스트(assignee_id NULL · assignee_name 만 있음) 는 이메일 미보유로
--     자동 스킵.
--   * /my-actions 페이지가 ix_mnai_assignee_status partial index 로 본인 미완료
--     빠르게 조회.
CREATE TABLE public.meeting_note_action_items (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    -- nullable — 회의록 없는 standalone 액션 (sidebar > 내 액션 의 '+ 액션 추가') 도 허용.
    meeting_note_id uuid          REFERENCES public.meeting_notes(id) ON DELETE CASCADE,
    title           varchar(500)  NOT NULL,
    -- 담당자 — 사내 정규직 우선. 매핑 없으면 assignee_name 만 set.
    assignee_id     uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    assignee_name   varchar(120),
    due_date        date,
    status          varchar(16)   NOT NULL DEFAULT 'TODO'
                                  CHECK (status IN ('TODO','IN_PROGRESS','DONE','BLOCKED')),
    note_text       text,
    sort_order      integer       NOT NULL DEFAULT 0,
    completed_at    timestamptz,
    -- 완료 시 사용자가 남긴 한 줄 코멘트. 체크박스 체크 → DialogProvider.prompt
    -- 입력. DONE 외 상태로 다시 전이해도 보존 (히스토리 단일 슬롯).
    completion_comment text,
    -- 옵션 고객사·프로젝트 (standalone 액션에서 직접 지정 / 회의록 attached 도 override 가능).
    customer_id     uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    project_id      uuid          REFERENCES public.projects(id)  ON DELETE SET NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_mnai_note ON public.meeting_note_action_items (meeting_note_id, sort_order);
-- 미완료(open) 상태인 항목만 인덱싱 — '내 액션' 조회 효율 ↑.
CREATE INDEX ix_mnai_assignee_status ON public.meeting_note_action_items (assignee_id, status)
    WHERE status IN ('TODO','IN_PROGRESS');
CREATE INDEX ix_mnai_customer ON public.meeting_note_action_items (customer_id);
CREATE INDEX ix_mnai_project  ON public.meeting_note_action_items (project_id);

ALTER TABLE public.meeting_note_action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_note_action_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.meeting_note_action_items;
CREATE POLICY tenant_iso ON public.meeting_note_action_items
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- -----------------------------------------------------------------------------
-- 계정과목 (account_codes) — 수입·지출 항목 마스터 (예산·실적·결산의 토대).
--   kind = INCOME | EXPENSE
--   category = 자유 입력 (varchar) — 권장 enum 은 프론트에서만 안내
--   account_code/account_name = 한국 회계 표준 매핑 (선택)
--   is_pl = false → 자본·자산·부채 거래 (대출 원금/펀드/임직원 대여 등) — P&L 합산 제외
-- -----------------------------------------------------------------------------
CREATE TABLE public.account_codes (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    kind          varchar(8)    NOT NULL CHECK (kind IN ('INCOME','EXPENSE')),
    category      varchar(40)   NOT NULL,
    name          varchar(100)  NOT NULL,
    description   text,                                 -- 비고 (짧은 부제)
    usage_guide   text,                                 -- 사용 지침 (비전문가용 안내)
    account_code  varchar(10),
    account_name  varchar(50),
    is_pl         boolean       NOT NULL DEFAULT true,
    sort_order    integer       NOT NULL DEFAULT 0,
    is_active     boolean       NOT NULL DEFAULT true,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_account_code UNIQUE (tenant_id, kind, category, name)
);
CREATE INDEX ix_account_codes_kind_cat
    ON public.account_codes (tenant_id, kind, category, sort_order);

ALTER TABLE public.account_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_codes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.account_codes;
CREATE POLICY tenant_iso ON public.account_codes
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- -----------------------------------------------------------------------------
-- 정부 R&D 예산
--   * rnd_budget_plans       — 예산서(연도·프로젝트·기업규모·정부/기관/현금/현물)
--   * rnd_budget_lines       — 비목·세목·항목·단가·건수·합계 입력 라인
--   * rnd_budget_personnel   — 인건비 인력 (기존/신규 segment, 월급여·4대보험·
--                              퇴직금·개월·투입율 → 보수 합계)
--   * 비목/세목/항목 기준은 backend/app/data/rnd_*_seed.json 시드에서 로드
--     (정부 R&D 표준 산정기준·정산서류·불인정사례 — read-only)
--   * 비율 사용자 정의 (gov_funding_rate 등) — null 이면 기업규모 default 적용.
--     기관 = 1 - 정부 자동, 현금/현물은 독립 (둘 다 0% 케이스 허용)
--   * 모든 금액은 frontend 에서 10원 단위 반올림(roundWon) 후 저장
-- -----------------------------------------------------------------------------
CREATE TABLE public.rnd_budget_plans (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    year            integer       NOT NULL,
    title           varchar(200)  NOT NULL,
    project_id      uuid          REFERENCES public.projects(id)  ON DELETE SET NULL,
    customer_id     uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    funding_agency  varchar(80),
    total_amount    numeric(14,2) NOT NULL DEFAULT 0,
    -- 예산 요약 (선택) — 정부 R&D 표준 4 분할.
    company_size       varchar(8),                                -- SMALL/MID/LARGE
    total_rnd_budget   numeric(14,2),                             -- 총 연구개발비
    gov_funding_amount numeric(14,2),                             -- 정부지원금
    own_cash_amount    numeric(14,2),                             -- 기관부담금 현금
    own_inkind_amount  numeric(14,2),                             -- 기관부담금 현물
    -- 비율 사용자 정의 (null = 기업규모 default 사용). 0.0000 ~ 1.0000.
    gov_funding_rate   numeric(5,4) CHECK (gov_funding_rate IS NULL OR (gov_funding_rate >= 0 AND gov_funding_rate <= 1)),
    own_burden_rate    numeric(5,4) CHECK (own_burden_rate  IS NULL OR (own_burden_rate  >= 0 AND own_burden_rate  <= 1)),
    cash_min_rate      numeric(5,4) CHECK (cash_min_rate    IS NULL OR (cash_min_rate    >= 0 AND cash_min_rate    <= 1)),
    inkind_min_rate    numeric(5,4) CHECK (inkind_min_rate  IS NULL OR (inkind_min_rate  >= 0 AND inkind_min_rate  <= 1)),
    memo            text,
    status          varchar(16)   NOT NULL DEFAULT 'DRAFT'
                                  CHECK (status IN ('DRAFT','SUBMITTED','APPROVED')),
    created_by      uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_rnd_budget_plans_tenant_year ON public.rnd_budget_plans (tenant_id, year DESC);
CREATE INDEX ix_rnd_budget_plans_project    ON public.rnd_budget_plans (project_id);

ALTER TABLE public.rnd_budget_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rnd_budget_plans FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.rnd_budget_plans;
CREATE POLICY tenant_iso ON public.rnd_budget_plans
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

CREATE TABLE public.rnd_budget_lines (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    plan_id            uuid          NOT NULL REFERENCES public.rnd_budget_plans(id) ON DELETE CASCADE,
    category_id        varchar(40)   NOT NULL,
    category_label     varchar(60)   NOT NULL,
    subcategory_id     varchar(60)   NOT NULL,
    subcategory_label  varchar(80)   NOT NULL,
    item_id            varchar(80),
    item_label         varchar(200),
    unit_price         numeric(12,2) NOT NULL DEFAULT 0,
    quantity           numeric(10,2) NOT NULL DEFAULT 0,
    amount             numeric(14,2) NOT NULL DEFAULT 0,
    note               text,
    sort_order         integer       NOT NULL DEFAULT 0,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_rnd_budget_lines_plan
    ON public.rnd_budget_lines (plan_id, category_id, subcategory_id, sort_order);

ALTER TABLE public.rnd_budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rnd_budget_lines FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.rnd_budget_lines;
CREATE POLICY tenant_iso ON public.rnd_budget_lines
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

-- 인건비 인력 — rnd_budget_lines 의 보수(personnel-salary) 행을 매칭하기 위한
-- 인력별 명세. plan_id 별 N개 (기존/신규 segment 분리).
--   segment = EXISTING — 이미 정규직(staff-picker 콤보로 선택, 자동 채움)
--             NEW      — 입사 6개월 이내 또는 미입사 (콤보 선택 가능, 미선택 시
--                        저장 단계에서 빈 이름 행 자동 스킵)
--   투입 금액 = roundWon(((salary + insurance) * 12 + severance) / 12
--                      * months * ratio_pct / 100)
--   * staff-picker 자동 채움: monthly_salary = 연봉/12,
--                             monthly_insurance = developer_salaries.estimated_employer_insurance_monthly,
--                             severance_annual = monthly_salary (1개월분),
--                             role             = developers.title
CREATE TABLE public.rnd_budget_personnel (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    plan_id           uuid          NOT NULL REFERENCES public.rnd_budget_plans(id) ON DELETE CASCADE,
    segment           varchar(16)   NOT NULL CHECK (segment IN ('EXISTING','NEW')),
    name              varchar(80)   NOT NULL,
    role              varchar(80),
    monthly_salary    numeric(12,2) NOT NULL DEFAULT 0,
    monthly_insurance numeric(12,2) NOT NULL DEFAULT 0,
    severance_annual  numeric(12,2) NOT NULL DEFAULT 0,
    months            numeric(5,2)  NOT NULL DEFAULT 0,
    ratio_pct         numeric(5,2)  NOT NULL DEFAULT 0,
    sort_order        integer       NOT NULL DEFAULT 0,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_rnd_budget_personnel_plan ON public.rnd_budget_personnel (plan_id, segment, sort_order);

ALTER TABLE public.rnd_budget_personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rnd_budget_personnel FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.rnd_budget_personnel;
CREATE POLICY tenant_iso ON public.rnd_budget_personnel
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- -----------------------------------------------------------------------------
-- 운영 예산 계획 — 연도별 12개월 지출 예산
--   * budget_calc_plans  — 연도·제목·메모
--   * budget_calc_lines  — 비목(account_codes EXPENSE) + m1~m12 월별 금액
--   * 비목 그룹핑은 account_codes.category 로 (UI 에서 카테고리별 소계)
--   * 단위: 그리드 표시 천원, DB 저장 원
-- -----------------------------------------------------------------------------
CREATE TABLE public.budget_calc_plans (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    year         integer       NOT NULL,
    title        varchar(200)  NOT NULL,
    memo         text,
    created_by   uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_budget_calc_plans_tenant_year ON public.budget_calc_plans (tenant_id, year DESC);

ALTER TABLE public.budget_calc_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_calc_plans FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.budget_calc_plans;
CREATE POLICY tenant_iso ON public.budget_calc_plans
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

CREATE TABLE public.budget_calc_lines (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    plan_id         uuid          NOT NULL REFERENCES public.budget_calc_plans(id) ON DELETE CASCADE,
    account_code_id uuid          REFERENCES public.account_codes(id) ON DELETE SET NULL,
    item_label      varchar(200),
    m1              numeric(14,2) NOT NULL DEFAULT 0,
    m2              numeric(14,2) NOT NULL DEFAULT 0,
    m3              numeric(14,2) NOT NULL DEFAULT 0,
    m4              numeric(14,2) NOT NULL DEFAULT 0,
    m5              numeric(14,2) NOT NULL DEFAULT 0,
    m6              numeric(14,2) NOT NULL DEFAULT 0,
    m7              numeric(14,2) NOT NULL DEFAULT 0,
    m8              numeric(14,2) NOT NULL DEFAULT 0,
    m9              numeric(14,2) NOT NULL DEFAULT 0,
    m10             numeric(14,2) NOT NULL DEFAULT 0,
    m11             numeric(14,2) NOT NULL DEFAULT 0,
    m12             numeric(14,2) NOT NULL DEFAULT 0,
    note            text,
    sort_order      integer       NOT NULL DEFAULT 0,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_budget_calc_lines_plan ON public.budget_calc_lines (plan_id, sort_order);

ALTER TABLE public.budget_calc_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_calc_lines FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.budget_calc_lines;
CREATE POLICY tenant_iso ON public.budget_calc_lines
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- -----------------------------------------------------------------------------
-- 연차 (leave) — 법정/포상/신청/배분 원장
--   - leave_balances              : 연도별 법정 연차 잔여 (관리자 초기화)
--   - leave_accruals              : 월 개근 적립 이력 (최대 11일 상한)
--   - leave_reward_grants         : 포상 연차 부여 원장 (이월·누적)
--   - leave_requests              : 신청 본체
--   - leave_request_allocations   : 신청이 어느 원장에서 얼마를 뺐는지
--   - leave_reset_history         : 초기화 감사
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.leave_request_allocations CASCADE;
DROP TABLE IF EXISTS public.leave_requests            CASCADE;
DROP TABLE IF EXISTS public.leave_reward_grants       CASCADE;
DROP TABLE IF EXISTS public.leave_accruals            CASCADE;
DROP TABLE IF EXISTS public.leave_balances            CASCADE;
DROP TABLE IF EXISTS public.leave_reset_history       CASCADE;

CREATE TABLE public.leave_balances (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id     uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    year             integer       NOT NULL,
    granted_days     numeric(4,1)  NOT NULL DEFAULT 0.0,
    used_days        numeric(4,1)  NOT NULL DEFAULT 0.0,
    pending_days     numeric(4,1)  NOT NULL DEFAULT 0.0,
    accrual_strategy varchar(20)   NOT NULL DEFAULT 'ANNUAL_15',
    initialized_at   timestamptz,
    initialized_by   uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_leave_balance_dev_year UNIQUE (developer_id, year)
);
CREATE INDEX ix_leave_balances_dev  ON public.leave_balances(developer_id);
CREATE INDEX ix_leave_balances_year ON public.leave_balances(year);

CREATE TABLE public.leave_accruals (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    year         integer       NOT NULL,
    month        integer       NOT NULL,
    days         numeric(3,1)  NOT NULL DEFAULT 1.0,
    reason       varchar(40)   NOT NULL DEFAULT 'PERFECT_ATTENDANCE',
    created_at   timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_leave_accrual_dev_year_month UNIQUE (developer_id, year, month)
);
CREATE INDEX ix_leave_accruals_dev ON public.leave_accruals(developer_id);

CREATE TABLE public.leave_reward_grants (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id   uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    granted_days   numeric(4,1)  NOT NULL,
    remaining_days numeric(4,1)  NOT NULL,
    reason         varchar(200)  NOT NULL,
    granted_at     timestamptz   NOT NULL DEFAULT now(),
    granted_by     uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    revoked_at     timestamptz,
    revoked_by     uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    revoked_reason text,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_leave_reward_grants_dev ON public.leave_reward_grants(developer_id);

CREATE TABLE public.leave_requests (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id      uuid          NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    requester_user_id uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    leave_type        varchar(20)   NOT NULL,   -- ANNUAL | HALF | UNPAID_PUBLIC
    half_kind         varchar(4),               -- AM | PM (HALF 전용)
    category          varchar(30),              -- RESERVE_DUTY 등 (UNPAID_PUBLIC 전용)
    start_date        date          NOT NULL,
    end_date          date          NOT NULL,
    days_total        numeric(4,1)  NOT NULL,
    status            varchar(16)   NOT NULL DEFAULT 'PENDING',  -- PENDING|APPROVED|REJECTED|CANCELLED
    reason            text,
    evidence_path     varchar(500),
    approver_user_id  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at       timestamptz,
    rejected_reason   text,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_leave_requests_half_day_unit
        CHECK ((days_total * 2) = floor(days_total * 2)),
    CONSTRAINT ck_leave_requests_min_days    CHECK (days_total >= 0.5),
    CONSTRAINT ck_leave_requests_date_order  CHECK (end_date >= start_date)
);
CREATE INDEX ix_leave_requests_dev    ON public.leave_requests(developer_id);
CREATE INDEX ix_leave_requests_status ON public.leave_requests(status);
CREATE INDEX ix_leave_requests_start  ON public.leave_requests(start_date);
CREATE INDEX ix_leave_requests_end    ON public.leave_requests(end_date);

CREATE TABLE public.leave_request_allocations (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id  uuid          NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
    source_type varchar(16)   NOT NULL,   -- STATUTORY | REWARD
    year        integer,                  -- STATUTORY 일 때 balance year
    grant_id    uuid          REFERENCES public.leave_reward_grants(id) ON DELETE RESTRICT,
    days        numeric(4,1)  NOT NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_leave_alloc_source_shape CHECK (
        (source_type = 'STATUTORY' AND year IS NOT NULL AND grant_id IS NULL) OR
        (source_type = 'REWARD'    AND year IS NULL     AND grant_id IS NOT NULL)
    ),
    CONSTRAINT ck_leave_alloc_positive_days CHECK (days > 0)
);
CREATE INDEX ix_leave_alloc_request ON public.leave_request_allocations(request_id);
CREATE INDEX ix_leave_alloc_grant   ON public.leave_request_allocations(grant_id);

CREATE TABLE public.leave_reset_history (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    year          integer       NOT NULL,
    developer_id  uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    strategy      varchar(20)   NOT NULL,
    granted_days  numeric(4,1)  NOT NULL,
    reset_by      uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    reset_at      timestamptz   NOT NULL DEFAULT now(),
    note          text
);
CREATE INDEX ix_leave_reset_year ON public.leave_reset_history(year);


-- -----------------------------------------------------------------------------
-- 메뉴별 역할 권한 (menu_permissions) — Sidebar 메뉴 표시 여부 제어.
-- ADMIN 은 하드코딩으로 항상 모든 메뉴를 보므로 이 테이블에 저장하지 않음.
-- 비어 있으면 API 에서 기본값(ROLE_PERMS 기반 seed) 을 반환.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.menu_permissions CASCADE;

-- tenant_id 컬럼은 Stage 2a 부록의 ALTER 에서 추가됨.
-- PK 는 (tenant_id, menu_key, role) — Stage 5 부록에서 변경.
CREATE TABLE public.menu_permissions (
    menu_key varchar(64) NOT NULL,
    role     varchar(16) NOT NULL,
    PRIMARY KEY (menu_key, role)
);
CREATE INDEX ix_menu_permissions_role ON public.menu_permissions (role);


-- -----------------------------------------------------------------------------
-- 기능별 역할 권한 (feature_permissions) — 페이지 내부의 버튼·필드·탭 통제.
-- 예: employees.salary.view, employees.password.reset, employees.tab.passport
-- ADMIN 은 하드코딩으로 모든 기능 허용 → 이 테이블에 저장하지 않음.
-- 비어 있으면 API 가 DEFAULT_FEATURE_PERMISSIONS 를 seed 후 반환.
-- -----------------------------------------------------------------------------
CREATE TABLE public.feature_permissions (
    tenant_id   uuid       NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    feature_key varchar(64) NOT NULL,
    role        varchar(16) NOT NULL,
    PRIMARY KEY (tenant_id, feature_key, role)
);
CREATE INDEX ix_feature_permissions_tenant ON public.feature_permissions (tenant_id);
CREATE INDEX ix_feature_permissions_role ON public.feature_permissions (role);


-- -----------------------------------------------------------------------------
-- 사용자별 기능 부여(user_feature_grants) — feature_permissions(role 단위) 와
-- 별개. 특정 user 개인에게 ADMIN role 없이 일부 기능만 위임 허용 (예: SALES 인
-- 한 명에게만 주간보고 전체 조회 허용). 카탈로그는 backend 의
-- KNOWN_GRANTABLE_FEATURES 가 화이트리스트.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.user_feature_grants CASCADE;
CREATE TABLE public.user_feature_grants (
    tenant_id          uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    user_id            uuid        NOT NULL REFERENCES public.users(id)   ON DELETE CASCADE,
    feature_key        varchar(64) NOT NULL,
    granted_by_user_id uuid        REFERENCES public.users(id)            ON DELETE SET NULL,
    granted_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, feature_key)
);
CREATE INDEX ix_user_feature_grants_tenant ON public.user_feature_grants (tenant_id);
CREATE INDEX ix_user_feature_grants_user   ON public.user_feature_grants (user_id);


-- -----------------------------------------------------------------------------
-- 사용자별 메뉴 부여(user_menu_grants) — menu_permissions(role 단위) 와 별개.
-- 특정 user 한 명에게만 사이드바 메뉴를 추가 노출 (전사 role 매트릭스 미변경).
-- 사이드바 필터 = role 매트릭스 OR me.menu_grants. 부정(빼앗기) 미지원.
-- 부여는 ADMIN/SUPER_ADMIN/HR.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.user_menu_grants CASCADE;
CREATE TABLE public.user_menu_grants (
    tenant_id          uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    user_id            uuid        NOT NULL REFERENCES public.users(id)   ON DELETE CASCADE,
    menu_key           varchar(64) NOT NULL,
    granted_by_user_id uuid        REFERENCES public.users(id)            ON DELETE SET NULL,
    granted_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, menu_key)
);
CREATE INDEX ix_user_menu_grants_tenant ON public.user_menu_grants (tenant_id);
CREATE INDEX ix_user_menu_grants_user   ON public.user_menu_grants (user_id);


-- -----------------------------------------------------------------------------
-- 회사 자산(company_assets) — 책상/노트북/모니터 등 내부 운영 자산.
-- asset_no(DDA-YYYY-XXXX, XXXX = Crockford base32 랜덤 4자) 로 QR 라벨을 인쇄해
-- 부착. 삭제는 status=DISPOSED 로 소프트.
-- 사진은 1장만 column 기반 저장 (data/assets/<id>/<uuid>.<ext>).
-- -----------------------------------------------------------------------------
CREATE TABLE public.company_assets (
    id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_no          varchar(32)  NOT NULL UNIQUE,                      -- DDA-2026-J7K2
    category          varchar(20)  NOT NULL,                             -- LAPTOP | DESK | MONITOR | ...
    manufacturer      varchar(200),                                      -- 제조사 (예: Apple)
    model_name        varchar(200),                                      -- 제품명 (예: MacBook Pro 16")
    serial_no         varchar(120),                                      -- 일련번호 (제조사 시리얼)
    spec              text,                                              -- 상세 사양 (자유 텍스트)
    purchase_date     date,
    purchase_vendor   varchar(200),                                      -- 구입처
    purchase_price    numeric(14, 2),                                    -- 구입 금액(원)
    warranty_expires  date,                                              -- AS 만료일
    owner_id          uuid         REFERENCES public.developers(id) ON DELETE SET NULL,
    status            varchar(20)  NOT NULL DEFAULT 'IN_USE',            -- IN_USE | IN_STORAGE | DISPOSED
    location          varchar(200),                                      -- 위치/부서
    memo              text,
    -- 사진 1장
    photo_name        varchar(255),
    photo_path        varchar(1024),
    photo_mime        varchar(120),
    photo_size        integer,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_company_assets_category ON public.company_assets (category);
CREATE INDEX ix_company_assets_owner    ON public.company_assets (owner_id);
CREATE INDEX ix_company_assets_status   ON public.company_assets (status);


-- 법인 차량(company_cars) — 리스/렌트/소유 차량 CRUD · 보험·등록증 파일첨부.
CREATE TABLE public.company_cars (
    id               uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    manufacturer     varchar(100)   NOT NULL,
    model            varchar(100)   NOT NULL,
    year             integer,                                                  -- YYYY
    plate_no         varchar(30),                                              -- 차량번호
    vin              varchar(50),                                              -- 차대번호
    contract_type    varchar(20)    NOT NULL DEFAULT 'OWNED',                  -- LEASE | RENT | OWNED
    contract_start   date,
    contract_end     date,
    contract_company varchar(200),
    insurer          varchar(200),
    insurer_phone    varchar(50),
    insurance_start  date,
    insurance_end    date,
    vehicle_price    numeric(14, 2),                                           -- 차량 취득가
    monthly_payment  numeric(14, 2),                                           -- 월 납입금
    memo             text,
    manager_id       uuid           REFERENCES public.developers(id) ON DELETE SET NULL,
    created_at       timestamptz    NOT NULL DEFAULT now(),
    updated_at       timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_company_cars_manager ON public.company_cars (manager_id);
CREATE INDEX ix_company_cars_ins_end ON public.company_cars (insurance_end);


-- 법인 차량 첨부파일. slot 당 1건 (INSURANCE=보험증서, REGISTRATION=자동차 등록증).
CREATE TABLE public.company_car_attachments (
    id         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    car_id     uuid         NOT NULL REFERENCES public.company_cars(id) ON DELETE CASCADE,
    slot       varchar(30)  NOT NULL,
    file_name  varchar(300) NOT NULL,
    file_path  varchar(1024) NOT NULL,
    mime_type  varchar(120),
    size       bigint,
    created_at timestamptz  NOT NULL DEFAULT now(),
    updated_at timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_company_car_attachment_slot UNIQUE (car_id, slot)
);


-- 회사 보험(company_insurances) — 보험 납입·상태 관리 + 자유 다파일 첨부.
CREATE TABLE public.company_insurances (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    insurer         varchar(200) NOT NULL,
    name            varchar(200) NOT NULL,                                     -- 보험명
    planner_name    varchar(100),
    planner_phone   varchar(50),
    planner_email   varchar(200),
    monthly_payment numeric(14, 2),                                            -- 월 납입금
    final_amount    numeric(14, 2),                                            -- 최종 납입금액
    payment_start   date,
    payment_end     date,
    status          varchar(20)  NOT NULL DEFAULT 'PAYING',                    -- PAYING|SUSPENDED|COMPLETED|CANCELED
    memo            text,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_company_insurances_status ON public.company_insurances (status);


-- 회사 보험 첨부(다파일). slot 없음 — 보험증서·약관·갱신서 등 자유.
CREATE TABLE public.company_insurance_attachments (
    id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    insurance_id  uuid         NOT NULL REFERENCES public.company_insurances(id) ON DELETE CASCADE,
    file_name     varchar(300) NOT NULL,
    file_path     varchar(1024) NOT NULL,
    mime_type     varchar(120),
    size          bigint,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_company_insurance_att_insurance
    ON public.company_insurance_attachments (insurance_id);


-- -----------------------------------------------------------------------------
-- 런타임 설정 (app_settings) — config.yaml 을 UI 에서 오버라이드.
-- 섹션당 1 row, JSONB 에 editable 필드만 담아 저장.
-- -----------------------------------------------------------------------------
-- tenant_id 컬럼 + (tenant_id, section) 복합 unique 는 Stage 8 부록에서 적용.
-- 신규 설치 시에도 부록의 ALTER 가 자동 실행됨.
CREATE TABLE public.app_settings (
    id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    section     varchar(40)  NOT NULL,
    value       jsonb        NOT NULL,
    updated_at  timestamptz  NOT NULL DEFAULT now(),
    updated_by  uuid         REFERENCES public.users(id) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
-- 전자세금계산서 (tax_invoices) — 바로빌 API 수집 기록.
-- 매일 새벽 03:00 GetDailyTaxInvoice{Sales,Purchase}List 로 최근 3일치 upsert.
-- approval_no UNIQUE 로 중복 방지. PDF 는 data/tax_invoices/YYYY/MM/ 에 저장.
-- -----------------------------------------------------------------------------
CREATE TABLE public.tax_invoices (
    id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    kind               varchar(10)  NOT NULL,               -- PURCHASE | SALES
    status             varchar(20)  NOT NULL DEFAULT 'ISSUED',
    approval_no        varchar(30)  NOT NULL UNIQUE,        -- NTS 승인번호
    mgt_key            varchar(40),                          -- 바로빌 문서번호 (PDF 조회용)
    issue_date         date         NOT NULL,
    written_date       date,
    supplier_biz_no    varchar(20),
    supplier_name      varchar(200),
    supplier_ceo       varchar(100),
    buyer_biz_no       varchar(20),
    buyer_name         varchar(200),
    buyer_ceo          varchar(100),
    supply_amount      numeric(14, 2) NOT NULL DEFAULT 0,
    tax_amount         numeric(14, 2) NOT NULL DEFAULT 0,
    total_amount       numeric(14, 2) NOT NULL DEFAULT 0,
    tax_type           varchar(20),                          -- TAX | NONTAX | ZERO
    issue_type         varchar(20),                          -- NORMAL | MODIFIED
    source             varchar(40)  NOT NULL DEFAULT 'barobill',
    external_id        varchar(100),
    raw_payload        jsonb,
    linked_customer_id uuid         REFERENCES public.customers(id) ON DELETE SET NULL,
    linked_invoice_id  uuid         REFERENCES public.invoices(id) ON DELETE SET NULL,
    linked_project_id  uuid         REFERENCES public.projects(id) ON DELETE SET NULL,
    pdf_path           varchar(1024),
    memo               text,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_tax_invoices_kind_date        ON public.tax_invoices (kind, issue_date DESC);
CREATE INDEX ix_tax_invoices_supplier_biz     ON public.tax_invoices (supplier_biz_no);
CREATE INDEX ix_tax_invoices_buyer_biz        ON public.tax_invoices (buyer_biz_no);
CREATE INDEX ix_tax_invoices_linked_customer  ON public.tax_invoices (linked_customer_id);
CREATE INDEX ix_tax_invoices_linked_invoice   ON public.tax_invoices (linked_invoice_id);
CREATE INDEX ix_tax_invoices_linked_project   ON public.tax_invoices (linked_project_id);

CREATE TABLE public.tax_invoice_items (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_invoice_id  uuid          NOT NULL REFERENCES public.tax_invoices(id) ON DELETE CASCADE,
    position        integer       NOT NULL DEFAULT 0,
    item_name       varchar(200),
    spec            varchar(200),
    quantity        numeric(14, 3),
    unit_price      numeric(14, 2),
    supply_amount   numeric(14, 2),
    tax_amount      numeric(14, 2),
    memo            text
);
CREATE INDEX ix_tax_invoice_items_invoice ON public.tax_invoice_items (tax_invoice_id);

CREATE TABLE public.tax_invoice_fetches (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           varchar(10)   NOT NULL,                  -- SALES | PURCHASE
    method         varchar(20)   NOT NULL,                  -- DAILY | PERIOD
    period_start   date,
    period_end     date,
    trigger_kind   varchar(30)   NOT NULL DEFAULT 'MANUAL', -- SCHEDULED_DAILY | MANUAL
    source         varchar(40)   NOT NULL DEFAULT 'barobill',
    triggered_by   uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    status         varchar(20)   NOT NULL DEFAULT 'SUCCESS',
    fetched_count  integer       NOT NULL DEFAULT 0,
    created_count  integer       NOT NULL DEFAULT 0,
    updated_count  integer       NOT NULL DEFAULT 0,
    skipped_count  integer       NOT NULL DEFAULT 0,
    error_message  text,
    started_at     timestamptz   NOT NULL,
    finished_at    timestamptz
);
CREATE INDEX ix_tax_invoice_fetches_started ON public.tax_invoice_fetches (started_at DESC);


-- =============================================================================
-- 클라우드 비용 (Cloud cost — AWS / Azure / GCP)
-- =============================================================================
--
-- 매일 1회 스케줄러가 각 provider 의 일일 비용을 service 별로 가져와 UPSERT.
-- (provider, account_id, usage_date, service) 가 자연키. service NULL = 합계 row.
--
-- 자격증명은 app_settings.cloud_cost 에 Fernet 암호화하여 저장 (db.sql 직접
-- 노출 X). KRW 환산은 services/exchange 의 환율을 적용해 amount_krw 캐시.

-- tenant_id 는 stage 2b 의 ADD COLUMN IF NOT EXISTS 로도 추가되지만, UNIQUE
-- 자연키에 포함시키려고 여기서 직접 NOT NULL 로 선언. (Stage 2b 는 idempotent.)
CREATE TABLE public.cloud_costs (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    provider    varchar(20)   NOT NULL,                -- AWS | AZURE | GCP
    account_id  varchar(120)  NOT NULL,
    usage_date  date          NOT NULL,
    service     varchar(120),                          -- NULL = account 합계 row
    currency    varchar(8)    NOT NULL DEFAULT 'USD',
    amount      numeric(18, 4) NOT NULL DEFAULT 0,
    amount_krw  numeric(18, 4),
    raw         jsonb,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    -- service 가 NULL 이면 PostgreSQL UNIQUE 가 NULL 들끼리 충돌하지 않으므로,
    -- service.py 가 service='' (빈문자열) 로 채워 단일 합계 row 보장.
    CONSTRAINT uq_cloud_costs_natural UNIQUE (tenant_id, provider, account_id, usage_date, service)
);
CREATE INDEX ix_cloud_costs_provider_date ON public.cloud_costs (provider, usage_date DESC);
CREATE INDEX ix_cloud_costs_account       ON public.cloud_costs (account_id);
CREATE INDEX ix_cloud_costs_usage_date    ON public.cloud_costs (usage_date DESC);

CREATE TABLE public.cloud_cost_fetches (
    id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid          NOT NULL,
    provider       varchar(20)   NOT NULL,                -- AWS | AZURE | GCP
    period_start   date,
    period_end     date,
    trigger_kind   varchar(30)   NOT NULL DEFAULT 'MANUAL', -- SCHEDULED_DAILY | MANUAL
    triggered_by   uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    status         varchar(20)   NOT NULL DEFAULT 'SUCCESS', -- SUCCESS | FAILED | PARTIAL | SKIPPED
    fetched_count  integer       NOT NULL DEFAULT 0,
    created_count  integer       NOT NULL DEFAULT 0,
    updated_count  integer       NOT NULL DEFAULT 0,
    skipped_count  integer       NOT NULL DEFAULT 0,
    error_message  text,
    started_at     timestamptz   NOT NULL,
    finished_at    timestamptz
);
CREATE INDEX ix_cloud_cost_fetches_started ON public.cloud_cost_fetches (started_at DESC);

-- 알람 규칙 + 이벤트 (Tier 1+2: DAILY_THRESHOLD / MONTHLY_FORECAST / FETCH_FAILED /
-- DAY_OVER_DAY_PERCENT / NEW_SERVICE). 일일 cloud cost 수집 후 evaluator 가 평가.
CREATE TABLE public.cloud_cost_alert_rules (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid          NOT NULL,
    name                varchar(200)  NOT NULL,
    enabled             boolean       NOT NULL DEFAULT true,
    rule_type           varchar(40)   NOT NULL,
    provider            varchar(20),                            -- AWS | AZURE | GCP | NULL(전체)
    account_id          varchar(120),
    threshold_krw       integer,
    threshold_percent   integer,
    -- 발송 대상 override — NULL/빈 배열이면 tenant default 사용.
    notify_channels     text[],
    notify_user_emails  text[],
    notify_user_ids     text[],
    last_fired_at       timestamptz,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_cloud_cost_alert_rules_tenant  ON public.cloud_cost_alert_rules (tenant_id);
CREATE INDEX ix_cloud_cost_alert_rules_enabled ON public.cloud_cost_alert_rules (enabled);

CREATE TABLE public.cloud_cost_alert_events (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL,
    rule_id       uuid          NOT NULL REFERENCES public.cloud_cost_alert_rules(id) ON DELETE CASCADE,
    -- (rule_id, dedup_key) UNIQUE 로 중복 발송 방지. 예: 'DAILY:2026-04-29'.
    dedup_key     varchar(200)  NOT NULL,
    fired_at      timestamptz   NOT NULL,
    message       text          NOT NULL,
    payload       jsonb,
    delivered     boolean       NOT NULL DEFAULT false,
    error_message text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_cloud_cost_alert_events_dedup UNIQUE (rule_id, dedup_key)
);
CREATE INDEX ix_cloud_cost_alert_events_rule   ON public.cloud_cost_alert_events (rule_id, fired_at DESC);
CREATE INDEX ix_cloud_cost_alert_events_tenant ON public.cloud_cost_alert_events (tenant_id);


-- =============================================================================
-- 매입 인보이스 (Vendor bills)
-- =============================================================================
--
-- 외부 vendor 가 우리에게 발행한 청구서. 한국 전자세금계산서(tax_invoices PURCHASE)
-- 가 자동 수집되는 반면, 이건 세금계산서가 아닌 모든 수신 청구를 수동/반자동
-- 입력. 영수증 1장 column-기반 첨부, tax_invoices·bank_transactions 와 nullable
-- FK 로 매칭 가능.

CREATE TABLE public.vendor_bills (
    id                          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid          NOT NULL,
    vendor_name                 varchar(200)  NOT NULL,
    vendor_biz_no               varchar(20),
    customer_id                 uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    delivery_customer_id        uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    quote_id                    uuid          REFERENCES public.quotes(id) ON DELETE SET NULL,
    project_id                  uuid          REFERENCES public.projects(id) ON DELETE SET NULL,
    title                       varchar(200),
    invoice_no                  varchar(80),
    po_no                       varchar(80),
    sales_order_no              varchar(80),
    bill_date                   date          NOT NULL,
    due_date                    date,
    category                    varchar(40)   NOT NULL DEFAULT 'OTHER',
    currency                    varchar(8)    NOT NULL DEFAULT 'USD',
    tax_mode                    varchar(16)   NOT NULL DEFAULT 'EXCLUSIVE',
    amount                      numeric(18, 2) NOT NULL DEFAULT 0,
    tax_amount                  numeric(18, 2) NOT NULL DEFAULT 0,
    -- 합계 = amount + tax_amount, DB 가 자동 계산. INSERT/UPDATE 시 직접 set 불가.
    total_amount                numeric(18, 2) GENERATED ALWAYS AS (amount + tax_amount) STORED,
    payment_status              varchar(16)   NOT NULL DEFAULT 'UNPAID',
    paid_amount                 numeric(18, 2) NOT NULL DEFAULT 0,
    paid_at                     date,
    memo                        text,
    linked_tax_invoice_id       uuid          REFERENCES public.tax_invoices(id) ON DELETE SET NULL,
    linked_bank_transaction_id  uuid          REFERENCES public.bank_transactions(id) ON DELETE SET NULL,
    created_by                  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at                  timestamptz   NOT NULL DEFAULT now(),
    updated_at                  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_vendor_bills_vendor   ON public.vendor_bills (vendor_name);
CREATE INDEX ix_vendor_bills_customer          ON public.vendor_bills (customer_id);
CREATE INDEX ix_vendor_bills_delivery_customer ON public.vendor_bills (delivery_customer_id);
CREATE INDEX ix_vendor_bills_quote             ON public.vendor_bills (quote_id);
CREATE INDEX ix_vendor_bills_project           ON public.vendor_bills (project_id);
CREATE INDEX ix_vendor_bills_date     ON public.vendor_bills (bill_date DESC);
CREATE INDEX ix_vendor_bills_category ON public.vendor_bills (category);
CREATE INDEX ix_vendor_bills_status   ON public.vendor_bills (payment_status);
CREATE INDEX ix_vendor_bills_link_ti  ON public.vendor_bills (linked_tax_invoice_id);
CREATE INDEX ix_vendor_bills_link_bt  ON public.vendor_bills (linked_bank_transaction_id);

CREATE TABLE public.vendor_bill_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    bill_id     uuid          NOT NULL REFERENCES public.vendor_bills(id) ON DELETE CASCADE,
    file_name   varchar(255)  NOT NULL,
    file_path   varchar(1024) NOT NULL,
    mime_type   varchar(120),
    size        integer,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_vendor_bill_attachments_bill ON public.vendor_bill_attachments (bill_id);


-- =============================================================================
-- 이벤트 — 워크샵 / 컨퍼런스 / 출장 (Events)
-- =============================================================================
--
-- 회사가 참여하는 워크샵·컨퍼런스·출장의 일정·장소·항공권·숙박·참석자·첨부 통합.
-- 참석자는 사내 developer FK 또는 외부 게스트(이름만) 둘 다 지원. 모든 비용 KRW.
-- kind = WORKSHOP | CONFERENCE | BUSINESS_TRIP. 비용 분류:
--   budget       = 사전 책정 예산
--   actual_cost  = 실제 소요 금액 (참가비·스폰서·부스·경품 모두 포함)
--   entry_fee    = 컨퍼런스 참가비 / 행사 스폰서 비용
--   expenses     = 실비 — 교통비·식대 등 (참가비·소요금액과 별도)
-- plan: 메모장 스타일의 자유 입력 (일정·준비물·체크리스트 등 plain text).

CREATE TABLE public.events (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    kind        varchar(20)   NOT NULL,                          -- WORKSHOP | CONFERENCE | BUSINESS_TRIP
    title       varchar(200)  NOT NULL,
    address     text,
    start_date  date          NOT NULL,
    end_date    date          NOT NULL,
    budget      numeric(18,2) NOT NULL DEFAULT 0,                -- 사전 책정 예산 (KRW)
    actual_cost numeric(18,2) NOT NULL DEFAULT 0,                -- 실제 소요 금액 (KRW)
    entry_fee   numeric(18,2) NOT NULL DEFAULT 0,                -- 참가비 (KRW)
    expenses    numeric(18,2) NOT NULL DEFAULT 0,                -- 실비 — 교통비·식대 등 (KRW)
    memo        text,
    plan        text,                                            -- 상세 계획 (메모장 스타일 plain text)
    created_by  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_events_kind        ON public.events (kind);
CREATE INDEX ix_events_start_date  ON public.events (start_date DESC);

CREATE TABLE public.event_flights (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid          NOT NULL,
    event_id            uuid          NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    position            integer       NOT NULL DEFAULT 0,
    airline             varchar(120),
    booking_ref         varchar(80),
    ticket_no           varchar(80),
    flight_no           varchar(40),
    departure_airport   varchar(120),
    departure_terminal  varchar(40),
    arrival_airport     varchar(120),
    arrival_terminal    varchar(40),
    seat_class          varchar(40),
    departure_at        timestamptz,
    arrival_at          timestamptz,
    cost                numeric(18, 2) NOT NULL DEFAULT 0,
    memo                text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_event_flights_event ON public.event_flights (event_id);

CREATE TABLE public.event_lodgings (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL,
    event_id        uuid          NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    position        integer       NOT NULL DEFAULT 0,
    name            varchar(200),
    address         text,
    phone           varchar(40),
    email           varchar(120),
    check_in_date   date,
    check_out_date  date,
    cost            numeric(18, 2) NOT NULL DEFAULT 0,
    memo            text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_event_lodgings_event ON public.event_lodgings (event_id);

CREATE TABLE public.event_participants (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL,
    event_id      uuid          NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    position      integer       NOT NULL DEFAULT 0,
    -- developer_id 가 set 이면 사내 임직원, NULL 이면 guest_name 으로 외부 참석자.
    developer_id  uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    guest_name    varchar(120),
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    -- 같은 developer 가 한 event 에 중복 등록되지 않도록.
    CONSTRAINT uq_event_participants_dev UNIQUE (event_id, developer_id)
);
CREATE INDEX ix_event_participants_event ON public.event_participants (event_id);
CREATE INDEX ix_event_participants_dev   ON public.event_participants (developer_id);

CREATE TABLE public.event_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    event_id    uuid          NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    file_name   varchar(255)  NOT NULL,
    file_path   varchar(1024) NOT NULL,
    mime_type   varchar(120),
    size        integer,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_event_attachments_event ON public.event_attachments (event_id);


-- =============================================================================
-- 제품 카탈로그 — vendors / products / product_versions
-- =============================================================================
-- 지원(케이스/로그) 및 라이센스 도메인이 공용으로 참조. tenant 단위 격리.
-- 신규 케이스/로그/라이센스 저장 시 이름 lookup-or-create 로 자동 채워짐.
-- 삭제: ON DELETE RESTRICT — 참조하는 도메인 row 가 있으면 409.

CREATE TABLE public.vendors (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    name        varchar(120)  NOT NULL,
    is_active   boolean       NOT NULL DEFAULT true,
    sort_order  integer       NOT NULL DEFAULT 0,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_vendors_tenant_name UNIQUE (tenant_id, name)
);
CREATE INDEX ix_vendors_name ON public.vendors (name);

CREATE TABLE public.products (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL,
    vendor_id     uuid          NOT NULL REFERENCES public.vendors(id) ON DELETE RESTRICT,
    name          varchar(120)  NOT NULL,                     -- 짧은 이름 (드롭다운 식별자)
    long_name     varchar(200),                               -- 풀네임 (예: Cloudera Data Platform)
    description   text,                                       -- 제품 설명
    product_code  varchar(50),                                -- 외부 시스템 참조 코드
    link          varchar(500),                               -- 공식 페이지·문서 URL
    is_active     boolean       NOT NULL DEFAULT true,
    sort_order    integer       NOT NULL DEFAULT 0,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_products_tenant_vendor_name UNIQUE (tenant_id, vendor_id, name)
);
CREATE INDEX ix_products_vendor ON public.products (vendor_id);
CREATE INDEX ix_products_name   ON public.products (name);
CREATE INDEX ix_products_code   ON public.products (product_code);

CREATE TABLE public.product_versions (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL,
    product_id    uuid          NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
    name          varchar(60)   NOT NULL,
    release_date  date,
    description   text,                                       -- 이 버전의 주요 변경·신규 기능
    link          varchar(500),                               -- 릴리즈 노트·다운로드 URL
    is_active     boolean       NOT NULL DEFAULT true,
    sort_order    integer       NOT NULL DEFAULT 0,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_product_versions_tenant_product_name UNIQUE (tenant_id, product_id, name)
);
CREATE INDEX ix_product_versions_product ON public.product_versions (product_id);
CREATE INDEX ix_product_versions_name    ON public.product_versions (name);


-- =============================================================================
-- 기술지원 — 케이스 / 활동 로그 (Support)
-- =============================================================================
--
-- 케이스(`support_cases`): 고객사 제품 사용 중 발생한 문제·문의를 등록 추적.
--   상태 = OPEN | IN_PROGRESS | CLOSED, 벤더 케이스 번호, 영업대표/엔지니어 지정.
-- 로그(`support_logs`): 기술지원 활동 일자별 기록 — 시작·종료일, 소요 분.
-- vendor/product/version 은 product_catalog(vendors/products/product_versions) FK.
-- 양쪽 모두 첨부(N) + 코멘트(N) sub 테이블 보유. 코멘트는 작성자(`author_user_id`)
-- 와 ADMIN 만 편집·삭제 (앱 가드).
-- 권한: `support.manage` (SALES + HR + SUPPORT + ADMIN).

CREATE TABLE public.support_cases (
    id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     uuid          NOT NULL,
    -- 사람-친화 케이스 번호 "CASE-YYYY-NNN". tenant 안에서 unique.
    -- 생성 시 backend 가 support_case_counters 로 원자적 발급. URL/검색 키.
    case_no                       varchar(20),
    customer_id                   uuid          NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    project_id                    uuid          REFERENCES public.projects(id) ON DELETE SET NULL,
    sales_rep_developer_id        uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    support_engineer_developer_id uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    -- 제조사 — 정보·필터링용 단일. 제품·버전은 다대다 join 테이블
    -- support_case_products 에 저장 (한 케이스에 여러 제품 가능).
    vendor_id                     uuid          REFERENCES public.vendors(id) ON DELETE RESTRICT,
    vendor_case_no                varchar(120),
    title                         varchar(300)  NOT NULL,                       -- 케이스 제목 (필수)
    status                        varchar(20)   NOT NULL DEFAULT 'OPEN',       -- OPEN | IN_PROGRESS | CLOSED
    -- 케이스 유형 — 운영 통계·필터·우선순위 판단의 기본 기준.
    -- PERFORMANCE | MALFUNCTION | SECURITY | DATA_LOSS | TUNING | JOB_FAILURE | SERVICE_DOWN | OTHER
    category                      varchar(30)   NOT NULL DEFAULT 'OTHER',
    severity                      varchar(2)    NOT NULL DEFAULT 'S3'          -- AWS-style: S1(긴급) ~ S5(정보)
                                                CHECK (severity IN ('S1','S2','S3','S4','S5')),
    body                          text,
    created_by                    uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    -- 종료 시각/주체. status → 'CLOSED' 전환 시 백엔드가 갱신, 재오픈 시 NULL 로 reset.
    closed_at                     timestamptz,
    closed_by                     uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at                    timestamptz   NOT NULL DEFAULT now(),
    updated_at                    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_support_cases_tenant_case_no UNIQUE (tenant_id, case_no)
);
CREATE INDEX ix_support_cases_customer       ON public.support_cases (customer_id);
CREATE INDEX ix_support_cases_project        ON public.support_cases (project_id);
CREATE INDEX ix_support_cases_status         ON public.support_cases (status);
CREATE INDEX ix_support_cases_severity       ON public.support_cases (severity);
CREATE INDEX ix_support_cases_category       ON public.support_cases (category);
CREATE INDEX ix_support_cases_vendor_case_no ON public.support_cases (vendor_case_no);
CREATE INDEX ix_support_cases_case_no        ON public.support_cases (case_no);
CREATE INDEX ix_support_cases_vendor_id      ON public.support_cases (vendor_id);
CREATE INDEX ix_support_cases_closed_at      ON public.support_cases (closed_at);

-- 케이스 ↔ 제품 다대다. PK (support_case_id, product_id) 라 같은 제품 중복 부착 불가.
-- product 별 version_id 별도. CASCADE: case 삭제 시 join row 함께 제거.
CREATE TABLE public.support_case_products (
    tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    support_case_id uuid        NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
    product_id      uuid        NOT NULL REFERENCES public.products(id)      ON DELETE RESTRICT,
    version_id      uuid        REFERENCES public.product_versions(id)      ON DELETE RESTRICT,
    sort_order      integer     NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (support_case_id, product_id)
);
CREATE INDEX ix_support_case_products_case    ON public.support_case_products (support_case_id);
CREATE INDEX ix_support_case_products_product ON public.support_case_products (product_id);
CREATE INDEX ix_support_case_products_version ON public.support_case_products (version_id);

-- 케이스 번호 시퀀스 — (tenant, year) 별 last_seq. 신규 케이스 생성 시 SELECT...FOR UPDATE
-- 로 row lock 잡고 last_seq+1.
-- tenant_id FK = ON DELETE RESTRICT (TenantMixin 기본). tenant 삭제 시 명시 cleanup 강제.
CREATE TABLE public.support_case_counters (
    tenant_id   uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    year        integer NOT NULL,
    last_seq    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, year)
);

CREATE TABLE public.support_case_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    case_id     uuid          NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
    file_name   varchar(255)  NOT NULL,
    file_path   varchar(1024) NOT NULL,
    mime_type   varchar(120),
    size        integer,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_support_case_attachments_case ON public.support_case_attachments (case_id);

CREATE TABLE public.support_case_comments (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL,
    case_id         uuid          NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
    author_user_id  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    body            text          NOT NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_support_case_comments_case   ON public.support_case_comments (case_id);
CREATE INDEX ix_support_case_comments_author ON public.support_case_comments (author_user_id);

CREATE TABLE public.support_logs (
    id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     uuid          NOT NULL,
    customer_id                   uuid          NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    project_id                    uuid          REFERENCES public.projects(id) ON DELETE SET NULL,
    sales_rep_developer_id        uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    support_engineer_developer_id uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    start_date                    date          NOT NULL,
    end_date                      date          NOT NULL,
    duration_minutes              integer       NOT NULL DEFAULT 0,            -- UI 는 "Xh Ym" 표기
    -- 제조사 — 정보·필터링용 단일. 제품·버전은 다대다 join (support_log_products).
    vendor_id                     uuid          REFERENCES public.vendors(id) ON DELETE RESTRICT,
    body                          text,
    created_by                    uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at                    timestamptz   NOT NULL DEFAULT now(),
    updated_at                    timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_support_logs_customer    ON public.support_logs (customer_id);
CREATE INDEX ix_support_logs_project     ON public.support_logs (project_id);
CREATE INDEX ix_support_logs_start_date  ON public.support_logs (start_date DESC);
CREATE INDEX ix_support_logs_vendor_id   ON public.support_logs (vendor_id);

-- 로그 ↔ 제품 다대다. PK (support_log_id, product_id). CASCADE: log 삭제 시 함께 제거.
CREATE TABLE public.support_log_products (
    tenant_id      uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    support_log_id uuid        NOT NULL REFERENCES public.support_logs(id) ON DELETE CASCADE,
    product_id     uuid        NOT NULL REFERENCES public.products(id)     ON DELETE RESTRICT,
    version_id     uuid        REFERENCES public.product_versions(id)     ON DELETE RESTRICT,
    sort_order     integer     NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (support_log_id, product_id)
);
CREATE INDEX ix_support_log_products_log     ON public.support_log_products (support_log_id);
CREATE INDEX ix_support_log_products_product ON public.support_log_products (product_id);
CREATE INDEX ix_support_log_products_version ON public.support_log_products (version_id);

CREATE TABLE public.support_log_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL,
    log_id      uuid          NOT NULL REFERENCES public.support_logs(id) ON DELETE CASCADE,
    file_name   varchar(255)  NOT NULL,
    file_path   varchar(1024) NOT NULL,
    mime_type   varchar(120),
    size        integer,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_support_log_attachments_log ON public.support_log_attachments (log_id);


-- -----------------------------------------------------------------------------
-- 지식 베이스 (kb_entries) — 벤더 자료(DOC) + 사내 트러블슈팅 노하우(KB) 통합.
-- `type` 컬럼('DOC'|'KB') 으로 두 컨텐츠 성격 구분. 카탈로그 vendors/products/
-- product_versions 와 연동 (모두 nullable — 벤더 무관한 사내 가이드 가능).
-- tags 는 text[] (PostgreSQL array), 자유 분류 검색용.
-- plain_text 는 TipTap 본문 추출 캐시 — quickFilter 용도.
-- visibility = all | manager | admin — 메뉴 권한과 AND 로 적용되는 row-level 가시성.
-- -----------------------------------------------------------------------------
CREATE TABLE public.kb_entries (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    title           varchar(300)  NOT NULL,
    type            varchar(10)   NOT NULL DEFAULT 'KB',  -- DOC | KB
    vendor_id       uuid          REFERENCES public.vendors(id)          ON DELETE RESTRICT,
    product_id      uuid          REFERENCES public.products(id)         ON DELETE RESTRICT,
    version_id      uuid          REFERENCES public.product_versions(id) ON DELETE RESTRICT,
    category        varchar(40),
    tags            text[],
    body            text,
    plain_text      text,
    source_url      varchar(1024),                            -- legacy 단일 URL (사용 안 함)
    source_links    jsonb,                                    -- [{name: str, url: str}, ...] (UI 가 max 2 강제)
    resolved        boolean       NOT NULL DEFAULT false,
    author_user_id  uuid          REFERENCES public.users(id)            ON DELETE SET NULL,
    visibility      varchar(20)   NOT NULL DEFAULT 'all',
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_kb_entries_tenant   ON public.kb_entries (tenant_id);
CREATE INDEX ix_kb_entries_type     ON public.kb_entries (type);
CREATE INDEX ix_kb_entries_vendor   ON public.kb_entries (vendor_id);
CREATE INDEX ix_kb_entries_product  ON public.kb_entries (product_id);
CREATE INDEX ix_kb_entries_version  ON public.kb_entries (version_id);
CREATE INDEX ix_kb_entries_category ON public.kb_entries (category);
CREATE INDEX ix_kb_entries_author   ON public.kb_entries (author_user_id);

CREATE TABLE public.kb_entry_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    entry_id    uuid          NOT NULL REFERENCES public.kb_entries(id) ON DELETE CASCADE,
    file_name   varchar(300)  NOT NULL,
    file_path   varchar(1024) NOT NULL,
    mime_type   varchar(120),
    size        bigint,
    uploaded_by uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_kb_entry_attachments_entry ON public.kb_entry_attachments (entry_id);

-- 도움말 컨텐츠 (help_articles) — 정적 코드(help-content.tsx) 의 DB override.
-- 운영자가 사이드바 > 도움말 페이지에서 직접 편집. 저장마다 revision snapshot.
CREATE TABLE public.help_articles (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    menu_key           varchar(64)   NOT NULL,                          -- menu-registry 키 (예: 'kb')
    title              varchar(200)  NOT NULL,
    "group"            varchar(60),                                       -- 카테고리 라벨
    sort_order         integer       NOT NULL DEFAULT 0,
    summary            text,
    body_html          text          NOT NULL DEFAULT '',                 -- TipTap 본문
    body_text          text,                                              -- 검색 캐시
    updated_by_user_id uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, menu_key)
);
CREATE INDEX ix_help_articles_tenant   ON public.help_articles (tenant_id);
CREATE INDEX ix_help_articles_menu_key ON public.help_articles (menu_key);

-- 저장 시점마다 article 의 snapshot — restore 기준.
CREATE TABLE public.help_article_revisions (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    article_id       uuid          NOT NULL REFERENCES public.help_articles(id) ON DELETE CASCADE,
    title            varchar(200)  NOT NULL,
    "group"          varchar(60),
    sort_order       integer       NOT NULL DEFAULT 0,
    summary          text,
    body_html        text          NOT NULL DEFAULT '',
    body_text        text,
    change_note      text,                                                 -- 변경 사유 메모
    saved_by_user_id uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    saved_at         timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_help_article_revisions_article  ON public.help_article_revisions (article_id);
CREATE INDEX ix_help_article_revisions_saved_at ON public.help_article_revisions (saved_at DESC);

-- 고객사 현황 (Customer Status) — 고객사 × 프로젝트 × 시스템 단위 운영 카드.
-- license_id 가 있으면 sidebar > 라이센스 master 와 연결. quantity/기간은 자체 컬럼
-- (마스터에 없거나 카드별 override 필요).
CREATE TABLE public.customer_status_entries (
    id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    customer_id            uuid          NOT NULL REFERENCES public.customers(id)        ON DELETE RESTRICT,
    project_id             uuid          REFERENCES public.projects(id)                  ON DELETE RESTRICT,
    system_name            varchar(120)  NOT NULL,
    environment            varchar(20)   NOT NULL DEFAULT 'PROD',       -- PROD | STAGING | DEV
    runtime_type           varchar(20)   NOT NULL DEFAULT 'BAREMETAL',   -- VM | BAREMETAL | KUBERNETES | DOCKER
    vendor_id              uuid          REFERENCES public.vendors(id)                   ON DELETE RESTRICT,
    product_id             uuid          REFERENCES public.products(id)                  ON DELETE RESTRICT,
    version_id             uuid          REFERENCES public.product_versions(id)          ON DELETE RESTRICT,
    version_detail         varchar(60),                                                    -- 자유 패치/빌드 표기 (예: 7.1.9.1080-4)
    license_id             uuid          REFERENCES public.licenses(id)                  ON DELETE SET NULL,
    license_quantity       integer,
    license_start_date     date,
    license_end_date       date,
    customer_contact_id    uuid          REFERENCES public.customer_contacts(id)         ON DELETE SET NULL,
    tech_support_user_id   uuid          REFERENCES public.users(id)                     ON DELETE SET NULL,
    body                   text,
    plain_text             text,
    created_by_user_id     uuid          REFERENCES public.users(id)                     ON DELETE SET NULL,
    created_at             timestamptz   NOT NULL DEFAULT now(),
    updated_at             timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_customer_status_entries_tenant   ON public.customer_status_entries (tenant_id);
CREATE INDEX ix_customer_status_entries_customer ON public.customer_status_entries (customer_id);
CREATE INDEX ix_customer_status_entries_project  ON public.customer_status_entries (project_id);
CREATE INDEX ix_customer_status_entries_vendor   ON public.customer_status_entries (vendor_id);
CREATE INDEX ix_customer_status_entries_product  ON public.customer_status_entries (product_id);
CREATE INDEX ix_customer_status_entries_version  ON public.customer_status_entries (version_id);
CREATE INDEX ix_customer_status_entries_license  ON public.customer_status_entries (license_id);
CREATE INDEX ix_customer_status_entries_contact  ON public.customer_status_entries (customer_contact_id);
CREATE INDEX ix_customer_status_entries_support  ON public.customer_status_entries (tech_support_user_id);
CREATE INDEX ix_customer_status_entries_author   ON public.customer_status_entries (created_by_user_id);

CREATE TABLE public.customer_status_attachments (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    entry_id    uuid          NOT NULL REFERENCES public.customer_status_entries(id) ON DELETE CASCADE,
    file_name   varchar(300)  NOT NULL,
    file_path   varchar(1024) NOT NULL,
    mime_type   varchar(120),
    size        bigint,
    uploaded_by uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_customer_status_attachments_entry ON public.customer_status_attachments (entry_id);

CREATE TABLE public.support_log_comments (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid          NOT NULL,
    log_id            uuid          NOT NULL REFERENCES public.support_logs(id) ON DELETE CASCADE,
    author_user_id    uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    body              text          NOT NULL,
    duration_minutes  integer       NOT NULL DEFAULT 0,  -- 코멘트별 지원 시간. log.duration_minutes = SUM
    start_date        date          NOT NULL,            -- 코멘트별 지원 시작일. log.start_date = MIN
    end_date          date          NOT NULL,            -- 코멘트별 지원 종료일. log.end_date   = MAX
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_support_log_comments_log    ON public.support_log_comments (log_id);
CREATE INDEX ix_support_log_comments_author ON public.support_log_comments (author_user_id);


-- =============================================================================
-- 사업공고 수집 (Announcements)
-- =============================================================================
--
-- 매일 03:00 KST 스케줄러가 나라장터(G2B)·NTIS·IRIS·BizInfo·K-Startup 등 외부
-- 소스에서 공고를 UPSERT. 중복 방지 키는 (source_id, external_id).
--
-- Secret 은 저장하지 않음 — API 키는 app_settings.announcements.sources.* 에서.
-- 본문 전체도 저장하지 않음 — summary + detail_url 만. 원본 응답은 raw_payload.

CREATE TABLE public.announcement_sources (
    id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    code             varchar(40)  NOT NULL UNIQUE,
    name             varchar(100) NOT NULL,
    agency           varchar(200),
    base_url         varchar(500),
    adapter_kind     varchar(20)  NOT NULL DEFAULT 'openapi', -- openapi | html | rss
    enabled          boolean      NOT NULL DEFAULT true,
    priority         smallint     NOT NULL DEFAULT 100,
    last_fetched_at  timestamptz,
    last_ok_at       timestamptz,
    last_error       text,
    last_count       integer,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE public.announcements (
    id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id                uuid           NOT NULL REFERENCES public.announcement_sources(id) ON DELETE CASCADE,
    external_id              varchar(200)   NOT NULL,
    title                    varchar(500)   NOT NULL,
    agency                   varchar(200),
    department               varchar(200),
    business_type            varchar(20),   -- RESEARCH | PUBLIC_BID | PRIVATE_BID | STARTUP | SUPPORT | OTHER
    category                 varchar(100),
    region                   varchar(80),
    posted_at                date,
    deadline_at              timestamptz,
    budget_amount            numeric(18, 0),
    currency                 varchar(3)     NOT NULL DEFAULT 'KRW',
    contact_name             varchar(100),
    contact_phone            varchar(50),
    contact_email            varchar(200),
    detail_url               varchar(1000),
    attachment_urls          varchar(1000)[],
    summary                  text,
    raw_payload              jsonb,
    content_hash             varchar(64),
    first_seen_at            timestamptz    NOT NULL,
    last_seen_at             timestamptz    NOT NULL,
    is_active                boolean        NOT NULL DEFAULT true,
    converted_opportunity_id uuid,
    created_at               timestamptz    NOT NULL DEFAULT now(),
    updated_at               timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_announcement_source_ext UNIQUE (source_id, external_id)
);
CREATE INDEX ix_announcements_source        ON public.announcements (source_id);
CREATE INDEX ix_announcements_agency        ON public.announcements (agency);
CREATE INDEX ix_announcements_business_type ON public.announcements (business_type);
CREATE INDEX ix_announcements_posted_at     ON public.announcements (posted_at DESC);
CREATE INDEX ix_announcements_deadline_at   ON public.announcements (deadline_at);

CREATE TABLE public.announcement_fetch_runs (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       uuid         REFERENCES public.announcement_sources(id) ON DELETE SET NULL,
    source_code     varchar(40)  NOT NULL,
    trigger_kind    varchar(20)  NOT NULL,                   -- SCHEDULED | MANUAL
    triggered_by    uuid         REFERENCES public.users(id) ON DELETE SET NULL,
    started_at      timestamptz  NOT NULL,
    finished_at     timestamptz,
    status          varchar(20)  NOT NULL DEFAULT 'RUNNING', -- RUNNING | OK | FAILED | SKIPPED
    fetched_count   integer      NOT NULL DEFAULT 0,
    inserted_count  integer      NOT NULL DEFAULT 0,
    updated_count   integer      NOT NULL DEFAULT 0,
    skipped_count   integer      NOT NULL DEFAULT 0,
    error_message   text
);
CREATE INDEX ix_announcement_fetch_runs_started ON public.announcement_fetch_runs (started_at DESC);
CREATE INDEX ix_announcement_fetch_runs_source  ON public.announcement_fetch_runs (source_id);

CREATE TABLE public.announcement_bookmarks (
    id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id  uuid         NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
    user_id          uuid         NOT NULL REFERENCES public.users(id)         ON DELETE CASCADE,
    memo             text,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_announcement_bookmark_user UNIQUE (announcement_id, user_id)
);
CREATE INDEX ix_announcement_bookmarks_user ON public.announcement_bookmarks (user_id);

-- 초기 소스 시드 — 어댑터가 있는 것부터.
INSERT INTO public.announcement_sources (code, name, agency, base_url, adapter_kind, priority) VALUES
  ('g2b',      '나라장터 입찰공고',    '조달청',                   'https://www.g2b.go.kr',       'openapi', 10),
  ('ntis',     'NTIS 국가R&D통합공고', '과학기술정보통신부',       'https://www.ntis.go.kr',      'openapi', 20),
  ('bizinfo',  '기업마당 지원사업',    '중소벤처기업부',           'https://www.bizinfo.go.kr',   'openapi', 30),
  ('kstartup', 'K-Startup 창업지원',   '창업진흥원',               'https://www.k-startup.go.kr', 'openapi', 40),
  ('iris',     'IRIS 사업공고',        '범부처통합연구지원시스템', 'https://www.iris.go.kr',      'html',    50),
  ('nipa',     'NIPA 사업공고',        '정보통신산업진흥원',       'https://www.nipa.kr',         'html',    60),
  ('iitp',     'IITP 사업공고',        '정보통신기획평가원',       'https://www.iitp.kr',         'html',    70),
  ('keit',     'KEIT SROME',           '한국산업기술기획평가원',   'https://srome.keit.re.kr',    'html',    80)
ON CONFLICT (code) DO NOTHING;


-- =============================================================================
-- 알람 (Alarms) — Slack 정기 리마인더
--
-- sidebar > ADMINISTRATION > Alarms. 관리자가 등록하면 APScheduler 가 지정된
-- 시각에 Slack 채널 또는 임직원(developers) DM 으로 `message` 를 발송.
-- 공휴일/주말이면 홀리데이 테이블을 참고해 **직전 영업일 같은 시각**으로 이동.
--
-- schedule_kind 별 필수 필드:
--   ONE_TIME  — one_time_at
--   DAILY     — hour, minute
--   WEEKLY    — hour, minute, weekdays (0=월~6=일, 1개 이상)
--   MONTHLY   — hour, minute, day_of_month
--   YEARLY    — hour, minute, day_of_month, month_of_year
-- 크로스 필드 정합성은 API 레이어(_validate_schedule)가 강제.
--
-- 수신처는 slack_channel 과 recipient_developer_ids 중 최소 1개 필요.
-- =============================================================================

CREATE TABLE public.alarms (
    id                      uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    title                   varchar(100)   NOT NULL,
    message                 text           NOT NULL,

    schedule_kind           varchar(20)    NOT NULL,    -- ONE_TIME|DAILY|WEEKLY|MONTHLY|YEARLY
    one_time_at             timestamptz,                -- ONE_TIME
    hour                    integer,                    -- 0-23
    minute                  integer,                    -- 0-59
    weekdays                integer[],                  -- WEEKLY: {0..6}
    day_of_month            integer,                    -- MONTHLY/YEARLY: 1-31
    month_of_year           integer,                    -- YEARLY: 1-12

    slack_channel           varchar(120),               -- "#alert" 또는 channel id
    recipient_developer_ids uuid[],                     -- developers.id, DM 전송

    active_from             date,
    active_to               date,

    enabled                 boolean        NOT NULL DEFAULT true,
    last_sent_at            timestamptz,
    last_status             varchar(30),                -- SUCCESS|FAILED|SKIPPED_DISABLED|SKIPPED_INACTIVE
    last_error              text,
    sent_count              integer        NOT NULL DEFAULT 0,

    created_by              uuid           REFERENCES public.users(id) ON DELETE SET NULL,
    created_at              timestamptz    NOT NULL DEFAULT now(),
    updated_at              timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_alarms_enabled ON public.alarms (enabled);


-- 알람 실행 이력. 매 발송(혹은 스킵) 마다 한 행. 30일 이후 배치 job 이 삭제.
CREATE TABLE public.alarm_sends (
    id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    alarm_id           uuid         NOT NULL REFERENCES public.alarms(id) ON DELETE CASCADE,
    scheduled_at       timestamptz  NOT NULL,            -- SHIFT_BEFORE 적용 전 원래 트리거 시각
    sent_at            timestamptz,                      -- 실제 발송 시각
    status             varchar(30)  NOT NULL,            -- SUCCESS|FAILED|SKIPPED_*
    error_message      text,
    recipients_summary varchar(500),                     -- 예: "#alert + 김철수, 이영희"
    manual             boolean      NOT NULL DEFAULT false,  -- "지금 테스트 발송" = true
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_alarm_sends_alarm        ON public.alarm_sends (alarm_id);
CREATE INDEX ix_alarm_sends_scheduled_at ON public.alarm_sends (scheduled_at DESC);


-- =============================================================================
-- 작업 이력 (JobRun) — 백그라운드 jobs 통합 실행 로그
-- =============================================================================
-- 스케줄러로 도는 일간 작업 (FX·금리·주가·백업·공고·세금계산서·일일알림 등) 과
-- 사용자 수동 트리거 (예: 알람 "지금 테스트 발송") 가 모두 이 한 테이블에 row 를 남긴다.
-- 도메인별 상세 테이블(`alarm_sends`, `announcement_fetch_runs`) 은 그대로 유지 —
-- 본 테이블은 통합 모니터링 + 이상 탐지용. 보존 14일, 매일 03:00 cleanup.
CREATE TABLE public.job_runs (
    id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name             varchar(200) NOT NULL,                  -- "환율 자동 수집" 등 사람 읽는 이름
    job_kind             varchar(50)  NOT NULL,                  -- FX_FETCH, ECOS_INTEREST, ALARM_DISPATCH 등 코드
    status               varchar(20)  NOT NULL DEFAULT 'RUNNING',-- RUNNING|SUCCESS|FAILED|SKIPPED
    started_at           timestamptz  NOT NULL,
    finished_at          timestamptz,
    duration_ms          integer,                                -- 시작~종료 ms (RUNNING 중엔 NULL)
    triggered_by         varchar(20)  NOT NULL DEFAULT 'SCHEDULER', -- SCHEDULER|MANUAL|API
    triggered_by_user_id uuid         REFERENCES public.users(id) ON DELETE SET NULL,
    result_summary       text,                                   -- 사람 읽기 좋은 한 줄
    error_message        text,                                   -- 실패 시 traceback
    extra                jsonb,                                  -- 구조화 통계
    created_at           timestamptz  NOT NULL DEFAULT now(),
    updated_at           timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_job_runs_kind        ON public.job_runs (job_kind);
CREATE INDEX ix_job_runs_status      ON public.job_runs (status);
CREATE INDEX ix_job_runs_started_at  ON public.job_runs (started_at DESC);


-- =============================================================================
-- 출퇴근 (Attendance) — 모바일 GPS 체크인
-- =============================================================================
-- 한 row = 한 세션 (출근→퇴근). 같은 날 여러 세션 허용 — 정규 근무 후 긴급
-- 업무로 다시 나오는 경우 등을 자연스럽게 N개 row 로 표현.
--
-- 불변식: 사용자당 동시에 열린 세션 0 또는 1개. 아래 partial unique index 가
-- DB 차원에서 강제 (두 기기 동시 출근 클릭 같은 경합 방어).
--
-- 체크인 시 worksite 중심에서 거리(m) + 반경 안/밖 결과를 같이 저장 — 사후
-- 감사·통계용. 반경 밖이면 API 가 reason 필수 (422).
CREATE TABLE public.attendances (
    id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    developer_id             uuid         REFERENCES public.developers(id) ON DELETE SET NULL,
    worksite_id              uuid         REFERENCES public.worksites(id) ON DELETE SET NULL,
    work_date                date         NOT NULL,

    check_in_at              timestamptz  NOT NULL,
    check_in_lat             numeric(10,7) NOT NULL,
    check_in_lng             numeric(10,7) NOT NULL,
    check_in_distance_m      integer,
    check_in_within_radius   boolean,
    check_in_reason          text,

    check_out_at             timestamptz,
    check_out_lat            numeric(10,7),
    check_out_lng            numeric(10,7),
    check_out_distance_m     integer,
    check_out_within_radius  boolean,
    check_out_reason         text,

    created_at               timestamptz  NOT NULL DEFAULT now(),
    updated_at               timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_attendance_user      ON public.attendances (user_id);
CREATE INDEX ix_attendance_developer ON public.attendances (developer_id);
CREATE INDEX ix_attendance_work_date ON public.attendances (work_date);
-- 사용자당 열린 세션 1개만 허용 (check_out_at IS NULL 인 row).
CREATE UNIQUE INDEX uq_attendance_user_open
  ON public.attendances (user_id) WHERE check_out_at IS NULL;


-- =============================================================================
-- PWA Web Push 구독 (PushSubscription)
-- =============================================================================
-- 사용자가 모바일 PWA 에서 알림 동의 시 1행 추가. PushManager.subscribe() 가
-- 반환하는 endpoint + p256dh + auth 를 그대로 저장. webpush 라이브러리가 이 셋과
-- VAPID 키만 있으면 발송 가능. 한 사용자 N 기기 → N 행. 410 Gone 응답 시 자동 삭제.
CREATE TABLE public.push_subscriptions (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  endpoint     text         NOT NULL UNIQUE,
  p256dh       varchar(255) NOT NULL,
  auth         varchar(255) NOT NULL,
  user_agent   varchar(500),
  last_sent_at timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_push_subscriptions_user ON public.push_subscriptions (user_id);


-- =============================================================================
-- 근무지 (Worksite) + 직원 매핑 (WorksiteAssignment)
-- =============================================================================
-- 근무지는 프로젝트와 무관하게도 존재 가능 (project_id NULL 허용).
-- 출퇴근 GPS 검증의 기준점 — latitude/longitude + radius_meters 안에서 체크인.
CREATE TABLE public.worksites (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    name          varchar(200)  NOT NULL,
    address       text,
    -- numeric(10,7) ≈ 11mm 정밀도. 등록 직후 좌표 미입력 가능 → NULL 허용.
    latitude      numeric(10,7),
    longitude     numeric(10,7),
    -- 출퇴근 허용 반경(m). 등록 시 사용자 직접 입력 (도심·외곽 따라 다름).
    radius_meters integer       NOT NULL,
    -- 근무시간 — "HH:MM" 30분 단위. 정시·지각 분류 기준.
    work_start_time varchar(5)  NOT NULL DEFAULT '09:00',
    work_end_time   varchar(5)  NOT NULL DEFAULT '18:00',
    -- ACTIVE | INACTIVE — 종료된 근무지는 INACTIVE 로 soft-disable (이력 보존).
    -- 프로젝트 연결은 별도 worksite_projects 테이블 (M:N).
    status        varchar(20)   NOT NULL DEFAULT 'ACTIVE',
    memo          text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_worksites_status  ON public.worksites (status);


-- 근무지 ↔ 프로젝트 M:N 매핑. 한 근무지가 여러 프로젝트에 속할 수 있고
-- (예: 같은 사무실에서 여러 프로젝트 동시 진행), 한 프로젝트도 여러 근무지에
-- 분산 가능. 두 쪽 모두 CASCADE — 어느 쪽이든 삭제되면 link 자동 정리.
CREATE TABLE public.worksite_projects (
    tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    worksite_id uuid NOT NULL REFERENCES public.worksites(id) ON DELETE CASCADE,
    project_id  uuid NOT NULL REFERENCES public.projects(id)  ON DELETE CASCADE,
    PRIMARY KEY (tenant_id, worksite_id, project_id)
);
CREATE INDEX ix_wp_project ON public.worksite_projects (project_id);
CREATE INDEX ix_wp_tenant  ON public.worksite_projects (tenant_id);

-- RLS — `app.tenant_id` 기반 격리. 부모(worksite·project) 가 RLS 로 막혀 cross-tenant
-- 연결 시도가 거의 불가하지만, defense-in-depth.
ALTER TABLE public.worksite_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worksite_projects FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.worksite_projects;
CREATE POLICY tenant_iso ON public.worksite_projects
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- 직원 ↔ 근무지 매핑 (M:N). 한 직원이 여러 근무지에 동시에 배정될 수 있음.
-- end_date NULL = 진행 중. 종료 시 end_date 채우거나 hard delete.
CREATE TABLE public.worksite_assignments (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    worksite_id  uuid         NOT NULL REFERENCES public.worksites(id)  ON DELETE CASCADE,
    developer_id uuid         NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    start_date   date         NOT NULL,
    end_date     date,
    is_primary   boolean      NOT NULL DEFAULT false,
    memo         text,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_wa_dev    ON public.worksite_assignments (developer_id);
CREATE INDEX ix_wa_site   ON public.worksite_assignments (worksite_id);
CREATE INDEX ix_wa_active ON public.worksite_assignments (developer_id) WHERE end_date IS NULL;


-- =============================================================================
-- 자사 통장 계좌 (자사 전용 — 고객/직원 owner 없음)
-- =============================================================================
-- 원화·외환 모두 지원. 외환 계좌는 swift_code/iban/bank_address 추가 입력.
-- 통화별 primary 1개만 — 부분 unique 인덱스로 강제.
CREATE TABLE public.bank_accounts (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_name       varchar(100)  NOT NULL,
    account_number  varchar(50)   NOT NULL,
    holder_name     varchar(100)  NOT NULL,
    -- ISO 4217 — KRW|USD|EUR|JPY|CNY|GBP… 등 3-letter uppercase.
    currency        varchar(3)    NOT NULL,
    purpose         varchar(200),
    -- 외환 계좌 (currency != 'KRW' 일 때 주로 입력. NULL 허용).
    swift_code      varchar(20),
    iban            varchar(50),
    bank_address    text,
    -- 통장사본 첨부 (1 row / 1 file slot).
    passbook_name   varchar(255),
    passbook_path   varchar(1024),
    passbook_mime   varchar(120),
    passbook_size   integer,
    is_primary      boolean       NOT NULL DEFAULT false,
    -- ACTIVE | INACTIVE — soft delete.
    status          varchar(20)   NOT NULL DEFAULT 'ACTIVE',
    memo            text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_bank_accounts_currency CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX ix_bank_accounts_currency ON public.bank_accounts (currency);
CREATE INDEX ix_bank_accounts_status   ON public.bank_accounts (status);
-- 통화별 primary 는 활성 row 중 1개만.
CREATE UNIQUE INDEX uq_bank_primary_per_currency ON public.bank_accounts (currency)
    WHERE is_primary = true AND status = 'ACTIVE';


-- =============================================================================
-- 은행 거래내역 (BankTransaction) — bank_accounts 의 송금 이력
-- =============================================================================
-- CSV 업로드 적재 (현재 기업은행 IBK 만 지원).
-- PK 전략: (bank_account_id, tx_at, balance_after) 복합 UNIQUE → 재업로드 idempotent.
CREATE TABLE public.bank_transactions (
    id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id       uuid           NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
    tx_at                 timestamptz    NOT NULL,                          -- 거래일시
    withdrawal            numeric(18,2)  NOT NULL DEFAULT 0,                -- 출금
    deposit               numeric(18,2)  NOT NULL DEFAULT 0,                -- 입금
    balance_after         numeric(18,2)  NOT NULL,                          -- 거래후잔액 (PK 일부)
    description           text,                                              -- 거래내용
    counterparty_account  varchar(50),                                       -- 상대계좌번호
    counterparty_bank     varchar(50),                                       -- 상대은행
    counterparty_holder   varchar(100),                                      -- 상대계좌예금주명
    memo                  text,                                              -- 메모
    tx_type               varchar(30),                                       -- 거래구분 (인터넷·ATM·자동이체)
    check_amount          numeric(18,2)  NOT NULL DEFAULT 0,                 -- 수표어음금액
    cms_code              varchar(30),                                       -- CMS 코드
    created_at            timestamptz    NOT NULL DEFAULT now(),
    updated_at            timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_bank_tx_account_dt_bal UNIQUE (bank_account_id, tx_at, balance_after)
);
CREATE INDEX ix_bank_tx_account ON public.bank_transactions (bank_account_id);
CREATE INDEX ix_bank_tx_at      ON public.bank_transactions (tx_at DESC);


-- =============================================================================
-- 특허 (Patent) — 자사 보유·출원 특허 원장 + 첨부 서류
-- =============================================================================
-- 단순 관리용. 상태(FILED/REGISTERED) 수동 전환만. 프로젝트 연결·만료 알림 미포함.
CREATE TABLE public.patents (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  status          varchar(20)   NOT NULL DEFAULT 'FILED',  -- FILED|REGISTERED
  title           varchar(500)  NOT NULL,                  -- 발명의 명칭
  application_no  varchar(100),                             -- 출원번호
  patent_no       varchar(100),                             -- 특허번호 (등록번호)
  filed_date      date,                                     -- 출원일
  registered_date date,                                     -- 등록일
  patent_holder   varchar(200),                             -- 특허권자
  holder_address  text,                                     -- 특허권자 주소
  inventors       text,                                     -- 발명자 (콤마 구분 자유 텍스트)
  inventor_address text,                                    -- 발명자 주소
  country         varchar(50),                              -- 국가 (KR/US/EP 등 자유)
  memo            text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_patents_status ON public.patents (status);

CREATE TABLE public.patent_attachments (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  patent_id   uuid          NOT NULL REFERENCES public.patents(id) ON DELETE CASCADE,
  filename    varchar(255)  NOT NULL,
  path        varchar(1024) NOT NULL,
  mime_type   varchar(120),
  file_size   integer,
  uploaded_by uuid          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_patent_attachments_patent ON public.patent_attachments (patent_id);


-- =============================================================================
-- 도서 (Books) — 회사 도서 대장 + 임대 추적 (sidebar > 홈 > 도서)
-- =============================================================================
-- 1권 = 1 row. 임대 이력은 보존하지 않음 (사내 운영용으로 충분):
--   * 현재 임대인  → borrower_id     (NULL = 미대여)
--   * 임대 시작    → borrowed_at     (timestamptz, borrower_id 존재 시 자동 now)
--   * 반납 예정일  → due_date        (date, NULL 허용)
--   * 반납 시      → borrower_id / borrowed_at 모두 NULL 클리어
-- 권한: 조회 = 모든 인증 사용자, CRUD = HR/ADMIN (`books.manage` permission).
-- 인덱스: title (부분일치 검색용 ilike 도 사용), borrower_id 는 partial index
-- (대여중 row 만, NULL 다수가 인덱스를 부풀리지 않도록).
-- 임대인 FK 는 ON DELETE SET NULL — 임대인 퇴사 시 row 는 보존, 임대 기록만 끊김.

CREATE TABLE public.books (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    title         varchar(300)  NOT NULL,
    location      varchar(200),                                           -- 비치 위치 (자유 텍스트, 예: "회의실 책장 A-2")
    publisher     varchar(150),
    category      varchar(100),                                          -- 분야 (자유 텍스트, 예: 개발/경영/자기계발)
    price         integer,                                                -- KRW 정수
    -- 현재 임대인 (이력 X). 반납 시 NULL. 퇴사 시 SET NULL.
    borrower_id   uuid          REFERENCES public.developers(id) ON DELETE SET NULL,
    borrowed_at   timestamptz,                                            -- 임대 시작 시각
    due_date      date,                                                   -- 반납 예정일 (옵션)
    registered_at date          NOT NULL DEFAULT current_date,            -- 도서 등록일
    note          text,                                                   -- ISBN / 메모
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_books_title    ON public.books (title);
CREATE INDEX ix_books_borrower ON public.books (borrower_id) WHERE borrower_id IS NOT NULL;
-- tenant_id / RLS / fn_auto_tenant_id 트리거는 파일 끝의 일괄 부여 블록이 처리.


-- =============================================================================
-- 출장 일정 (`trips`, `trip_events`) — sidebar > 홈 > 출장
-- =============================================================================
-- 도메인:
--   * trips        : 출장 1건 (이름·기간·출발/도착 TZ·소유자).
--   * trip_events  : 비행/숙박/미팅/기타 일정. 시각은 UTC 저장, 표시용
--                    event_tz(IANA) 로 wall-clock 변환은 프런트가 수행.
-- 권한: 소유자(owner_user_id) 본인만 조회·수정. ADMIN/HR 도 타인 출장에는
--       관여하지 않는 개인 일정 성격. 같은 tenant 내에서도 row 격리는
--       애플리케이션 레벨 (RLS 는 tenant 단위만).

CREATE TABLE public.trips (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    name            varchar(200)  NOT NULL,
    start_date      date          NOT NULL,
    end_date        date          NOT NULL,
    origin_tz       varchar(64)   NOT NULL,                                 -- 출발지 IANA TZ (예: Asia/Seoul)
    destination_tz  varchar(64)   NOT NULL,                                 -- 도착지 IANA TZ (예: America/Los_Angeles)
    origin_iata     varchar(8),                                              -- 출발지 공항 IATA (선택, 목록 표시용)
    destination_iata varchar(8),                                             -- 도착지 공항 IATA (선택)
    owner_user_id   uuid          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    notes           text,
    prep_notes      text,                                                    -- 준비물 (BlockNote JSON body)
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_trips_owner ON public.trips (owner_user_id);
CREATE INDEX ix_trips_start ON public.trips (start_date);

CREATE TABLE public.trip_events (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     uuid          NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
    kind        varchar(20)   NOT NULL,                                     -- FLIGHT | HOTEL | MEETING | OTHER
    title       varchar(200)  NOT NULL,
    start_at    timestamptz   NOT NULL,                                     -- UTC 정규화
    end_at      timestamptz   NOT NULL,
    event_tz    varchar(64)   NOT NULL,                                     -- 이 이벤트의 표시용 IANA TZ
    from_iata   varchar(8),                                                 -- 비행 전용
    to_iata     varchar(8),                                                 -- 비행 전용
    flight_no   varchar(20),                                                -- 비행 전용
    location    varchar(300),                                               -- 호텔/미팅 주소
    notes       text,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_trip_events_trip   ON public.trip_events (trip_id);
CREATE INDEX ix_trip_events_kind   ON public.trip_events (trip_id, kind);
CREATE INDEX ix_trip_events_start  ON public.trip_events (start_at);
-- tenant_id / RLS / fn_auto_tenant_id 트리거는 파일 끝의 일괄 부여 블록이 처리.


-- =============================================================================
-- 주간보고 (Weekly Reports) — 매주 1 직원 1 row 의 주간 보고
-- =============================================================================
-- 도메인:
--   * weekly_report_assignments — ADMIN/HR 가 지정한 작성 의무자.
--   * weekly_reports             — 본문 (1 직원 × 1 ISO 주 = 1 row, UNIQUE).
--   * weekly_report_attachments  — 첨부.
--   * weekly_report_templates    — 양식 (kind=MANAGER|GENERAL, tenant 별 1 행).
--   * weekly_report_comments     — 코멘트 (SUBMITTED 상태에서만 작성).
--
-- 양식은 신규 보고서 lazy create 시 작성자의 매니저 여부(직속 부하 ≥1) 로
-- 자동 선택. DB 미설정이면 코드(weekly_reports.py) 의 기본값으로 fallback.
--
-- 권한:
--   조회 — 본인 / 직속 매니저 chain (depth ≤10) / HR/ADMIN/SUPER_ADMIN.
--   편집 — 본인 + SUPER_ADMIN. ADMIN 도 본인 행이 아니면 편집 불가 (감독은
--          조회만).
--   지정자·양식 관리 — ADMIN/HR.

-- UNIQUE 가 tenant_id 를 참조해야 하므로 컬럼을 CREATE 안에 명시 (bulk
-- 부여 블록의 ADD COLUMN IF NOT EXISTS 는 no-op 이 된다).

CREATE TABLE public.weekly_report_assignments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    developer_id    uuid NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    active          boolean NOT NULL DEFAULT true,
    -- 시작·종료 ISO 주 (NULL = 무기한). 인사이동·퇴사 시 종료 주 채움.
    start_year      integer,
    start_week      integer,
    end_year        integer,
    end_week        integer,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- 1 직원 1 행 — 활성/비활성과 시작·종료 주로만 토글.
    CONSTRAINT uq_wra_dev UNIQUE (tenant_id, developer_id)
);
CREATE INDEX ix_wra_dev    ON public.weekly_report_assignments (developer_id);
CREATE INDEX ix_wra_active ON public.weekly_report_assignments (active);

CREATE TABLE public.weekly_reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    developer_id    uuid NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    iso_year        integer NOT NULL,
    iso_week        integer NOT NULL CHECK (iso_week BETWEEN 1 AND 53),
    week_start      date    NOT NULL,                                 -- ISO 주 월요일
    week_end        date    NOT NULL,                                 -- ISO 주 일요일
    body            text,                                              -- TipTap HTML
    plain_text      text,                                              -- 검색 캐시 (HTML 제거)
    -- DRAFT (작성중) / SUBMITTED (제출 완료, 본인이 토글).
    status          varchar(20) NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT','SUBMITTED')),
    submitted_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_wr_dev_year_week UNIQUE (tenant_id, developer_id, iso_year, iso_week)
);
CREATE INDEX ix_wr_dev    ON public.weekly_reports (developer_id);
CREATE INDEX ix_wr_status ON public.weekly_reports (status);
CREATE INDEX ix_wr_year_week ON public.weekly_reports (iso_year DESC, iso_week DESC);

CREATE TABLE public.weekly_report_attachments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    weekly_report_id    uuid NOT NULL REFERENCES public.weekly_reports(id) ON DELETE CASCADE,
    file_name           varchar(300)  NOT NULL,
    file_path           varchar(1024) NOT NULL,                  -- data/<tenant>/weekly-reports/<id>/<uuid>.<ext>
    mime_type           varchar(120),
    size                bigint,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_wra_att_report ON public.weekly_report_attachments (weekly_report_id);

CREATE TABLE public.weekly_report_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    -- MANAGER | GENERAL — 매니저 여부(직속 부하 ≥1)로 자동 선택.
    kind        varchar(20) NOT NULL CHECK (kind IN ('MANAGER','GENERAL')),
    body        text NOT NULL DEFAULT '',                        -- TipTap HTML
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_wrt_kind UNIQUE (tenant_id, kind)
);

-- 코멘트 — SUBMITTED 상태의 보고서에만 작성. 보고서 read 권한자 누구나
-- 작성·열람. 편집/삭제는 작성자 + ADMIN. 작성 시 owner 에게 DM 알림.
-- developer 미매핑 사용자(ADMIN 부트스트랩 등) 도 author_user_id 로 추적.
CREATE TABLE public.weekly_report_comments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    weekly_report_id    uuid NOT NULL REFERENCES public.weekly_reports(id) ON DELETE CASCADE,
    author_id           uuid REFERENCES public.developers(id) ON DELETE SET NULL,
    author_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
    body                text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_wrc_report  ON public.weekly_report_comments (weekly_report_id);
CREATE INDEX ix_wrc_author  ON public.weekly_report_comments (author_id);
CREATE INDEX ix_wrc_created ON public.weekly_report_comments (created_at);
-- tenant_id / RLS / fn_auto_tenant_id 트리거는 파일 끝의 일괄 부여 블록이 처리
-- (ADD COLUMN IF NOT EXISTS 는 위 명시 컬럼 덕에 no-op).


-- =============================================================================
-- 임직원 평가 (Employee Evaluation) — 반기 cycle, S~D 등급
-- =============================================================================
-- 도메인:
--   * evaluation_cycles            — HR 가 만드는 반기 cycle (1H/2H, 1년 2개)
--   * competency_dimensions        — tenant 별 역량 dimension (Settings 편집)
--   * evaluations                  — 1 cycle × 1 직원 = 1 row
--   * evaluation_competency_scores — 1 evaluation × N dimension
--
-- workflow:
--   NOT_STARTED → SELF_DRAFT → SELF_SUBMITTED → MGR_DRAFT
--   → MGR_SUBMITTED → CALIBRATED → FINALIZED
--
-- 권한:
--   - HR/ADMIN — cycle 관리 + 모든 evaluation calibration
--   - 매니저 — 직속 부하의 manager_score / manager_narrative 작성
--   - 본인 — 본인 self_*. FINALIZED 후에만 manager_* / final_* 조회 가능
--   - calibration_note — HR/ADMIN 전용 (본인·매니저 미노출)

CREATE TABLE public.evaluation_cycles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    year            integer     NOT NULL,
    period          varchar(4)  NOT NULL CHECK (period IN ('1H', '2H')),
    name            varchar(120) NOT NULL,
    -- goal 자동 집계 범위 (1H = 1/1~6/30, 2H = 7/1~12/31 권장).
    start_date      date NOT NULL,
    end_date        date NOT NULL,
    -- 3-단계 deadline.
    self_due        date NOT NULL,
    manager_due     date NOT NULL,
    finalize_due    date NOT NULL,
    status          varchar(16) NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT','OPEN','CALIBRATING','CLOSED')),
    created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    opened_at       timestamptz,
    closed_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_eval_cycle_year_period UNIQUE (tenant_id, year, period)
);
CREATE INDEX ix_eval_cycle_status ON public.evaluation_cycles (status);

CREATE TABLE public.competency_dimensions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    -- key 는 slug 로 코드 매칭. 평가 진행 후엔 변경 자제 (score row 에 영향).
    key         varchar(40) NOT NULL,
    label       varchar(80) NOT NULL,
    description text,
    sort_order  integer NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_competency_dim_key UNIQUE (tenant_id, key)
);

CREATE TABLE public.evaluations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    cycle_id           uuid NOT NULL REFERENCES public.evaluation_cycles(id) ON DELETE CASCADE,
    developer_id       uuid NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
    -- 매니저 스냅샷 — cycle open 시점의 manager. 도중 변경되어도 평가자 보존.
    manager_id         uuid REFERENCES public.developers(id) ON DELETE SET NULL,
    status             varchar(20) NOT NULL DEFAULT 'NOT_STARTED'
                                  CHECK (status IN (
                                    'NOT_STARTED','SELF_DRAFT','SELF_SUBMITTED',
                                    'MGR_DRAFT','MGR_SUBMITTED','CALIBRATED','FINALIZED'
                                  )),
    -- TipTap HTML 본문.
    self_narrative     text,
    manager_narrative  text,
    -- HR 내부 메모 — 본인·매니저 미노출.
    calibration_note   text,
    -- 목표 달성도 1.0~5.0. self/manager/HR 가 prefill 받아 조정.
    goal_score_self    numeric(3,1),
    goal_score_manager numeric(3,1),
    goal_score_final   numeric(3,1),
    -- 역량 평균 (서버 계산 캐시 — competency_scores 가 source of truth).
    competency_avg_self    numeric(3,2),
    competency_avg_manager numeric(3,2),
    competency_avg_final   numeric(3,2),
    -- 최종 종합 점수 + 등급 — calibration 단계에서 HR 결정.
    final_overall_score numeric(3,2),
    final_grade        varchar(2)
                       CHECK (final_grade IS NULL OR final_grade IN ('S','A','B','C','D')),
    -- 단계별 timestamp.
    self_submitted_at    timestamptz,
    manager_submitted_at timestamptz,
    calibrated_at        timestamptz,
    finalized_at         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_evaluation_cycle_dev UNIQUE (tenant_id, cycle_id, developer_id)
);
CREATE INDEX ix_evaluations_cycle  ON public.evaluations (cycle_id);
CREATE INDEX ix_evaluations_dev    ON public.evaluations (developer_id);
CREATE INDEX ix_evaluations_mgr    ON public.evaluations (manager_id);
CREATE INDEX ix_evaluations_status ON public.evaluations (status);

CREATE TABLE public.evaluation_competency_scores (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    evaluation_id   uuid NOT NULL REFERENCES public.evaluations(id) ON DELETE CASCADE,
    -- competency_dimensions.key soft FK — dimension rename/비활성 시에도 score 보존.
    dimension_key   varchar(40) NOT NULL,
    self_score      integer CHECK (self_score    IS NULL OR self_score    BETWEEN 1 AND 5),
    manager_score   integer CHECK (manager_score IS NULL OR manager_score BETWEEN 1 AND 5),
    final_score     integer CHECK (final_score   IS NULL OR final_score   BETWEEN 1 AND 5),
    self_comment    text,
    manager_comment text,
    final_comment   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_eval_competency_eval_dim UNIQUE (evaluation_id, dimension_key)
);
CREATE INDEX ix_eval_competency_scores_eval ON public.evaluation_competency_scores (evaluation_id);
-- tenant_id / RLS / fn_auto_tenant_id 트리거는 파일 끝의 일괄 부여 블록이 처리.


-- =============================================================================
-- 대출 (Loan) — 자사 대출 원장 + 첨부
-- =============================================================================
-- 통화 KRW 고정. 은행은 bank_accounts FK 로 연결, 등록 시점 bank_name 은
-- snapshot 으로 보존해 통장 삭제(SET NULL) 후에도 표시 유지.

CREATE TABLE public.loans (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id   uuid          REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
    bank_name         varchar(100)  NOT NULL,                            -- snapshot
    category          varchar(100),                                       -- 구분 (자유 입력)
    -- SME_FACILITY (중소기업시설자금) | SME_GENERAL (중소기업자금) | CORP_OPERATING (기업운전일반자금)
    loan_type         varchar(30)   NOT NULL,
    -- 계좌번호는 별도 컬럼 X — 응답 직렬화 시 bank_account.account_number JOIN.
    contract_amount   numeric(18,0) NOT NULL DEFAULT 0,
    balance_amount    numeric(18,0) NOT NULL DEFAULT 0,
    interest_pay_day  smallint      CHECK (interest_pay_day BETWEEN 1 AND 31),
    maturity_date     date,
    is_overdraft      boolean       NOT NULL DEFAULT false,
    overdraft_limit   numeric(18,0),
    memo              text,
    -- ACTIVE | CLOSED — soft delete (만기·상환 완료).
    status            varchar(20)   NOT NULL DEFAULT 'ACTIVE',
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_loans_loan_type CHECK (loan_type IN ('SME_FACILITY','SME_GENERAL','CORP_OPERATING'))
);
CREATE INDEX ix_loans_bank_account ON public.loans (bank_account_id);
CREATE INDEX ix_loans_status       ON public.loans (status);
CREATE INDEX ix_loans_maturity     ON public.loans (maturity_date);


-- 대출 첨부 (대출약정서·담보서류 등). 다중 파일.
-- 디스크: data/loans/{loan_id}/<uuid>.<ext>. file_name 은 사용자 변경 가능.
CREATE TABLE public.loan_attachments (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_id      uuid          NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
    file_name    varchar(300)  NOT NULL,
    file_path    varchar(1024) NOT NULL,
    mime_type    varchar(120),
    size         bigint,
    description  text,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_loan_attachments_loan ON public.loan_attachments (loan_id);


-- =============================================================================
-- 휴가 유형 (LeaveType) — 자사 휴가 종류 마스터
-- =============================================================================
-- 기존 leave_requests.leave_type (varchar enum) 과 별개로 운영되는 reference
-- 테이블. UI select 옵션 채움, 카테고리·색상·규칙 메타데이터 보관. LeaveRequest
-- 와 FK 연결은 향후 PR 에서 마이그레이션.
CREATE TABLE public.leave_types (
    id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 영문/숫자/_. tenant 별로 동일 code 가능 → (tenant_id, code) 복합 UNIQUE 는 부록 ALTER 에서.
    code               varchar(40)    NOT NULL,
    name               varchar(100)   NOT NULL,
    -- ANNUAL | LIFE_EVENT | PUBLIC_DUTY | SICK | REWARD | OTHER
    category           varchar(30)    NOT NULL,
    -- DAY | HALF | HOUR
    unit               varchar(10)    NOT NULL DEFAULT 'DAY',
    deducts_annual     boolean        NOT NULL DEFAULT true,
    paid               boolean        NOT NULL DEFAULT true,
    max_days_per_year  numeric(4,1),
    max_uses_per_year  smallint,
    requires_evidence  boolean        NOT NULL DEFAULT false,
    requires_reason    boolean        NOT NULL DEFAULT false,
    color              varchar(7),                              -- HEX
    description        text,
    sort_order         smallint       NOT NULL DEFAULT 0,
    is_active          boolean        NOT NULL DEFAULT true,
    created_at         timestamptz    NOT NULL DEFAULT now(),
    updated_at         timestamptz    NOT NULL DEFAULT now()
);
CREATE INDEX ix_leave_types_active   ON public.leave_types (is_active);
CREATE INDEX ix_leave_types_category ON public.leave_types (category);
-- (tenant_id, code) 복합 UNIQUE — Stage 2a 부록의 tenant_id 추가 후 실행되도록
-- 끝부분 부록에서 idempotent 하게 다시 보장.



-- =============================================================================
-- Stage 2a 부록 — 모든 도메인 테이블에 tenant_id 추가 (멀티 테넌트 격리 준비)
-- =============================================================================
-- - 신규 설치 시 자동 적용. 기존 DB 업그레이드 시 ops/db_migrations/stage2a_tenant_id.sql
--   동일 로직.
-- - 컬럼은 nullable 로 추가 후 default tenant 1개 만들어 backfill.
-- - NOT NULL 전환과 RLS 활성화는 Stage 2b/3 에서.

-- default tenant 생성 — placeholder. 운영자가 Tenant 관리 UI 에서 수정.
ALTER TABLE public.tenants ALTER COLUMN id SET DEFAULT gen_random_uuid();

INSERT INTO public.tenants (slug, name, domains, is_active, number_prefix)
SELECT 'default', 'Default', ARRAY[]::varchar(120)[], true, 'DD'
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'default');

DO $$
DECLARE
  default_tid uuid;
  tbl text;
  tables text[] := ARRAY[
    'alarms', 'alarm_sends',
    'announcement_bookmarks',
    'approval_templates', 'approval_requests', 'approval_steps',
    'approval_history', 'approval_attachments',
    'goals', 'goal_due_alerts', 'goal_comments', 'goal_attachments', 'goal_score_baselines',
    'evaluation_cycles', 'competency_dimensions', 'evaluations', 'evaluation_competency_scores',
    'assignments',
    'attendances',
    'bank_accounts', 'bank_transactions',
    'quotes', 'quote_items', 'quote_versions',
    'invoices', 'invoice_items', 'invoice_versions',
    'board_posts', 'board_attachments', 'board_comments',
    'bookmarks',
    'company_assets',
    'company_cars', 'company_car_attachments',
    'company_insurances', 'company_insurance_attachments',
    'customers', 'license_contacts',
    'customer_contacts',
    'customer_interactions', 'customer_interaction_attachments',
    'developers', 'developer_approvers', 'developer_resumes',
    'developer_profiles', 'developer_certifications', 'developer_experiences',
    'developer_passports', 'developer_emergency_contacts', 'developer_interviews',
    'project_estimate_items',
    'developer_salaries',
    'job_runs',
    'leave_balances', 'leave_accruals', 'leave_reward_grants',
    'leave_requests', 'leave_request_allocations', 'leave_reset_history',
    'leave_types',
    'licenses', 'license_quotes', 'license_quote_items',
    'loans', 'loan_attachments', 'books', 'trips', 'trip_events',
    'weekly_report_assignments', 'weekly_reports', 'weekly_report_attachments', 'weekly_report_templates', 'weekly_report_comments',
    'meeting_rooms', 'meeting_reservations', 'meeting_reservation_participants',
    'meeting_notes', 'meeting_note_shares', 'meeting_note_attachments',
    'meeting_note_action_items',
    'account_codes',
    'rnd_budget_plans', 'rnd_budget_lines', 'rnd_budget_personnel',
    'budget_calc_plans', 'budget_calc_lines',
    'menu_permissions', 'feature_permissions',
    'opportunities', 'opportunity_activities',
    'opportunity_stage_history', 'opportunity_attachments',
    'patents', 'patent_attachments',
    'payroll_runs', 'payroll_items', 'payroll_distributions',
    'developer_tax_profile',
    'project_procurements',
    'projects', 'project_quotes', 'project_attachments', 'project_comments',
    'push_subscriptions',
    'developer_research_grants',
    'tax_invoices', 'tax_invoice_items', 'tax_invoice_fetches',
    'cloud_costs', 'cloud_cost_fetches',
    'cloud_cost_alert_rules', 'cloud_cost_alert_events',
    'vendor_bills', 'vendor_bill_attachments',
    'events', 'event_flights', 'event_lodgings', 'event_participants', 'event_attachments',
    'vendors', 'products', 'product_versions',
    'support_cases', 'support_case_attachments', 'support_case_comments', 'support_case_counters',
    'support_logs', 'support_log_attachments', 'support_log_comments',
    'holiday_alarm_recipients',
    'worksites', 'worksite_assignments'
  ];
BEGIN
  SELECT id INTO default_tid FROM public.tenants WHERE slug = 'default';
  IF default_tid IS NULL THEN RAISE EXCEPTION 'default tenant 가 없습니다.'; END IF;

  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid', tbl
      );
      EXECUTE format(
        'UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL',
        tbl, default_tid
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS ix_%I_tenant ON public.%I (tenant_id)',
        tbl, tbl
      );
      EXECUTE format($f$
        DO $inner$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.%I'::regclass
              AND conname  = '%I_tenant_id_fkey'
          ) THEN
            ALTER TABLE public.%I
              ADD CONSTRAINT %I_tenant_id_fkey
              FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;
          END IF;
        END $inner$;
      $f$, tbl, tbl, tbl, tbl);
    END IF;
  END LOOP;
END $$;

-- 기존 users — admin 부트스트랩 포함 모두 default tenant 로 backfill.
-- (SUPER_ADMIN 만 tenant_id IS NULL 유지.)
UPDATE public.users
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL AND role <> 'SUPER_ADMIN';


-- =============================================================================
-- 3a-pre 부록 — tenant_id 자동 backfill 트리거 (defensive layer)
-- =============================================================================
-- 앱 레벨 SQLAlchemy `before_flush` listener (app/core/tenant_listener.py) 가
-- 1차로 tenant_id 를 채우지만, listener 가 어떤 이유로 fire 하지 못하는 경우
-- (모듈 import 누락, 직접 SQL INSERT, 마이그레이션 스크립트 등) 를 대비한 마지막
-- 안전망. INSERT 시 NEW.tenant_id 가 NULL 이면 PostgreSQL session GUC `app.tenant_id`
-- 로부터 자동 채운다. GUC 도 비어 있으면 NULL 그대로 — NOT NULL 제약이 RAISE.

CREATE OR REPLACE FUNCTION public.fn_auto_tenant_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  guc text;
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  guc := current_setting('app.tenant_id', true);
  IF guc IS NULL OR guc = '' THEN
    RETURN NEW;  -- 못 채움 → 다음 단계 (NOT NULL 또는 RLS) 가 RAISE
  END IF;
  NEW.tenant_id := guc::uuid;
  RETURN NEW;
END $$;


-- =============================================================================
-- Stage 3a 부록 — Row-Level Security
-- =============================================================================
-- 정책 동작:
--   app.bypass_rls   = 'true' → 시스템 우회 (login·bootstrap 한정)
--   app.is_super_admin = 'true' → tenants/users 테이블만 우회
--   app.tenant_id    = '<uuid>' → 도메인 테이블 격리
-- ENABLE + FORCE 로 owner(orbit_super 유저)도 정책 적용 받음.

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'alarms', 'alarm_sends',
    'announcement_bookmarks',
    'approval_templates', 'approval_requests', 'approval_steps',
    'approval_history', 'approval_attachments',
    'goals', 'goal_due_alerts', 'goal_comments', 'goal_attachments', 'goal_score_baselines',
    'evaluation_cycles', 'competency_dimensions', 'evaluations', 'evaluation_competency_scores',
    'assignments',
    'attendances',
    'bank_accounts', 'bank_transactions',
    'quotes', 'quote_items', 'quote_versions',
    'invoices', 'invoice_items', 'invoice_versions',
    'board_posts', 'board_attachments', 'board_comments',
    'bookmarks',
    'company_assets',
    'company_cars', 'company_car_attachments',
    'company_insurances', 'company_insurance_attachments',
    'customers', 'license_contacts',
    'customer_contacts',
    'customer_interactions', 'customer_interaction_attachments',
    'developers', 'developer_approvers', 'developer_resumes',
    'developer_profiles', 'developer_certifications', 'developer_experiences',
    'developer_passports', 'developer_emergency_contacts', 'developer_interviews',
    'project_estimate_items',
    'developer_salaries',
    'job_runs',
    'leave_balances', 'leave_accruals', 'leave_reward_grants',
    'leave_requests', 'leave_request_allocations', 'leave_reset_history',
    'leave_types',
    'licenses', 'license_quotes', 'license_quote_items',
    'loans', 'loan_attachments', 'books', 'trips', 'trip_events',
    'weekly_report_assignments', 'weekly_reports', 'weekly_report_attachments', 'weekly_report_templates', 'weekly_report_comments',
    'meeting_rooms', 'meeting_reservations', 'meeting_reservation_participants',
    'meeting_notes', 'meeting_note_shares', 'meeting_note_attachments',
    'meeting_note_action_items',
    'account_codes',
    'rnd_budget_plans', 'rnd_budget_lines', 'rnd_budget_personnel',
    'budget_calc_plans', 'budget_calc_lines',
    'menu_permissions', 'feature_permissions',
    'opportunities', 'opportunity_activities',
    'opportunity_stage_history', 'opportunity_attachments',
    'patents', 'patent_attachments',
    'payroll_runs', 'payroll_items', 'payroll_distributions',
    'developer_tax_profile',
    'project_procurements',
    'projects', 'project_quotes', 'project_attachments', 'project_comments',
    'push_subscriptions',
    'developer_research_grants',
    'tax_invoices', 'tax_invoice_items', 'tax_invoice_fetches',
    'cloud_costs', 'cloud_cost_fetches',
    'cloud_cost_alert_rules', 'cloud_cost_alert_events',
    'vendor_bills', 'vendor_bill_attachments',
    'events', 'event_flights', 'event_lodgings', 'event_participants', 'event_attachments',
    'vendors', 'products', 'product_versions',
    'support_cases', 'support_case_attachments', 'support_case_comments', 'support_case_counters',
    'support_logs', 'support_log_attachments', 'support_log_comments',
    'holiday_alarm_recipients',
    'worksites', 'worksite_assignments'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name=tbl) THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_iso ON public.%I', tbl);
    EXECUTE format($p$
      CREATE POLICY tenant_iso ON public.%I
        AS PERMISSIVE FOR ALL
        USING (
          current_setting('app.bypass_rls', true) = 'true'
          OR (current_setting('app.tenant_id', true) <> ''
              AND tenant_id::text = current_setting('app.tenant_id', true))
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'true'
          OR (current_setting('app.tenant_id', true) <> ''
              AND tenant_id::text = current_setting('app.tenant_id', true))
        )
    $p$, tbl);
    -- BEFORE INSERT 트리거 — tenant_id NULL 이면 GUC 로 자동 backfill (defense layer 2).
    EXECUTE format('DROP TRIGGER IF EXISTS trg_auto_tenant_id ON public.%I', tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_auto_tenant_id BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_auto_tenant_id()',
      tbl
    );
  END LOOP;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_iso ON public.users;
CREATE POLICY users_tenant_iso ON public.users
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.is_super_admin', true) = 'true'
    OR (tenant_id IS NOT NULL
        AND current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.is_super_admin', true) = 'true'
    OR (tenant_id IS NOT NULL
        AND current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_super_admin ON public.tenants;
DROP POLICY IF EXISTS tenants_self        ON public.tenants;
CREATE POLICY tenants_super_admin ON public.tenants
  AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'true'
         OR current_setting('app.is_super_admin', true) = 'true')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'true'
              OR current_setting('app.is_super_admin', true) = 'true');
CREATE POLICY tenants_self ON public.tenants
  AS PERMISSIVE FOR SELECT
  USING (current_setting('app.tenant_id', true) <> ''
         AND id::text = current_setting('app.tenant_id', true));
CREATE POLICY tenants_self_update ON public.tenants
  AS PERMISSIVE FOR UPDATE
  USING (current_setting('app.tenant_id', true) <> ''
         AND id::text = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.tenant_id', true) <> ''
              AND id::text = current_setting('app.tenant_id', true));


-- Stage 3c — tenant_audit (SUPER_ADMIN 운영 액션 기록).
CREATE TABLE IF NOT EXISTS public.tenant_audit (
    id              uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id   uuid                    REFERENCES public.users(id) ON DELETE SET NULL,
    tenant_id       uuid                    REFERENCES public.tenants(id) ON DELETE SET NULL,
    action          varchar(40)             NOT NULL,
    payload         jsonb                   NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz             NOT NULL DEFAULT now(),
    updated_at      timestamptz             NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tenant_audit_action ON public.tenant_audit (action);
CREATE INDEX IF NOT EXISTS ix_tenant_audit_tenant ON public.tenant_audit (tenant_id);
CREATE INDEX IF NOT EXISTS ix_tenant_audit_actor  ON public.tenant_audit (actor_user_id);
CREATE INDEX IF NOT EXISTS ix_tenant_audit_created ON public.tenant_audit (created_at DESC);


-- =============================================================================
-- Stage 2b 부록 — tenant_id NOT NULL 전환
-- =============================================================================
-- Stage 2a 가 backfill 완료한 모든 도메인 테이블의 tenant_id 를 NOT NULL 로.
DO $$
DECLARE
  tbl text;
  null_cnt int;
  tables text[] := ARRAY[
    'alarms', 'alarm_sends', 'announcement_bookmarks',
    'approval_templates', 'approval_requests', 'approval_steps',
    'approval_history', 'approval_attachments',
    'goals', 'goal_due_alerts', 'goal_comments', 'goal_attachments', 'goal_score_baselines',
    'evaluation_cycles', 'competency_dimensions', 'evaluations', 'evaluation_competency_scores',
    'assignments', 'attendances',
    'bank_accounts', 'bank_transactions',
    'quotes', 'quote_items', 'quote_versions',
    'invoices', 'invoice_items', 'invoice_versions',
    'board_posts', 'board_attachments', 'board_comments',
    'bookmarks',
    'company_assets', 'company_cars', 'company_car_attachments',
    'company_insurances', 'company_insurance_attachments',
    'customers', 'license_contacts', 'customer_contacts',
    'customer_interactions', 'customer_interaction_attachments',
    'developers', 'developer_approvers', 'developer_resumes', 'developer_profiles',
    'developer_certifications', 'developer_experiences', 'developer_passports',
    'developer_emergency_contacts', 'developer_interviews',
    'project_estimate_items', 'developer_salaries',
    -- job_runs 는 의도적으로 제외 — 시스템 레벨 스케줄러 job 은 tenant 가 없음.
    'leave_balances', 'leave_accruals', 'leave_reward_grants',
    'leave_requests', 'leave_request_allocations', 'leave_reset_history', 'leave_types',
    'licenses', 'license_quotes', 'license_quote_items',
    'loans', 'loan_attachments', 'books', 'trips', 'trip_events',
    'weekly_report_assignments', 'weekly_reports', 'weekly_report_attachments', 'weekly_report_templates', 'weekly_report_comments',
    'meeting_rooms', 'meeting_reservations', 'meeting_reservation_participants',
    'meeting_notes', 'meeting_note_shares', 'meeting_note_attachments',
    'meeting_note_action_items',
    'account_codes',
    'rnd_budget_plans', 'rnd_budget_lines', 'rnd_budget_personnel',
    'budget_calc_plans', 'budget_calc_lines',
    'menu_permissions', 'feature_permissions',
    'opportunities', 'opportunity_activities', 'opportunity_stage_history', 'opportunity_attachments',
    'patents', 'patent_attachments',
    'payroll_runs', 'payroll_items', 'payroll_distributions', 'developer_tax_profile',
    'project_procurements', 'projects', 'project_quotes', 'project_attachments', 'project_comments',
    'push_subscriptions', 'developer_research_grants',
    'tax_invoices', 'tax_invoice_items', 'tax_invoice_fetches',
    'cloud_costs', 'cloud_cost_fetches',
    'cloud_cost_alert_rules', 'cloud_cost_alert_events',
    'vendor_bills', 'vendor_bill_attachments',
    'events', 'event_flights', 'event_lodgings', 'event_participants', 'event_attachments',
    'vendors', 'products', 'product_versions',
    'support_cases', 'support_case_attachments', 'support_case_comments', 'support_case_counters',
    'support_logs', 'support_log_attachments', 'support_log_comments',
    'holiday_alarm_recipients',
    'worksites', 'worksite_assignments'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name=tbl) THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id IS NULL', tbl) INTO null_cnt;
    IF null_cnt > 0 THEN
      RAISE EXCEPTION 'NOT NULL 전환 불가 — %.tenant_id 에 NULL row % 개 남음.', tbl, null_cnt;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', tbl);
  END LOOP;
END $$;
-- job_runs.tenant_id 는 NULL 허용 (스케줄러가 시스템 레벨로 도는 job).
-- MANUAL 트리거는 tenant_listener 가 ContextVar 의 current_tenant_id 로 채움.
ALTER TABLE public.job_runs ALTER COLUMN tenant_id DROP NOT NULL;


-- =============================================================================
-- Stage 5 부록 — lookup 키를 tenant 별로 분리 + default tenant 시드
-- =============================================================================
-- leave_types: 글로벌 UNIQUE(code) → (tenant_id, code) 복합 UNIQUE
ALTER TABLE public.leave_types DROP CONSTRAINT IF EXISTS leave_types_code_key;
DROP INDEX IF EXISTS leave_types_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_types_tenant_code
    ON public.leave_types (tenant_id, code);

-- meeting_rooms: 글로벌 UNIQUE(name) → (tenant_id, name) — 회사별 같은 이름 가능.
ALTER TABLE public.meeting_rooms DROP CONSTRAINT IF EXISTS meeting_rooms_name_key;
ALTER TABLE public.meeting_rooms DROP CONSTRAINT IF EXISTS meeting_rooms_tenant_name_key;
ALTER TABLE public.meeting_rooms ADD CONSTRAINT meeting_rooms_tenant_name_key
    UNIQUE (tenant_id, name);

-- menu_permissions PK (menu_key, role) → (tenant_id, menu_key, role)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'menu_permissions_pkey'
      AND conrelid = 'public.menu_permissions'::regclass
      AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE public.menu_permissions DROP CONSTRAINT menu_permissions_pkey;
    ALTER TABLE public.menu_permissions ADD CONSTRAINT menu_permissions_pkey
      PRIMARY KEY (tenant_id, menu_key, role);
  END IF;
END $$;

-- default tenant 의 leave_types 시드 (17 종 휴가 유형)
DO $$
DECLARE default_tid uuid;
BEGIN
  SELECT id INTO default_tid FROM public.tenants WHERE slug = 'default';
  IF default_tid IS NULL THEN RETURN; END IF;
  INSERT INTO public.leave_types
      (tenant_id, code, name, category, unit, deducts_annual, paid,
       max_days_per_year, requires_evidence, color, sort_order, is_active)
  VALUES
      (default_tid,'FAMILY_WEDDING','경조 - 결혼','LIFE_EVENT','DAY',false,true,5,true,'#F59E0B',10,true),
      (default_tid,'FAMILY_FUNERAL','경조 - 조의(사망)','LIFE_EVENT','DAY',false,true,5,true,'#F59E0B',11,true),
      (default_tid,'FAMILY_70TH','경조 - 칠순','LIFE_EVENT','DAY',false,true,1,true,'#F59E0B',12,true),
      (default_tid,'FAMILY_60TH','경조 - 회갑','LIFE_EVENT','DAY',false,true,1,true,'#F59E0B',13,true),
      (default_tid,'PUBLIC_HEALTH_CHECK','공가 - 건강검진','PUBLIC_DUTY','DAY',false,true,NULL,true,'#8B5CF6',20,true),
      (default_tid,'PUBLIC_CIVIL_DEFENSE','공가 - 민방위','PUBLIC_DUTY','DAY',false,true,NULL,true,'#8B5CF6',21,true),
      (default_tid,'PUBLIC_RESERVE_DUTY','공가 - 예비군','PUBLIC_DUTY','DAY',false,true,NULL,true,'#8B5CF6',22,true),
      (default_tid,'SICK_HEALTH','병가 - 보건휴가','SICK','DAY',false,true,NULL,false,'#EF4444',30,true),
      (default_tid,'SICK_PAID','병가 - 유급 병가','SICK','DAY',false,true,NULL,true,'#EF4444',31,true),
      (default_tid,'SICK_UNPAID','병가 - 무급 병가','SICK','DAY',false,false,NULL,false,'#EF4444',32,true),
      (default_tid,'ANNUAL_FULL','연차','ANNUAL','DAY',true,true,NULL,false,'#3B82F6',1,true),
      (default_tid,'ANNUAL_HALF_AM','반차 (오전)','ANNUAL','HALF',true,true,NULL,false,'#3B82F6',2,true),
      (default_tid,'ANNUAL_HALF_PM','반차 (오후)','ANNUAL','HALF',true,true,NULL,false,'#3B82F6',3,true),
      (default_tid,'REWARD_TENURE_5Y','포상 - 장기근속 5년','REWARD','DAY',false,true,NULL,false,'#10B981',40,true),
      (default_tid,'REWARD_TENURE_7Y','포상 - 장기근속 7년','REWARD','DAY',false,true,NULL,false,'#10B981',41,true),
      (default_tid,'REWARD_TENURE_10Y','포상 - 장기근속 10년','REWARD','DAY',false,true,NULL,false,'#10B981',42,true),
      (default_tid,'MATERNITY','출산휴가','LIFE_EVENT','DAY',false,true,90,true,'#F59E0B',50,true),
      (default_tid,'UNPAID_LEAVE','무급휴가','OTHER','DAY',false,false,NULL,false,'#6B7280',60,true)
  ON CONFLICT (tenant_id, code) DO NOTHING;
END $$;


-- =============================================================================
-- Stage 6 부록 — company_profile → tenants 컬럼 통합
-- =============================================================================
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bank_name        varchar(100);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bank_account     varchar(100);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bank_holder      varchar(100);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bank_name_en     varchar(100);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS bank_holder_en   varchar(100);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS logo_name        varchar(255);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS logo_path        varchar(1024);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS logo_mime        varchar(120);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS stamp_name       varchar(255);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS stamp_path       varchar(1024);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS stamp_mime       varchar(120);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS seal_name        varchar(255);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS seal_path        varchar(1024);
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS seal_mime        varchar(120);

-- 옛 company_profile 테이블 → tenants 마이그레이션 로직 (이미 production 적용 완료) 은
-- 테이블 자체가 제거된 후 git history 에서만 확인 가능. 신규 deployment 는
-- placeholder default tenant 로 시작 (운영자가 Tenant 관리에서 채움).


-- =============================================================================
-- Stage 7 부록 — hr_insurance_rates / withholding_tax 를 tenant 별로
-- =============================================================================
DO $$
DECLARE
  default_tid uuid;
  tbl text;
  tables text[] := ARRAY['hr_insurance_rates', 'withholding_tax_tables', 'withholding_tax_rows'];
BEGIN
  SELECT id INTO default_tid FROM public.tenants WHERE slug = 'default';
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name=tbl) THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid', tbl);
    IF default_tid IS NOT NULL THEN
      EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', tbl, default_tid);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', tbl);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%I_tenant ON public.%I (tenant_id)', tbl, tbl);
    EXECUTE format($f$
      DO $inner$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conrelid = 'public.%I'::regclass
                         AND conname  = '%I_tenant_id_fkey') THEN
          ALTER TABLE public.%I ADD CONSTRAINT %I_tenant_id_fkey
            FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;
        END IF;
      END $inner$;
    $f$, tbl, tbl, tbl, tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_iso ON public.%I', tbl);
    EXECUTE format($p$
      CREATE POLICY tenant_iso ON public.%I
        AS PERMISSIVE FOR ALL
        USING (
          current_setting('app.bypass_rls', true) = 'true'
          OR (current_setting('app.tenant_id', true) <> ''
              AND tenant_id::text = current_setting('app.tenant_id', true))
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'true'
          OR (current_setting('app.tenant_id', true) <> ''
              AND tenant_id::text = current_setting('app.tenant_id', true))
        )
    $p$, tbl);
  END LOOP;
END $$;


-- =============================================================================
-- Stage 8 부록 — app_settings tenant 별로 (NULL = 글로벌)
-- =============================================================================
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE public.app_settings SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.app_settings ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS tenant_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.app_settings'::regclass
                   AND conname = 'app_settings_tenant_id_fkey') THEN
    ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.app_settings'::regclass
               AND conname = 'app_settings_pkey'
               AND array_length(conkey, 1) = 1) THEN
    ALTER TABLE public.app_settings DROP CONSTRAINT app_settings_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.app_settings'::regclass
                   AND conname = 'app_settings_pkey') THEN
    ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_tenant_section
  ON public.app_settings (COALESCE(tenant_id::text, ''), section);

-- backfill — tenant 섹션은 default tenant 로, SUPER_ADMIN 섹션(backup/ecos/fred/exchange/announcements)은 NULL 유지.
DO $$
DECLARE default_tid uuid;
BEGIN
  SELECT id INTO default_tid FROM public.tenants WHERE slug = 'default';
  IF default_tid IS NOT NULL THEN
    UPDATE public.app_settings
       SET tenant_id = default_tid
     WHERE tenant_id IS NULL
       AND section NOT IN ('backup','ecos','fred','exchange','announcements','auth','upload','logging');
  END IF;
END $$;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.app_settings;
CREATE POLICY tenant_iso ON public.app_settings
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR current_setting('app.is_super_admin', true) = 'true'
    OR tenant_id IS NULL
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.is_super_admin', true) = 'true' AND tenant_id IS NULL)
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- =============================================================================
-- Stage 9 부록 — 알람 시스템 통합 (slack 섹션 → notify 섹션)
-- =============================================================================
-- 기존 'slack' 섹션을 'notify' 섹션으로 이전. notify 는 provider 선택 (slack |
-- mattermost) + 각 provider sub-section 으로 자격증명 분리 보관.
-- 마이그레이션 SQL: ops/db_migrations/stage9_notify_section.sql
-- 신규 설치는 이 부록이 자동 적용. 기존 DB 업그레이드는 위 파일을 수동 실행.
INSERT INTO public.app_settings (id, tenant_id, section, value, updated_by, updated_at)
SELECT
  gen_random_uuid(), s.tenant_id, 'notify',
  jsonb_build_object(
    'enabled', COALESCE((s.value->>'enabled')::boolean, false),
    'provider', 'slack',
    'slack', jsonb_build_object(
      'bot_token',           COALESCE(s.value->>'bot_token', ''),
      'default_webhook_url', COALESCE(s.value->>'default_webhook_url', ''),
      'default_channels',    COALESCE(s.value->'default_channels', '[]'::jsonb),
      'default_user_emails', COALESCE(s.value->'default_user_emails', '[]'::jsonb),
      'default_user_ids',    COALESCE(s.value->'default_user_ids', '[]'::jsonb),
      'emoji_prefix',        COALESCE(s.value->'notifications'->>'emoji_prefix', ':bell:')
    ),
    'mattermost', jsonb_build_object(
      'base_url', '', 'bot_token', '', 'default_team', '',
      'default_channels', '[]'::jsonb, 'default_user_emails', '[]'::jsonb
    ),
    'notifications', jsonb_build_object(
      'license_expiry_days_before',
        COALESCE(s.value->'notifications'->'license_expiry_days_before', '[30,14,7,1]'::jsonb),
      'license_renewal_prep',
        COALESCE((s.value->'notifications'->>'license_renewal_prep')::boolean, true)
    )
  ),
  s.updated_by, s.updated_at
FROM public.app_settings s
WHERE s.section = 'slack'
  AND NOT EXISTS (
    SELECT 1 FROM public.app_settings n
    WHERE n.section = 'notify'
      AND ((n.tenant_id IS NULL AND s.tenant_id IS NULL) OR n.tenant_id = s.tenant_id)
  );
DELETE FROM public.app_settings WHERE section = 'slack';


-- =============================================================================
-- Stage 10 부록 — AI 어시스턴트 (floating chat) 대화 영속화
-- =============================================================================
-- Gemini / Claude / OpenAI 를 통합한 대화형 어시스턴트가 cloud cost 등 도메인
-- 데이터를 tool calling 으로 조회. 한 사용자의 한 대화 = 1 conversation row,
-- 그 대화의 메시지 = N messages row.
--
-- 영속화는 app_settings.assistant.persist_conversations=true 일 때만 수행.
-- false 면 메모리 only — 페이지 새로고침 시 휘발.
--
-- tenant_id RLS 로 tenant 격리. 같은 tenant 안에서도 user_id 로 자기 대화만
-- 보이도록 API 레이어에서 추가 필터.

CREATE TABLE IF NOT EXISTS public.assistant_conversations (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id     uuid          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title       varchar(200),
    provider    varchar(20),                         -- gemini | claude | openai
    model       varchar(80),
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_assistant_conv_tenant ON public.assistant_conversations (tenant_id);
CREATE INDEX IF NOT EXISTS ix_assistant_conv_user   ON public.assistant_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.assistant_messages (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid          NOT NULL REFERENCES public.assistant_conversations(id) ON DELETE CASCADE,
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    role            varchar(16)   NOT NULL,          -- user | assistant | tool
    content         text,
    tool_calls      jsonb,                            -- assistant role 의 [{id,name,args},...]
    tool_result     jsonb,                            -- tool role 의 {tool_call_id,name,result|error}
    tokens_in       integer,
    tokens_out      integer,
    cached_tokens   integer,                          -- prompt cache hit 토큰 (provider 보고 시)
    provider        varchar(20),
    model           varchar(80),
    created_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_assistant_msg_conv   ON public.assistant_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ix_assistant_msg_tenant ON public.assistant_messages (tenant_id);

ALTER TABLE public.assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_conversations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.assistant_conversations;
CREATE POLICY tenant_iso ON public.assistant_conversations
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.assistant_messages;
CREATE POLICY tenant_iso ON public.assistant_messages
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- =============================================================================
-- 19) 마케팅 — 캠페인 / 이메일 / Google Ads
-- =============================================================================
--
-- 타겟 = 기존 고객. Lead 도메인 없음. 수신자 = customer_contacts (회사 FK 보유).
-- 채널은 EMAIL · GOOGLE_ADS 두 종류만 1차에서 지원.
--
-- 흐름:
--   1) customer_segments 정의 (어느 고객들에게 보낼지)
--   2) marketing_campaigns 생성 (채널·기간·예산·세그먼트 연결)
--   3) EMAIL 채널: marketing_email_templates + send_now/schedule
--      → marketing_email_sends 에 수신자별 row insert + 발송 결과 갱신
--      → 오픈/클릭 픽셀·리다이렉트 라우터로 카운터 증분
--   4) GOOGLE_ADS 채널: marketing_google_ads_metrics 일별 KPI 시계열
--      (외부 API 동기화 결과). 1차에서 manual sync.
--   5) 모든 채널 공통: marketing_campaign_touches 에 attribution 행 적재.
--
-- RLS: 모든 테이블에 tenant_iso 정책 적용. 발송 로그는 email_sends 의
--      tenant_id 컬럼으로 격리.

-- 캠페인 수신자 세그먼트 — 재사용 가능한 추출 조건.
-- 1차 단순 모델: 명시적 customer_id 배열 + 옵션 (partners 포함, contact 한정).
-- 추후 jsonb filter 확장.
CREATE TABLE public.customer_segments (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid         NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    name            varchar(120) NOT NULL,
    description     text,
    -- 명시 고객사 ID 배열 — 빈 배열 = 전체 고객 (include_partners 와 조합).
    customer_ids    uuid[]       NOT NULL DEFAULT '{}'::uuid[],
    -- 특정 contact 만 발송 대상이면 contact_ids 지정. NULL/빈배열 = customer_ids
    -- 의 모든 contact (kind 필터 적용 후).
    contact_ids     uuid[]       NOT NULL DEFAULT '{}'::uuid[],
    -- 회사 직원(developers) UUID — 내부 임직원에게도 마케팅 메일 발송할 때.
    -- 저장 시 각 developer 별로 kind='EMPLOYEE' 인 shadow CustomerContact 가
    -- lookup-or-create 되어 contact_ids 에도 합쳐진다. 이 컬럼은 UI 상태 보존용.
    developer_ids   uuid[]       NOT NULL DEFAULT '{}'::uuid[],
    -- 'CUSTOMER' | 'PARTNER' | 'ALL' — customer_contacts.kind 필터.
    include_kinds   varchar(20)[] NOT NULL DEFAULT ARRAY['CUSTOMER']::varchar[],
    created_by      uuid         REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_customer_segments_tenant ON public.customer_segments (tenant_id);
CREATE INDEX ix_customer_segments_name   ON public.customer_segments (tenant_id, name);

ALTER TABLE public.customer_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_segments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.customer_segments;
CREATE POLICY tenant_iso ON public.customer_segments
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- 이메일 템플릿 — 캠페인에서 참조. 머지필드는 {{customer_name}} {{contact_name}} 등.
CREATE TABLE public.marketing_email_templates (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    name         varchar(120)  NOT NULL,
    subject      varchar(500)  NOT NULL,
    -- body 입력 방식: HTML(textarea 직접) | EDITOR(BlockNote) | IMPORT(URL 가져오기).
    -- 발송 시점에 body_html 만 사용. body_json 은 EDITOR 모드 편집 round-trip 용.
    body_kind    varchar(20)   NOT NULL DEFAULT 'HTML',
    body_html    text          NOT NULL DEFAULT '',
    -- BlockNote raw blocks (EDITOR 모드만). 그 외는 NULL.
    body_json    jsonb,
    body_text    text          NOT NULL DEFAULT '',
    -- 발송 시점에 머지필드 치환 (단순 문자열 replace). 지원 키 목록을 UI 에서 hint 로 노출.
    description  text,
    created_by   uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    last_used_at timestamptz,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_marketing_email_templates_tenant ON public.marketing_email_templates (tenant_id);
CREATE INDEX ix_marketing_email_templates_name   ON public.marketing_email_templates (tenant_id, name);

ALTER TABLE public.marketing_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_templates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_email_templates;
CREATE POLICY tenant_iso ON public.marketing_email_templates
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );

-- 템플릿 본문에 인라인 임베드되는 이미지/파일.
-- 본문 HTML 의 <img src="cid:{content_id}"> 와 매칭되어 발송 시 multipart/related
-- part 의 Content-ID 헤더로 들어간다.
CREATE TABLE public.marketing_email_template_assets (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    template_id  uuid          NOT NULL REFERENCES public.marketing_email_templates(id) ON DELETE CASCADE,
    content_id   varchar(80)   NOT NULL,
    file_name    varchar(300)  NOT NULL,
    file_path    varchar(1024) NOT NULL,
    mime_type    varchar(120),
    size         bigint,
    uploaded_by  uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (template_id, content_id)
);
CREATE INDEX ix_marketing_email_template_assets_template ON public.marketing_email_template_assets (template_id);

ALTER TABLE public.marketing_email_template_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_template_assets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_email_template_assets;
CREATE POLICY tenant_iso ON public.marketing_email_template_assets
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- 마케팅 캠페인 — 모든 채널 공통 베이스. channel 컬럼으로 분기.
-- 채널별 고유 필드:
--   EMAIL       : email_template_id, scheduled_at, send_started_at, send_finished_at,
--                 from_address, from_name, reply_to
--   GOOGLE_ADS  : ga_customer_id, ga_external_id, ga_campaign_type, ga_daily_budget,
--                 ga_last_synced_at
-- 다른 채널 필드는 미사용시 NULL.
CREATE TABLE public.marketing_campaigns (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    name            varchar(200)  NOT NULL,
    -- EMAIL | GOOGLE_ADS — 1차 지원. 추가 채널은 enum 확장.
    channel         varchar(20)   NOT NULL,
    -- PLANNED | RUNNING | PAUSED | COMPLETED | ARCHIVED
    status          varchar(20)   NOT NULL DEFAULT 'PLANNED',
    -- CROSS_SELL | UPSELL | NURTURE | RETENTION | WIN_BACK | EVENT_INVITE | OTHER
    objective       varchar(20)   NOT NULL DEFAULT 'NURTURE',
    start_date      date,
    end_date        date,
    budget          numeric(18, 2) NOT NULL DEFAULT 0,
    actual_cost     numeric(18, 2) NOT NULL DEFAULT 0,
    currency        varchar(3)    NOT NULL DEFAULT 'KRW',
    owner_id        uuid          REFERENCES public.users(id) ON DELETE SET NULL,
    segment_id      uuid          REFERENCES public.customer_segments(id) ON DELETE SET NULL,
    -- UTM 표준 추적 키 — 이메일 본문 링크에 자동 부착. GAds 는 sync 결과.
    utm_source      varchar(60),
    utm_medium      varchar(60),
    utm_campaign    varchar(120),
    notes           text,
    -- ---- EMAIL channel fields (NULL when channel != 'EMAIL') ----
    email_template_id   uuid       REFERENCES public.marketing_email_templates(id) ON DELETE SET NULL,
    from_address        varchar(200),
    from_name           varchar(120),
    reply_to            varchar(200),
    scheduled_at        timestamptz,
    send_started_at     timestamptz,
    send_finished_at    timestamptz,
    -- ---- GOOGLE_ADS channel fields ----
    ga_customer_id      varchar(40),  -- 외부 Google Ads 계정 ID (xxx-xxx-xxxx)
    ga_external_id      varchar(60),  -- 외부 캠페인 ID
    ga_campaign_type    varchar(30),  -- SEARCH | DISPLAY | VIDEO | PMAX
    ga_daily_budget     numeric(18, 2),
    ga_last_synced_at   timestamptz,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_marketing_campaigns_tenant   ON public.marketing_campaigns (tenant_id);
CREATE INDEX ix_marketing_campaigns_channel  ON public.marketing_campaigns (tenant_id, channel);
CREATE INDEX ix_marketing_campaigns_status   ON public.marketing_campaigns (tenant_id, status);
CREATE INDEX ix_marketing_campaigns_owner    ON public.marketing_campaigns (owner_id);

ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_campaigns;
CREATE POLICY tenant_iso ON public.marketing_campaigns
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- 이메일 수신거부 마스터 — 정보통신망법 50조 의무. 발송 직전 필터.
-- email 단일 키 (대소문자 무시 — 저장은 lowercase). tenant 격리.
CREATE TABLE public.marketing_email_unsubscribes (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    email           varchar(200)  NOT NULL,
    reason          text,
    unsubscribed_at timestamptz   NOT NULL DEFAULT now(),
    -- 어느 캠페인 링크로 해지했는지 추적용 (NULL 도 가능 — 수동 추가).
    source_campaign_id uuid       REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
    created_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_marketing_email_unsubscribes
    ON public.marketing_email_unsubscribes (tenant_id, lower(email));

ALTER TABLE public.marketing_email_unsubscribes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_unsubscribes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_email_unsubscribes;
CREATE POLICY tenant_iso ON public.marketing_email_unsubscribes
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- 캠페인 발송 로그 (수신자 단위) — EMAIL 채널 전용.
-- 발송 직전 INSERT (status='QUEUED') → 발송 결과로 UPDATE.
-- 오픈 픽셀·클릭 리다이렉트가 카운터를 증분.
CREATE TABLE public.marketing_email_sends (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    campaign_id         uuid          NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
    customer_contact_id uuid          REFERENCES public.customer_contacts(id) ON DELETE SET NULL,
    customer_id         uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    to_address          varchar(200)  NOT NULL,
    -- QUEUED | SENT | BOUNCED | FAILED | SKIPPED_UNSUBSCRIBED
    status              varchar(30)   NOT NULL DEFAULT 'QUEUED',
    sent_at             timestamptz,
    error_message       text,
    open_count          integer       NOT NULL DEFAULT 0,
    first_opened_at     timestamptz,
    last_opened_at      timestamptz,
    click_count         integer       NOT NULL DEFAULT 0,
    first_clicked_at    timestamptz,
    last_clicked_at     timestamptz,
    unsubscribed_at     timestamptz,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_marketing_email_sends_campaign ON public.marketing_email_sends (campaign_id, status);
CREATE INDEX ix_marketing_email_sends_contact  ON public.marketing_email_sends (customer_contact_id);
CREATE INDEX ix_marketing_email_sends_to       ON public.marketing_email_sends (tenant_id, lower(to_address));

ALTER TABLE public.marketing_email_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_sends FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_email_sends;
CREATE POLICY tenant_iso ON public.marketing_email_sends
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- Google Ads 일별 KPI 시계열 — 외부 API sync 결과.
-- 1차에서는 수동 sync 버튼 (cron 은 2차). PK (campaign_id, date) 로 upsert.
CREATE TABLE public.marketing_google_ads_metrics (
    tenant_id           uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    campaign_id         uuid          NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
    metric_date         date          NOT NULL,
    impressions         bigint        NOT NULL DEFAULT 0,
    clicks              bigint        NOT NULL DEFAULT 0,
    cost_micros         bigint        NOT NULL DEFAULT 0,   -- micros (원의 1/1,000,000)
    conversions         numeric(12,2) NOT NULL DEFAULT 0,
    conversions_value   numeric(18,2) NOT NULL DEFAULT 0,
    synced_at           timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, metric_date)
);
CREATE INDEX ix_marketing_google_ads_metrics_tenant
    ON public.marketing_google_ads_metrics (tenant_id, metric_date);

ALTER TABLE public.marketing_google_ads_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_google_ads_metrics FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_google_ads_metrics;
CREATE POLICY tenant_iso ON public.marketing_google_ads_metrics
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- 캠페인 ↔ 고객 attribution — 모든 채널 공통.
-- touch_type: SENT(메일 발송) / OPENED / CLICKED / GA_IMPRESSION / GA_CLICK / CONVERTED.
-- 분석 쿼리: "이 고객은 어느 캠페인 이후 추가 계약했나" — converted 이벤트는 수동/cron.
CREATE TABLE public.marketing_campaign_touches (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
    campaign_id     uuid          NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
    customer_id     uuid          REFERENCES public.customers(id) ON DELETE SET NULL,
    customer_contact_id uuid      REFERENCES public.customer_contacts(id) ON DELETE SET NULL,
    touch_type      varchar(30)   NOT NULL,
    occurred_at     timestamptz   NOT NULL DEFAULT now(),
    metadata        jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ix_marketing_touches_campaign ON public.marketing_campaign_touches (campaign_id, occurred_at);
CREATE INDEX ix_marketing_touches_customer ON public.marketing_campaign_touches (customer_id);
CREATE INDEX ix_marketing_touches_tenant   ON public.marketing_campaign_touches (tenant_id, occurred_at);

ALTER TABLE public.marketing_campaign_touches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaign_touches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON public.marketing_campaign_touches;
CREATE POLICY tenant_iso ON public.marketing_campaign_touches
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  );


-- =============================================================================
-- 완료
-- =============================================================================
