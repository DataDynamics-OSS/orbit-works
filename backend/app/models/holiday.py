"""Holiday — 공휴일/임시 공휴일/회사 휴일 + 공개·비공개 일정 관리.

API path 는 `/calendar` 이지만 테이블·모델·도메인 어휘는 그대로 'holidays'.
type 5종:
  STATUTORY/TEMPORARY/COMPANY = 휴일 (근무일 차감, 모두 공개)
  EVENT_PUBLIC                = 일정 (근무일 비차감, 모두 공개)
  EVENT_PRIVATE               = 일정 (근무일 비차감, HR/ADMIN/SUPER_ADMIN 만 보기)

토/일(주말)은 요일 규칙으로 판단하므로 DB 에 저장하지 않음.

tenant 별로 독립 — 법정 공휴일은 신규 tenant 생성 시 tenant_seed 가 시드,
그 외는 ADMIN/HR 이 자유롭게 등록.
"""

from datetime import date as date_cls, datetime
from uuid import UUID

from sqlalchemy import Date, DateTime, ForeignKey, Index, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Holiday(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "holidays"
    # 휴일 3종(STATUTORY/TEMPORARY/COMPANY) 만 (tenant, date) 중복 방지.
    # EVENT_PUBLIC / EVENT_PRIVATE 일정은 같은 날에 여러 개 + 휴일과 공존 가능.
    # (이전엔 broad UNIQUE 였어서 같은 날 등록이 1개로 막힘.)
    __table_args__ = (
        Index(
            "uq_holidays_tenant_date_holiday",
            "tenant_id", "date",
            unique=True,
            postgresql_where=text(
                "type IN ('STATUTORY','TEMPORARY','COMPANY')"
            ),
        ),
    )

    date: Mapped[date_cls] = mapped_column(Date, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # STATUTORY | TEMPORARY | COMPANY | EVENT_PUBLIC | EVENT_PRIVATE
    type: Mapped[str] = mapped_column(String(16), nullable=False, default="TEMPORARY")
    description: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    # 알람 수신자 (1:N) — 비공개 일정만 사용. 09:00 cron 이 일괄 발송.
    alarm_recipients: Mapped[list["HolidayAlarmRecipient"]] = relationship(
        "HolidayAlarmRecipient",
        back_populates="holiday",
        cascade="all, delete-orphan",
    )


class HolidayAlarmRecipient(Base, UUIDMixin, TenantMixin):
    """비공개 일정 알람 수신자.

    `daily_alerts.run_calendar_event_alarms()` 가 매일 09:00 발송. 발송 후
    `notified_at` 채워 중복 발송 차단. 일정 삭제 시 cascade.
    """

    __tablename__ = "holiday_alarm_recipients"
    __table_args__ = (
        UniqueConstraint(
            "holiday_id", "developer_id", name="uq_holiday_alarm_recipient"
        ),
    )

    holiday_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("holidays.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default="now()"
    )

    holiday: Mapped[Holiday] = relationship(back_populates="alarm_recipients")
