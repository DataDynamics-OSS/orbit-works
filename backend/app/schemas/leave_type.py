"""LeaveType Pydantic 스키마."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


LeaveCategory = Literal[
    "ANNUAL",       # 연차/반차
    "LIFE_EVENT",   # 경조 + 출산
    "PUBLIC_DUTY",  # 공가 (예비군·민방위·건강검진)
    "SICK",         # 병가 (보건/유급/무급)
    "REWARD",       # 포상 (장기근속 등)
    "OTHER",        # 출장·무급휴가·기타
]
LeaveUnit = Literal["DAY", "HALF", "HOUR"]


class LeaveTypeBase(BaseModel):
    # code 는 시스템 내부 식별자 — 신규 등록 시 비우면 라우터가 자동 생성한다.
    # UI 에서는 노출하지 않으며, 시드 데이터·백엔드 로직·향후 마이그레이션 용도.
    code: str | None = Field(default=None, max_length=40, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=1, max_length=100)
    category: LeaveCategory
    unit: LeaveUnit = "DAY"
    deducts_annual: bool = True
    paid: bool = True
    max_days_per_year: Decimal | None = Field(default=None, ge=0)
    max_uses_per_year: int | None = Field(default=None, ge=0)
    requires_evidence: bool = False
    requires_reason: bool = False
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    description: str | None = None
    sort_order: int = 0
    is_active: bool = True


class LeaveTypeCreate(LeaveTypeBase):
    pass


class LeaveTypeUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=40, pattern=r"^[A-Z0-9_]+$")
    name: str | None = Field(default=None, min_length=1, max_length=100)
    category: LeaveCategory | None = None
    unit: LeaveUnit | None = None
    deducts_annual: bool | None = None
    paid: bool | None = None
    max_days_per_year: Decimal | None = Field(default=None, ge=0)
    max_uses_per_year: int | None = Field(default=None, ge=0)
    requires_evidence: bool | None = None
    requires_reason: bool | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    description: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None


class LeaveTypeOut(LeaveTypeBase):
    id: UUID
    code: str  # Out 은 항상 채워져 있음 (DB 가 NOT NULL)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
