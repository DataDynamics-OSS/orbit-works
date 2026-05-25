"""고객사 인터랙션 (CustomerInteraction) 스키마."""

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


class CustomerInteractionAttachmentOut(BaseModel):
    id: UUID
    interaction_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    created_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Interactions
# ---------------------------------------------------------------------------


# 이번 단계는 자유 확장을 위해 enum 대신 단순 코드. 프론트엔드도 같은 코드 사용.
ALLOWED_TYPES = {"CALL", "MEETING", "EMAIL", "OTHER"}


class CustomerInteractionBase(BaseModel):
    type: str = Field("OTHER")
    occurred_at: datetime
    title: str
    body: str | None = None
    participants: str | None = None
    follow_up_at: date | None = None


class CustomerInteractionCreate(CustomerInteractionBase):
    # author_id 는 토큰의 mapped_developer_id 로 자동 채움 — 입력 받지 않음.
    pass


class CustomerInteractionUpdate(BaseModel):
    type: str | None = None
    occurred_at: datetime | None = None
    title: str | None = None
    body: str | None = None
    participants: str | None = None
    follow_up_at: date | None = None


class CustomerInteractionOut(CustomerInteractionBase):
    id: UUID
    customer_id: UUID
    author_id: UUID | None = None
    author_name: str | None = None
    attachments: list[CustomerInteractionAttachmentOut] = []
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
