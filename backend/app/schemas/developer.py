from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, model_validator


PaymentMethod = Literal["PAYROLL", "TAX_INVOICE", "HOURLY"]
DeveloperStatus = Literal["ACTIVE", "INACTIVE"]


class DeveloperApproverOut(BaseModel):
    id: UUID
    developer_id: UUID
    approver_user_id: UUID
    approver_name: str | None = None
    approver_email: str | None = None
    is_primary: bool
    position: int


class DeveloperApproverInput(BaseModel):
    """PUT /developers/{id}/approvers 의 원소."""

    user_id: UUID
    is_primary: bool = False


class MyProfileOut(BaseModel):
    """모바일 '내 프로필' 항목 — 편집 가능/읽기 전용 모두 포함."""

    developer_id: UUID
    name: str
    company_email: str | None = None
    phone: str | None = None
    hire_date: date | None = None
    address: str | None = None
    emergency_contact_name: str | None = None
    emergency_contact_phone: str | None = None


class MyProfileUpdate(BaseModel):
    phone: str | None = None
    address: str | None = None
    emergency_contact_name: str | None = None
    emergency_contact_phone: str | None = None


class DeveloperDirectoryOut(BaseModel):
    """Lightweight directory entry for people-picker UIs (예: 회의 참석자 선택).

    email 은 Slack 알림 발송 대상으로 사용되며 company_email → personal_email
    순으로 폴백한다. 둘 다 없으면 None.
    """

    id: UUID
    name: str
    tag: str | None = None
    email: str | None = None
    phone: str | None = None
    employment_type: str
    # 직급/직책 — picker 에서 자동 채움용
    title: str | None = None
    # 'M' | 'F' | None — 주민번호 7번째 자리에서 derive (raw RRN 은 노출 X).
    gender: Literal["M", "F"] | None = None


class RosterPassport(BaseModel):
    passport_number: str | None = None
    surname_en: str | None = None
    given_name_en: str | None = None
    issue_date: date | None = None
    expiry_date: date | None = None


class RosterEmergencyContact(BaseModel):
    name: str | None = None
    relation: str | None = None
    phone: str | None = None


class DeveloperRosterRow(BaseModel):
    """임직원 명부 PDF 출력용 — 정규직(FULL_TIME) + 재직자(ACTIVE) 한정.

    `birth_date` 는 `resident_number` 의 앞 6자리(YYMMDD) + 7번째 자리(성별/세기 코드) 로
    YYYY-MM-DD 변환. 변환 불가하면 None.
    """

    id: UUID
    name: str
    employee_no: str | None = None  # 정규직만 부여 (5자리 zero-padded).
    phone: str | None = None
    email: str | None = None     # company_email 우선, 없으면 personal_email
    address: str | None = None
    hire_date: date | None = None
    birth_date: date | None = None
    # 'M' | 'F' | None — 주민번호 7번째 자리에서 derive (raw RRN 노출 X).
    gender: Literal["M", "F"] | None = None
    passport: RosterPassport | None = None
    emergency_contacts: list[RosterEmergencyContact] = []


class DeveloperBase(BaseModel):
    name: str
    employment_type: str = "FREELANCER"
    status: DeveloperStatus = "ACTIVE"
    title: str | None = None
    phone: str | None = None
    address: str | None = None

    personal_email: EmailStr | None = None
    # 로그인 ID 로 사용되므로 신규 등록 시 필수 (DeveloperCreate 에서 강제).
    company_email: EmailStr | None = None
    tax_invoice_email: EmailStr | None = None

    # 주민등록번호. 하이픈 포함 "XXXXXX-XXXXXXX" (14자) 권장.
    resident_number: str | None = None

    payment_method: PaymentMethod = "PAYROLL"
    business_no: str | None = None
    business_address: str | None = None

    salary: Decimal | None = None
    hourly_rate: Decimal | None = None
    hire_date: date | None = None
    career_months_at_hire: int | None = None
    resigned_date: date | None = None
    resignation_reason: str | None = None

    roles: list[str] | None = None
    skills: list[str] | None = None
    memo: str | None = None
    color: str | None = None

    # 동명이인 식별 뱃지 — 서버가 자동 관리 (create 시 자동 부여).
    tag: str | None = None

    # 보안 역할 — 권한 매트릭스와 연결. 기본 ETC, ADMIN 만 편집 가능.
    security_role: str = "ETC"

    # 1차 결재자(상위 관리자) — 모든 결재(휴가·출장·경비)의 첫 승인자.
    # HR/ADMIN 만 변경 가능. 자기 자신·하위 트리·10단계 사이클은 PATCH 단계에서 검증.
    manager_id: UUID | None = None

    # 직위(Rank) — 모든 임직원이 1개씩. 직책(Position) — 선택적. 결재 룰 라우팅의
    # source of truth. PATCH/POST 시 위 title (varchar) 도 자동 sync (직책 있으면
    # 직책명, 없으면 직위명).
    rank_id: UUID | None = None
    position_id: UUID | None = None

    @model_validator(mode="after")
    def _check_tax_invoice_fields(self) -> "DeveloperBase":
        if self.payment_method == "TAX_INVOICE":
            if not self.business_no:
                raise ValueError("세금계산서 방식은 사업자등록번호가 필요합니다.")
            if not self.business_address:
                raise ValueError("세금계산서 방식은 사업자 주소가 필요합니다.")
        return self


class DeveloperCreate(DeveloperBase):
    # 주민등록번호 필수 — 앞 6자리가 초기 비밀번호로 사용됨.
    resident_number: str = Field(
        min_length=14,
        max_length=14,
        pattern=r"^\d{6}-\d{7}$",
        description="주민등록번호 XXXXXX-XXXXXXX",
    )

    @model_validator(mode="after")
    def _check_email_by_employment(self) -> "DeveloperCreate":
        # 프리랜서는 개인 이메일이 주 연락/로그인 수단. 정규직·자사화는 회사 이메일 필수.
        if self.employment_type == "FREELANCER":
            if not self.personal_email:
                raise ValueError("프리랜서는 개인 이메일이 필수입니다.")
        else:
            if not self.company_email:
                raise ValueError("정규직/자사화는 회사 이메일이 필수입니다.")
        return self


class DeveloperPasswordUpdate(BaseModel):
    """관리자가 임직원 비밀번호를 재설정."""

    new_password: str = Field(min_length=4, max_length=200)


class DeveloperChangePassword(BaseModel):
    """임직원 본인이 비밀번호 변경 (모바일 프로필)."""

    current_password: str
    new_password: str = Field(min_length=4, max_length=200)


class PasswordResetResult(BaseModel):
    """POST /developers/{id}/password/reset 응답.

    - mode='birthday': temp_password 는 None. 관리자는 '주민번호 앞 6자리' 안내.
    - mode='random': resident_number 가 비어 있어 생년월일 초기화가 불가해
      시스템이 랜덤 12자 임시 비번을 발급. temp_password 가 응답에 평문으로
      포함되어 UI 에 1회 표시. 본인은 첫 로그인 시 강제 변경.
    """

    mode: Literal["birthday", "random"]
    temp_password: str | None = None


class DeveloperUpdate(BaseModel):
    name: str | None = None
    employment_type: str | None = None
    status: DeveloperStatus | None = None
    title: str | None = None
    phone: str | None = None
    address: str | None = None
    personal_email: EmailStr | None = None
    company_email: EmailStr | None = None
    # 관리자가 편집 가능 — ADMIN 전용. 서버에서 추가 검증.
    security_role: str | None = None
    tax_invoice_email: EmailStr | None = None
    resident_number: str | None = None
    payment_method: PaymentMethod | None = None
    business_no: str | None = None
    business_address: str | None = None
    salary: Decimal | None = None
    hourly_rate: Decimal | None = None
    hire_date: date | None = None
    career_months_at_hire: int | None = None
    resigned_date: date | None = None
    resignation_reason: str | None = None
    roles: list[str] | None = None
    skills: list[str] | None = None
    memo: str | None = None
    color: str | None = None
    # HR/ADMIN 만 적용 — API 단에서 권한·사이클 검증.
    manager_id: UUID | None = None
    rank_id: UUID | None = None
    position_id: UUID | None = None


class DeveloperResumeOut(BaseModel):
    id: UUID
    developer_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int
    description: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class DeveloperResumeUpdate(BaseModel):
    file_name: str | None = None
    description: str | None = None


class DeveloperOut(DeveloperBase):
    id: UUID
    created_at: datetime
    resumes: list[DeveloperResumeOut] = []
    # Latest effective salary from developer_salaries (admin-visible). Falls
    # back to the legacy developers.salary column when no history exists.
    latest_salary: Decimal | None = None
    # 사번 — 정규직만 부여 (프리랜서/자사화는 None). 5자리 zero-padded.
    employee_no: str | None = None
    # 매핑된 사용자 ID — 임직원 화면의 추가 권한(user_feature_grants) 섹션이
    # 이 값으로 grants endpoint 를 호출. 매핑된 user 가 없으면 None.
    user_id: UUID | None = None

    class Config:
        from_attributes = True


class DeveloperAssignmentHistory(BaseModel):
    assignment_id: UUID
    project_id: UUID
    project_name: str
    start_date: str
    end_date: str
    monthly_rate: Decimal
    is_insourced: bool


# ---------------------------------------------------------------------------
# 구조화 이력서 (profile + certifications + experiences)
# ---------------------------------------------------------------------------


class ResumeProfileUpdate(BaseModel):
    birth_date: date | None = None
    school: str | None = None
    major: str | None = None
    graduation_year: int | None = Field(default=None, ge=1900, le=2100)


class ResumeProfileOut(ResumeProfileUpdate):
    developer_id: UUID

    class Config:
        from_attributes = True


class ResumeCertificationInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    issuer: str | None = None
    acquired_on: date | None = None


class ResumeCertificationOut(ResumeCertificationInput):
    id: UUID
    position: int

    class Config:
        from_attributes = True


class ResumeExperienceInput(BaseModel):
    start_date: date
    end_date: date | None = None
    company: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=200)
    description: str | None = None

    @model_validator(mode="after")
    def _check_dates(self) -> "ResumeExperienceInput":
        if self.end_date and self.end_date < self.start_date:
            raise ValueError("종료일은 시작일 이후여야 합니다.")
        return self


class ResumeExperienceOut(ResumeExperienceInput):
    id: UUID
    position: int

    class Config:
        from_attributes = True


class ResumeBundleOut(BaseModel):
    """이력서 단일 GET 응답 — 프론트에서 한 번에 받기 위한 번들."""

    developer_id: UUID
    name: str
    profile: ResumeProfileOut | None = None
    certifications: list[ResumeCertificationOut] = []
    experiences: list[ResumeExperienceOut] = []
