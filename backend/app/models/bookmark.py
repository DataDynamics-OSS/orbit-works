"""북마크 — 헤더 빠른 도구 drawer 의 "북마크" 패널.

scope 두 가지를 같은 테이블에 저장:
- `PERSONAL` — 사용자 개인. owner_user_id 가 본인. 본인만 보고 본인만 편집.
- `COMPANY`  — 회사 공용. ADMIN/HR 가 Settings 에서 관리. visible_roles 로
  role 별 노출 여부 결정 (NULL = 전직원, ADMIN 은 항상).

`info` 필드는 로그인 정보 등 자유 메모 — 평문 저장이지만 drawer UI 에서
기본 마스킹 + 복사 버튼으로 노출.
"""

from uuid import UUID

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Bookmark(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "bookmarks"

    # PERSONAL | COMPANY
    scope: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    # PERSONAL 일 때만 채워짐 — owner 가 본인일 때만 편집/조회. user 삭제 시
    # 북마크도 같이 사라지도록 CASCADE.
    owner_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    category: Mapped[str | None] = mapped_column(String(50), nullable=True)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    info: Mapped[str | None] = mapped_column(Text, nullable=True)
    # COMPANY 한정 — NULL/빈 배열 = 전직원 노출, 값 있으면 그 role + ADMIN 만.
    # 패턴은 board_posts.visible_roles 와 동일.
    visible_roles: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(20)), nullable=True
    )
    # 정보(info) 필드 가시성 — visible_roles 와 동일 의미 체계.
    # NULL = row 가시 사용자 전원에게 정보 노출 (전직원 공개와 짝)
    # [] (빈 배열) = 아무에게도 정보 미노출 (default OFF)
    # ["HR"] = HR + ADMIN 만 정보 노출. 그 외 role 은 row 는 보되 ⓘ 없음.
    # info_visible_roles ⊆ visible_roles ∪ {ADMIN} (UI 단계 강제).
    info_visible_roles: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(20)), nullable=True
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
