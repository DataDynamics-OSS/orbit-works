"""임직원 면담 기록 API.

- HR / ADMIN / SUPER_ADMIN 만 조회 / 작성. 본인 작성 코멘트 + ADMIN 만 수정·삭제.
- 1직원 = N개 면담 기록. 작성 순서대로 표시.
- 본인(=mapped_developer_id) 일지라도 본인 면담은 비공개 (HR 평가 보호).
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, has_feature
from app.core.database import get_db
from app.models import Developer, DeveloperInterview, User
from app.schemas.developer_interview import (
    DeveloperInterviewIn,
    DeveloperInterviewOut,
)

router = APIRouter(prefix="/developers", tags=["developer-interviews"])
logger = logging.getLogger(__name__)


async def _ensure_can_view(db: AsyncSession, user: User) -> None:
    """면담 열람 권한 — `employees.tab.interview` 기능. 본인 예외 없음 (HR 평가 보호)."""
    if not await has_feature(db, user, "employees.tab.interview"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="면담 기록 권한 없음",
        )


def _ensure_can_edit(user: User, row: DeveloperInterview) -> None:
    """본인(작성자) 또는 ADMIN/SUPER_ADMIN 만 수정·삭제."""
    if user.role in ("ADMIN", "SUPER_ADMIN"):
        return
    if row.author_user_id is not None and row.author_user_id == user.id:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="면담 코멘트 권한 없음"
    )


async def _developer_or_404(db: AsyncSession, dev_id: UUID) -> Developer:
    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="임직원을 찾을 수 없습니다.")
    return dev


async def _serialize(
    db: AsyncSession, rows: list[DeveloperInterview]
) -> list[DeveloperInterviewOut]:
    """author_user_id → user.name 을 join 으로 채워 응답."""
    user_ids = {r.author_user_id for r in rows if r.author_user_id}
    name_by: dict[UUID, str] = {}
    if user_ids:
        result = await db.execute(
            select(User.id, User.name).where(User.id.in_(user_ids))
        )
        name_by = {uid: nm for uid, nm in result.all()}
    return [
        DeveloperInterviewOut(
            id=r.id,
            developer_id=r.developer_id,
            author_user_id=r.author_user_id,
            author_name=name_by.get(r.author_user_id) if r.author_user_id else None,
            body=r.body,
            created_at=r.created_at,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.get(
    "/{dev_id}/interviews", response_model=list[DeveloperInterviewOut]
)
async def list_interviews(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_view(db, user)
    await _developer_or_404(db, dev_id)
    rows = list(
        (
            await db.execute(
                select(DeveloperInterview)
                .where(DeveloperInterview.developer_id == dev_id)
                .order_by(DeveloperInterview.created_at.desc())
            )
        ).scalars()
    )
    return await _serialize(db, rows)


@router.post(
    "/{dev_id}/interviews",
    response_model=DeveloperInterviewOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_interview(
    dev_id: UUID,
    payload: DeveloperInterviewIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_view(db, user)
    await _developer_or_404(db, dev_id)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="면담 내용이 비어 있습니다.")
    row = DeveloperInterview(developer_id=dev_id, author_user_id=user.id, body=body)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("면담 추가: dev=%s by=%s", dev_id, user.id)
    return (await _serialize(db, [row]))[0]


@router.patch(
    "/{dev_id}/interviews/{interview_id}", response_model=DeveloperInterviewOut
)
async def edit_interview(
    dev_id: UUID,
    interview_id: UUID,
    payload: DeveloperInterviewIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_view(db, user)
    row = (
        await db.execute(
            select(DeveloperInterview).where(
                DeveloperInterview.id == interview_id,
                DeveloperInterview.developer_id == dev_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="면담을 찾을 수 없습니다.")
    _ensure_can_edit(user, row)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="면담 내용이 비어 있습니다.")
    row.body = body
    await db.commit()
    await db.refresh(row)
    logger.info("면담 수정: dev=%s id=%s by=%s", dev_id, interview_id, user.id)
    return (await _serialize(db, [row]))[0]


@router.delete(
    "/{dev_id}/interviews/{interview_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_interview(
    dev_id: UUID,
    interview_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_view(db, user)
    row = (
        await db.execute(
            select(DeveloperInterview).where(
                DeveloperInterview.id == interview_id,
                DeveloperInterview.developer_id == dev_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="면담을 찾을 수 없습니다.")
    _ensure_can_edit(user, row)
    await db.delete(row)
    await db.commit()
    logger.warning("면담 삭제: dev=%s id=%s by=%s", dev_id, interview_id, user.id)
