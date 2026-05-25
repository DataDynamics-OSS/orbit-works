"""제품 카탈로그 API — vendors / products / product_versions.

권한:
- GET (목록·단건): 모든 인증 사용자 (케이스/로그/라이센스 폼에서 dropdown 채움).
- POST/PATCH/DELETE: ADMIN 만.
- DELETE 시 참조하는 case/log/license 가 있으면 409 (FK ON DELETE RESTRICT 가 raise).

자동 생성 헬퍼:
- `ensure_vendor(db, tenant_id, name)` 등은 같은 모듈에서 외부 도메인이 import 해서 사용.
- 사용자가 자유 타이핑한 신규 이름이 lookup 으로 없으면 새 row 생성하고 id 반환.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.models import Product, ProductVersion, Vendor, User
from app.schemas.product_catalog import (
    ProductIn,
    ProductOut,
    ProductUpdate,
    ProductVersionIn,
    ProductVersionOut,
    ProductVersionUpdate,
    VendorIn,
    VendorOut,
    VendorUpdate,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/catalog", tags=["product-catalog"])


# ---------------------------------------------------------------------------
# lookup-or-create — 외부 도메인 (support_cases/logs, licenses) 가 import 해서 사용.
# 사용자가 자유 타이핑한 이름이 있으면 해당 카탈로그 row 반환, 없으면 신규 생성.
# ---------------------------------------------------------------------------


async def ensure_vendor(db: AsyncSession, tenant_id: UUID, name: str) -> Vendor:
    """이름으로 vendor 조회 후 없으면 생성. trim 된 빈 문자열은 ValueError."""
    name = (name or "").strip()
    if not name:
        raise ValueError("vendor name 비어있음")
    row = (
        await db.execute(
            select(Vendor).where(Vendor.tenant_id == tenant_id, Vendor.name == name)
        )
    ).scalar_one_or_none()
    if row is not None:
        return row
    row = Vendor(tenant_id=tenant_id, name=name)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        # 동시 INSERT race — 재조회.
        await db.rollback()
        row = (
            await db.execute(
                select(Vendor).where(Vendor.tenant_id == tenant_id, Vendor.name == name)
            )
        ).scalar_one()
    return row


async def ensure_product(
    db: AsyncSession, tenant_id: UUID, vendor_id: UUID, name: str
) -> Product:
    name = (name or "").strip()
    if not name:
        raise ValueError("product name 비어있음")
    row = (
        await db.execute(
            select(Product).where(
                Product.tenant_id == tenant_id,
                Product.vendor_id == vendor_id,
                Product.name == name,
            )
        )
    ).scalar_one_or_none()
    if row is not None:
        return row
    row = Product(tenant_id=tenant_id, vendor_id=vendor_id, name=name)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        row = (
            await db.execute(
                select(Product).where(
                    Product.tenant_id == tenant_id,
                    Product.vendor_id == vendor_id,
                    Product.name == name,
                )
            )
        ).scalar_one()
    return row


async def ensure_version(
    db: AsyncSession, tenant_id: UUID, product_id: UUID, name: str
) -> ProductVersion:
    name = (name or "").strip()
    if not name:
        raise ValueError("version name 비어있음")
    row = (
        await db.execute(
            select(ProductVersion).where(
                ProductVersion.tenant_id == tenant_id,
                ProductVersion.product_id == product_id,
                ProductVersion.name == name,
            )
        )
    ).scalar_one_or_none()
    if row is not None:
        return row
    row = ProductVersion(tenant_id=tenant_id, product_id=product_id, name=name)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        row = (
            await db.execute(
                select(ProductVersion).where(
                    ProductVersion.tenant_id == tenant_id,
                    ProductVersion.product_id == product_id,
                    ProductVersion.name == name,
                )
            )
        ).scalar_one()
    return row


# ---------------------------------------------------------------------------
# Vendors API
# ---------------------------------------------------------------------------


@router.get("/vendors", response_model=list[VendorOut])
async def list_vendors(
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Vendor).order_by(Vendor.sort_order.asc(), Vendor.name.asc())
    if not include_inactive:
        stmt = stmt.where(Vendor.is_active.is_(True))
    rows = list((await db.execute(stmt)).scalars())
    return [VendorOut.model_validate(r) for r in rows]


@router.post("/vendors", response_model=VendorOut, status_code=status.HTTP_201_CREATED)
async def create_vendor(
    payload: VendorIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if user.tenant_id is None:
        raise HTTPException(400, "tenant 미배정 사용자는 카탈로그를 생성할 수 없습니다.")
    row = Vendor(
        tenant_id=user.tenant_id,
        name=payload.name.strip(),
        is_active=payload.is_active,
        sort_order=payload.sort_order,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이미 같은 이름의 제조사가 있습니다.")
    await db.refresh(row)
    logger.info("vendor 생성: id=%s name=%s by=%s", row.id, row.name, user.id)
    return VendorOut.model_validate(row)


@router.patch("/vendors/{vendor_id}", response_model=VendorOut)
async def update_vendor(
    vendor_id: UUID,
    payload: VendorUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "vendor 없음")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        data["name"] = data["name"].strip()
    for k, v in data.items():
        setattr(row, k, v)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이름 중복")
    await db.refresh(row)
    return VendorOut.model_validate(row)


@router.delete("/vendors/{vendor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_vendor(
    vendor_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "vendor 없음")
    try:
        await db.delete(row)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "참조하는 케이스/로그/라이센스가 있어 삭제할 수 없습니다.")
    logger.info("vendor 삭제: id=%s by=%s", vendor_id, user.id)


# ---------------------------------------------------------------------------
# Products API
# ---------------------------------------------------------------------------


def _product_out(p: Product, vendor_name: str | None) -> ProductOut:
    return ProductOut(
        id=p.id,
        vendor_id=p.vendor_id,
        vendor_name=vendor_name,
        name=p.name,
        long_name=p.long_name,
        description=p.description,
        product_code=p.product_code,
        link=p.link,
        is_active=p.is_active,
        sort_order=p.sort_order,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


@router.get("/products", response_model=list[ProductOut])
async def list_products(
    vendor_id: UUID | None = Query(None),
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Product).order_by(Product.sort_order.asc(), Product.name.asc())
    if vendor_id is not None:
        stmt = stmt.where(Product.vendor_id == vendor_id)
    if not include_inactive:
        stmt = stmt.where(Product.is_active.is_(True))
    rows = list((await db.execute(stmt)).scalars())
    # vendor name lookup (1번 join)
    vendor_ids = list({r.vendor_id for r in rows})
    name_map: dict[UUID, str] = {}
    if vendor_ids:
        vrows = (
            await db.execute(
                select(Vendor.id, Vendor.name).where(Vendor.id.in_(vendor_ids))
            )
        ).all()
        name_map = {v.id: v.name for v in vrows}
    return [_product_out(r, name_map.get(r.vendor_id)) for r in rows]


@router.post("/products", response_model=ProductOut, status_code=status.HTTP_201_CREATED)
async def create_product(
    payload: ProductIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if user.tenant_id is None:
        raise HTTPException(400, "tenant 미배정 사용자는 카탈로그를 생성할 수 없습니다.")
    row = Product(
        tenant_id=user.tenant_id,
        vendor_id=payload.vendor_id,
        name=payload.name.strip(),
        long_name=(payload.long_name or "").strip() or None,
        description=(payload.description or "").strip() or None,
        product_code=(payload.product_code or "").strip() or None,
        link=(payload.link or "").strip() or None,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이미 같은 제조사·제품 조합이 있습니다.")
    await db.refresh(row)
    vname = (
        await db.execute(select(Vendor.name).where(Vendor.id == row.vendor_id))
    ).scalar_one_or_none()
    return _product_out(row, vname)


@router.patch("/products/{product_id}", response_model=ProductOut)
async def update_product(
    product_id: UUID,
    payload: ProductUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(Product).where(Product.id == product_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "product 없음")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        data["name"] = data["name"].strip()
    for k, v in data.items():
        setattr(row, k, v)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이름 중복")
    await db.refresh(row)
    vname = (
        await db.execute(select(Vendor.name).where(Vendor.id == row.vendor_id))
    ).scalar_one_or_none()
    return _product_out(row, vname)


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_product(
    product_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(Product).where(Product.id == product_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "product 없음")
    try:
        await db.delete(row)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "참조하는 케이스/로그/라이센스가 있어 삭제할 수 없습니다.")


# ---------------------------------------------------------------------------
# Versions API
# ---------------------------------------------------------------------------


def _version_out(
    v: ProductVersion, product_name: str | None, vendor_id: UUID | None, vendor_name: str | None
) -> ProductVersionOut:
    return ProductVersionOut(
        id=v.id,
        product_id=v.product_id,
        product_name=product_name,
        vendor_id=vendor_id,
        vendor_name=vendor_name,
        name=v.name,
        release_date=v.release_date,
        description=v.description,
        link=v.link,
        is_active=v.is_active,
        sort_order=v.sort_order,
        created_at=v.created_at,
        updated_at=v.updated_at,
    )


@router.get("/versions", response_model=list[ProductVersionOut])
async def list_versions(
    product_id: UUID | None = Query(None),
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(ProductVersion).order_by(
        ProductVersion.sort_order.asc(), ProductVersion.name.asc()
    )
    if product_id is not None:
        stmt = stmt.where(ProductVersion.product_id == product_id)
    if not include_inactive:
        stmt = stmt.where(ProductVersion.is_active.is_(True))
    rows = list((await db.execute(stmt)).scalars())
    product_ids = list({r.product_id for r in rows})
    pname_map: dict[UUID, tuple[str, UUID]] = {}
    if product_ids:
        prows = (
            await db.execute(
                select(Product.id, Product.name, Product.vendor_id).where(
                    Product.id.in_(product_ids)
                )
            )
        ).all()
        pname_map = {p.id: (p.name, p.vendor_id) for p in prows}
    vendor_ids = list({pname_map[pid][1] for pid in pname_map})
    vname_map: dict[UUID, str] = {}
    if vendor_ids:
        vrows = (
            await db.execute(
                select(Vendor.id, Vendor.name).where(Vendor.id.in_(vendor_ids))
            )
        ).all()
        vname_map = {v.id: v.name for v in vrows}
    out: list[ProductVersionOut] = []
    for r in rows:
        pname, vid = pname_map.get(r.product_id, (None, None))
        out.append(_version_out(r, pname, vid, vname_map.get(vid) if vid else None))
    return out


@router.post("/versions", response_model=ProductVersionOut, status_code=status.HTTP_201_CREATED)
async def create_version(
    payload: ProductVersionIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if user.tenant_id is None:
        raise HTTPException(400, "tenant 미배정 사용자는 카탈로그를 생성할 수 없습니다.")
    row = ProductVersion(
        tenant_id=user.tenant_id,
        product_id=payload.product_id,
        name=payload.name.strip(),
        release_date=payload.release_date,
        description=(payload.description or "").strip() or None,
        link=(payload.link or "").strip() or None,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이미 같은 제품·버전 조합이 있습니다.")
    await db.refresh(row)
    return _version_out(row, None, None, None)


@router.patch("/versions/{version_id}", response_model=ProductVersionOut)
async def update_version(
    version_id: UUID,
    payload: ProductVersionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(ProductVersion).where(ProductVersion.id == version_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "version 없음")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        data["name"] = data["name"].strip()
    for k, v in data.items():
        setattr(row, k, v)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이름 중복")
    await db.refresh(row)
    return _version_out(row, None, None, None)


@router.delete("/versions/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_version(
    version_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    row = (
        await db.execute(select(ProductVersion).where(ProductVersion.id == version_id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "version 없음")
    try:
        await db.delete(row)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "참조하는 케이스/로그가 있어 삭제할 수 없습니다.")
