"""임직원 평가 — Pydantic 스키마.

응답 visibility 는 API 가드(권한별)로 None 처리. 본인이 본인 평가 조회 시
manager_* / final_* 는 FINALIZED 후에만 채워서 내보냄. calibration_note 는
HR/ADMIN 전용.
"""

from __future__ import annotations

from datetime import date as date_cls, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

CycleStatus = Literal["DRAFT", "OPEN", "CALIBRATING", "CLOSED"]
EvalStatus = Literal[
    "NOT_STARTED",
    "SELF_DRAFT",
    "SELF_SUBMITTED",
    "MGR_DRAFT",
    "MGR_SUBMITTED",
    "CALIBRATED",
    "FINALIZED",
]
Period = Literal["1H", "2H"]
Grade = Literal["S", "A", "B", "C", "D"]


# ---------------------------------------------------------------------------
# Cycle
# ---------------------------------------------------------------------------


class CycleBase(BaseModel):
    year: int = Field(ge=2000, le=2100)
    period: Period
    name: str = Field(min_length=1, max_length=120)
    start_date: date_cls
    end_date: date_cls
    self_due: date_cls
    manager_due: date_cls
    finalize_due: date_cls


class CycleCreate(CycleBase):
    pass


class CycleUpdate(BaseModel):
    """DRAFT 상태에서만 적용. OPEN 이후엔 deadline 외 변경 막음 (서비스 가드)."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    start_date: date_cls | None = None
    end_date: date_cls | None = None
    self_due: date_cls | None = None
    manager_due: date_cls | None = None
    finalize_due: date_cls | None = None


class CycleOut(CycleBase):
    id: UUID
    status: CycleStatus
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    # row 자동 생성 결과 통계 (요약 표시용 — open 후에만 의미 있음).
    evaluation_count: int = 0
    submitted_count: int = 0   # MGR_SUBMITTED 이상
    finalized_count: int = 0   # FINALIZED 만

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Competency Dimension
# ---------------------------------------------------------------------------


class DimensionUpsert(BaseModel):
    key: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=80)
    description: str | None = None
    sort_order: int = 0
    active: bool = True


class DimensionsBulkUpsert(BaseModel):
    """ADMIN 이 양식 전체를 한 번에 저장 — drift 회피."""

    items: list[DimensionUpsert]


class DimensionOut(DimensionUpsert):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Evaluation — competency / goal summary / row / detail
# ---------------------------------------------------------------------------


class CompetencyScoreOut(BaseModel):
    dimension_key: str
    self_score: int | None = None
    manager_score: int | None = None
    final_score: int | None = None
    self_comment: str | None = None
    manager_comment: str | None = None
    final_comment: str | None = None

    class Config:
        from_attributes = True


class CompetencyScoreInput(BaseModel):
    """Self / Manager / Calibration stage 가 dimension 별 자기 컬럼만 update.

    stage='self'        → self_score / self_comment
    stage='manager'     → manager_score / manager_comment
    stage='calibration' → final_score / final_comment
    """

    dimension_key: str
    score: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = None


class EvaluationGoalSummary(BaseModel):
    """cycle 기간 안의 PERSONAL goal 자동 집계 (참고용)."""

    count: int = 0
    completed: int = 0
    avg_progress: float = 0.0           # 0~100
    sum_self_score: float = 0.0         # goal.self_score 합 (0~150 단위)
    sum_manager_score: float = 0.0
    # progress_pct 선형 변환 (0%→1.0, 100%→5.0). UI 의 prefill 값.
    prefill_score: float = 1.0


class CompetencyScoreLite(BaseModel):
    """카드 안 mini 게이지용 — 코멘트 미포함, 점수만. payload 절감."""
    dimension_key: str
    self_score: int | None = None
    manager_score: int | None = None
    final_score: int | None = None

    class Config:
        from_attributes = True


class EvaluationRowOut(BaseModel):
    """목록용 — narrative 미포함 (payload 절감). dimension 점수는 카드 안
    미니 게이지에서 쓰므로 lite 형태로 포함."""

    id: UUID
    cycle_id: UUID
    developer_id: UUID
    developer_name: str | None = None
    manager_id: UUID | None = None
    manager_name: str | None = None
    status: EvalStatus
    final_grade: Grade | None = None
    final_overall_score: Decimal | None = None
    self_submitted_at: datetime | None = None
    manager_submitted_at: datetime | None = None
    finalized_at: datetime | None = None
    # 조회자 권한 컨텍스트 — 버튼 노출 가드용.
    can_self: bool = False         # 본인이 self 입력 가능한지
    can_manager: bool = False      # 매니저가 manager 입력 가능한지
    can_calibrate: bool = False    # HR 가 calibration 가능한지
    competencies: list[CompetencyScoreLite] = Field(default_factory=list)
    # 직위(rank) — 카드 그룹핑·정렬용. NULL 은 "(직위 미지정)" 그룹.
    rank_id: UUID | None = None
    rank_name: str | None = None
    rank_sort_order: int | None = None
    updated_at: datetime

    class Config:
        from_attributes = True


class EvaluationOut(EvaluationRowOut):
    """상세 — 본문·역량·목표 통계 포함. visibility 가드된 필드는 None 일 수 있음."""

    self_narrative: str | None = None
    manager_narrative: str | None = None
    calibration_note: str | None = None
    goal_score_self: Decimal | None = None
    goal_score_manager: Decimal | None = None
    goal_score_final: Decimal | None = None
    competency_avg_self: Decimal | None = None
    competency_avg_manager: Decimal | None = None
    competency_avg_final: Decimal | None = None
    competencies: list[CompetencyScoreOut] = Field(default_factory=list)
    goal_summary: EvaluationGoalSummary | None = None


# ---------------------------------------------------------------------------
# Stage payloads — PATCH /self · /manager · /calibrate
# ---------------------------------------------------------------------------


class SelfPayload(BaseModel):
    self_narrative: str | None = None
    goal_score_self: Decimal | None = Field(
        default=None, ge=Decimal("1.0"), le=Decimal("5.0"),
    )
    competencies: list[CompetencyScoreInput] = Field(default_factory=list)


class ManagerPayload(BaseModel):
    manager_narrative: str | None = None
    goal_score_manager: Decimal | None = Field(
        default=None, ge=Decimal("1.0"), le=Decimal("5.0"),
    )
    competencies: list[CompetencyScoreInput] = Field(default_factory=list)


class CalibratePayload(BaseModel):
    calibration_note: str | None = None
    goal_score_final: Decimal | None = Field(
        default=None, ge=Decimal("1.0"), le=Decimal("5.0"),
    )
    final_overall_score: Decimal | None = Field(
        default=None, ge=Decimal("1.0"), le=Decimal("5.0"),
    )
    final_grade: Grade | None = None
    competencies: list[CompetencyScoreInput] = Field(default_factory=list)
