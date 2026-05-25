"""앱 런타임 설정 (DB 저장 오버라이드).

`config.yaml` 의 각 섹션을 런타임에 덮어쓰는 값. 섹션 단위 JSONB 저장으로
쓰기·읽기 모두 섹션 원자적.

멀티 테넌트:
- `tenant_id IS NULL` = 글로벌 (시스템 공통 — backup/ecos/fred/exchange/announcements)
- `tenant_id = X`     = 그 tenant 의 오버라이드 (slack/mail/auth/scheduler 등)

합성 순서 (뒤가 앞을 덮어씀):
  config.yaml defaults → ENV vars → 글로벌 app_settings (tenant_id IS NULL) → tenant app_settings

부트스트랩/보안 키 (server, database, auth.jwt_*, initial_admin, upload.dir, ...)
는 config.yaml 에만 두고 UI 로는 수정하지 않는다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AppSetting(Base):
    __tablename__ = "app_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # NULL = 글로벌(시스템) — SUPER_ADMIN 만 쓰기. 그 외 = tenant 별 오버라이드.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    # 'scheduler' | 'backup' | 'slack' | 'mail' | 'auth' | 'upload' | ...
    section: Mapped[str] = mapped_column(String(40), nullable=False)
    # 섹션의 editable 필드만 담은 dict. nested 구조는 그대로 중첩 dict 로 저장.
    value: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
