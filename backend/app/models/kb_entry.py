"""지식 베이스 (KB) — 벤더 자료(DOC) + 트러블슈팅 노하우(KB) 통합.

`type` 컬럼으로 두 컨텐츠 성격을 한 테이블에서 구분:
- DOC : 벤더 PDF·매뉴얼·release note 등. 본문은 짧은 설명, 첨부 중심.
- KB  : 사내 트러블슈팅 노하우. TipTap 긴 본문 (문제·원인·해결), 부 첨부.

카탈로그 연동: `vendor_id` / `product_id` / `version_id` 는 기존
vendors / products / product_versions 마스터에 FK. 모두 nullable —
일반 가이드/사내 절차처럼 벤더 무관한 항목도 등록 가능.

`tags` 는 PostgreSQL text[] 로 저장 — 자유 분류 검색용 (예: install, perf, security).
`plain_text` 는 TipTap 본문에서 추출한 캐시 — quickFilter / quick search 용.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class KbEntry(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "kb_entries"

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    # 'DOC' | 'KB'. KB 는 사내 노하우, DOC 는 외부 벤더 자료.
    type: Mapped[str] = mapped_column(
        String(10), nullable=False, default="KB", server_default="KB", index=True,
    )

    # 카탈로그 연동 (선택). vendor 가 비면 product/version 도 비어야 자연스럽지만,
    # FK 차원에서는 각자 nullable — 인서트 검증은 API 레이어에서.
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT"), index=True,
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="RESTRICT"), index=True,
    )
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("product_versions.id", ondelete="RESTRICT"),
        index=True,
    )

    category: Mapped[str | None] = mapped_column(String(40), index=True)
    # PostgreSQL text[] — 자유 태그. UI 는 chip input.
    tags: Mapped[list[str] | None] = mapped_column(ARRAY(String))

    body: Mapped[str | None] = mapped_column(Text)           # TipTap HTML
    plain_text: Mapped[str | None] = mapped_column(Text)      # 검색 캐시
    source_url: Mapped[str | None] = mapped_column(String(1024))  # legacy 단일 URL (사용 안 함)
    # 외부 자료 링크 목록 — 최대 2개 (UI 가 강제). 형식: [{name: str, url: str}, ...].
    # JSON Schema 검증은 schema 레이어에서.
    source_links: Mapped[list[dict] | None] = mapped_column(JSONB)

    # KB 한정 — 트러블슈팅이 해결된 항목인지 표시. 기본 false.
    resolved: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )

    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True,
    )

    # entry 별 추가 가시성 제한. all = 모든 사용자, manager = 매니저 이상,
    # admin = ADMIN/SUPER_ADMIN. menu_permissions 의 kb 진입 조건과 AND.
    visibility: Mapped[str] = mapped_column(
        String(20), nullable=False, default="all", server_default="all",
    )

    attachments: Mapped[list["KbEntryAttachment"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
        order_by="KbEntryAttachment.created_at",
        passive_deletes=True,
    )


class KbEntryAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """KB entry 첨부. 디스크 경로: data/kb/<entry_id>/<uuid>.<ext>."""

    __tablename__ = "kb_entry_attachments"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("kb_entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )

    entry: Mapped["KbEntry"] = relationship(back_populates="attachments")
