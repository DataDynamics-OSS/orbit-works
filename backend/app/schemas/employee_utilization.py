"""EmployeeUtilization — 매트릭스 응답 + recompute 요청 스키마.

GET 응답은 행렬 형태:
  - `months` 헤더 배열
  - `rows` — 임직원별, 각 row 는 month-cells 배열을 가짐
  - `summary` — 회사 평균·벤치 인원수 (탑 헤더 카드용)
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# 요청 파라미터
# ---------------------------------------------------------------------------


Scope = Literal["me", "team", "all"]
Mode = Literal["time", "cost"]


class RecomputeRequest(BaseModel):
    """수동 recompute body. months 단위 기간 (둘 다 inclusive)."""

    year_from: int = Field(..., ge=2000, le=2100)
    month_from: int = Field(..., ge=1, le=12)
    year_to: int = Field(..., ge=2000, le=2100)
    month_to: int = Field(..., ge=1, le=12)


# ---------------------------------------------------------------------------
# 응답
# ---------------------------------------------------------------------------


class BreakdownEntry(BaseModel):
    """셀 popover 한 줄 — 어떤 프로젝트에 며칠/얼만큼 배정됐는가."""

    project_id: UUID
    project_name: str
    # 그 달 안에서 해당 assignment 와 겹친 영업일 수 (소수점 0).
    days: float
    # assignment.allocation_percent 그대로 (보통 0..100, 가끔 그 이상).
    allocation_percent: float
    # 프로젝트에 부담된 인건비 단가 (월) — 정보 표시용.
    monthly_rate: float
    # 이 라인의 수익기여도 분자 기여분 — Σ 가 cell.revenue_contrib 와 일치.
    contrib: float


class CellOut(BaseModel):
    """매트릭스 한 칸."""

    month: str                         # "YYYY-MM"
    workdays: float                    # 분모 — 휴가·입사전/퇴사후 차감 후
    allocated_days: float              # 시간 기반 분자
    time_ratio: float | None           # workdays=0 이면 None
    revenue_contrib: float
    monthly_cost: float
    cost_ratio: float | None           # cost=0 이면 None
    breakdown: list[BreakdownEntry] = Field(default_factory=list)


class DeveloperHeader(BaseModel):
    id: UUID
    name: str
    rank_name: str | None = None
    position_name: str | None = None
    hire_date: date | None = None
    resigned_date: date | None = None


class RowOut(BaseModel):
    """임직원 한 행 — `cells` 는 `months` 와 같은 순서·길이."""

    developer: DeveloperHeader
    cells: list[CellOut]
    # 기간 평균 — None 셀(분모=0) 은 평균에서 제외.
    avg_time_ratio: float | None = None
    avg_cost_ratio: float | None = None


class SummaryOut(BaseModel):
    """헤더 카드용 회사 단위 집계."""

    # months 와 같은 순서·길이. 정규직 평균.
    company_avg_time_by_month: list[float | None]
    company_avg_cost_by_month: list[float | None]
    headcount_by_month: list[int]        # 그 달에 1일 이상 가용일이 있던 정규직 수
    bench_count_by_month: list[int]      # time_ratio == 0 인 사람 수


class MatrixOut(BaseModel):
    """매트릭스 응답 전체."""

    months: list[str]                     # ["2026-01", "2026-02", ...]
    scope: Scope
    mode: Mode
    rows: list[RowOut]
    summary: SummaryOut

    model_config = ConfigDict(from_attributes=True)


class RecomputeResult(BaseModel):
    """recompute 결과 — 운영자 확인용."""

    tenant_id: UUID
    cells_upserted: int
    duration_ms: int
    months_covered: list[str]
