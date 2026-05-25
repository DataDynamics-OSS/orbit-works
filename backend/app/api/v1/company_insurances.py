"""법인 보험 CRUD + 첨부파일(자유 다파일) 업로드/수정/삭제."""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import CompanyInsurance, CompanyInsuranceAttachment, User
from app.schemas.company_insurance import (
    CompanyInsuranceAttachmentOut,
    CompanyInsuranceAttachmentUpdate,
    CompanyInsuranceCreate,
    CompanyInsuranceOut,
    CompanyInsuranceUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/company-insurances", tags=["company-insurances"])


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[CompanyInsuranceOut])
async def list_insurances(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(CompanyInsurance)
                .options(selectinload(CompanyInsurance.attachments))
                .order_by(CompanyInsurance.insurer.asc(), CompanyInsurance.name.asc())
            )
        ).scalars()
    )
    return rows


@router.post(
    "", response_model=CompanyInsuranceOut, status_code=status.HTTP_201_CREATED
)
async def create_insurance(
    payload: CompanyInsuranceCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ins = CompanyInsurance(**payload.model_dump())
    db.add(ins)
    await db.commit()
    await db.refresh(ins, attribute_names=["attachments"])
    logger.info(
        "보험 등록: id=%s %s / %s (작성자=%s)",
        ins.id, ins.insurer, ins.name, user.id,
    )
    return ins


@router.get("/{insurance_id}", response_model=CompanyInsuranceOut)
async def get_insurance(
    insurance_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    ins = (
        await db.execute(
            select(CompanyInsurance)
            .options(selectinload(CompanyInsurance.attachments))
            .where(CompanyInsurance.id == insurance_id)
        )
    ).scalar_one_or_none()
    if not ins:
        raise HTTPException(status_code=404, detail="Insurance not found")
    return ins


@router.patch("/{insurance_id}", response_model=CompanyInsuranceOut)
async def update_insurance(
    insurance_id: UUID,
    payload: CompanyInsuranceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ins = (
        await db.execute(
            select(CompanyInsurance)
            .options(selectinload(CompanyInsurance.attachments))
            .where(CompanyInsurance.id == insurance_id)
        )
    ).scalar_one_or_none()
    if not ins:
        raise HTTPException(status_code=404, detail="Insurance not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(ins, k, v)
    await db.commit()
    await db.refresh(ins, attribute_names=["attachments"])
    logger.info("보험 수정: id=%s 필드=%s 수정자=%s", ins.id, list(data.keys()), user.id)
    return ins


@router.delete("/{insurance_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_insurance(
    insurance_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ins = (
        await db.execute(
            select(CompanyInsurance)
            .options(selectinload(CompanyInsurance.attachments))
            .where(CompanyInsurance.id == insurance_id)
        )
    ).scalar_one_or_none()
    if not ins:
        raise HTTPException(status_code=404, detail="Insurance not found")
    for att in ins.attachments:
        delete_file(att.file_path)
    await db.delete(ins)
    await db.commit()
    logger.info(
        "보험 삭제: id=%s %s / %s 삭제자=%s",
        ins.id, ins.insurer, ins.name, user.id,
    )


# ---------------------------------------------------------------------------
# 첨부파일 (자유 다파일)
# ---------------------------------------------------------------------------


@router.post(
    "/{insurance_id}/attachments",
    response_model=CompanyInsuranceAttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_insurance_attachment(
    insurance_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    ins = (
        await db.execute(
            select(CompanyInsurance).where(CompanyInsurance.id == insurance_id)
        )
    ).scalar_one_or_none()
    if not ins:
        raise HTTPException(status_code=404, detail="Insurance not found")
    stored, size = await save_upload(file, f"company-insurances/{insurance_id}")
    row = CompanyInsuranceAttachment(
        insurance_id=insurance_id,
        file_name=file.filename or Path(stored).name,
        file_path=stored,
        mime_type=file.content_type,
        size=size,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/attachments/{attachment_id}/download")
async def download_insurance_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(CompanyInsuranceAttachment).where(
                CompanyInsuranceAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    abs_path = resolve_upload_path(row.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404, detail="파일이 디스크에 존재하지 않습니다."
        )
    return FileResponse(
        str(abs_path),
        filename=row.file_name,
        media_type=row.mime_type or "application/octet-stream",
    )


@router.patch(
    "/attachments/{attachment_id}",
    response_model=CompanyInsuranceAttachmentOut,
)
async def rename_insurance_attachment(
    attachment_id: UUID,
    payload: CompanyInsuranceAttachmentUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """표시 파일명만 변경 — 실제 파일 경로는 유지."""
    row = (
        await db.execute(
            select(CompanyInsuranceAttachment).where(
                CompanyInsuranceAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete(
    "/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_insurance_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(CompanyInsuranceAttachment).where(
                CompanyInsuranceAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    delete_file(row.file_path)
    await db.delete(row)
    await db.commit()
