from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(200), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="USER")
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

    # 사용자별 전역 스크래치패드 메모 — 우측 drawer 로 어느 페이지에서든 편집.
    memo: Mapped[str | None] = mapped_column(Text)
    memo_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # 사용자가 공지사항 목록을 마지막으로 본 시각. 그 이후 발행된 공지를
    # "안 읽음" 으로 카운트해 모바일/웹 헤더에 배지 표시.
    # 사용자가 /board/posts/seen 을 명시적으로 호출하거나 공지 목록 페이지에
    # 진입하면 갱신.
    last_notice_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )

    # admin 초기 부트스트랩용: 이 users 행이 어느 임직원(developer)에 매핑돼 있는지.
    # 일반 users 행도 로그인 시 developer 매칭을 위해 자동 세팅됨.
    mapped_developer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )

    # 멀티 테넌트 — 이 사용자가 속한 회사. SUPER_ADMIN 은 NULL.
    # 일반 ADMIN/HR/SALES/SUPPORT/ETC 는 NOT NULL — INSERT 자체는 nullable 컬럼이라
    # 가능하지만 RLS WITH CHECK 가 차단. SUPER_ADMIN 부트스트랩 행 한 건만 NULL.
    tenant_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        index=True,
    )
