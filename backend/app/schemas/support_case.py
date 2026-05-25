"""기술지원 케이스 — Pydantic 직렬화."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

SupportCaseStatus = Literal["OPEN", "IN_PROGRESS", "CLOSED"]
# AWS-style 5단계 — S1(긴급) ~ S5(정보). 정렬에 자연스러운 코드 사용.
SupportCaseSeverity = Literal["S1", "S2", "S3", "S4", "S5"]
# 케이스 유형. 한글 라벨은 프론트 (lib/support-categories.ts) 에서 매핑.
SupportCaseCategory = Literal[
    "PERFORMANCE",
    "MALFUNCTION",
    "SECURITY",
    "DATA_LOSS",
    "TUNING",
    "JOB_FAILURE",
    "SERVICE_DOWN",
    "OTHER",
]


class SupportCaseAttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None
    size: int | None
    created_at: datetime

    class Config:
        from_attributes = True


class SupportCaseCommentOut(BaseModel):
    id: UUID
    author_user_id: UUID | None
    author_name: str | None = None  # API 가 user 이름 join 으로 채움
    body: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SupportCaseProductIn(BaseModel):
    """Case 다이얼로그가 보내는 product 1건. id 가 None 이면 product 이름으로
    카탈로그 lookup-or-create.
    """
    product_id: UUID | None = None
    product: str | None = None
    version_id: UUID | None = None
    version: str | None = None
    sort_order: int = 0


class SupportCaseProductOut(BaseModel):
    product_id: UUID
    product: str | None = None
    version_id: UUID | None = None
    version: str | None = None
    sort_order: int = 0

    class Config:
        from_attributes = True


class SupportCaseBase(BaseModel):
    customer_id: UUID
    project_id: UUID | None = None
    sales_rep_developer_id: UUID | None = None
    support_engineer_developer_id: UUID | None = None
    # vendor 는 단일 정보·필터링용. 제품·버전은 products[] 다중.
    vendor: str | None = None
    products: list[SupportCaseProductIn] = Field(default_factory=list)
    vendor_case_no: str | None = None
    title: str = Field(..., min_length=1, max_length=300)
    status: SupportCaseStatus = "OPEN"
    category: SupportCaseCategory = "OTHER"
    severity: SupportCaseSeverity = "S3"
    body: str | None = None


class SupportCaseCreate(SupportCaseBase):
    pass


class SupportCaseUpdate(BaseModel):
    customer_id: UUID | None = None
    project_id: UUID | None = None
    sales_rep_developer_id: UUID | None = None
    support_engineer_developer_id: UUID | None = None
    vendor: str | None = None
    products: list[SupportCaseProductIn] | None = None
    vendor_case_no: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    status: SupportCaseStatus | None = None
    category: SupportCaseCategory | None = None
    severity: SupportCaseSeverity | None = None
    body: str | None = None


class SupportCaseOut(BaseModel):
    id: UUID
    case_no: str | None = None
    customer_id: UUID
    project_id: UUID | None = None
    sales_rep_developer_id: UUID | None = None
    support_engineer_developer_id: UUID | None = None
    vendor_id: UUID | None = None
    vendor: str | None = None  # vendor name (UI 표시용)
    products: list[SupportCaseProductOut] = Field(default_factory=list)
    vendor_case_no: str | None = None
    title: str
    status: SupportCaseStatus
    category: SupportCaseCategory
    severity: SupportCaseSeverity
    body: str | None = None
    customer_name: str | None = None
    project_name: str | None = None
    sales_rep_name: str | None = None
    support_engineer_name: str | None = None
    attachments: list[SupportCaseAttachmentOut] = Field(default_factory=list)
    comments: list[SupportCaseCommentOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    created_by: UUID | None = None
    # 종료 메타 — status == 'CLOSED' 일 때 채워짐. 재오픈하면 NULL 로 reset.
    closed_at: datetime | None = None
    closed_by: UUID | None = None
    closed_by_name: str | None = None  # users 조인으로 라우터가 채움

    class Config:
        from_attributes = True


class CommentIn(BaseModel):
    body: str


class AttachmentRename(BaseModel):
    file_name: str


class StatsBucket(BaseModel):
    """파이 차트 한 조각 — label + count."""

    label: str
    count: int


class SupportCaseStats(BaseModel):
    """기술지원 케이스 KPI — created_at 의 연도 기준."""

    year: int
    year_count: int
    by_severity: list[StatsBucket]
    by_status: list[StatsBucket]
    by_category: list[StatsBucket]
    by_product: list[StatsBucket]
    by_engineer: list[StatsBucket]
