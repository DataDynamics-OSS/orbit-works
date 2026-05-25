from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    ARRAY,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Developer(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "developers"

    name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    # 동명이인 식별용 뱃지. 같은 이름이 2명 이상이면 'A', 'B', 'C' ... 자동 할당.
    # 이름이 유일하면 NULL.
    tag: Mapped[str | None] = mapped_column(String(8))
    # 사번 — 정규직(FULL_TIME) 등록 시 서버가 자동 부여 (5자리 zero-padded "00001"~).
    # 한 번 부여되면 영구 (입사일 수정·고용형태 변경·퇴사 후에도 유지). 프리랜서/자사화는 NULL.
    # tenant 별 (tenant_id, employee_no) UNIQUE — 부분 인덱스 (NULL 허용).
    employee_no: Mapped[str | None] = mapped_column(String(8), index=True)
    employment_type: Mapped[str] = mapped_column(String(20), nullable=False, default="FREELANCER")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    title: Mapped[str | None] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(50))
    address: Mapped[str | None] = mapped_column(String(500))

    personal_email: Mapped[str | None] = mapped_column(String(200))
    company_email: Mapped[str | None] = mapped_column(String(200))
    tax_invoice_email: Mapped[str | None] = mapped_column(String(200))

    # 주민등록번호. 하이픈 포함 "XXXXXX-XXXXXXX" 형식 저장 (14자).
    resident_number: Mapped[str | None] = mapped_column(String(14))

    # PAYROLL | TAX_INVOICE | HOURLY (시간당 — 인턴/아르바이트 등)
    payment_method: Mapped[str] = mapped_column(String(20), nullable=False, default="PAYROLL")
    business_no: Mapped[str | None] = mapped_column(String(50))
    business_address: Mapped[str | None] = mapped_column(String(500))

    # Annual salary (KRW) — currently used for freelancers
    salary: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    # 시간당 금액 (KRW) — payment_method = HOURLY 인 경우 사용 (인턴/아르바이트).
    hourly_rate: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))

    # 입사일 및 입사일 기준 경력(개월)
    hire_date: Mapped[date | None] = mapped_column(Date)
    career_months_at_hire: Mapped[int | None] = mapped_column(Integer)

    # 퇴사일 및 사유
    resigned_date: Mapped[date | None] = mapped_column(Date)
    resignation_reason: Mapped[str | None] = mapped_column(Text)

    # 비상연락망 (본인이 모바일에서 직접 편집)
    emergency_contact_name: Mapped[str | None] = mapped_column(String(100))
    emergency_contact_phone: Mapped[str | None] = mapped_column(String(50))

    # 인증 관련 (company_email + hashed_password 로 직접 로그인).
    # 신규 등록 시 서버가 자동 생성, 비번 재설정은 관리자가 수행.
    hashed_password: Mapped[str | None] = mapped_column(String(255))
    # ADMIN | SALES | HR | SUPPORT | ETC — 역할→권한 매트릭스 (app/core/roles.py)
    security_role: Mapped[str] = mapped_column(
        String(16), nullable=False, default="ETC"
    )
    # 관리자(HR/ADMIN) 가 비밀번호를 강제 재설정했을 때 True 로 세팅.
    # 본인이 /me/change-password 로 스스로 변경하면 False 로 해제.
    # /auth/me 응답의 must_change_password 에 반영돼 프런트가 강제 변경 화면으로 유도.
    password_reset_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    # Functional roles (e.g. 컨설팅, 개발, PM, ...)
    roles: Mapped[list[str] | None] = mapped_column(ARRAY(String(30)))
    skills: Mapped[list[str] | None] = mapped_column(ARRAY(String(50)))
    memo: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(7))

    # 1차 결재자(상위 관리자) — self-FK. NULL 허용 (대표·외부인). HR/ADMIN 만 변경.
    # 결재 모듈이 휴가·출장·경비 등 모든 신청의 첫 승인자로 사용. 사이클은 앱 레이어에서
    # 검증 (자기 자신 금지, ancestor chain 에 자기 등장 금지, 깊이 10단계 제한).
    # ON DELETE SET NULL — 매니저가 삭제되면 하위 자동 분리 (재배정은 운영자 몫).
    manager_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="SET NULL"),
        index=True,
    )
    manager: Mapped["Developer | None"] = relationship(
        "Developer",
        remote_side="Developer.id",
        foreign_keys=[manager_id],
        lazy="select",
    )

    # 직위(Rank) — 모든 임직원이 1개씩. 결재선의 기본 hierarchy.
    # ON DELETE SET NULL — 직위 삭제 시 참조만 끊고 임직원 row 는 보존.
    rank_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("job_ranks.id", ondelete="SET NULL"),
        index=True,
    )
    # 직책(Position) — 선택적 job role. NULL 허용.
    position_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("job_positions.id", ondelete="SET NULL"),
        index=True,
    )

    resumes: Mapped[list["DeveloperResume"]] = relationship(
        back_populates="developer", cascade="all, delete-orphan"
    )
    approvers: Mapped[list["DeveloperApprover"]] = relationship(
        back_populates="developer", cascade="all, delete-orphan",
        order_by="DeveloperApprover.position",
    )
    profile: Mapped["DeveloperProfile | None"] = relationship(
        back_populates="developer",
        cascade="all, delete-orphan",
        uselist=False,
    )
    certifications: Mapped[list["DeveloperCertification"]] = relationship(
        back_populates="developer",
        cascade="all, delete-orphan",
        order_by="DeveloperCertification.position",
    )
    experiences: Mapped[list["DeveloperExperience"]] = relationship(
        back_populates="developer",
        cascade="all, delete-orphan",
        order_by="DeveloperExperience.start_date.desc()",
    )
    # 1:1 — 여권 정보. 명부 PDF 출력 시 selectinload 로 함께 조회.
    passport_record: Mapped["DeveloperPassport | None"] = relationship(
        "DeveloperPassport",
        primaryjoin="Developer.id == DeveloperPassport.developer_id",
        foreign_keys="DeveloperPassport.developer_id",
        uselist=False,
        cascade="all, delete-orphan",
        single_parent=True,
        viewonly=False,
    )
    # 1:N — 비상연락처. UI 는 2 슬롯만 표시.
    emergency_contacts: Mapped[list["DeveloperEmergencyContact"]] = relationship(
        "DeveloperEmergencyContact",
        primaryjoin="Developer.id == DeveloperEmergencyContact.developer_id",
        foreign_keys="DeveloperEmergencyContact.developer_id",
        cascade="all, delete-orphan",
        order_by="DeveloperEmergencyContact.position",
    )


class DeveloperApprover(Base, UUIDMixin, TenantMixin):
    __tablename__ = "developer_approvers"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    approver_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Primary 승인자는 Slack DM 타겟. 직원당 최대 1명 (DB UNIQUE INDEX로 보장).
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    developer: Mapped[Developer] = relationship(back_populates="approvers")


class DeveloperResume(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """임직원 단위 첨부 파일. "첨부파일" 탭에서 관리.

    이름은 역사적 이유로 ``developer_resumes`` 를 유지하지만, 구조화 이력서는
    ``developer_profiles`` / ``developer_certifications`` / ``developer_experiences``
    로 별도 관리된다.
    """
    __tablename__ = "developer_resumes"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    description: Mapped[str | None] = mapped_column(Text)

    developer: Mapped[Developer] = relationship(back_populates="resumes")


class DeveloperProfile(Base, TenantMixin):
    """구조화 이력서 머리부 — 임직원당 1 row."""

    __tablename__ = "developer_profiles"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    birth_date: Mapped[date | None] = mapped_column(Date)
    school: Mapped[str | None] = mapped_column(String(200))
    major: Mapped[str | None] = mapped_column(String(200))
    graduation_year: Mapped[int | None] = mapped_column(SmallInteger)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=lambda: datetime.utcnow(),
        nullable=False,
    )

    developer: Mapped[Developer] = relationship(back_populates="profile")


class DeveloperCertification(Base, UUIDMixin, TenantMixin):
    __tablename__ = "developer_certifications"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    issuer: Mapped[str | None] = mapped_column(String(200))
    acquired_on: Mapped[date | None] = mapped_column(Date)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    developer: Mapped[Developer] = relationship(back_populates="certifications")


class DeveloperExperience(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "developer_experiences"

    developer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("developers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    # NULL = 재직중 / 진행중
    end_date: Mapped[date | None] = mapped_column(Date)
    company: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    developer: Mapped[Developer] = relationship(back_populates="experiences")
