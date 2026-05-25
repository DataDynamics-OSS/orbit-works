"""도움말 컨텐츠 (Help Articles) — DB 기반 본문 + 버전 관리.

코드의 `frontend/lib/help-content.tsx` 가 정적 default 이고, 이 테이블이
override 역할. 사이드바 도움말 페이지 + DashboardHeader 의 ? 아이콘이
DB 우선 / 코드 fallback 순으로 본문을 조회한다.

저장 시점마다 `help_article_revisions` 에 snapshot 을 적재해 복원 가능.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class HelpArticle(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """tenant 별 (menu_key) 도움말 row.

    `menu_key` 는 `menu-registry.ts` / 기존 `help-content.tsx` 와 동일한
    식별자라 DashboardHeader 의 ? 아이콘이 lookup 가능. UNIQUE(tenant, menu_key).
    """

    __tablename__ = "help_articles"

    # menu-registry 의 key (예: 'kb', 'customer-status', 'marketing.campaigns').
    menu_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # 카테고리 라벨 — 도움말 페이지에서 그룹 헤더로 사용. 코드 패턴과 동일.
    group: Mapped[str | None] = mapped_column(String(60))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 한 줄 요약 — 목록 카드/검색 결과에 노출.
    summary: Mapped[str | None] = mapped_column(Text)
    # 본문 HTML (TipTap). 이미지는 base64 data URL 로 inline 가능.
    body_html: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 검색 캐시.
    body_text: Mapped[str | None] = mapped_column(Text)

    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )

    revisions: Mapped[list["HelpArticleRevision"]] = relationship(
        back_populates="article",
        cascade="all, delete-orphan",
        order_by="HelpArticleRevision.saved_at.desc()",
        passive_deletes=True,
    )


class HelpArticleRevision(Base, UUIDMixin, TenantMixin):
    """저장 시점마다 article 의 snapshot. 복원 (POST restore) 기준.

    별도 timestamp_mixin 안 씀 — saved_at 컬럼 명시.
    """

    __tablename__ = "help_article_revisions"

    article_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("help_articles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # snapshot 시점의 메타·본문 — 복원 시 그대로 적용.
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    group: Mapped[str | None] = mapped_column(String(60))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    summary: Mapped[str | None] = mapped_column(Text)
    body_html: Mapped[str] = mapped_column(Text, nullable=False, default="")
    body_text: Mapped[str | None] = mapped_column(Text)
    # 운영자가 남길 수 있는 변경 사유 메모.
    change_note: Mapped[str | None] = mapped_column(Text)

    saved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    from sqlalchemy import DateTime, func as _func  # local import 회피용
    saved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_func.now(),
    )

    article: Mapped["HelpArticle"] = relationship(back_populates="revisions")
