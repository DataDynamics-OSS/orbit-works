from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class DeveloperSalary(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """Salary history for an employee.

    The salary effective on a given date is the row with the greatest
    ``effective_from`` that is ``<= date`` for the same ``developer_id``.
    """

    __tablename__ = "developer_salaries"
    __table_args__ = (
        UniqueConstraint(
            "developer_id", "effective_from", name="uq_dev_salary_effective"
        ),
    )

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    annual_salary: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    # Open-ended when NULL (i.e. the period is ongoing).
    effective_to: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text)

    # 예상 4대보험 (연봉 + 등록 시점 요율로 계산, 월 기준)
    estimated_employee_insurance_monthly: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2)
    )
    estimated_employer_insurance_monthly: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2)
    )
    # 실제 지급 4대보험 (관리자 입력, 월 기준)
    actual_employee_insurance_monthly: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2)
    )
    actual_employer_insurance_monthly: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2)
    )
    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class HrInsuranceRate(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """Social-insurance rate snapshot for employer contribution.

    The rate set applicable on a given date is the row with the greatest
    ``effective_from`` that is ``<= date``.
    """

    __tablename__ = "hr_insurance_rates"

    effective_from: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False)

    national_pension_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), nullable=False)
    national_pension_ceiling: Mapped[int] = mapped_column(Integer, nullable=False)
    national_pension_floor: Mapped[int | None] = mapped_column(Integer)

    health_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), nullable=False)
    long_term_care_rate_on_health: Mapped[Decimal] = mapped_column(
        Numeric(6, 4), nullable=False
    )

    employment_unemployment_rate: Mapped[Decimal] = mapped_column(
        Numeric(6, 4), nullable=False
    )
    employment_stability_rate: Mapped[Decimal] = mapped_column(
        Numeric(6, 4), nullable=False
    )

    industrial_accident_rate: Mapped[Decimal] = mapped_column(
        Numeric(6, 4), nullable=False
    )

    company_size_tier: Mapped[str | None] = mapped_column(String(30))
    industry_note: Mapped[str | None] = mapped_column(Text)

    updated_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
