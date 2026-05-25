from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


Stage = Literal["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION"]
OpportunityStatus = Literal["OPEN", "WON", "LOST", "ABANDONED"]
Currency = Literal["KRW", "USD"]
BusinessType = Literal["RESEARCH", "PRIVATE", "PUBLIC"]
ActivityType = Literal["MEETING", "CALL", "EMAIL", "PROPOSAL", "NOTE", "OTHER"]


class OpportunityBase(BaseModel):
    name: str
    customer_id: UUID | None = None
    owner_id: UUID | None = None
    sales_rep_id: UUID | None = None
    stage: Stage = "LEAD"
    status: OpportunityStatus = "OPEN"
    probability: int = 10
    expected_amount: Decimal = Decimal("0")
    currency: Currency = "KRW"
    expected_close_date: date | None = None
    registered_at: date | None = None
    source: str | None = None
    business_type: BusinessType | None = None
    description: str | None = None
    memo: str | None = None
    contact_name: str | None = None
    contact_department: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None


class OpportunityCreate(OpportunityBase):
    pass


class OpportunityUpdate(BaseModel):
    name: str | None = None
    customer_id: UUID | None = None
    owner_id: UUID | None = None
    sales_rep_id: UUID | None = None
    stage: Stage | None = None
    status: OpportunityStatus | None = None
    probability: int | None = None
    expected_amount: Decimal | None = None
    currency: Currency | None = None
    expected_close_date: date | None = None
    registered_at: date | None = None
    source: str | None = None
    business_type: BusinessType | None = None
    description: str | None = None
    memo: str | None = None
    contact_name: str | None = None
    contact_department: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    # Optional link — used when "convert" action moves this to a license/project.
    converted_license_id: UUID | None = None
    converted_project_id: UUID | None = None
    # Optional hint recorded in stage_history when stage/status changes.
    stage_change_note: str | None = None


class OpportunityActivityOut(BaseModel):
    id: UUID
    opportunity_id: UUID
    activity_type: ActivityType
    happened_at: datetime
    summary: str
    owner_id: UUID | None = None

    class Config:
        from_attributes = True


class OpportunityActivityCreate(BaseModel):
    activity_type: ActivityType = "NOTE"
    happened_at: datetime | None = None  # default to server now
    summary: str = ""


class OpportunityActivityUpdate(BaseModel):
    activity_type: ActivityType | None = None
    happened_at: datetime | None = None
    summary: str | None = None


class OpportunityStageHistoryOut(BaseModel):
    id: UUID
    opportunity_id: UUID
    from_stage: str | None
    to_stage: str
    from_status: str | None
    to_status: str
    changed_at: datetime
    changed_by: UUID | None = None
    note: str | None = None

    class Config:
        from_attributes = True


class OpportunityOut(OpportunityBase):
    id: UUID
    closed_at: datetime | None = None
    converted_license_id: UUID | None = None
    converted_project_id: UUID | None = None
    customer_name: str | None = None
    owner_name: str | None = None
    sales_rep_name: str | None = None
    weighted_amount: Decimal = Decimal("0")
    created_at: datetime

    class Config:
        from_attributes = True


class OpportunityDetail(OpportunityOut):
    activities: list[OpportunityActivityOut] = []
    stage_history: list[OpportunityStageHistoryOut] = []


class StageBucket(BaseModel):
    stage: str
    count: int
    amount: Decimal
    weighted: Decimal


class OpportunitySummary(BaseModel):
    year: int
    total_count: int
    total_amount: Decimal  # OPEN + WON (원화 환산 합)
    weighted_amount: Decimal
    won_amount: Decimal  # KRW 환산 합 (교차통화 포함)
    won_amount_krw: Decimal = Decimal("0")  # currency=KRW 인 수주 합
    won_amount_usd: Decimal = Decimal("0")  # currency=USD 인 수주 합
    lost_amount: Decimal
    win_rate: float  # WON / (WON + LOST), 0.0 ~ 1.0
    by_stage: list[StageBucket]


class OpportunityAttachmentOut(BaseModel):
    id: UUID
    opportunity_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    description: str | None = None

    class Config:
        from_attributes = True


class OpportunityAttachmentUpdate(BaseModel):
    file_name: str | None = None
    description: str | None = None


class OpportunityConvert(BaseModel):
    target: Literal["LICENSE", "PROJECT"]
    license_id: UUID | None = None
    project_id: UUID | None = None
    note: str | None = None
