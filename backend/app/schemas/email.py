"""이메일 클라이언트 — Pydantic schemas.

설계: docs/email-client-design.md. 비밀(password/smtp_password)은 스키마에 포함하지
않는다 — announcements 와 동일하게 app_settings.email.accounts.<id> 에 두고 응답 시
`***last4` 마스킹(별도 settings 엔드포인트). 여기서는 계정 메타·멤버·메시지만 다룬다.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

# ──────────────────────────── 계정 ────────────────────────────


class EmailAccountBase(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=120)
    email_addr: EmailStr
    kind: str = Field(default="PERSONAL", pattern="^(PERSONAL|SHARED)$")
    protocol: str = Field(default="IMAP", pattern="^(IMAP|POP3)$")
    host: str = Field(..., min_length=1, max_length=255)
    port: int = Field(default=993, ge=1, le=65535)
    security: str = Field(default="SSL", pattern="^(SSL|STARTTLS|NONE)$")
    username: str = Field(..., min_length=1, max_length=320)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=587, ge=1, le=65535)
    smtp_security: str | None = Field(default="STARTTLS", pattern="^(SSL|STARTTLS|NONE)$")
    smtp_username: str | None = Field(default=None, max_length=320)
    sent_folder: str | None = Field(default="Sent", max_length=255)
    archive_folder: str | None = Field(default="Archive", max_length=255)
    trash_folder: str | None = Field(default="Trash", max_length=255)
    shared_seen: bool = False
    enabled: bool = True
    sync_enabled: bool = True


class EmailAccountCreate(EmailAccountBase):
    # 생성 시에만 비밀 전달 — DB 가 아니라 settings 로 저장. 마스킹 규약(***)은 settings 측.
    password: str | None = Field(default=None, max_length=512)
    smtp_password: str | None = Field(default=None, max_length=512)


class EmailAccountUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    email_addr: EmailStr | None = None
    kind: str | None = Field(default=None, pattern="^(PERSONAL|SHARED)$")
    host: str | None = Field(default=None, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    security: str | None = Field(default=None, pattern="^(SSL|STARTTLS|NONE)$")
    username: str | None = Field(default=None, max_length=320)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: str | None = Field(default=None, pattern="^(SSL|STARTTLS|NONE)$")
    smtp_username: str | None = Field(default=None, max_length=320)
    sent_folder: str | None = Field(default=None, max_length=255)
    archive_folder: str | None = Field(default=None, max_length=255)
    trash_folder: str | None = Field(default=None, max_length=255)
    shared_seen: bool | None = None
    enabled: bool | None = None
    sync_enabled: bool | None = None
    password: str | None = Field(default=None, max_length=512)
    smtp_password: str | None = Field(default=None, max_length=512)


class EmailAccountOut(EmailAccountBase):
    id: UUID
    created_by: UUID | None = None
    last_sync_at: datetime | None = None
    last_ok_at: datetime | None = None
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime
    # 현재 사용자의 멤버십(편의 필드 — 라우터가 채움)
    my_role: str | None = None
    can_send: bool | None = None
    can_manage: bool | None = None
    # 저장된 비밀번호(평문) — 단건 조회(get_account)에서만 채움. 편집 폼에서
    # eye 토글로 확인 가능하게 하기 위함(운영 편의). 목록 응답에서는 None.
    password_plain: str | None = None
    smtp_password_plain: str | None = None

    class Config:
        from_attributes = True


# ──────────────────────────── 멤버 ────────────────────────────


class EmailAccountMemberCreate(BaseModel):
    user_id: UUID
    role: str = Field(default="MEMBER", pattern="^(OWNER|MEMBER|VIEWER)$")
    can_send: bool = True
    can_manage: bool = False


class EmailAccountMemberUpdate(BaseModel):
    role: str | None = Field(default=None, pattern="^(OWNER|MEMBER|VIEWER)$")
    can_send: bool | None = None
    can_manage: bool | None = None


class EmailAccountMemberOut(BaseModel):
    id: UUID
    account_id: UUID
    user_id: UUID
    user_name: str | None = None  # derived
    role: str
    can_send: bool
    can_manage: bool
    created_at: datetime

    class Config:
        from_attributes = True


# ──────────────────────────── 폴더 ────────────────────────────


class EmailFolderOut(BaseModel):
    id: UUID
    account_id: UUID
    name: str
    role: str | None = None
    total_count: int
    unseen_count: int

    class Config:
        from_attributes = True


# ──────────────────────────── 메시지 ────────────────────────────


class EmailAttachmentOut(BaseModel):
    id: UUID
    filename: str
    content_type: str | None = None
    is_inline: bool
    size_bytes: int | None = None
    # 캐시 여부 — 열람 전이면 false (lazy)
    cached: bool = False

    class Config:
        from_attributes = True


class EmailListItem(BaseModel):
    """목록(3-pane 가운데) 행 — 본문 제외 경량."""

    id: UUID
    account_id: UUID
    folder_id: UUID | None = None
    subject: str | None = None
    from_addr: str | None = None
    from_name: str | None = None
    snippet: str | None = None
    received_at: datetime | None = None
    has_attachments: bool = False
    is_seen: bool = False
    is_flagged: bool = False
    is_answered: bool = False
    is_archived: bool = False
    size_bytes: int | None = None
    # 이 메일에 붙은 라벨 id 목록(라우터가 채움). 배지 렌더용.
    label_ids: list[UUID] = Field(default_factory=list)

    class Config:
        from_attributes = True


class EmailDetail(EmailListItem):
    """상세 — 본문 포함."""

    to_addrs: list[str] | None = None
    cc_addrs: list[str] | None = None
    reply_to: str | None = None
    message_id: str | None = None
    sent_at: datetime | None = None
    body_text: str | None = None
    body_html: str | None = None
    attachments: list[EmailAttachmentOut] = Field(default_factory=list)


class EmailFlagUpdate(BaseModel):
    is_seen: bool | None = None
    is_flagged: bool | None = None


class EmailMoveRequest(BaseModel):
    target_folder: str = Field(..., min_length=1, max_length=512)


class EmailBulkAction(BaseModel):
    email_ids: list[UUID] = Field(..., min_length=1)
    action: str = Field(
        ..., pattern="^(SEEN|UNSEEN|FLAG|UNFLAG|MOVE|ARCHIVE|TRASH|DELETE)$"
    )
    target_folder: str | None = Field(default=None, max_length=512)


# ──────────────────────────── 동기화 이력 ────────────────────────────


class EmailSyncRunOut(BaseModel):
    id: UUID
    account_id: UUID | None = None
    folder_id: UUID | None = None
    trigger_kind: str
    direction: str
    started_at: datetime
    finished_at: datetime | None = None
    status: str
    fetched_count: int
    inserted_count: int
    updated_count: int
    pushed_count: int
    skipped_count: int
    error_message: str | None = None

    class Config:
        from_attributes = True


# ──────────────────────────── 발송 ────────────────────────────


class OutboxAttachmentIn(BaseModel):
    """발송 첨부 참조 — /email/outbox/upload 가 돌려준 값을 그대로 echo.
    file_path 는 서버가 검증(emails/outbox/ 하위만 허용)."""

    filename: str = Field(..., min_length=1, max_length=255)
    file_path: str = Field(..., max_length=512)
    content_type: str | None = Field(default=None, max_length=255)
    size_bytes: int | None = None


class EmailComposeRequest(BaseModel):
    account_id: UUID
    to_addrs: list[EmailStr] = Field(..., min_length=1)
    cc_addrs: list[EmailStr] | None = None
    bcc_addrs: list[EmailStr] | None = None
    subject: str | None = None
    body_text: str | None = None
    body_html: str | None = None
    in_reply_to: UUID | None = None
    # 전달 시: 이 메일의 (비인라인) 첨부를 원본 .eml 에서 추출해 함께 발송.
    attach_from_email: UUID | None = None
    # 사용자가 업로드한 첨부(파일 첨부 버튼).
    attachments: list[OutboxAttachmentIn] | None = None
    # DRAFT = 임시저장, QUEUED = 발송
    status: str = Field(default="QUEUED", pattern="^(DRAFT|QUEUED)$")


class EmailOutboxOut(BaseModel):
    id: UUID
    account_id: UUID
    user_id: UUID
    sender_name: str | None = None  # derived (신원 표기)
    to_addrs: list[str]
    cc_addrs: list[str] | None = None
    bcc_addrs: list[str] | None = None
    subject: str | None = None
    body_text: str | None = None
    body_html: str | None = None
    attachments: list[dict] | None = None  # [{filename, file_path, content_type}]
    status: str
    scheduled_at: datetime | None = None
    sent_at: datetime | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class EmailOutboxUpdate(BaseModel):
    """임시보관(DRAFT) 수정 — 지정된 필드만 갱신. add_attachments 는 기존 첨부에
    덧붙인다(기존 서버측 첨부는 보존)."""

    to_addrs: list[EmailStr] | None = None
    cc_addrs: list[EmailStr] | None = None
    bcc_addrs: list[EmailStr] | None = None
    subject: str | None = None
    body_text: str | None = None
    body_html: str | None = None
    add_attachments: list[OutboxAttachmentIn] | None = None

# ──────────────────────────── 라벨 ────────────────────────────


class EmailLabelOut(BaseModel):
    id: UUID
    account_id: UUID
    name: str
    color: str | None = None

    class Config:
        from_attributes = True


class EmailLabelCreate(BaseModel):
    account_id: UUID
    name: str = Field(..., min_length=1, max_length=100)
    color: str | None = Field(default=None, max_length=20)


class EmailLabelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, max_length=20)


class EmailLabelApply(BaseModel):
    """메일들에 라벨 적용/해제. email_ids × label_id."""

    email_ids: list[UUID] = Field(..., min_length=1)
    label_id: UUID
    attach: bool = True  # True=붙이기, False=떼기
