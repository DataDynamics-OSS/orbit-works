"""지식 베이스 (KB) — Pydantic 스키마."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

KbType = Literal["DOC", "KB"]
KbVisibility = Literal["all", "manager", "admin"]


class KbAttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    uploaded_by: UUID | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class KbSourceLink(BaseModel):
    """외부 자료 링크 1건 — 표시명 + URL."""
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=1024)


class KbEntryRowOut(BaseModel):
    """목록용 — body/plain_text 비포함 (payload 절감)."""
    id: UUID
    title: str
    type: KbType
    vendor_id: UUID | None = None
    vendor_name: str | None = None
    product_id: UUID | None = None
    product_name: str | None = None
    version_id: UUID | None = None
    version_name: str | None = None
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    source_url: str | None = None  # legacy (사용 안 함)
    source_links: list[KbSourceLink] = Field(default_factory=list)
    resolved: bool = False
    visibility: KbVisibility = "all"
    author_user_id: UUID | None = None
    author_name: str | None = None
    attachment_count: int = 0
    created_at: datetime
    updated_at: datetime


class KbEntryOut(KbEntryRowOut):
    """상세 — 본문 + 첨부 포함."""
    body: str | None = None
    plain_text: str | None = None
    attachments: list[KbAttachmentOut] = Field(default_factory=list)


class KbEntryCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    type: KbType = "KB"
    vendor_id: UUID | None = None
    product_id: UUID | None = None
    version_id: UUID | None = None
    category: str | None = Field(default=None, max_length=40)
    tags: list[str] = Field(default_factory=list)
    body: str | None = None
    plain_text: str | None = None
    # UI 가 max 2 강제. 서버에서도 안전망으로 자름 (router 에서).
    source_links: list[KbSourceLink] = Field(default_factory=list)
    resolved: bool = False
    visibility: KbVisibility = "all"


class KbEntryUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    type: KbType | None = None
    vendor_id: UUID | None = None
    product_id: UUID | None = None
    version_id: UUID | None = None
    category: str | None = Field(default=None, max_length=40)
    tags: list[str] | None = None
    body: str | None = None
    plain_text: str | None = None
    source_links: list[KbSourceLink] | None = None
    resolved: bool | None = None
    visibility: KbVisibility | None = None


class KbAttachmentRename(BaseModel):
    file_name: str = Field(min_length=1, max_length=300)
