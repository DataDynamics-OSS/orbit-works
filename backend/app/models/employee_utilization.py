"""임직원 가동율 캐시 — 인사 > 임직원 가동율 메뉴.

매월 (developer × year × month) 단위로 시간 기반 가동율과 수익기여도(비용
기반) 를 미리 계산해 저장한다. 매트릭스 페이지가 이 테이블만 읽어 즉시 응답.

정책:
  - 정규직(`employment_type='FULL_TIME'`) 만 행으로 잡는다 (FREELANCER 는
    monthly_rate ≒ 원가라 항상 1.0, INSOURCED 는 1차 출시 제외).
  - 매일 03:00 cron 이 **이번 달만** 재계산 (`utilization_recompute`).
    안전 윈도우 1개월 — 지난달 retroactive 수정은 수동 POST recompute 로 처리.
  - 백엔드 startup 시 빈 테이블이면 자동으로 올해 1월~현재월 백필.

계산 공식 (services/utilization.py 의 compute_cell 와 동기):
  time_ratio   = allocated_days / workdays                (workdays=0 → NULL)
  cost_ratio   = revenue_contrib / monthly_cost           (cost=0     → NULL)
  workdays     = 월 영업일 − 입사전/퇴사후 − APPROVED leave_requests.days_total
  영업일       = 평일 − holidays(STATUTORY/TEMPORARY/COMPANY)
  allocated_days = Σ_assignments(overlap_workdays × allocation_percent / 100)
  revenue_contrib = Σ_assignments(monthly_rate × overlap_workdays/월영업일 × allocation_percent/100)
  monthly_cost   = (annual_salary / 12) + actual_employer_insurance_monthly  (or estimated)

테이블 RLS:
  - `tenant_iso` 정책 (`backend/sql/rls_policies.sql`) — backend startup 시 자동 적용.
  - INSERT trigger `fn_auto_tenant_id` 가 tenant_id 자동 채움.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class EmployeeUtilizationCell(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """한 (developer × year × month) cell 의 가동율·수익기여도 + breakdown."""

    __tablename__ = "employee_utilization_cells"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "developer_id", "year", "month",
            name="uq_eu_cells",
        ),
    )

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    # 1..12
    month: Mapped[int] = mapped_column(Integer, nullable=False)

    # --- 시간 기반 ---
    # 분모. 그 달 영업일 − 입사전/퇴사후 일수 − APPROVED leave 일수 (반차 0.5 반영).
    # 휴가가 가용일보다 큰 비정상 입력은 0 으로 clamp + services/utilization.py
    # 의 WARNING 으로 기록.
    workdays: Mapped[Decimal] = mapped_column(Numeric(5, 1), nullable=False)
    # 분자. Σ(overlap_workdays × allocation_percent/100). 여러 프로젝트 동시 투입
    # 시 합산 → workdays 초과 가능 (overbook — 프런트 빨강).
    allocated_days: Mapped[Decimal] = mapped_column(
        Numeric(7, 2), nullable=False, default=Decimal("0")
    )
    # = allocated_days / workdays. workdays=0 (그 달 내내 휴직·미입사·퇴사 후) →
    # NULL → 프런트 '-' 표시 ("벤치(0%)" 와 명확히 구분).
    time_ratio: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))

    # --- 수익기여도 (비용 기반) ---
    # 분자. Σ(monthly_rate × overlap_workdays/월영업일 × allocation%) — 그 달에
    # 프로젝트로부터 회사가 부담받은 인건비 단가.
    revenue_contrib: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=Decimal("0")
    )
    # 분모. annual_salary/12 + 회사부담 4대보험 (actual 우선, 없으면 estimated).
    # DeveloperSalary 행이 없으면 0 → cost_ratio NULL.
    monthly_cost: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=Decimal("0")
    )
    # = revenue_contrib / monthly_cost. NULL 사유:
    #   (1) monthly_cost=0 (salary 누락 — recompute 에서 WARNING)
    # 1.0× = 손익분기, > 1.0× 흑자, < 1.0× 적자.
    cost_ratio: Mapped[Decimal | None] = mapped_column(Numeric(8, 4))

    # --- popover breakdown ---
    # 셀 클릭 popover 용 — 프로젝트별 기여 라인. 같은 트랜잭션에 cells 컬럼과
    # 함께 저장되어 항상 정합. shape:
    # [{ "project_id": "uuid", "project_name": "X",
    #    "days": 12.0, "allocation_percent": 100,
    #    "monthly_rate": 7500000, "contrib": 3750000.0 }, ...]
    # Σ(line.days)   = allocated_days
    # Σ(line.contrib) = revenue_contrib
    breakdown_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list
    )

    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
