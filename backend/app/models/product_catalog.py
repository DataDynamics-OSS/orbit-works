"""제품 카탈로그 — 제조사(vendor) · 제품(product) · 버전(version) 3계층 마스터.

지원(케이스/로그) 및 라이센스 도메인이 공용. 외부 도메인에서는 vendor_id / product_id
/ version_id (모두 nullable) 로 참조한다.

설계 노트:
- tenant 단위로 격리 (RLS).
- 이름 lookup-or-create 가 케이스/로그/라이센스 등록 흐름에서 자동으로 일어남.
  사용자가 자유 타이핑한 신규 값이 그대로 카탈로그에 들어와 ADMIN 이 나중에 정리할 수 있음.
- 삭제는 참조하는 도메인 row 가 있으면 409 (FK ON DELETE RESTRICT).
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

from sqlalchemy import Boolean, Date, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Vendor(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """제조사 — Cloudera, Databricks, MongoDB, …"""

    __tablename__ = "vendors"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_vendors_tenant_name"),
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    products: Mapped[list["Product"]] = relationship(
        back_populates="vendor", cascade="all, delete-orphan"
    )


class Product(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """제품 — 한 vendor 의 자식. 예: Cloudera 의 CDP / CFM / PVC-DS."""

    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("tenant_id", "vendor_id", "name", name="uq_products_tenant_vendor_name"),
    )

    vendor_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("vendors.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    # 짧은 이름 (예: "CDP", "CFM") — 드롭다운 식별자.
    name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    # 풀네임 (예: "Cloudera Data Platform"). 상세 표시·문서 인용용.
    long_name: Mapped[str | None] = mapped_column(String(200))
    # 자유 설명 — 제품 카탈로그 페이지에서 표시.
    description: Mapped[str | None] = mapped_column(Text)
    # 제품 코드 — 외부 시스템·문서 참조용 식별자 (예: "CDP-PVC"). UNIQUE 미강제.
    product_code: Mapped[str | None] = mapped_column(String(50), index=True)
    # 제품 공식 페이지·문서 URL.
    link: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    vendor: Mapped[Vendor] = relationship(back_populates="products")
    versions: Mapped[list["ProductVersion"]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )


class ProductVersion(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """제품 버전 — 한 product 의 자식. release_date 는 선택."""

    __tablename__ = "product_versions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "product_id", "name", name="uq_product_versions_tenant_product_name"),
    )

    product_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    release_date: Mapped[date | None] = mapped_column(Date)
    # 기능 설명 — 이 버전의 주요 변경·신규 기능 메모.
    description: Mapped[str | None] = mapped_column(Text)
    # 릴리즈 노트 / 다운로드 URL.
    link: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped[Product] = relationship(back_populates="versions")
