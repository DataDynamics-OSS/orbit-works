import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Customer(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "customers"

    name: Mapped[str] = mapped_column(String(200), unique=True, nullable=False, index=True)
    business_no: Mapped[str | None] = mapped_column(String(20))
    representative: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[str | None] = mapped_column(Text)
    memo: Mapped[str | None] = mapped_column(Text)
    # 해외 법인 여부 — true 면 USD 청구 시 영세율(0%) 기본 적용.
    is_overseas: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Account Owner — 회사를 책임지는 우리 측 직원(Developer). 퇴사·삭제 시
    # 회사 row 자체는 유지되어야 하므로 SET NULL.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )

    # 사업자등록증 파일 (single file per customer)
    business_license_name: Mapped[str | None] = mapped_column(String(255))
    business_license_path: Mapped[str | None] = mapped_column(String(1024))
    business_license_mime: Mapped[str | None] = mapped_column(String(120))
    business_license_size: Mapped[int | None] = mapped_column(Integer)

    # 통장 사본 파일 (single file per customer)
    bank_account_name: Mapped[str | None] = mapped_column(String(255))
    bank_account_path: Mapped[str | None] = mapped_column(String(1024))
    bank_account_mime: Mapped[str | None] = mapped_column(String(120))
    bank_account_size: Mapped[int | None] = mapped_column(Integer)

    contacts: Mapped[list["LicenseContact"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan"
    )
    # SET NULL on developer delete — 응답 직렬화 시 owner.name / owner.status 만 사용.
    owner = relationship("Developer", foreign_keys=[owner_id], lazy="select")


class LicenseContact(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "license_contacts"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))

    customer: Mapped["Customer"] = relationship(back_populates="contacts")
