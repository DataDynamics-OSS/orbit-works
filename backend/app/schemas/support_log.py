"""기술지원 활동 로그 — Pydantic 직렬화."""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field


class SupportLogAttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None
    size: int | None
    created_at: datetime

    class Config:
        from_attributes = True


class SupportLogCommentOut(BaseModel):
    id: UUID
    author_user_id: UUID | None
    author_name: str | None = None
    body: str
    duration_minutes: int = 0
    start_date: date | None = None
    end_date: date | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SupportLogProductIn(BaseModel):
    """다이얼로그가 보내는 product 1건. product_id 는 신규 입력 시 빈 문자열 ""
    또는 None 가능 — 이름(product)으로 lookup-or-create 한 뒤 채워짐.
    """
    product_id: UUID | None = None
    product: str | None = None       # 이름 — id 가 None 일 때 카탈로그 lookup-or-create
    version_id: UUID | None = None
    version: str | None = None       # 이름 — id 가 None 일 때 lookup-or-create
    sort_order: int = 0


class SupportLogProductOut(BaseModel):
    product_id: UUID
    product: str | None = None       # 표시명 — derived via join
    version_id: UUID | None = None
    version: str | None = None
    sort_order: int = 0

    class Config:
        from_attributes = True


class SupportLogBase(BaseModel):
    customer_id: UUID
    project_id: UUID | None = None
    sales_rep_developer_id: UUID | None = None
    support_engineer_developer_id: UUID | None = None
    start_date: date
    end_date: date
    duration_minutes: int = 0
    # vendor 는 단일 정보·필터링용. product/version 은 products[] 다중.
    vendor: str | None = None
    products: list[SupportLogProductIn] = Field(default_factory=list)
    body: str | None = None


class SupportLogCreate(SupportLogBase):
    pass


class SupportLogUpdate(BaseModel):
    customer_id: UUID | None = None
    project_id: UUID | None = None
    sales_rep_developer_id: UUID | None = None
    support_engineer_developer_id: UUID | None = None
    start_date: date | None = None
    end_date: date | None = None
    duration_minutes: int | None = None
    vendor: str | None = None
    # None 이면 미변경, 빈 list 면 전부 제거. 기존 set 과 차분.
    products: list[SupportLogProductIn] | None = None
    body: str | None = None


class SupportLogOut(BaseModel):
    id: UUID
    customer_id: UUID
    project_id: UUID | None = None
    sales_rep_developer_id: UUID | None = None
    support_engineer_developer_id: UUID | None = None
    start_date: date
    end_date: date
    duration_minutes: int
    vendor_id: UUID | None = None
    vendor: str | None = None
    products: list[SupportLogProductOut] = Field(default_factory=list)
    body: str | None = None
    customer_name: str | None = None
    project_name: str | None = None
    sales_rep_name: str | None = None
    support_engineer_name: str | None = None
    attachments: list[SupportLogAttachmentOut] = Field(default_factory=list)
    comments: list[SupportLogCommentOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    created_by: UUID | None = None

    class Config:
        from_attributes = True


class CommentIn(BaseModel):
    body: str
    duration_minutes: int = Field(default=0, ge=0)
    # 미지정 시 서버 today 로 채움.
    start_date: date | None = None
    end_date: date | None = None


class AttachmentRename(BaseModel):
    file_name: str


class SupportLogStats(BaseModel):
    """기술지원 활동 로그 KPI — 코멘트 단위 집계.

    "건" 은 코멘트 1개 (= 한 번의 지원 세션). 날짜 기준은 comment.start_date.
    """

    year: int
    month: int
    year_count: int
    year_minutes: int
    year_customers: int
    month_count: int
    month_minutes: int
    month_customers: int


class MonthlyEngineerSeries(BaseModel):
    engineer_id: UUID | None
    engineer_name: str  # "(미지정)" 포함
    monthly_count: list[int] = Field(min_length=12, max_length=12)
    monthly_minutes: list[int] = Field(min_length=12, max_length=12)


class SupportLogCharts(BaseModel):
    """월별 차트 데이터 — 코멘트 단위, comment.start_date 기준."""

    year: int
    monthly_count: list[int] = Field(min_length=12, max_length=12)
    monthly_minutes: list[int] = Field(min_length=12, max_length=12)
    by_engineer: list[MonthlyEngineerSeries]
