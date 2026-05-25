"""마케팅 도메인 Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

CampaignChannel = Literal["EMAIL", "GOOGLE_ADS"]
CampaignStatus = Literal["PLANNED", "RUNNING", "PAUSED", "COMPLETED", "ARCHIVED"]
CampaignObjective = Literal[
    "CROSS_SELL", "UPSELL", "NURTURE", "RETENTION", "WIN_BACK", "EVENT_INVITE", "OTHER"
]
ContactKind = Literal["CUSTOMER", "PARTNER"]
EmailSendStatus = Literal[
    "QUEUED", "SENT", "BOUNCED", "FAILED", "SKIPPED_UNSUBSCRIBED"
]
TouchType = Literal[
    "SENT", "OPENED", "CLICKED", "GA_IMPRESSION", "GA_CLICK", "CONVERTED"
]
GoogleAdsCampaignType = Literal["SEARCH", "DISPLAY", "VIDEO", "PMAX"]


# ---------------------------------------------------------------------------
# Customer Segment
# ---------------------------------------------------------------------------


class CustomerSegmentBase(BaseModel):
    name: str
    description: str | None = None
    customer_ids: list[UUID] = Field(default_factory=list)
    contact_ids: list[UUID] = Field(default_factory=list)
    # 회사 직원(developers) UUID — 저장 시 shadow CustomerContact (kind=EMPLOYEE)
    # 로 materialize 되어 contact_ids 에도 자동 합쳐진다.
    developer_ids: list[UUID] = Field(default_factory=list)
    include_kinds: list[ContactKind] = Field(default_factory=lambda: ["CUSTOMER"])


class CustomerSegmentCreate(CustomerSegmentBase):
    pass


class CustomerSegmentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    customer_ids: list[UUID] | None = None
    contact_ids: list[UUID] | None = None
    developer_ids: list[UUID] | None = None
    include_kinds: list[ContactKind] | None = None


class CustomerSegmentOut(CustomerSegmentBase):
    id: UUID
    created_by: UUID | None = None
    created_at: datetime
    updated_at: datetime
    # 발송 시 추출되는 수신자 수 (실시간 계산, list 응답에 포함).
    recipient_count: int | None = None

    class Config:
        from_attributes = True


class SegmentRecipient(BaseModel):
    """세그먼트 미리보기 — 발송 전 수신자 목록 확인용."""

    customer_id: UUID | None
    customer_name: str | None
    customer_contact_id: UUID
    contact_name: str
    email: str
    kind: ContactKind


# ---------------------------------------------------------------------------
# Email Template
# ---------------------------------------------------------------------------


EmailBodyKind = Literal["HTML", "EDITOR", "IMPORT"]


class EmailTemplateBase(BaseModel):
    name: str
    subject: str
    body_kind: EmailBodyKind = "HTML"
    body_html: str = ""
    body_json: Any | None = None  # BlockNote raw blocks (EDITOR 모드만)
    body_text: str = ""
    description: str | None = None


class EmailTemplateCreate(EmailTemplateBase):
    pass


class EmailTemplateUpdate(BaseModel):
    name: str | None = None
    subject: str | None = None
    body_kind: EmailBodyKind | None = None
    body_html: str | None = None
    body_json: Any | None = None
    body_text: str | None = None
    description: str | None = None


class EmailTemplateAssetOut(BaseModel):
    id: UUID
    content_id: str
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class EmailTemplateOut(EmailTemplateBase):
    id: UUID
    created_by: UUID | None = None
    last_used_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    # list 응답에는 assets 미부착 (가볍게), 상세에서만 채움.
    assets: list[EmailTemplateAssetOut] = []

    class Config:
        from_attributes = True


class EmailImportUrlIn(BaseModel):
    """외부 URL 의 HTML 을 가져와 이메일용으로 정리해 돌려준다."""
    url: str = Field(min_length=1, max_length=1024)


class EmailImportUrlOut(BaseModel):
    body_html: str
    title: str | None = None


# ---------------------------------------------------------------------------
# Campaign
# ---------------------------------------------------------------------------


class CampaignBase(BaseModel):
    name: str
    channel: CampaignChannel
    status: CampaignStatus = "PLANNED"
    objective: CampaignObjective = "NURTURE"
    start_date: date | None = None
    end_date: date | None = None
    budget: Decimal = Decimal("0")
    actual_cost: Decimal = Decimal("0")
    currency: str = "KRW"
    owner_id: UUID | None = None
    segment_id: UUID | None = None
    utm_source: str | None = None
    utm_medium: str | None = None
    utm_campaign: str | None = None
    notes: str | None = None
    # EMAIL
    email_template_id: UUID | None = None
    from_address: str | None = None
    from_name: str | None = None
    reply_to: str | None = None
    scheduled_at: datetime | None = None
    # GOOGLE_ADS
    ga_customer_id: str | None = None
    ga_external_id: str | None = None
    ga_campaign_type: GoogleAdsCampaignType | None = None
    ga_daily_budget: Decimal | None = None


class CampaignCreate(CampaignBase):
    pass


class CampaignUpdate(BaseModel):
    name: str | None = None
    status: CampaignStatus | None = None
    objective: CampaignObjective | None = None
    start_date: date | None = None
    end_date: date | None = None
    budget: Decimal | None = None
    actual_cost: Decimal | None = None
    currency: str | None = None
    owner_id: UUID | None = None
    segment_id: UUID | None = None
    utm_source: str | None = None
    utm_medium: str | None = None
    utm_campaign: str | None = None
    notes: str | None = None
    email_template_id: UUID | None = None
    from_address: str | None = None
    from_name: str | None = None
    reply_to: str | None = None
    scheduled_at: datetime | None = None
    ga_customer_id: str | None = None
    ga_external_id: str | None = None
    ga_campaign_type: GoogleAdsCampaignType | None = None
    ga_daily_budget: Decimal | None = None


class CampaignOut(CampaignBase):
    id: UUID
    send_started_at: datetime | None = None
    send_finished_at: datetime | None = None
    ga_last_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    # Derived
    owner_name: str | None = None
    segment_name: str | None = None
    email_template_name: str | None = None
    # Email KPI rollup (NULL for non-EMAIL channels)
    sent_count: int | None = None
    opened_count: int | None = None
    clicked_count: int | None = None
    bounced_count: int | None = None
    # Google Ads KPI rollup
    ga_impressions: int | None = None
    ga_clicks: int | None = None
    ga_cost: Decimal | None = None
    ga_conversions: Decimal | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Email Send (recipient-level log)
# ---------------------------------------------------------------------------


class EmailSendOut(BaseModel):
    id: UUID
    campaign_id: UUID
    customer_id: UUID | None = None
    customer_contact_id: UUID | None = None
    to_address: str
    status: EmailSendStatus
    sent_at: datetime | None = None
    error_message: str | None = None
    open_count: int
    first_opened_at: datetime | None = None
    last_opened_at: datetime | None = None
    click_count: int
    first_clicked_at: datetime | None = None
    last_clicked_at: datetime | None = None
    unsubscribed_at: datetime | None = None
    # Derived
    contact_name: str | None = None
    customer_name: str | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Unsubscribe
# ---------------------------------------------------------------------------


class UnsubscribeOut(BaseModel):
    id: UUID
    email: str
    reason: str | None = None
    unsubscribed_at: datetime
    source_campaign_id: UUID | None = None

    class Config:
        from_attributes = True


class UnsubscribeCreate(BaseModel):
    email: EmailStr
    reason: str | None = None


# ---------------------------------------------------------------------------
# Google Ads Metrics
# ---------------------------------------------------------------------------


class GoogleAdsMetricOut(BaseModel):
    campaign_id: UUID
    metric_date: date
    impressions: int
    clicks: int
    cost_micros: int
    conversions: Decimal
    conversions_value: Decimal
    synced_at: datetime

    class Config:
        from_attributes = True


class GoogleAdsMetricUpsert(BaseModel):
    """수동 입력/sync 결과 한 일자 upsert."""

    metric_date: date
    impressions: int = 0
    clicks: int = 0
    cost_micros: int = 0
    conversions: Decimal = Decimal("0")
    conversions_value: Decimal = Decimal("0")


# ---------------------------------------------------------------------------
# Dashboard summary
# ---------------------------------------------------------------------------


class MarketingDashboardSummary(BaseModel):
    """대시보드 위젯용 통합 요약."""

    total_campaigns: int
    active_campaigns: int
    completed_campaigns: int
    email_campaigns: int
    google_ads_campaigns: int
    # Email KPI (last 30 days)
    emails_sent_30d: int
    emails_opened_30d: int
    emails_clicked_30d: int
    open_rate_30d: float
    click_rate_30d: float
    unsubscribe_count: int
    # Google Ads KPI (last 30 days)
    ga_impressions_30d: int
    ga_clicks_30d: int
    ga_cost_30d_micros: int
    ga_conversions_30d: Decimal
