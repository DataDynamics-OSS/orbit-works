"""매입 인보이스 (VendorBill) API.

Endpoints:
- `GET    /vendor-bills`                     목록 (필터: vendor·category·payment_status·기간)
- `GET    /vendor-bills/{id}`                단건
- `POST   /vendor-bills`                     생성
- `PATCH  /vendor-bills/{id}`                수정
- `DELETE /vendor-bills/{id}`                삭제
- `POST   /vendor-bills/{id}/attachments`    영수증 추가 (한 번에 여러 파일)
- `GET    /vendor-bills/{id}/attachments/{att_id}`    개별 파일 다운로드
- `DELETE /vendor-bills/{id}/attachments/{att_id}`    개별 파일 삭제

권한: 조회·관리 모두 `vendor_bills.manage` (HR + ADMIN).
"""

from __future__ import annotations

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import User, VendorBill, VendorBillAttachment
from app.schemas.vendor_bill import (
    PaymentStatus,
    VendorBillAttachmentOut,
    VendorBillCategory,
    VendorBillCreate,
    VendorBillOut,
    VendorBillUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/vendor-bills", tags=["vendor-bills"])


_ATTACH_ALLOWED_MIME = {
    "application/pdf",
    "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic",
}


def _to_out(b: VendorBill) -> VendorBillOut:
    return VendorBillOut(
        id=b.id,
        vendor_name=b.vendor_name,
        vendor_biz_no=b.vendor_biz_no,
        customer_id=b.customer_id,
        delivery_customer_id=b.delivery_customer_id,
        quote_id=b.quote_id,
        project_id=b.project_id,
        title=b.title,
        invoice_no=b.invoice_no,
        po_no=b.po_no,
        sales_order_no=b.sales_order_no,
        bill_date=b.bill_date,
        due_date=b.due_date,
        category=b.category,  # type: ignore[arg-type]
        currency=b.currency,
        tax_mode=b.tax_mode,  # type: ignore[arg-type]
        amount=b.amount,
        tax_amount=b.tax_amount,
        total_amount=b.total_amount,
        payment_status=b.payment_status,  # type: ignore[arg-type]
        paid_amount=b.paid_amount,
        paid_at=b.paid_at,
        memo=b.memo,
        linked_tax_invoice_id=b.linked_tax_invoice_id,
        linked_bank_transaction_id=b.linked_bank_transaction_id,
        attachments=[VendorBillAttachmentOut.model_validate(a) for a in (b.attachments or [])],
        created_at=b.created_at,
        updated_at=b.updated_at,
        created_by=b.created_by,
    )


async def _get_or_404(db: AsyncSession, bill_id: UUID) -> VendorBill:
    row = (
        await db.execute(
            select(VendorBill)
            .options(selectinload(VendorBill.attachments))
            .where(VendorBill.id == bill_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="매입 인보이스를 찾을 수 없습니다.")
    return row


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[VendorBillOut])
async def list_bills(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("vendor_bills.manage")),
    vendor: str | None = None,
    customer_id: UUID | None = None,
    category: VendorBillCategory | None = None,
    payment_status: PaymentStatus | None = None,
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
):
    q = (
        select(VendorBill)
        .options(selectinload(VendorBill.attachments))
        .order_by(VendorBill.bill_date.desc(), VendorBill.created_at.desc())
    )
    if vendor:
        q = q.where(VendorBill.vendor_name.ilike(f"%{vendor}%"))
    if customer_id:
        q = q.where(VendorBill.customer_id == customer_id)
    if category:
        q = q.where(VendorBill.category == category)
    if payment_status:
        q = q.where(VendorBill.payment_status == payment_status)
    if from_:
        q = q.where(VendorBill.bill_date >= from_)
    if to:
        q = q.where(VendorBill.bill_date <= to)
    rows = list((await db.execute(q)).scalars())
    return [_to_out(r) for r in rows]


@router.get("/{bill_id}", response_model=VendorBillOut)
async def get_bill(
    bill_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("vendor_bills.manage")),
):
    return _to_out(await _get_or_404(db, bill_id))


@router.post("", response_model=VendorBillOut, status_code=status.HTTP_201_CREATED)
async def create_bill(
    payload: VendorBillCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("vendor_bills.manage")),
):
    row = VendorBill(
        vendor_name=payload.vendor_name,
        vendor_biz_no=payload.vendor_biz_no,
        customer_id=payload.customer_id,
        delivery_customer_id=payload.delivery_customer_id,
        quote_id=payload.quote_id,
        project_id=payload.project_id,
        title=payload.title,
        invoice_no=payload.invoice_no,
        po_no=payload.po_no,
        sales_order_no=payload.sales_order_no,
        bill_date=payload.bill_date,
        due_date=payload.due_date,
        category=payload.category,
        currency=payload.currency,
        tax_mode=payload.tax_mode,
        amount=payload.amount,
        tax_amount=payload.tax_amount,
        payment_status=payload.payment_status,
        paid_amount=payload.paid_amount,
        paid_at=payload.paid_at,
        memo=payload.memo,
        linked_tax_invoice_id=payload.linked_tax_invoice_id,
        linked_bank_transaction_id=payload.linked_bank_transaction_id,
        created_by=user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row, attribute_names=["total_amount", "attachments"])
    logger.info("매입 인보이스 생성: id=%s vendor=%s amount=%s", row.id, row.vendor_name, row.amount)
    return _to_out(row)


@router.patch("/{bill_id}", response_model=VendorBillOut)
async def update_bill(
    bill_id: UUID,
    payload: VendorBillUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("vendor_bills.manage")),
):
    row = await _get_or_404(db, bill_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    # total_amount 는 PostgreSQL GENERATED 컬럼 — UPDATE 후 SQLAlchemy 가 stale
    # 로 마크하므로 함께 refresh 해야 _to_out 의 동기 접근이 IO 를 트리거하지 않는다.
    await db.refresh(row, attribute_names=["total_amount", "attachments"])
    logger.info(
        "매입 인보이스 수정: id=%s 변경필드=%s (수정자=%s)",
        bill_id, list(data.keys()), user.id,
    )
    return _to_out(row)


@router.delete("/{bill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bill(
    bill_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("vendor_bills.manage")),
):
    row = await _get_or_404(db, bill_id)
    att_count = len(row.attachments or [])
    # 디스크 정리 — DB cascade 는 row 만 지움.
    for att in row.attachments or []:
        delete_file(att.file_path)
    await db.delete(row)
    await db.commit()
    logger.info(
        "매입 인보이스 삭제: id=%s vendor=%s 첨부=%d (삭제자=%s)",
        bill_id, row.vendor_name, att_count, user.id,
    )


# ---------------------------------------------------------------------------
# Attachments (multi)
# ---------------------------------------------------------------------------


@router.post("/{bill_id}/attachments", response_model=VendorBillOut)
async def upload_attachments(
    bill_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("vendor_bills.manage")),
):
    """1회 호출에 여러 파일 첨부. 기존 첨부는 유지 — 누적."""
    row = await _get_or_404(db, bill_id)
    if not files:
        raise HTTPException(status_code=400, detail="업로드할 파일이 없습니다.")

    total_size = 0
    for f in files:
        mime = (f.content_type or "").lower()
        if mime not in _ATTACH_ALLOWED_MIME:
            raise HTTPException(
                status_code=400,
                detail=f"지원하지 않는 형식: {f.filename} ({mime}). PDF / JPEG / PNG / WebP / GIF / HEIC 만 허용.",
            )
        path, size = await save_upload(f, f"vendor_bills/{row.id}")
        total_size += size
        db.add(VendorBillAttachment(
            bill_id=row.id,
            file_name=f.filename or "attachment",
            file_path=path,
            mime_type=mime,
            size=size,
        ))
    await db.commit()
    await db.refresh(row, attribute_names=["attachments"])
    logger.info(
        "매입 인보이스 첨부 추가: bill_id=%s files=%d total_size=%dKB (업로드자=%s)",
        bill_id, len(files), total_size // 1024, user.id,
    )
    return _to_out(row)


@router.get("/{bill_id}/attachments/{att_id}")
async def download_attachment(
    bill_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("vendor_bills.manage")),
):
    att = (await db.execute(
        select(VendorBillAttachment)
        .where(VendorBillAttachment.id == att_id, VendorBillAttachment.bill_id == bill_id)
    )).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        media_type=att.mime_type or "application/octet-stream",
        filename=att.file_name,
    )


@router.delete("/{bill_id}/attachments/{att_id}", response_model=VendorBillOut)
async def delete_attachment(
    bill_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("vendor_bills.manage")),
):
    att = (await db.execute(
        select(VendorBillAttachment)
        .where(VendorBillAttachment.id == att_id, VendorBillAttachment.bill_id == bill_id)
    )).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    row = await _get_or_404(db, bill_id)
    return _to_out(row)
