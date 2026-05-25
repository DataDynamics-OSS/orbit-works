"""Alarm — 반복/단발 Slack 알람.

관리자가 `"매월 20일 09:00 → '급여 지급 준비'"` 같은 reminder 를 등록하면
APScheduler 가 해당 시각에 Slack 채널 또는 임직원(developers) DM 으로
메시지를 발송한다. 기능 배경·설계는 `README.md → 알람(Alarms)` 섹션 참고.

핵심 규칙:
- 공휴일/주말이면 **직전 영업일 같은 시각**으로 이동 (`shift_to_previous_working_day`).
  `holidays` 테이블이 권위 — 주말은 요일로 판단, 법정·임시·회사 휴일은 테이블 조회.
- ONE_TIME 은 발송 1회 후 자동 `enabled=false`.
- 수신처는 `slack_channel` 과 `recipient_developer_ids` 중 최소 1개 필요 —
  검증은 Pydantic/API 레이어에서 수행 (DB 레벨 체크는 과도).
- `enabled=false` 로 전환되면 스케줄러가 해당 job 을 제거. 다시 true 면 재등록.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Alarm(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "alarms"

    # 식별용 제목 — 목록 UI 표시, 로그 식별.
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    # Slack 으로 보낼 본문. 멀티라인 허용 (Slack markdown 그대로 전달).
    message: Mapped[str] = mapped_column(Text, nullable=False)

    # 스케줄 유형. 값에 따라 아래 필드들의 사용 여부가 달라진다.
    # ONE_TIME | DAILY | WEEKLY | MONTHLY | YEARLY
    schedule_kind: Mapped[str] = mapped_column(String(20), nullable=False)

    # ONE_TIME — 이 시각에 1회 발송 후 자동 disable.
    one_time_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # DAILY/WEEKLY/MONTHLY/YEARLY 공통 시각.
    hour: Mapped[int | None] = mapped_column(Integer)
    minute: Mapped[int | None] = mapped_column(Integer)

    # WEEKLY — 0=월요일 ~ 6=일요일. 복수 선택 가능 (예: 월·수·금).
    weekdays: Mapped[list[int] | None] = mapped_column(ARRAY(Integer))

    # MONTHLY/YEARLY — 1~31. 31이 없는 달은 APScheduler 가 알아서 handle
    # (CronTrigger day='31' 은 그달 말일이 31 이 아니면 발송 안 됨 — 대신
    # `L` 대체가 필요할 수 있지만 MVP 는 날짜 그대로 사용).
    day_of_month: Mapped[int | None] = mapped_column(Integer)

    # YEARLY — 1~12.
    month_of_year: Mapped[int | None] = mapped_column(Integer)

    # 수신처 — 최소 1개 필요 (API 에서 검증).
    # 채널: "#alert" 또는 Slack channel ID ("C0123..."). 없으면 DM 만.
    slack_channel: Mapped[str | None] = mapped_column(String(120))
    # 임직원 DM 대상. company_email 로 Slack user lookup → DM.
    recipient_developer_ids: Mapped[list[uuid.UUID] | None] = mapped_column(
        ARRAY(UUID(as_uuid=True))
    )

    # 유효 기간 — 비어 있으면 무제한. active_to 지나면 실행 시 SKIPPED 기록 + 자동 disable.
    active_from: Mapped[date | None] = mapped_column(Date)
    active_to: Mapped[date | None] = mapped_column(Date)

    # 상태.
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # SUCCESS | FAILED | SKIPPED_DISABLED | SKIPPED_INACTIVE | SKIPPED_SHIFTED
    last_status: Mapped[str | None] = mapped_column(String(30))
    last_error: Mapped[str | None] = mapped_column(Text)
    sent_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 감사.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class AlarmSend(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """알람 실행 이력 — 성공/실패 관계없이 한 행씩 기록. 7일 후 정리 job 이 삭제."""

    __tablename__ = "alarm_sends"

    alarm_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("alarms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # APScheduler 가 트리거한 원래 시각 (SHIFT_BEFORE 적용 전).
    scheduled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # 실제 발송 시각 (SHIFT_BEFORE 적용 후).
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # SUCCESS | FAILED | SKIPPED_DISABLED | SKIPPED_INACTIVE
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    # 발송된 채널·담당자 요약 — UI 이력 드로어에 표시용.
    recipients_summary: Mapped[str | None] = mapped_column(String(500))
    # 수동 테스트 발송 여부 — 주기 실행은 false, /alarms/{id}/test 는 true.
    manual: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
