"""출퇴근 (Attendance) — 모바일에서 출근/퇴근 시 위치와 시각을 기록.

한 row = 한 세션(출근→퇴근). 같은 날 여러 세션 허용 — 정규 근무 후 긴급
업무로 다시 나오는 경우 등을 자연스럽게 N개 row 로 표현.

불변식: 사용자당 동시에 열린 세션은 0 또는 1개. partial unique index 가
DB 차원에서 강제 (`uq_attendance_user_open`). 두 기기에서 동시에 출근
클릭하는 경합도 한쪽이 IntegrityError 로 거부됨.

체크인 시 사용자의 GPS 좌표 + 매핑된 worksite 의 중심 좌표/반경을 비교해
- 반경 안 → reason 선택
- 반경 밖 → reason 필수 (API 단에서 강제, UI 에서도 안내)
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Attendance(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "attendances"
    __table_args__ = (
        # "동시에 열린 세션 1개" 강제 — check_out_at IS NULL 인 row 가
        # 사용자별 최대 1개. 정상 흐름(퇴근 후 새 출근) 은 통과.
        Index(
            "uq_attendance_user_open",
            "user_id",
            unique=True,
            postgresql_where="check_out_at IS NULL",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 검색·HR 리포트 편의용 denormalize. user.mapped_developer_id 와 동일 시점값.
    developer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    # 체크인 시점에 평가된 가장 가까운 worksite (또는 사용자 매핑된 1개). NULL = worksite 미매핑.
    worksite_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("worksites.id", ondelete="SET NULL"),
    )
    # 한국 시간 기준 근무일 (YYYY-MM-DD). 일자별 unique 키.
    work_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ---- 출근 ----
    check_in_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    check_in_lat: Mapped[Decimal] = mapped_column(Numeric(10, 7), nullable=False)
    check_in_lng: Mapped[Decimal] = mapped_column(Numeric(10, 7), nullable=False)
    # worksite 중심에서의 거리(m). worksite 가 없거나 좌표 미등록이면 NULL.
    check_in_distance_m: Mapped[int | None] = mapped_column(Integer)
    # 반경 안이면 true, 밖이면 false. worksite 미매핑 시 NULL.
    check_in_within_radius: Mapped[bool | None] = mapped_column(Boolean)
    # 비정상 체크인(반경 밖 / 지각 등) 사유. 반경 밖이면 필수.
    check_in_reason: Mapped[str | None] = mapped_column(Text)

    # ---- 퇴근 (다음 작업) ----
    check_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    check_out_lat: Mapped[Decimal | None] = mapped_column(Numeric(10, 7))
    check_out_lng: Mapped[Decimal | None] = mapped_column(Numeric(10, 7))
    check_out_distance_m: Mapped[int | None] = mapped_column(Integer)
    check_out_within_radius: Mapped[bool | None] = mapped_column(Boolean)
    check_out_reason: Mapped[str | None] = mapped_column(Text)
