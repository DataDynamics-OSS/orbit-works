"""Worksite + WorksiteAssignment Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


WorksiteStatus = Literal["ACTIVE", "INACTIVE"]


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------


class WorksiteAssignmentBase(BaseModel):
    developer_id: UUID
    # 입력은 옵션 — 미지정 시 라우터가 오늘 날짜로 채움. 출력엔 항상 값 존재.
    start_date: date | None = None
    end_date: date | None = None
    is_primary: bool = False
    memo: str | None = None


class WorksiteAssignmentCreate(WorksiteAssignmentBase):
    pass


class WorksiteAssignmentUpdate(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    is_primary: bool | None = None
    memo: str | None = None


class WorksiteAssignmentOut(WorksiteAssignmentBase):
    id: UUID
    worksite_id: UUID
    # JOIN 으로 채워지는 표시 전용.
    developer_name: str | None = None
    # 퇴사 직원(INACTIVE) 매핑은 UI 에서 숨겨야 하므로 status 도 함께 노출.
    developer_status: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Worksite
# ---------------------------------------------------------------------------


# "HH:MM" 30분 단위 — 정확히 ":00" 또는 ":30" 만 허용.
TIME_HHMM_30M = r"^([01]\d|2[0-3]):(00|30)$"


class WorksiteBase(BaseModel):
    name: str
    address: str | None = None
    # 좌표는 신규 등록 직후엔 비어있을 수 있어 NULL 허용.
    latitude: Decimal | None = Field(default=None, ge=-90, le=90)
    longitude: Decimal | None = Field(default=None, ge=-180, le=180)
    # 사용자가 등록 시 직접 입력 (m). 0 보다 커야 함.
    radius_meters: int = Field(gt=0, le=10000)
    work_start_time: str = Field(default="09:00", pattern=TIME_HHMM_30M)
    work_end_time: str = Field(default="18:00", pattern=TIME_HHMM_30M)
    # M:N — 입력은 프로젝트 ID 리스트. 비어있으면 무관 근무지.
    project_ids: list[UUID] = Field(default_factory=list)
    status: WorksiteStatus = "ACTIVE"
    memo: str | None = None


class WorksiteCreate(WorksiteBase):
    pass


class WorksiteUpdate(BaseModel):
    name: str | None = None
    address: str | None = None
    latitude: Decimal | None = Field(default=None, ge=-90, le=90)
    longitude: Decimal | None = Field(default=None, ge=-180, le=180)
    radius_meters: int | None = Field(default=None, gt=0, le=10000)
    work_start_time: str | None = Field(default=None, pattern=TIME_HHMM_30M)
    work_end_time: str | None = Field(default=None, pattern=TIME_HHMM_30M)
    # 미지정 → 변경 없음. 명시 빈 리스트 → 모든 link 제거.
    project_ids: list[UUID] | None = None
    status: WorksiteStatus | None = None
    memo: str | None = None


class ProjectBrief(BaseModel):
    id: UUID
    name: str

    model_config = ConfigDict(from_attributes=True)


class WorksiteOut(WorksiteBase):
    id: UUID
    # JOIN derived — 표시 전용 (id+name 페어). 입력 시 project_ids 만 사용.
    projects: list[ProjectBrief] = []
    assignment_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WorksiteDetail(WorksiteOut):
    """상세 — 매핑 직원 목록 포함."""

    assignments: list[WorksiteAssignmentOut] = []
