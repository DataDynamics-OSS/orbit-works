"""게시판 (board) API.

Endpoints:
- GET    /board/posts                        목록
- POST   /board/posts                        글 등록
- GET    /board/posts/{pid}                  상세 (+ view_count 증가)
- PATCH  /board/posts/{pid}                  본인 or 관리자
- DELETE /board/posts/{pid}                  본인 or 관리자

- POST   /board/posts/{pid}/attachments      첨부 업로드 (본인/관리자)
- GET    /board/attachments/{aid}/download   다운로드 (인증만)
- PATCH  /board/attachments/{aid}            이름 변경 (본인/관리자)
- DELETE /board/attachments/{aid}            삭제 (본인/관리자)

- GET    /board/posts/{pid}/comments         코멘트 목록 (read 권한자)
- POST   /board/posts/{pid}/comments         코멘트 작성 (read 권한자)
- PATCH  /board/comments/{cid}               코멘트 수정 (작성자/ADMIN)
- DELETE /board/comments/{cid}               코멘트 삭제 (작성자/ADMIN)
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import BoardAttachment, BoardComment, BoardPost, User
from app.schemas.board import (
    BoardAttachmentOut,
    BoardAttachmentUpdate,
    BoardCommentCreate,
    BoardCommentOut,
    BoardCommentUpdate,
    BoardPostCreate,
    BoardPostOut,
    BoardPostUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/board", tags=["board"])


# ---------------------------------------------------------------------------
# 권한
# ---------------------------------------------------------------------------


def _assert_can_edit(post: BoardPost, user: User) -> None:
    """본인 글 또는 ADMIN 만 수정/삭제 허용."""
    if user.role == "ADMIN":
        return
    if post.author_id == user.id:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="본인 글 또는 관리자만 수정/삭제할 수 있습니다.",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _load_post(
    db: AsyncSession, pid: UUID, *, with_attachments: bool = False
) -> BoardPost:
    stmt = select(BoardPost).where(BoardPost.id == pid)
    if with_attachments:
        stmt = stmt.options(selectinload(BoardPost.attachments))
    row = (await db.execute(stmt)).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")
    return row


def _can_view(post: BoardPost, user: User) -> bool:
    """visible_roles 기반 노출 여부 — ADMIN·작성자는 항상 통과."""
    if user.role == "ADMIN":
        return True
    if post.author_id and post.author_id == user.id:
        return True
    if not post.visible_roles:
        return True
    return user.role in post.visible_roles


def _normalize_roles(values: list[str] | None) -> list[str] | None:
    """입력 visible_roles 정규화 — None/빈 리스트 → None (전체 공개), 유효 role 만 보존,
    ADMIN 은 자동 제외 (항상 모든 글 볼 수 있어 명시 불필요)."""
    if not values:
        return None
    from app.core.roles import ROLES

    cleaned: list[str] = []
    for v in values:
        v = (v or "").strip().upper()
        if v == "ADMIN":
            continue
        if v in ROLES and v not in cleaned:
            cleaned.append(v)
    return cleaned or None


async def _author_name(db: AsyncSession, author_id: UUID | None) -> str | None:
    if not author_id:
        return None
    user = (
        await db.execute(select(User).where(User.id == author_id))
    ).scalar_one_or_none()
    if not user:
        return None
    return user.name or user.email


def _to_out(post: BoardPost, author_name: str | None) -> BoardPostOut:
    atts = list(post.attachments) if post.attachments is not None else []
    out = BoardPostOut.model_validate(post, from_attributes=True)
    out.author_name = author_name
    out.attachment_count = len(atts)
    out.attachments = [
        BoardAttachmentOut.model_validate(a, from_attributes=True) for a in atts
    ]
    return out


# ---------------------------------------------------------------------------
# Post CRUD
# ---------------------------------------------------------------------------


@router.get("/posts", response_model=list[BoardPostOut])
async def list_posts(
    category: str | None = None,
    limit: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """고정 글 우선, 최신순 정렬. category='NOTICE' 등으로 필터 가능.

    visible_roles 가 지정된 글은 그 role + ADMIN + 작성자만 볼 수 있음.
    """
    stmt = (
        select(BoardPost)
        .options(selectinload(BoardPost.attachments))
        .order_by(BoardPost.is_pinned.desc(), BoardPost.created_at.desc())
    )
    if category:
        stmt = stmt.where(BoardPost.category == category)
    if limit:
        stmt = stmt.limit(limit)
    posts = list((await db.execute(stmt)).scalars())
    # 노출 필터 — Python side. 보통 글 수가 수백 단위라 충분.
    posts = [p for p in posts if _can_view(p, user)]
    author_cache: dict[UUID, str | None] = {}
    out: list[BoardPostOut] = []
    for p in posts:
        if p.author_id and p.author_id not in author_cache:
            author_cache[p.author_id] = await _author_name(db, p.author_id)
        out.append(_to_out(p, author_cache.get(p.author_id) if p.author_id else None))
    return out


@router.get("/posts/unread-count", response_model=dict)
async def unread_notice_count(
    category: str = "NOTICE",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """사용자가 마지막으로 본 시각 이후 등록된 글 수.

    `last_notice_seen_at` 가 NULL 이면 모든 활성 글을 안 읽음으로 카운트
    (신규 사용자 대비). 모바일/웹 헤더에 빨간 배지로 노출하기 위한 단일 호출.
    """
    from datetime import datetime, timezone

    stmt = select(BoardPost).where(BoardPost.category == category)
    if user.last_notice_seen_at is not None:
        stmt = stmt.where(BoardPost.created_at > user.last_notice_seen_at)
    posts = list((await db.execute(stmt)).scalars())
    return {
        "count": len(posts),
        "last_seen_at": user.last_notice_seen_at.isoformat()
        if user.last_notice_seen_at
        else None,
        "now": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/posts/seen", status_code=status.HTTP_204_NO_CONTENT)
async def mark_notices_seen(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """사용자가 공지 목록을 봤음을 인정 → last_notice_seen_at = now().

    이후 unread-count 는 0 (이 시점 이후 새로 작성되는 글은 다시 카운트).
    카테고리별로 따로 추적하지 않음 — 단순 모델로 시작.
    """
    from datetime import datetime, timezone

    user.last_notice_seen_at = datetime.now(timezone.utc)
    await db.commit()


@router.get("/posts/{pid}", response_model=BoardPostOut)
async def get_post(
    pid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = await _load_post(db, pid, with_attachments=True)
    if not _can_view(post, user):
        # 권한 없는 사용자에게는 존재 자체를 노출하지 않음.
        raise HTTPException(status_code=404, detail="Post not found")
    # 조회수 증가 — best-effort.
    post.view_count = (post.view_count or 0) + 1
    await db.commit()
    await db.refresh(post, attribute_names=["attachments"])
    name = await _author_name(db, post.author_id)
    return _to_out(post, name)


@router.post(
    "/posts",
    response_model=BoardPostOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_post(
    payload: BoardPostCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = BoardPost(
        title=payload.title,
        content=payload.content,
        is_pinned=payload.is_pinned,
        category=payload.category,
        author_id=user.id,
        visible_roles=_normalize_roles(payload.visible_roles),
    )
    db.add(post)
    await db.commit()
    await db.refresh(post, attribute_names=["attachments"])
    logger.info("게시판 글 등록: id=%s title=%s (작성자=%s)", post.id, post.title, user.id)

    # NOTICE 카테고리만 PWA push 발송 — 게시판 일반 글은 기존처럼 조용히.
    # 발송 실패는 예외로 올리지 않음 — 글 등록 자체는 이미 성공한 트랜잭션이고,
    # push 는 best-effort.
    if post.category == "NOTICE":
        try:
            from app.services.push import broadcast_push

            preview = (post.content or "").strip().replace("\n", " ")
            if len(preview) > 100:
                preview = preview[:100] + "…"
            await broadcast_push({
                "title": "📢 새 공지사항",
                "body": f"{post.title}\n{preview}" if preview else post.title,
                "url": f"/m/notice/{post.id}",
                "tag": f"notice-{post.id}",
            })
        except Exception as exc:  # pragma: no cover
            logger.warning("공지 push 발송 실패: %s", exc, exc_info=True)

    name = user.name or user.email
    return _to_out(post, name)


@router.patch("/posts/{pid}", response_model=BoardPostOut)
async def update_post(
    pid: UUID,
    payload: BoardPostUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = await _load_post(db, pid, with_attachments=True)
    _assert_can_edit(post, user)
    data = payload.model_dump(exclude_unset=True)
    if "visible_roles" in data:
        data["visible_roles"] = _normalize_roles(data["visible_roles"])
    for k, v in data.items():
        setattr(post, k, v)
    await db.commit()
    await db.refresh(post, attribute_names=["attachments"])
    logger.info(
        "게시판 글 수정: id=%s 변경=%s (수정자=%s)",
        post.id,
        list(data.keys()),
        user.id,
    )
    name = await _author_name(db, post.author_id)
    return _to_out(post, name)


@router.delete("/posts/{pid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_post(
    pid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = await _load_post(db, pid, with_attachments=True)
    _assert_can_edit(post, user)
    # 첨부 파일도 디스크에서 제거.
    for att in list(post.attachments or []):
        delete_file(att.file_path)
    await db.delete(post)
    await db.commit()
    logger.warning("게시판 글 삭제: id=%s (삭제자=%s)", pid, user.id)


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post(
    "/posts/{pid}/attachments",
    response_model=BoardAttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    pid: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = await _load_post(db, pid)
    _assert_can_edit(post, user)
    stored, size = await save_upload(file, f"board/{pid}")
    att = BoardAttachment(
        post_id=pid,
        file_name=file.filename or "file",
        file_path=stored,
        mime_type=file.content_type,
        size=size,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    logger.info(
        "게시판 첨부 업로드: post=%s file=%s size=%s (업로더=%s)",
        pid,
        att.file_name,
        size,
        user.id,
    )
    return BoardAttachmentOut.model_validate(att, from_attributes=True)


@router.get("/attachments/{aid}/download")
async def download_attachment(
    aid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    att = (
        await db.execute(select(BoardAttachment).where(BoardAttachment.id == aid))
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )


@router.patch("/attachments/{aid}", response_model=BoardAttachmentOut)
async def rename_attachment(
    aid: UUID,
    payload: BoardAttachmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    att = (
        await db.execute(select(BoardAttachment).where(BoardAttachment.id == aid))
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    post = await _load_post(db, att.post_id)
    _assert_can_edit(post, user)
    att.file_name = payload.file_name
    await db.commit()
    await db.refresh(att)
    return BoardAttachmentOut.model_validate(att, from_attributes=True)


@router.delete("/attachments/{aid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(
    aid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    att = (
        await db.execute(select(BoardAttachment).where(BoardAttachment.id == aid))
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    post = await _load_post(db, att.post_id)
    _assert_can_edit(post, user)
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    logger.info("게시판 첨부 삭제: id=%s post=%s (삭제자=%s)", aid, att.post_id, user.id)


# ---------------------------------------------------------------------------
# Comments — 글에 달리는 코멘트.
#   조회·작성: 글을 볼 수 있는 사용자(_can_view) 모두.
#   편집·삭제: 작성자 본인 + ADMIN. user 삭제 시 author_id NULL (코멘트 보존).
# ---------------------------------------------------------------------------


def _can_edit_comment(c: BoardComment, user: User) -> bool:
    if user.role == "ADMIN":
        return True
    return c.author_id is not None and c.author_id == user.id


async def _serialize_comment(
    db: AsyncSession,
    c: BoardComment,
    user: User,
    *,
    name_cache: dict[UUID, str | None] | None = None,
) -> BoardCommentOut:
    name: str | None = None
    if c.author_id:
        if name_cache is not None and c.author_id in name_cache:
            name = name_cache[c.author_id]
        else:
            name = await _author_name(db, c.author_id)
    return BoardCommentOut(
        id=c.id,
        post_id=c.post_id,
        parent_id=c.parent_id,
        author_id=c.author_id,
        author_name=name,
        body=c.body,
        created_at=c.created_at,
        updated_at=c.updated_at,
        can_edit=_can_edit_comment(c, user),
    )


@router.get("/posts/{pid}/comments", response_model=list[BoardCommentOut])
async def list_comments(
    pid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = await _load_post(db, pid)
    if not _can_view(post, user):
        raise HTTPException(status_code=404, detail="Post not found")
    rows = list(
        (
            await db.execute(
                select(BoardComment)
                .where(BoardComment.post_id == pid)
                .order_by(BoardComment.created_at.asc())
            )
        ).scalars()
    )
    # 작성자 이름 캐시 — N+1 방지.
    name_cache: dict[UUID, str | None] = {}
    for c in rows:
        if c.author_id and c.author_id not in name_cache:
            name_cache[c.author_id] = await _author_name(db, c.author_id)
    return [
        await _serialize_comment(db, c, user, name_cache=name_cache) for c in rows
    ]


@router.post(
    "/posts/{pid}/comments",
    response_model=BoardCommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    pid: UUID,
    payload: BoardCommentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    post = await _load_post(db, pid)
    if not _can_view(post, user):
        # 작성 권한 = 조회 권한자 — 권한 없으면 글 자체 noopt 으로 404.
        raise HTTPException(status_code=404, detail="Post not found")
    # 답글이면 부모 코멘트 검증 — 같은 post 안의 코멘트여야 함.
    # tenant 일치는 RLS 가 자동 강제 (orbit_app role 기준 같은 tenant 만 SELECT).
    parent_id = payload.parent_id
    if parent_id is not None:
        parent = (
            await db.execute(select(BoardComment).where(BoardComment.id == parent_id))
        ).scalar_one_or_none()
        if parent is None or parent.post_id != pid:
            raise HTTPException(
                status_code=400, detail="부모 코멘트를 찾을 수 없습니다."
            )
    c = BoardComment(
        post_id=pid, author_id=user.id, body=payload.body, parent_id=parent_id,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info(
        "게시판 코멘트 작성: post=%s comment=%s actor=%s",
        pid, c.id, user.id,
    )
    return await _serialize_comment(db, c, user)


@router.patch("/comments/{cid}", response_model=BoardCommentOut)
async def update_comment(
    cid: UUID,
    payload: BoardCommentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = (
        await db.execute(select(BoardComment).where(BoardComment.id == cid))
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    if not _can_edit_comment(c, user):
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")
    c.body = payload.body
    await db.commit()
    await db.refresh(c)
    logger.info(
        "게시판 코멘트 수정: post=%s comment=%s actor=%s",
        c.post_id, cid, user.id,
    )
    return await _serialize_comment(db, c, user)


@router.delete("/comments/{cid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    cid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = (
        await db.execute(select(BoardComment).where(BoardComment.id == cid))
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    if not _can_edit_comment(c, user):
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다.")
    pid = c.post_id
    await db.delete(c)
    await db.commit()
    logger.warning(
        "게시판 코멘트 삭제: post=%s comment=%s actor=%s",
        pid, cid, user.id,
    )
