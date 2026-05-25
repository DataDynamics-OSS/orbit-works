"""Pydantic schemas — 연차 도메인.

API 경계에서 사용하는 모든 타입 정의. 내부 allocation 엔진은
`app/services/leave_allocation.py` 참고.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


LeaveType = Literal["ANNUAL", "HALF", "UNPAID_PUBLIC"]
HalfKind = Literal["AM", "PM"]
LeaveStatus = Literal["PENDING", "APPROVED", "REJECTED", "CANCELLED"]
AccrualStrategy = Literal["ANNUAL_15", "MONTHLY_ACCRUAL"]
AllocationSource = Literal["STATUTORY", "REWARD"]


# ---------------------------------------------------------------------------
# 잔여 / 포상 조회
# ---------------------------------------------------------------------------


class StatutoryBalanceOut(BaseModel):
    year: int
    granted: Decimal
    used: Decimal
    pending: Decimal
    remaining: Decimal
    accrual_strategy: AccrualStrategy
    expires_on: date
    initialized_at: Optional[datetime] = None


class RewardGrantOut(BaseModel):
    id: UUID
    granted_days: Decimal
    remaining_days: Decimal
    reason: str
    granted_at: datetime
    granted_by: Optional[UUID] = None
    revoked_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class RewardSummaryOut(BaseModel):
    remaining: Decimal
    grants: list[RewardGrantOut]


class MyApproverInfo(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    is_primary: bool = False


class MyBalanceOut(BaseModel):
    year: int
    statutory: StatutoryBalanceOut
    reward: RewardSummaryOut
    total_remaining: Decimal
    approvers: list[MyApproverInfo] = []


class TeamBalanceRow(BaseModel):
    """직원 중심 관리 보드 요약. `/leaves/balances?year=` 응답."""

    developer_id: UUID
    name: str
    tag: Optional[str] = None
    employment_type: str
    hire_date: Optional[date] = None
    initialized: bool
    accrual_strategy: Optional[AccrualStrategy] = None
    statutory_granted: Decimal
    statutory_used: Decimal
    statutory_pending: Decimal
    statutory_remaining: Decimal
    reward_remaining: Decimal
    total_remaining: Decimal
    pending_request_count: int


# ---------------------------------------------------------------------------
# 초기화 / 누락된 연도 검색
# ---------------------------------------------------------------------------


class InitializePreviewRow(BaseModel):
    developer_id: UUID
    name: str
    tag: Optional[str] = None
    hire_date: Optional[date] = None
    tenure_months: Optional[int] = None
    prev_attendance_rate: Optional[float] = None
    suggested_strategy: AccrualStrategy
    suggested_granted_days: Decimal


class InitializeRequest(BaseModel):
    year: int
    developer_ids: list[UUID] = Field(default_factory=list)
    dry_run: bool = False
    note: Optional[str] = None


class InitializeResponse(BaseModel):
    year: int
    dry_run: bool
    preview: list[InitializePreviewRow]
    initialized_count: int = 0
    skipped_count: int = 0


class MissingBalanceRow(BaseModel):
    developer_id: UUID
    name: str
    tag: Optional[str] = None
    hire_date: Optional[date] = None
    tenure_months: Optional[int] = None
    suggested_strategy: AccrualStrategy


# ---------------------------------------------------------------------------
# 포상 연차 부여 / 회수
# ---------------------------------------------------------------------------


class RewardGrantCreate(BaseModel):
    developer_id: UUID
    granted_days: Decimal = Field(gt=0)
    reason: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _check_half_day_unit(self) -> "RewardGrantCreate":
        if (self.granted_days * 2) % 1 != 0:
            raise ValueError("포상 연차는 0.5일 단위여야 합니다.")
        return self


class RewardGrantRevoke(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


# ---------------------------------------------------------------------------
# 월 개근 적립
# ---------------------------------------------------------------------------


class AccrualOut(BaseModel):
    id: UUID
    developer_id: UUID
    year: int
    month: int
    days: Decimal
    reason: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AccrualResponse(BaseModel):
    year: int
    month: int
    added: int
    skipped_capped: int
    skipped_strategy: int
    skipped_existing: int


# ---------------------------------------------------------------------------
# 신청 / 승인 — PR2 에서 완성 (자리만 마련)
# ---------------------------------------------------------------------------


class AllocationOut(BaseModel):
    source_type: AllocationSource
    year: Optional[int] = None
    grant_id: Optional[UUID] = None
    days: Decimal

    model_config = ConfigDict(from_attributes=True)


class LeaveRequestCreate(BaseModel):
    developer_id: Optional[UUID] = None  # null 이면 본인 (인증된 사용자 매핑)
    leave_type: LeaveType
    half_kind: Optional[HalfKind] = None
    category: Optional[str] = Field(default=None, max_length=30)
    start_date: date
    end_date: date
    days_total: Decimal = Field(gt=0)
    reason: Optional[str] = None

    @model_validator(mode="after")
    def _check_shape(self) -> "LeaveRequestCreate":
        if self.end_date < self.start_date:
            raise ValueError("end_date 는 start_date 보다 크거나 같아야 합니다.")
        if (self.days_total * 2) % 1 != 0:
            raise ValueError("연차는 0.5일 단위여야 합니다.")
        if self.leave_type == "HALF":
            if self.half_kind is None:
                raise ValueError("반차는 half_kind (AM/PM) 이 필요합니다.")
            if self.start_date != self.end_date:
                raise ValueError("반차는 단일 일자만 허용됩니다.")
            if self.days_total != Decimal("0.5"):
                raise ValueError("반차의 days_total 은 0.5 이어야 합니다.")
        if self.leave_type == "UNPAID_PUBLIC" and not self.category:
            raise ValueError("무상 공가는 category 가 필요합니다.")
        return self


class LeaveRequestUpdate(BaseModel):
    leave_type: Optional[LeaveType] = None
    half_kind: Optional[HalfKind] = None
    category: Optional[str] = Field(default=None, max_length=30)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    days_total: Optional[Decimal] = None
    reason: Optional[str] = None


class RejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class LeaveRequestOut(BaseModel):
    id: UUID
    developer_id: UUID
    developer_name: Optional[str] = None
    developer_tag: Optional[str] = None
    requester_user_id: Optional[UUID] = None
    leave_type: LeaveType
    half_kind: Optional[HalfKind] = None
    category: Optional[str] = None
    start_date: date
    end_date: date
    days_total: Decimal
    status: LeaveStatus
    reason: Optional[str] = None
    evidence_path: Optional[str] = None
    approver_user_id: Optional[UUID] = None
    approved_at: Optional[datetime] = None
    rejected_reason: Optional[str] = None
    allocations: list[AllocationOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# 초기화 미이행 에러 body (클라가 사용)
# ---------------------------------------------------------------------------


class LeaveBalanceMissingDetail(BaseModel):
    detail: str
    code: Literal["LEAVE_BALANCE_NOT_INITIALIZED"] = "LEAVE_BALANCE_NOT_INITIALIZED"
    missing_years: list[int]
    required_action: Literal["ADMIN_INITIALIZE"] = "ADMIN_INITIALIZE"
