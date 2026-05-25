"""직위 / 직책 마스터 API.

- `/job-ranks`     — 직위 (모든 임직원 1개 보유, 결재 hierarchy 기준)
- `/job-positions` — 직책 (선택적 job role)

권한:
- 조회: 인증된 사용자 모두 (임직원 폼 / 결재 미리보기 등)
- 변경: HR/ADMIN
"""

from __future__ import annotations

import logging
from typing import Type
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Developer, JobPosition, JobRank, User
from app.schemas.job_grade import (
    JobPositionCreate,
    JobPositionOut,
    JobPositionUpdate,
    JobRankCreate,
    JobRankOut,
    JobRankUpdate,
)

logger = logging.getLogger(__name__)


def _require_admin_or_hr(user: User) -> None:
    if user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="HR/ADMIN 만 가능합니다.")


# ---------------------------------------------------------------------------
# 직위 (JobRank)
# ---------------------------------------------------------------------------

ranks_router = APIRouter(prefix="/job-ranks", tags=["job-ranks"])


@ranks_router.get("", response_model=list[JobRankOut])
async def list_ranks(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(JobRank).order_by(JobRank.level.desc(), JobRank.sort_order.asc())
    if not include_inactive:
        stmt = stmt.where(JobRank.is_active.is_(True))
    return (await db.execute(stmt)).scalars().all()


@ranks_router.post("", response_model=JobRankOut, status_code=201)
async def create_rank(
    payload: JobRankCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = JobRank(**payload.model_dump())
    db.add(row)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    logger.info("직위 생성: id=%s name=%s level=%s", row.id, row.name, row.level)
    return row


@ranks_router.patch("/{rank_id}", response_model=JobRankOut)
async def update_rank(
    rank_id: UUID,
    payload: JobRankUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (await db.execute(select(JobRank).where(JobRank.id == rank_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="직위를 찾을 수 없습니다.")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    return row


@ranks_router.delete("/{rank_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rank(
    rank_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (await db.execute(select(JobRank).where(JobRank.id == rank_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="직위를 찾을 수 없습니다.")
    in_use = (
        await db.execute(select(Developer).where(Developer.rank_id == rank_id).limit(1))
    ).scalar_one_or_none()
    if in_use:
        raise HTTPException(
            status_code=400,
            detail="현재 사용 중인 직위는 삭제할 수 없습니다 (비활성 처리 권장).",
        )
    await db.delete(row)
    await db.commit()
    logger.warning("직위 삭제: id=%s name=%s", rank_id, row.name)


# ---------------------------------------------------------------------------
# 직책 (JobPosition)
# ---------------------------------------------------------------------------

positions_router = APIRouter(prefix="/job-positions", tags=["job-positions"])


@positions_router.get("", response_model=list[JobPositionOut])
async def list_positions(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(JobPosition).order_by(JobPosition.level.desc(), JobPosition.sort_order.asc())
    if not include_inactive:
        stmt = stmt.where(JobPosition.is_active.is_(True))
    return (await db.execute(stmt)).scalars().all()


@positions_router.post("", response_model=JobPositionOut, status_code=201)
async def create_position(
    payload: JobPositionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = JobPosition(**payload.model_dump())
    db.add(row)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    logger.info("직책 생성: id=%s name=%s level=%s", row.id, row.name, row.level)
    return row


@positions_router.patch("/{pos_id}", response_model=JobPositionOut)
async def update_position(
    pos_id: UUID,
    payload: JobPositionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (
        await db.execute(select(JobPosition).where(JobPosition.id == pos_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="직책을 찾을 수 없습니다.")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    return row


@positions_router.delete("/{pos_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_position(
    pos_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (
        await db.execute(select(JobPosition).where(JobPosition.id == pos_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="직책을 찾을 수 없습니다.")
    in_use = (
        await db.execute(select(Developer).where(Developer.position_id == pos_id).limit(1))
    ).scalar_one_or_none()
    if in_use:
        raise HTTPException(
            status_code=400,
            detail="현재 사용 중인 직책은 삭제할 수 없습니다 (비활성 처리 권장).",
        )
    await db.delete(row)
    await db.commit()
    logger.warning("직책 삭제: id=%s name=%s", pos_id, row.name)
