"""고객사 인터랙션 (통화/미팅/이메일/기타 노트) 엔드포인트.

회사 단위 자유 노트 + 첨부 1:N. 작성자(author_id) 는 토큰의
`mapped_developer_id` 로 자동 채움. 매핑이 없으면 NULL → "관리자" 로 표시.

권한:
- 읽기: 로그인 사용자 (회사 read 가능자 모두)
- 작성(POST): `customers.manage` 권한자만 — ETC 는 활동 로그 기록 불가.
- 수정·삭제: `customers.manage` 또는 작성자 본인 (기존 row 자기 정정 허용).
"""

import logging
from datetime import date, datetime
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.roles import has as role_has
from app.models import (
    Customer,
    CustomerInteraction,
    CustomerInteractionAttachment,
    Developer,
    User,
)
from app.schemas.customer_interaction import (
    ALLOWED_TYPES,
    CustomerInteractionAttachmentOut,
    CustomerInteractionCreate,
    CustomerInteractionOut,
    CustomerInteractionUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(tags=["customer-interactions"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _attach_author(rows: Iterable[CustomerInteraction]) -> None:
    """`author_name` transient 속성 채움. relationship 은 selectinload 필요."""
    for r in rows:
        r.author_name = r.author.name if r.author else None  # type: ignore[attr-defined]


def _validate_type(t: str | None) -> str | None:
    if t is None:
        return None
    if t not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid type: {t}")
    return t


async def _ensure_customer(db: AsyncSession, customer_id: UUID) -> None:
    exists = (
        await db.execute(select(Customer.id).where(Customer.id == customer_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="Customer not found")


async def _load_interaction(
    db: AsyncSession, interaction_id: UUID
) -> CustomerInteraction:
    row = (
        await db.execute(
            select(CustomerInteraction)
            .options(
                selectinload(CustomerInteraction.attachments),
                selectinload(CustomerInteraction.author),
            )
            .where(CustomerInteraction.id == interaction_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Interaction not found")
    return row


def _can_modify(user: User, interaction: CustomerInteraction) -> bool:
    """작성자 본인 OR customers.manage 권한자."""
    if role_has(user.role, "customers.manage"):
        return True
    return (
        user.mapped_developer_id is not None
        and interaction.author_id == user.mapped_developer_id
    )


# ---------------------------------------------------------------------------
# LIST / CREATE
# ---------------------------------------------------------------------------


@router.get(
    "/customers/{customer_id}/interactions",
    response_model=list[CustomerInteractionOut],
)
async def list_interactions(
    customer_id: UUID,
    type: str | None = None,
    author_id: str | None = None,  # `me` | UUID
    date_from: date | None = None,
    date_to: date | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_customer(db, customer_id)
    stmt = (
        select(CustomerInteraction)
        .options(
            selectinload(CustomerInteraction.attachments),
            selectinload(CustomerInteraction.author),
        )
        .where(CustomerInteraction.customer_id == customer_id)
    )
    if type:
        stmt = stmt.where(CustomerInteraction.type == _validate_type(type))
    if author_id:
        if author_id == "me":
            if not user.mapped_developer_id:
                return []
            stmt = stmt.where(
                CustomerInteraction.author_id == user.mapped_developer_id
            )
        else:
            try:
                aid = UUID(author_id)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid author_id") from exc
            stmt = stmt.where(CustomerInteraction.author_id == aid)
    if date_from:
        stmt = stmt.where(
            CustomerInteraction.occurred_at
            >= datetime.combine(date_from, datetime.min.time())
        )
    if date_to:
        stmt = stmt.where(
            CustomerInteraction.occurred_at
            < datetime.combine(date_to, datetime.max.time())
        )
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            (CustomerInteraction.title.ilike(pattern))
            | (CustomerInteraction.body.ilike(pattern))
        )
    stmt = (
        stmt.order_by(CustomerInteraction.occurred_at.desc())
        .limit(min(max(limit, 1), 200))
        .offset(max(offset, 0))
    )
    rows = list((await db.execute(stmt)).scalars().all())
    _attach_author(rows)
    return rows


@router.post(
    "/customers/{customer_id}/interactions",
    response_model=CustomerInteractionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_interaction(
    customer_id: UUID,
    payload: CustomerInteractionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not role_has(user.role, "customers.manage"):
        raise HTTPException(status_code=403, detail="권한 없음 (customers.manage)")
    await _ensure_customer(db, customer_id)
    _validate_type(payload.type)
    interaction = CustomerInteraction(
        customer_id=customer_id,
        type=payload.type,
        occurred_at=payload.occurred_at,
        title=payload.title.strip(),
        body=payload.body,
        participants=payload.participants,
        follow_up_at=payload.follow_up_at,
        author_id=user.mapped_developer_id,
    )
    db.add(interaction)
    await db.commit()
    await db.refresh(interaction, attribute_names=["attachments", "author"])
    _attach_author([interaction])
    logger.info(
        "고객 인터랙션 등록: customer_id=%s id=%s type=%s (작성자=%s)",
        customer_id,
        interaction.id,
        interaction.type,
        user.id,
    )
    return interaction


# ---------------------------------------------------------------------------
# single — GET / PATCH / DELETE
# ---------------------------------------------------------------------------


@router.get(
    "/customer-interactions/{interaction_id}",
    response_model=CustomerInteractionOut,
)
async def get_interaction(
    interaction_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    interaction = await _load_interaction(db, interaction_id)
    _attach_author([interaction])
    return interaction


@router.patch(
    "/customer-interactions/{interaction_id}",
    response_model=CustomerInteractionOut,
)
async def update_interaction(
    interaction_id: UUID,
    payload: CustomerInteractionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    interaction = await _load_interaction(db, interaction_id)
    if not _can_modify(user, interaction):
        raise HTTPException(status_code=403, detail="권한 없음")
    data = payload.model_dump(exclude_unset=True)
    if "type" in data:
        _validate_type(data["type"])
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    for k, v in data.items():
        setattr(interaction, k, v)
    await db.commit()
    await db.refresh(interaction, attribute_names=["attachments", "author"])
    _attach_author([interaction])
    return interaction


@router.delete(
    "/customer-interactions/{interaction_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_interaction(
    interaction_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    interaction = await _load_interaction(db, interaction_id)
    if not _can_modify(user, interaction):
        raise HTTPException(status_code=403, detail="권한 없음")
    # CASCADE 가 attachment row 를 지우지만 디스크 파일은 따로 정리.
    for att in interaction.attachments:
        delete_file(att.file_path)
    await db.delete(interaction)
    await db.commit()
    logger.warning(
        "고객 인터랙션 삭제: id=%s customer_id=%s (삭제자=%s)",
        interaction.id,
        interaction.customer_id,
        user.id,
    )


# ---------------------------------------------------------------------------
# attachments
# ---------------------------------------------------------------------------


@router.post(
    "/customer-interactions/{interaction_id}/attachments",
    response_model=CustomerInteractionAttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_interaction_attachment(
    interaction_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    interaction = await _load_interaction(db, interaction_id)
    if not _can_modify(user, interaction):
        raise HTTPException(status_code=403, detail="권한 없음")
    stored, size = await save_upload(
        file, f"customers/{interaction.customer_id}/interactions/{interaction_id}"
    )
    att = CustomerInteractionAttachment(
        interaction_id=interaction_id,
        file_name=file.filename or "upload.bin",
        file_path=stored,
        mime_type=file.content_type,
        size=size,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return att


@router.delete(
    "/customer-interaction-attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_interaction_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    att = (
        await db.execute(
            select(CustomerInteractionAttachment).where(
                CustomerInteractionAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    interaction = await _load_interaction(db, att.interaction_id)
    if not _can_modify(user, interaction):
        raise HTTPException(status_code=403, detail="권한 없음")
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()


@router.get("/customer-interaction-attachments/{attachment_id}/download")
async def download_interaction_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    att = (
        await db.execute(
            select(CustomerInteractionAttachment).where(
                CustomerInteractionAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404, detail="파일이 디스크에 존재하지 않습니다."
        )
    return FileResponse(
        str(abs_path),
        filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )
