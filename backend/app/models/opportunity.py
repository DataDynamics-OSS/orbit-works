import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    SmallInteger,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Opportunity(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """매년 관리되는 영업기회 (Sales Opportunity).

    - stage: LEAD | QUALIFIED | PROPOSAL | NEGOTIATION (open pipeline 단계)
    - status: OPEN (기본) | WON | LOST | ABANDONED
    - 연도 필터 기준은 expected_close_date.year.
    """

    __tablename__ = "opportunities"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="SET NULL")
    )
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    # 영업대표 — 임직원(Developer) 테이블 참조.
    sales_rep_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("developers.id", ondelete="SET NULL")
    )

    stage: Mapped[str] = mapped_column(String(20), nullable=False, default="LEAD")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    probability: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=10)
    # RESEARCH(연구과제) | PRIVATE(민간사업) | PUBLIC(공공사업)
    business_type: Mapped[str | None] = mapped_column(String(20))

    expected_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")

    # 업무상 "등록일" — 사용자가 생성 시 지정 (기본 오늘, 과거/미래 자유).
    # 미지정(NULL) 시 타임라인은 created_at 로 폴백한다.
    registered_at: Mapped[date | None] = mapped_column(Date)
    expected_close_date: Mapped[date | None] = mapped_column(Date)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    source: Mapped[str | None] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(Text)
    memo: Mapped[str | None] = mapped_column(Text)

    # Customer-side contact (담당자) info.
    contact_name: Mapped[str | None] = mapped_column(String(100))
    contact_department: Mapped[str | None] = mapped_column(String(100))
    contact_phone: Mapped[str | None] = mapped_column(String(50))
    contact_email: Mapped[str | None] = mapped_column(String(200))

    # Optional conversion targets — populated when the opportunity is won and
    # materialized into a license or project. FKs are intentionally not
    # declared (no cascades, no hard coupling) to keep delete semantics safe.
    converted_license_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True)
    )
    converted_project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True)
    )

    activities: Mapped[list["OpportunityActivity"]] = relationship(
        back_populates="opportunity",
        cascade="all, delete-orphan",
        order_by="OpportunityActivity.happened_at.desc()",
    )
    stage_history: Mapped[list["OpportunityStageHistory"]] = relationship(
        back_populates="opportunity",
        cascade="all, delete-orphan",
        order_by="OpportunityStageHistory.changed_at",
    )
    attachments: Mapped[list["OpportunityAttachment"]] = relationship(
        back_populates="opportunity",
        cascade="all, delete-orphan",
        order_by="OpportunityAttachment.created_at.desc()",
    )


class OpportunityActivity(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """활동 기록 — MEETING / CALL / EMAIL / PROPOSAL / NOTE 등."""

    __tablename__ = "opportunity_activities"

    opportunity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("opportunities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    activity_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="NOTE"
    )
    happened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    opportunity: Mapped["Opportunity"] = relationship(back_populates="activities")


class OpportunityStageHistory(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """Stage/Status 변경 로그 — 자동 기록."""

    __tablename__ = "opportunity_stage_history"

    opportunity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("opportunities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    from_stage: Mapped[str | None] = mapped_column(String(20))
    to_stage: Mapped[str] = mapped_column(String(20), nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    note: Mapped[str | None] = mapped_column(Text)

    opportunity: Mapped["Opportunity"] = relationship(back_populates="stage_history")


class OpportunityAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """영업기회 첨부 파일. 파일은 data/opportunities/{opp_id}/ 아래에 저장."""

    __tablename__ = "opportunity_attachments"

    opportunity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("opportunities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)
    description: Mapped[str | None] = mapped_column(Text)

    opportunity: Mapped["Opportunity"] = relationship(back_populates="attachments")
