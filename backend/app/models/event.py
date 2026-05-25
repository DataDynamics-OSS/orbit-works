"""워크샵·컨퍼런스 (`events`) 모델 + 4 sub 테이블.

기능:
- 회사가 참여하는 워크샵·컨퍼런스의 일정·장소·항공권·숙박·참석자·첨부 통합 관리.
- 참석자는 사내 developer (FK) 또는 외부 인사 (이름만 입력) 둘 다 지원.
- 모든 비용 KRW 고정 (다중 통화 미지원, 추후 필요해지면 currency 컬럼 추가).

관계:
  events ──┬── event_flights        (1:N, FK CASCADE)
           ├── event_lodgings       (1:N, FK CASCADE)
           ├── event_participants   (1:N, FK CASCADE; developer_id OR guest_name)
           └── event_attachments    (1:N, FK CASCADE; 다중 파일)

권한: `events.manage` (HR + ADMIN).
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Event(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """워크샵 또는 컨퍼런스 1건."""

    __tablename__ = "events"

    # WORKSHOP | CONFERENCE | BUSINESS_TRIP — frontend 와 동기화.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # 자유 텍스트 주소 — Kakao Map / Google Map 으로 시각화. 좌표 별도 저장 X
    # (지도 SDK 의 geocoder 가 매번 변환 — 주소가 바뀔 때 재계산하면 됨).
    address: Mapped[str | None] = mapped_column(Text)
    start_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # 사전 책정 예산 / 실제 소요 금액 / 참가비 / 실비 (KRW). 통계·집행률 분석용.
    # expenses = 교통비·식대 등 출장 실비 (참가비·소요금액과 별도 집계).
    budget: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    actual_cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    entry_fee: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    expenses: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    memo: Mapped[str | None] = mapped_column(Text)
    # 상세 계획 — 메모장처럼 자유 입력 (plain text, 마크다운 X). 일정·준비물·체크리스트.
    plan: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    flights: Mapped[list["EventFlight"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        order_by="EventFlight.position",
    )
    lodgings: Mapped[list["EventLodging"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        order_by="EventLodging.position",
    )
    participants: Mapped[list["EventParticipant"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        order_by="EventParticipant.position",
    )
    attachments: Mapped[list["EventAttachment"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        order_by="EventAttachment.created_at",
    )


class EventFlight(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """항공권 1건. event 1개당 N개 가능 (왕복·환승·다구간 등)."""

    __tablename__ = "event_flights"

    event_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # UI 정렬용. 사용자가 추가 순서대로 0,1,2,...
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    airline: Mapped[str | None] = mapped_column(String(120))           # 항공사 (예: "Korean Air")
    booking_ref: Mapped[str | None] = mapped_column(String(80))        # 예약번호 (PNR)
    ticket_no: Mapped[str | None] = mapped_column(String(80))          # 항공권 번호 (eTicket)
    flight_no: Mapped[str | None] = mapped_column(String(40))          # 편명 (예: "KE017")
    departure_airport: Mapped[str | None] = mapped_column(String(120))
    departure_terminal: Mapped[str | None] = mapped_column(String(40))
    arrival_airport: Mapped[str | None] = mapped_column(String(120))
    arrival_terminal: Mapped[str | None] = mapped_column(String(40))
    seat_class: Mapped[str | None] = mapped_column(String(40))         # ECONOMY/BUSINESS/FIRST/PREMIUM 등
    departure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    arrival_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # 비용 (KRW 고정)
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    memo: Mapped[str | None] = mapped_column(Text)

    event: Mapped[Event] = relationship(back_populates="flights")


class EventLodging(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """숙박 1건 (호텔/에어비앤비 등)."""

    __tablename__ = "event_lodgings"

    event_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    name: Mapped[str | None] = mapped_column(String(200))              # 호텔명
    address: Mapped[str | None] = mapped_column(Text)                  # 호텔 주소 (지도 미리보기)
    phone: Mapped[str | None] = mapped_column(String(40))              # 전화번호
    email: Mapped[str | None] = mapped_column(String(120))             # 이메일
    check_in_date: Mapped[date | None] = mapped_column(Date)
    check_out_date: Mapped[date | None] = mapped_column(Date)
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    memo: Mapped[str | None] = mapped_column(Text)

    event: Mapped[Event] = relationship(back_populates="lodgings")


class EventParticipant(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """참석자 1명. developer_id 가 set 되면 사내 임직원, NULL 이면 guest_name 으로 외부인."""

    __tablename__ = "event_participants"

    event_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 사내 임직원 — set 이면 guest_name 무시. 둘 중 하나는 반드시 채워져야 함 (앱 검증).
    developer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    # 외부 참석자 — developer_id 가 NULL 일 때 표시용 이름.
    guest_name: Mapped[str | None] = mapped_column(String(120))

    event: Mapped[Event] = relationship(back_populates="participants")

    # 같은 developer 가 한 event 에 중복 등록되는 일은 없다 (외부 게스트는 이름 중복 허용).
    __table_args__ = (
        UniqueConstraint("event_id", "developer_id", name="uq_event_participants_dev"),
    )


class EventAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """이벤트 첨부 — 매입 인보이스 첨부와 동일 패턴."""

    __tablename__ = "event_attachments"

    event_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(Integer)

    event: Mapped[Event] = relationship(back_populates="attachments")
