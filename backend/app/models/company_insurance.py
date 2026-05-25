"""법인 보험 관리 모델.

보험사·보험명·설계사·납입 상태 등을 CRUD. 첨부는 자유 다파일 방식
(슬롯 고정 아님 — 보험증서·약관·안내서·갱신서 등 다양).
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import BigInteger, Date, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CompanyInsurance(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "company_insurances"

    insurer: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)  # 보험명

    planner_name: Mapped[str | None] = mapped_column(String(100))
    planner_phone: Mapped[str | None] = mapped_column(String(50))
    planner_email: Mapped[str | None] = mapped_column(String(200))

    monthly_payment: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    # 최종 납입금액 — 만기 시 총 납부 예상액 (monthly × 기간) 또는 완납 시점의 누적금.
    final_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))

    payment_start: Mapped[date | None] = mapped_column(Date)
    payment_end: Mapped[date | None] = mapped_column(Date)

    # PAYING (납입중) | SUSPENDED (중지) | COMPLETED (완납) | CANCELED (해지)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PAYING")

    memo: Mapped[str | None] = mapped_column(Text)

    attachments: Mapped[list["CompanyInsuranceAttachment"]] = relationship(
        back_populates="insurance", cascade="all, delete-orphan"
    )


class CompanyInsuranceAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """법인 보험 첨부파일 (자유 다파일).

    slot 없음 — 보험증서·약관·갱신서 등 종류 제한 없이 여러 개 업로드 가능.
    표시용 `file_name` 은 사용자 변경 가능, 저장 경로 `file_path` 는 서버가 관리.
    """

    __tablename__ = "company_insurance_attachments"

    insurance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("company_insurances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)

    insurance: Mapped["CompanyInsurance"] = relationship(back_populates="attachments")
