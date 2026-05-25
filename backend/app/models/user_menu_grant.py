"""사용자별 메뉴 부여 (user_menu_grants).

`menu_permissions` 가 role 단위 매트릭스를 다룬다면, 이 테이블은 **개별 user**
에게 특정 메뉴를 추가로 노출한다. 예: SALES role 김부장에게만 "주간보고" 메뉴를
보이고 싶을 때 — 전사 role 매트릭스를 건드리지 않고 사람 단위로 부여.

사이드바 필터 = `menu_permissions[role].includes(key) || user_menu_grants(me).includes(key)`
즉 단순 OR. 부정(빼앗기) 은 1차에서는 지원하지 않는다.

부여는 ADMIN/SUPER_ADMIN/HR. 본인 grants 조회는 모든 user 허용.

스키마는 `user_feature_grants` 와 1:1 동형 (feature_key → menu_key).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserMenuGrant(Base):
    """tenant 별 (user_id, menu_key) 부여. 복합 PK."""

    __tablename__ = "user_menu_grants"

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
    # 프런트 menu-registry · 백엔드 menu_permissions DEFAULT 의 menu key 와 일치.
    menu_key: Mapped[str] = mapped_column(String(64), primary_key=True)

    granted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
