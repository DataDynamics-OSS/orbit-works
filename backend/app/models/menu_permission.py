"""메뉴별 역할 권한 매핑 (menu_permissions).

Sidebar 메뉴의 표시 여부를 역할(ROLE) 별로 제어한다.

스키마 선택 근거:
- `(menu_key, role)` 복합 PK — 한 메뉴에 허용되는 역할 집합을 'row 집합' 으로
  표현. 삭제/추가가 단순한 INSERT/DELETE 로 해결되고, 부분 실패 시에도
  고아 row 가 남지 않는다.
- 값 컬럼(`is_enabled` 등) 을 두지 않는 이유: 허용/비허용을 row 유무로만 표현해
  삭제 연산이 그 자체로 권한 회수 의미를 갖는다.

ADMIN 은 프런트 가드에서 항상 모든 메뉴를 볼 수 있으므로 이 테이블에 저장하지
않는다. 저장 API (`PUT /menu-permissions`) 는 ADMIN 입력을 조용히 필터링한다.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MenuPermission(Base):
    """tenant 별 menu_key×role 매핑. PK 는 (tenant_id, menu_key, role) 복합."""

    __tablename__ = "menu_permissions"

    # tenant 별 격리. TenantMixin 대신 직접 PK 일부로 둔다.
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        primary_key=True,
        index=True,
    )
    # 프런트 `menu-registry.ts` 와 백엔드 `DEFAULT_MENU_PERMISSIONS` 의 키와 일치.
    menu_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    # SALES | HR | SUPPORT | ETC — ADMIN 은 저장 대상 아님 (암묵 허용).
    role: Mapped[str] = mapped_column(String(16), primary_key=True)
