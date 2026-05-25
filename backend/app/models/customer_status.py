"""고객사 현황 (Customer Status) — 고객사 × 프로젝트(선택) × 시스템 단위 카드.

기술지원이 고객 환경의 운영 상태(어떤 벤더의 어떤 제품·버전이 깔려 있고
어떤 라이센스로 묶여 있으며 누가 담당인지) 를 한 화면에 묶어 관리하기
위한 엔트리. KB 와 동일한 본문(TipTap) + 첨부 패턴을 차용한다.

식별 단위는 (customer_id, project_id, system_name) — 같은 프로젝트
안에서도 시스템(DataLake / Search / Gateway 등) 마다 라이센스·담당자
조합이 다르므로 시스템 단위로 카드를 쪼갠다. project_id 는 NULL 허용
(상시 보수처럼 특정 프로젝트에 묶이지 않는 운영 환경도 다룬다).

분류 컬럼:
- environment    : PROD / STAGING / DEV         (기본 PROD)
- runtime_type   : VM / BAREMETAL / KUBERNETES / DOCKER  (기본 BAREMETAL)
  → 카드 검색·필터·시각화 의 차원 컬럼.

카탈로그 연동:
- vendor_id / product_id / version_id : 마스터 FK (nullable).
- version_detail : varchar(60), 자유 패치/빌드 표기 (예: "7.1.9.1080-4").
  카탈로그 버전 master 에 매번 등록하기 어려운 마이너 패치를 보존한다.

라이센스 결합:
- license_id 가 있으면 sidebar > 라이센스의 master 와 연결. quantity /
  기간은 license 마스터에 없는 필드(수량) 가 있고, 사용자가 license 마스터의
  기간과 다른 적용 기간(예: 일부만 활성) 을 기록할 수 있도록 자체 컬럼으로
  보유. UI 가 license 선택 시 마스터의 start/end_date 를 사용자가 비워 둔
  슬롯에만 자동 채워주고 (override 가능), 라이센스 마스터 삭제 시 ON
  DELETE SET NULL — 카드 자체는 보존.

담당자:
- customer_contact_id : `customer_contacts` 마스터 FK (해당 고객사의 contact 한정).
- tech_support_user_id : 내부 `users` FK. picker 는 FULL_TIME + ACTIVE 임직원만.
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import BigInteger, Date, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CustomerStatusEntry(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "customer_status_entries"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    # 옵션 — 카드가 특정 프로젝트에 묶이지 않는 운영 환경(상시 보수 등) 도 있음.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="RESTRICT"),
        index=True,
    )
    system_name: Mapped[str] = mapped_column(String(120), nullable=False)
    # 'PROD' (운영) | 'STAGING' (스테이징) | 'DEV' (개발). 기본 운영.
    environment: Mapped[str] = mapped_column(
        String(20), nullable=False, default="PROD", server_default="PROD",
    )
    # 'VM' | 'BAREMETAL' | 'KUBERNETES' | 'DOCKER'. 기본 베어메탈.
    runtime_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="BAREMETAL", server_default="BAREMETAL",
    )

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT"), index=True,
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="RESTRICT"), index=True,
    )
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("product_versions.id", ondelete="RESTRICT"),
        index=True,
    )
    # 카탈로그 버전 master 보다 더 구체적인 빌드/패치 표기 (예: 7.1.9.1080-4).
    # 자유 텍스트 — 카탈로그에 등록 안 된 마이너 패치도 보존.
    version_detail: Mapped[str | None] = mapped_column(String(60))

    license_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("licenses.id", ondelete="SET NULL"), index=True,
    )
    # 라이센스 마스터에 quantity 가 없어 자체 컬럼. 마스터 기간과 다른 적용 기간
    # 도 카드별로 override 가능.
    license_quantity: Mapped[int | None] = mapped_column(Integer)
    license_start_date: Mapped[date | None] = mapped_column(Date)
    license_end_date: Mapped[date | None] = mapped_column(Date)

    customer_contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customer_contacts.id", ondelete="SET NULL"),
        index=True,
    )
    tech_support_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True,
    )

    body: Mapped[str | None] = mapped_column(Text)           # TipTap HTML
    plain_text: Mapped[str | None] = mapped_column(Text)      # 검색 캐시

    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True,
    )

    attachments: Mapped[list["CustomerStatusAttachment"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
        order_by="CustomerStatusAttachment.created_at",
        passive_deletes=True,
    )


class CustomerStatusAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """엔트리 첨부. 디스크 경로: data/customer-status/<entry_id>/<uuid>.<ext>."""

    __tablename__ = "customer_status_attachments"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customer_status_entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )

    entry: Mapped["CustomerStatusEntry"] = relationship(back_populates="attachments")
