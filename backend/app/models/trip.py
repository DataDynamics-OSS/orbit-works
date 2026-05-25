"""출장 일정 (sidebar > 홈 > 출장).

여러 timezone 이 섞이는 출장 일정을 한 화면에서 계획. Trip 1건 = 한 출장,
하위 TripEvent 가 비행/숙박/미팅 등 개별 일정. 모든 시각은 UTC 로 정규화해
저장하고, `event_tz` 는 표시(현지) 시간대.
"""

import uuid
from datetime import date as date_cls, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Trip(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "trips"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 출장 기간 — 도착지 현지 날짜 기준 (UI 캘린더가 이 범위만 그린다).
    start_date: Mapped[date_cls] = mapped_column(Date, nullable=False)
    end_date: Mapped[date_cls] = mapped_column(Date, nullable=False)
    # IANA TZ 문자열 (예: "Asia/Seoul", "America/Los_Angeles"). 출발지/도착지를
    # 동시 표시(dual-tz) 하는 시간축에 사용.
    origin_tz: Mapped[str] = mapped_column(String(64), nullable=False)
    destination_tz: Mapped[str] = mapped_column(String(64), nullable=False)
    # 출발/도착 공항 IATA — 출장 생성 시 picker 로 선택. 목록 그리드 표시·
    # 필터링에 사용. NULL 허용 (수동 TZ 만 지정한 케이스 대비).
    origin_iata: Mapped[str | None] = mapped_column(String(8))
    destination_iata: Mapped[str | None] = mapped_column(String(8))
    # 소유자 — 본인 출장만 수정 가능 (조회는 같은 tenant 누구나).
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    notes: Mapped[str | None] = mapped_column(Text)
    # 준비물 — BlockNote JSON body (회의록 에디터와 동일 포맷). 우측 패널에 표시.
    prep_notes: Mapped[str | None] = mapped_column(Text)

    events: Mapped[list["TripEvent"]] = relationship(
        "TripEvent",
        back_populates="trip",
        cascade="all, delete-orphan",
        order_by="TripEvent.start_at",
    )


class TripEvent(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "trip_events"

    trip_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("trips.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # FLIGHT / HOTEL / MEETING / OTHER. enum 으로 묶지 않고 자유 문자열 — 추후
    # kind 추가 시 마이그레이션 부담을 피한다.
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # 모든 시각은 UTC. 표시용 wall-clock 변환은 event_tz 로 프런트가 수행.
    start_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    end_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # 이 이벤트가 일어나는 현지 TZ — 비행 도착 leg 는 도착공항 TZ, 호텔/미팅은
    # destination_tz 와 보통 같지만 환승/경유 등 예외를 위해 별도 컬럼.
    event_tz: Mapped[str] = mapped_column(String(64), nullable=False)
    # 비행 전용 — 출발/도착 IATA 와 항공편 번호. 다른 kind 에선 NULL.
    from_iata: Mapped[str | None] = mapped_column(String(8))
    to_iata: Mapped[str | None] = mapped_column(String(8))
    flight_no: Mapped[str | None] = mapped_column(String(20))
    # 위치/주소 — 호텔명·미팅 장소 등. 비행 이벤트에선 보통 비움.
    location: Mapped[str | None] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(Text)

    trip: Mapped[Trip] = relationship("Trip", back_populates="events")
