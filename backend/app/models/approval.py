"""결재 시스템 도메인 — 5 테이블.

- ApprovalTemplate    — 결재 양식 마스터 (form_schema + approval_rules JSON, version)
- ApprovalRequest     — 결재 요청 (form_data, status). source of truth.
- ApprovalStep        — 각 결재 단계 (제출 시 룰 평가 결과 snapshot)
- ApprovalHistory     — 모든 상태 변화 (DRAFT/SUBMITTED/APPROVED/REJECTED/CANCELLED/...)
- ApprovalAttachment  — 첨부 파일 (data/approvals/{id}/<uuid>.<ext>)

설계 원칙:
- 룰·폼 schema 변경이 진행중 결재에 영향 X 위해 ApprovalRequest 가
  template_version + form_schema_snapshot + approval_rules_snapshot 을 자체 보존.
- 결재선은 제출 시점 manager_id / 직위·직책 chain 으로 1회 평가해 step row 로 굳힘.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


# 결재 종류 코드 — 시드 JSON 의 kind 와 1:1.
APPROVAL_KINDS = (
    "EXPENSE",        # 지출결의서
    "LEAVE",          # 휴가
    "BUSINESS_TRIP",  # 출장
    "PURCHASE",       # 물품 구매
    "REMOTE_WORK",    # 재택근무
    "OVERTIME",       # 야근/휴일근무
    "CARD_USAGE",     # 법인카드 사용 신고
    "SUBSCRIPTION",   # SaaS·라이센스 구독
    "OUTSOURCING",    # 외주/용역 계약
    "PERSONNEL",      # 휴직/복직/사직서
    "BIZ_HOSPITALITY", # 접대비 (기업업무추진비)
    "POC",            # PoC 수행 (지출 카테고리지만 1 kind = 1 template 제약상 별도)
    "ETC",            # 기타 — 지원하지 않는 결재 양식의 자유 형식
)


class ApprovalTemplate(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """결재 양식 마스터. 같은 (tenant, kind) 는 1 row 만."""

    __tablename__ = "approval_templates"
    __table_args__ = (
        UniqueConstraint("tenant_id", "kind", name="uq_approval_templates_tenant_kind"),
    )

    kind: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    icon: Mapped[str | None] = mapped_column(String(40))                  # lucide-react icon key
    # JSON Schema (필드 정의). rjsf 가 그대로 렌더.
    form_schema: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # rjsf ui 힌트 (layout, widget 종류 등). 선택적.
    ui_schema: Mapped[dict | None] = mapped_column(JSONB)
    # 결재 룰 — when 조건 + approvers 배열.
    approval_rules: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # 첨부 슬롯 정의 — { "slots": [ { "slug", "label", "required", "min_count",
    #   "max_count", "description" } ] }. 슬롯이 없거나 빈 배열이면 자유 첨부만 허용.
    attachment_slots: Mapped[dict | None] = mapped_column(JSONB)
    # 폼/룰 변경 시 자동 +1. 진행중 결재는 옛 version 의 schema 로 frozen.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[str | None] = mapped_column(Text)


class ApprovalRequest(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """결재 요청 — 제출 시점 form_data + 룰 평가 결과 snapshot 보존."""

    __tablename__ = "approval_requests"

    template_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("approval_templates.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    # template.kind 와 동일. 빠른 필터용 중복 컬럼.
    kind: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    requester_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    # DRAFT | SUBMITTED | IN_PROGRESS | APPROVED | REJECTED | CANCELLED
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="DRAFT", index=True
    )
    # 사용자가 입력한 폼 값.
    form_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    # ── 진행중 결재 보호용 snapshot ──
    template_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    form_schema_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    approval_rules_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    # 제출 시점 슬롯 정의 snapshot — 진행중 결재의 기대 첨부 보호.
    attachment_slots_snapshot: Mapped[dict | None] = mapped_column(JSONB)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_reason: Mapped[str | None] = mapped_column(Text)

    template: Mapped[ApprovalTemplate] = relationship("ApprovalTemplate", lazy="select")
    steps: Mapped[list["ApprovalStep"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="ApprovalStep.step_no",
    )
    history: Mapped[list["ApprovalHistory"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="ApprovalHistory.occurred_at",
    )
    attachments: Mapped[list["ApprovalAttachment"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="ApprovalAttachment.created_at",
    )


class ApprovalStep(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """각 결재 단계 — 제출 시 룰 평가로 미리 만든 snapshot.

    매니저가 갑자기 퇴사·이동해도 진행중 결재는 영향 X (approver_id 가 그 시점 사람).
    """

    __tablename__ = "approval_steps"

    request_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("approval_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    step_no: Mapped[int] = mapped_column(Integer, nullable=False)
    step_name: Mapped[str] = mapped_column(String(100), nullable=False)
    # rule index — 어느 룰의 어느 approver 항목에서 만들어졌는지 (감사 추적).
    rule_index: Mapped[int | None] = mapped_column(Integer)
    approver_index: Mapped[int | None] = mapped_column(Integer)
    approver_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    # PENDING | APPROVED | REJECTED | DELEGATED | SKIPPED
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="PENDING", index=True
    )
    decision_comment: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 위임된 경우 — DELEGATED 시 새 step row 가 생성되고 그 row 의 delegated_from_step_id 설정.
    delegated_from_step_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("approval_steps.id", ondelete="SET NULL"),
    )

    request: Mapped[ApprovalRequest] = relationship(back_populates="steps")


class ApprovalHistory(Base, UUIDMixin, TenantMixin):
    """모든 상태 변화의 영구 감사 로그 (TimestampMixin 미적용 — created_at = occurred_at)."""

    __tablename__ = "approval_history"

    request_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("approval_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    step_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("approval_steps.id", ondelete="SET NULL"),
    )
    # CREATED | SUBMITTED | APPROVED | REJECTED | CANCELLED | DELEGATED | TIMEOUT | COMMENTED
    event: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )
    payload: Mapped[dict | None] = mapped_column(JSONB)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    request: Mapped[ApprovalRequest] = relationship(back_populates="history")


class ApprovalAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """결재 요청 첨부 — data/approvals/{request_id}/<uuid>.<ext>."""

    __tablename__ = "approval_attachments"

    request_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("approval_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 첨부 슬롯 식별자 (template.attachment_slots.slots[].slug). NULL = 기타.
    slot: Mapped[str | None] = mapped_column(String(40))
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )

    request: Mapped[ApprovalRequest] = relationship(back_populates="attachments")
