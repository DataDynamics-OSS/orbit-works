"""법인 차량 CRUD + 첨부파일 (보험증서·등록증) 업로드/수정/삭제."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import CompanyCar, CompanyCarAttachment, Developer, User
from app.schemas.company_car import (
    CompanyCarAttachmentOut,
    CompanyCarAttachmentUpdate,
    CompanyCarCreate,
    CompanyCarOut,
    CompanyCarUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload_as

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/company-cars", tags=["company-cars"])


_SLOTS: dict[str, str] = {
    "INSURANCE": "보험증서",
    "REGISTRATION": "자동차등록증",
}


async def _enrich(db: AsyncSession, car: CompanyCar) -> CompanyCarOut:
    manager_name: str | None = None
    if car.manager_id:
        mgr = (
            await db.execute(select(Developer).where(Developer.id == car.manager_id))
        ).scalar_one_or_none()
        if mgr:
            manager_name = mgr.name
    out = CompanyCarOut.model_validate(car)
    out.manager_name = manager_name
    return out


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[CompanyCarOut])
async def list_cars(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(CompanyCar)
                .options(selectinload(CompanyCar.attachments))
                .order_by(CompanyCar.manufacturer.asc(), CompanyCar.model.asc())
            )
        ).scalars()
    )
    # 관리자 이름 한 번에 모으기 — N+1 회피.
    manager_ids = {c.manager_id for c in rows if c.manager_id}
    names: dict[UUID, str] = {}
    if manager_ids:
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(manager_ids)))
        ).scalars():
            names[d.id] = d.name
    out: list[CompanyCarOut] = []
    for c in rows:
        o = CompanyCarOut.model_validate(c)
        o.manager_name = names.get(c.manager_id) if c.manager_id else None
        out.append(o)
    return out


@router.post("", response_model=CompanyCarOut, status_code=status.HTTP_201_CREATED)
async def create_car(
    payload: CompanyCarCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    car = CompanyCar(**payload.model_dump())
    db.add(car)
    await db.commit()
    await db.refresh(car, attribute_names=["attachments"])
    logger.info(
        "차량 등록: id=%s %s %s (%s) 작성자=%s",
        car.id, car.manufacturer, car.model, car.plate_no or "-", user.id,
    )
    return await _enrich(db, car)


@router.get("/{car_id}", response_model=CompanyCarOut)
async def get_car(
    car_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    car = (
        await db.execute(
            select(CompanyCar)
            .options(selectinload(CompanyCar.attachments))
            .where(CompanyCar.id == car_id)
        )
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    return await _enrich(db, car)


@router.patch("/{car_id}", response_model=CompanyCarOut)
async def update_car(
    car_id: UUID,
    payload: CompanyCarUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    car = (
        await db.execute(
            select(CompanyCar)
            .options(selectinload(CompanyCar.attachments))
            .where(CompanyCar.id == car_id)
        )
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(car, k, v)
    await db.commit()
    await db.refresh(car, attribute_names=["attachments"])
    logger.info("차량 수정: id=%s 필드=%s 수정자=%s", car.id, list(data.keys()), user.id)
    return await _enrich(db, car)


@router.delete("/{car_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_car(
    car_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    car = (
        await db.execute(
            select(CompanyCar)
            .options(selectinload(CompanyCar.attachments))
            .where(CompanyCar.id == car_id)
        )
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    for att in car.attachments:
        delete_file(att.file_path)
    await db.delete(car)
    await db.commit()
    logger.info("차량 삭제: id=%s %s %s 삭제자=%s", car.id, car.manufacturer, car.model, user.id)


# ---------------------------------------------------------------------------
# 첨부파일 — 프로젝트 첨부와 동일한 slot 기반 패턴
# ---------------------------------------------------------------------------


def _check_slot(slot: str) -> None:
    if slot not in _SLOTS:
        raise HTTPException(
            status_code=400, detail=f"Unknown slot: {slot} (allowed: {list(_SLOTS)})"
        )


@router.post(
    "/{car_id}/attachments/{slot}",
    response_model=CompanyCarAttachmentOut,
)
async def upload_car_attachment(
    car_id: UUID,
    slot: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    _check_slot(slot)
    car = (
        await db.execute(select(CompanyCar).where(CompanyCar.id == car_id))
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    # 동일 slot 기존 row/파일 제거 후 교체 (slot=UNIQUE 제약).
    existing = (
        await db.execute(
            select(CompanyCarAttachment).where(
                CompanyCarAttachment.car_id == car_id,
                CompanyCarAttachment.slot == slot,
            )
        )
    ).scalar_one_or_none()
    if existing:
        delete_file(existing.file_path)
        await db.delete(existing)
        await db.flush()
    stored, size = await save_upload_as(file, f"company-cars/{car_id}", _SLOTS[slot])
    row = CompanyCarAttachment(
        car_id=car_id,
        slot=slot,
        file_name=file.filename or Path(stored).name,
        file_path=stored,
        mime_type=file.content_type,
        size=size,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/{car_id}/attachments/{slot}")
async def download_car_attachment(
    car_id: UUID,
    slot: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    _check_slot(slot)
    row = (
        await db.execute(
            select(CompanyCarAttachment).where(
                CompanyCarAttachment.car_id == car_id,
                CompanyCarAttachment.slot == slot,
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
    "/{car_id}/attachments/{slot}",
    response_model=CompanyCarAttachmentOut,
)
async def rename_car_attachment(
    car_id: UUID,
    slot: str,
    payload: CompanyCarAttachmentUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """표시 파일명만 변경. 실제 파일 경로는 유지."""
    _check_slot(slot)
    row = (
        await db.execute(
            select(CompanyCarAttachment).where(
                CompanyCarAttachment.car_id == car_id,
                CompanyCarAttachment.slot == slot,
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
    "/{car_id}/attachments/{slot}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_car_attachment(
    car_id: UUID,
    slot: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    _check_slot(slot)
    row = (
        await db.execute(
            select(CompanyCarAttachment).where(
                CompanyCarAttachment.car_id == car_id,
                CompanyCarAttachment.slot == slot,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    delete_file(row.file_path)
    await db.delete(row)
    await db.commit()
