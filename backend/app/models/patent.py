"""특허(Patent) — 자사 보유·출원 특허 원장 + 첨부 서류.

상태: `FILED`(출원) / `REGISTERED`(등록). 수동 전환만 (자동 X).
국가는 자유 텍스트 (KR/US/JP/EP 등 + 필요 시 한글 풀네임).
발명자는 자유 텍스트 (외부 공동 발명자 케이스 — 임직원 매핑 필요시 향후 보조 테이블).
"""

import uuid
from datetime import date

from sqlalchemy import (
    Date,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Patent(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "patents"

    # FILED(출원) | REGISTERED(등록).
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="FILED", index=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)  # 발명의 명칭
    application_no: Mapped[str | None] = mapped_column(String(100))   # 출원번호
    patent_no: Mapped[str | None] = mapped_column(String(100))        # 특허번호 (등록번호)
    filed_date: Mapped[date | None] = mapped_column(Date)
    registered_date: Mapped[date | None] = mapped_column(Date)
    patent_holder: Mapped[str | None] = mapped_column(String(200))    # 특허권자
    holder_address: Mapped[str | None] = mapped_column(Text)
    inventors: Mapped[str | None] = mapped_column(Text)               # 발명자 (콤마 구분)
    inventor_address: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(String(50))           # 국가 (KR/US 등)
    memo: Mapped[str | None] = mapped_column(Text)

    attachments: Mapped[list["PatentAttachment"]] = relationship(
        back_populates="patent",
        cascade="all, delete-orphan",
        order_by="PatentAttachment.created_at",
    )


class PatentAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "patent_attachments"

    patent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("patents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    file_size: Mapped[int | None] = mapped_column(Integer)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    patent: Mapped[Patent] = relationship(back_populates="attachments")
