from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


InsuranceStatus = Literal["PAYING", "SUSPENDED", "COMPLETED", "CANCELED"]


class CompanyInsuranceAttachmentOut(BaseModel):
    id: UUID
    insurance_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None

    class Config:
        from_attributes = True


class CompanyInsuranceAttachmentUpdate(BaseModel):
    file_name: str | None = None


class CompanyInsuranceBase(BaseModel):
    insurer: str
    name: str
    planner_name: str | None = None
    planner_phone: str | None = None
    planner_email: str | None = None
    monthly_payment: Decimal | None = None
    final_amount: Decimal | None = None
    payment_start: date | None = None
    payment_end: date | None = None
    status: InsuranceStatus = "PAYING"
    memo: str | None = None


class CompanyInsuranceCreate(CompanyInsuranceBase):
    pass


class CompanyInsuranceUpdate(BaseModel):
    insurer: str | None = None
    name: str | None = None
    planner_name: str | None = None
    planner_phone: str | None = None
    planner_email: str | None = None
    monthly_payment: Decimal | None = None
    final_amount: Decimal | None = None
    payment_start: date | None = None
    payment_end: date | None = None
    status: InsuranceStatus | None = None
    memo: str | None = None


class CompanyInsuranceOut(CompanyInsuranceBase):
    id: UUID
    created_at: datetime
    attachments: list[CompanyInsuranceAttachmentOut] = []

    class Config:
        from_attributes = True
