from decimal import Decimal
from uuid import UUID

from sqlalchemy import ForeignKey, Integer, Numeric, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class ProjectEstimateItem(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """프로젝트 견적서 라인아이템.

    합계는 저장하지 않는다. 표시 시 unit_rate × months × (1 − discount/100).
    """

    __tablename__ = "project_estimate_items"

    project_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    grade: Mapped[str] = mapped_column(String(20), nullable=False, default="MID")
    unit_rate: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    months: Mapped[Decimal] = mapped_column(Numeric(6, 2), nullable=False, default=1)
    discount_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
