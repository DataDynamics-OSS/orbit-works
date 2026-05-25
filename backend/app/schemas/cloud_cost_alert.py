"""클라우드 비용 알람 — Pydantic."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

# frontend 와 동기화 필수.
RuleType = Literal[
    "DAILY_THRESHOLD",
    "MONTHLY_FORECAST",
    "FETCH_FAILED",
    "DAY_OVER_DAY_PERCENT",
    "NEW_SERVICE",
]

CloudProvider = Literal["AWS", "AZURE", "GCP"]


class AlertRuleBase(BaseModel):
    name: str
    enabled: bool = True
    rule_type: RuleType
    provider: CloudProvider | None = None
    account_id: str | None = None
    threshold_krw: int | None = None
    threshold_percent: int | None = None
    notify_channels: list[str] | None = None
    notify_user_emails: list[str] | None = None
    notify_user_ids: list[str] | None = None


class AlertRuleCreate(AlertRuleBase):
    pass


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    rule_type: RuleType | None = None
    provider: CloudProvider | None = None
    account_id: str | None = None
    threshold_krw: int | None = None
    threshold_percent: int | None = None
    notify_channels: list[str] | None = None
    notify_user_emails: list[str] | None = None
    notify_user_ids: list[str] | None = None


class AlertRuleOut(AlertRuleBase):
    id: UUID
    last_fired_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AlertEventOut(BaseModel):
    id: UUID
    rule_id: UUID
    dedup_key: str
    fired_at: datetime
    message: str
    payload: dict | None = None
    delivered: bool
    error_message: str | None = None

    class Config:
        from_attributes = True
