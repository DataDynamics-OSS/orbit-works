"""운영 예산 계획 — 연도별 12개월 지출 예산.

- budget_calc_plans  : 예산서(연도·제목·메모)
- budget_calc_lines  : 비목(account_code_id, EXPENSE) + m1~m12 월별 금액
                       amount_total = m1+...+m12 (frontend 에서 합산)
- 비목 그룹핑은 account_codes.category 로 (UI 에서 카테고리별 소계)
- 단위: 그리드 표시 천원, DB 저장 원
"""

import uuid

from sqlalchemy import ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class BudgetCalcPlan(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "budget_calc_plans"

    year: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    memo: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    lines: Mapped[list["BudgetCalcLine"]] = relationship(
        back_populates="plan",
        cascade="all, delete-orphan",
        order_by="BudgetCalcLine.sort_order",
        passive_deletes=True,
    )


class BudgetCalcLine(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "budget_calc_lines"

    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("budget_calc_plans.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 비목 — account_codes (EXPENSE) 참조. 삭제되면 SET NULL (라인은 유지).
    account_code_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("account_codes.id", ondelete="SET NULL"),
    )
    # 자유 입력 라벨 — 같은 비목 내 세분(예: "정규직 급여" / "프리랜서 급여")
    item_label: Mapped[str | None] = mapped_column(String(200))

    # 월별 금액 — 매월/연1회/특정월/분기 어떤 패턴이든 표현 가능
    m1: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m2: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m3: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m4: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m5: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m6: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m7: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m8: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m9: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m10: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m11: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    m12: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    note: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    plan: Mapped["BudgetCalcPlan"] = relationship(back_populates="lines")
