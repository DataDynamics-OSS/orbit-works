from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


ContractType = Literal["LEASE", "RENT", "OWNED"]
CarAttachmentSlot = Literal["INSURANCE", "REGISTRATION"]


class CompanyCarAttachmentOut(BaseModel):
    id: UUID
    car_id: UUID
    slot: CarAttachmentSlot
    file_name: str
    mime_type: str | None = None
    size: int | None = None

    class Config:
        from_attributes = True


class CompanyCarAttachmentUpdate(BaseModel):
    file_name: str | None = None


class CompanyCarBase(BaseModel):
    manufacturer: str
    model: str
    year: int | None = None
    plate_no: str | None = None
    vin: str | None = None
    contract_type: ContractType = "OWNED"
    contract_start: date | None = None
    contract_end: date | None = None
    contract_company: str | None = None
    insurer: str | None = None
    insurer_phone: str | None = None
    insurance_start: date | None = None
    insurance_end: date | None = None
    vehicle_price: Decimal | None = None
    monthly_payment: Decimal | None = None
    memo: str | None = None
    manager_id: UUID | None = None


class CompanyCarCreate(CompanyCarBase):
    pass


class CompanyCarUpdate(BaseModel):
    manufacturer: str | None = None
    model: str | None = None
    year: int | None = None
    plate_no: str | None = None
    vin: str | None = None
    contract_type: ContractType | None = None
    contract_start: date | None = None
    contract_end: date | None = None
    contract_company: str | None = None
    insurer: str | None = None
    insurer_phone: str | None = None
    insurance_start: date | None = None
    insurance_end: date | None = None
    vehicle_price: Decimal | None = None
    monthly_payment: Decimal | None = None
    memo: str | None = None
    manager_id: UUID | None = None


class CompanyCarOut(CompanyCarBase):
    id: UUID
    created_at: datetime
    manager_name: str | None = None
    attachments: list[CompanyCarAttachmentOut] = []

    class Config:
        from_attributes = True
