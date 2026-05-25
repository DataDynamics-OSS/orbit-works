"""Pydantic schemas for the 게시판 (board)."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Attachment
# ---------------------------------------------------------------------------


class BoardAttachmentOut(BaseModel):
    id: UUID
    post_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int = 0
    created_at: datetime | None = None

    class Config:
        from_attributes = True


class BoardAttachmentUpdate(BaseModel):
    """이름만 변경 (디스크 파일은 그대로, DB 의 file_name 만 교체)."""

    file_name: str = Field(min_length=1, max_length=255)


# ---------------------------------------------------------------------------
# Post
# ---------------------------------------------------------------------------


class BoardPostCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    content: str = ""
    is_pinned: bool = False
    category: str = "BOARD"
    # 보안 역할 제한 — 비우면 전체 공개. 값 있으면 그 role 만 볼 수 있음.
    visible_roles: list[str] | None = None


class BoardPostUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    content: str | None = None
    is_pinned: bool | None = None
    visible_roles: list[str] | None = None


class BoardPostOut(BaseModel):
    id: UUID
    title: str
    category: str = "BOARD"
    content: str = ""
    author_id: UUID | None = None
    author_name: str | None = None  # 조인으로 채움
    is_pinned: bool = False
    view_count: int = 0
    visible_roles: list[str] | None = None
    attachments: list[BoardAttachmentOut] = []
    attachment_count: int = 0  # 목록용
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Comment — 글에 달리는 코멘트. read 권한자 누구나 작성, 작성자+ADMIN 만 편집.
# ---------------------------------------------------------------------------


class BoardCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)
    # 답글이면 부모 코멘트 id. NULL = 루트 코멘트. 백엔드가 같은 post 인지 검증.
    parent_id: UUID | None = None


class BoardCommentUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class BoardCommentOut(BaseModel):
    id: UUID
    post_id: UUID
    parent_id: UUID | None = None
    author_id: UUID | None = None
    author_name: str | None = None
    body: str
    created_at: datetime
    updated_at: datetime
    can_edit: bool = False

    class Config:
        from_attributes = True
