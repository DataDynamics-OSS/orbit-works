"""기술지원 — 케이스 (Cases).

고객사 제품 사용 중 발생한 문제·문의를 케이스 단위로 추적.

  support_cases ──┬── support_case_attachments  (1:N, 다중 파일)
                  └── support_case_comments     (1:N, 작성자 본인+ADMIN 만 편집·삭제)

권한: `support.manage` (SALES + HR + SUPPORT + ADMIN).
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, PrimaryKeyConstraint, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class SupportCase(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "support_cases"
    __table_args__ = (
        # 케이스 번호는 tenant 안에서 unique. URL/검색 키로 사용.
        UniqueConstraint("tenant_id", "case_no", name="uq_support_cases_tenant_case_no"),
    )

    # "CASE-YYYY-NNN" 형식 사람-친화 번호. tenant 단위로 매년 1부터 리셋.
    # 신규 case 생성 시 SupportCaseCounter 로 원자적 발급.
    case_no: Mapped[str | None] = mapped_column(String(20), index=True)

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
    # 영업대표 / 기술지원 담당자 — 정규직(FULL_TIME) 임직원에서 픽 (UI 가드).
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

    # 제조사 — 정보·필터링용 단일 컬럼. 제품들은 별도 join 테이블
    # support_case_products 에 다중으로 저장 (product 별 version 도 함께).
    vendor_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("vendors.id", ondelete="RESTRICT"),
        index=True,
    )
    # 벤더(예: Cloudera) 의 케이스 트래킹 번호 — 자유 텍스트.
    vendor_case_no: Mapped[str | None] = mapped_column(String(120), index=True)

    # 케이스 제목 — 그리드 / 상세 헤드라인. 필수.
    title: Mapped[str] = mapped_column(String(300), nullable=False)

    # OPEN / IN_PROGRESS / CLOSED — 라벨: 등록 / 처리중 / 종료.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="OPEN", index=True
    )

    # 케이스 유형 — PERFORMANCE | MALFUNCTION | SECURITY | DATA_LOSS |
    # TUNING | JOB_FAILURE | SERVICE_DOWN | OTHER. 통계/필터 기본 축.
    category: Mapped[str] = mapped_column(
        String(30), nullable=False, default="OTHER", index=True
    )

    # AWS-style 5단계 심각도 — S1(긴급) ~ S5(정보). 기본 S3.
    severity: Mapped[str] = mapped_column(
        String(2), nullable=False, default="S3", index=True
    )

    # 케이스 세부 내용 (긴 텍스트 — 줄바꿈 보존).
    body: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    # 종료 메타. status → 'CLOSED' 로 전환할 때 라우터가 채우고, 재오픈 시 NULL 로 reset.
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    closed_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    attachments: Mapped[list["SupportCaseAttachment"]] = relationship(
        back_populates="case",
        cascade="all, delete-orphan",
        order_by="SupportCaseAttachment.created_at",
    )
    comments: Mapped[list["SupportCaseComment"]] = relationship(
        back_populates="case",
        cascade="all, delete-orphan",
        order_by="SupportCaseComment.created_at",
    )
    products: Mapped[list["SupportCaseProduct"]] = relationship(
        back_populates="case",
        cascade="all, delete-orphan",
        order_by="SupportCaseProduct.sort_order",
    )


class SupportCaseProduct(Base, TenantMixin, TimestampMixin):
    """SupportCase ↔ Product 다대다 join. product 별 version 도 함께 저장.

    PK 는 (support_case_id, product_id). sort_order 로 UI 정렬 보존.
    """

    __tablename__ = "support_case_products"

    support_case_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("support_cases.id", ondelete="CASCADE"),
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

    case: Mapped[SupportCase] = relationship(back_populates="products")


class SupportCaseAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "support_case_attachments"

    case_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("support_cases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(Integer)

    case: Mapped[SupportCase] = relationship(back_populates="attachments")


class SupportCaseComment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """케이스 코멘트 — 본인(작성자)와 ADMIN 만 편집·삭제 (앱 가드)."""

    __tablename__ = "support_case_comments"

    case_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("support_cases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)

    case: Mapped[SupportCase] = relationship(back_populates="comments")


class SupportCaseCounter(Base, TenantMixin):
    """케이스 번호 시퀀스 — (tenant, year) 별 last_seq.

    동시성: SELECT ... FOR UPDATE 로 row lock. 트랜잭션 내에서만 lock 유지.
    낮은 동시성(연 수십~수백 건) 환경이라 단순 패턴으로 충분.
    """

    __tablename__ = "support_case_counters"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "year", name="pk_support_case_counters"),
    )

    year: Mapped[int] = mapped_column(Integer, nullable=False)
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
