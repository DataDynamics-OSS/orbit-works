"""임직원 여권정보 — 1:1 with `developers`.

PII 취급:
- `passport_number_enc` 는 Fernet 으로 암호화 (`enc:` prefix). DB 에 평문 저장 X.
- 디코딩은 `app.core.secrets_crypto.decrypt_secret` 으로 가능 (대칭키, 운영자가
  config.yaml `security.secrets_key` 보관).

조회/수정 권한 (앱 레벨 가드):
- 본인 (`User.mapped_developer_id == developer_id`)
- HR / ADMIN / SUPER_ADMIN

다른 임직원의 상세 페이지에서는 탭 자체를 숨겨 클라이언트에 데이터를 노출하지 않음.
"""

from datetime import date
from uuid import UUID

from sqlalchemy import Date, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class DeveloperPassport(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """임직원 1명당 여권 1건 (1:1)."""

    __tablename__ = "developer_passports"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Fernet 암호화 토큰 (`enc:` prefix). `secrets_crypto.decrypt_secret` 로 복원.
    passport_number_enc: Mapped[str | None] = mapped_column(Text)
    # 'M' | 'F' — 여권에 표기되는 성별 (Sex).
    gender: Mapped[str | None] = mapped_column(String(1))
    surname_en: Mapped[str | None] = mapped_column(String(100))     # 영문 성
    given_name_en: Mapped[str | None] = mapped_column(String(100))  # 영문 이름
    nationality: Mapped[str | None] = mapped_column(String(3))      # ISO 3-letter (예: "KOR")
    issue_date: Mapped[date | None] = mapped_column(Date)
    expiry_date: Mapped[date | None] = mapped_column(Date)
    issue_country: Mapped[str | None] = mapped_column(String(60))   # 발급국가 (자유 텍스트, 예: "Republic of Korea")
    # REGULAR | OFFICIAL | DIPLOMATIC — frontend 와 동기화.
    passport_type: Mapped[str | None] = mapped_column(String(20))

    __table_args__ = (
        # 임직원 1명당 여권 1건 — 동일 developer_id row 가 하나만.
        UniqueConstraint("developer_id", name="uq_developer_passports_dev"),
    )
