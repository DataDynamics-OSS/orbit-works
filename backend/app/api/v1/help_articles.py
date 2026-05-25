"""도움말 컨텐츠 (Help Articles) CRUD + 버전 관리.

Endpoints:
  GET    /help-articles                          목록 (모든 인증 사용자)
  GET    /help-articles/{menu_key}               단건 — DashboardHeader ? 가 호출
  PUT    /help-articles/{menu_key}               upsert + revision snapshot (ADMIN/HR)
  DELETE /help-articles/{menu_key}               삭제 (ADMIN/HR) — revision 도 cascade
  GET    /help-articles/{menu_key}/revisions     history 목록
  GET    /help-articles/revisions/{rev_id}       단건 revision 본문
  POST   /help-articles/{menu_key}/restore/{rev_id}  복원 (현재 본문은 별도 revision)

Logging:
- INFO    : 본문 저장·복원 (사용자가 만든 변화).
- WARNING : 삭제 (전체 행 + revisions 삭제).
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import HelpArticle, HelpArticleRevision, User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/help-articles", tags=["help-articles"])


def _can_edit(user: User) -> bool:
    """ADMIN / SUPER_ADMIN / HR 만 도움말 편집."""
    return user.role in ("ADMIN", "SUPER_ADMIN", "HR")


def _require_edit(user: User) -> None:
    if not _can_edit(user):
        raise HTTPException(403, "도움말 편집 권한 없음 (ADMIN/HR)")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class HelpArticleOut(BaseModel):
    id: UUID
    menu_key: str
    title: str
    group: str | None = Field(default=None, alias="group")
    sort_order: int
    summary: str | None
    body_html: str
    body_text: str | None
    updated_at: str | None = None

    class Config:
        from_attributes = True
        populate_by_name = True


class HelpArticleListOut(BaseModel):
    """list 응답 — body 는 비포함 (가볍게)."""
    id: UUID
    menu_key: str
    title: str
    group: str | None
    sort_order: int
    summary: str | None
    updated_at: str | None = None

    class Config:
        from_attributes = True


class HelpArticleUpsert(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    group: str | None = Field(default=None, max_length=60)
    sort_order: int = 0
    summary: str | None = None
    body_html: str = ""
    body_text: str | None = None
    change_note: str | None = None


class RevisionOut(BaseModel):
    id: UUID
    article_id: UUID
    title: str
    group: str | None
    sort_order: int
    summary: str | None
    body_html: str
    body_text: str | None
    change_note: str | None
    saved_by_user_id: UUID | None
    saved_at: str

    class Config:
        from_attributes = True


class RevisionListItem(BaseModel):
    id: UUID
    title: str
    change_note: str | None
    saved_by_user_id: UUID | None
    saved_at: str

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize(a: HelpArticle) -> dict:
    return {
        "id": a.id,
        "menu_key": a.menu_key,
        "title": a.title,
        "group": a.group,
        "sort_order": a.sort_order,
        "summary": a.summary,
        "body_html": a.body_html,
        "body_text": a.body_text,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


def _snapshot(a: HelpArticle, change_note: str | None, saved_by: UUID) -> HelpArticleRevision:
    """현재 상태를 revision row 로 snapshot 한다 (DB add 만, commit 은 호출자)."""
    return HelpArticleRevision(
        tenant_id=a.tenant_id,
        article_id=a.id,
        title=a.title,
        group=a.group,
        sort_order=a.sort_order,
        summary=a.summary,
        body_html=a.body_html,
        body_text=a.body_text,
        change_note=change_note,
        saved_by_user_id=saved_by,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/export")
async def export_seed(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """현재 tenant 의 모든 articles 를 seed format JSON 으로 반환 (ADMIN/HR).

    개발자가 이 결과를 `backend/app/data/help_seed.json` 으로 commit 하면
    신규 tenant 생성 시 자동 시드. 이미지 base64 가 body 안에 그대로 포함됨.
    """
    _require_edit(user)
    rows = list(
        (
            await db.execute(
                select(HelpArticle)
                .where(HelpArticle.tenant_id == user.tenant_id)
                .order_by(
                    HelpArticle.group.asc().nullslast(),
                    HelpArticle.sort_order.asc(),
                    HelpArticle.menu_key.asc(),
                )
            )
        ).scalars()
    )
    items = [
        {
            "menu_key": a.menu_key,
            "title": a.title,
            "group": a.group,
            "sort_order": a.sort_order,
            "summary": a.summary,
            "body_html": a.body_html,
            "body_text": a.body_text,
        }
        for a in rows
    ]
    return {"version": 1, "items": items}


@router.get("", response_model=list[HelpArticleListOut])
async def list_articles(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(HelpArticle).order_by(
                    HelpArticle.group.asc().nullslast(),
                    HelpArticle.sort_order.asc(),
                    HelpArticle.title.asc(),
                )
            )
        ).scalars()
    )
    return [
        HelpArticleListOut(
            id=a.id,
            menu_key=a.menu_key,
            title=a.title,
            group=a.group,
            sort_order=a.sort_order,
            summary=a.summary,
            updated_at=a.updated_at.isoformat() if a.updated_at else None,
        )
        for a in rows
    ]


@router.get("/{menu_key}", response_model=HelpArticleOut)
async def get_article(
    menu_key: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    a = (
        await db.execute(
            select(HelpArticle).where(HelpArticle.menu_key == menu_key)
        )
    ).scalar_one_or_none()
    if not a:
        # 404 — frontend 가 코드 fallback 으로 처리.
        raise HTTPException(404, "도움말 항목 없음")
    return _serialize(a)


@router.put("/{menu_key}", response_model=HelpArticleOut)
async def upsert_article(
    menu_key: str,
    payload: HelpArticleUpsert,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_edit(user)
    a = (
        await db.execute(
            select(HelpArticle).where(
                HelpArticle.tenant_id == user.tenant_id,
                HelpArticle.menu_key == menu_key,
            )
        )
    ).scalar_one_or_none()
    if a is None:
        a = HelpArticle(
            tenant_id=user.tenant_id,
            menu_key=menu_key,
            title=payload.title.strip(),
            group=payload.group,
            sort_order=payload.sort_order,
            summary=payload.summary,
            body_html=payload.body_html or "",
            body_text=payload.body_text,
            updated_by_user_id=user.id,
        )
        db.add(a)
        await db.flush()
        # 최초 생성도 revision 1번 적재 — restore 의 기준선.
        db.add(_snapshot(a, payload.change_note or "초기 작성", user.id))
        await db.commit()
        await db.refresh(a)
        logger.info(
            "도움말 신규 작성: menu_key=%s title=%s by=%s",
            menu_key, a.title, user.id,
        )
        return _serialize(a)

    # 기존 행 — 변경 적용 전에 기존 상태를 snapshot.
    db.add(_snapshot(a, payload.change_note, user.id))
    a.title = payload.title.strip()
    a.group = payload.group
    a.sort_order = payload.sort_order
    a.summary = payload.summary
    a.body_html = payload.body_html or ""
    a.body_text = payload.body_text
    a.updated_by_user_id = user.id
    await db.commit()
    await db.refresh(a)
    logger.info(
        "도움말 수정: menu_key=%s title=%s by=%s",
        menu_key, a.title, user.id,
    )
    return _serialize(a)


@router.delete("/{menu_key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_article(
    menu_key: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_edit(user)
    a = (
        await db.execute(
            select(HelpArticle).where(
                HelpArticle.tenant_id == user.tenant_id,
                HelpArticle.menu_key == menu_key,
            )
        )
    ).scalar_one_or_none()
    if a is None:
        return
    await db.delete(a)
    await db.commit()
    logger.warning(
        "도움말 삭제: menu_key=%s title=%s by=%s",
        menu_key, a.title, user.id,
    )


@router.get("/{menu_key}/revisions", response_model=list[RevisionListItem])
async def list_revisions(
    menu_key: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    a = (
        await db.execute(
            select(HelpArticle).where(HelpArticle.menu_key == menu_key)
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "도움말 항목 없음")
    rows = list(
        (
            await db.execute(
                select(HelpArticleRevision)
                .where(HelpArticleRevision.article_id == a.id)
                .order_by(HelpArticleRevision.saved_at.desc())
            )
        ).scalars()
    )
    return [
        RevisionListItem(
            id=r.id,
            title=r.title,
            change_note=r.change_note,
            saved_by_user_id=r.saved_by_user_id,
            saved_at=r.saved_at.isoformat(),
        )
        for r in rows
    ]


@router.get("/revisions/{rev_id}", response_model=RevisionOut)
async def get_revision(
    rev_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    r = (
        await db.execute(
            select(HelpArticleRevision).where(HelpArticleRevision.id == rev_id)
        )
    ).scalar_one_or_none()
    if not r:
        raise HTTPException(404, "revision 없음")
    return RevisionOut(
        id=r.id,
        article_id=r.article_id,
        title=r.title,
        group=r.group,
        sort_order=r.sort_order,
        summary=r.summary,
        body_html=r.body_html,
        body_text=r.body_text,
        change_note=r.change_note,
        saved_by_user_id=r.saved_by_user_id,
        saved_at=r.saved_at.isoformat(),
    )


@router.post("/{menu_key}/restore/{rev_id}", response_model=HelpArticleOut)
async def restore_revision(
    menu_key: str,
    rev_id: UUID,
    note: str | None = Body(default=None, embed=True),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """특정 revision 으로 복원. 현재 상태도 별도 revision 으로 snapshot 한 뒤
    선택한 rev 의 메타·본문을 article 에 적용."""
    _require_edit(user)
    a = (
        await db.execute(
            select(HelpArticle).where(
                HelpArticle.tenant_id == user.tenant_id,
                HelpArticle.menu_key == menu_key,
            )
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "도움말 항목 없음")
    r = (
        await db.execute(
            select(HelpArticleRevision).where(
                HelpArticleRevision.id == rev_id,
                HelpArticleRevision.article_id == a.id,
            )
        )
    ).scalar_one_or_none()
    if not r:
        raise HTTPException(404, "revision 없음")
    # 현재 상태 snapshot — 복원 후에도 되돌릴 수 있도록.
    note_text = note or f"{r.saved_at.isoformat()} 복원 전 자동 저장"
    db.add(_snapshot(a, note_text, user.id))
    a.title = r.title
    a.group = r.group
    a.sort_order = r.sort_order
    a.summary = r.summary
    a.body_html = r.body_html
    a.body_text = r.body_text
    a.updated_by_user_id = user.id
    await db.commit()
    await db.refresh(a)
    logger.info(
        "도움말 복원: menu_key=%s rev=%s by=%s",
        menu_key, rev_id, user.id,
    )
    return _serialize(a)
