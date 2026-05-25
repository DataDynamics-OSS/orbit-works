"""회사 자산(CompanyAsset) Pydantic 스키마.

프런트 — 백엔드 간 직렬화 계약. `photo_path` 는 내부 경로라 외부로 노출하지 않고
`photo_name` 과 `has_photo` 플래그만 공개한다 (실제 파일은 별도 GET 엔드포인트).
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


# 카테고리 코드 — frontend `asset-categories.ts` 와 동기화 필수.
AssetCategory = Literal[
    "LAPTOP",
    "DESKTOP",
    "SERVER",
    "MONITOR",
    "PROJECTOR",
    "DESK",
    "CHAIR",
    "PHONE",
    "TABLET",
    "PRINTER",
    "NETWORK",
    "PERIPHERAL",
    "FURNITURE",
    "SOFTWARE",
    "SPEAKER",
    "TV",
    "AIR_PURIFIER",
    "WATER_PURIFIER",
    "REFRIGERATOR",
    "BIDET",
    "BUILDING",
    "OFFICE",
    "LAND",
    "CERTIFICATION",
    "OTHER",
]

AssetStatus = Literal["IN_USE", "IN_STORAGE", "DISPOSED"]


class AssetBase(BaseModel):
    category: AssetCategory
    manufacturer: str | None = None
    model_name: str | None = None
    serial_no: str | None = None
    spec: str | None = None
    purchase_date: date | None = None
    purchase_vendor: str | None = None
    purchase_price: Decimal | None = None
    warranty_expires: date | None = None
    owner_id: UUID | None = None
    status: AssetStatus = "IN_USE"
    location: str | None = None
    memo: str | None = None


class AssetCreate(AssetBase):
    pass


class AssetUpdate(BaseModel):
    category: AssetCategory | None = None
    manufacturer: str | None = None
    model_name: str | None = None
    serial_no: str | None = None
    spec: str | None = None
    purchase_date: date | None = None
    purchase_vendor: str | None = None
    purchase_price: Decimal | None = None
    warranty_expires: date | None = None
    owner_id: UUID | None = None
    status: AssetStatus | None = None
    location: str | None = None
    memo: str | None = None


class AssetOut(AssetBase):
    id: UUID
    asset_no: str
    # 프런트 표시용 소유자 정보 (없으면 None).
    owner_name: str | None = None
    owner_tag: str | None = None
    # 사진 1장 업로드 여부 — 실제 blob 은 별도 GET 엔드포인트.
    photo_name: str | None = None
    has_photo: bool = False
    created_at: datetime
    updated_at: datetime


class AssetPageOut(BaseModel):
    """페이지네이션 응답. 프런트 DataGrid 가 page/page_size/total 을 사용."""

    items: list[AssetOut]
    total: int
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=2000)
