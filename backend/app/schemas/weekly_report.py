"""주간보고 — Pydantic 스키마."""

from __future__ import annotations

from datetime import date as date_cls, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

WeeklyReportStatus = Literal["DRAFT", "SUBMITTED"]
TemplateKind = Literal["MANAGER", "GENERAL"]


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------


class AssignmentBase(BaseModel):
    developer_id: UUID
    active: bool = True
    start_year: int | None = None
    start_week: int | None = None
    end_year: int | None = None
    end_week: int | None = None
    note: str | None = None


class AssignmentCreate(AssignmentBase):
    pass


class AssignmentUpdate(BaseModel):
    active: bool | None = None
    start_year: int | None = None
    start_week: int | None = None
    end_year: int | None = None
    end_week: int | None = None
    note: str | None = None


class AssignmentOut(AssignmentBase):
    id: UUID
    developer_name: str | None = None  # join 으로 채움
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Attachment
# ---------------------------------------------------------------------------


class AttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class AttachmentRename(BaseModel):
    file_name: str


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


class WeeklyReportRowOut(BaseModel):
    """매트릭스 셀용 — 그리드 표시에 필요한 최소 컬럼."""

    id: UUID
    developer_id: UUID
    developer_name: str | None = None
    iso_year: int
    iso_week: int
    week_start: date_cls
    week_end: date_cls
    status: WeeklyReportStatus
    submitted_at: datetime | None = None
    attachment_count: int = 0
    can_edit: bool = False
    updated_at: datetime

    class Config:
        from_attributes = True


class WeeklyReportOut(WeeklyReportRowOut):
    """상세 — 본문 포함."""

    body: str | None = None
    plain_text: str | None = None
    attachments: list[AttachmentOut] = Field(default_factory=list)


class WeeklyReportLazyCreate(BaseModel):
    """매트릭스 셀 클릭 시 호출 — 없으면 새 DRAFT 생성, 있으면 기존 반환."""

    developer_id: UUID
    iso_year: int
    iso_week: int


class WeeklyReportBodyUpdate(BaseModel):
    body: str | None = None
    plain_text: str | None = None


# ---------------------------------------------------------------------------
# Template
# ---------------------------------------------------------------------------


class TemplateOut(BaseModel):
    kind: TemplateKind
    body: str

    class Config:
        from_attributes = True


class TemplateUpdate(BaseModel):
    body: str = Field(default="", max_length=20000)


class TemplatesAllOut(BaseModel):
    """GET /weekly-reports/templates 응답 — 두 종 동시 반환."""

    manager: TemplateOut
    general: TemplateOut


# ---------------------------------------------------------------------------
# Comment — SUBMITTED 보고서에만 작성. 작성 시 owner 에게 DM 알림.
# ---------------------------------------------------------------------------


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CommentUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CommentOut(BaseModel):
    id: UUID
    weekly_report_id: UUID
    author_id: UUID | None = None
    author_name: str | None = None
    body: str
    created_at: datetime
    updated_at: datetime
    can_edit: bool = False

    class Config:
        from_attributes = True
