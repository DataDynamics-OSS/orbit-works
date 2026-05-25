"""Leave (연차) 도메인 모델.

설계 요약 — 자세한 근거는 README 의 "연차 제도" 섹션 참고.

- `leave_balances`              : 법정 연차 잔여 (연도 단위, 관리자 초기화)
- `leave_accruals`              : 월 개근 적립 이력 (최대 11일 상한)
- `leave_reward_grants`         : 포상 연차 부여 원장 (소진까지 유지, FIFO)
- `leave_requests`              : 신청 본체
- `leave_request_allocations`   : 한 신청이 어느 원장에서 얼마를 뺐는지 배분
- `leave_reset_history`         : 초기화 감사

사용 순서는 법정(current year) → 포상(FIFO) 이며, 연도 경계를 걸치는 신청은
`leave_request_allocations` 에 연도별로 여러 row 가 생성되어 관리된다.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
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


# ---------------------------------------------------------------------------
# 법정 연차 잔여 (연도 단위)
# ---------------------------------------------------------------------------


class LeaveBalance(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "leave_balances"
    __table_args__ = (
        UniqueConstraint("developer_id", "year", name="uq_leave_balance_dev_year"),
    )

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    year: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    granted_days: Mapped[Decimal] = mapped_column(
        Numeric(4, 1), nullable=False, default=Decimal("0.0")
    )
    used_days: Mapped[Decimal] = mapped_column(
        Numeric(4, 1), nullable=False, default=Decimal("0.0")
    )
    pending_days: Mapped[Decimal] = mapped_column(
        Numeric(4, 1), nullable=False, default=Decimal("0.0")
    )
    # ANNUAL_15  : 1년 이상 근속 & 전년 출근율 80%↑ → 15일 일괄 부여
    # MONTHLY_ACCRUAL : 1년 미만 또는 80% 미만 → 월 개근 시 1일씩 누적 (최대 11)
    accrual_strategy: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ANNUAL_15"
    )
    initialized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    initialized_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


# ---------------------------------------------------------------------------
# 월 개근 적립 이력
# ---------------------------------------------------------------------------


class LeaveAccrual(Base, UUIDMixin, TenantMixin):
    __tablename__ = "leave_accruals"
    __table_args__ = (
        UniqueConstraint(
            "developer_id", "year", "month", name="uq_leave_accrual_dev_year_month"
        ),
    )

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    days: Mapped[Decimal] = mapped_column(
        Numeric(3, 1), nullable=False, default=Decimal("1.0")
    )
    reason: Mapped[str] = mapped_column(
        String(40), nullable=False, default="PERFECT_ATTENDANCE"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default="now()"
    )


# ---------------------------------------------------------------------------
# 포상 연차 (이월·누적, 소진까지 유지)
# ---------------------------------------------------------------------------


class LeaveRewardGrant(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "leave_reward_grants"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    granted_days: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False)
    remaining_days: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False)
    reason: Mapped[str] = mapped_column(String(200), nullable=False)
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default="now()"
    )
    granted_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    revoked_reason: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------------------
# 연차 신청
# ---------------------------------------------------------------------------


class LeaveRequest(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "leave_requests"
    __table_args__ = (
        CheckConstraint(
            "(days_total * 2) = floor(days_total * 2)",
            name="ck_leave_requests_half_day_unit",
        ),
        CheckConstraint("days_total >= 0.5", name="ck_leave_requests_min_days"),
        CheckConstraint("end_date >= start_date", name="ck_leave_requests_date_order"),
    )

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    requester_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    # ANNUAL | HALF | UNPAID_PUBLIC
    leave_type: Mapped[str] = mapped_column(String(20), nullable=False)
    # HALF 일 때만: AM | PM
    half_kind: Mapped[str | None] = mapped_column(String(4))
    # UNPAID_PUBLIC 전용: RESERVE_DUTY | CIVIC_DEFENSE | JURY_DUTY | ...
    category: Mapped[str | None] = mapped_column(String(30))

    start_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    end_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    days_total: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False)

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="PENDING", index=True
    )
    reason: Mapped[str | None] = mapped_column(Text)
    evidence_path: Mapped[str | None] = mapped_column(String(500))

    approver_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_reason: Mapped[str | None] = mapped_column(Text)

    allocations: Mapped[list["LeaveRequestAllocation"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
    )


# ---------------------------------------------------------------------------
# 신청 ↔ 원장 차감 배분 (1 신청 = N allocation)
# ---------------------------------------------------------------------------


class LeaveRequestAllocation(Base, UUIDMixin, TenantMixin):
    __tablename__ = "leave_request_allocations"
    __table_args__ = (
        CheckConstraint(
            "(source_type = 'STATUTORY' AND year IS NOT NULL AND grant_id IS NULL) OR "
            "(source_type = 'REWARD'    AND year IS NULL     AND grant_id IS NOT NULL)",
            name="ck_leave_alloc_source_shape",
        ),
        CheckConstraint("days > 0", name="ck_leave_alloc_positive_days"),
    )

    request_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("leave_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_type: Mapped[str] = mapped_column(String(16), nullable=False)
    year: Mapped[int | None] = mapped_column(Integer)
    grant_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("leave_reward_grants.id", ondelete="RESTRICT"),
    )
    days: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default="now()"
    )

    request: Mapped[LeaveRequest] = relationship(back_populates="allocations")


# ---------------------------------------------------------------------------
# 초기화 감사
# ---------------------------------------------------------------------------


class LeaveResetHistory(Base, UUIDMixin, TenantMixin):
    __tablename__ = "leave_reset_history"

    year: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # NULL = 전체 / 특정 ID = 해당 직원만
    developer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("developers.id", ondelete="SET NULL")
    )
    strategy: Mapped[str] = mapped_column(String(20), nullable=False)
    granted_days: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False)
    reset_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    reset_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default="now()"
    )
    note: Mapped[str | None] = mapped_column(Text)
