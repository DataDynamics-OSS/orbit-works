"""주간보고 (Weekly Reports).

도메인:
  - 매주(ISO week) 지정된 임직원이 자신의 주간 보고를 작성.
  - 한 직원 × 한 주 = 1 row (UNIQUE).
  - 양식(template) 두 가지 — 매니저 / 일반. 작성자의 부하 유무로 자동 선택.
  - 본문 = TipTap HTML (게시판/공지/목표와 동일 에디터).
  - 첨부 파일 N 개.
  - 제출(SUBMITTED) 후에도 본인은 재편집 가능 (status 토글 → submitted_at 갱신).
  - 코멘트 — SUBMITTED 상태에서만 작성 가능. 작성 시 owner 에게 DM 알림.

테이블 5종:
  weekly_report_assignments  — 누가 매주 써야 하는지 (관리자 지정).
  weekly_reports             — 보고서 본체.
  weekly_report_attachments  — 첨부.
  weekly_report_templates    — tenant 별 양식 (kind=MANAGER|GENERAL).
  weekly_report_comments     — 보고서 코멘트 (피드백·질문).
"""

from __future__ import annotations

import uuid
from datetime import date as date_cls, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class WeeklyReportAssignment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """누가 매주 보고서를 써야 하는지 — ADMIN/HR 가 지정."""

    __tablename__ = "weekly_report_assignments"
    __table_args__ = (
        # 한 직원 1 row — 활성/비활성·기간으로만 토글.
        UniqueConstraint("tenant_id", "developer_id", name="uq_wra_dev"),
    )

    developer_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # ISO 시작/종료 주 — NULL = 무기한. 인사이동·퇴사 시 종료 주 채움.
    start_year: Mapped[int | None] = mapped_column(Integer)
    start_week: Mapped[int | None] = mapped_column(Integer)
    end_year: Mapped[int | None] = mapped_column(Integer)
    end_week: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)


class WeeklyReport(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """1 직원 × 1 ISO 주 = 1 row."""

    __tablename__ = "weekly_reports"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "developer_id", "iso_year", "iso_week",
            name="uq_wr_dev_year_week",
        ),
    )

    developer_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    iso_year: Mapped[int] = mapped_column(Integer, nullable=False)
    iso_week: Mapped[int] = mapped_column(Integer, nullable=False)
    # ISO 주의 월요일 / 일요일 — 표시·필터·정렬 편의용 캐시.
    week_start: Mapped[date_cls] = mapped_column(Date, nullable=False)
    week_end: Mapped[date_cls] = mapped_column(Date, nullable=False)

    # 본문 — TipTap HTML. plain_text 는 검색 용 캐시 (HTML 태그 제거).
    body: Mapped[str | None] = mapped_column(Text)
    plain_text: Mapped[str | None] = mapped_column(Text)

    # DRAFT (작성중) / SUBMITTED (제출 완료, 본인이 토글).
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="DRAFT", index=True,
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    attachments: Mapped[list["WeeklyReportAttachment"]] = relationship(
        back_populates="report",
        cascade="all, delete-orphan",
        order_by="WeeklyReportAttachment.created_at",
    )


class WeeklyReportAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "weekly_report_attachments"

    weekly_report_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("weekly_reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(300), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(BigInteger)

    report: Mapped[WeeklyReport] = relationship(back_populates="attachments")


class WeeklyReportTemplate(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """주간보고 양식 — tenant 당 (MANAGER / GENERAL) 두 종류 + 미설정 시 코드 fallback.

    Settings UI 에서 ADMIN 이 본문 HTML 직접 편집. 신규 보고서 lazy create
    시 작성자의 매니저 여부 (직속 부하 ≥1) 에 따라 자동 선택.
    """

    __tablename__ = "weekly_report_templates"
    __table_args__ = (
        UniqueConstraint("tenant_id", "kind", name="uq_wrt_kind"),
    )

    # MANAGER | GENERAL — 그 외 값 사전 검증은 service 계층에서.
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")


class WeeklyReportComment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """주간보고 코멘트 — TipTap HTML 본문.

    SUBMITTED 상태의 보고서에만 작성 가능 (DRAFT 시점에는 owner 가 아직
    편집중이므로 의미 없음). 보고서 read 권한자 (본인·매니저 chain·HR/ADMIN/
    SUPER_ADMIN) 는 누구나 작성·열람 가능. 편집·삭제는 작성자 + ADMIN.

    작성 즉시 owner (보고서 developer) 에게 Slack/Mattermost DM 발송 —
    본인이 본인 보고서에 작성한 경우는 self-notify 회피.
    """

    __tablename__ = "weekly_report_comments"

    weekly_report_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("weekly_reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
    )
    # developer 미매핑 사용자 (ADMIN 부트스트랩 등) fallback.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
