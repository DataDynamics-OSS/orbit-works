"""고객사 인터랙션 로그 — 통화 / 미팅 / 이메일 등 영업·CS 활동 기록.

현재 `OpportunityActivity` 가 영업기회(Opportunity) 단위로 같은 역할을 하지만,
이쪽은 **회사 단위** 로 묶이는 자유 노트 + 첨부 모델. 개별 기회 없이 진행되는
일반 미팅·통화·후속 조치도 같이 모인다.

회사 360° 페이지에서 두 소스 (Opportunity activity + 회사 인터랙션) 를 한
타임라인으로 합쳐 보여줄 수 있다.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CustomerInteraction(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """회사 단위 인터랙션 로그 (자유 노트)."""

    __tablename__ = "customer_interactions"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # CALL | MEETING | EMAIL | OTHER — 자유 확장 가능. ENUM 안 쓰는 이유는
    # 신규 유형 추가 때 ALTER 부담을 피하기 위함.
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="OTHER")
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # 작성자 = 우리 직원. 매핑 안 된 admin 은 NULL → "관리자" 로 표시.
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)         # markdown 허용
    participants: Mapped[str | None] = mapped_column(Text)  # 자유 텍스트
    # 후속 조치 일정 — UI 에서 강조 표시. 이번 범위에선 알람 자동 생성 X.
    follow_up_at: Mapped[date | None] = mapped_column(Date, index=True)

    attachments: Mapped[list["CustomerInteractionAttachment"]] = relationship(
        back_populates="interaction",
        cascade="all, delete-orphan",
        order_by="CustomerInteractionAttachment.created_at",
    )
    author = relationship("Developer", foreign_keys=[author_id], lazy="select")


class CustomerInteractionAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """인터랙션 첨부 파일.

    저장 경로: ``data/customers/{customer_id}/interactions/{interaction_id}/<uuid>.<ext>``
    DB 에는 ``upload.dir`` 상대경로만 보관 (``customers/.../<uuid>.<ext>``).
    """

    __tablename__ = "customer_interaction_attachments"

    interaction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customer_interactions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)

    interaction: Mapped["CustomerInteraction"] = relationship(
        back_populates="attachments"
    )
