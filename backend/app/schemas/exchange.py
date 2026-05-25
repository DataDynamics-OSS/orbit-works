from datetime import date
from decimal import Decimal
from pydantic import BaseModel


class ExchangeRateOut(BaseModel):
    date: date
    base: str
    target: str
    rate: Decimal

    class Config:
        from_attributes = True
