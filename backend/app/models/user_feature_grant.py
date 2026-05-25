"""사용자별 기능 부여 (user_feature_grants).

`feature_permissions` 가 role 단위 매트릭스를 다룬다면, 이 테이블은 **개별 user**
에게 추가 권한을 부여한다. 예: SALES role 인 김부장에게만 주간보고 전체 조회
허용 — role 을 ADMIN 으로 올리지 않고도 특정 기능 한정으로 위임 가능.

권한 부여 자체는 ADMIN/SUPER_ADMIN 만 수행. 사용 가능한 feature_key 는
`app.core.grantable_features.KNOWN_GRANTABLE_FEATURES` 카탈로그에 등록된 키로
제한 (typo 방지).

스키마는 `feature_permissions` 와 비슷하지만 role 대신 user_id 가 PK 의 일부.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserFeatureGrant(Base):
    """tenant 별 (user_id, feature_key) 부여. 복합 PK."""

    __tablename__ = "user_feature_grants"

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        primary_key=True,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    # 프런트 grantable feature 카탈로그 + 백엔드 KNOWN_GRANTABLE_FEATURES 와 일치.
    feature_key: Mapped[str] = mapped_column(String(64), primary_key=True)

    # audit — 누가 언제 부여했는지. user 삭제 시 grant 자체는 유지 (granted_by 만 NULL).
    granted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
