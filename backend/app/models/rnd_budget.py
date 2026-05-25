"""정부 R&D 예산 — 예산서(plan) + 입력 라인(line).

연도·프로젝트별 다중 예산서 관리. 비목·세목 label 은 라인에 스냅샷으로 저장
(시드 label 변경 시 과거 예산서 영향 없게).
"""

import uuid

from sqlalchemy import ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class RndBudgetPlan(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "rnd_budget_plans"

    year: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        index=True,
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    funding_agency: Mapped[str | None] = mapped_column(String(80))  # TIPA/IITP/KEIT
    total_amount: Mapped[float] = mapped_column(
        Numeric(14, 2), nullable=False, default=0
    )
    # 예산 요약 — 기업규모 + 총 연구개발비 4 분할
    company_size: Mapped[str | None] = mapped_column(String(8))  # SMALL/MID/LARGE
    total_rnd_budget: Mapped[float | None] = mapped_column(Numeric(14, 2))
    gov_funding_amount: Mapped[float | None] = mapped_column(Numeric(14, 2))
    own_cash_amount: Mapped[float | None] = mapped_column(Numeric(14, 2))
    own_inkind_amount: Mapped[float | None] = mapped_column(Numeric(14, 2))
    # 비율 사용자 정의 (null = 기업규모 default 사용). Option A:
    # gov_funding_rate 만 사용자 입력, own_burden_rate = 1 - gov_funding_rate 로 자동 도출.
    # cash_min_rate 는 기관부담금 內 현금 최소 비율(독립 입력).
    gov_funding_rate: Mapped[float | None] = mapped_column(Numeric(5, 4))
    own_burden_rate: Mapped[float | None] = mapped_column(Numeric(5, 4))
    cash_min_rate: Mapped[float | None] = mapped_column(Numeric(5, 4))
    # 현물 비율 — 보통 현금에서 자동 도출(1 - cash) 이지만, 둘 다 0% 같은
    # 비표준 케이스를 위해 별도 저장. null = 현금 기준 자동.
    inkind_min_rate: Mapped[float | None] = mapped_column(Numeric(5, 4))
    memo: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="DRAFT")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    lines: Mapped[list["RndBudgetLine"]] = relationship(
        back_populates="plan",
        cascade="all, delete-orphan",
        order_by="RndBudgetLine.sort_order",
        passive_deletes=True,
    )
    personnel: Mapped[list["RndBudgetPersonnel"]] = relationship(
        back_populates="plan",
        cascade="all, delete-orphan",
        order_by="RndBudgetPersonnel.sort_order",
        passive_deletes=True,
    )


class RndBudgetLine(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "rnd_budget_lines"

    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rnd_budget_plans.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 시드의 비목·세목 id (예: "personnel" / "personnel-salary")
    category_id: Mapped[str] = mapped_column(String(40), nullable=False)
    category_label: Mapped[str] = mapped_column(String(60), nullable=False)
    subcategory_id: Mapped[str] = mapped_column(String(60), nullable=False)
    subcategory_label: Mapped[str] = mapped_column(String(80), nullable=False)
    # 시드의 항목 id (depth-3 — 운영비 일부 세목에만 존재)
    item_id: Mapped[str | None] = mapped_column(String(80))
    # 항목명 — 시드 items 가 있으면 select 결과, 없으면 자유 입력
    item_label: Mapped[str | None] = mapped_column(String(200))
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    quantity: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    amount: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    note: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    plan: Mapped["RndBudgetPlan"] = relationship(back_populates="lines")


class RndBudgetPersonnel(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """인건비 인력 — 보수 행을 채우기 위한 인력별 입력.

    segment = EXISTING(기존 정규직) / NEW(신규 - 입사 6개월 이내 또는 미입사).
    각 인력의 연간 총 보수 = (월급여 + 월 4대보험) × 12 + 연간퇴직금.
    투입 금액 = (연간 총 보수 / 12) × months × ratio_pct/100.
    """

    __tablename__ = "rnd_budget_personnel"

    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rnd_budget_plans.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    segment: Mapped[str] = mapped_column(String(16), nullable=False)  # EXISTING|NEW
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    role: Mapped[str | None] = mapped_column(String(80))
    monthly_salary: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    monthly_insurance: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    severance_annual: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    months: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    ratio_pct: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    plan: Mapped["RndBudgetPlan"] = relationship(back_populates="personnel")
