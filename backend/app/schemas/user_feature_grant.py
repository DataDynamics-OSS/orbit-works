"""user_feature_grants Pydantic 스키마."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class UserFeatureGrantOut(BaseModel):
    user_id: UUID
    feature_key: str
    granted_by_user_id: UUID | None = None
    granted_at: datetime

    class Config:
        from_attributes = True


class UserFeatureGrantCreate(BaseModel):
    user_id: UUID
    feature_key: str = Field(min_length=1, max_length=64)


class GrantableFeatureOut(BaseModel):
    """카탈로그 노출용 — UI 의 grant 부여 옵션."""
    feature_key: str
    label: str
