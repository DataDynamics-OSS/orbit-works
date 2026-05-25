"""Attendance Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AttendanceCheckInRequest(BaseModel):
    """모바일 체크인 페이로드.

    `latitude`/`longitude` 는 브라우저 geolocation API 의 coords. 정밀도가 낮은
    값(±1km IP geolocation 등) 도 허용 — 검증은 worksite 반경 vs 거리 비교로만.
    """

    latitude: Decimal = Field(..., ge=-90, le=90)
    longitude: Decimal = Field(..., ge=-180, le=180)
    reason: str | None = Field(None, max_length=500)


class AttendanceCheckOutRequest(BaseModel):
    """모바일 체크아웃 페이로드 — 체크인과 동일 구조."""

    latitude: Decimal = Field(..., ge=-90, le=90)
    longitude: Decimal = Field(..., ge=-180, le=180)
    reason: str | None = Field(None, max_length=500)


class AttendanceOut(BaseModel):
    id: UUID
    user_id: UUID
    developer_id: UUID | None = None
    worksite_id: UUID | None = None
    work_date: date

    check_in_at: datetime
    check_in_lat: Decimal
    check_in_lng: Decimal
    check_in_distance_m: int | None = None
    check_in_within_radius: bool | None = None
    check_in_reason: str | None = None

    check_out_at: datetime | None = None
    check_out_lat: Decimal | None = None
    check_out_lng: Decimal | None = None
    check_out_distance_m: int | None = None
    check_out_within_radius: bool | None = None
    check_out_reason: str | None = None

    # JOIN derived (응답 시 채움) — worksite 이름·반경, developer 이름.
    worksite_name: str | None = None
    worksite_radius_meters: int | None = None
    developer_name: str | None = None

    model_config = ConfigDict(from_attributes=True)


class AttendanceContext(BaseModel):
    """체크인 화면 진입 시 미리 보여줄 컨텍스트.

    - `worksite`        : 사용자에게 매핑된(primary) 근무지. 없으면 null — UI 는
                          GPS 만 쓰고 거리 검증 없이 체크인 허용.
    - `today_sessions`  : 오늘(KST) work_date 의 모든 세션. ASC by check_in_at.
                          마지막 원소가 가장 최근 세션 — UI 는 이걸로 버튼 상태
                          판정 (열린 세션이면 출근 잠금/퇴근 활성, 모두 닫혔으면
                          출근 활성).
    """

    worksite_id: UUID | None = None
    worksite_name: str | None = None
    worksite_latitude: Decimal | None = None
    worksite_longitude: Decimal | None = None
    worksite_radius_meters: int | None = None
    worksite_work_start_time: str | None = None

    today_sessions: list[AttendanceOut] = []
