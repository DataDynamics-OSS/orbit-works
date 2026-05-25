"""사업공고 API.

Endpoints:
- `GET    /announcements`                  목록(필터·페이징)
- `GET    /announcements/{id}`             상세
- `PATCH  /announcements/{id}`             memo (북마크) · converted_opportunity_id
- `POST   /announcements/{id}/bookmark`    북마크 추가/업데이트
- `DELETE /announcements/{id}/bookmark`    북마크 제거
- `GET    /announcements/sources`          소스 목록 + 최근 run 요약
- `PATCH  /announcements/sources/{code}`   enabled/priority 토글
- `POST   /announcements/fetch`            수동 수집 (전체 or source 지정)
- `GET    /announcements/runs`             수집 로그
- `GET    /announcements/summary`          대시보드 카드용 요약
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission, require_super_admin
from app.core.database import get_db
from app.models import (
    Announcement,
    AnnouncementBookmark,
    AnnouncementFetchRun,
    AnnouncementSource,
    User,
)
from app.services.announcements import ADAPTERS, run_all, run_one

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/announcements", tags=["announcements"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class AnnouncementOut(BaseModel):
    id: UUID
    source_id: UUID
    source_code: str | None = None
    source_name: str | None = None
    external_id: str
    title: str
    agency: str | None
    department: str | None
    business_type: str | None
    category: str | None
    region: str | None
    posted_at: date | None
    deadline_at: datetime | None
    days_to_deadline: int | None = None
    budget_amount: float | None
    currency: str
    contact_name: str | None
    contact_phone: str | None
    contact_email: str | None
    detail_url: str | None
    attachment_urls: list[str] | None
    summary: str | None
    is_active: bool
    bookmarked: bool = False
    bookmark_memo: str | None = None
    converted_opportunity_id: UUID | None
    first_seen_at: datetime
    last_seen_at: datetime


class AnnouncementPageOut(BaseModel):
    items: list[AnnouncementOut]
    total: int
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=2000)


class AnnouncementPatch(BaseModel):
    converted_opportunity_id: UUID | None = None


class BookmarkIn(BaseModel):
    memo: str | None = None


class SourceOut(BaseModel):
    id: UUID
    code: str
    name: str
    agency: str | None
    base_url: str | None
    adapter_kind: str
    enabled: bool
    priority: int
    last_fetched_at: datetime | None
    last_ok_at: datetime | None
    last_error: str | None
    last_count: int | None
    needs_api_key: bool
    has_api_key: bool
    implemented: bool


class SourcePatch(BaseModel):
    enabled: bool | None = None
    priority: int | None = None


class FetchRunOut(BaseModel):
    id: UUID
    source_id: UUID | None
    source_code: str
    trigger_kind: str
    started_at: datetime
    finished_at: datetime | None
    status: str
    fetched_count: int
    inserted_count: int
    updated_count: int
    skipped_count: int
    error_message: str | None


class FetchTriggerRequest(BaseModel):
    source: str | None = None
    since_days: int = Field(default=1, ge=1, le=30)


class FetchTriggerResponse(BaseModel):
    results: list[dict]


class AnnouncementSummaryOut(BaseModel):
    total: int
    new_today: int
    closing_within_7d: int
    by_source: dict[str, int]
    by_business_type: dict[str, int]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _days_to_deadline(deadline: datetime | None) -> int | None:
    if deadline is None:
        return None
    now = datetime.now(timezone.utc)
    delta = deadline - now
    return delta.days


def _to_out(
    a: Announcement,
    *,
    source: AnnouncementSource | None,
    bookmark: AnnouncementBookmark | None,
) -> AnnouncementOut:
    return AnnouncementOut(
        id=a.id,
        source_id=a.source_id,
        source_code=source.code if source else None,
        source_name=source.name if source else None,
        external_id=a.external_id,
        title=a.title,
        agency=a.agency,
        department=a.department,
        business_type=a.business_type,
        category=a.category,
        region=a.region,
        posted_at=a.posted_at,
        deadline_at=a.deadline_at,
        days_to_deadline=_days_to_deadline(a.deadline_at),
        budget_amount=float(a.budget_amount) if a.budget_amount is not None else None,
        currency=a.currency,
        contact_name=a.contact_name,
        contact_phone=a.contact_phone,
        contact_email=a.contact_email,
        detail_url=a.detail_url,
        attachment_urls=a.attachment_urls,
        summary=a.summary,
        is_active=a.is_active,
        bookmarked=bookmark is not None,
        bookmark_memo=bookmark.memo if bookmark else None,
        converted_opportunity_id=a.converted_opportunity_id,
        first_seen_at=a.first_seen_at,
        last_seen_at=a.last_seen_at,
    )


# ---------------------------------------------------------------------------
# List / detail
# ---------------------------------------------------------------------------


@router.get("", response_model=AnnouncementPageOut)
async def list_announcements(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("announcements.read")),
    q: str | None = Query(default=None, description="제목·기관 부분일치"),
    sources: list[str] | None = Query(default=None, description="source code 복수 지정"),
    business_type: str | None = Query(default=None),
    region: str | None = Query(default=None),
    posted_from: date | None = Query(default=None),
    posted_to: date | None = Query(default=None),
    deadline_from: date | None = Query(default=None),
    deadline_to: date | None = Query(default=None),
    deadline_within_days: int | None = Query(default=None, ge=1, le=120),
    bookmarked_only: bool = Query(default=False),
    active_only: bool = Query(default=True),
    sort: Literal["posted_desc", "deadline_asc", "first_seen_desc"] = Query(
        default="posted_desc"
    ),
    page: int = Query(default=1, ge=1),
    # 프론트가 클라이언트 페이징을 쓰므로 상한을 넉넉히 (2000).
    page_size: int = Query(default=50, ge=1, le=2000),
):
    stmt = select(Announcement).options(selectinload(Announcement.source))
    conditions = []
    if active_only:
        conditions.append(Announcement.is_active.is_(True))
    if q:
        like = f"%{q}%"
        conditions.append(
            or_(Announcement.title.ilike(like), Announcement.agency.ilike(like))
        )
    if sources:
        sub = select(AnnouncementSource.id).where(AnnouncementSource.code.in_(sources))
        conditions.append(Announcement.source_id.in_(sub))
    if business_type:
        conditions.append(Announcement.business_type == business_type)
    if region:
        conditions.append(Announcement.region == region)
    if posted_from:
        conditions.append(Announcement.posted_at >= posted_from)
    if posted_to:
        conditions.append(Announcement.posted_at <= posted_to)
    if deadline_from:
        conditions.append(Announcement.deadline_at >= datetime.combine(deadline_from, datetime.min.time()))
    if deadline_to:
        conditions.append(Announcement.deadline_at <= datetime.combine(deadline_to, datetime.max.time()))
    if deadline_within_days is not None:
        now = datetime.now(timezone.utc)
        conditions.append(Announcement.deadline_at.is_not(None))
        conditions.append(Announcement.deadline_at >= now)
        conditions.append(
            Announcement.deadline_at <= now + timedelta(days=deadline_within_days)
        )
    if bookmarked_only:
        sub = select(AnnouncementBookmark.announcement_id).where(
            AnnouncementBookmark.user_id == user.id
        )
        conditions.append(Announcement.id.in_(sub))

    if conditions:
        stmt = stmt.where(and_(*conditions))

    if sort == "deadline_asc":
        stmt = stmt.order_by(
            Announcement.deadline_at.asc().nullslast(),
            Announcement.posted_at.desc().nullslast(),
        )
    elif sort == "first_seen_desc":
        stmt = stmt.order_by(Announcement.first_seen_at.desc())
    else:
        stmt = stmt.order_by(
            Announcement.posted_at.desc().nullslast(),
            Announcement.created_at.desc(),
        )

    total = await db.scalar(
        select(func.count()).select_from(stmt.order_by(None).subquery())
    )
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()

    # Preload bookmarks for the shown rows.
    ids = [r.id for r in rows]
    bookmarks: dict[UUID, AnnouncementBookmark] = {}
    if ids:
        bq = await db.execute(
            select(AnnouncementBookmark).where(
                AnnouncementBookmark.announcement_id.in_(ids),
                AnnouncementBookmark.user_id == user.id,
            )
        )
        for b in bq.scalars():
            bookmarks[b.announcement_id] = b

    return AnnouncementPageOut(
        items=[_to_out(a, source=a.source, bookmark=bookmarks.get(a.id)) for a in rows],
        total=total or 0,
        page=page,
        page_size=page_size,
    )


@router.get("/summary", response_model=AnnouncementSummaryOut)
async def announcements_summary(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("announcements.read")),
):
    now = datetime.now(timezone.utc)
    today = date.today()
    total = await db.scalar(
        select(func.count(Announcement.id)).where(Announcement.is_active.is_(True))
    )
    new_today = await db.scalar(
        select(func.count(Announcement.id)).where(
            Announcement.first_seen_at >= datetime.combine(today, datetime.min.time()).replace(tzinfo=timezone.utc)
        )
    )
    closing = await db.scalar(
        select(func.count(Announcement.id)).where(
            Announcement.is_active.is_(True),
            Announcement.deadline_at.is_not(None),
            Announcement.deadline_at >= now,
            Announcement.deadline_at <= now + timedelta(days=7),
        )
    )
    by_source_rows = (
        await db.execute(
            select(AnnouncementSource.code, func.count(Announcement.id))
            .join(Announcement, Announcement.source_id == AnnouncementSource.id)
            .where(Announcement.is_active.is_(True))
            .group_by(AnnouncementSource.code)
        )
    ).all()
    by_biz_rows = (
        await db.execute(
            select(Announcement.business_type, func.count(Announcement.id))
            .where(Announcement.is_active.is_(True))
            .group_by(Announcement.business_type)
        )
    ).all()
    return AnnouncementSummaryOut(
        total=total or 0,
        new_today=new_today or 0,
        closing_within_7d=closing or 0,
        by_source={code: cnt for code, cnt in by_source_rows},
        by_business_type={(bt or "UNKNOWN"): cnt for bt, cnt in by_biz_rows},
    )


@router.get("/{announcement_id:uuid}", response_model=AnnouncementOut)
async def get_announcement(
    announcement_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("announcements.read")),
):
    a = (
        await db.execute(
            select(Announcement)
            .options(selectinload(Announcement.source))
            .where(Announcement.id == announcement_id)
        )
    ).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="공고 없음")
    b = (
        await db.execute(
            select(AnnouncementBookmark).where(
                AnnouncementBookmark.announcement_id == a.id,
                AnnouncementBookmark.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    return _to_out(a, source=a.source, bookmark=b)


@router.patch("/{announcement_id:uuid}", response_model=AnnouncementOut)
async def patch_announcement(
    announcement_id: UUID,
    patch: AnnouncementPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("announcements.manage")),
):
    a = (
        await db.execute(
            select(Announcement)
            .options(selectinload(Announcement.source))
            .where(Announcement.id == announcement_id)
        )
    ).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="공고 없음")
    if "converted_opportunity_id" in patch.model_fields_set:
        a.converted_opportunity_id = patch.converted_opportunity_id
    await db.commit()
    await db.refresh(a)
    b = (
        await db.execute(
            select(AnnouncementBookmark).where(
                AnnouncementBookmark.announcement_id == a.id,
                AnnouncementBookmark.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    return _to_out(a, source=a.source, bookmark=b)


# ---------------------------------------------------------------------------
# Bookmark
# ---------------------------------------------------------------------------


@router.post("/{announcement_id:uuid}/bookmark", response_model=AnnouncementOut)
async def add_bookmark(
    announcement_id: UUID,
    body: BookmarkIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("announcements.read")),
):
    a = (
        await db.execute(
            select(Announcement)
            .options(selectinload(Announcement.source))
            .where(Announcement.id == announcement_id)
        )
    ).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="공고 없음")
    existing = (
        await db.execute(
            select(AnnouncementBookmark).where(
                AnnouncementBookmark.announcement_id == a.id,
                AnnouncementBookmark.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = AnnouncementBookmark(
            announcement_id=a.id, user_id=user.id, memo=body.memo
        )
        db.add(existing)
    else:
        existing.memo = body.memo
    await db.commit()
    await db.refresh(existing)
    return _to_out(a, source=a.source, bookmark=existing)


@router.delete("/{announcement_id:uuid}/bookmark", response_model=AnnouncementOut)
async def remove_bookmark(
    announcement_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("announcements.read")),
):
    a = (
        await db.execute(
            select(Announcement)
            .options(selectinload(Announcement.source))
            .where(Announcement.id == announcement_id)
        )
    ).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="공고 없음")
    existing = (
        await db.execute(
            select(AnnouncementBookmark).where(
                AnnouncementBookmark.announcement_id == a.id,
                AnnouncementBookmark.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        await db.delete(existing)
        await db.commit()
    return _to_out(a, source=a.source, bookmark=None)


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


@router.get("/sources", response_model=list[SourceOut])
async def list_sources(
    db: AsyncSession = Depends(get_db),
    # 누구나 읽기 가능 — source 메타(이름·base_url 등) 는 공개 정보. 관리(PATCH)
    # 는 별도로 require_super_admin 으로 가드. 수동 수집(POST /fetch) 은 인증만 요구.
    _user: User = Depends(get_current_user),
):
    from app.core.config import get_settings

    cfg = get_settings().announcements
    q = select(AnnouncementSource).order_by(
        AnnouncementSource.priority.asc(), AnnouncementSource.code.asc()
    )
    rows = (await db.execute(q)).scalars().all()
    out: list[SourceOut] = []
    for s in rows:
        adapter_cls = ADAPTERS.get(s.code)
        needs = bool(adapter_cls and adapter_cls.requires_api_key)
        src_cfg = cfg.sources.get(s.code)
        has_key = bool(src_cfg and src_cfg.api_key)
        out.append(
            SourceOut(
                id=s.id,
                code=s.code,
                name=s.name,
                agency=s.agency,
                base_url=s.base_url,
                adapter_kind=s.adapter_kind,
                enabled=s.enabled,
                priority=s.priority,
                last_fetched_at=s.last_fetched_at,
                last_ok_at=s.last_ok_at,
                last_error=s.last_error,
                last_count=s.last_count,
                needs_api_key=needs,
                has_api_key=has_key,
                implemented=adapter_cls is not None,
            )
        )
    return out


@router.patch("/sources/{code}", response_model=SourceOut)
async def patch_source(
    code: str,
    patch: SourcePatch,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_super_admin),
):
    s = (
        await db.execute(
            select(AnnouncementSource).where(AnnouncementSource.code == code)
        )
    ).scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="소스 없음")
    if patch.enabled is not None:
        s.enabled = patch.enabled
    if patch.priority is not None:
        s.priority = patch.priority
    await db.commit()
    await db.refresh(s)

    from app.core.config import get_settings

    cfg = get_settings().announcements
    adapter_cls = ADAPTERS.get(s.code)
    src_cfg = cfg.sources.get(s.code)
    return SourceOut(
        id=s.id,
        code=s.code,
        name=s.name,
        agency=s.agency,
        base_url=s.base_url,
        adapter_kind=s.adapter_kind,
        enabled=s.enabled,
        priority=s.priority,
        last_fetched_at=s.last_fetched_at,
        last_ok_at=s.last_ok_at,
        last_error=s.last_error,
        last_count=s.last_count,
        needs_api_key=bool(adapter_cls and adapter_cls.requires_api_key),
        has_api_key=bool(src_cfg and src_cfg.api_key),
        implemented=adapter_cls is not None,
    )


# ---------------------------------------------------------------------------
# Manual fetch
# ---------------------------------------------------------------------------


@router.post("/fetch", response_model=FetchTriggerResponse)
async def trigger_fetch(
    body: FetchTriggerRequest,
    db: AsyncSession = Depends(get_db),
    # 수동 수집은 인증된 사용자라면 누구나 — public 데이터 수집이라 권한 게이트 불필요.
    user: User = Depends(get_current_user),
):
    since = date.today() - timedelta(days=body.since_days)
    if body.source:
        summary = await run_one(
            db,
            body.source,
            trigger_kind="MANUAL",
            triggered_by=user.id,
            since=since,
        )
        return FetchTriggerResponse(results=[summary.__dict__])
    results = await run_all(
        db, trigger_kind="MANUAL", triggered_by=user.id, since=since
    )
    return FetchTriggerResponse(results=[r.__dict__ for r in results])


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@router.get("/runs", response_model=list[FetchRunOut])
async def list_runs(
    db: AsyncSession = Depends(get_db),
    # source 관리 화면(/admin/announcements) 에서 SUPER_ADMIN 이 호출하므로 권한 풀어둠.
    _user: User = Depends(get_current_user),
    source: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    q = select(AnnouncementFetchRun).order_by(AnnouncementFetchRun.started_at.desc())
    if source:
        q = q.where(AnnouncementFetchRun.source_code == source)
    q = q.limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return [
        FetchRunOut(
            id=r.id,
            source_id=r.source_id,
            source_code=r.source_code,
            trigger_kind=r.trigger_kind,
            started_at=r.started_at,
            finished_at=r.finished_at,
            status=r.status,
            fetched_count=r.fetched_count,
            inserted_count=r.inserted_count,
            updated_count=r.updated_count,
            skipped_count=r.skipped_count,
            error_message=r.error_message,
        )
        for r in rows
    ]
