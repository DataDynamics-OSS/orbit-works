"""지식 베이스 (KB) — 벤더 자료(DOC) + 사내 트러블슈팅 노하우(KB) CRUD + 첨부.

Endpoints:
  GET    /kb-entries[?type=&vendor_id=&q=&tag=]    목록 (검색·필터)
  GET    /kb-entries/{id}                          상세
  POST   /kb-entries                               생성 (kb.write 필요)
  PATCH  /kb-entries/{id}                          편집 (작성자 또는 kb.write)
  DELETE /kb-entries/{id}                          삭제 (작성자 또는 kb.write)

첨부 (회의록 attachment 패턴 동일):
  POST   /kb-entries/{id}/attachments              multipart upload (multi)
  PATCH  /kb-entries/{id}/attachments/{aid}        파일명 변경
  DELETE /kb-entries/{id}/attachments/{aid}        삭제
  GET    /kb-entries/{id}/attachments/{aid}/download  다운로드

권한:
- 조회는 모든 인증 사용자 + entry.visibility 가 AND 로 추가 적용
  (manager = 매니저 이상, admin = ADMIN/SUPER_ADMIN)
- 작성·편집·삭제는 `kb.write` feature 권한 (SUPPORT/HR/ADMIN 기본)
- 작성자 본인은 자기 글 편집·삭제 항상 가능
"""

from __future__ import annotations

import logging
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, has_feature
from app.core.database import get_db
from app.models import (
    KbEntry,
    KbEntryAttachment,
    Product,
    ProductVersion,
    User,
    Vendor,
)
from app.schemas.kb_entry import (
    KbAttachmentOut,
    KbAttachmentRename,
    KbEntryCreate,
    KbEntryOut,
    KbEntryRowOut,
    KbEntryUpdate,
    KbSourceLink,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/kb-entries", tags=["kb-entries"])


# ---------------------------------------------------------------------------
# 권한 helpers
# ---------------------------------------------------------------------------


def _is_admin(user: User) -> bool:
    return user.role in ("ADMIN", "SUPER_ADMIN")


def _can_view_visibility(entry: KbEntry, user: User) -> bool:
    """row-level visibility 게이트. menu 권한 (kb) 통과한 사용자에게 추가 적용."""
    if entry.visibility == "all":
        return True
    if entry.visibility == "admin":
        return _is_admin(user)
    if entry.visibility == "manager":
        # 단순화 — HR/ADMIN/SUPER_ADMIN 도 통과.
        return user.role in ("ADMIN", "SUPER_ADMIN", "HR")
    return True


async def _require_write(db: AsyncSession, user: User, entry: KbEntry | None = None) -> None:
    """편집 권한 — kb.write 또는 작성자 본인 또는 ADMIN."""
    if _is_admin(user):
        return
    if entry is not None and entry.author_user_id == user.id:
        return
    if await has_feature(db, user, "kb.write"):
        return
    raise HTTPException(status_code=403, detail="kb 작성 권한 없음")


async def _require_delete(db: AsyncSession, user: User, entry: KbEntry) -> None:
    """삭제 권한 — kb.delete 또는 작성자 본인 또는 ADMIN. write 와 분리."""
    if _is_admin(user):
        return
    if entry.author_user_id == user.id:
        return
    if await has_feature(db, user, "kb.delete"):
        return
    raise HTTPException(status_code=403, detail="kb 삭제 권한 없음")


async def _require_publish_admin(
    db: AsyncSession, user: User, visibility: str | None,
) -> None:
    """visibility = manager|admin 인 글의 작성·승격 — kb.publish_admin 필요.
    visibility=all 은 별도 가드 없음."""
    if visibility in (None, "all"):
        return
    if _is_admin(user):
        return
    if await has_feature(db, user, "kb.publish_admin"):
        return
    raise HTTPException(status_code=403, detail="이 가시성으로 글을 작성할 권한이 없습니다.")


# ---------------------------------------------------------------------------
# row → DTO
# ---------------------------------------------------------------------------


async def _row_out(
    db: AsyncSession,
    entry: KbEntry,
    *,
    author_name: str | None = None,
    vendor_name: str | None = None,
    product_name: str | None = None,
    version_name: str | None = None,
    attachment_count: int = 0,
) -> KbEntryRowOut:
    # source_links — JSONB list of {name, url}. validate 로 KbSourceLink list 생성.
    raw_links = entry.source_links or []
    links: list[KbSourceLink] = []
    for it in raw_links:
        try:
            links.append(KbSourceLink.model_validate(it))
        except Exception:
            continue  # 잘못된 row 는 skip
    return KbEntryRowOut(
        id=entry.id,
        title=entry.title,
        type=entry.type,  # type: ignore[arg-type]
        vendor_id=entry.vendor_id,
        vendor_name=vendor_name,
        product_id=entry.product_id,
        product_name=product_name,
        version_id=entry.version_id,
        version_name=version_name,
        category=entry.category,
        tags=list(entry.tags or []),
        source_url=entry.source_url,
        source_links=links,
        resolved=entry.resolved,
        visibility=entry.visibility,  # type: ignore[arg-type]
        author_user_id=entry.author_user_id,
        author_name=author_name,
        attachment_count=attachment_count,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


async def _detail_out(db: AsyncSession, entry: KbEntry) -> KbEntryOut:
    # 이름 lookup — 단건이라 N+1 부담 없음.
    vendor_name: str | None = None
    product_name: str | None = None
    version_name: str | None = None
    author_name: str | None = None
    if entry.vendor_id:
        vendor_name = (
            await db.execute(select(Vendor.name).where(Vendor.id == entry.vendor_id))
        ).scalar_one_or_none()
    if entry.product_id:
        product_name = (
            await db.execute(select(Product.name).where(Product.id == entry.product_id))
        ).scalar_one_or_none()
    if entry.version_id:
        version_name = (
            await db.execute(
                select(ProductVersion.name).where(ProductVersion.id == entry.version_id)
            )
        ).scalar_one_or_none()
    if entry.author_user_id:
        row = (
            await db.execute(
                select(User.name, User.email).where(User.id == entry.author_user_id)
            )
        ).first()
        if row:
            author_name = row[0] or row[1] or None
    base = await _row_out(
        db, entry,
        author_name=author_name,
        vendor_name=vendor_name,
        product_name=product_name,
        version_name=version_name,
        attachment_count=len(entry.attachments or []),
    )
    return KbEntryOut(
        **base.model_dump(),
        body=entry.body,
        plain_text=entry.plain_text,
        attachments=[
            KbAttachmentOut.model_validate(a, from_attributes=True)
            for a in (entry.attachments or [])
        ],
    )


async def _get_or_404(db: AsyncSession, entry_id: UUID) -> KbEntry:
    e = (
        await db.execute(
            select(KbEntry)
            .options(selectinload(KbEntry.attachments))
            .where(KbEntry.id == entry_id)
        )
    ).scalar_one_or_none()
    if e is None:
        raise HTTPException(status_code=404, detail="KB 항목을 찾을 수 없습니다.")
    return e


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[KbEntryRowOut])
async def list_kb_entries(
    type: str | None = None,
    vendor_id: UUID | None = None,
    product_id: UUID | None = None,
    q: str | None = None,
    tag: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(KbEntry)
        .options(selectinload(KbEntry.attachments))
        .order_by(KbEntry.updated_at.desc())
    )
    if type:
        if type not in ("DOC", "KB"):
            raise HTTPException(status_code=400, detail="type 은 DOC|KB.")
        stmt = stmt.where(KbEntry.type == type)
    if vendor_id:
        stmt = stmt.where(KbEntry.vendor_id == vendor_id)
    if product_id:
        stmt = stmt.where(KbEntry.product_id == product_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            or_(KbEntry.title.ilike(like), KbEntry.plain_text.ilike(like))
        )
    if tag:
        # text[] 안에 tag 포함 — PostgreSQL `@>` 연산자. SQLAlchemy 의 ARRAY.contains.
        stmt = stmt.where(KbEntry.tags.contains([tag]))

    rows = list((await db.execute(stmt)).scalars())
    # row-level visibility 필터 — DB where 로 옮길 수도 있지만 작은 N 이라 in-memory.
    rows = [r for r in rows if _can_view_visibility(r, user)]

    # 이름 batch lookup — N+1 회피.
    vendor_ids = {r.vendor_id for r in rows if r.vendor_id}
    product_ids = {r.product_id for r in rows if r.product_id}
    version_ids = {r.version_id for r in rows if r.version_id}
    author_ids = {r.author_user_id for r in rows if r.author_user_id}
    vmap: dict[UUID, str] = {}
    pmap: dict[UUID, str] = {}
    vermap: dict[UUID, str] = {}
    amap: dict[UUID, str] = {}
    if vendor_ids:
        vmap = {
            i: n for (i, n) in (
                await db.execute(select(Vendor.id, Vendor.name).where(Vendor.id.in_(vendor_ids)))
            ).all()
        }
    if product_ids:
        pmap = {
            i: n for (i, n) in (
                await db.execute(
                    select(Product.id, Product.name).where(Product.id.in_(product_ids))
                )
            ).all()
        }
    if version_ids:
        vermap = {
            i: n for (i, n) in (
                await db.execute(
                    select(ProductVersion.id, ProductVersion.name).where(
                        ProductVersion.id.in_(version_ids)
                    )
                )
            ).all()
        }
    if author_ids:
        for (uid, name, email) in (
            await db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(author_ids))
            )
        ).all():
            amap[uid] = name or email or ""

    out: list[KbEntryRowOut] = []
    for r in rows:
        out.append(
            await _row_out(
                db, r,
                author_name=amap.get(r.author_user_id) if r.author_user_id else None,
                vendor_name=vmap.get(r.vendor_id) if r.vendor_id else None,
                product_name=pmap.get(r.product_id) if r.product_id else None,
                version_name=vermap.get(r.version_id) if r.version_id else None,
                attachment_count=len(r.attachments or []),
            )
        )
    return out


@router.get("/{entry_id}", response_model=KbEntryOut)
async def get_kb_entry(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    if not _can_view_visibility(e, user):
        raise HTTPException(status_code=403, detail="이 항목을 볼 권한이 없습니다.")
    return await _detail_out(db, e)


@router.post("", response_model=KbEntryOut, status_code=status.HTTP_201_CREATED)
async def create_kb_entry(
    payload: KbEntryCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _require_write(db, user)
    await _require_publish_admin(db, user, payload.visibility)
    # source_links 는 UI 가 max 2 강제, 서버에서도 안전망으로 자름.
    links = [link.model_dump() for link in (payload.source_links or [])[:2]]
    e = KbEntry(
        title=payload.title.strip(),
        type=payload.type,
        vendor_id=payload.vendor_id,
        product_id=payload.product_id,
        version_id=payload.version_id,
        category=payload.category,
        tags=payload.tags or None,
        body=payload.body,
        plain_text=payload.plain_text,
        source_links=links or None,
        resolved=payload.resolved,
        visibility=payload.visibility,
        author_user_id=user.id,
    )
    db.add(e)
    await db.commit()
    e = await _get_or_404(db, e.id)
    logger.info(
        "KB 생성: id=%s type=%s title=%s author=%s",
        e.id, e.type, e.title, user.id,
    )
    return await _detail_out(db, e)


@router.patch("/{entry_id}", response_model=KbEntryOut)
async def update_kb_entry(
    entry_id: UUID,
    payload: KbEntryUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    data = payload.model_dump(exclude_unset=True)
    # visibility 승격(all → manager/admin) 도 별도 권한.
    if "visibility" in data and data["visibility"] != e.visibility:
        await _require_publish_admin(db, user, data["visibility"])
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    # source_links — list[dict] 로 직렬화. UI 가 max 2 강제, 서버 안전망.
    if "source_links" in data and data["source_links"] is not None:
        data["source_links"] = data["source_links"][:2] or None
    for k, v in data.items():
        setattr(e, k, v)
    await db.commit()
    e = await _get_or_404(db, entry_id)
    logger.info("KB 수정: id=%s 변경필드=%s by=%s", entry_id, list(data.keys()), user.id)
    return await _detail_out(db, e)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_kb_entry(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    # write 가 아닌 별도 delete 게이트 — kb.delete 또는 작성자 본인.
    await _require_delete(db, user, e)
    # 첨부 파일 디스크에서도 정리. CASCADE 가 DB row 는 제거, 디스크는 우리가 처리.
    for a in (e.attachments or []):
        try:
            delete_file(a.file_path)
        except Exception as exc:  # pragma: no cover
            logger.warning("KB 첨부 파일 삭제 실패: path=%s err=%s", a.file_path, exc)
    await db.delete(e)
    await db.commit()
    logger.info("KB 삭제: id=%s by=%s", entry_id, user.id)


# ---------------------------------------------------------------------------
# 첨부
# ---------------------------------------------------------------------------


@router.post(
    "/{entry_id}/attachments",
    response_model=list[KbAttachmentOut],
    status_code=status.HTTP_201_CREATED,
)
async def upload_kb_attachments(
    entry_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    saved: list[KbEntryAttachment] = []
    for f in files:
        path, size = await save_upload(f, f"kb/{e.id}")
        att = KbEntryAttachment(
            tenant_id=e.tenant_id,
            entry_id=e.id,
            file_name=f.filename or uuid4().hex,
            file_path=path,
            mime_type=f.content_type,
            size=size,
            uploaded_by=user.id,
        )
        db.add(att)
        saved.append(att)
    await db.commit()
    for s in saved:
        await db.refresh(s)
    return [KbAttachmentOut.model_validate(s, from_attributes=True) for s in saved]


@router.patch(
    "/{entry_id}/attachments/{att_id}", response_model=KbAttachmentOut,
)
async def rename_kb_attachment(
    entry_id: UUID,
    att_id: UUID,
    payload: KbAttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    att = (
        await db.execute(
            select(KbEntryAttachment).where(
                KbEntryAttachment.id == att_id,
                KbEntryAttachment.entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    att.file_name = payload.file_name.strip()
    await db.commit()
    await db.refresh(att)
    return KbAttachmentOut.model_validate(att, from_attributes=True)


@router.delete(
    "/{entry_id}/attachments/{att_id}", status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_kb_attachment(
    entry_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    await _require_write(db, user, e)
    att = (
        await db.execute(
            select(KbEntryAttachment).where(
                KbEntryAttachment.id == att_id,
                KbEntryAttachment.entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        return
    try:
        delete_file(att.file_path)
    except Exception as exc:  # pragma: no cover
        logger.warning("KB 첨부 파일 삭제 실패: path=%s err=%s", att.file_path, exc)
    await db.delete(att)
    await db.commit()


@router.get("/{entry_id}/attachments/{att_id}/download")
async def download_kb_attachment(
    entry_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _get_or_404(db, entry_id)
    if not _can_view_visibility(e, user):
        raise HTTPException(status_code=403, detail="이 항목을 볼 권한이 없습니다.")
    att = (
        await db.execute(
            select(KbEntryAttachment).where(
                KbEntryAttachment.id == att_id,
                KbEntryAttachment.entry_id == entry_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    p: Path = resolve_upload_path(att.file_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 없습니다.")
    return FileResponse(
        path=str(p), filename=att.file_name, media_type=att.mime_type or "application/octet-stream",
    )
