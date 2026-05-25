"""외부 주소록 모델 (고객 · 협력사 공용).

`customers` 테이블에 매핑되는 강결합 주소록. `customer_id` FK 로 회사를 참조하며,
회사가 정해지지 않은 개인 담당자(예: 영업 초기 단계의 잠재 고객)도 다룰 수 있도록
NULL 을 허용한다. 회사명은 더 이상 자유 문자열로 저장하지 않고 항상 customers.name
에서 JOIN 으로 라이브 조회 (드리프트·orphan 차단).

`kind` 로 고객(CUSTOMER) / 협력사(PARTNER) 를 구분. 테이블명은 역사적 이유로
`customer_contacts` 를 유지한다.

설계 포인트:
- ON DELETE SET NULL — 회사 삭제로 담당자 정보가 사라지면 안 됨.
- company_name 컬럼은 의도적으로 폐기. 표시 회사명은 응답 직렬화 시점에
  `customer.name` 을 transient 속성으로 채워 보낸다 (`CustomerContactOut.company_name`).
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CustomerContact(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "customer_contacts"

    # CUSTOMER | PARTNER — 주소록 탭 구분. 기본값 CUSTOMER (레거시 row 호환).
    kind: Mapped[str] = mapped_column(
        String(20), nullable=False, default="CUSTOMER", index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    # 회사 FK — NULL 허용. 회사 삭제 시 SET NULL.
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    # 직함/부서 (예: "차장", "영업본부").
    title: Mapped[str | None] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(50))
    mobile: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))
    memo: Mapped[str | None] = mapped_column(Text)

    # 표시 회사명은 항상 customer.name 에서 JOIN — 컬럼으로 캐싱하지 않음.
    customer = relationship("Customer", foreign_keys=[customer_id], lazy="select")
