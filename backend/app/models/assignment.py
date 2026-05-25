import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import Boolean, Date, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Assignment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "assignments"

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    developer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("developers.id", ondelete="CASCADE"), nullable=False
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)

    # Monthly totals — monthly_rate holds the sum (base + insurance +
    # overhead + freelancer). Detail columns are kept for display/audit.
    monthly_rate: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    base_monthly: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    insurance_monthly: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    overhead_monthly: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    freelancer_monthly: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    is_insourced: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 투입 공수(%) — 원가 계산 시 해당 인력의 월 비용에 곱해지는 비율.
    # 100 = 풀타임, 60 = 60% 원가만 프로젝트에 귀속 (잔여는 다른 프로젝트/내부 업무).
    allocation_percent: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=Decimal("100")
    )
    color: Mapped[str | None] = mapped_column(String(7))
    memo: Mapped[str | None] = mapped_column(Text)

    # Optional mapping back to a line in the project's estimate (견적서).
    estimate_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("project_estimate_items.id", ondelete="SET NULL"),
    )
