"""법인 차량 관리 모델.

자사가 리스·렌트·소유 중인 차량을 CRUD·첨부파일 관리. 첨부는 project_attachments
패턴을 그대로 따라 slot 별 1파일 (INSURANCE=보험증서, REGISTRATION=자동차 등록증).
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CompanyCar(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "company_cars"

    manufacturer: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    year: Mapped[int | None] = mapped_column(Integer)
    # 한국 번호판 포맷 변동이 많아 자유 문자열로 저장 ("12가 3456", "제주12가3456" 등).
    plate_no: Mapped[str | None] = mapped_column(String(30))
    vin: Mapped[str | None] = mapped_column(String(50))

    # LEASE | RENT | OWNED
    contract_type: Mapped[str] = mapped_column(String(20), nullable=False, default="OWNED")
    contract_start: Mapped[date | None] = mapped_column(Date)
    contract_end: Mapped[date | None] = mapped_column(Date)
    contract_company: Mapped[str | None] = mapped_column(String(200))

    insurer: Mapped[str | None] = mapped_column(String(200))
    insurer_phone: Mapped[str | None] = mapped_column(String(50))
    insurance_start: Mapped[date | None] = mapped_column(Date)
    insurance_end: Mapped[date | None] = mapped_column(Date)

    # 차량 취득가 (KRW). 리스/렌트면 차량 평가액 참고치, 소유면 매입가.
    vehicle_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    # 월 납입금 (KRW). 소유라면 할부 or 0.
    monthly_payment: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))

    memo: Mapped[str | None] = mapped_column(Text)

    # 관리자 (임직원 목록). 사임·퇴사 시 SET NULL 로 기록 보존.
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )

    attachments: Mapped[list["CompanyCarAttachment"]] = relationship(
        back_populates="car", cascade="all, delete-orphan"
    )


class CompanyCarAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """차량 첨부파일 — slot 당 1개 (INSURANCE / REGISTRATION)."""

    __tablename__ = "company_car_attachments"
    __table_args__ = (
        UniqueConstraint("car_id", "slot", name="uq_company_car_attachment_slot"),
    )

    car_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("company_cars.id", ondelete="CASCADE"),
        nullable=False,
    )
    # INSURANCE (보험증서) | REGISTRATION (자동차 등록증)
    slot: Mapped[str] = mapped_column(String(30), nullable=False)
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)

    car: Mapped["CompanyCar"] = relationship(back_populates="attachments")
