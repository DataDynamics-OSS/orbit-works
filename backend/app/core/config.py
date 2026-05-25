import os
from pathlib import Path
from urllib.parse import quote_plus

from pydantic import BaseModel, Field, model_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)


def _config_file() -> str:
    # 새 이름(ORBIT_CONFIG_FILE) 우선, 기존 DLM_CONFIG_FILE 을 후순위로 fallback
    # → 구 배포 환경이 바로 깨지지 않도록 하위호환 유지.
    return os.environ.get(
        "ORBIT_CONFIG_FILE",
        os.environ.get("DLM_CONFIG_FILE", "config.yaml"),
    )


class AppConfig(BaseModel):
    name: str = "Orbit Works"
    environment: str = "development"
    api_v1_prefix: str = "/api/v1"


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 4001
    frontend_host: str = "0.0.0.0"
    frontend_port: int = 4000
    # 외부에서 접근 가능한 base URL — notify 서비스가 발송하는 메시지의 링크에
    # 사용. 예: https://orbit.example.com (prod). 미설정 시 localhost 로 떨어짐.
    public_url: str = "http://localhost:4000"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:4000"])


class DatabaseConfig(BaseModel):
    host: str = "db"
    port: int = 5432
    name: str = "orbit"
    username: str = "orbit"
    password: str = ""
    pool_size: int = 10
    pool_pre_ping: bool = True


class InitialAdmin(BaseModel):
    email: str = "admin"
    password: str = "admin"


class AuthConfig(BaseModel):
    jwt_secret: str = "change-me-to-a-long-random-string-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = 60 * 24
    initial_admin: InitialAdmin = Field(default_factory=InitialAdmin)


class UploadConfig(BaseModel):
    dir: str = "data"
    max_size_mb: int = 100


class BackupConfig(BaseModel):
    """DB 자동 백업 설정. pg_dump → zip 으로 dir 아래에 yyyymmdd-HHMMSS-db.zip 생성.

    `frequency` 로 cron 주기를 결정:
    - DAILY  : 매일 hour:minute 에 1회
    - WEEKLY : 매주 day_of_week 요일 hour:minute (0=월~6=일)
    - MONTHLY: 매월 day_of_month 일 hour:minute
    """

    enabled: bool = True
    # 백업 주기 — 기본 매일 (월 1회는 retention 정책상 위험). frontend 와 동기화.
    frequency: str = "DAILY"  # DAILY | WEEKLY | MONTHLY
    # 시각 (모든 frequency 에 적용).
    hour: int = 2
    minute: int = 0
    # frequency=WEEKLY 일 때만 사용. APScheduler day_of_week: 0=월요일.
    day_of_week: int = 0
    # frequency=MONTHLY 일 때만 사용.
    day_of_month: int = 1
    # data/backups/
    dir: str = "data/backups"
    # pg_dump 바이너리 경로 (PATH 에서 찾지 못하면 절대경로 지정).
    pg_dump_bin: str = "pg_dump"
    # 보관 일수 (0 = 영구 보관). 기본 30 일 — daily backup 기준 적정.
    retention_days: int = 30
    # 백업 전용 DB 자격증명 — RLS 우회용. 운영 환경의 앱 DB 사용자(orbit_app)는
    # NOSUPERUSER/NOBYPASSRLS 라 FORCE RLS 테이블의 pg_dump 가 실패한다.
    # SUPERUSER 또는 BYPASSRLS 권한이 있는 별도 롤을 지정해야 한다.
    # 비워두면 database.* 자격증명을 그대로 사용 (단일테넌트·개발 환경 호환).
    db_username: str = ""
    db_password: str = ""
    # Data 디렉토리(upload.dir 전체) 백업 — 수동 실행만 (자동 cron 없음).
    # 같은 backup.dir 에 YYYYMMDD-HHMMSS-data.zip 으로 저장하되, ZIP 안에는
    # backup.dir 자체(자기 자신) 를 제외해 무한 누적 방지.
    # DB 보다 부피가 클 수 있어 retention 은 더 짧게 (기본 7 일).
    data_retention_days: int = 7


class SchedulerConfig(BaseModel):
    enabled: bool = True
    timezone: str = "Asia/Seoul"
    # Daily alert cron: fire at 01:00 KST by default.
    daily_alert_hour: int = 1
    daily_alert_minute: int = 0
    # D-day list for project / assignment end_date reminders.
    project_alert_days: list[int] = [30]
    assignment_alert_days: list[int] = [30]
    license_alert_days: list[int] = [30]


class LoggingConfig(BaseModel):
    dir: str = "logs"
    filename: str = "app.log"
    level: str = "INFO"
    backup_count: int = 30
    console: bool = True
    format: str = "%(asctime)s %(levelname)s [%(tenant)s] [%(name)s] %(message)s"
    date_format: str = "%Y-%m-%d %H:%M:%S"


class ExchangeConfig(BaseModel):
    api_url: str = "https://open.er-api.com/v6/latest/USD"
    base: str = "USD"
    target: str = "KRW"
    refresh_cron_hour: int = 9
    # 앱 기동 시 frankfurter.app 에서 히스토리를 백필할 구간 길이 (일).
    initial_backfill_days: int = 90
    # 일일 스케줄 cron 이 수행할 구간 길이 (일) — 주말·공휴일 재공시 데이터를 함께 갱신.
    daily_backfill_days: int = 7


class EcosConfig(BaseModel):
    """한국은행 경제통계시스템(ECOS) Open API 연동 설정.

    대시보드에 국내 금리(기준금리·CD91 등) 시계열을 표시하기 위한 데이터 소스.
    API 키는 https://ecos.bok.or.kr > 서비스 이용 에서 발급 (무료).
    """

    enabled: bool = False
    api_key: str = ""
    base_url: str = "https://ecos.bok.or.kr/api"


class DirectoryConfig(BaseModel):
    """임직원 디렉터리(주소록·picker) 노출 제어.

    `excluded_developer_ids` 에 포함된 UUID 는 Employees·Payroll 을 제외한
    모든 developers 조회 (인력 picker·주소록·대시보드 리스트 등) 에서
    자동으로 숨겨진다. 과거 할당·급여 등 이력은 유지.
    """

    excluded_developer_ids: list[str] = Field(default_factory=list)


class FredConfig(BaseModel):
    """세인트루이스 연준 FRED Open API 연동 설정.

    대시보드에 미국 주가지수(S&P500 · NASDAQ · DJIA) 일별 시계열 표시용.
    API 키는 https://fred.stlouisfed.org 회원가입 후 즉시 발급 (무료).
    """

    enabled: bool = False
    api_key: str = ""
    base_url: str = "https://api.stlouisfed.org/fred"


class KakaoMapConfig(BaseModel):
    """카카오맵 JavaScript SDK 키.

    근무지 등록 시 주소 → 좌표 지오코딩 + 미니 지도 미리보기에 사용.
    키 발급:
    1. https://developers.kakao.com 접속
    2. 개발자 등록 및 앱 생성
    3. [앱] > [앱 설정] > [앱] > [플랫폼 키] 에서 JavaScript Key 사용

    `sdk_version` 은 t1.kakaocdn.net/kakao_js_sdk/<version>/kakao.min.js 경로의
    버전 세그먼트. X.X.X 의미 버전(semver). `integrity` 는 SRI 해시 — 버전마다
    값이 달라지므로 SDK 버전을 바꾸면 반드시 같이 갱신.

    `enabled=True` 일 때는 javascript_key/sdk_version/integrity 가 모두 비어
    있지 않아야 한다 (model_validator 강제).
    """

    enabled: bool = False
    javascript_key: str = ""
    sdk_version: str = Field(default="2.8.1", pattern=r"^\d+\.\d+\.\d+$")
    # 기본값은 sdk_version 2.8.1 에 매칭되는 SRI 해시. 버전을 바꾸면 반드시
    # Kakao Developers 가이드의 새 해시로 함께 갱신해야 한다.
    integrity: str = "sha384-OL+ylM/iuPLtW5U3XcvLSGhE8JzReKDank5InqlHGWPhb4140/yrBw0bg0y7+C9J"

    @model_validator(mode="after")
    def _require_when_enabled(self) -> "KakaoMapConfig":
        if self.enabled:
            missing: list[str] = []
            if not self.javascript_key.strip():
                missing.append("javascript_key")
            if not self.sdk_version.strip():
                missing.append("sdk_version")
            if not self.integrity.strip():
                missing.append("integrity")
            if missing:
                raise ValueError(
                    "Kakao Map 활성화 시 필수: " + ", ".join(missing)
                )
        return self


class GoogleMapConfig(BaseModel):
    """Google Maps JavaScript API 설정.

    이벤트(워크샵·컨퍼런스) 등록 시 주소 → 좌표 지오코딩 + 미니 지도 미리보기에
    사용. Kakao Map 과 병렬로 운영되어, 사용자가 두 지도 중 선택해 표시.

    키 발급:
    1. https://console.cloud.google.com 접속
    2. 프로젝트 생성 → APIs & Services → Library → "Maps JavaScript API" 활성화
    3. Credentials → Create credentials → API key → 도메인 제한(권장)

    `javascript_key` 는 마스킹하지 않고 평문 노출 (운영자 명시 요청).
    """

    enabled: bool = False
    javascript_key: str = ""


class NhnCloudSmsConfig(BaseModel):
    """NHN Cloud SMS 발송 게이트웨이 설정.

    NHN Cloud 콘솔 → Notification → SMS 에서 AppKey/SecretKey 발급 후
    `app_key`, `secret_key` 를 입력. 값들은 사용자 요청에 따라 마스킹 없이
    평문 노출 (Slack bot_token / Google JS Key 와 동일 정책).

    `enabled=false` 면 발송 자체 안 함.
    """

    enabled: bool = False
    # NHN Cloud SMS 기본 엔드포인트.
    url: str = "https://sms.api.nhncloudservice.com"
    app_key: str = ""
    secret_key: str = ""


class PushConfig(BaseModel):
    """PWA Web Push (VAPID) 설정.

    공개 키는 브라우저 PushManager.subscribe(applicationServerKey) 에 그대로 사용.
    private 키는 서버에서 webpush 호출 시 서명용. 두 값은 한 쌍이어야 동작.

    `enabled=false` 면 발송 자체 안 함. UI 도 구독 토글을 표시하지 않음.

    `vapid_subject` 는 `mailto:` 또는 `https://` URL — 브라우저 Push 서비스가
    오용 시 운영자에게 연락할 수 있는 어드레스.
    """

    enabled: bool = False
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:admin@example.com"


class SmtpConfig(BaseModel):
    host: str = "smtp.gmail.com"
    port: int = 587
    use_tls: bool = True
    use_ssl: bool = False
    timeout_seconds: int = 10


class MailSender(BaseModel):
    email: str = ""
    name: str = "Orbit Works Notifier"
    app_password: str = ""


class MailNotifications(BaseModel):
    license_expiry_days_before: list[int] = Field(default_factory=lambda: [30, 14, 7, 1])
    license_renewal_prep: bool = True
    subject_prefix: str = "[Orbit Works]"


class MailConfig(BaseModel):
    enabled: bool = False
    provider: str = "gmail"
    smtp: SmtpConfig = Field(default_factory=SmtpConfig)
    sender: MailSender = Field(default_factory=MailSender)
    default_recipients: list[str] = Field(default_factory=list)
    notifications: MailNotifications = Field(default_factory=MailNotifications)


class NotifyPolicy(BaseModel):
    """provider 무관 공통 알림 정책."""

    license_expiry_days_before: list[int] = Field(default_factory=lambda: [30, 14, 7, 1])
    license_renewal_prep: bool = True


class TaxInvoiceAutoFetch(BaseModel):
    """세금계산서 자동 수집 스케줄."""

    enabled: bool = True
    hour: int = 3
    minute: int = 0
    # catchup_days: 자동 실행 시 몇 일 전까지 되돌아 조회할지 (지연 등록 대응).
    # 바로빌 공시 지연을 고려해 기본 7일 — upsert 라 기존 건과 충돌해도 새 것만 INSERT.
    catchup_days: int = 7


class TaxInvoiceConfig(BaseModel):
    """전자세금계산서(바로빌) 수집 설정."""

    enabled: bool = True
    provider: str = "barobill"
    certkey: str = ""
    corpnum: str = ""
    user_id: str = ""
    environment: str = "production"   # 'production' | 'test'
    download_pdf: bool = True
    auto_fetch: TaxInvoiceAutoFetch = Field(default_factory=TaxInvoiceAutoFetch)


class AnnouncementSourceConfig(BaseModel):
    """개별 수집 소스의 활성 상태·API 키.

    키 없이도 일부 소스(HTML 파싱)는 동작하므로 `api_key` 는 선택.
    """

    enabled: bool = True
    api_key: str = ""


class AnnouncementsAutoFetch(BaseModel):
    """사업공고 자동 수집 스케줄."""

    enabled: bool = True
    hour: int = 3
    minute: int = 0
    # 지난 n 일치 범위 재수집 — 지연 공시/수정 반영.
    catchup_days: int = 1


class AnnouncementsConfig(BaseModel):
    """사업공고 수집 런타임 설정 — app_settings.announcements 로 저장."""

    enabled: bool = True
    auto_fetch: AnnouncementsAutoFetch = Field(default_factory=AnnouncementsAutoFetch)
    # code → source-level settings. 키가 없으면 DB enabled 플래그만 사용.
    sources: dict[str, AnnouncementSourceConfig] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# 보안 — 마스터 키 (settings 의 자격증명 암호화)
# ---------------------------------------------------------------------------


class SecurityConfig(BaseModel):
    """애플리케이션 레벨 시크릿 암호화 설정.

    `secrets_key` 는 Fernet (AES-128-CBC + HMAC) base64-encoded 32-byte key.
    config.yaml / 환경변수에서만 주입 — 절대 DB·로그에 남기지 않는다.
    DB 백업이 유출되어도 이 키 없이는 클라우드 자격증명을 복호화 불가.

    키 생성: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
    """

    secrets_key: str = ""


# ---------------------------------------------------------------------------
# Cloud cost — AWS / Azure / GCP 일일 비용 수집
# ---------------------------------------------------------------------------


class AWSCloudCostConfig(BaseModel):
    """AWS Cost Explorer (`ce:GetCostAndUsage`) 자격증명·범위.

    멀티 account 는 `accounts` 에 account_id 들을 나열 (이 자격증명이 cross-account
    role 또는 organization payer account 의 키여야 모두 보임). 단일 account 만
    조회하려면 비워둘 수 있다 — 그땐 자격증명의 own account 비용만 잡힌다.
    """

    enabled: bool = False
    access_key_id: str = ""        # 평문 또는 enc:… (자동 변환)
    secret_access_key: str = ""    # 평문 또는 enc:…
    region: str = "us-east-1"      # Cost Explorer endpoint 는 us-east-1 만 지원
    accounts: list[str] = Field(default_factory=list)


class AzureCloudCostConfig(BaseModel):
    """Azure Cost Management (`/query`) 자격증명·범위.

    Service Principal 인증. `subscription_ids` 에 subscription GUID 들을 나열.
    Reader + Cost Management Reader 권한 필요.
    """

    enabled: bool = False
    tenant_id: str = ""
    client_id: str = ""
    client_secret: str = ""        # 평문 또는 enc:…
    subscription_ids: list[str] = Field(default_factory=list)


class GCPCloudCostConfig(BaseModel):
    """GCP BigQuery 의 billing export 테이블에서 비용 조회.

    GCP 는 actual cost 를 반환하는 직접 API 가 없어 BigQuery export 가 사실상
    유일한 경로. 사용자는 GCP 콘솔에서 1회 export 활성화 필요:
        Billing → Billing export → BigQuery export → enable

    `bigquery_dataset` 은 export dataset (예: "myproj.billing_export"),
    `bigquery_table_suffix` 는 billing_account_id 의 underscore 변환
    (`011130-7C85FE-92EE07` → `011130_7C85FE_92EE07`).

    Service Account 권한:
    - BigQuery Data Viewer (해당 dataset)
    - BigQuery Job User (쿼리 실행)
    """

    enabled: bool = False
    service_account_json: str = ""    # 평문 또는 enc:… (전체 SA JSON 통째)
    billing_account_id: str = ""
    bigquery_dataset: str = ""        # "<project>.<dataset>"
    bigquery_table_suffix: str = ""   # billing_account_id 의 _ 치환형


class CloudCostConfig(BaseModel):
    """클라우드 일별 비용 수집 — AWS / Azure / GCP 통합.

    스케줄러는 cron 으로 매일 시도하고, `fetch_interval_days` 가 1 보다 크면
    마지막 SUCCESS 가 그 일수 이내일 때 skip.

    `service_top_n` 은 일별 service-level row cardinality 상한 — 그 이상은
    `service="OTHER"` 로 합산. 0 이면 전체 보존.

    `alert_threshold_krw` 가 0 보다 크면 일별 합계가 그 KRW 환산값을 초과할 때
    notify 시스템(Slack/Mattermost)으로 발송.
    """

    enabled: bool = False
    fetch_interval_days: int = Field(default=1, ge=1, le=7)
    service_top_n: int = Field(default=20, ge=0)
    alert_threshold_krw: int = 0
    auto_fetch: "CloudCostAutoFetch" = Field(default_factory=lambda: CloudCostAutoFetch())
    aws: AWSCloudCostConfig = Field(default_factory=AWSCloudCostConfig)
    azure: AzureCloudCostConfig = Field(default_factory=AzureCloudCostConfig)
    gcp: GCPCloudCostConfig = Field(default_factory=GCPCloudCostConfig)


class CloudCostAutoFetch(BaseModel):
    """클라우드 비용 자동 수집 cron — tax_invoice/announcements 와 동일 패턴."""

    enabled: bool = True
    hour: int = 4
    minute: int = 0
    catchup_days: int = 2  # 어제 + 그저께 (전일 비용 정정 반영)


# forward-ref resolution
CloudCostConfig.model_rebuild()


class SlackProviderConfig(BaseModel):
    """Slack provider 자격증명 + 발송 대상 기본값."""

    bot_token: str = ""
    default_webhook_url: str = ""
    api_base_url: str = "https://slack.com/api"
    timeout_seconds: int = 10
    default_channels: list[str] = Field(default_factory=list)
    default_user_emails: list[str] = Field(default_factory=list)
    default_user_ids: list[str] = Field(default_factory=list)
    emoji_prefix: str = ":bell:"


class MattermostProviderConfig(BaseModel):
    """Mattermost provider 자격증명 + 발송 대상 기본값.

    인증은 Bot Account Token 만 지원 (Personal Access Token 호환). Webhook 미지원.
    `default_team` 은 channel name 을 channel id 로 해석할 때 필요.
    """

    base_url: str = ""              # https://mm.example.com (no trailing /)
    bot_token: str = ""
    timeout_seconds: int = 10
    default_team: str = ""          # team name 또는 id
    default_channels: list[str] = Field(default_factory=list)
    default_user_emails: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# AI Assistant — Gemini / Claude / OpenAI 통합 어시스턴트
# ---------------------------------------------------------------------------


class AssistantProviderConfig(BaseModel):
    """단일 LLM provider 자격증명·모델 설정.

    `api_key` 는 평문 또는 enc:… (자동 변환). `model` 은 provider 별 기본 모델
    이름 — UI 에서 고정 dropdown 보다는 자유 입력으로 두어 신모델 즉시 사용 가능.
    `enabled=true` 면 default_provider 후보에 포함.
    """

    enabled: bool = False
    api_key: str = ""
    model: str = ""


class AssistantConfig(BaseModel):
    """대화형 어시스턴트(floating chat)의 런타임 설정.

    `default_provider` 가 사용자의 1차 모델. 응답 중 tool 호출 + multi-turn 루프는
    `max_turns` 로 cap. `enabled=false` 면 프론트엔드 floating chat 자체가
    표시되지 않고, 서버 엔드포인트도 503 반환.

    프롬프트 캐싱은 provider 어댑터가 자동으로 시도 (system + tool schemas 가
    안정적 prefix 라 거의 항상 hit). 따로 토글 없음.
    """

    enabled: bool = False
    default_provider: str = "gemini"  # "gemini" | "claude" | "openai"
    max_turns: int = Field(default=5, ge=1, le=15)
    # 사용자별 1분당 호출 한도 (rate limit). 0 = 무제한 (개발용).
    rate_limit_per_minute: int = Field(default=20, ge=0, le=1000)
    # 대화 영속화 — false 면 메모리 only (peer-to-peer test 용).
    persist_conversations: bool = True

    gemini: AssistantProviderConfig = Field(
        default_factory=lambda: AssistantProviderConfig(model="gemini-2.5-flash")
    )
    claude: AssistantProviderConfig = Field(
        default_factory=lambda: AssistantProviderConfig(model="claude-sonnet-4-6")
    )
    openai: AssistantProviderConfig = Field(
        default_factory=lambda: AssistantProviderConfig(model="gpt-4o-mini")
    )


class PayrollConfig(BaseModel):
    """급여일 설정 — 대시보드의 '다음 급여일' 타일 + 향후 급여 모듈 공유.

    저장 위치: `app_settings.payroll` (tenant-scoped). 미설정 시 기본값으로
    동작 (매월 25일 / 직전 영업일 / 공휴일 포함).
    """

    payday_of_month: int = Field(default=25, ge=1, le=31)
    # 휴일/주말일 때 어느 영업일로 보정할지.
    # "previous" — 직전 영업일 (예: 22일 토요일 → 21일 금요일).
    # "next"     — 다음 영업일 (예: 22일 토요일 → 24일 월요일).
    rollback_strategy: str = Field(default="previous", pattern=r"^(previous|next)$")
    # true = 토/일 + 공휴일 모두 영업일 외. false = 토/일만.
    include_holidays: bool = True


class NotifyGates(BaseModel):
    """피처별 알림 on/off 토글.

    `enabled=false` (마스터) 면 어떤 게이트값이든 무시되고 전체 차단된다.
    마스터가 켜져 있을 때만 개별 게이트가 의미를 갖는다 — 디스패처가
    `feature` 인자를 받으면 `getattr(gates, feature, True)` 를 검사.

    신규 피처 추가 시 여기에 boolean 필드 1개 + `services/<feature>_notify.py`
    에서 `feature=<key>` 인자 전달 + `EDITABLE_KEYS["notify"]` 에 `gates.<key>`
    경로 등록.
    """

    approval: bool = True          # services/approval_notify.py
    leave: bool = True             # services/leave_notify.py
    meeting: bool = True           # services/meeting_notify.py
    meeting_note: bool = True      # api/v1/meeting_notes.py — 회의록 신규/수동발송
    weekly_report: bool = True     # services/weekly_report_notify.py
    goal: bool = True              # services/goal_notify.py
    evaluation: bool = True        # services/evaluation_notify.py
    alarm: bool = True             # services/alarm.py (cron 알람)
    action_item: bool = True       # services/action_item_notify.py
    cloud_cost: bool = True        # services/cloud_cost/alerts.py
    developer_auth: bool = True    # services/developer_auth.py (신규 비번 발급 DM)
    expiry_alert: bool = True      # services/daily_alerts.py — 프로젝트/투입/라이센스 D-30
    calendar_event: bool = True    # services/daily_alerts.py — EVENT_PRIVATE
    support_case: bool = True      # services/support_case_notify.py — 신규 케이스 → SUPPORT 역할 DM
    support_case_comment: bool = True  # services/support_case_notify.py — 코멘트 추가 → SUPPORT 역할 DM (작성자 제외)


class NotifyConfig(BaseModel):
    """알람 시스템 설정.

    provider 를 단일 선택 — slack 또는 mattermost. enabled=true 일 때만 실제 발송.
    각 provider 의 설정은 자기 sub-section 으로 격리해 전환 시 데이터 손실 없음.
    `gates` 는 피처별 미세 on/off — 마스터가 켜진 상태에서만 효과.
    """

    enabled: bool = False
    provider: str = "slack"          # "slack" | "mattermost"
    slack: SlackProviderConfig = Field(default_factory=SlackProviderConfig)
    mattermost: MattermostProviderConfig = Field(default_factory=MattermostProviderConfig)
    notifications: NotifyPolicy = Field(default_factory=NotifyPolicy)
    gates: NotifyGates = Field(default_factory=NotifyGates)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_nested_delimiter="__",
        extra="ignore",
        case_sensitive=False,
    )

    app: AppConfig = Field(default_factory=AppConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    auth: AuthConfig = Field(default_factory=AuthConfig)
    upload: UploadConfig = Field(default_factory=UploadConfig)
    backup: BackupConfig = Field(default_factory=BackupConfig)
    scheduler: SchedulerConfig = Field(default_factory=SchedulerConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    exchange: ExchangeConfig = Field(default_factory=ExchangeConfig)
    ecos: EcosConfig = Field(default_factory=EcosConfig)
    fred: FredConfig = Field(default_factory=FredConfig)
    kakao_map: KakaoMapConfig = Field(default_factory=KakaoMapConfig)
    google_map: GoogleMapConfig = Field(default_factory=GoogleMapConfig)
    nhn_cloud_sms: NhnCloudSmsConfig = Field(default_factory=NhnCloudSmsConfig)
    push: PushConfig = Field(default_factory=PushConfig)
    directory: DirectoryConfig = Field(default_factory=DirectoryConfig)
    mail: MailConfig = Field(default_factory=MailConfig)
    notify: NotifyConfig = Field(default_factory=NotifyConfig)
    payroll: PayrollConfig = Field(default_factory=PayrollConfig)
    tax_invoice: TaxInvoiceConfig = Field(default_factory=TaxInvoiceConfig)
    announcements: AnnouncementsConfig = Field(default_factory=AnnouncementsConfig)
    security: SecurityConfig = Field(default_factory=SecurityConfig)
    cloud_cost: CloudCostConfig = Field(default_factory=CloudCostConfig)
    assistant: AssistantConfig = Field(default_factory=AssistantConfig)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        yaml_path = Path(_config_file())
        sources: list[PydanticBaseSettingsSource] = [
            init_settings,
            env_settings,
            dotenv_settings,
        ]
        if yaml_path.exists():
            sources.append(YamlConfigSettingsSource(settings_cls, yaml_file=yaml_path))
        sources.append(file_secret_settings)
        return tuple(sources)

    @property
    def database_url(self) -> str:
        db = self.database
        pw = quote_plus(db.password)
        return (
            f"postgresql+asyncpg://{db.username}:{pw}@{db.host}:{db.port}/{db.name}"
        )


# ---------------------------------------------------------------------------
# 런타임 설정 합성 엔진
# ---------------------------------------------------------------------------
#
# `Settings()` 는 config.yaml + ENV vars 로부터 base 설정을 구성한다. 여기에
# DB 의 `app_settings` 테이블 값을 섹션별로 deep-merge 해 최종 런타임 설정이
# 된다. 소비자는 기존처럼 `get_settings()` 만 호출하면 항상 최신 값을 받는다.
#
# 반영 흐름:
#   1. 앱 시작 시 FastAPI lifespan 에서 `await reload_db_overrides()` 호출
#   2. `/api/v1/settings/{section}` PUT 핸들러가 DB 저장 후 reload_db_overrides
#      + invalidate_settings_cache + dispatch(section) 호출
#
# invalidate 후 첫 `get_settings()` 가 base + overrides 를 재합성해 캐시.
# ---------------------------------------------------------------------------


# DB 에서 로드한 섹션별 오버라이드. 키 예: "scheduler" → {"daily_alert_hour": 3}.
_db_overrides: dict[str, dict] = {}
_cached: "Settings | None" = None


def _deep_merge(base: dict, override: dict) -> dict:
    """재귀 dict merge. override 의 nested dict 는 기존 값과 병합, 그 외는 교체."""
    out = dict(base)
    for k, v in override.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _apply_overrides(base: Settings) -> Settings:
    if not _db_overrides:
        return base
    # 섹션별로 overriding — Pydantic model_copy 로 재구성하여 validator 통과.
    patched = base.model_dump()
    for section, override in _db_overrides.items():
        if section in patched and isinstance(patched[section], dict) and isinstance(override, dict):
            patched[section] = _deep_merge(patched[section], override)
    return Settings.model_validate(patched)


def get_settings() -> Settings:
    """합성된 현재 런타임 설정. invalidate 전까지 동일 인스턴스 반환."""
    global _cached
    if _cached is None:
        _cached = _apply_overrides(Settings())
    return _cached


def invalidate_settings_cache() -> None:
    """다음 `get_settings()` 호출 시 재합성되도록 캐시 초기화."""
    global _cached
    _cached = None


# tenant section 합성값 캐시 — 동시 다발 fire 시 동일 tenant 의 DB SELECT 중복 회피.
# 키: (tenant_id_str, section). 값: (data, expires_at_unix_ts).
# TTL 60 초 — UI 변경 후 최대 1분 내 반영. 즉시 반영이 필요한 PUT/DELETE 핸들러는
# `invalidate_tenant_section()` 으로 명시적으로 비운다.
_TENANT_SECTION_TTL_SEC = 60.0
_tenant_section_cache: dict[tuple[str, str], tuple[dict, float]] = {}


def invalidate_tenant_section(tenant_id, section: str | None = None) -> None:
    """캐시 무효화. section 미지정이면 그 tenant 의 모든 섹션 제거.

    호출 위치: settings PUT/DELETE 핸들러, tenant 삭제·비활성화 등.
    """
    tid_str = str(tenant_id) if tenant_id is not None else ""
    if section is None:
        keys = [k for k in _tenant_section_cache if k[0] == tid_str]
        for k in keys:
            _tenant_section_cache.pop(k, None)
    else:
        _tenant_section_cache.pop((tid_str, section), None)


async def get_tenant_section(tenant_id, section: str) -> dict:
    """특정 tenant 의 section 합성값 반환 (TTL 60s 메모리 캐시).

    합성 순서: config.yaml + 글로벌 app_settings (tenant_id IS NULL) +
    tenant 의 app_settings row. tenant 의 row 가 없으면 글로벌까지의 값을 반환.

    스케줄러 등 *요청 컨텍스트가 없는* 백그라운드에서 tenant scoped 설정에
    접근할 때 사용. tenant_id=None 이면 글로벌만 반환 (= get_settings() 의 section).
    """
    import time as _time
    from sqlalchemy import select
    from app.core.database import system_session
    from app.models.app_setting import AppSetting

    base_section = get_settings().model_dump().get(section, {}) or {}
    if not isinstance(base_section, dict):
        base_section = {}
    if tenant_id is None:
        return base_section

    cache_key = (str(tenant_id), section)
    now = _time.monotonic()
    cached = _tenant_section_cache.get(cache_key)
    if cached is not None and cached[1] > now:
        # dict 를 그대로 반환하면 호출자가 mutate 시 캐시도 오염되므로 deep copy.
        return _deep_merge({}, cached[0])

    async with system_session() as db:
        row = (
            await db.execute(
                select(AppSetting).where(
                    AppSetting.section == section,
                    AppSetting.tenant_id == tenant_id,
                )
            )
        ).scalar_one_or_none()
    if row is None or not isinstance(row.value, dict):
        merged = base_section
    else:
        merged = _deep_merge(base_section, row.value)
    _tenant_section_cache[cache_key] = (merged, now + _TENANT_SECTION_TTL_SEC)
    return _deep_merge({}, merged)


async def reload_db_overrides() -> None:
    """`app_settings` 테이블의 *글로벌* (tenant_id IS NULL) 섹션을 메모리에 캐시.

    멀티 테넌트: tenant 별 오버라이드는 `get_tenant_section()` 으로 매번 DB 조회.
    시스템 컨텍스트 (cron/services) 는 글로벌 + 필요한 경우 tenant 별 분기 사용.
    """
    # 지연 import — 순환참조(app.core.database → config) 방지.
    from sqlalchemy import select
    from app.core.database import system_session
    from app.models.app_setting import AppSetting

    global _db_overrides
    new_overrides: dict[str, dict] = {}
    try:
        async with system_session() as db:
            rows = (
                await db.execute(
                    select(AppSetting).where(AppSetting.tenant_id.is_(None))
                )
            ).scalars().all()
            for r in rows:
                if isinstance(r.value, dict):
                    new_overrides[r.section] = r.value
    except Exception as exc:  # pragma: no cover
        import logging
        logging.getLogger(__name__).warning(
            "app_settings 로드 실패 (base 설정으로 진행): %s", exc
        )
        return
    _db_overrides = new_overrides
    invalidate_settings_cache()
