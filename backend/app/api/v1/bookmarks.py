"""북마크 API — PERSONAL/COMPANY 같은 테이블에서 scope 로 분리 관리.

조회:
- `GET /bookmarks?scope=personal|company` — 가시 목록 반환.
  - personal: owner_user_id == 본인 인 row.
  - company : visible_roles 가 NULL/빈배열 이거나 본인 role 포함, 또는 본인 ADMIN.

CRUD:
- POST/PATCH/DELETE — PERSONAL 은 owner 만, COMPANY 는 ADMIN/HR 만.

tenant 격리는 RLS 가 자동 처리. 추가 가드는 권한 분기 한정.
"""

from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Bookmark, User
from app.schemas.bookmark import BookmarkCreate, BookmarkOut, BookmarkUpdate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])

ScopeQuery = Literal["personal", "company"]


def _can_edit(b: Bookmark, user: User) -> bool:
    if b.scope == "PERSONAL":
        return b.owner_user_id == user.id
    # COMPANY
    return user.role in ("ADMIN", "HR")


def _can_view_company(b: Bookmark, user: User) -> bool:
    """COMPANY 북마크 가시성 — visible_roles NULL/빈배열 = 전직원, 그 외 role 매칭.
    ADMIN 은 항상 노출.
    """
    if user.role == "ADMIN":
        return True
    if not b.visible_roles:
        return True
    return user.role in b.visible_roles


def _can_view_info(b: Bookmark, user: User) -> bool:
    """정보(info) 필드 가시성. row 자체 가시성 위에 추가로 좁힌다.

    - PERSONAL: owner 본인은 항상 노출. (그 외 사용자는 row 자체를 못 봄.)
    - COMPANY  · ADMIN: 항상 노출.
    - COMPANY  · info_visible_roles == NULL: row 가시 사용자 전원 노출.
    - COMPANY  · info_visible_roles == []  : 아무에게도 미노출.
    - COMPANY  · info_visible_roles == [list]: 본인 role 이 list 에 있을 때만.
    """
    if b.scope == "PERSONAL":
        return b.owner_user_id == user.id
    if user.role == "ADMIN":
        return True
    roles = b.info_visible_roles
    if roles is None:
        return True
    return user.role in roles


def _normalize_roles(roles: list[str] | None) -> list[str] | None:
    if not roles:
        return None
    allowed = {"SALES", "HR", "SUPPORT", "ETC"}
    cleaned = [r for r in roles if r in allowed]
    return cleaned or None


def _to_out(b: Bookmark, user: User) -> BookmarkOut:
    # 권한 없는 사용자에게는 info 평문을 응답에서 제거해 누출 차단.
    info_ok = _can_view_info(b, user)
    return BookmarkOut(
        id=b.id,
        scope=b.scope,  # type: ignore[arg-type]
        owner_user_id=b.owner_user_id,
        label=b.label,
        url=b.url,
        info=b.info if info_ok else None,
        category=b.category,
        visible_roles=b.visible_roles,
        info_visible_roles=b.info_visible_roles,
        sort_order=b.sort_order,
        can_edit=_can_edit(b, user),
        created_at=b.created_at,
        updated_at=b.updated_at,
    )


@router.get("", response_model=list[BookmarkOut])
async def list_bookmarks(
    scope: ScopeQuery = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    target_scope = "PERSONAL" if scope == "personal" else "COMPANY"
    stmt = (
        select(Bookmark)
        .where(Bookmark.scope == target_scope)
        .order_by(Bookmark.sort_order.asc(), Bookmark.label.asc())
    )
    if target_scope == "PERSONAL":
        stmt = stmt.where(Bookmark.owner_user_id == user.id)
    rows = list((await db.execute(stmt)).scalars())
    if target_scope == "COMPANY":
        rows = [b for b in rows if _can_view_company(b, user)]
    return [_to_out(b, user) for b in rows]


@router.post("", response_model=BookmarkOut, status_code=status.HTTP_201_CREATED)
async def create_bookmark(
    payload: BookmarkCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if payload.scope == "COMPANY" and user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="공용 북마크는 ADMIN/HR 만 추가 가능합니다.")

    # COMPANY: visible_roles 정규화 + info_visible_roles 정규화 (단, NULL 유지).
    # PERSONAL: 두 필드 모두 무관 — 백엔드가 강제로 NULL.
    is_company = payload.scope == "COMPANY"
    info_roles_in = payload.info_visible_roles
    if is_company:
        if info_roles_in is None:
            info_roles_norm: list[str] | None = None
        else:
            info_roles_norm = _normalize_roles(info_roles_in) or []
    else:
        info_roles_norm = None

    b = Bookmark(
        scope=payload.scope,
        owner_user_id=user.id if payload.scope == "PERSONAL" else None,
        label=payload.label,
        url=payload.url,
        info=payload.info,
        category=payload.category,
        visible_roles=(
            _normalize_roles(payload.visible_roles) if is_company else None
        ),
        info_visible_roles=info_roles_norm,
        sort_order=payload.sort_order or 0,
    )
    db.add(b)
    await db.commit()
    await db.refresh(b)
    logger.info(
        "북마크 생성: id=%s scope=%s label=%s by=%s",
        b.id, b.scope, b.label, user.id,
    )
    return _to_out(b, user)


@router.patch("/{bookmark_id}", response_model=BookmarkOut)
async def update_bookmark(
    bookmark_id: UUID,
    payload: BookmarkUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(select(Bookmark).where(Bookmark.id == bookmark_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="북마크를 찾을 수 없습니다.")
    if not _can_edit(row, user):
        raise HTTPException(status_code=403, detail="편집 권한이 없습니다.")

    data = payload.model_dump(exclude_unset=True)
    is_company = row.scope == "COMPANY"
    if "visible_roles" in data:
        if is_company:
            data["visible_roles"] = _normalize_roles(data["visible_roles"])
        else:
            data.pop("visible_roles", None)
    if "info_visible_roles" in data:
        if is_company:
            v = data["info_visible_roles"]
            if v is None:
                data["info_visible_roles"] = None  # NULL = 전직원 노출
            else:
                data["info_visible_roles"] = _normalize_roles(v) or []
        else:
            data.pop("info_visible_roles", None)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _to_out(row, user)


@router.delete("/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmark(
    bookmark_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(select(Bookmark).where(Bookmark.id == bookmark_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="북마크를 찾을 수 없습니다.")
    if not _can_edit(row, user):
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다.")
    await db.delete(row)
    await db.commit()
    logger.info("북마크 삭제: id=%s scope=%s by=%s", bookmark_id, row.scope, user.id)
