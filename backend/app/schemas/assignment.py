from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel


class AssignmentBase(BaseModel):
    project_id: UUID
    developer_id: UUID
    start_date: date
    end_date: date
    monthly_rate: Decimal = Decimal("0")
    base_monthly: Decimal | None = None
    insurance_monthly: Decimal | None = None
    overhead_monthly: Decimal | None = None
    freelancer_monthly: Decimal | None = None
    is_insourced: bool = False
    allocation_percent: Decimal = Decimal("100")
    color: str | None = None
    memo: str | None = None
    estimate_item_id: UUID | None = None


class AssignmentCreate(AssignmentBase):
    pass


class AssignmentUpdate(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    monthly_rate: Decimal | None = None
    base_monthly: Decimal | None = None
    insurance_monthly: Decimal | None = None
    overhead_monthly: Decimal | None = None
    freelancer_monthly: Decimal | None = None
    is_insourced: bool | None = None
    allocation_percent: Decimal | None = None
    color: str | None = None
    memo: str | None = None
    estimate_item_id: UUID | None = None


class AssignmentOut(AssignmentBase):
    id: UUID
    developer_name: str | None = None
    project_name: str | None = None

    class Config:
        from_attributes = True
