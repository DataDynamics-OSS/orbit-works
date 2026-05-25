from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel


class ResearchGrantBase(BaseModel):
    name: str | None = None
    start_date: date
    end_date: date
    total_amount: Decimal
    participation_rate: Decimal
    note: str | None = None


class ResearchGrantCreate(ResearchGrantBase):
    pass


class ResearchGrantUpdate(BaseModel):
    name: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    total_amount: Decimal | None = None
    participation_rate: Decimal | None = None
    note: str | None = None


class ResearchGrantOut(ResearchGrantBase):
    id: UUID
    developer_id: UUID
    created_at: datetime

    class Config:
        from_attributes = True
