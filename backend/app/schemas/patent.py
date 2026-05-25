"""Patent Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


PatentStatus = Literal["FILED", "REGISTERED"]


class PatentAttachmentOut(BaseModel):
    id: UUID
    filename: str
    mime_type: str | None = None
    file_size: int | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PatentBase(BaseModel):
    status: PatentStatus = "FILED"
    title: str = Field(..., min_length=1, max_length=500)
    application_no: str | None = Field(None, max_length=100)
    patent_no: str | None = Field(None, max_length=100)
    filed_date: date | None = None
    registered_date: date | None = None
    patent_holder: str | None = Field(None, max_length=200)
    holder_address: str | None = None
    inventors: str | None = None
    inventor_address: str | None = None
    country: str | None = Field(None, max_length=50)
    memo: str | None = None


class PatentCreate(PatentBase):
    pass


class PatentUpdate(BaseModel):
    status: PatentStatus | None = None
    title: str | None = Field(None, min_length=1, max_length=500)
    application_no: str | None = None
    patent_no: str | None = None
    filed_date: date | None = None
    registered_date: date | None = None
    patent_holder: str | None = None
    holder_address: str | None = None
    inventors: str | None = None
    inventor_address: str | None = None
    country: str | None = None
    memo: str | None = None


class PatentOut(PatentBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    attachment_count: int = 0
    attachments: list[PatentAttachmentOut] = []

    model_config = ConfigDict(from_attributes=True)


class PatentAttachmentRename(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
