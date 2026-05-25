"""Payroll (급여) 모델.

- 월급제 정규직/자사화: mode=PAYROLL — 4대보험 + 근로소득세 (간이세액표) + 지방소득세
- 프리랜서: mode=WITHHOLDING — 3% 원천징수 + 0.3% 지방소득세 (간단 flow)

연말정산 회차(`is_year_end_adjustment=true`) 에서는 year_end_* 컬럼으로 추가징수/환급 반영.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class PayrollRun(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """월별 급여 회차. 회차 단위로 DRAFT → FINAL → PAID 상태 전이."""

    __tablename__ = "payroll_runs"
    __table_args__ = (
        UniqueConstraint("year", "month", name="uq_payroll_runs_year_month"),
    )

    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="DRAFT"
    )  # DRAFT | FINAL | PAID
    pay_date: Mapped[date | None] = mapped_column(Date)
    is_year_end_adjustment: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    memo: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    items: Mapped[list["PayrollItem"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
    )


class PayrollItem(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """회차 × 직원 — AG Grid 의 1행."""

    __tablename__ = "payroll_items"
    __table_args__ = (
        UniqueConstraint("run_id", "developer_id", name="uq_payroll_items_rd"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("payroll_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    developer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # PAYROLL (월급제) | WITHHOLDING (프리랜서 3.3% 원천징수)
    mode: Mapped[str] = mapped_column(String(16), nullable=False, default="PAYROLL")

    # 지급 - 과세
    base_salary: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    position_allowance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    overtime_pay: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    holiday_pay: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    annual_leave_pay: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    family_allowance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    bonus: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    holiday_bonus: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    other_taxable: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    # 지급 - 비과세
    meal_allowance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    car_allowance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    childcare_allowance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    research_allowance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    expense_reimbursement: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    tuition: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    other_nontax: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    # 공제 - 4대보험 (근로자 부담)
    pension: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    health: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    long_term_care: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    employment_insurance: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    # 공제 - 세금
    income_tax: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    local_tax: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    # 연말정산 (환급 시 음수). DECIMAL 로 그대로 저장.
    year_end_income_tax: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    year_end_local_tax: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    other_deduction: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    # 프리랜서 WITHHOLDING 모드 전용
    freelancer_gross: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    # 스냅샷 합계
    gross_taxable: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    gross_nontax: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    total_deduction: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    net_pay: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    memo: Mapped[str | None] = mapped_column(Text)

    run: Mapped["PayrollRun"] = relationship(back_populates="items")


class DeveloperTaxProfile(Base, TenantMixin, TimestampMixin):
    """직원별 세액계산 옵션. 1:1 with developers."""

    __tablename__ = "developer_tax_profile"

    developer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # 간이세액표 공제대상 가족수 (본인 포함).
    dependents_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    # 70세 이상 부양가족 (추가공제 반영용, 향후).
    elderly_dependents_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    # 만 20세 이하 자녀 수 (간이세액표 선택 옵션용).
    child_dependents_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    # 80 / 100 / 120% 선택. 기본 100%.
    tax_reduction_rate: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=100)


class WithholdingTaxTable(Base, UUIDMixin, TenantMixin):
    """간이세액표 업로드 회차 (효력시점 버전관리).

    회차별 `withholding_tax_rows` 를 가지며, pay_date ≥ effective_from 중
    가장 최신 effective_from 을 가진 table 을 적용.
    """

    __tablename__ = "withholding_tax_tables"

    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(255))
    note: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    rows: Mapped[list["WithholdingTaxRow"]] = relationship(
        back_populates="table",
        cascade="all, delete-orphan",
    )


class WithholdingTaxRow(Base, UUIDMixin, TenantMixin):
    """간이세액표 개별 행 (월급 구간 × 부양가족수)."""

    __tablename__ = "withholding_tax_rows"

    table_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("withholding_tax_tables.id", ondelete="CASCADE"),
        nullable=False,
    )
    # 월급(과세소득) 구간 — [min, max) KRW. 국세청 표 기준.
    bracket_min: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    bracket_max: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    dependents: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    tax_80: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    tax_100: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    tax_120: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)

    table: Mapped["WithholdingTaxTable"] = relationship(back_populates="rows")


class PayrollDistribution(Base, UUIDMixin, TenantMixin):
    """명세서 배포 이력 — 재시도/실패 로깅 용도."""

    __tablename__ = "payroll_distributions"

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("payroll_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    developer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
    )
    method: Mapped[str] = mapped_column(String(16), nullable=False, default="EMAIL")  # EMAIL|DOWNLOAD
    to_email: Mapped[str | None] = mapped_column(String(200))
    pdf_size_bytes: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="SENT")  # SENT|FAILED
    error_msg: Mapped[str | None] = mapped_column(Text)
    delivered_at: Mapped[date | None] = mapped_column(Date)
    delivered_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
