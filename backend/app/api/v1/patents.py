"""특허 (Patent) — CRUD + 다중 첨부.

권한: `patents.manage` (SALES + HR + ADMIN). 단순 관리용 — 프로젝트 연결·만료
알림은 미포함. 상태(FILED/REGISTERED) 자동 전환 X — 사용자 수동.

첨부는 Loan 과 동일 패턴 — 1:N. 파일명 변경은 PATCH (디스크 파일은 UUID 고정,
사용자가 보는 filename 만 갱신).
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import Patent, PatentAttachment, User
from app.schemas.patent import (
    PatentAttachmentOut,
    PatentAttachmentRename,
    PatentCreate,
    PatentOut,
    PatentUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/patents", tags=["patents"])


def _to_out(row: Patent) -> PatentOut:
    out = PatentOut.model_validate(row, from_attributes=True)
    out.attachment_count = len(row.attachments or [])
    out.attachments = [
        PatentAttachmentOut.model_validate(a, from_attributes=True)
        for a in (row.attachments or [])
    ]
    return out


async def _load(db: AsyncSession, patent_id: UUID) -> Patent:
    row = (
        await db.execute(
            select(Patent)
            .options(selectinload(Patent.attachments))
            .where(Patent.id == patent_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="특허를 찾을 수 없습니다.")
    return row


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[PatentOut])
async def list_patents(
    status_filter: str | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("patents.manage")),
):
    """필터: status (FILED/REGISTERED), q (특허명·번호·발명자 검색)."""
    stmt = (
        select(Patent)
        .options(selectinload(Patent.attachments))
        .order_by(Patent.created_at.desc())
    )
    if status_filter in ("FILED", "REGISTERED"):
        stmt = stmt.where(Patent.status == status_filter)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            or_(
                Patent.title.ilike(like),
                Patent.application_no.ilike(like),
                Patent.patent_no.ilike(like),
                Patent.inventors.ilike(like),
                Patent.patent_holder.ilike(like),
            )
        )
    rows = list((await db.execute(stmt)).scalars())
    return [_to_out(r) for r in rows]


@router.post("", response_model=PatentOut, status_code=status.HTTP_201_CREATED)
async def create_patent(
    payload: PatentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("patents.manage")),
):
    row = Patent(**payload.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row, attribute_names=["attachments"])
    logger.info("특허 등록: id=%s title=%s 작성자=%s", row.id, row.title, user.id)
    return _to_out(row)


@router.get("/{patent_id}", response_model=PatentOut)
async def get_patent(
    patent_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("patents.manage")),
):
    return _to_out(await _load(db, patent_id))


@router.patch("/{patent_id}", response_model=PatentOut)
async def update_patent(
    patent_id: UUID,
    payload: PatentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("patents.manage")),
):
    row = await _load(db, patent_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row, attribute_names=["attachments"])
    logger.info(
        "특허 수정: id=%s 변경=%s 수정자=%s", row.id, list(data.keys()), user.id
    )
    return _to_out(row)


@router.delete("/{patent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_patent(
    patent_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("patents.manage")),
):
    row = await _load(db, patent_id)
    # 첨부 파일들 디스크에서 제거 (cascade 가 row 는 지우지만 디스크 파일은 별도).
    for att in row.attachments:
        delete_file(att.path)
    await db.delete(row)
    await db.commit()
    logger.warning("특허 삭제: id=%s title=%s 실행자=%s", row.id, row.title, user.id)


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post(
    "/{patent_id}/attachments",
    response_model=PatentAttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    patent_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("patents.manage")),
):
    exists = (
        await db.execute(select(Patent.id).where(Patent.id == patent_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="특허를 찾을 수 없습니다.")
    stored, size = await save_upload(file, f"patents/{patent_id}")
    att = PatentAttachment(
        patent_id=patent_id,
        filename=file.filename or "upload.bin",
        path=stored,
        mime_type=file.content_type,
        file_size=size,
        uploaded_by=user.id,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    logger.info(
        "특허 첨부 업로드: patent_id=%s file=%s size=%s 업로드자=%s",
        patent_id, att.filename, size, user.id,
    )
    return att


@router.patch(
    "/attachments/{attachment_id}", response_model=PatentAttachmentOut
)
async def rename_attachment(
    attachment_id: UUID,
    payload: PatentAttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("patents.manage")),
):
    """표시 파일명만 변경. 디스크 실제 파일명(UUID) 그대로."""
    att = (
        await db.execute(
            select(PatentAttachment).where(PatentAttachment.id == attachment_id)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    att.filename = payload.filename.strip()
    await db.commit()
    await db.refresh(att)
    logger.info("특허 첨부 이름 변경: id=%s → %s 수정자=%s", attachment_id, att.filename, user.id)
    return att


@router.delete(
    "/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("patents.manage")),
):
    att = (
        await db.execute(
            select(PatentAttachment).where(PatentAttachment.id == attachment_id)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    delete_file(att.path)
    await db.delete(att)
    await db.commit()
    logger.info("특허 첨부 삭제: id=%s 실행자=%s", attachment_id, user.id)


@router.get("/attachments/{attachment_id}/download")
async def download_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("patents.manage")),
):
    att = (
        await db.execute(
            select(PatentAttachment).where(PatentAttachment.id == attachment_id)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404, detail="파일이 디스크에 존재하지 않습니다."
        )
    return FileResponse(
        str(abs_path),
        filename=att.filename,
        media_type=att.mime_type or "application/octet-stream",
    )
