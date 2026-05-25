"""Meeting — 회의실 예약 도메인.

- `meeting_rooms`: 관리자가 관리하는 회의실 마스터
- `meeting_reservations`: 일반 사용자가 생성하는 예약 (start/end, 주최자, 상태)
- `meeting_reservation_participants`: 예약-임직원 다대다 (Slack 알림 대상)

시간 충돌 방지는 PostgreSQL EXCLUDE USING gist (tstzrange) 제약으로
DB 레벨에서 race condition-safe 하게 보장된다 (db.sql 참조).
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class MeetingRoom(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "meeting_rooms"
    # tenant 별 같은 이름 회의실 가능 — 글로벌 UNIQUE 가 아니라 (tenant_id, name)
    # 복합 UNIQUE.
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="meeting_rooms_tenant_name_key"),
    )

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    location: Mapped[str | None] = mapped_column(String(200))
    capacity: Mapped[int | None] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class MeetingReservation(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "meeting_reservations"

    room_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meeting_rooms.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    organizer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # CONFIRMED | CANCELLED
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="CONFIRMED")
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    room: Mapped[MeetingRoom] = relationship()
    participants: Mapped[list["MeetingReservationParticipant"]] = relationship(
        back_populates="reservation",
        cascade="all, delete-orphan",
    )


class MeetingReservationParticipant(Base, TenantMixin):
    __tablename__ = "meeting_reservation_participants"

    reservation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meeting_reservations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        primary_key=True,
    )

    reservation: Mapped[MeetingReservation] = relationship(back_populates="participants")
