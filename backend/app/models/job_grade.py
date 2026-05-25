"""직위(JobRank) + 직책(JobPosition) 마스터.

- **직위(Rank)** — 모든 임직원이 1개씩 보유. 결재선의 기본 hierarchy.
  예: 연구원 → 주임/선임/책임/수석연구원 → 이사 → 상무/전무 → 부대표 → 대표이사.
- **직책(Position)** — 임직원이 선택적으로 보유 (NULL 허용).
  예: 파트장 / 팀장 / 본부장 / CEO 등.

두 모델은 동일 구조(name + level + is_active + sort_order). 결재 룰이
`rank.level ≥ N` 또는 `position.name in [...]` 식으로 라우팅에 사용.
level 은 NUMERIC 으로 사이 무제한 삽입 가능.
"""

from decimal import Decimal

from sqlalchemy import Boolean, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class JobRank(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """직위 — 모든 임직원이 1개씩 보유하는 career grade."""

    __tablename__ = "job_ranks"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_job_ranks_tenant_name"),
    )

    name: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    level: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 진급 기준 연차 — 「직위별 총 경력 분포」 차트의 가이드 라인 (rank 가
    # 1차 사용처). 직책에도 컬럼은 동일 보유 (스키마 통일). NULL = 차트
    # 미표시.
    years: Mapped[int | None] = mapped_column(Integer)


class JobPosition(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """직책 — 선택적 job role (팀장/본부장/CEO 등)."""

    __tablename__ = "job_positions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_job_positions_tenant_name"),
    )

    name: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    level: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 진급 기준 연차 — 「직위별 총 경력 분포」 차트의 가이드 라인 (rank 가
    # 1차 사용처). 직책에도 컬럼은 동일 보유 (스키마 통일). NULL = 차트
    # 미표시.
    years: Mapped[int | None] = mapped_column(Integer)
