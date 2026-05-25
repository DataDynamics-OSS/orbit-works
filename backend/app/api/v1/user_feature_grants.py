"""사용자별 feature grant CRUD.

ADMIN/SUPER_ADMIN 만 부여/해제 가능. 본인 grant 조회는 모든 user 허용
(UI 에서 "내가 추가로 받은 권한" 표시 등 향후 활용).

부여 가능 키는 `KNOWN_GRANTABLE_FEATURES` 카탈로그에 등록된 것만.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.core.grantable_features import KNOWN_GRANTABLE_FEATURES, is_grantable
from app.models import User, UserFeatureGrant
from app.schemas.user_feature_grant import (
    GrantableFeatureOut,
    UserFeatureGrantCreate,
    UserFeatureGrantOut,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/user-feature-grants", tags=["user-feature-grants"])


@router.get("/catalog", response_model=list[GrantableFeatureOut])
async def list_catalog(
    _user: User = Depends(get_current_user),
):
    """부여 가능한 feature 카탈로그 — UI 의 부여 선택지."""
    return [
        GrantableFeatureOut(feature_key=k, label=v)
        for k, v in KNOWN_GRANTABLE_FEATURES.items()
    ]


@router.get("/me", response_model=list[UserFeatureGrantOut])
async def list_my_grants(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 grants — UI 에서 "내가 받은 추가 권한" 표시용."""
    rows = await db.execute(
        select(UserFeatureGrant)
        .where(
            UserFeatureGrant.tenant_id == user.tenant_id,
            UserFeatureGrant.user_id == user.id,
        )
        .order_by(UserFeatureGrant.granted_at.desc())
    )
    return list(rows.scalars().all())


@router.get("", response_model=list[UserFeatureGrantOut])
async def list_grants(
    user_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """특정 user 의 grants. user_id 미지정 시 tenant 전체."""
    stmt = select(UserFeatureGrant).where(
        UserFeatureGrant.tenant_id == admin.tenant_id,
    )
    if user_id is not None:
        stmt = stmt.where(UserFeatureGrant.user_id == user_id)
    stmt = stmt.order_by(UserFeatureGrant.granted_at.desc())
    rows = await db.execute(stmt)
    return list(rows.scalars().all())


@router.post(
    "", response_model=UserFeatureGrantOut, status_code=status.HTTP_201_CREATED,
)
async def create_grant(
    payload: UserFeatureGrantCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """grant 부여. idempotent — 같은 (user, feature) 가 이미 있으면 200 처럼 그대로."""
    if not is_grantable(payload.feature_key):
        raise HTTPException(
            status_code=400,
            detail=f"등록되지 않은 feature_key: {payload.feature_key}",
        )
    # 대상 user 가 같은 tenant 인지 확인 — 다른 tenant 의 user 에 grant 부여 차단.
    target = await db.execute(
        select(User).where(
            User.id == payload.user_id,
            User.tenant_id == admin.tenant_id,
        )
    )
    if target.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="대상 user 를 찾을 수 없습니다.")

    # 이미 존재하면 그대로 반환 (idempotent).
    existing = await db.execute(
        select(UserFeatureGrant).where(
            UserFeatureGrant.tenant_id == admin.tenant_id,
            UserFeatureGrant.user_id == payload.user_id,
            UserFeatureGrant.feature_key == payload.feature_key,
        )
    )
    row = existing.scalar_one_or_none()
    if row is not None:
        return row

    row = UserFeatureGrant(
        tenant_id=admin.tenant_id,
        user_id=payload.user_id,
        feature_key=payload.feature_key,
        granted_by_user_id=admin.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "feature grant 부여: user=%s feature=%s by=%s",
        payload.user_id, payload.feature_key, admin.id,
    )
    return row


@router.delete(
    "/{user_id}/{feature_key}", status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_grant(
    user_id: UUID,
    feature_key: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """grant 해제. 없어도 204 (idempotent)."""
    row = await db.execute(
        select(UserFeatureGrant).where(
            UserFeatureGrant.tenant_id == admin.tenant_id,
            UserFeatureGrant.user_id == user_id,
            UserFeatureGrant.feature_key == feature_key,
        )
    )
    obj = row.scalar_one_or_none()
    if obj is not None:
        await db.delete(obj)
        await db.commit()
        logger.info(
            "feature grant 해제: user=%s feature=%s by=%s",
            user_id, feature_key, admin.id,
        )
