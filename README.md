# Orbit Works

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](./LICENSE.md)

영업기회 · SW 라이센스 · 임직원 · 프로젝트 · 투입 · 급여 · 청구 · 회사 자산 · 출퇴근 · 사업공고를 통합 관리하는 **멀티테넌트** 운영 SaaS.

## 기술 스택

- **Backend**: FastAPI, SQLAlchemy 2 (async, asyncpg), Pydantic v2, PostgreSQL 16, PyJWT · bcrypt, APScheduler, httpx, OpenPyXL, **PostgreSQL Row-Level Security (RLS)** 기반 tenant 격리
- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS, AG Grid 32, FullCalendar, TanStack Query v5, html2canvas + jsPDF
- **SUPER_ADMIN**: Next.js 15 — `/admin` basePath, tenant·시스템 운영 콘솔
- **Shared**: `@orbit/shared` (pnpm workspace, 공용 타입·유틸)
- **배포**: Docker Compose (`db` / `backend` / `frontend` / `drawio`)

## 멀티테넌트 아키텍처

Orbit Works 은 단일 deployment 가 여러 회사(=tenant) 를 격리해 호스팅합니다.

### 격리 계층 (5-layer defense)

1. **JWT** — 토큰의 `tenant_id` claim 으로 사용자 소속 식별.
2. **ContextVar** — FastAPI 미들웨어(`app/core/tenant_middleware.py`) 가 매 요청마다 JWT 의 tenant_id 를 `ContextVar` 에 set.
3. **PostgreSQL GUC** — `get_db()` 가 세션마다 `app.tenant_id`, `app.bypass_rls`, `app.is_super_admin` 을 `set_config()` 로 주입.
4. **App-level INSERT listener** — `tenant_listener.py` 의 SQLAlchemy `before_flush` 이벤트가 `tenant_id` 미지정 객체에 ContextVar 값을 자동 주입.
5. **DB-level INSERT 트리거** (방어망) — 모든 tenant 테이블에 `trg_auto_tenant_id` 가 BEFORE INSERT 로 걸려, `tenant_id` 가 NULL 이면 `app.tenant_id` GUC 로 자동 backfill. 앱 listener 가 어떤 이유로 fire 하지 못해도 DB 가 보장.
6. **Row-Level Security** — 모든 도메인 테이블에 `FORCE ROW LEVEL SECURITY` + `tenant_iso` 정책 (`tenant_id::text = current_setting('app.tenant_id')`). 위 layer 가 모두 통과해도 잘못된 tenant_id 면 DB 가 차단.

### 추가 보호장치

- **DB 롤 분리**: 앱은 `orbit_app` (NOSUPERUSER NOBYPASSRLS) 로 접속 → RLS 가 실제 적용. `orbit_super` (bootstrap SUPERUSER) 는 백업·DDL 전용으로 격리. PostgreSQL 이 bootstrap user 강등을 거부하므로 영구 분리.
- **시스템 세션**: 백그라운드 cron · 로그인 등 요청 컨텍스트가 없는 코드는 `system_session()` 로 `app.bypass_rls=true` 를 명시적으로 set 한 뒤 cross-tenant 작업.
- **파일 격리**: 업로드 파일 디스크 경로는 `data/<tenant_uuid>/<resource>/<entity_id>/<file>` — DB 에는 tenant 내 상대경로만 저장하고 `storage.resolve_upload_path()` 가 ContextVar 의 tenant_id 로 prefix 합성.
- **시크릿 암호화**: 클라우드 자격증명(AWS/Azure/GCP), Bot token, **임직원 여권번호** 등 민감 데이터는 `app/core/secrets_crypto.py` 의 Fernet (AES-128-CBC + HMAC) 으로 암호화되어 `app_settings` / `developer_passports.passport_number_enc` 에 저장. 마스터 키는 `config.yaml` 의 `security.secrets_key` — DB 백업 유출만으로는 복호화 불가.

### Tenant 모델

| 역할 | tenant_id | 설명 |
|---|---|---|
| **SUPER_ADMIN** (`admin`) | NULL | 단일 deployment 운영자. `/admin/*` UI 만 사용. 도메인 데이터 미노출(RLS 가 자연스럽게 막음). |
| **ADMIN** (`<email>@<domain>`) | tenant UUID | 해당 tenant 의 운영자. 일반 dashboard + Settings (tenant 범위) 사용. |
| **HR / SALES / SUPPORT / ETC** | tenant UUID | 일반 임직원. security_role 별 메뉴 가시성. |

로그인은 이메일 도메인 → tenants.domains 매칭으로 tenant 를 결정 → 해당 tenant 안에서 user/developer 룩업.

### 데이터 디렉터리

```
data/
  <tenant_uuid>/                  ← e.g. ea9c1c3e-c9bd-490d-ac8a-94052d10fe67
    licenses/<id>/<uuid>.pdf
    projects/<id>/<uuid>.xlsx
    company-cars/<id>/<uuid>.png
    ...
  backups/                        ← tenant 무관 시스템 백업
    YYYYMMDD-HHMMSS-db.zip
```

## 빠른 시작

```bash
# 1. 런타임 설정 파일 생성 (둘 다 .gitignore 등록되어 clone 후 수동 생성)
cp config.yaml.template config.yaml
cp docker-compose.yml.template docker-compose.yml
vi config.yaml                    # CHANGE_ME / 빈값으로 표시된 시크릿 채움
vi docker-compose.yml             # POSTGRES_PASSWORD 등 — config.yaml 과 일치

# 2. 컨테이너 기동
docker compose up --build
```

**데이터 영속화** — `docker-compose.yml` 이 호스트 디렉터리를 bind-mount:
- `${DATA_DIR:-./data}` → `/app/data` — 업로드 파일 (tenant prefix), 월간 DB 백업
- `${PG_DATA_DIR:-./pgdata}` → `/var/lib/postgresql/data` — PostgreSQL data directory

다른 경로 사용 시 `.env` 에 `DATA_DIR=/srv/orbit-data`, `PG_DATA_DIR=/srv/orbit-pg` 지정.

- Frontend (Desktop): http://localhost:4000
- Frontend (Mobile PWA): http://localhost:4000/m
- SUPER_ADMIN console: http://localhost:4000/admin
- Backend API: http://localhost:4001 (OpenAPI: `/docs`)
- PostgreSQL: `localhost:5432` (DB: `orbit`)

첫 기동 시 `Base.metadata.create_all()` 가 모든 테이블을 생성하지만, **멀티테넌트 RLS·tenant_id NOT NULL·정책은 [`db.sql`](./db.sql) 의 Stage 1~8 부록 SQL 에서만 생성됩니다**. 신규 환경은 `db.sql` 을 직접 적용 권장:

```bash
psql -U orbit -d orbit -f db.sql
```

신규 deployment 는 위 한 번이면 충분합니다. **평상시 schema 변경**은 stage 파일 같은 마이그레이션 도구 없이 SQLAlchemy 모델 + `db.sql` + production 에 `ALTER` 직접 실행 으로 진행합니다.

## 주요 기능

전체 기능 목록과 한 줄 요약은 [features.md](./features.md) 참조. 대분류만 옮기면:
**홈 · 영업 · 기술지원 · 라이센스 · 자원 · 인사 · 근태 · 예산 · 관리** 9 개 사이드바 그룹 + SUPER_ADMIN 영역.

### 백그라운드 cron (시스템 레벨)

| 시각 (KST) | job | 설명 |
|---|---|---|
| 매일 01:00 | 일일 알림 | 프로젝트/투입/라이센스 D-30 → Slack `#alert` |
| 매일 09:00 | 비공개 일정 알람 | `/calendar` 의 `EVENT_PRIVATE` 일정에 등록된 알람 수신자에게 Slack DM. `notified_at` 으로 중복 발송 차단. |
| 매일 09:05 | 회의록 액션 마감 DM | 미완료 액션 아이템 중 마감 D-3/D-1/D-Day 인 항목을 담당자별 그루핑해 Slack DM 1통 (담당자 = 정규직 매핑된 developer, 외부 게스트는 자동 스킵). |
| 매일 09:10 | 목표 마감 알림 | 활성 PERSONAL/COMPANY 목표의 D-30 1회 + D-Day 후 첫 영업일 1회 OVERDUE 발송. 수신자: PERSONAL = owner + 직속 매니저 / COMPANY = ADMIN role. `goal_due_alerts(goal_id, alert_kind)` UNIQUE 로 dedup. |
| 매일 03:00 | 환율 자동 수집 | Frankfurter ECB |
| 매일 03:00 | 금리 자동 수집 | ECOS Open API |
| 매일 03:00 | 주가 자동 수집 | ECOS + FRED |
| 매일 03:00 | DB 자동 백업 | `pg_dump` → `<backup.dir>/YYYYMMDD-HHMMSS-db.zip` |
| 매일 03:00 | 사업공고 일간 수집 | source priority 오름차순 순차 호출, 활성 소스만 |
| 매일 03:00 | 전자세금계산서 (바로빌) | 최근 3일 재조회·upsert (지연 등록 대응) |
| 매일 04:00 | 클라우드 비용 일간 수집 | AWS/Azure/GCP, **단일 range 호출** (catchup_days 기간) → 알람 규칙 평가 |
| 매일 04:00 | 작업 이력 정리 | 14일 이전 row 삭제 |
| 매일 04:00 | 알람 이력 정리 | 7일 이전 row 삭제 |

모두 `job_runs` 테이블에 status·duration·result_summary·extra(JSONB) 로 통합 기록. `/admin/job-runs` 에서 조회.

## 첨부 미리보기 (Cross-cutting)

`<AttachmentPreviewButton filename mime downloadPath />` 공용 컴포넌트 — 11+ 모듈
(게시판·공지·회의록·주간보고·목표·영업기회·고객 활동·매입 인보이스·특허·대출·
기술지원 케이스/로그·결재·이벤트) 의 첨부 row 에 한 줄로 적용. axios 인터셉터로
인증된 blob fetch → object URL → mime/확장자 기반 dispatch.

**지원 14 카테고리 / 약 90 확장자**:

- **Tier 1 네이티브** — 이미지 (PNG/JPG/GIF/WebP/SVG/AVIF/BMP/ICO) · PDF (iframe)
  · 비디오 (MP4/WebM/Ogg) · 오디오 (MP3/WAV/OGG/M4A/FLAC/AAC) · HTML
  (sandboxed iframe).
- **Tier 2 텍스트** — Markdown (react-markdown + remark-gfm) · 소스 코드 50종
  (highlight.js auto-detect) · CSV/TSV (papaparse, 1000행 cap) · JSON · YAML/TOML
  (js-yaml + 원본/JSON 2-pane) · XML · 단순 텍스트/로그/설정.
- **Tier 2 Office** — Excel (xlsx/xlsm/xls — SheetJS, 시트 탭) · Word (docx —
  docx-preview, 서식 보존).
- **Fallback** — 미지원 시 다운로드 안내.

외부 라이브러리 (highlight.js / docx-preview / xlsx / papaparse / js-yaml) 는
**모달 열릴 때 동적 import** — 첫 페이지 bundle 영향 0.

미지원 (다운로드만 가능): HWP/HWPX (한컴), PPTX, AVI/MOV/MKV (브라우저 미지원
코덱), ZIP/TAR, 3D/CAD. 향후 Phase 3 — 서버 LibreOffice 변환 (Office 전체 PDF
폴백 + 한글 지원) 으로 확장 가능.

## 인증 · 권한

### 역할

| 역할 | 범위 | 권한 |
|---|---|---|
| **SUPER_ADMIN** | 시스템 (tenant_id=NULL) | tenant CRUD, 시스템 설정, 백업, 사업공고 source, 외부 데이터, 작업 이력. 도메인 데이터 비노출. |
| **ADMIN** | tenant | 해당 tenant 의 모든 권한. tenant 프로필·메뉴 권한 편집 가능. |
| **HR (관리)** | tenant | 임직원·연차·급여·공휴일·회의실·프로젝트. ADMIN 부여 불가. |
| **SALES** | tenant | 영업기회·견적·청구·라이센스·고객사. |
| **SUPPORT** | tenant | 라이센스·고객사 조회/편집, 회의실. |
| **ETC** | tenant | 공지/게시판/본인 연차/본인 회의실. |

역할별 권한 집합은 [`backend/app/core/roles.py`](./backend/app/core/roles.py) 가 단일 원천. 사이드바 메뉴 표시 여부는 **Settings > 메뉴 권한** 에서 역할 × 메뉴 매트릭스로 오버라이드 가능 (ADMIN 은 항상 전체).

### 권한 게이트 3계층 + 개별 user grant

| 계층 | 대상 | 구현 |
|---|---|---|
| **사이드바 가시성** | 메뉴 항목 노출 여부 | `menu_permissions` 테이블 + `isMenuVisible(perms, key, role)` (`menu-registry.ts`) |
| **URL/페이지 가드** | 직접 URL 입력 차단 | `(dashboard)/layout.tsx` 의 `resolveMenuKeyFromPath(pathname)` → `isMenuVisible` 차단 시 `/` 로 `router.replace`. 백엔드는 `require_menu(menu_key)` 의존성을 라우터별 `dependencies=[Depends(require_menu("..."))]` 로 부착 (`api/v1/router.py`). curl 우회까지 차단. |
| **페이지 내 기능 가드 (role 단위)** | 버튼·필드·탭 단위 | `feature_permissions` 테이블 + `hasFeature(perms, key, role)` (`feature-registry.ts`) + 백엔드 `require_feature(key)` / `has_feature(db, user, key)` (`deps.py`). 임직원 메뉴에서 등록·급여·보안 역할·비번 재설정·여권/비상연락처/면담 탭 등 9개 키로 시작. |
| **개별 user grant** | 한 명에게만 특정 기능 위임 | `user_feature_grants` 테이블 (`(tenant_id, user_id, feature_key)` PK) + `current_user_grants` ContextVar (요청 진입 시 1회 로드). ADMIN role 부여 없이 SALES 등 일반 사용자에게도 한정 권한 부여 가능. 부여 가능 키는 `app.core.grantable_features.KNOWN_GRANTABLE_FEATURES` 카탈로그(첫 키: `weekly_reports.view_all`). ADMIN/SUPER_ADMIN 이 임직원 상세 > 기본 탭의 "추가 권한" 섹션에서 체크박스 토글로 부여/해제. |

ADMIN/SUPER_ADMIN 은 모든 계층 자동 통과. 본인 데이터 자기 열람 (자기 여권·비상연락처) 은 `feature_permissions` 과 무관하게 코드 invariant 로 보장. HR→ADMIN 권한 상승, 마지막 ADMIN 강등도 코드 invariant.

`menu_permissions` / `feature_permissions` / `user_feature_grants` 모두 tenant 별로 격리. 메뉴/기능 매트릭스는 첫 GET 호출 시 `DEFAULT_*_PERMISSIONS` 가 자동 seed 되며, 이후 Settings UI 에서 ADMIN 이 자유 편집. 차단된 endpoint 호출은 WARNING 로그로 audit trail.

### 로그인 흐름

1. 이메일 도메인 → `tenants.domains` 매칭으로 tenant 결정.
2. 해당 tenant 안에서 `users` 테이블 룩업 (SUPER_ADMIN/ADMIN 경로).
3. 매칭되지 않으면 **글로벌 fallback** (SUPER_ADMIN, role=`SUPER_ADMIN`).
4. 그래도 없으면 `developers` 테이블 룩업 (일반 임직원, 비번 권위는 `developers.hashed_password`).
5. 최초 로그인은 주민번호 앞 6자리(생년월일) → 즉시 `/password-change` 강제 진입.

JWT payload: `{sub, exp, role, kind: "user"|"developer", tenant_id}`. 매 요청마다 미들웨어가 ContextVar 와 PostgreSQL GUC 에 propagate.

### 사용자 ↔ 임직원 자동 매핑

`users.mapped_developer_id` 가 비어 있으면 PERSONAL 목표·내 액션·공유받은 회의록 등 본인 정보가 안 보임. 이를 누락 없이 유지하기 위한 **4-layer 방어**:

| 층 | 트리거 | 동작 |
|---|---|---|
| L1 | Developer 생성/수정 (이메일 변경) | 같은 이메일의 사용자가 있으면 매핑 채움. 미로그인 사용자도 cover. |
| L2 | User 생성 (가입) | 같은 이메일의 developer 가 있으면 매핑 채움. |
| L3 | 로그인 직후 (defensive) | `mapped_developer_id IS NULL` 이면 이메일 매칭 재시도. |
| L4 | 1회성 backfill SQL | 기존 누락 데이터 정정. |

이미 매핑된 user 는 절대 변경하지 않음 (관리자 의도 보호). 매칭 누락은 silent skip (정상 흐름). 매핑 변화는 모두 INFO logging, 동일 이메일에 여러 developer 매칭은 WARNING. helper: [`backend/app/services/user_developer_sync.py`](./backend/app/services/user_developer_sync.py).

## 구성 (config.yaml)

모든 런타임 설정은 프로젝트 루트의 [`config.yaml`](./config.yaml). 섹션 요약:

| 섹션 | 범위 | 설명 |
|---|---|---|
| `app` | 시스템 | 앱 이름, 환경, API prefix |
| `server` | 시스템 | 백엔드 4001 / 프론트 4000 / 모바일 4002, CORS |
| `database` | 시스템 | PostgreSQL 접속 (`username: orbit_app`, password) |
| `auth` | SUPER_ADMIN | JWT 시크릿/만료, 초기 admin 계정 |
| `upload` | SUPER_ADMIN | 업로드 base 경로, 최대 크기 |
| `backup` | SUPER_ADMIN | 월간 DB 백업 cron, 보관일수 |
| `logging` | SUPER_ADMIN | 로그 레벨, 파일 경로, 롤링 |
| `push` | SUPER_ADMIN | PWA Web Push VAPID 키쌍 |
| `exchange` / `ecos` / `fred` | SUPER_ADMIN | 외부 데이터 source |
| `announcements` | SUPER_ADMIN | 사업공고 수집 정책, source 관리 |
| `scheduler` | SUPER_ADMIN | cron on/off, timezone, D-day |
| `slack` / `mail` / `tax_invoice` / `kakao_map` | tenant | 외부 연동 — `app_settings` 에 tenant 별 row 로 오버라이드 |

### 환경변수 오버라이드

중첩 구분자 `__`:

```bash
DATABASE__PASSWORD=secret \
SLACK__BOT_TOKEN=xoxb-... \
SCHEDULER__ENABLED=false \
  docker compose up
```

### 런타임 설정 오버라이드 (`app_settings` 테이블)

`config.yaml` 의 대부분 섹션은 UI 에서 편집 가능. DB 의 `app_settings` 에 `(tenant_id, section)` 단위 JSONB 로 저장 (SUPER_ADMIN section 은 `tenant_id=NULL`):

- `scheduler` · `backup` · `exchange` · `tax_invoice` → APScheduler job 재등록 (앱 재시작 불필요)
- `logging.level` → root logger 레벨 즉시 변경
- `slack` · `mail` → 매 호출마다 `get_settings()` 참조해 다음 전송부터 반영

보안·인프라 키 (`server.*`, `database.*`, `auth.jwt_secret`, `upload.dir`, `backup.dir/pg_dump_bin`, `scheduler.timezone`, `logging.{dir,filename,format}`) 는 UI 편집 차단 — `config.yaml` 에서만 관리.

### 시크릿 마스킹

GET 응답 시 `mail.sender.app_password`, `auth.jwt_secret`, `auth.initial_admin.password` 는 `***<last4>` 로 마스킹. PUT 요청에 마스킹 값 또는 빈 문자열로 들어오면 "기존 값 유지" 로 해석. `tax_invoice.certkey` · `slack.bot_token` · `ecos.api_key` · `fred.api_key` 는 평문 표시 (운영자 명시적 요청).

## 데이터베이스

전체 스키마 정의: **[db.sql](./db.sql)** — 도메인별 섹션 주석 + Stage 1~8 부록 SQL (재실행 안전).

### 주요 테이블 그룹

```
멀티테넌트         tenants (slug, name, domains[], 사업자정보, 회사 프로필)
                   tenant_audit (SUPER_ADMIN 의 tenant 변경 감사 로그)

사용자/인증        users (admin · 세션 프록시 · tenant ADMIN, tenant_id NULLable
                   for SUPER_ADMIN)
                   임직원 비번 권위는 developers

고객사/연락처      customers · license_contacts · customer_contacts
                   (kind=CUSTOMER|PARTNER) · customer_interactions

외환/HR/시계열     exchange_rates · interest_rates · stock_prices (글로벌)
                   hr_insurance_rates (tenant 별 시드)

임직원             developers (hashed_password, security_role, 주민번호)
                   developer_approvers · developer_resumes · developer_salaries
                   developer_research_grants · developer_certifications
                   developer_experiences · developer_profiles
                   developer_passports (1:1, 여권번호 Fernet 암호화 저장,
                                        gender / 영문성·이름 / 발급·만료일 등)
                   developer_emergency_contacts (1:N, UI 는 2 슬롯,
                                                 이름·관계·전화)

프로젝트/투입      projects · project_estimate_items · project_quotes
                   project_attachments · project_comments · project_procurements
                   assignments

라이센스           licenses · license_quotes · license_quote_items

영업기회           opportunities · opportunity_activities
                   opportunity_stage_history · opportunity_attachments

견적·청구          quotes · quote_items · quote_versions
                   invoices · invoice_items · invoice_versions

게시판/공지        board_posts · board_attachments

회의록             meeting_notes (본문 BlockNote JSON + plain_text 검색 캐시
                                    + mindmap_data JSONB)
                   meeting_note_shares (1:N 직원 공유 + read receipt)
                   meeting_note_attachments (1:N 첨부 — 디스크 저장)
                   meeting_note_action_items (TODO — 담당자/마감일/상태
                                              + completion_comment)

주간보고          weekly_report_assignments ((tenant_id, developer_id) UNIQUE
                                              — 매주 작성 의무자, active /
                                              start·end ISO 주)
                  weekly_reports ((tenant_id, developer_id, iso_year, iso_week)
                                  UNIQUE — TipTap HTML 본문 + plain_text + status
                                  DRAFT/SUBMITTED + week_start/week_end 캐시)
                  weekly_report_attachments (1:N 첨부 — 디스크
                                             data/<tenant>/weekly-reports/<id>/...)
                  weekly_report_templates ((tenant_id, kind) UNIQUE,
                                           kind=MANAGER|GENERAL — 양식 본문)
                  weekly_report_comments (TipTap HTML 코멘트 — SUBMITTED 상태에서만,
                                          작성자 = developer + user dual id,
                                          발송 시 owner Slack/Mattermost DM)

게시판 코멘트     board_comments (post_id FK CASCADE, author_id → users.id SET NULL,
                                  TipTap HTML — 작성자+ADMIN 만 편집·삭제)

임직원 평가       evaluation_cycles ((tenant_id, year, period) UNIQUE — 반기 1H/2H,
                                    self_due/manager_due/finalize_due 3 deadline,
                                    DRAFT/OPEN/CALIBRATING/CLOSED)
                  competency_dimensions ((tenant_id, key) UNIQUE — tenant 별 역량
                                         dimension, Settings 에서 ADMIN bulk upsert,
                                         첫 GET 시 default 7종 자동 시드)
                  evaluations ((tenant_id, cycle_id, developer_id) UNIQUE,
                               manager_id 스냅샷, 7-단계 status,
                               self/manager/final narrative 3종 + goal_score_*
                               + competency_avg_* + final_overall_score + final_grade
                               S/A/B/C/D + 단계별 timestamp)
                  evaluation_competency_scores ((evaluation_id, dimension_key) UNIQUE,
                                                self/manager/final 점수 1~5,
                                                soft FK on dimension_key —
                                                dimension rename/비활성화 후에도
                                                score row 보존)

회의실             meeting_rooms · meeting_reservations
                   meeting_reservation_participants
                   (tstzrange + room_id EXCLUDE 제약)

연차 관리          leave_types · leave_balances · leave_accruals
                   leave_reward_grants · leave_requests
                   leave_request_allocations · leave_reset_history

결재                approval_templates (kind, form_schema/ui_schema/approval_rules/
                                        attachment_slots JSONB, version,
                                        unique(tenant_id, kind))
                   approval_requests (template_id, status, form_data,
                                      template_version + form_schema_snapshot +
                                      approval_rules_snapshot +
                                      attachment_slots_snapshot
                                      = 진행중 결재 보호용 frozen 카피)
                   approval_steps (룰 평가 결과 snapshot — step_no, approver_id,
                                   rule/approver_index, status, decided_at,
                                   delegated_from_step_id self-FK)
                   approval_history (이벤트 로그: CREATED/SUBMITTED/APPROVED/
                                     REJECTED/CANCELLED/DELEGATED/COMMENTED/TIMEOUT)
                   approval_attachments (slot 컬럼 — template 슬롯 식별자.
                                         NULL = 자유 첨부.
                                         data/<tenant>/approvals/<id>/<uuid>.<ext>)

목표                goals (scope=PERSONAL|COMPANY, year, owner_id NULL=COMPANY,
                          parent_goal_id self-FK, category/priority/difficulty,
                          progress_pct numeric(5,2), due_date,
                          self_score / manager_score numeric(5,2) + comments)
                   goal_due_alerts (alert_kind D_30 | OVERDUE,
                                    UNIQUE(goal_id, alert_kind) — cron dedup)
                   goal_comments (TipTap HTML, author_id SET NULL on delete)
                   goal_attachments (file_path data/<tenant>/goals/<id>/<uuid>.<ext>)
                   goal_score_baselines ((tenant_id, year) UNIQUE — 종합 점수
                                          가중치 하한. 분모를 min_total_weight 로
                                          고정해 적게 등록한 직원의 점수 부풀림 방지.
                                          min_goal_count 는 페널티 없는 안내용.)

급여·원천세        payroll_runs · payroll_items · payroll_distributions
                   developer_tax_profile · withholding_tax_tables · withholding_tax_rows

캘린더(일정)       holidays (type=STATUTORY|TEMPORARY|COMPANY|EVENT_PUBLIC|EVENT_PRIVATE)
                   (휴일 3종 + 일정 2종 통합. EVENT_PRIVATE 는 HR/ADMIN 만 가시)

메뉴 권한          menu_permissions ((tenant_id, menu_key, role) UNIQUE)
                   feature_permissions ((tenant_id, feature_key, role) UNIQUE)
                   user_feature_grants ((tenant_id, user_id, feature_key) PK)
                   * menu_permissions = 사이드바 노출 + URL 가드 (페이지 단위)
                   * feature_permissions = 페이지 내 버튼·필드·탭 단위 통제 (role 단위)
                   * user_feature_grants = role 부여 없이 한 명에게만 위임 (예:
                     weekly_reports.view_all → SALES 한 명에게 주간보고 전체 조회)
                   * ADMIN 은 세 테이블 모두 암묵 허용 (저장 대상 아님)
                   * menu/feature 는 첫 GET 호출 시 DEFAULT 가 자동 seed

회사 자산          company_assets (자산번호 prefix는 tenants.number_prefix 사용)

법인 차량/보험     company_cars · company_car_attachments
                   company_insurances · company_insurance_attachments

런타임 설정        app_settings ((tenant_id, section) UNIQUE,
                   tenant_id NULL = 시스템 글로벌)

전자세금계산서     tax_invoices · tax_invoice_items · tax_invoice_fetches

매입 인보이스      vendor_bills · vendor_bill_attachments
                   (외부 vendor 청구서 수동 입력 — 공급/납품/견적/프로젝트 연결)

기술지원           support_cases · support_case_attachments · support_case_comments
                   · support_case_products
                   (severity = S1~S5 AWS-style, status = OPEN|IN_PROGRESS|CLOSED,
                    vendor_id 단일 + support_case_products 다대다 join
                    ((support_case_id, product_id) PK + version_id + sort_order)
                    → 한 케이스에 여러 제품·버전을 각자 부착)
                   support_logs · support_log_attachments · support_log_comments
                   · support_log_products
                   (활동 로그 — 코멘트별 start_date/end_date/duration_minutes 컬럼,
                    로그 본체의 동일 컬럼은 SUM/MIN/MAX 로 자동 재계산;
                    제품은 케이스와 동일 패턴의 다대다 join)
                   kb_entries · kb_entry_attachments
                   (지식 베이스 — type='DOC'(벤더 자료) | 'KB'(사내 노하우) 통합.
                    카탈로그 FK + tags text[] + source_links jsonb (UI max 2) +
                    body/plain_text + resolved + row-level visibility)
                   customer_status_entries · customer_status_attachments
                   (고객사 현황 — customer × project(선택) × system 단위 카드.
                    environment (PROD/STAGING/DEV, 기본 PROD) +
                    runtime_type (VM/BAREMETAL/KUBERNETES/DOCKER, 기본 BAREMETAL) +
                    카탈로그 FK + version_detail(자유) + license FK + 수량/적용기간
                    자체 컬럼 + customer_contact / tech_support user FK +
                    TipTap body. 첨부는 KB 패턴 + inline 미리보기 엔드포인트 추가)

제품 카탈로그      vendors (제조사)
                   products (제품 — name 짧은 이름, long_name 풀네임, description,
                             product_code, link)
                   product_versions (버전 — name, release_date, description, link)
                   (lookup-or-create 패턴 — 자유 타이핑한 이름이 자동 등록.
                    UNIQUE(tenant_id, vendor_id, name) / UNIQUE(tenant_id, product_id, name))

이벤트             events (kind=WORKSHOP|CONFERENCE|BUSINESS_TRIP, 예산/소요금액/
                           참가비/실비, 상세 계획)
                   event_flights (1:N — 편명·공항·터미널·좌석·시간·비용)
                   event_lodgings (1:N — 호텔·주소·전화·이메일·체크인/아웃·비용)
                   event_participants (1:N — developer_id 또는 guest_name)
                   event_attachments (1:N — 다중 파일)

클라우드 비용      cloud_costs · cloud_cost_fetches
                   ((tenant_id, provider, account_id, usage_date, service) UNIQUE,
                    total_amount = amount + tax_amount GENERATED column)
                   cloud_cost_alert_rules · cloud_cost_alert_events
                   ((rule_id, dedup_key) UNIQUE 로 중복 발송 차단)

사업공고           announcement_sources (글로벌) · announcements (글로벌)
                   announcement_fetch_runs (글로벌)
                   announcement_bookmarks (tenant 별)

운영 예산 계산     budget_calc_plans (연도·제목·메모)
                   budget_calc_lines (account_code_id FK + m1~m12 numeric(14,2)
                                      + note + sort_order)

R&D 예산           rnd_budget_plans (연도·프로젝트·기업규모·정부지원금/기관부담금/
                                     현금/현물 + 비율 사용자 정의 4종)
                   rnd_budget_lines (비목·세목·항목·단가·건수·합계)
                   rnd_budget_personnel (segment EXISTING/NEW · 월급여·월보험·
                                          연간퇴직금·개월·투입율%)
                   * 시드 JSON: backend/app/data/rnd_*_seed.json
                   * 계정과목: account_codes (수입·지출 항목 마스터)

특허               patents · patent_attachments

회사 도서          books (1권=1 row, 임대 이력 미보존 — borrower_id/borrowed_at/
                          due_date 컬럼만, 반납 시 NULL 클리어, 임대인 퇴사 시
                          SET NULL)

은행 거래내역      bank_accounts · bank_transactions

출퇴근             attendances · worksites · worksite_assignments

알람 / 작업 이력   alarms · alarm_sends
                   job_runs (tenant_id NULLable: 시스템 cron 은 NULL,
                            MANUAL 트리거는 tenant)

PWA Push           push_subscriptions
```

### Row-Level Security 정책

모든 도메인 테이블에 `FORCE ROW LEVEL SECURITY` + 다음 패턴의 `tenant_iso` 정책:

```sql
CREATE POLICY tenant_iso ON public.<table>
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (current_setting('app.tenant_id', true) <> ''
        AND tenant_id::text = current_setting('app.tenant_id', true))
  )
  WITH CHECK ( ... 동일 ... );
```

`tenants` 테이블은 별도 정책 — `tenants_self` (자기 tenant 1행) + `tenants_super_admin` (`is_super_admin=true` 시 ALL).

### DB 롤 분리

- **`orbit_super`** = bootstrap SUPERUSER. SUPERUSER 라 RLS 자동 우회. 백업·DDL 전용.
- **`orbit_app`** = NOSUPERUSER NOBYPASSRLS. 백엔드 config.yaml 의 접속 사용자. RLS 정상 적용.
- **`postgres`** = rescue superuser (orbit_super 와 별도).

비밀번호는 `config.yaml` (gitignored) 의 `database.password` 와 `backup.db_password` 로 분리 관리.

## 디렉토리 구조

```
backend/
  app/
    core/                # 설정 · DB · JWT · 로깅 · roles.py
                         # tenant_context.py · tenant_listener.py · tenant_middleware.py
    models/              # SQLAlchemy 모델 (TenantMixin 적용)
    schemas/             # Pydantic 스키마
    services/
      storage.py          # tenant prefix 합성 (resolve_upload_path)
      tenant_seed.py      # 신규 tenant 생성 시 leave_types/menu_permissions 시드
      backup · scheduler · daily_alerts · slack · mail · alarm
      tax_invoice/{barobill,service}
      announcements/{base,registry,runner,adapters/*}
    api/v1/
      auth.py             # 로그인 (도메인→tenant 매칭) · /me · /change-password
      tenants.py          # SUPER_ADMIN: tenant CRUD · admin user 추가/upsert
      customers.py · customer_contacts.py · customer_interactions.py
      developers.py · projects.py · assignments.py
      licenses.py · opportunities.py
      exchange.py · hr.py
      billing.py · payroll.py
      board.py · holidays.py · meetings.py · leaves.py
      menu_permissions.py · assets.py · company_cars.py · company_insurances.py
      backups.py · settings.py · tax_invoices.py · announcements.py
      patents.py · bank_accounts.py · bank_transactions.py · worksites.py
      attendances.py · alarms.py · job_runs.py · push_subscriptions.py
      dashboard.py · notifications.py
  Dockerfile

frontend/
  app/
    login/ · password-change/
    admin/                # SUPER_ADMIN 콘솔 (별도 layout)
      tenants/            # tenant CRUD + ADMIN 사용자 관리
      db-backups/ · announcements/ · data-sources/
      system-settings/    # JWT/upload/log/VAPID
      job-runs/ · password-change/
    (dashboard)/          # tenant 사용자 영역
      dashboard/ · notice/ · board/
      opportunities/ · licenses/
      developers/ · projects/ · assignments/ · worksites/
      customers/ · contacts/
      cars/ · insurances/
      quotes/ · invoices/ · tax-invoices/ · payroll/
      leaves/ · meetings/ · holidays/
      assets/ · patents/
      bank-accounts/ · bank-accounts/[id]/
      attendance/         # 출퇴근 모니터링 (admin)
      alarms/
      announcements/
      users/              # tenant ADMIN: tenant 사용자 관리
      settings/           # tenant 범위 (9 탭)
  components/
    settings/             # SchedulerTab · IntegrationsTab · AdvancedTab · AnnouncementsTab
    data-grid/ · layout/  # AG Grid 래퍼 · Sidebar · DashboardHeader
    opportunities/ · billing/ · ui/
  Dockerfile

shared/                  # @orbit/shared (공용 타입/유틸)

config.yaml.template     # 런타임 설정 템플릿 (cp 해서 config.yaml 만들고 채움)
docker-compose.yml.template  # 컨테이너 구성 템플릿
db.sql                   # PostgreSQL 스키마 — 단일 소스 오브 트루스 (모델·db.sql·prod ALTER 동시 갱신)
LICENSE.md               # FSL-1.1-ALv2
README.md
features.md              # 사이드바 메뉴별 기능 한 줄 요약
```

## 개발 모드

### 백엔드

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./run.sh   # uvicorn --reload
```

### 프론트엔드

```bash
cd frontend
pnpm install
pnpm dev          # http://localhost:4000
```

### 로그

- 파일: `backend/logs/app.log` (일자별 롤링, `config.yaml → logging.backup_count` 만큼 보존)
- 레벨: INFO 기본. 중요 작업 (CRUD, 스테이지 변경, 파일 업로드/삭제, 퇴사, tenant 변경 등) 은 **한글 메시지**로 요청자·대상 ID 포함

## 주요 API

상세 OpenAPI: `http://localhost:4001/docs`. 자주 쓰이는 엔드포인트만:

### 인증
- `POST /api/v1/auth/login` — `{email, password}` → JWT
- `GET /api/v1/auth/me` — 현재 사용자 + 권한 + `is_super_admin` · `must_change_password`
- `POST /api/v1/auth/change-password` — 본인 비밀번호 변경 (current_password 검증)

### Tenant (SUPER_ADMIN)
- `GET|POST /api/v1/tenants` · `PATCH /{id}` · `DELETE /{id}` (hard)
- `GET /api/v1/tenants/me` — 현재 사용자의 tenant 정보 (tenant 사용자도 read 가능)
- `PATCH /api/v1/tenants/me` — tenant 프로필 수정 (ADMIN)
- `POST /api/v1/tenants/{id}/admin-users` — ADMIN 추가, **이메일 중복 시 비밀번호 갱신 (upsert)**
- `POST /api/v1/tenants/{id}/admin-users/{user_id}/reset-password`

### 임직원
- `GET /api/v1/developers?employment_type=&status_filter=&include_hidden=`
- `POST /api/v1/developers` · `PATCH /{id}` · `POST /{id}/restore`
- `GET /api/v1/developers/directory?employment_type=&include_hidden=` — id/name/tag/email/phone/employment_type 만 (people-picker 용)
- `GET /api/v1/developers/roster` — 정규직 재직자 명부 (HR/ADMIN). 여권 + 비상연락처 join, 여권번호 복호화, 주민번호 → 생년월일 변환
- `GET|PUT|DELETE /api/v1/developers/{id}/passport` — 1:1 여권. 본인/HR/ADMIN 만 (서버 가드)
- `GET|PUT /api/v1/developers/{id}/emergency-contacts` — 1:N 비상연락처 (전체 교체 PUT). 본인/HR/ADMIN 만
- `PATCH /api/v1/developers/{id}/password` — 관리자 비번 재설정 (ADMIN/HR)
- `POST /api/v1/developers/me/change-password`
- `GET|PATCH /api/v1/developers/me/profile`

### 영업·라이센스·프로젝트
- `GET /api/v1/opportunities?year=2026` · CRUD · `/activities`
- `GET /api/v1/licenses/{id}` · `PUT /{id}/quote-items?kind=PURCHASE|SALES`
- `GET /api/v1/projects/{id}/monthly-costs`

### 견적·매출/매입 인보이스
- `POST /api/v1/quotes` · `POST /{id}/save` · `/finalize` · `/unfinalize` · `/copy` · `/versions`
- `POST /api/v1/invoices` · 동일 + `/payments` (매출)
- `GET|POST|PATCH|DELETE /api/v1/vendor-bills` · `/{id}/attachments` (매입 인보이스, 다중 첨부)

### 이벤트 (워크샵/컨퍼런스/출장)
- `GET /api/v1/events?year=&kind=` · `POST /api/v1/events` · `GET|PATCH|DELETE /{id}` (HR/ADMIN, sub 항목은 PATCH 전체 교체)
- `POST /api/v1/events/{id}/attachments` · `PATCH|DELETE /{id}/attachments/{aid}`

### 클라우드 비용
- `GET /api/v1/cloud-costs?from=&to=&provider=&account_id=` · `/summary` · `/fetches`
- `POST /api/v1/cloud-costs/fetch` (수동 수집, 단일 range 호출)
- `GET|POST|PATCH|DELETE /api/v1/cloud-costs/alerts` · `POST /{id}/evaluate`
- `GET /api/v1/cloud-costs/alert-events`

### 결재 (Approvals)
- 양식 마스터 — `GET|POST|PATCH|DELETE /api/v1/approval-templates` · `POST /seed` (시드 JSON 의 누락 양식만 멱등 추가, ADMIN/HR)
- 결재 요청 — `POST /api/v1/approvals` (DRAFT 또는 즉시 SUBMITTED) · `POST /preview` (결재선 미리보기) · `GET /inbox` (내 결재 차례) · `GET /mine` (내가 올린) · `GET|PATCH /{id}` · `POST /{id}/submit` · `POST /{id}/cancel`
- 단계 처리 — `POST /api/v1/approvals/{id}/steps/{step_id}/{approve|reject|delegate}` · `POST /{id}/comment`
- 첨부 — `POST /{id}/attachments?slot=<slug>` (multipart, slot 미지정 = 자유 첨부) · `GET /{id}/attachments/{aid}/download` · `DELETE /{id}/attachments/{aid}` (신청자 + ADMIN/HR 만 수정 가능, 결재자 추가 불가)
- 등급 자동 SKIP — 결재선 생성 시 (engine) + 단계 승인 시 (`_auto_skip_downstream`)
  두 단계 모두에서: ① 매니저 chain 부족으로 결재자 미해결인 step, ② `rank_min_level`/`title_min_level` 이 이미
  상위 단계 결재자의 등급으로 충족되는 redundant step 을 자동 `SKIPPED`. 신청자가 '결재자 미정' 으로
  멈추는 회기 회피.
- 현재 대기 결재자 — `/approvals/inbox` · `/mine` · `/{id}` 응답 모두에 `current_pending_step` 필드 포함
  (이름·직책·전화·회사 이메일). 결재함 목록에서 신청자가 누가 막고 있는지 즉시 확인 + hover 시 `tel:` / `mailto:` 링크.
- Mattermost 알림 — `services/approval_notify.py` 가 제출/승인/반려/위임/취소 시 다음 결재자(또는 신청자)에게 DM.
  메시지는 양식·제목·신청자 등 필드 + '결재 보기 →' 링크 포함 markdown 표 (Mattermost provider 가 Slack blocks
  → markdown 자동 변환). 외부 URL 은 `PLM_PUBLIC_URL` 환경 변수로 override.

### 목표 (Goals)
- 목표 CRUD — `GET|POST /api/v1/goals` · `GET|PATCH|DELETE /{id}`
- 점수 — `GET /goals/score/summary?year=&owner_id=` (본인 종합 점수) · `GET /goals/score/distribution?year=` (전 정규직 익명 점수 분포 + 내 위치) · `GET /goals/score/team-overview?year=` (직원 현황: HR/ADMIN 전체 / 매니저는 chain 후손)
- 평가 — `POST /goals/{id}/score-self` (본인) · `POST /goals/{id}/score-manager` (직속 매니저)
- 코멘트 — `GET|POST /goals/{id}/comments` · `PATCH|DELETE /comments/{cid}`
- 첨부 — `GET|POST /goals/{id}/attachments` · `GET /attachments/{aid}/download` · `PATCH /{aid}` (rename) · `DELETE /{aid}`
- 마감 알림 수동 실행 — `POST /api/v1/notifications/goal-due-alerts/run` (ADMIN, dedup 통과한 항목만)

### 급여·연차·회의실·공휴일
- `GET|POST /api/v1/payroll/runs` · `POST /tax-tables`
- `GET /api/v1/leaves/balances` · `POST /reset` · `/requests` (`/approve` · `/reject`)
- `GET|POST /api/v1/meeting-rooms` · `/meeting-reservations`
- 회의록 — `GET|POST /api/v1/meeting-notes` · `GET|PATCH|DELETE /{id}` · `PATCH /{id}/body` · `PATCH /{id}/mindmap` · `POST /{id}/attachments` · `PATCH|DELETE /attachments/{aid}` · `POST /{id}/notify` (재발송) · **`POST /{id}/email` (이메일 + DM 동시 발송, body 에 BlockNote HTML + custom_message)** · `GET|POST|PATCH|DELETE /{id}/action-items` · `GET /action-items/mine` · 조직도 `GET /api/v1/developers/org-chart` (G6 시각화)
- 주간보고 — `GET /api/v1/weekly-reports?owner=me|team|all&from_year&from_week&to_year&to_week&include_body=` · `GET /{id}` · `POST` (lazy create — body: developer_id, iso_year, iso_week) · `PATCH /{id}/body` · `PATCH /{id}/submit` · `PATCH /{id}/reopen` · `PATCH /{id}/reapply-template` · 첨부 `POST /{id}/attachments` · `GET /attachments/{aid}` (다운로드, read 권한자) · `PATCH /attachments/{aid}` (이름변경, ADMIN/HR + 본인) · `DELETE /attachments/{aid}` · 코멘트 `GET|POST /{id}/comments` · `PATCH|DELETE /{id}/comments/{cid}` · 양식 `GET /weekly-reports/templates` · `PATCH /weekly-reports/templates/{kind}` (MANAGER\|GENERAL) · 지정자 `GET|POST /weekly-reports/assignments` · `PATCH|DELETE /weekly-reports/assignments/{aid}`
- 임직원 평가 — `GET /api/v1/evaluations/cycles` · `POST` (HR — DRAFT) · `PATCH /cycles/{id}` · `POST /cycles/{id}/open` (DRAFT → OPEN, FULL_TIME ACTIVE 자동 생성) · `POST /cycles/{id}/close` · `DELETE /cycles/{id}` · 양식 `GET /evaluations/dimensions` (lazy seed 7종) · `PUT /dimensions` (ADMIN bulk upsert) · 평가 `GET /evaluations?cycle_id=&owner=me|team|all` · `GET /{id}` · `PATCH /{id}/self` · `POST /{id}/self/submit` · `POST /{id}/self/reopen` · `PATCH /{id}/manager` · `POST /{id}/manager/submit` · `POST /{id}/manager/reopen` · `PATCH /{id}/calibrate` (HR) · `POST /{id}/finalize` (HR — 본인 공개) · `POST /{id}/admin-reopen` (HR 임의 단계 되돌리기)
- 게시판 코멘트 — `GET|POST /api/v1/board/posts/{pid}/comments` · `PATCH|DELETE /board/comments/{cid}` (작성자 + ADMIN)
- 액션 아이템 — `GET /api/v1/meeting-notes/action-items?scope=me|team|all&include_done=` (`me` = 본인, `team` = 직속 부하 chain, `all` = HR/ADMIN). `/action-items/mine` 은 `?scope=me` 별칭 (calendar / dashboard 위젯 호환).
- 환율 — `GET /api/v1/exchange/current?base=USD&target=KRW` (단일 페어, ExchangeRate 테이블 캐시) · **`GET /api/v1/exchange/multi?base=KRW`** (6시간 in-memory 캐시, open.er-api.com → KRW/USD/EUR/CNY/JPY/THB/VND/TWD/HKD/SGD)
- `GET|POST|PATCH|DELETE /api/v1/holidays`

### 자산·세금계산서·사업공고·특허·은행·출퇴근
- `GET|POST /api/v1/assets` · `GET /by-number/{no}` · `POST /{id}/photo`
- `GET /api/v1/tax-invoices?kind=&date_from=&date_to=` · `/summary` · `POST /fetch`
- `GET /api/v1/announcements?...` · `/sources` · `POST /fetch` · `/runs`
- `GET|POST /api/v1/patents` · `PATCH|DELETE /{id}`
- 도서 — `GET /api/v1/books?q=&category=&borrowed=` · `POST` · `PATCH|DELETE /{id}` (CRUD 는 `books.manage` = HR/ADMIN)
- `GET|POST /api/v1/bank-accounts` · `GET /{id}/transactions` · `POST /{id}/transactions/import`
- `GET /api/v1/attendances/admin?from=&to=` · `POST /attendances/check-in|check-out` (모바일)

### 알람·작업이력·푸시
- `GET|POST|PATCH|DELETE /api/v1/alarms` · `POST /test-send`
- `GET /api/v1/job-runs?kind=&status=&days=` (SUPER_ADMIN) · `GET /{id}`
- `POST /api/v1/push-subscriptions` (구독) · `DELETE /{id}` · `POST /broadcast` (관리자)

### 공용 picker (모든 role 호출 가능)
- `GET /api/v1/pickers/customers` — 고객사 id/name 만. 메뉴 권한과 별개, 회의록 / 내 액션 / 라이센스 현황 등 cascading combo 용.
- `GET /api/v1/pickers/projects?customer_id=` — 프로젝트 id/name/customer_id. 동일 목적.
- `GET /api/v1/pickers/my-assignments?year=` — 본인 인력투입 row 만 (mapped_developer_id 강제 필터, 금액 필드 제외). 주간보고 '내 프로젝트 투입' 위젯 등 ETC role 도 본인 row 표시 필요한 곳에 사용.

### 설정·백업·대시보드
- `GET|PUT|DELETE /api/v1/settings/{section}` — section 별 권한 자동 분기 (SUPER_ADMIN sections vs tenant)
- `GET|POST /api/v1/backups` · `GET /{name}/download` · `DELETE /{name}` (SUPER_ADMIN)
- `GET|PUT /api/v1/menu-permissions`
- `POST /api/v1/company-profile/{logo|stamp|seal}` (tenant 회사 프로필)
- `GET /api/v1/dashboard/summary?year=2026`
- `GET /api/v1/dashboard/next-payday` (다음 급여일 — payroll 설정 + 휴일 보정. `app_settings.payroll` tenant-scoped: `GET|PUT /api/v1/settings/payroll`)
- `POST /api/v1/notifications/daily-alerts/run?force=true`
- `POST /api/v1/notifications/{slack|mail}/test`

인증은 모든 API 에 `Authorization: Bearer <JWT>` 헤더 필요 (로그인 제외). 리버스 프록시가 `/api/` 는 backend, `/admin/` · `/` 는 frontend, `/drawio/` 는 drawio 컨테이너로 라우팅.

## 운영 · 배포

- **재배포**: `git pull --ff-only && docker compose build && docker compose up -d`
- **DB 백업**: `/admin/db-backups` UI 또는 cron (`<DATA_DIR>/backups/YYYYMMDD-HHMMSS-db.zip`)
- **롤백**: 백업의 `db.sql.gz` + `data.tar.gz` 로 일관성 있는 시점 복원
- **새 tenant 추가**: SUPER_ADMIN 으로 `/admin/tenants` 에서 등록 → 도메인·번호 prefix 입력 → 자동으로 leave_types · menu_permissions · holidays seed → ADMIN 사용자 1 명 추가 → 그 admin 이 첫 임직원 등록부터 진행

## 라이센스

이 프로젝트는 **[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE.md)** 로 배포됩니다.

요약:

- ✅ **자유**: 내부 운영 도구로 사용·수정·재배포·교육·연구 자유
- ✅ **상업적 internal 사용 허용**: 회사 안에서 운영 도구로 쓰는 것은 무관
- ❌ **금지 (Competing Use)**: Orbit Works (또는 fork) 를 hosted / managed
  service 형태로 **제3자에게 상업적으로 제공** 하는 행위 — ASP·SaaS 로
  띄워 다른 사용자로부터 비용을 받는 패턴
- ⏳ **2 년 후 자동 OSS 전환**: 각 릴리즈는 공개 시점으로부터 만 2년 뒤
  자동으로 **Apache License 2.0** 으로도 사용 가능해집니다. 즉 제약은
  영구가 아니라 최신 2년치만 적용됩니다.

라이센스 전문은 [`LICENSE.md`](./LICENSE.md) 참조. 상업 라이센스 (FSL 의 Competing Use
범위 활동을 즉시 허용받고 싶은 경우) 가 필요하다면 별도 협의가 필요합니다.
