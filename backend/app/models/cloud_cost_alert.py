"""클라우드 비용 알람 — 규칙 + 발송 이벤트 이력.

규칙(rule) 은 운영자가 등록하는 조건. 일일 cloud_cost 수집이 끝난 뒤
evaluator 가 모든 enabled 규칙을 평가해 충족하면 notify_service 로 발송.

이벤트(event) 는 fire 된 알람 1건 — `(rule_id, dedup_key)` UNIQUE 로 중복
발송 방지. dedup_key 예: "DAILY:2026-04-29", "MONTH:2026-04",
"FETCH:<fetch_uuid>", "NEW:2026-04-29:AmazonEC2".
"""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CloudCostAlertRule(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """알람 규칙. enabled=true 면 일일 평가 대상."""

    __tablename__ = "cloud_cost_alert_rules"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # 규칙 종류 — frontend 와 동기화. evaluator 의 dispatch 키.
    #   DAILY_THRESHOLD       — 어제 합계 > threshold_krw
    #   MONTHLY_FORECAST      — 이번 달 추정 합계 > threshold_krw
    #   FETCH_FAILED          — cloud_cost_fetches 의 FAILED 발생
    #   DAY_OVER_DAY_PERCENT  — 어제 합계가 그저께 대비 +threshold_percent% 이상
    #   NEW_SERVICE           — 7일 평균에 없던 service 가 어제 새로 청구
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False)

    # 필터 — 모두 None 이면 tenant 전체 합계로 평가.
    provider: Mapped[str | None] = mapped_column(String(20))   # AWS | AZURE | GCP | None(전체)
    account_id: Mapped[str | None] = mapped_column(String(120))

    threshold_krw: Mapped[int | None] = mapped_column(Integer)         # KRW 절대값 (정수)
    threshold_percent: Mapped[int | None] = mapped_column(Integer)     # 퍼센트 (정수, 예: 30)

    # 발송 대상 override — None/빈 배열이면 tenant 의 notify default 사용. 채워지면
    # 그 값으로 override (slack provider 의 `channels or cfg.default_channels` 패턴).
    # provider 별 호환:
    #   - notify_channels:     Slack/Mattermost 둘 다 채널명 list (예: '#cost-alerts')
    #   - notify_user_emails:  둘 다 이메일로 사용자 lookup → DM
    #   - notify_user_ids:     Slack 전용 (Mattermost 는 무시)
    notify_channels: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    notify_user_emails: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    notify_user_ids: Mapped[list[str] | None] = mapped_column(ARRAY(String))

    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CloudCostAlertEvent(Base, UUIDMixin, TenantMixin):
    """알람 발송 이벤트 — 발송 이력 + 중복 방지 키."""

    __tablename__ = "cloud_cost_alert_events"

    rule_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("cloud_cost_alert_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # `<TYPE>:<period>[:<sub>]` 형식. (rule_id, dedup_key) UNIQUE 로 중복 발송 차단.
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False)
    fired_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    delivered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    error_message: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint("rule_id", "dedup_key", name="uq_cloud_cost_alert_events_dedup"),
    )
