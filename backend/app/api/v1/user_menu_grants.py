"""사용자별 메뉴 grant CRUD.

ADMIN/SUPER_ADMIN/HR 만 부여. 본인 grants 조회는 모든 user 가 허용 — Sidebar
필터에 사용.

화이트리스트는 menu_permissions DEFAULT 키 목록 (백엔드 진실의 원천).

Endpoints:
  GET    /user-menu-grants/me                 본인 grants — Sidebar 가 호출
  GET    /user-menu-grants/all                ADMIN/HR — tenant 전체 grants (user_id→[menu_key])
  GET    /user-menu-grants?user_id=...        ADMIN/HR — 특정 user 의 grants
  PUT    /user-menu-grants/{user_id}          set 교체 — payload: list[menu_key]
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, has_feature
from app.api.v1.menu_permissions import DEFAULT_MENU_PERMISSIONS
from app.core.database import get_db
from app.models import User, UserMenuGrant

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/user-menu-grants", tags=["user-menu-grants"])


def _is_admin(u: User) -> bool:
    return u.role in ("ADMIN", "SUPER_ADMIN")


async def _require_grantor(db: AsyncSession, u: User) -> None:
    """ADMIN/SUPER_ADMIN/HR(role) 모두 부여 가능."""
    if _is_admin(u) or u.role == "HR":
        return
    # 거부 케이스에서 실제 actor role 을 한 번 찍어 원인 추적을 쉽게.
    logger.warning(
        "메뉴 grant 거부: user=%s email=%s role=%r tenant=%s",
        u.id, u.email, u.role, u.tenant_id,
    )
    raise HTTPException(status_code=403, detail="메뉴 부여 권한 없음 (ADMIN/HR)")


def _validate_keys(keys: list[str]) -> list[str]:
    out: list[str] = []
    for k in keys:
        if not isinstance(k, str) or not k:
            continue
        # menu_permissions DEFAULT 키 화이트리스트 — typo 방지.
        if k not in DEFAULT_MENU_PERMISSIONS:
            raise HTTPException(400, f"알 수 없는 menu_key: {k}")
        if k not in out:
            out.append(k)
    return out


@router.get("/me", response_model=list[str])
async def list_my_grants(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 grants — Sidebar 필터링 용."""
    rows = await db.execute(
        select(UserMenuGrant.menu_key).where(
            UserMenuGrant.tenant_id == user.tenant_id,
            UserMenuGrant.user_id == user.id,
        )
    )
    return [r[0] for r in rows.all()]


@router.get("/all", response_model=dict[str, list[str]])
async def list_all_grants(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    """tenant 전체 user grants — ADMIN/HR 만. 권한 관리 매트릭스 뷰 용.

    반환: `{user_id: [menu_key, ...]}` (grant 가 있는 user 만 포함).
    """
    if not (_is_admin(actor) or actor.role == "HR"):
        raise HTTPException(403, "전체 grants 조회 권한 없음 (ADMIN/HR)")
    rows = (
        await db.execute(
            select(UserMenuGrant.user_id, UserMenuGrant.menu_key).where(
                UserMenuGrant.tenant_id == actor.tenant_id,
            )
        )
    ).all()
    out: dict[str, list[str]] = {}
    for uid, key in rows:
        out.setdefault(str(uid), []).append(key)
    logger.info(
        "메뉴 grant 전체 조회: tenant=%s actor=%s users=%d",
        actor.tenant_id, actor.id, len(out),
    )
    return out


@router.get("", response_model=list[str])
async def list_user_grants(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    """특정 user 의 grants — ADMIN/HR 또는 본인."""
    if actor.id != user_id and not (_is_admin(actor) or actor.role == "HR"):
        raise HTTPException(403, "다른 사용자의 grants 조회 권한 없음")
    rows = await db.execute(
        select(UserMenuGrant.menu_key).where(
            UserMenuGrant.tenant_id == actor.tenant_id,
            UserMenuGrant.user_id == user_id,
        )
    )
    return [r[0] for r in rows.all()]


@router.put("/{user_id}", response_model=list[str])
async def set_user_grants(
    user_id: UUID,
    payload: list[str] = Body(...),
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    """user 의 grants 를 payload set 으로 교체. 비어 있으면 전부 해제."""
    await _require_grantor(db, actor)
    keys = _validate_keys(payload)
    # 대상 user 가 같은 tenant 인지 확인 (FK 만으론 cross-tenant 차단 약함).
    target = (
        await db.execute(
            select(User).where(User.id == user_id, User.tenant_id == actor.tenant_id)
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")

    await db.execute(
        delete(UserMenuGrant).where(
            UserMenuGrant.tenant_id == actor.tenant_id,
            UserMenuGrant.user_id == user_id,
        )
    )
    for k in keys:
        db.add(
            UserMenuGrant(
                tenant_id=actor.tenant_id,
                user_id=user_id,
                menu_key=k,
                granted_by_user_id=actor.id,
            )
        )
    await db.commit()
    logger.info(
        "사용자 메뉴 grant 저장: user=%s menus=%d (부여자=%s)",
        user_id, len(keys), actor.id,
    )
    return keys
