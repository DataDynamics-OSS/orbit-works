"""마케팅 도메인 — 캠페인 / 세그먼트 / 이메일 / Google Ads.

타겟 = 기존 고객 (Lead 도메인 없음). 채널 EMAIL · GOOGLE_ADS 두 종류만 1차에 지원.

각 모델 컬럼 의미는 db.sql 의 19) 섹션 주석 참고.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CustomerSegment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """캠페인 수신자 세그먼트.

    1차 단순 모델 — 명시적 customer_id 배열 + (옵션) contact_ids · include_kinds.
    빈 customer_ids = 전체 고객 (include_kinds 필터만 적용).
    """

    __tablename__ = "customer_segments"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    customer_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, default=list
    )
    contact_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, default=list
    )
    # 회사 직원(developers) — 내부 임직원에게도 마케팅 메일 발송하고자 할 때.
    # 저장 시 각 developer 에 대해 kind=EMPLOYEE 인 shadow CustomerContact 가
    # lookup-or-create 되어 contact_ids 에도 합쳐진다. 이 컬럼은 round-trip UI
    # 상태 보존 용 (체크박스/직원 선택 상태 그대로 복원).
    developer_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, default=list
    )
    include_kinds: Mapped[list[str]] = mapped_column(
        ARRAY(String(20)), nullable=False, default=lambda: ["CUSTOMER"]
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class MarketingEmailTemplate(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """이메일 템플릿. 머지필드 — {{customer_name}}, {{contact_name}}, {{contact_email}}.

    body 입력 방식 3종 (`body_kind`):
    - HTML   : textarea 에 HTML 직접 입력. body_html 만 사용.
    - EDITOR : BlockNote 에디터 (회의록 패턴). 프론트가 blocks → HTML 변환해서
               body_html 에 저장 + 원본 blocks 를 body_json 에 보관해 편집
               round-trip 보존. 본문 이미지는 별도 `MarketingEmailTemplateAsset`
               row 로 업로드되고 본문에는 `<img src="cid:{content_id}">` 로 들어감.
               발송 시 multipart/related 로 inline 임베드.
    - IMPORT : 외부 URL 가져오기 후 sanitize·premailer 인라인한 결과 HTML 을
               body_html 에 저장. body_json 은 NULL.
    """

    __tablename__ = "marketing_email_templates"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    subject: Mapped[str] = mapped_column(String(500), nullable=False)
    body_kind: Mapped[str] = mapped_column(
        String(20), nullable=False, default="HTML", server_default="HTML",
    )
    body_html: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # BlockNote raw blocks (EDITOR 모드 round-trip). 그 외 모드는 NULL.
    body_json: Mapped[dict | list | None] = mapped_column(JSONB)
    body_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    description: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    assets: Mapped[list["MarketingEmailTemplateAsset"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="MarketingEmailTemplateAsset.created_at",
        passive_deletes=True,
    )


class MarketingEmailTemplateAsset(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """템플릿 본문에 인라인 임베드되는 이미지/파일.

    저장 경로: data/marketing-email-assets/<template_id>/<uuid>.<ext>
    `content_id` 는 본문 HTML 의 `<img src="cid:{content_id}">` 와 매칭되어
    발송 시 multipart/related part 의 Content-ID 헤더로 들어간다.
    UNIQUE(template_id, content_id) — 같은 cid 가 두 번 발급되지 않도록.
    """

    __tablename__ = "marketing_email_template_assets"

    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketing_email_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    content_id: Mapped[str] = mapped_column(String(80), nullable=False)
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )

    template: Mapped["MarketingEmailTemplate"] = relationship(back_populates="assets")


class MarketingCampaign(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """마케팅 캠페인 — 모든 채널 공통 베이스. channel 컬럼으로 분기."""

    __tablename__ = "marketing_campaigns"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # EMAIL | GOOGLE_ADS
    channel: Mapped[str] = mapped_column(String(20), nullable=False)
    # PLANNED | RUNNING | PAUSED | COMPLETED | ARCHIVED
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PLANNED")
    # CROSS_SELL | UPSELL | NURTURE | RETENTION | WIN_BACK | EVENT_INVITE | OTHER
    objective: Mapped[str] = mapped_column(String(20), nullable=False, default="NURTURE")
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    budget: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    actual_cost: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    segment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customer_segments.id", ondelete="SET NULL")
    )
    utm_source: Mapped[str | None] = mapped_column(String(60))
    utm_medium: Mapped[str | None] = mapped_column(String(60))
    utm_campaign: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)

    # EMAIL channel fields ---------------------------------------------------
    email_template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketing_email_templates.id", ondelete="SET NULL"),
    )
    from_address: Mapped[str | None] = mapped_column(String(200))
    from_name: Mapped[str | None] = mapped_column(String(120))
    reply_to: Mapped[str | None] = mapped_column(String(200))
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    send_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    send_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # GOOGLE_ADS channel fields ---------------------------------------------
    ga_customer_id: Mapped[str | None] = mapped_column(String(40))
    ga_external_id: Mapped[str | None] = mapped_column(String(60))
    ga_campaign_type: Mapped[str | None] = mapped_column(String(30))
    ga_daily_budget: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    ga_last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sends: Mapped[list["MarketingEmailSend"]] = relationship(
        back_populates="campaign", cascade="all, delete-orphan"
    )


class MarketingEmailUnsubscribe(Base, UUIDMixin, TenantMixin):
    """이메일 수신거부 마스터. 발송 직전 lower(email) 으로 LEFT JOIN — 매칭 시 SKIPPED."""

    __tablename__ = "marketing_email_unsubscribes"

    email: Mapped[str] = mapped_column(String(200), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    unsubscribed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    source_campaign_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("marketing_campaigns.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )


class MarketingEmailSend(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """캠페인 발송 로그 (수신자 단위) — EMAIL 채널 전용."""

    __tablename__ = "marketing_email_sends"

    campaign_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketing_campaigns.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    customer_contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customer_contacts.id", ondelete="SET NULL")
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="SET NULL")
    )
    to_address: Mapped[str] = mapped_column(String(200), nullable=False)
    # QUEUED | SENT | BOUNCED | FAILED | SKIPPED_UNSUBSCRIBED
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="QUEUED")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)
    open_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    click_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_clicked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_clicked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unsubscribed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    campaign: Mapped["MarketingCampaign"] = relationship(back_populates="sends")


class MarketingGoogleAdsMetric(Base, TenantMixin):
    """Google Ads 일별 KPI 시계열. (campaign_id, metric_date) 복합 PK."""

    __tablename__ = "marketing_google_ads_metrics"

    campaign_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketing_campaigns.id", ondelete="CASCADE"),
        primary_key=True,
    )
    metric_date: Mapped[date] = mapped_column(Date, primary_key=True)
    impressions: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    clicks: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cost_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    conversions: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=0
    )
    conversions_value: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )


class MarketingCampaignTouch(Base, UUIDMixin, TenantMixin):
    """캠페인 ↔ 고객 attribution. 모든 채널 공통 이벤트 로그."""

    __tablename__ = "marketing_campaign_touches"

    campaign_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("marketing_campaigns.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="SET NULL")
    )
    customer_contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customer_contacts.id", ondelete="SET NULL")
    )
    # SENT | OPENED | CLICKED | GA_IMPRESSION | GA_CLICK | CONVERTED
    touch_type: Mapped[str] = mapped_column(String(30), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    extra: Mapped[dict] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
