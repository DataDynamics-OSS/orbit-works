from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ExchangeRate(Base, TimestampMixin):
    __tablename__ = "exchange_rates"

    date: Mapped[date] = mapped_column(Date, primary_key=True)
    base: Mapped[str] = mapped_column(String(3), primary_key=True, default="USD")
    target: Mapped[str] = mapped_column(String(3), primary_key=True, default="KRW")
    rate: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)
