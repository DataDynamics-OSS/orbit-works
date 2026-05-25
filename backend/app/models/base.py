import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column


class Base(DeclarativeBase):
    pass


class UUIDMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class TenantMixin:
    """멀티 테넌트 격리 — 모든 도메인 모델이 적용한다.

    `tenant_id` 는 NOT NULL. INSERT 시 tenant_id 미지정이면 SQLAlchemy
    before_flush 이벤트(`app.core.tenant_listener`) 가 ContextVar 의
    current_tenant_id 로 자동 채움.

    PostgreSQL RLS 가 이 컬럼으로 자동 필터 (`tenant_iso` 정책 — db.sql 참고).

    참고: 이 컬럼은 *비정규화* 다 — 자식 테이블도 부모 tenant 와 동일한 값을
    중복 보유. RLS 정책을 모든 테이블에 균일하게 적용하기 위함.
    """

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(
            UUID(as_uuid=True),
            ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        )
