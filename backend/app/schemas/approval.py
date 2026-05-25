"""결재 시스템 스키마."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


ApprovalKind = Literal[
    "EXPENSE",
    "LEAVE",
    "BUSINESS_TRIP",
    "PURCHASE",
    "REMOTE_WORK",
    "OVERTIME",
    "CARD_USAGE",
    "SUBSCRIPTION",
    "OUTSOURCING",
    "PERSONNEL",
    "BIZ_HOSPITALITY",
    "POC",
    "ETC",
]
RequestStatus = Literal[
    "DRAFT", "SUBMITTED", "IN_PROGRESS", "APPROVED", "REJECTED", "CANCELLED"
]
StepStatus = Literal["PENDING", "APPROVED", "REJECTED", "DELEGATED", "SKIPPED"]


# ---------------------------------------------------------------------------
# Template
# ---------------------------------------------------------------------------


class AttachmentSlot(BaseModel):
    slug: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str
    required: bool = False
    min_count: int = 0
    max_count: int | None = None
    description: str | None = None


class AttachmentSlotsConfig(BaseModel):
    slots: list[AttachmentSlot] = Field(default_factory=list)


class ApprovalTemplateBase(BaseModel):
    kind: ApprovalKind
    name: str = Field(min_length=1, max_length=100)
    icon: str | None = None
    form_schema: dict[str, Any] = Field(default_factory=dict)
    ui_schema: dict[str, Any] | None = None
    approval_rules: dict[str, Any] = Field(default_factory=dict)
    attachment_slots: dict[str, Any] | None = None
    is_active: bool = True
    description: str | None = None


class ApprovalTemplateCreate(ApprovalTemplateBase):
    pass


class ApprovalTemplateUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    form_schema: dict[str, Any] | None = None
    ui_schema: dict[str, Any] | None = None
    approval_rules: dict[str, Any] | None = None
    attachment_slots: dict[str, Any] | None = None
    is_active: bool | None = None
    description: str | None = None


class ApprovalTemplateOut(ApprovalTemplateBase):
    id: UUID
    version: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Step
# ---------------------------------------------------------------------------


class ApprovalStepOut(BaseModel):
    id: UUID
    step_no: int
    step_name: str
    rule_index: int | None = None
    approver_index: int | None = None
    approver_id: UUID | None = None
    approver_name: str | None = None
    approver_title: str | None = None
    status: StepStatus
    decision_comment: str | None = None
    decided_at: datetime | None = None
    delegated_from_step_id: UUID | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


class ApprovalHistoryOut(BaseModel):
    id: UUID
    request_id: UUID
    step_id: UUID | None = None
    event: str
    actor_id: UUID | None = None
    actor_name: str | None = None
    payload: dict[str, Any] | None = None
    occurred_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Attachment
# ---------------------------------------------------------------------------


class ApprovalAttachmentOut(BaseModel):
    id: UUID
    request_id: UUID
    slot: str | None = None
    file_name: str
    mime_type: str | None = None
    size: int
    uploaded_by_id: UUID | None = None
    uploaded_by_name: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------


class ApprovalRequestCreate(BaseModel):
    template_id: UUID
    title: str = Field(min_length=1, max_length=300)
    form_data: dict[str, Any] = Field(default_factory=dict)
    submit: bool = True   # True 면 즉시 SUBMITTED, False 면 DRAFT 로만.


class ApprovalRequestUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    form_data: dict[str, Any] | None = None


class ApprovalDecisionInput(BaseModel):
    comment: str | None = None


class ApprovalDelegateInput(BaseModel):
    delegate_to_developer_id: UUID
    comment: str | None = None


class ApprovalRequestCurrentPending(BaseModel):
    """요청 전체 관점의 '지금 누구 차례인지' — 신청자가 결재자에게 직접 연락할
    수 있도록 연락처 포함. viewer 무관 (`my_pending_step` 과 별개)."""

    step_no: int
    step_name: str
    approver_id: UUID | None = None
    approver_name: str | None = None
    approver_title: str | None = None
    approver_phone: str | None = None
    approver_email: str | None = None


class ApprovalRequestSummary(BaseModel):
    """목록(/inbox /mine) 응답 — 폼 데이터 없이 메타만."""

    id: UUID
    kind: str
    template_id: UUID
    template_name: str | None = None
    template_icon: str | None = None
    title: str
    requester_id: UUID
    requester_name: str | None = None
    status: RequestStatus
    submitted_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    # 결재함(/inbox) 에서 — 현재 내가 처리해야 할 step.
    my_pending_step: ApprovalStepOut | None = None
    # '현재 대기' — 요청 단위로 step_no 가 가장 작은 PENDING. 누가 막고 있는지
    # 신청자 시점에서 확인 + 연락처 직접 노출 (hover tooltip 용).
    current_pending_step: ApprovalRequestCurrentPending | None = None
    # 진행 표시 — 전체 단계 수 / 처리 완료 수.
    total_steps: int = 0
    approved_steps: int = 0


class ApprovalRequestDetail(BaseModel):
    """단건 상세 — 폼·step·history·첨부 모두 포함."""

    id: UUID
    kind: str
    template_id: UUID
    template_name: str | None = None
    template_icon: str | None = None
    template_version: int
    form_schema_snapshot: dict[str, Any] | None = None
    ui_schema_snapshot: dict[str, Any] | None = None
    attachment_slots_snapshot: dict[str, Any] | None = None
    title: str
    requester_id: UUID
    requester_name: str | None = None
    status: RequestStatus
    form_data: dict[str, Any]
    submitted_at: datetime | None = None
    completed_at: datetime | None = None
    cancelled_reason: str | None = None
    created_at: datetime
    steps: list[ApprovalStepOut]
    # 현재 대기 step — 요약 응답과 동일 schema, 신청자에게 연락처 노출.
    current_pending_step: ApprovalRequestCurrentPending | None = None
    history: list[ApprovalHistoryOut]
    attachments: list[ApprovalAttachmentOut]
    # 보기 권한·수정 권한 hint (frontend 에서 버튼 disable 등에 사용).
    can_edit: bool = False
    can_cancel: bool = False
    can_act_step_id: UUID | None = None  # 내가 처리할 PENDING step id (있으면)


# ---------------------------------------------------------------------------
# 결재선 미리보기 — 신청 화면에서 form 입력 시 결재선이 어떻게 그려지는지.
# ---------------------------------------------------------------------------


class ApprovalChainPreviewIn(BaseModel):
    template_id: UUID
    form_data: dict[str, Any] = Field(default_factory=dict)


class ApprovalChainPreviewOut(BaseModel):
    matched_rule_name: str | None = None
    steps: list[ApprovalStepOut]
    warnings: list[str] = []
