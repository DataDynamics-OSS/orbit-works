"""임직원 비상연락처 (1:N).

UI 에선 2 슬롯 (`position` 0, 1) 만 노출. 모델 자체는 N 개 허용해 향후
"가족 / 친구 / 회사 동료" 등으로 확장 여지 둠.

권한: 본인 / HR / ADMIN / SUPER_ADMIN — 여권정보와 동일.
"""

from uuid import UUID

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class DeveloperEmergencyContact(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "developer_emergency_contacts"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    name: Mapped[str | None] = mapped_column(String(100))
    relation: Mapped[str | None] = mapped_column(String(50))
    phone: Mapped[str | None] = mapped_column(String(50))
