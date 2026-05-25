"""사업공고 수집 — 나라장터·NTIS·IRIS·BizInfo·K-Startup 등 외부 소스.

스케줄러가 매일 03:00 KST 에 모든 활성 소스를 순회하며 UPSERT 한다.
중복 방지는 (source_id, external_id) UNIQUE.

설계 메모
- `announcement_sources` 는 코드 내 adapter registry 와 1:1 로 매핑되는 seed 데이터.
  실제 비밀키(API key) 는 `app_settings.announcements.sources.<code>.api_key` 쪽에.
- `raw_payload` 는 원본 응답을 보존해 파서 변경 시 재처리 가능.
- 본문 전체는 저장하지 않는다 (저작권 · 용량). summary + detail_url 만.
- `converted_opportunity_id` 는 FK 를 걸지 않는다 — 기존 Opportunity 의
  `converted_license_id` 패턴과 동일. 삭제 연쇄 방지.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    ARRAY,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class AnnouncementSource(Base, UUIDMixin, TimestampMixin):
    """사업공고 소스 마스터. 코드 내 adapter 와 1:1."""

    __tablename__ = "announcement_sources"

    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    agency: Mapped[str | None] = mapped_column(String(200))
    base_url: Mapped[str | None] = mapped_column(String(500))
    # 'openapi' | 'html' | 'rss'
    adapter_kind: Mapped[str] = mapped_column(
        String(20), nullable=False, default="openapi"
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    priority: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=100)

    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    last_count: Mapped[int | None] = mapped_column(Integer)

    announcements: Mapped[list["Announcement"]] = relationship(
        back_populates="source", cascade="save-update, merge"
    )


class Announcement(Base, UUIDMixin, TimestampMixin):
    """수집된 공고 한 건. (source_id, external_id) UNIQUE."""

    __tablename__ = "announcements"
    __table_args__ = (
        UniqueConstraint("source_id", "external_id", name="uq_announcement_source_ext"),
    )

    source_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("announcement_sources.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    external_id: Mapped[str] = mapped_column(String(200), nullable=False)

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    agency: Mapped[str | None] = mapped_column(String(200), index=True)
    department: Mapped[str | None] = mapped_column(String(200))
    # RESEARCH | PUBLIC_BID | PRIVATE_BID | STARTUP | SUPPORT | OTHER
    business_type: Mapped[str | None] = mapped_column(String(20), index=True)
    category: Mapped[str | None] = mapped_column(String(100))
    region: Mapped[str | None] = mapped_column(String(80))

    posted_at: Mapped[date | None] = mapped_column(Date, index=True)
    deadline_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )

    budget_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 0))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")

    contact_name: Mapped[str | None] = mapped_column(String(100))
    contact_phone: Mapped[str | None] = mapped_column(String(50))
    contact_email: Mapped[str | None] = mapped_column(String(200))

    detail_url: Mapped[str | None] = mapped_column(String(1000))
    attachment_urls: Mapped[list[str] | None] = mapped_column(ARRAY(String(1000)))
    summary: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict | None] = mapped_column(JSONB)

    content_hash: Mapped[str | None] = mapped_column(String(64))
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Opportunity 로 전환된 경우 기록 (FK 없음 — 삭제 연쇄 차단).
    converted_opportunity_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True))

    source: Mapped["AnnouncementSource"] = relationship(back_populates="announcements")
    bookmarks: Mapped[list["AnnouncementBookmark"]] = relationship(
        back_populates="announcement", cascade="all, delete-orphan"
    )


class AnnouncementFetchRun(Base, UUIDMixin):
    """수집 실행 이력 — 소스별 한 번의 fetch 사이클."""

    __tablename__ = "announcement_fetch_runs"

    source_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("announcement_sources.id", ondelete="SET NULL"),
        index=True,
    )
    source_code: Mapped[str] = mapped_column(String(40), nullable=False)
    # SCHEDULED | MANUAL
    trigger_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    triggered_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # RUNNING | OK | FAILED | SKIPPED
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="RUNNING")

    fetched_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    inserted_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)


class AnnouncementBookmark(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """사용자 북마크 — 관심 공고."""

    __tablename__ = "announcement_bookmarks"
    __table_args__ = (
        UniqueConstraint(
            "announcement_id", "user_id", name="uq_announcement_bookmark_user"
        ),
    )

    announcement_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("announcements.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    memo: Mapped[str | None] = mapped_column(Text)

    announcement: Mapped["Announcement"] = relationship(back_populates="bookmarks")
