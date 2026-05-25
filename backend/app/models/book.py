"""회사 도서 — sidebar > 홈 > 도서 메뉴.

회사가 보유한 도서 1권을 1 row 로 관리. 임대 이력은 보존하지 않음 — 현재
임대인 / 시작 시각 / 반납 예정일만 컬럼으로 들고, 반납 시 borrower_id =
NULL 로 클리어.
"""

import uuid
from datetime import date as date_cls, datetime

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Book(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "books"

    title: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    # 도서가 비치된 물리적 위치 (예: "회의실 책장 A-2", "본사 3층 라운지"). 자유 입력.
    location: Mapped[str | None] = mapped_column(String(200))
    publisher: Mapped[str | None] = mapped_column(String(150))
    category: Mapped[str | None] = mapped_column(String(100))
    price: Mapped[int | None] = mapped_column(Integer)  # KRW 정수.
    # 현재 임대 — 1권당 1명 동시 임대 (이력 X).
    borrower_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    borrowed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_date: Mapped[date_cls | None] = mapped_column(Date)
    registered_at: Mapped[date_cls] = mapped_column(
        Date, nullable=False, default=date_cls.today
    )
    note: Mapped[str | None] = mapped_column(Text)
