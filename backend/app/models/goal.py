"""목표(Goal) — 개인/회사 연간 목표.

scope 두 종:
- PERSONAL : owner_id NOT NULL (developers.id). 본인+매니저+HR/ADMIN 조회·편집.
- COMPANY  : owner_id NULL. 전직원 readonly, HR/ADMIN 만 작성·수정.

parent_goal_id 로 회사 목표 → 개인 목표 cascade 연결 가능 (선택).
TipTap HTML 본문은 description 컬럼에 저장.

phase2 예약 — goal_key_results (Objective+KR 정량 측정), goal_check_ins (Q1~Q4 회고).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
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


# scope 코드 — schema/api literal 과 동기화.
GOAL_SCOPES = ("PERSONAL", "COMPANY")
GOAL_CATEGORIES = (
    "BUSINESS",         # 사업·매출
    "TECH",             # 기술·제품
    "CAREER",           # 커리어 발전
    "OPERATIONS",       # 운영·프로세스
    "PERSONAL_GROWTH",  # 자기계발
    "OTHER",
)
GOAL_PRIORITIES = ("HIGH", "MEDIUM", "LOW")
GOAL_STATUSES = (
    "DRAFT",
    "IN_PROGRESS",
    "AT_RISK",
    "DONE",
    "DROPPED",
)
# 난이도 — multiplier 는 schemas/services 에서 사용.
GOAL_DIFFICULTIES = ("ROUTINE", "NORMAL", "CHALLENGING", "STRETCH")
DIFFICULTY_FACTOR: dict[str, float] = {
    "ROUTINE": 0.8,
    "NORMAL": 1.0,
    "CHALLENGING": 1.5,
    "STRETCH": 2.0,
}
PRIORITY_WEIGHT: dict[str, int] = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
GRADE_CUTOFFS: tuple[tuple[float, str], ...] = (
    (120.0, "S"),
    (90.0, "A"),
    (70.0, "B"),
    (50.0, "C"),
    (0.0, "D"),
)


class Goal(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "goals"

    scope: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # PERSONAL 은 NOT NULL, COMPANY 는 NULL — 앱 레이어 검증.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        index=True,
    )
    parent_goal_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("goals.id", ondelete="SET NULL"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(
        String(30), nullable=False, default="BUSINESS"
    )
    priority: Mapped[str] = mapped_column(
        String(8), nullable=False, default="MEDIUM"
    )
    difficulty: Mapped[str] = mapped_column(
        String(16), nullable=False, default="NORMAL"
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="DRAFT"
    )
    progress_pct: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=Decimal("0")
    )
    due_date: Mapped[date | None] = mapped_column(Date)
    # 평가 점수 (0~150). NULL = 미입력.
    self_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    self_score_comment: Mapped[str | None] = mapped_column(Text)
    manager_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    manager_score_comment: Mapped[str | None] = mapped_column(Text)
    manager_score_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )
    manager_score_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # parent_goal_id self-reference 관계 (cascade 표시용 join).
    parent: Mapped["Goal | None"] = relationship(
        "Goal",
        remote_side="Goal.id",
        foreign_keys=[parent_goal_id],
        lazy="select",
    )


# 마감일 알림 종류.
GOAL_ALERT_KINDS = ("D_30", "OVERDUE")


class GoalDueAlert(Base, UUIDMixin, TenantMixin):
    """목표 마감일 알림 dedup row.

    UNIQUE(goal_id, alert_kind) — INSERT … ON CONFLICT DO NOTHING 으로
    매일 cron 재실행 시에도 중복 발송 차단.
    """

    __tablename__ = "goal_due_alerts"

    goal_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("goals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    alert_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    notified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default="now()",
    )


class GoalComment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """목표 코멘트 — TipTap HTML 본문.

    조회 권한자(_can_view 통과)는 누구나 작성 가능. 편집·삭제는 작성자
    + HR/ADMIN. developer 삭제 시 author_id NULL (코멘트는 감사 로그로 보존).
    """

    __tablename__ = "goal_comments"

    goal_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("goals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )
    # developer 미매핑 사용자(ADMIN 부트스트랩 등) fallback.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)


class GoalScoreBaseline(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """연도별 종합 점수 가중치 하한 (Σweight floor).

    `total_score = Σ(goal_score) / max(Σweight, min_total_weight)` 로 계산.
    목표를 적게 등록한 owner 가 가중평균 분모 축소로 점수 부풀림되는 것을 차단.
    하나도 없으면 floor 미적용 (= 기존 동작).
    """

    __tablename__ = "goal_score_baselines"
    __table_args__ = (
        UniqueConstraint("tenant_id", "year", name="uq_goal_score_baselines_year"),
    )

    year: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # Σ(priority_weight × category_weight) 의 하한. 0 보다 커야 의미 있음.
    min_total_weight: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False
    )
    # 동일한 의미의 보조 정보 — UI 에 "최소 N 개" 권장치 노출 (페널티 X, 안내만).
    min_goal_count: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)


class GoalAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """목표 첨부 파일 — N개. 본인/직속 매니저/HR/ADMIN 업로드·삭제·이름변경.
    다운로드는 조회 권한자 모두.

    저장 경로: data/<tenant>/goals/<goal_id>/<uuid>.<ext>
    """

    __tablename__ = "goal_attachments"

    goal_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("goals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )
