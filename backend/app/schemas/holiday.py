"""Pydantic schemas for 캘린더 (공휴일 + 일정).

휴일 3종 + 일정 2종을 같은 테이블에 저장. type 으로 구분.
"""

from datetime import date as DateType, datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

# 휴일 3종 + 일정 3종.
#   STATUTORY/TEMPORARY/COMPANY = 휴일 (근무일수 차감, 모두 공개)
#   EVENT_PUBLIC                = 일정 (근무일수 비차감, 모두 공개)
#   EVENT_PRIVATE               = 일정 (근무일수 비차감, HR/ADMIN/SUPER_ADMIN 만 보기 — HR 내부)
#   EVENT_PERSONAL              = 일정 (근무일수 비차감, 작성자 본인만 보기 — 개인 일정)
HolidayType = Literal[
    "STATUTORY", "TEMPORARY", "COMPANY",
    "EVENT_PUBLIC", "EVENT_PRIVATE", "EVENT_PERSONAL",
    # 합성 row — DB 저장 안 함. list_holidays 가 payroll 설정 기반으로
    # 매월 1개씩 만들어 응답에 추가. 모든 임직원 가시. 편집·삭제 불가.
    "EVENT_PAYDAY",
]

# 휴일 vs 일정 구분 — 근무일수 계산·정렬·UI 색상에서 사용.
HOLIDAY_KIND_TYPES: tuple[str, ...] = ("STATUTORY", "TEMPORARY", "COMPANY")
EVENT_KIND_TYPES: tuple[str, ...] = ("EVENT_PUBLIC", "EVENT_PRIVATE", "EVENT_PERSONAL")
# 일반 사용자(ETC/SALES/SUPPORT)도 직접 등록·삭제 가능한 일정 타입.
USER_CREATABLE_TYPES: tuple[str, ...] = ("EVENT_PUBLIC", "EVENT_PERSONAL")


class AlarmRecipientOut(BaseModel):
    """비공개 일정 알람 수신자 — 응답 전용."""

    developer_id: UUID
    developer_name: Optional[str] = None  # API 가 join 으로 채움
    notified_at: Optional[datetime] = None


class HolidayCreate(BaseModel):
    date: DateType
    name: str = Field(min_length=1, max_length=100)
    type: HolidayType = "TEMPORARY"
    description: Optional[str] = None
    # EVENT_PRIVATE 일 때만 의미 있음. 그 외 type 이면 서버가 무시 (silently drop).
    alarm_recipients: list[UUID] = Field(default_factory=list)


class HolidayUpdate(BaseModel):
    date: Optional[DateType] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    type: Optional[HolidayType] = None
    description: Optional[str] = None
    # None = 변경 없음. [] = 모두 제거. list = 전체 교체.
    alarm_recipients: Optional[list[UUID]] = None


class HolidayBulkCreate(BaseModel):
    dates: list[DateType]
    name: str = Field(min_length=1, max_length=100)
    type: HolidayType = "TEMPORARY"
    description: Optional[str] = None


class HolidayOut(BaseModel):
    id: UUID
    date: DateType
    name: str
    type: HolidayType
    description: Optional[str] = None
    created_by: Optional[UUID] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    alarm_recipients: list[AlarmRecipientOut] = Field(default_factory=list)

    class Config:
        from_attributes = True


class HolidayCheckOut(BaseModel):
    date: DateType
    is_holiday: bool
    is_weekend: bool
    name: Optional[str] = None
    type: Optional[HolidayType] = None
