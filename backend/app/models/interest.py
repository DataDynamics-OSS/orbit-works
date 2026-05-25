from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class InterestRate(Base, TimestampMixin):
    """ECOS(한국은행) 에서 수집한 국내 금리 시계열.

    series_code 는 Orbit Works 내부 명(`BASE_RATE`, `CD_91` 등) — 외부 ECOS 식별자
    (stat_code + item_code) 와의 매핑은 `app/services/interest.py` 의 SERIES
    카탈로그에서 관리.
    """

    __tablename__ = "interest_rates"

    date: Mapped[date] = mapped_column(Date, primary_key=True)
    series_code: Mapped[str] = mapped_column(String(32), primary_key=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(8, 4), nullable=False)
