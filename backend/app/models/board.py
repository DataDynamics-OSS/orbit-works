"""Board (게시판) — 제목/내용/첨부파일 을 공유하는 내부 게시판.

- `board_posts`: 제목, 마크다운/TipTap 본문, 작성자, 고정 여부, 조회수
- `board_attachments`: post 당 여러 파일 (file_path 는 upload.dir 상대경로)
- `board_comments`: 글에 달리는 코멘트 (TipTap HTML, 작성자 User)
"""

from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class BoardPost(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "board_posts"

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    # BOARD (게시판, 기본) | NOTICE (공지사항)
    category: Mapped[str] = mapped_column(
        String(20), nullable=False, default="BOARD", index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    author_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 보안 역할 제한 — NULL/빈 배열 = 전체 공개. 값 있으면 그 role 만 볼 수 있음.
    # ADMIN 과 작성자는 항상 볼 수 있음 (목록·상세 가드에서 명시 처리).
    visible_roles: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(20)), nullable=True
    )

    attachments: Mapped[list["BoardAttachment"]] = relationship(
        back_populates="post",
        cascade="all, delete-orphan",
        order_by="BoardAttachment.created_at",
    )


class BoardAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "board_attachments"

    post_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("board_posts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    post: Mapped[BoardPost] = relationship(back_populates="attachments")


class BoardComment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """게시판 코멘트 — TipTap HTML 본문.

    글을 볼 수 있는 사용자(_can_view 통과) 누구나 작성·열람 가능. 편집·삭제는
    작성자 본인 + ADMIN. user 삭제 시 author_id NULL (코멘트는 보존).

    `parent_id` — 답글(대댓글) 자기참조. NULL = 루트 코멘트, 값 있으면 그
    코멘트의 답글. 같은 post 안에서만 부모 지정 가능 (API 단계 검증). 부모
    삭제 시 자식도 cascade 삭제. 깊이 제한 없음 (N 레벨 트리).
    """

    __tablename__ = "board_comments"

    post_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("board_posts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    parent_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("board_comments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    author_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
