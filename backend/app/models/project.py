import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import ARRAY, BigInteger, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Project(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "projects"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="SET NULL")
    )
    orderer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="SET NULL")
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    total_contract_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, default=0
    )
    # KRW | USD
    contract_currency: Mapped[str] = mapped_column(String(10), nullable=False, default="KRW")
    description: Mapped[str | None] = mapped_column(Text)
    memo: Mapped[str | None] = mapped_column(Text)

    # SOLO | CONSORTIUM | SUBCONTRACT
    contract_type: Mapped[str | None] = mapped_column(String(30))
    # RESEARCH | PUBLIC | PRIVATE
    business_type: Mapped[str | None] = mapped_column(String(30))
    # CONSULTING | DEVELOPMENT | OPERATIONS_MAINTENANCE | TECHNICAL_SUPPORT
    project_nature: Mapped[str | None] = mapped_column(String(30))

    # Days-before-end to trigger expiry alarms (e.g. [90, 30, 7])
    alarm_days_before: Mapped[list[int] | None] = mapped_column(ARRAY(Integer))

    # 명시적 종료 타임스탬프. set 이면 프로젝트가 수동으로 종료됨을 의미
    # (end_date 기준 자동 "지연" 표시와 구분).
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    quotes: Mapped[list["ProjectQuote"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    comments: Mapped[list["ProjectComment"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    attachments: Mapped[list["ProjectAttachment"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class ProjectQuote(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "project_quotes"

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(100))
    size: Mapped[int | None] = mapped_column(BigInteger)
    description: Mapped[str | None] = mapped_column(Text)

    project: Mapped["Project"] = relationship(back_populates="quotes")


class ProjectAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """Single-file-per-slot attachment. Slot values:
    CONTRACT(계약서) / QUOTE(견적서) / PROPOSAL(제안서) /
    TECH_NEGOTIATION(기술협상) / OTHER(기타).
    """

    __tablename__ = "project_attachments"
    __table_args__ = (
        UniqueConstraint("project_id", "slot", name="uq_project_attachment_slot"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    slot: Mapped[str] = mapped_column(String(30), nullable=False)
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(Integer)

    project: Mapped["Project"] = relationship(back_populates="attachments")


class ProjectComment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "project_comments"

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    author_name: Mapped[str | None] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text, nullable=False)

    project: Mapped["Project"] = relationship(back_populates="comments")
