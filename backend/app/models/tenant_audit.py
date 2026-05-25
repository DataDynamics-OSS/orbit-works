"""SUPER_ADMIN 의 tenant 관리 액션 자동 기록.

운영 사고 발생 시 "누가 언제 어느 tenant 만졌나" 추적용. RLS 미적용
(super admin 만 봄). 외래키는 RESTRICT — tenant 삭제는 정책상 soft delete 만
허용하므로 actual DELETE 는 없을 거고 audit 는 영속.
"""

from uuid import UUID

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class TenantAudit(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "tenant_audit"

    actor_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    tenant_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="SET NULL"),
        nullable=True,
    )
    action: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
