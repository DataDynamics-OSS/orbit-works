"""회의록 (MeetingNote) — 본문 + 공유 + 첨부.

P1 범위: 본문은 BlockNote JSON(TEXT) 으로 저장 + 5초 autosave (협업 동시편집 X).
P2/P3 에서 Yjs 본문/마인드맵 collab 추가 예정 — 이를 위해 `body_yjs` /
`mindmap_yjs` BYTEA 컬럼을 미리 자리 잡아 둠 (P1 에서는 NULL 유지).

도메인 명칭 충돌 회피:
- 기존 `MeetingRoom` / `MeetingReservation` 은 회의실 예약 도메인.
- 본 모델은 회의록 (회의 노트) — 다른 도메인이라 별도 테이블/모듈로 분리.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class MeetingNote(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "meeting_notes"

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        index=True,
    )
    # 작성자 표시용 — 로그인 사용자에 매핑된 developer. 매핑 없는 admin 은 NULL.
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    # 작성 주체(권한 판정·"내 회의록" 필터에 사용). 항상 NOT NULL — developer 매핑
    # 유무와 무관하게 모든 회의록은 정확히 1명의 user 가 작성.
    author_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )

    # 본문 — BlockNote JSON 직렬화. P1 에서는 단일 사용자 autosave.
    body: Mapped[str | None] = mapped_column(Text)
    # 검색용 평문 캐시 (P1 에서는 BlockNote 가 추출해 함께 보냄).
    plain_text: Mapped[str | None] = mapped_column(Text)
    # P2 협업: Yjs 본문 state (현재는 NULL — hocuspocus 도입 시 채움).
    body_yjs: Mapped[bytes | None] = mapped_column(LargeBinary)
    # P3-Lite 마인드맵: 단독 편집 — reactflow nodes/edges JSON.
    # `{"nodes": [...], "edges": [...]}` 형식. 동시편집(P3-Full) 으로 가면
    # mindmap_yjs 로 마이그레이션.
    mindmap_data: Mapped[dict | None] = mapped_column(JSONB)
    # P3-Full(미사용): Yjs 마인드맵 state. 동시편집 도입 시 사용.
    mindmap_yjs: Mapped[bytes | None] = mapped_column(LargeBinary)
    # drawio 다이어그램 — 자체 호스팅 drawio iframe 의 native XML 포맷
    # (`<mxfile>...</mxfile>`). 1 회의록 = 1 다이어그램. 빈 문자열은 사용자가
    # 명시적으로 비운 상태, NULL 은 한 번도 작성 안 함 — UI 의 ● 인디케이터
    # 분기에 사용.
    drawio_xml: Mapped[str | None] = mapped_column(Text)

    shares: Mapped[list["MeetingNoteShare"]] = relationship(
        back_populates="note",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    attachments: Mapped[list["MeetingNoteAttachment"]] = relationship(
        back_populates="note",
        cascade="all, delete-orphan",
        order_by="MeetingNoteAttachment.created_at",
        passive_deletes=True,
    )
    action_items: Mapped[list["MeetingNoteActionItem"]] = relationship(
        back_populates="note",
        cascade="all, delete-orphan",
        order_by="MeetingNoteActionItem.sort_order",
        passive_deletes=True,
    )
    author = relationship("Developer", foreign_keys=[author_id], lazy="select")


class MeetingNoteShare(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """회의록 공유 대상 (= 목록 노출 + 알림 발송 대상)."""

    __tablename__ = "meeting_note_shares"

    meeting_note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meeting_notes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    developer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Slack/Mattermost 발송 시각. 재발송 시 갱신.
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 마지막 열람 — read receipt 표시용 (선택 표시).
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    note: Mapped["MeetingNote"] = relationship(back_populates="shares")
    developer = relationship("Developer", foreign_keys=[developer_id], lazy="select")


class MeetingNoteAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """회의록 첨부. 디스크 경로: data/meeting-notes/{note_id}/<uuid>.<ext>."""

    __tablename__ = "meeting_note_attachments"

    meeting_note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meeting_notes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )

    note: Mapped["MeetingNote"] = relationship(back_populates="attachments")


class MeetingNoteActionItem(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """회의록 액션 아이템 (TODO).

    한 회의록 안의 1:N 항목. 담당자(정규직 developer 또는 외부 게스트 이름),
    마감일, 상태(TODO·IN_PROGRESS·DONE·BLOCKED). Slack DM 알림은 별도 cron
    job 이 due_date 기준으로 발송.
    """

    __tablename__ = "meeting_note_action_items"

    # nullable — 회의록과 무관한 standalone 액션 (sidebar > 내 액션의
    # "+ 액션 추가") 도 허용. 회의록 attached 면 회의록 삭제 시 cascade.
    meeting_note_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meeting_notes.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    # 담당자 — 사내 정규직(developer) 우선, 없으면 외부 게스트 이름.
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    assignee_name: Mapped[str | None] = mapped_column(String(120))
    due_date: Mapped[date | None] = mapped_column(Date)
    # 옵션 — 액션을 특정 고객사 / 프로젝트와 연결. standalone 액션이면 직접 입력.
    # 회의록 attached 액션은 회의록의 customer/project 와 별도로 override 가능.
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        index=True,
    )
    # TODO | IN_PROGRESS | DONE | BLOCKED
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="TODO", server_default="TODO"
    )
    note_text: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 완료 시 사용자가 남긴 한 줄 코멘트. 체크박스 클릭 → prompt 다이얼로그 입력.
    # DONE 외 상태로 다시 전이해도 보존 (재완료 시 덮어쓰기).
    completion_comment: Mapped[str | None] = mapped_column(Text)

    note: Mapped["MeetingNote"] = relationship(back_populates="action_items")
    assignee = relationship(
        "Developer", foreign_keys=[assignee_id], lazy="select"
    )
