"""Alarm Pydantic 스키마.

스케줄 유형(`schedule_kind`) 에 따라 요구되는 필드가 달라지는데, 복잡한 분기
검증은 API 레이어의 `_validate_schedule()` 헬퍼에서 수행. 여기서는 필드 범위
(hour 0-23, weekday 0-6 등) 정도만 Pydantic 으로 강제하고, 크로스-필드 정합성은
라우터에서 검사해 에러 메시지를 명확하게 한다.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


ScheduleKind = Literal["ONE_TIME", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
AlarmStatus = Literal[
    "SUCCESS",
    "FAILED",
    "SKIPPED_DISABLED",
    "SKIPPED_INACTIVE",
]


class AlarmBase(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1)

    schedule_kind: ScheduleKind

    one_time_at: datetime | None = None
    hour: int | None = Field(default=None, ge=0, le=23)
    minute: int | None = Field(default=None, ge=0, le=59)
    # 0=월 ~ 6=일. WEEKLY 에서 1개 이상 필수.
    weekdays: list[int] | None = None
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    month_of_year: int | None = Field(default=None, ge=1, le=12)

    slack_channel: str | None = None
    recipient_developer_ids: list[UUID] | None = None

    active_from: date | None = None
    active_to: date | None = None

    enabled: bool = True


class AlarmCreate(AlarmBase):
    pass


class AlarmUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    message: str | None = Field(default=None, min_length=1)

    schedule_kind: ScheduleKind | None = None

    one_time_at: datetime | None = None
    hour: int | None = Field(default=None, ge=0, le=23)
    minute: int | None = Field(default=None, ge=0, le=59)
    weekdays: list[int] | None = None
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    month_of_year: int | None = Field(default=None, ge=1, le=12)

    slack_channel: str | None = None
    recipient_developer_ids: list[UUID] | None = None

    active_from: date | None = None
    active_to: date | None = None

    enabled: bool | None = None


class AlarmOut(AlarmBase):
    id: UUID
    last_sent_at: datetime | None = None
    last_status: str | None = None
    last_error: str | None = None
    sent_count: int
    created_at: datetime
    updated_at: datetime
    # 다음 실행 시각 — APScheduler 로부터 계산해서 응답에 채움.
    next_run_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class AlarmSendOut(BaseModel):
    id: UUID
    alarm_id: UUID
    scheduled_at: datetime
    sent_at: datetime | None = None
    status: str
    error_message: str | None = None
    recipients_summary: str | None = None
    manual: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
