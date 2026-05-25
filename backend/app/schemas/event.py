"""워크샵·컨퍼런스 (events) — Pydantic 직렬화."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

EventKind = Literal["WORKSHOP", "CONFERENCE", "BUSINESS_TRIP"]


class FlightIn(BaseModel):
    position: int = 0
    airline: str | None = None
    booking_ref: str | None = None
    ticket_no: str | None = None
    flight_no: str | None = None
    departure_airport: str | None = None
    departure_terminal: str | None = None
    arrival_airport: str | None = None
    arrival_terminal: str | None = None
    seat_class: str | None = None
    departure_at: datetime | None = None
    arrival_at: datetime | None = None
    cost: Decimal = Field(default=Decimal(0))
    memo: str | None = None


class FlightOut(FlightIn):
    id: UUID

    class Config:
        from_attributes = True


class LodgingIn(BaseModel):
    position: int = 0
    name: str | None = None
    address: str | None = None
    phone: str | None = None
    email: str | None = None
    check_in_date: date | None = None
    check_out_date: date | None = None
    cost: Decimal = Field(default=Decimal(0))
    memo: str | None = None


class LodgingOut(LodgingIn):
    id: UUID

    class Config:
        from_attributes = True


class ParticipantIn(BaseModel):
    position: int = 0
    # 둘 중 하나는 채워져야 함 (서버 검증). 둘 다 set 이면 developer_id 우선.
    developer_id: UUID | None = None
    guest_name: str | None = None


class ParticipantOut(ParticipantIn):
    id: UUID
    # 화면 표시용 — developer_id 가 set 이면 그 사람의 이름을 join 해서 채움.
    display_name: str | None = None
    # 'M' | 'F' | None — 주민번호 7번째 자리에서 derive (raw RRN 노출 X). 외부 게스트는 None.
    gender: Literal["M", "F"] | None = None

    class Config:
        from_attributes = True


class EventAttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None
    size: int | None
    created_at: datetime

    class Config:
        from_attributes = True


class EventBase(BaseModel):
    kind: EventKind
    title: str
    address: str | None = None
    start_date: date
    end_date: date
    # 사전 책정 예산 / 실제 소요 금액 / 참가비 / 실비 (KRW). 0 이면 미입력 동등.
    budget: Decimal = Field(default=Decimal(0))
    actual_cost: Decimal = Field(default=Decimal(0))
    entry_fee: Decimal = Field(default=Decimal(0))
    expenses: Decimal = Field(default=Decimal(0))
    memo: str | None = None
    plan: str | None = None


class EventCreate(EventBase):
    flights: list[FlightIn] = Field(default_factory=list)
    lodgings: list[LodgingIn] = Field(default_factory=list)
    participants: list[ParticipantIn] = Field(default_factory=list)


class EventUpdate(BaseModel):
    kind: EventKind | None = None
    title: str | None = None
    address: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    budget: Decimal | None = None
    actual_cost: Decimal | None = None
    entry_fee: Decimal | None = None
    expenses: Decimal | None = None
    memo: str | None = None
    plan: str | None = None
    # sub 은 항상 전체 교체 — 부분 업데이트 X (다이얼로그에서 통째로 보냄).
    flights: list[FlightIn] | None = None
    lodgings: list[LodgingIn] | None = None
    participants: list[ParticipantIn] | None = None


class EventOut(EventBase):
    id: UUID
    flights: list[FlightOut] = Field(default_factory=list)
    lodgings: list[LodgingOut] = Field(default_factory=list)
    participants: list[ParticipantOut] = Field(default_factory=list)
    attachments: list[EventAttachmentOut] = Field(default_factory=list)
    # 합계 — API 가 sum 으로 채워서 응답.
    flights_total: Decimal = Field(default=Decimal(0))
    lodgings_total: Decimal = Field(default=Decimal(0))
    grand_total: Decimal = Field(default=Decimal(0))
    created_at: datetime
    updated_at: datetime
    created_by: UUID | None = None

    class Config:
        from_attributes = True


class AttachmentRename(BaseModel):
    file_name: str
