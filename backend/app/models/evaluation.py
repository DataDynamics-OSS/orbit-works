"""임직원 평가 (employee evaluation).

도메인:
  - 반기(1H/2H) cycle 단위로 모든 활성 정규직(FULL_TIME) 직원에 평가 row
    자동 생성. cycle 1년 = 2개 (1H/2H).
  - workflow: NOT_STARTED → SELF_DRAFT → SELF_SUBMITTED → MGR_DRAFT
              → MGR_SUBMITTED → CALIBRATED → FINALIZED.
  - 평가 = 목표 달성도(자동 집계, 1.0~5.0) + 역량(competency_dimensions, 1~5점)
    + 종합 의견(TipTap HTML).
  - 등급 = S/A/B/C/D — HR calibration 결과.

테이블 4종:
  evaluation_cycles                — HR 가 만드는 평가 주기 (1H/2H, 1년 2개)
  competency_dimensions            — tenant 별 역량 dimension (Settings 편집)
  evaluations                      — 1 cycle × 1 직원 = 1 row
  evaluation_competency_scores     — 1 evaluation × N dimension
"""

from __future__ import annotations

import uuid
from datetime import date as date_cls, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class EvaluationCycle(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """반기 평가 주기 — HR 가 만들고 open/close.

    open 시 모든 active+FULL_TIME developer 에 evaluations row 자동 생성.
    closed 후엔 자기·매니저 평가는 read-only (HR 의 calibration 만 가능).
    """

    __tablename__ = "evaluation_cycles"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "year", "period",
            name="uq_eval_cycle_year_period",
        ),
    )

    year: Mapped[int] = mapped_column(Integer, nullable=False)
    # 1H | 2H — 반기 표기. period 가 결국 start_date/end_date 의 의미를 압축.
    period: Mapped[str] = mapped_column(String(4), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # goal 자동 집계 범위 (cycle.year 의 1/1~6/30 또는 7/1~12/31).
    start_date: Mapped[date_cls] = mapped_column(Date, nullable=False)
    end_date: Mapped[date_cls] = mapped_column(Date, nullable=False)
    # 3-단계 deadline — UI 에 D-? 로 표시, 마감 임박 알림 trigger.
    self_due: Mapped[date_cls] = mapped_column(Date, nullable=False)
    manager_due: Mapped[date_cls] = mapped_column(Date, nullable=False)
    finalize_due: Mapped[date_cls] = mapped_column(Date, nullable=False)
    # DRAFT → OPEN → CALIBRATING → CLOSED.
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="DRAFT", index=True,
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CompetencyDimension(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """역량 dimension — Settings 에서 ADMIN 이 편집.

    seeding: tenant 가 처음 GET /evaluations/dimensions 호출 시 default 7종
    자동 삽입. UNIQUE(tenant_id, key) — key 는 slug 로 코드와 매칭 안정.
    """

    __tablename__ = "competency_dimensions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "key", name="uq_competency_dim_key"),
    )

    key: Mapped[str] = mapped_column(String(40), nullable=False)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Evaluation(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """1 cycle × 1 직원 = 1 row. cycle open 시 자동 생성."""

    __tablename__ = "evaluations"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "cycle_id", "developer_id",
            name="uq_evaluation_cycle_dev",
        ),
    )

    cycle_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("evaluation_cycles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    developer_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 매니저 스냅샷 — cycle open 시점의 manager. 도중에 매니저가 바뀌어도
    # 그 cycle 의 평가자는 보존. NULL = 매니저 없음 (대표·고위직).
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    # NOT_STARTED | SELF_DRAFT | SELF_SUBMITTED | MGR_DRAFT
    # | MGR_SUBMITTED | CALIBRATED | FINALIZED.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="NOT_STARTED", index=True,
    )
    # TipTap HTML 본문.
    self_narrative: Mapped[str | None] = mapped_column(Text)
    manager_narrative: Mapped[str | None] = mapped_column(Text)
    # HR 내부 메모 — 본인·매니저에게 노출되지 않음.
    calibration_note: Mapped[str | None] = mapped_column(Text)

    # 목표 달성도 — 1.0~5.0. cycle 기간의 PERSONAL goals progress 평균에서
    # prefill, self/manager/HR 가 그대로 받거나 조정.
    goal_score_self: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    goal_score_manager: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    goal_score_final: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))

    # 역량 평균 (서버에서 계산 — competency_scores 가 source of truth).
    competency_avg_self: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    competency_avg_manager: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    competency_avg_final: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))

    # 최종 종합 점수 + 등급 — calibration 단계에서 HR 결정.
    final_overall_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    final_grade: Mapped[str | None] = mapped_column(String(2))  # S/A/B/C/D

    # 단계별 timestamp.
    self_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    manager_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    calibrated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    finalized_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )

    competencies: Mapped[list["EvaluationCompetencyScore"]] = relationship(
        back_populates="evaluation",
        cascade="all, delete-orphan",
        order_by="EvaluationCompetencyScore.dimension_key",
    )


class EvaluationCompetencyScore(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """평가 × dimension = 1 row.

    self/manager/final 점수는 1~5 정수. NULL = N/A
    (예: 비매니저의 leadership). UNIQUE(evaluation_id, dimension_key).
    """

    __tablename__ = "evaluation_competency_scores"
    __table_args__ = (
        UniqueConstraint(
            "evaluation_id", "dimension_key",
            name="uq_eval_competency_eval_dim",
        ),
    )

    evaluation_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("evaluations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # competency_dimensions.key 와 매핑되는 slug. soft FK — dimension 비활성/
    # rename 시에도 score row 보존 (내역 보존 우선).
    dimension_key: Mapped[str] = mapped_column(String(40), nullable=False)
    self_score: Mapped[int | None] = mapped_column(Integer)
    manager_score: Mapped[int | None] = mapped_column(Integer)
    final_score: Mapped[int | None] = mapped_column(Integer)
    self_comment: Mapped[str | None] = mapped_column(Text)
    manager_comment: Mapped[str | None] = mapped_column(Text)
    final_comment: Mapped[str | None] = mapped_column(Text)

    evaluation: Mapped[Evaluation] = relationship(back_populates="competencies")


# ---------------------------------------------------------------------------
# Default competency dimensions — tenant 처음 사용 시 seeding 에 사용.
# Settings 에서 ADMIN 이 자유롭게 추가/수정/비활성화 가능.
# ---------------------------------------------------------------------------

DEFAULT_DIMENSIONS: list[dict[str, object]] = [
    {
        "key": "tech_depth",
        "label": "기술 깊이",
        "description": "직무 도메인의 전문성·깊이. 새로운 문제를 깊이 있게 분석·해결한다.",
        "sort_order": 10,
    },
    {
        "key": "ownership",
        "label": "주도성·책임감",
        "description": "맡은 과업을 끝까지 책임지고 결과를 만들어낸다. 막힘 시 능동적으로 돌파.",
        "sort_order": 20,
    },
    {
        "key": "collaboration",
        "label": "협업",
        "description": "동료·팀과의 신뢰·소통·문제 해결. 팀 성과를 우선한다.",
        "sort_order": 30,
    },
    {
        "key": "learning",
        "label": "학습·성장",
        "description": "새 기술·도구·도메인 학습 속도. 피드백을 자기 발전에 반영.",
        "sort_order": 40,
    },
    {
        "key": "communication",
        "label": "커뮤니케이션",
        "description": "문서·구두 전달의 명확성·적시성. 적절한 청자에 맞춰 정보를 정리한다.",
        "sort_order": 50,
    },
    {
        "key": "customer_focus",
        "label": "고객 지향",
        "description": "내·외부 고객의 관점에서 우선순위를 판단하고 가치를 만든다.",
        "sort_order": 60,
    },
    {
        "key": "leadership",
        "label": "리더십",
        "description": "(매니저·시니어급) 팀 방향 설정·동기 부여·코칭·의사결정.",
        "sort_order": 70,
    },
]
