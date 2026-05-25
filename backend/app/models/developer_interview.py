"""임직원 면담 기록 — HR 가 직원과의 면담을 기록.

`support_case_comments` 와 동일한 단일-테이블 코멘트 패턴. 본인(작성자) 또는
ADMIN/SUPER_ADMIN 만 수정·삭제 — 앱 가드 + 백엔드 가드 양쪽 적용.
"""

from uuid import UUID

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class DeveloperInterview(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """면담 1회 기록. body 는 마크다운."""

    __tablename__ = "developer_interviews"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
