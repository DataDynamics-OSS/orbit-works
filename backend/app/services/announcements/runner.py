"""사업공고 수집 실행자.

- `run_one(source_code, ...)`  — 단일 소스 실행 (수동 버튼 등).
- `run_all(...)`              — 활성 소스 전체를 순차 실행 (스케줄러 용).

공통 동작:
1. `AnnouncementFetchRun` row 생성 (RUNNING)
2. 어댑터 `fetch()` 호출
3. (source_id, external_id) UPSERT — content_hash 가 다르면 updated++
4. run 종료 시 status=OK/FAILED/SKIPPED + 카운트 기록
5. `announcement_sources.last_*` 동기화
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.announcement import (
    Announcement,
    AnnouncementFetchRun,
    AnnouncementSource,
)
from app.services.announcements.base import (
    AnnouncementAdapter,
    AnnouncementFetchError,
    RawAnnouncement,
)
from app.services.announcements.registry import ADAPTERS

logger = logging.getLogger(__name__)


@dataclass
class RunSummary:
    source_code: str
    status: str           # OK | FAILED | SKIPPED
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    error: str | None = None


def _source_config(code: str) -> dict:
    """`announcements.sources.<code>` 를 dict 로 꺼낸다."""
    a = get_settings().announcements
    src = a.sources.get(code)
    if src is None:
        return {"enabled": True, "api_key": ""}
    return {"enabled": src.enabled, "api_key": src.api_key}


def _build_adapter(code: str) -> AnnouncementAdapter | None:
    cls = ADAPTERS.get(code)
    if cls is None:
        return None
    cfg = _source_config(code)
    return cls(api_key=cfg.get("api_key", ""), config=cfg)


async def _get_source(db: AsyncSession, code: str) -> AnnouncementSource | None:
    q = select(AnnouncementSource).where(AnnouncementSource.code == code)
    return (await db.execute(q)).scalar_one_or_none()


async def _upsert_one(
    db: AsyncSession,
    *,
    source_id: UUID,
    raw: RawAnnouncement,
    now: datetime,
) -> str:
    """한 건 UPSERT. 반환: 'inserted' | 'updated' | 'skipped'."""
    content_hash = raw.compute_hash()
    values = {
        "source_id": source_id,
        "external_id": raw.external_id,
        "title": raw.title[:500],
        "agency": raw.agency,
        "department": raw.department,
        "business_type": raw.business_type,
        "category": raw.category,
        "region": raw.region,
        "posted_at": raw.posted_at,
        "deadline_at": raw.deadline_at,
        "budget_amount": raw.budget_amount,
        "currency": raw.currency or "KRW",
        "contact_name": raw.contact_name,
        "contact_phone": raw.contact_phone,
        "contact_email": raw.contact_email,
        "detail_url": raw.detail_url,
        "attachment_urls": raw.attachment_urls,
        "summary": raw.summary,
        "raw_payload": raw.raw_payload,
        "content_hash": content_hash,
        "first_seen_at": now,
        "last_seen_at": now,
        "is_active": True,
    }
    stmt = pg_insert(Announcement).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["source_id", "external_id"],
        set_={
            "title": stmt.excluded.title,
            "agency": stmt.excluded.agency,
            "department": stmt.excluded.department,
            "business_type": stmt.excluded.business_type,
            "category": stmt.excluded.category,
            "region": stmt.excluded.region,
            "posted_at": stmt.excluded.posted_at,
            "deadline_at": stmt.excluded.deadline_at,
            "budget_amount": stmt.excluded.budget_amount,
            "currency": stmt.excluded.currency,
            "contact_name": stmt.excluded.contact_name,
            "contact_phone": stmt.excluded.contact_phone,
            "contact_email": stmt.excluded.contact_email,
            "detail_url": stmt.excluded.detail_url,
            "attachment_urls": stmt.excluded.attachment_urls,
            "summary": stmt.excluded.summary,
            "raw_payload": stmt.excluded.raw_payload,
            "content_hash": stmt.excluded.content_hash,
            "last_seen_at": stmt.excluded.last_seen_at,
            "is_active": True,
            "updated_at": now,
        },
        where=(Announcement.content_hash.is_distinct_from(content_hash)),
    ).returning(Announcement.id, Announcement.first_seen_at)
    res = await db.execute(stmt)
    row = res.first()
    if row is None:
        # WHERE 가 거짓이어서 no-op — 이미 동일 content. last_seen_at 만 touch.
        await db.execute(
            Announcement.__table__.update()
            .where(
                (Announcement.source_id == source_id)
                & (Announcement.external_id == raw.external_id)
            )
            .values(last_seen_at=now, is_active=True)
        )
        return "skipped"
    _id, first_seen = row
    if first_seen == now:
        return "inserted"
    return "updated"


async def _run_with_adapter(
    db: AsyncSession,
    source: AnnouncementSource,
    adapter: AnnouncementAdapter,
    *,
    trigger_kind: str,
    triggered_by: UUID | None,
    since: date,
) -> RunSummary:
    now = datetime.now(timezone.utc)
    run = AnnouncementFetchRun(
        source_id=source.id,
        source_code=source.code,
        trigger_kind=trigger_kind,
        triggered_by=triggered_by,
        started_at=now,
        status="RUNNING",
    )
    db.add(run)
    await db.flush()

    summary = RunSummary(source_code=source.code, status="OK")

    if adapter.requires_api_key and not adapter.api_key:
        summary.status = "SKIPPED"
        summary.error = "api_key 미설정"
        run.status = "SKIPPED"
        run.finished_at = datetime.now(timezone.utc)
        run.error_message = summary.error
        source.last_fetched_at = now
        source.last_error = summary.error
        source.last_count = 0
        await db.commit()
        return summary

    try:
        raws = await adapter.fetch(since)
        summary.fetched = len(raws)
        for raw in raws:
            if not raw.external_id or not raw.title:
                summary.skipped += 1
                continue
            outcome = await _upsert_one(db, source_id=source.id, raw=raw, now=now)
            if outcome == "inserted":
                summary.inserted += 1
            elif outcome == "updated":
                summary.updated += 1
            else:
                summary.skipped += 1
        run.status = "OK"
        source.last_ok_at = datetime.now(timezone.utc)
        source.last_error = None
    except AnnouncementFetchError as exc:
        logger.warning("공고 수집 실패 [%s]: %s", source.code, exc)
        summary.status = "FAILED"
        summary.error = str(exc)
        run.status = "FAILED"
        run.error_message = summary.error
        source.last_error = summary.error[:500]
    except Exception as exc:  # pragma: no cover
        logger.exception("공고 수집 예외 [%s]", source.code)
        summary.status = "FAILED"
        summary.error = f"{type(exc).__name__}: {exc}"
        run.status = "FAILED"
        run.error_message = summary.error
        source.last_error = summary.error[:500]
    finally:
        run.finished_at = datetime.now(timezone.utc)
        run.fetched_count = summary.fetched
        run.inserted_count = summary.inserted
        run.updated_count = summary.updated
        run.skipped_count = summary.skipped
        source.last_fetched_at = datetime.now(timezone.utc)
        source.last_count = summary.fetched
        await db.commit()

    return summary


async def run_one(
    db: AsyncSession,
    source_code: str,
    *,
    trigger_kind: str = "MANUAL",
    triggered_by: UUID | None = None,
    since: date | None = None,
) -> RunSummary:
    source = await _get_source(db, source_code)
    if source is None:
        return RunSummary(source_code=source_code, status="SKIPPED", error="소스 없음")
    adapter = _build_adapter(source_code)
    if adapter is None:
        return RunSummary(
            source_code=source_code, status="SKIPPED", error="어댑터 미구현"
        )
    if since is None:
        a = get_settings().announcements
        since = date.today() - timedelta(days=max(1, a.auto_fetch.catchup_days))
    return await _run_with_adapter(
        db,
        source,
        adapter,
        trigger_kind=trigger_kind,
        triggered_by=triggered_by,
        since=since,
    )


async def run_all(
    db: AsyncSession,
    *,
    trigger_kind: str = "SCHEDULED",
    triggered_by: UUID | None = None,
    since: date | None = None,
) -> list[RunSummary]:
    """활성 소스 전체를 priority 오름차순으로 순차 실행."""
    a = get_settings().announcements
    if since is None:
        since = date.today() - timedelta(days=max(1, a.auto_fetch.catchup_days))

    q = (
        select(AnnouncementSource)
        .where(AnnouncementSource.enabled.is_(True))
        .order_by(AnnouncementSource.priority.asc(), AnnouncementSource.code.asc())
    )
    sources = (await db.execute(q)).scalars().all()
    results: list[RunSummary] = []
    for source in sources:
        cfg = _source_config(source.code)
        if not cfg.get("enabled", True):
            results.append(
                RunSummary(
                    source_code=source.code,
                    status="SKIPPED",
                    error="settings.enabled=false",
                )
            )
            continue
        adapter = _build_adapter(source.code)
        if adapter is None:
            results.append(
                RunSummary(
                    source_code=source.code,
                    status="SKIPPED",
                    error="어댑터 미구현",
                )
            )
            continue
        summary = await _run_with_adapter(
            db,
            source,
            adapter,
            trigger_kind=trigger_kind,
            triggered_by=triggered_by,
            since=since,
        )
        results.append(summary)
    return results
