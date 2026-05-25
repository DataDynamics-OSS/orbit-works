"""Pydantic schemas for 회의실 예약(meetings)."""

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

ReservationStatus = Literal["CONFIRMED", "CANCELLED"]


# ---------------------------------------------------------------------------
# Room
# ---------------------------------------------------------------------------


class MeetingRoomCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    location: Optional[str] = Field(default=None, max_length=200)
    capacity: Optional[int] = Field(default=None, ge=0)
    description: Optional[str] = None
    is_active: bool = True


class MeetingRoomUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    location: Optional[str] = Field(default=None, max_length=200)
    capacity: Optional[int] = Field(default=None, ge=0)
    description: Optional[str] = None
    is_active: Optional[bool] = None


class MeetingRoomOut(BaseModel):
    id: UUID
    name: str
    location: Optional[str] = None
    capacity: Optional[int] = None
    description: Optional[str] = None
    is_active: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Reservation
# ---------------------------------------------------------------------------


class ReservationParticipantOut(BaseModel):
    developer_id: UUID
    name: Optional[str] = None
    email: Optional[str] = None


class MeetingReservationCreate(BaseModel):
    room_id: UUID
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    start_at: datetime
    end_at: datetime
    participant_developer_ids: list[UUID] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_range(self) -> "MeetingReservationCreate":
        if self.end_at <= self.start_at:
            raise ValueError("end_at 은 start_at 보다 커야 합니다.")
        return self


class MeetingReservationUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    participant_developer_ids: Optional[list[UUID]] = None
    status: Optional[ReservationStatus] = None

    @model_validator(mode="after")
    def _check_range(self) -> "MeetingReservationUpdate":
        if self.start_at and self.end_at and self.end_at <= self.start_at:
            raise ValueError("end_at 은 start_at 보다 커야 합니다.")
        return self


class MeetingReservationOut(BaseModel):
    id: UUID
    room_id: UUID
    room_name: Optional[str] = None
    organizer_id: Optional[UUID] = None
    organizer_name: Optional[str] = None
    title: str
    description: Optional[str] = None
    start_at: datetime
    end_at: datetime
    status: ReservationStatus
    participants: list[ReservationParticipantOut] = Field(default_factory=list)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True
