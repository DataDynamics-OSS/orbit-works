"""목표 시스템 스키마."""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


GoalScope = Literal["PERSONAL", "COMPANY"]
GoalCategory = Literal[
    "BUSINESS", "TECH", "CAREER", "OPERATIONS", "PERSONAL_GROWTH", "OTHER"
]
GoalPriority = Literal["HIGH", "MEDIUM", "LOW"]
GoalDifficulty = Literal["ROUTINE", "NORMAL", "CHALLENGING", "STRETCH"]
GoalStatus = Literal[
    "DRAFT", "IN_PROGRESS", "AT_RISK", "DONE", "DROPPED"
]
GoalGrade = Literal["S", "A", "B", "C", "D"]


class GoalBase(BaseModel):
    scope: GoalScope
    year: int = Field(ge=2024, le=2099)
    owner_id: UUID | None = None
    parent_goal_id: UUID | None = None
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    category: GoalCategory = "BUSINESS"
    priority: GoalPriority = "MEDIUM"
    difficulty: GoalDifficulty = "NORMAL"
    status: GoalStatus = "DRAFT"
    progress_pct: Decimal = Field(default=Decimal("0"), ge=0, le=200)  # >100 = 초과 달성
    due_date: date | None = None

    @model_validator(mode="after")
    def _check_owner_scope(self):
        if self.scope == "PERSONAL" and self.owner_id is None:
            raise ValueError("PERSONAL 목표는 owner_id 필수")
        if self.scope == "COMPANY" and self.owner_id is not None:
            # 회사 목표는 소유자 없음 (운영 주체는 HR/ADMIN).
            raise ValueError("COMPANY 목표는 owner_id 를 비워야 합니다")
        return self


class GoalCreate(GoalBase):
    pass


class GoalUpdate(BaseModel):
    """편집 시 일부 필드만 변경. scope/owner_id 변경은 금지."""

    parent_goal_id: UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    category: GoalCategory | None = None
    priority: GoalPriority | None = None
    difficulty: GoalDifficulty | None = None
    status: GoalStatus | None = None
    progress_pct: Decimal | None = Field(default=None, ge=0, le=200)
    due_date: date | None = None


class GoalScoreInput(BaseModel):
    """자기/매니저 평가 입력 — score 0~150."""

    score: Decimal = Field(ge=0, le=150)
    comment: str | None = None


class GoalScoreOut(BaseModel):
    """목표별 자동 점수 breakdown."""

    auto_score: float            # adjusted progress (= progress × difficulty_factor)
    weight: float                # priority × category 가중치
    difficulty_factor: float
    priority_weight: int
    category_weight: float


class GoalOut(BaseModel):
    id: UUID
    scope: GoalScope
    year: int
    owner_id: UUID | None = None
    owner_name: str | None = None
    parent_goal_id: UUID | None = None
    parent_title: str | None = None
    title: str
    description: str | None = None
    category: GoalCategory
    priority: GoalPriority
    difficulty: GoalDifficulty
    status: GoalStatus
    progress_pct: Decimal
    due_date: date | None = None
    # 평가 점수.
    self_score: Decimal | None = None
    self_score_comment: str | None = None
    manager_score: Decimal | None = None
    manager_score_comment: str | None = None
    manager_score_by_id: UUID | None = None
    manager_score_by_name: str | None = None
    manager_score_at: datetime | None = None
    # 자동 계산 score breakdown — server side computed.
    auto_score: GoalScoreOut | None = None
    created_at: datetime
    updated_at: datetime
    # 권한 hint — UI 가 편집 button disable 등에 사용.
    can_edit: bool = False
    can_score_self: bool = False
    can_score_manager: bool = False

    class Config:
        from_attributes = True


class TotalScoreOut(BaseModel):
    """집계 — 한 owner 또는 한 set 의 종합 점수."""

    total: float          # 0~200 가중평균 (200 = 모든 STRETCH 100% 달성)
    grade: GoalGrade
    goal_count: int
    by_priority: dict[str, float]   # 우선순위별 평균 (HIGH/MEDIUM/LOW)
    by_category: dict[str, float]   # 분류별 평균
    by_difficulty: dict[str, int]   # 난이도별 건수
    # 가중치 하한 적용 정보 — baseline 미설정이면 모두 None.
    weight_sum: float | None = None             # 실제 Σweight
    min_total_weight: float | None = None       # 적용된 하한 (없으면 None)
    floor_applied: bool = False                 # 분모가 하한으로 고정됐는지
    min_goal_count: int | None = None           # 권장 최소 목표 수 (안내용)


class GoalScoreBaselineIn(BaseModel):
    """연도별 가중치 하한 등록/수정."""

    year: int = Field(ge=2024, le=2099)
    min_total_weight: Decimal = Field(gt=0, le=999999)
    min_goal_count: int | None = Field(default=None, ge=0, le=100)
    note: str | None = None


class GoalScoreBaselineOut(BaseModel):
    id: UUID
    year: int
    min_total_weight: Decimal
    min_goal_count: int | None = None
    note: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TeamOverviewSummary(BaseModel):
    total_developers: int
    with_active_goals: int
    avg_score: float
    at_risk_developers: int
    overdue_developers: int


class TeamOverviewGoal(BaseModel):
    """직원 현황 PDF 용 mini goal — 보고서에 직원별 목표 진척도 표시."""

    id: UUID
    title: str
    category: GoalCategory
    priority: GoalPriority
    difficulty: GoalDifficulty
    status: GoalStatus
    progress_pct: Decimal
    due_date: date | None = None


class TeamOverviewDeveloper(BaseModel):
    id: UUID
    name: str
    tag: str | None = None
    title: str | None = None
    employment_type: str
    goal_count: int           # 전체 PERSONAL goal (DONE/DROPPED 포함)
    active_goal_count: int    # 진행 중 (NOT DONE/DROPPED)
    score: float              # 종합 점수 (0~200)
    grade: GoalGrade
    at_risk_count: int
    overdue_count: int
    done_count: int
    goals: list[TeamOverviewGoal] = []


class TeamOverviewOut(BaseModel):
    year: int
    summary: TeamOverviewSummary
    developers: list[TeamOverviewDeveloper]


class AssignmentCandidate(BaseModel):
    """할당 combo 후보 — id/이름/직책/tag 만 노출."""

    id: UUID
    name: str
    tag: str | None = None
    title: str | None = None
    is_self: bool = False   # 본인이면 true (UI 정렬·라벨 강조용)


class DistributionStats(BaseModel):
    avg: float
    median: float
    min: float
    max: float


class DistributionOut(BaseModel):
    """전 직원 점수 분포 — 본인이 자기 위치를 보기 위한 익명 데이터.

    scores 는 이름 없이 점수만. 모든 FULL_TIME 정규직 + ACTIVE + 해당 year
    PERSONAL 목표 보유자만 포함 (목표 0건은 분포 제외).
    """

    year: int
    my_score: float | None       # 본인 점수 (목표 없으면 None)
    my_rank: int | None          # 1-indexed (점수 desc). 동점은 strict greater-than 으로.
    percentile: float | None     # 상위 X% (0~100, 1등이면 ~0%)
    total_n: int
    scores: list[float]
    stats: DistributionStats


# ---------------------------------------------------------------------------
# Comment
# ---------------------------------------------------------------------------


class GoalCommentCreate(BaseModel):
    body: str = Field(min_length=1)


class GoalCommentUpdate(BaseModel):
    body: str = Field(min_length=1)


class GoalCommentOut(BaseModel):
    id: UUID
    goal_id: UUID
    author_id: UUID | None = None
    author_name: str | None = None
    body: str
    created_at: datetime
    updated_at: datetime
    can_edit: bool = False

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Attachment
# ---------------------------------------------------------------------------


class GoalAttachmentRename(BaseModel):
    file_name: str = Field(min_length=1, max_length=300)


class GoalAttachmentOut(BaseModel):
    id: UUID
    goal_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int
    uploaded_by_id: UUID | None = None
    uploaded_by_name: str | None = None
    created_at: datetime
    updated_at: datetime
    can_modify: bool = False

    class Config:
        from_attributes = True

