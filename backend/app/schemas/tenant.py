from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator


class TenantBase(BaseModel):
    slug: str = Field(min_length=2, max_length=60)
    name: str = Field(min_length=1, max_length=200)
    domains: list[str] = Field(default_factory=list)
    business_no: str | None = None
    representative: str | None = None
    address: str | None = None
    phone: str | None = None
    fax: str | None = None
    contact_email: str | None = None
    name_en: str | None = None
    representative_en: str | None = None
    address_en: str | None = None
    number_prefix: str = "DD"

    @field_validator("domains")
    @classmethod
    def _normalize_domains(cls, v: list[str]) -> list[str]:
        cleaned: list[str] = []
        for d in v or []:
            d = (d or "").strip().lower().lstrip("@")
            if not d:
                continue
            if "." not in d or " " in d:
                raise ValueError(f"올바르지 않은 도메인: {d!r}")
            if d not in cleaned:
                cleaned.append(d)
        return cleaned


class TenantCreate(TenantBase):
    """새 tenant 생성 — 첫 admin 유저까지 한 번에."""

    admin_email: str = Field(min_length=3)
    admin_password: str = Field(min_length=4, max_length=200)
    admin_name: str = ""

    @field_validator("admin_email")
    @classmethod
    def _lower_email(cls, v: str) -> str:
        return v.strip().lower()


class TenantUpdate(BaseModel):
    name: str | None = None
    domains: list[str] | None = None
    business_no: str | None = None
    representative: str | None = None
    address: str | None = None
    phone: str | None = None
    fax: str | None = None
    contact_email: str | None = None
    name_en: str | None = None
    representative_en: str | None = None
    address_en: str | None = None
    number_prefix: str | None = None
    is_active: bool | None = None

    @field_validator("domains")
    @classmethod
    def _normalize_domains(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        return TenantBase._normalize_domains(v)  # type: ignore[arg-type]


class TenantOut(TenantBase):
    id: UUID
    is_active: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # 활성 임직원 수 (developers.status='ACTIVE')
    developer_count: int = 0
    # 실제 로그인 기록 보유 user 수 (users 테이블 활성 행)
    user_count: int = 0
    # ADMIN role 보유 user 수
    admin_count: int = 0

    class Config:
        from_attributes = True


class TenantAdminCreate(BaseModel):
    """기존 tenant 에 admin 유저 추가."""

    email: str = Field(min_length=3)
    password: str = Field(min_length=4, max_length=200)
    name: str = ""

    @field_validator("email")
    @classmethod
    def _lower_email(cls, v: str) -> str:
        return v.strip().lower()


class TenantAdminPasswordReset(BaseModel):
    new_password: str = Field(min_length=4, max_length=200)
