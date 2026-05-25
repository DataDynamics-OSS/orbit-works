from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class StockPrice(Base, TimestampMixin):
    """주가지수 일별 종가 시계열.

    series_code 는 Orbit Works 내부 식별자 (KOSPI, KOSDAQ, SP500, NASDAQ, DJIA 등).
    외부 소스(ECOS/FRED) 매핑은 `app/services/stock.py` SERIES 카탈로그에 있다.
    """

    __tablename__ = "stock_prices"

    date: Mapped[date] = mapped_column(Date, primary_key=True)
    series_code: Mapped[str] = mapped_column(String(32), primary_key=True)
    close: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
