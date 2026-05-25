"""근무지(Worksite) + 직원 매핑(WorksiteAssignment) + 프로젝트 매핑(M:N).

근무지는 프로젝트와 무관하게도 존재 가능 (link 0건 허용). 출퇴근 GPS 검증의
기준점 — `latitude`/`longitude` + `radius_meters` 안에서 체크인 가능.

매핑(`WorksiteAssignment`) 은 직원 ↔ 근무지 M:N. 한 직원이 동시에 여러 근무지에
배정될 수 있으며 (예: 평일 오전 본사 + 오후 클라이언트 상주), 출퇴근 시 사용자가
어느 근무지로 기록할지 선택한다.

근무지 ↔ 프로젝트 M:N 은 association table `worksite_projects` 만 두고
별도 모델 클래스 없이 `Worksite.projects` relationship 으로 노출.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Table,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


# 근무지 ↔ 프로젝트 M:N association. tenant_id 도 같이 둬 RLS 격리 일관성 확보
# — 부모(worksites/projects) 가 같은 tenant 인지를 DB 레벨에서 한 번 더 검증.
worksite_projects = Table(
    "worksite_projects",
    Base.metadata,
    Column(
        "tenant_id",
        UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        primary_key=True,
        index=True,
    ),
    Column(
        "worksite_id",
        UUID(as_uuid=True),
        ForeignKey("worksites.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "project_id",
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    ),
)


class Worksite(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "worksites"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(Text)
    # GPS 좌표 — numeric(10,7) ≈ 11mm 정밀도. NULL 허용 (등록 직후 좌표 미입력 가능).
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(10, 7))
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(10, 7))
    # 출퇴근 허용 반경(m). 등록 시 사용자 직접 입력 (도심·외곽 따라 다름).
    radius_meters: Mapped[int] = mapped_column(Integer, nullable=False)
    # 근무시간 — "HH:MM" 30분 단위. 출퇴근 정시·지각 분류에 사용 (PR 2 에서).
    work_start_time: Mapped[str] = mapped_column(
        String(5), nullable=False, default="09:00"
    )
    work_end_time: Mapped[str] = mapped_column(
        String(5), nullable=False, default="18:00"
    )
    # ACTIVE | INACTIVE — 종료된 근무지는 INACTIVE 로 soft-disable (기록 보존).
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ACTIVE", index=True
    )
    memo: Mapped[str | None] = mapped_column(Text)

    # M:N 프로젝트. 0건 허용 (프로젝트 무관 근무지).
    projects = relationship(
        "Project",
        secondary=worksite_projects,
        lazy="select",
    )
    assignments: Mapped[list["WorksiteAssignment"]] = relationship(
        back_populates="worksite",
        cascade="all, delete-orphan",
        order_by="WorksiteAssignment.start_date.desc()",
    )


class WorksiteAssignment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "worksite_assignments"

    worksite_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("worksites.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    developer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    # NULL = 진행중. 매핑 종료 시 end_date 채워 보존 (hard delete 도 옵션).
    end_date: Mapped[date | None] = mapped_column(Date)
    # 직원이 여러 근무지에 매핑됐을 때 1순위 (UI 자동 선택용).
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    memo: Mapped[str | None] = mapped_column(Text)

    worksite: Mapped["Worksite"] = relationship(back_populates="assignments")
    developer = relationship("Developer", foreign_keys=[developer_id], lazy="select")
