"""Pydantic schemas for 북마크."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

BookmarkScope = Literal["PERSONAL", "COMPANY"]


class BookmarkBase(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2000)
    info: str | None = None
    category: str | None = Field(default=None, max_length=50)


class BookmarkCreate(BookmarkBase):
    scope: BookmarkScope
    # COMPANY 한정 — None/빈 배열 = 전직원 노출.
    visible_roles: list[str] | None = None
    # 정보 가시성 — None = row 가시 사용자 전원, [] = 아무도, [role,…] = 그 role.
    info_visible_roles: list[str] | None = None
    sort_order: int = 0


class BookmarkUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=200)
    url: str | None = Field(default=None, min_length=1, max_length=2000)
    info: str | None = None
    category: str | None = Field(default=None, max_length=50)
    visible_roles: list[str] | None = None
    info_visible_roles: list[str] | None = None
    sort_order: int | None = None


class BookmarkOut(BaseModel):
    id: UUID
    scope: BookmarkScope
    owner_user_id: UUID | None = None
    label: str
    url: str
    # 호출자가 정보 볼 권한 없으면 백엔드가 None 으로 sanitize 후 반환.
    info: str | None = None
    category: str | None = None
    visible_roles: list[str] | None = None
    info_visible_roles: list[str] | None = None
    sort_order: int = 0
    can_edit: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Config:
        from_attributes = True
