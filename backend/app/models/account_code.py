"""계정과목 (account_codes) — 수입·지출 항목 마스터.

연간 예산 수립 / 실적 매핑 / 결산 P&L / 현금흐름표의 토대가 되는 정의 테이블.
- kind = INCOME | EXPENSE
- category 는 자유 입력 (varchar) — 표준안은 프론트 select 의 권장 enum 으로만 안내
- account_code / account_name 은 한국 회계 표준(K-GAAP SME) 매핑(선택)
- is_pl=true → P&L 합산. false → 자본·자산·부채 거래 (대출원금/펀드/임직원대여 등)
"""

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class AccountCode(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "account_codes"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "kind", "category", "name", name="uq_account_code"
        ),
    )

    # 'INCOME' | 'EXPENSE'
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    # 자유 입력 — 권장 enum 은 프론트에서 안내
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # 비고 — 짧은 부제·키워드 (한 줄)
    description: Mapped[str | None] = mapped_column(Text)
    # 사용 지침 — 비전문가용 안내 (무엇·언제·의미). 길게 작성 가능.
    usage_guide: Mapped[str | None] = mapped_column(Text)

    # 회계 매핑 (선택)
    account_code: Mapped[str | None] = mapped_column(String(10))
    account_name: Mapped[str | None] = mapped_column(String(50))

    # P&L 합산 대상 여부 — false 면 현금흐름엔 잡히지만 손익 계산엔 제외
    is_pl: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
