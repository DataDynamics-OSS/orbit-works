import logging
from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import extract, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.api.v1.product_catalog import ensure_vendor
from app.core.database import get_db
from app.models import License, LicenseQuote, LicenseQuoteItem, User, Vendor
from app.schemas.license import (
    LicenseCreate,
    LicenseOut,
    LicenseQuoteItemOut,
    LicenseQuoteItemsSave,
    LicenseQuoteOut,
    LicenseQuoteUpdate,
    LicenseUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/licenses", tags=["licenses"])


def _calc_amount_krw(lic: License) -> Decimal | None:
    if lic.currency == "KRW":
        return lic.amount
    if lic.currency == "USD" and lic.applied_fx_rate:
        return (lic.amount * lic.applied_fx_rate).quantize(Decimal("0.01"))
    return None


async def _attach_vendor_name(db: AsyncSession, lic: License) -> License:
    """LicenseOut.vendor (string) 응답을 위해 vendor_id → 이름 lookup 결과를 transient attr 로."""
    if lic.vendor_id:
        name = (
            await db.execute(select(Vendor.name).where(Vendor.id == lic.vendor_id))
        ).scalar_one_or_none()
        # ORM 객체의 transient attribute — pydantic from_attributes 가 읽음.
        lic.vendor = name  # type: ignore[attr-defined]
    else:
        lic.vendor = None  # type: ignore[attr-defined]
    return lic


@router.get("", response_model=list[LicenseOut])
async def list_licenses(
    year: int | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(License).options(selectinload(License.quotes)).order_by(License.end_date)
    if year:
        stmt = stmt.where(
            or_(
                extract("year", License.start_date) == year,
                extract("year", License.end_date) == year,
                extract("year", License.renewal_prep_date) == year,
            )
        )
    if q:
        stmt = stmt.where(License.product_name.ilike(f"%{q}%"))
    result = await db.execute(stmt)
    rows = list(result.scalars().all())
    for r in rows:
        await _attach_vendor_name(db, r)
    return rows


@router.post("", response_model=LicenseOut, status_code=status.HTTP_201_CREATED)
async def create_license(
    payload: LicenseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    # vendor (이름 string) → vendor_id (FK) 자동 변환.
    vendor_name = data.pop("vendor", None)
    vendor_id = None
    if vendor_name and user.tenant_id is not None:
        vendor_id = (await ensure_vendor(db, user.tenant_id, vendor_name)).id
    license_obj = License(**data, vendor_id=vendor_id)
    license_obj.amount_krw = _calc_amount_krw(license_obj)
    db.add(license_obj)
    await db.commit()
    await db.refresh(license_obj, attribute_names=["quotes"])
    logger.info(
        "라이센스 등록: id=%s product=%s amount=%s %s (등록자=%s)",
        license_obj.id,
        license_obj.product_name,
        license_obj.amount,
        license_obj.currency,
        user.id,
    )
    return await _attach_vendor_name(db, license_obj)


@router.get("/{license_id}", response_model=LicenseOut)
async def get_license(
    license_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(License).options(selectinload(License.quotes)).where(License.id == license_id)
    )
    lic = result.scalar_one_or_none()
    if not lic:
        raise HTTPException(status_code=404, detail="License not found")
    return await _attach_vendor_name(db, lic)


@router.patch("/{license_id}", response_model=LicenseOut)
async def update_license(
    license_id: UUID,
    payload: LicenseUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(License).options(selectinload(License.quotes)).where(License.id == license_id)
    )
    lic = result.scalar_one_or_none()
    if not lic:
        raise HTTPException(status_code=404, detail="License not found")
    data = payload.model_dump(exclude_unset=True)
    # vendor 이름이 payload 에 있으면 vendor_id 로 변환.
    if "vendor" in payload.model_fields_set:
        vname = data.pop("vendor", None)
        if vname and user.tenant_id is not None:
            data["vendor_id"] = (await ensure_vendor(db, user.tenant_id, vname)).id
        else:
            data["vendor_id"] = None
    for key, value in data.items():
        setattr(lic, key, value)
    lic.amount_krw = _calc_amount_krw(lic)
    await db.commit()
    await db.refresh(lic, attribute_names=["quotes"])
    await _attach_vendor_name(db, lic)
    logger.info(
        "라이센스 수정: id=%s 변경필드=%s (수정자=%s)",
        lic.id,
        list(data.keys()),
        user.id,
    )
    return lic


@router.delete("/{license_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_license(
    license_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(License).options(selectinload(License.quotes)).where(License.id == license_id)
    )
    lic = result.scalar_one_or_none()
    if not lic:
        raise HTTPException(status_code=404, detail="License not found")
    logger.warning(
        "라이센스 삭제: id=%s product=%s 첨부파일수=%d (삭제자=%s)",
        lic.id,
        lic.product_name,
        len(lic.quotes),
        user.id,
    )
    for q in lic.quotes:
        delete_file(q.file_path)
    await db.delete(lic)
    await db.commit()


@router.post(
    "/{license_id}/quotes",
    response_model=LicenseQuoteOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_quote(
    license_id: UUID,
    file: UploadFile = File(...),
    description: str | None = Form(None),
    quote_type: str = Form("SALES"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    exists = await db.execute(select(License).where(License.id == license_id))
    if not exists.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="License not found")
    stored, size = await save_upload(file, f"licenses/{license_id}")
    quote = LicenseQuote(
        license_id=license_id,
        quote_type=quote_type,
        file_name=file.filename or "upload.bin",
        file_path=stored,
        mime_type=file.content_type,
        size=size,
        description=description,
    )
    db.add(quote)
    await db.commit()
    await db.refresh(quote)
    logger.info(
        "라이센스 첨부 업로드: license_id=%s file=%s type=%s size=%s (업로드자=%s)",
        license_id,
        quote.file_name,
        quote_type,
        size,
        user.id,
    )
    return quote


@router.patch("/quotes/{quote_id}", response_model=LicenseQuoteOut)
async def update_quote(
    quote_id: UUID,
    payload: LicenseQuoteUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(LicenseQuote).where(LicenseQuote.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(quote, key, value)
    await db.commit()
    await db.refresh(quote)
    return quote


@router.delete("/quotes/{quote_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_quote(
    quote_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(LicenseQuote).where(LicenseQuote.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    logger.info(
        "라이센스 첨부 삭제: id=%s file=%s license_id=%s (삭제자=%s)",
        quote.id,
        quote.file_name,
        quote.license_id,
        user.id,
    )
    delete_file(quote.file_path)
    await db.delete(quote)
    await db.commit()


@router.get("/quotes/{quote_id}/download")
async def download_quote(
    quote_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(LicenseQuote).where(LicenseQuote.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    abs_path = resolve_upload_path(quote.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다. (업로드된 원본이 삭제되었거나 유실됨)",
        )
    return FileResponse(
        str(abs_path),
        filename=quote.file_name,
        media_type=quote.mime_type or "application/octet-stream",
    )


@router.get(
    "/{license_id}/quote-items", response_model=list[LicenseQuoteItemOut]
)
async def list_quote_items(
    license_id: UUID,
    kind: str = "PURCHASE",
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(LicenseQuoteItem)
        .where(
            LicenseQuoteItem.license_id == license_id,
            LicenseQuoteItem.kind == kind,
        )
        .order_by(LicenseQuoteItem.position)
    )
    return list(result.scalars().all())


@router.put(
    "/{license_id}/quote-items", response_model=list[LicenseQuoteItemOut]
)
async def save_quote_items(
    license_id: UUID,
    payload: LicenseQuoteItemsSave,
    kind: str = "PURCHASE",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    exists = (
        await db.execute(select(License).where(License.id == license_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="License not found")

    existing_rows = list(
        (
            await db.execute(
                select(LicenseQuoteItem).where(
                    LicenseQuoteItem.license_id == license_id,
                    LicenseQuoteItem.kind == kind,
                )
            )
        ).scalars()
    )
    existing_by_id = {r.id: r for r in existing_rows}
    incoming_ids: set[UUID] = set()

    for idx, item in enumerate(payload.items):
        if item.id and item.id in existing_by_id:
            row = existing_by_id[item.id]
            row.product_name = item.product_name
            row.product_code = item.product_code
            row.description = item.description
            row.sales_price = item.sales_price
            row.qty = item.qty
            row.start_date = item.start_date
            row.end_date = item.end_date
            row.discount_rate = item.discount_rate
            row.net_total = item.net_total
            row.position = idx
            incoming_ids.add(row.id)
        else:
            new_row = LicenseQuoteItem(
                license_id=license_id,
                kind=kind,
                product_name=item.product_name,
                product_code=item.product_code,
                description=item.description,
                sales_price=item.sales_price,
                qty=item.qty,
                start_date=item.start_date,
                end_date=item.end_date,
                discount_rate=item.discount_rate,
                net_total=item.net_total,
                position=idx,
            )
            db.add(new_row)

    removed = 0
    for old in existing_rows:
        if old.id not in incoming_ids:
            await db.delete(old)
            removed += 1

    await db.commit()

    refreshed = list(
        (
            await db.execute(
                select(LicenseQuoteItem)
                .where(
                    LicenseQuoteItem.license_id == license_id,
                    LicenseQuoteItem.kind == kind,
                )
                .order_by(LicenseQuoteItem.position)
            )
        ).scalars()
    )
    logger.info(
        "라이센스 견적 라인 저장: license_id=%s kind=%s 총=%d 저장=%d 삭제=%d (저장자=%s)",
        license_id,
        kind,
        len(refreshed),
        len(payload.items),
        removed,
        user.id,
    )
    return refreshed


@router.get("/calendar/{year}")
async def license_calendar(
    year: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    from app.models import Customer  # local import to avoid cycle at module load

    stmt = select(License).where(
        or_(
            extract("year", License.start_date) == year,
            extract("year", License.end_date) == year,
            extract("year", License.renewal_prep_date) == year,
        )
    )
    result = await db.execute(stmt)
    licenses = list(result.scalars().all())
    # Resolve customer names in one query.
    customer_ids = {lic.customer_id for lic in licenses if lic.customer_id}
    customer_names: dict = {}
    if customer_ids:
        cresult = await db.execute(
            select(Customer).where(Customer.id.in_(customer_ids))
        )
        customer_names = {c.id: c.name for c in cresult.scalars()}

    events = []
    for lic in licenses:
        cust = customer_names.get(lic.customer_id) or ""
        base = {
            "license_id": str(lic.id),
            "title": lic.product_name,
            "customer_name": cust,
        }
        if lic.start_date and lic.start_date.year == year:
            events.append({**base, "type": "START", "date": lic.start_date.isoformat()})
        if lic.end_date and lic.end_date.year == year:
            events.append({**base, "type": "END", "date": lic.end_date.isoformat()})
        if lic.renewal_prep_date and lic.renewal_prep_date.year == year:
            events.append({**base, "type": "RENEWAL_PREP", "date": lic.renewal_prep_date.isoformat()})
    return {"year": year, "events": events}
