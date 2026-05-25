"""기능별 역할 권한 매핑 (feature_permissions).

페이지 안의 세부 기능(버튼·필드·탭)에 대한 role 별 허용 여부.

`menu_permissions` 가 페이지 단위 노출을 제어한다면, 이 테이블은
한 페이지 안의 개별 동작을 더 잘게 통제한다. 예:
- `employees.salary.view` — 급여 컬럼 조회
- `employees.password.reset` — 비밀번호 재설정 버튼
- `employees.tab.passport` — 여권 정보 탭 노출

스키마는 `MenuPermission` 과 동일 구조 (`tenant_id × feature_key × role` 복합 PK).
ADMIN 은 암묵 허용이라 저장하지 않는다.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class FeaturePermission(Base):
    """tenant 별 feature_key×role 매핑. PK 는 (tenant_id, feature_key, role) 복합."""

    __tablename__ = "feature_permissions"

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        primary_key=True,
        index=True,
    )
    # 프런트 `feature-registry.ts` 와 백엔드 `DEFAULT_FEATURE_PERMISSIONS` 의 키와 일치.
    feature_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    # SALES | HR | SUPPORT | ETC — ADMIN 은 저장 대상 아님 (암묵 허용).
    role: Mapped[str] = mapped_column(String(16), primary_key=True)
