"""회사 자산(Company Asset) 모델.

각 자산은 `asset_no` (DDA-YYYY-XXXX, XXXX 는 Crockford base32 4자 랜덤) 라는
고유 번호를 가지며, 이 번호로 QR 코드를 생성해 물리적 라벨(Formtec QR-3111 등)
에 인쇄해 붙인다. 포맷은 invoice (DDI-YYYYMMDD-XXXX) 와 같은 원리.
스캐너(스마트폰 카메라 등) 로 QR 을 읽으면 해당 자산 상세 페이지로 이동한다.

삭제는 소프트 — `status='DISPOSED'` 로 전환하여 기본 목록에서 감춘다 (구입 이력
보존을 위해 행 자체는 남긴다).

사진은 1장만 column 기반으로 저장 (tenants.logo 와 동일 패턴).
여러 장이 필요해지면 별도 attachments 테이블로 분리.
"""

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Date, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CompanyAsset(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "company_assets"

    # 자산번호 — DDA-YYYY-XXXX 포맷. XXXX 는 Crockford base32 랜덤 4자 (invoice
    # 와 동일 방식). 라벨 인쇄에 사용되므로 UNIQUE 이고 불변.
    asset_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    # 카테고리 — 코드 상수(하드코딩 enum). LAPTOP | DESK | MONITOR ... OTHER
    # frontend `asset-categories.ts` 와 동기화 필수.
    category: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # 제조사 · 제품명 · 일련번호 — 물리적 식별 정보.
    manufacturer: Mapped[str | None] = mapped_column(String(200))
    model_name: Mapped[str | None] = mapped_column(String(200))
    serial_no: Mapped[str | None] = mapped_column(String(120))

    # 상세 사양(자유 텍스트) — "RAM 16GB · SSD 512GB" 등.
    spec: Mapped[str | None] = mapped_column(Text)

    # 구입 정보
    purchase_date: Mapped[date | None] = mapped_column(Date)
    purchase_vendor: Mapped[str | None] = mapped_column(String(200))
    purchase_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))

    # AS 만료일
    warranty_expires: Mapped[date | None] = mapped_column(Date)

    # 현재 소유자(임직원). 퇴사 등으로 삭제되면 NULL 로 전환.
    owner_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )

    # 상태 — IN_USE(사용중) | IN_STORAGE(보관) | DISPOSED(폐기).
    # DELETE API 는 DISPOSED 로 전환할 뿐 row 는 남긴다.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="IN_USE", index=True
    )

    # 위치/부서 (자유 텍스트)
    location: Mapped[str | None] = mapped_column(String(200))
    memo: Mapped[str | None] = mapped_column(Text)

    # 사진 1장 — POST /assets/{id}/photo 로 교체, DELETE 로 제거.
    # 저장 경로는 services/storage.py 의 save_upload 가 정하는 data/assets/<id>/<uuid>.<ext>.
    photo_name: Mapped[str | None] = mapped_column(String(255))
    photo_path: Mapped[str | None] = mapped_column(String(1024))
    photo_mime: Mapped[str | None] = mapped_column(String(120))
    photo_size: Mapped[int | None] = mapped_column(Integer)
