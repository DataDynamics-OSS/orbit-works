"""Trip / TripEvent — Pydantic schemas."""

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field


TRIP_EVENT_KINDS = {
    "FLIGHT",
    "HOTEL",
    "MEETING",
    "TRANSIT",
    "TOURISM",
    "CONFERENCE",
    "OTHER",
}


class TripEventBase(BaseModel):
    kind: str = Field(..., description="FLIGHT / HOTEL / MEETING / OTHER")
    title: str = Field(..., min_length=1, max_length=200)
    # UTC 로 보낸다 (프런트가 공항 현지 시각 + IATA tz 를 UTC 로 변환).
    start_at: datetime
    end_at: datetime
    event_tz: str = Field(..., min_length=1, max_length=64)
    from_iata: str | None = Field(default=None, max_length=8)
    to_iata: str | None = Field(default=None, max_length=8)
    flight_no: str | None = Field(default=None, max_length=20)
    location: str | None = Field(default=None, max_length=300)
    notes: str | None = None


class TripEventCreate(TripEventBase):
    pass


class TripEventUpdate(BaseModel):
    kind: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    start_at: datetime | None = None
    end_at: datetime | None = None
    event_tz: str | None = Field(default=None, min_length=1, max_length=64)
    from_iata: str | None = Field(default=None, max_length=8)
    to_iata: str | None = Field(default=None, max_length=8)
    flight_no: str | None = Field(default=None, max_length=20)
    location: str | None = Field(default=None, max_length=300)
    notes: str | None = None


class TripEventOut(TripEventBase):
    id: UUID
    trip_id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TripBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    start_date: date
    end_date: date
    origin_tz: str = Field(..., min_length=1, max_length=64)
    destination_tz: str = Field(..., min_length=1, max_length=64)
    origin_iata: str | None = Field(default=None, max_length=8)
    destination_iata: str | None = Field(default=None, max_length=8)
    notes: str | None = None
    prep_notes: str | None = None  # BlockNote JSON


class TripCreate(TripBase):
    pass


class TripUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    start_date: date | None = None
    end_date: date | None = None
    origin_tz: str | None = Field(default=None, min_length=1, max_length=64)
    destination_tz: str | None = Field(default=None, min_length=1, max_length=64)
    origin_iata: str | None = Field(default=None, max_length=8)
    destination_iata: str | None = Field(default=None, max_length=8)
    notes: str | None = None
    prep_notes: str | None = None


class TripOut(TripBase):
    id: UUID
    owner_user_id: UUID
    owner_name: str | None = None
    created_at: datetime
    updated_at: datetime
    events: list[TripEventOut] = []

    class Config:
        from_attributes = True
