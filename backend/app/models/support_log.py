"""기술지원 — 활동 로그 (Logs).

기술지원 전담 인력이 수행한 지원 활동의 기록 (시간, 내용, 첨부, 코멘트).
케이스(`support_cases`) 와 별도 — 케이스에 종속된 작업 로그가 아니라
독립된 일자별 활동 기록 (예: 정기 점검, 단발성 장애 대응).

  support_logs ──┬── support_log_attachments  (1:N)
                 └── support_log_comments     (1:N)

권한: `support.manage` (SALES + HR + SUPPORT + ADMIN).
"""

from datetime import date
from uuid import UUID

from sqlalchemy import Date, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class SupportLog(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "support_logs"

    customer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        index=True,
    )
    sales_rep_developer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    support_engineer_developer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )

    # 지원 일정 — 시작일 ≤ 종료일. 단일 일자면 동일 값.
    start_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # 소요 시간 — 분 단위 저장 (UI 는 "2시간 30분" 형식 표기/입력).
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 제조사 — 정보·필터링용 단일 컬럼. 제품들은 별도 join 테이블
    # support_log_products 에 다중으로 저장 (product 별 version 도 함께).
    vendor_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("vendors.id", ondelete="RESTRICT"),
        index=True,
    )

    body: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    attachments: Mapped[list["SupportLogAttachment"]] = relationship(
        back_populates="log",
        cascade="all, delete-orphan",
        order_by="SupportLogAttachment.created_at",
    )
    comments: Mapped[list["SupportLogComment"]] = relationship(
        back_populates="log",
        cascade="all, delete-orphan",
        order_by="SupportLogComment.created_at",
    )
    products: Mapped[list["SupportLogProduct"]] = relationship(
        back_populates="log",
        cascade="all, delete-orphan",
        order_by="SupportLogProduct.sort_order",
    )


class SupportLogAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "support_log_attachments"

    log_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("support_logs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(Integer)

    log: Mapped[SupportLog] = relationship(back_populates="attachments")


class SupportLogProduct(Base, TenantMixin, TimestampMixin):
    """SupportLog ↔ Product 다대다 join + product 별 version_id.

    한 SupportLog 가 여러 product 를 대상으로 진행될 수 있고, 각 product 마다
    별도 version 을 지정 가능. PK 는 (support_log_id, product_id) — 같은 product
    중복 부착 불가. sort_order 로 UI 정렬 보존.
    """

    __tablename__ = "support_log_products"

    support_log_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("support_logs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    product_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    version_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("product_versions.id", ondelete="RESTRICT"),
        index=True,
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0",
    )

    log: Mapped[SupportLog] = relationship(back_populates="products")


class SupportLogComment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "support_log_comments"

    log_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("support_logs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # 이 코멘트로 기록된 지원 시간(분). 로그 전체 duration_minutes 는
    # 코멘트 add/edit/delete 시 SUM(comments.duration_minutes) 로 자동 갱신.
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 코멘트별 지원 일자. 로그 전체 start_date/end_date 는 MIN/MAX 로 자동 갱신.
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)

    log: Mapped[SupportLog] = relationship(back_populates="comments")
