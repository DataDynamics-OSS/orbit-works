from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

UserRole = Literal["SUPER_ADMIN", "ADMIN", "SALES", "HR", "SUPPORT", "ETC"]


class LoginRequest(BaseModel):
    # Field is named `email` for historical reasons but accepts any
    # identifier (e.g. plain username like "admin").
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: UUID
    email: str
    name: str
    role: str
    is_active: bool
    created_at: datetime | None = None

    class Config:
        from_attributes = True


class MeOut(UserOut):
    """`/auth/me` 응답 — 프런트가 UI 게이트에 쓰는 권한 목록 포함."""

    permissions: list[str] = []
    mapped_developer_id: UUID | None = None
    # True 면 현재 비밀번호가 초기값(주민번호 앞6자리)인 상태 — 변경 강제.
    must_change_password: bool = False
    # 멀티 테넌트 — 이 사용자가 속한 회사. SUPER_ADMIN 은 NULL.
    tenant_id: UUID | None = None
    # role == "SUPER_ADMIN" 의 편의 플래그.
    is_super_admin: bool = False
    # 사용자별 추가 메뉴 부여 — Sidebar 필터가 role 매트릭스와 OR. 비어 있으면 [].
    menu_grants: list[str] = []


class UserCreate(BaseModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)
    name: str = ""
    role: UserRole = "ETC"


class UserUpdate(BaseModel):
    name: str | None = None
    role: UserRole | None = None
    is_active: bool | None = None


class UserPasswordReset(BaseModel):
    new_password: str = Field(min_length=1)


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=1)


class InitialPasswordRequest(BaseModel):
    """첫 로그인 강제 변경 — current_password 불필요. 서버가 must_change_password
    상태(생년월일 = 현재 비번 OR password_reset_required) 일 때만 허용."""

    new_password: str = Field(min_length=4, max_length=200)


class MemoOut(BaseModel):
    memo: str = ""
    updated_at: datetime | None = None


class MemoUpdate(BaseModel):
    memo: str = ""
