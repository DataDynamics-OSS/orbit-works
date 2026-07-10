"""이메일 클라이언트 — IMAP/POP3 양방향 + 아카이빙.

설계 문서: docs/email-client-design.md

핵심 차이(사업공고 announcements 패턴 대비):
- 테넌트 데이터 + **계정 공유** — 메일은 유저가 아니라 *계정*에 귀속되고, 접근은
  `email_account_members` 멤버십으로 제어. 모든 테이블 TenantMixin(RLS 자동).
- 증분 동기화 상태(`UIDVALIDITY`/`UIDNEXT`/`HIGHESTMODSEQ`) 를 폴더별로 보관.
- 로컬→서버 양방향 반영을 위한 `email_pending_actions` 아웃박스.

설계 메모
- 중복 방지 키: (account_id, folder_id, uid_validity, imap_uid) UNIQUE.
- 원본 RFC822 raw 는 파일스토리지(.eml), DB 에는 파싱 메타 + 검색 인덱스만.
- `search_tsv`(tsvector) / `search_text`(pg_bigm 부분일치) 는 DB 트리거가 유지 —
  ORM 으로 직접 쓰지 않는다(트리거가 INSERT/UPDATE 시 덮어씀).
- 공유 메일함의 서버 `\\Seen` 은 메일박스당 하나(공유). 유저별 읽음이 필요하면
  `shared_seen=false` + `email_user_state` 오버레이.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin

# 프로토콜 / 보안 / 역할 enum (DB CHECK 없이 앱에서 검증).
EMAIL_PROTOCOLS = ("IMAP", "POP3")
EMAIL_SECURITY = ("SSL", "STARTTLS", "NONE")
EMAIL_ACCOUNT_KINDS = ("PERSONAL", "SHARED")
EMAIL_MEMBER_ROLES = ("OWNER", "MEMBER", "VIEWER")
EMAIL_FOLDER_ROLES = (
    "INBOX",
    "SENT",
    "ARCHIVE",
    "TRASH",
    "DRAFTS",
    "JUNK",
    "CUSTOM",
)
# 동기화 실행 상태 — announcement_fetch_runs 와 동일.
EMAIL_RUN_STATUSES = ("RUNNING", "OK", "FAILED", "SKIPPED")
EMAIL_TRIGGER_KINDS = ("SCHEDULED", "MANUAL")
# 로컬→서버 반영 액션.
EMAIL_PENDING_ACTIONS = (
    "SEEN",
    "UNSEEN",
    "FLAG",
    "UNFLAG",
    "MOVE",
    "ARCHIVE",
    "TRASH",
    "DELETE",
)
EMAIL_PENDING_STATUSES = ("PENDING", "DONE", "FAILED")
EMAIL_OUTBOX_STATUSES = ("DRAFT", "QUEUED", "SENT", "FAILED")


class EmailAccount(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """메일 계정 마스터. 자격증명(비밀)은 app_settings.email.accounts.<id> 에.

    계정은 PERSONAL(개인) 또는 SHARED(공유 메일함). 접근 사용자는
    `email_account_members` 가 결정.
    """

    __tablename__ = "email_accounts"
    __table_args__ = (
        UniqueConstraint("tenant_id", "email_addr", name="uq_email_account_addr"),
    )

    # PERSONAL | SHARED
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="PERSONAL")
    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    email_addr: Mapped[str] = mapped_column(String(320), nullable=False)
    # IMAP | POP3
    protocol: Mapped[str] = mapped_column(String(10), nullable=False, default="IMAP")

    # 수신 서버
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False, default=993)
    # SSL | STARTTLS | NONE
    security: Mapped[str] = mapped_column(String(10), nullable=False, default="SSL")
    username: Mapped[str] = mapped_column(String(320), nullable=False)

    # 발송 서버 (SMTP)
    smtp_host: Mapped[str | None] = mapped_column(String(255))
    smtp_port: Mapped[int | None] = mapped_column(Integer, default=587)
    smtp_security: Mapped[str | None] = mapped_column(String(10), default="STARTTLS")
    smtp_username: Mapped[str | None] = mapped_column(String(320))

    # 폴더 매핑 (서버 폴더명 — 서버마다 다름)
    sent_folder: Mapped[str | None] = mapped_column(String(255), default="Sent")
    archive_folder: Mapped[str | None] = mapped_column(String(255), default="Archive")
    trash_folder: Mapped[str | None] = mapped_column(String(255), default="Trash")

    # 공유 메일함 \Seen 동기화 여부 — 기본 false(유저별 읽음, email_user_state).
    shared_seen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sync_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    # 서버 capability 캐시 (CONDSTORE/QRESYNC/MOVE 지원 여부).
    capabilities: Mapped[dict | None] = mapped_column(JSONB)

    members: Mapped[list["EmailAccountMember"]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )
    folders: Mapped[list["EmailFolder"]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )


class EmailAccountMember(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """계정↔사용자 멤버십. 공유 메일함은 행 여럿, 개인 계정은 행 1개(OWNER)."""

    __tablename__ = "email_account_members"
    __table_args__ = (
        UniqueConstraint("account_id", "user_id", name="uq_email_member"),
    )

    account_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # OWNER | MEMBER | VIEWER
    role: Mapped[str] = mapped_column(String(10), nullable=False, default="MEMBER")
    can_send: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_manage: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    account: Mapped["EmailAccount"] = relationship(back_populates="members")


class EmailFolder(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """IMAP 폴더 + 폴더별 증분 동기화 상태."""

    __tablename__ = "email_folders"
    __table_args__ = (
        UniqueConstraint("account_id", "raw_name", name="uq_email_folder_raw"),
    )

    account_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 서버 mailbox 이름(디코드본) / 원본(modified UTF-7)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    raw_name: Mapped[str] = mapped_column(String(512), nullable=False)
    # INBOX | SENT | ARCHIVE | TRASH | DRAFTS | JUNK | CUSTOM
    role: Mapped[str | None] = mapped_column(String(20))

    # IMAP 동기화 토큰
    uid_validity: Mapped[int | None] = mapped_column(BigInteger)
    uid_next: Mapped[int | None] = mapped_column(BigInteger)
    highest_modseq: Mapped[int | None] = mapped_column(BigInteger)
    last_synced_uid: Mapped[int] = mapped_column(BigInteger, default=0)
    total_count: Mapped[int] = mapped_column(Integer, default=0)
    unseen_count: Mapped[int] = mapped_column(Integer, default=0)

    account: Mapped["EmailAccount"] = relationship(back_populates="folders")


class Email(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """메시지 한 건. 계정 귀속(유저 아님). 원본 raw 는 파일(.eml).

    (account_id, folder_id, uid_validity, imap_uid) UNIQUE 로 중복 방지.
    """

    __tablename__ = "emails"
    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "folder_id",
            "uid_validity",
            "imap_uid",
            name="uq_email_uid",
        ),
    )

    account_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    folder_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_folders.id", ondelete="SET NULL"),
        index=True,
    )

    # 서버 식별
    imap_uid: Mapped[int | None] = mapped_column(BigInteger)
    uid_validity: Mapped[int | None] = mapped_column(BigInteger)
    message_id: Mapped[str | None] = mapped_column(String(998), index=True)
    thread_id: Mapped[str | None] = mapped_column(String(998))

    # 헤더 파싱 결과
    subject: Mapped[str | None] = mapped_column(Text)
    from_addr: Mapped[str | None] = mapped_column(String(320))
    from_name: Mapped[str | None] = mapped_column(String(320))
    to_addrs: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    cc_addrs: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    bcc_addrs: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    reply_to: Mapped[str | None] = mapped_column(String(320))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )

    # 본문 (검색·미리보기용. 원본은 raw_path)
    body_text: Mapped[str | None] = mapped_column(Text)
    body_html: Mapped[str | None] = mapped_column(Text)
    snippet: Mapped[str | None] = mapped_column(String(512))
    has_attachments: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    size_bytes: Mapped[int | None] = mapped_column(Integer)

    # 플래그 (IMAP \Seen \Flagged \Answered \Draft)
    is_seen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_flagged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_answered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_draft: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # 아카이빙
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    # 서버에서 EXPUNGE(삭제)됨 — 폴더 목록에서 숨기되 보관된 .eml 은 유지(설계 §5).
    server_deleted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    server_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # 원본 보관 (불변)
    raw_path: Mapped[str | None] = mapped_column(String(512))
    raw_sha256: Mapped[str | None] = mapped_column(String(64))

    # 검색 — DB 트리거가 유지(fn_emails_tsv). ORM 으로 직접 쓰지 않음.
    search_tsv: Mapped[str | None] = mapped_column(TSVECTOR)
    search_text: Mapped[str | None] = mapped_column(Text)

    attachments: Mapped[list["EmailAttachment"]] = relationship(
        back_populates="email", cascade="all, delete-orphan"
    )


class EmailAttachment(Base, UUIDMixin, TenantMixin):
    """첨부 메타. lazy — 동기화 땐 메타만, 열람 시 보관 .eml 에서 추출·캐시."""

    __tablename__ = "email_attachments"

    email_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("emails.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(255))
    content_id: Mapped[str | None] = mapped_column(String(255))  # inline cid:
    is_inline: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    # lazy: part_ref 로 .eml 에서 추출. file_path/fetched_at 은 열람 후 캐시.
    part_ref: Mapped[str | None] = mapped_column(String(40))
    file_path: Mapped[str | None] = mapped_column(String(512))
    sha256: Mapped[str | None] = mapped_column(String(64))
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    email: Mapped["Email"] = relationship(back_populates="attachments")


class EmailSyncRun(Base, UUIDMixin, TenantMixin):
    """동기화 실행 이력 — 계정×폴더 1회 사이클. announcement_fetch_runs 대응."""

    __tablename__ = "email_sync_runs"

    account_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="SET NULL"),
        index=True,
    )
    folder_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("email_folders.id", ondelete="SET NULL")
    )
    # SCHEDULED | MANUAL
    trigger_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    triggered_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    # PULL | PUSH | BOTH
    direction: Mapped[str] = mapped_column(String(10), nullable=False, default="BOTH")

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # RUNNING | OK | FAILED | SKIPPED
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="RUNNING")

    fetched_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    inserted_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pushed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)


class EmailPendingAction(Base, UUIDMixin, TenantMixin):
    """로컬→서버 반영 대기 아웃박스 — 양방향 동기화 핵심."""

    __tablename__ = "email_pending_actions"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    account_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    email_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("emails.id", ondelete="CASCADE")
    )
    # SEEN | UNSEEN | FLAG | UNFLAG | MOVE | ARCHIVE | TRASH | DELETE
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    target_folder: Mapped[str | None] = mapped_column(String(512))
    payload: Mapped[dict | None] = mapped_column(JSONB)
    # PENDING | DONE | FAILED
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class EmailOutbox(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """발송 큐/이력 (SMTP). user_id = 발신자(공유함 신원 표기)."""

    __tablename__ = "email_outbox"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    account_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    in_reply_to: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("emails.id", ondelete="SET NULL")
    )
    to_addrs: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    cc_addrs: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    bcc_addrs: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    subject: Mapped[str | None] = mapped_column(Text)
    body_text: Mapped[str | None] = mapped_column(Text)
    body_html: Mapped[str | None] = mapped_column(Text)
    # [{filename, file_path, content_type}]
    attachments: Mapped[list | None] = mapped_column(JSONB)
    # DRAFT | QUEUED | SENT | FAILED
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="DRAFT")
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)


class EmailUserState(Base, UUIDMixin, TenantMixin):
    """공유 메일함 유저별 읽음 오버레이 — shared_seen=false 일 때만 사용.

    서버 \\Seen 은 공유되므로 push 하지 않는다. UI 전용.
    """

    __tablename__ = "email_user_state"
    __table_args__ = (
        UniqueConstraint("email_id", "user_id", name="uq_email_user_state"),
    )

    email_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("emails.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    is_seen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class EmailLabel(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """계정 단위 공유 라벨(Gmail 식). 로컬 전용 — IMAP 동기화 안 함.

    계정 멤버 모두가 공유. (account_id, name) 유일.
    """

    __tablename__ = "email_labels"
    __table_args__ = (
        UniqueConstraint("account_id", "name", name="uq_email_label_name"),
    )

    account_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # 표시 색(hex). UI 배지 색. 미지정 시 프론트 기본색.
    color: Mapped[str | None] = mapped_column(String(20))


class EmailLabelLink(Base, UUIDMixin, TenantMixin):
    """메일 ↔ 라벨 다대다 연결. 한 메일에 라벨 여러 개."""

    __tablename__ = "email_label_links"
    __table_args__ = (
        UniqueConstraint("email_id", "label_id", name="uq_email_label_link"),
    )

    email_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("emails.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    label_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_labels.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
