"""이메일 클라이언트 API — 계정·멤버십·동기화·조회 (Stage 1: 수신 read-only).

권한 모델(설계 §17): 역할 권한(emails.read/send/manage) + 계정 멤버십(직교).
- 기능 사용: require_permission("emails.read")
- 계정/메시지 접근: 추가로 멤버십 검증(_load_account) — 비멤버는 403.
- ADMIN 은 멤버십 없이도 테넌트 내 모든 계정 접근(emails.manage 보유).

발송(SMTP)·플래그 push·아카이브 MOVE 는 Stage 4·5 에서 추가.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.core.roles import has as role_has
from app.models import (
    CustomerContact,
    Email,
    EmailAccount,
    EmailAccountMember,
    EmailAttachment,
    EmailFolder,
    EmailLabel,
    EmailLabelLink,
    EmailOutbox,
    EmailPendingAction,
    EmailSyncRun,
    EmailUserState,
    User,
)
from app.schemas.common import Page
from app.schemas.email import (
    EmailAccountCreate,
    EmailAccountMemberCreate,
    EmailAccountMemberOut,
    EmailAccountMemberUpdate,
    EmailAccountOut,
    EmailAccountUpdate,
    EmailAttachmentOut,
    EmailBulkAction,
    EmailComposeRequest,
    EmailDetail,
    EmailFlagUpdate,
    EmailFolderOut,
    EmailLabelApply,
    EmailLabelCreate,
    EmailLabelOut,
    EmailLabelUpdate,
    EmailListItem,
    EmailMoveRequest,
    EmailOutboxOut,
    EmailOutboxUpdate,
    EmailSyncRunOut,
)
from app.services.email import run_one
from app.services.email.base import AccountConn, EmailFetchError
from app.services.email.sender import send_outbox
from app.services.email.eml import extract_attachment
from app.services.email.registry import ADAPTERS
from app.services.email.secrets import (
    delete_account_secrets,
    get_account_secrets,
    set_account_secrets,
)
from app.services.storage import resolve_upload_path, save_bytes, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/email", tags=["email"])


# ---------------------------------------------------------------------------
# 접근 제어 헬퍼 — 역할 권한 + 멤버십(직교)
# ---------------------------------------------------------------------------


def _is_admin(user: User) -> bool:
    return user.role in ("ADMIN", "SUPER_ADMIN")


async def _load_account(
    db: AsyncSession,
    user: User,
    account_id: UUID,
    *,
    need_manage: bool = False,
    need_send: bool = False,
) -> tuple[EmailAccount, EmailAccountMember | None]:
    """계정 로드 + 멤버십 검증. 비멤버(비ADMIN) 403, 계정 없음 404."""
    account = (
        await db.execute(
            select(EmailAccount).where(
                EmailAccount.id == account_id,
                EmailAccount.tenant_id == user.tenant_id,
            )
        )
    ).scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다")

    member = (
        await db.execute(
            select(EmailAccountMember).where(
                EmailAccountMember.account_id == account_id,
                EmailAccountMember.user_id == user.id,
            )
        )
    ).scalar_one_or_none()

    admin = _is_admin(user)
    if member is None and not admin:
        raise HTTPException(status_code=403, detail="이 계정의 멤버가 아닙니다")

    if need_manage and not admin:
        ok = member is not None and (member.can_manage or member.role == "OWNER")
        if not ok:
            raise HTTPException(status_code=403, detail="계정 관리 권한이 없습니다")
    if need_send and not admin:
        ok = member is not None and member.can_send and member.role != "VIEWER"
        if not ok:
            raise HTTPException(status_code=403, detail="이 계정으로 발송 권한이 없습니다")
    return account, member


def _account_out(account: EmailAccount, member: EmailAccountMember | None) -> EmailAccountOut:
    out = EmailAccountOut.model_validate(account)
    if member is not None:
        out.my_role = member.role
        out.can_send = member.can_send
        out.can_manage = member.can_manage
    else:
        # ADMIN (비멤버) — 전권으로 표시.
        out.my_role = "ADMIN"
        out.can_send = True
        out.can_manage = True
    return out


# ---------------------------------------------------------------------------
# 계정 CRUD
# ---------------------------------------------------------------------------


@router.get("/users-picker")
async def users_picker(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[dict]:
    """멤버 추가용 — 같은 테넌트의 활성 사용자(id/name/email)."""
    rows = (
        await db.execute(
            select(User.id, User.name, User.email)
            .where(User.tenant_id == user.tenant_id, User.is_active.is_(True))
            .order_by(User.name)
        )
    ).all()
    return [{"id": str(uid), "name": name, "email": email} for uid, name, email in rows]


async def _accessible_account_ids(
    db: AsyncSession, user: User, account_id: UUID | None
) -> list[UUID]:
    """주소록 '과거 메일 상대' 범위 — 계정 지정 시 멤버십 검증 후 그 계정만,
    아니면 접근 가능한 전 계정(ADMIN=테넌트 전체)."""
    if account_id is not None:
        await _load_account(db, user, account_id)
        return [account_id]
    if _is_admin(user):
        return list(
            (
                await db.execute(
                    select(EmailAccount.id).where(
                        EmailAccount.tenant_id == user.tenant_id
                    )
                )
            ).scalars()
        )
    return list(
        (
            await db.execute(
                select(EmailAccountMember.account_id).where(
                    EmailAccountMember.user_id == user.id
                )
            )
        ).scalars()
    )


@router.get("/address-book")
async def address_book(
    account_id: UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[dict]:
    """주소록 후보(자동완성·피커) — 테넌트 사용자 + 고객 연락처 + 과거 메일 상대.
    이메일(소문자) 기준 dedup. 프론트가 클라이언트 측에서 추가 필터링."""
    out: dict[str, dict] = {}

    def add(email: str | None, name: str | None, source: str) -> None:
        e = (email or "").strip()
        if not e or "@" not in e:
            return
        key = e.lower()
        existing = out.get(key)
        if existing is None:
            out[key] = {"name": (name or "").strip(), "email": e, "source": source}
        elif not existing["name"] and name:
            existing["name"] = name.strip()

    # 1) 테넌트 사용자(직원)
    for name, email in (
        await db.execute(
            select(User.name, User.email).where(
                User.tenant_id == user.tenant_id,
                User.is_active.is_(True),
                User.email.isnot(None),
            )
        )
    ).all():
        add(email, name, "user")

    # 2) 고객 연락처
    for name, email in (
        await db.execute(
            select(CustomerContact.name, CustomerContact.email).where(
                CustomerContact.tenant_id == user.tenant_id,
                CustomerContact.email.isnot(None),
            )
        )
    ).all():
        add(email, name, "contact")

    # 3) 과거 메일 상대 — 수신 발신자 + 발송 수신자.
    acc_ids = await _accessible_account_ids(db, user, account_id)
    if acc_ids:
        for from_addr, from_name in (
            await db.execute(
                select(Email.from_addr, Email.from_name)
                .where(Email.account_id.in_(acc_ids), Email.from_addr.isnot(None))
                .distinct()
                .limit(1000)
            )
        ).all():
            add(from_addr, from_name, "history")
        for to_addrs, cc_addrs in (
            await db.execute(
                select(EmailOutbox.to_addrs, EmailOutbox.cc_addrs)
                .where(EmailOutbox.account_id.in_(acc_ids))
                .limit(1000)
            )
        ).all():
            for e in (to_addrs or []) + (cc_addrs or []):
                add(e, None, "history")

    return sorted(out.values(), key=lambda r: (r["name"] or r["email"]).lower())


@router.get("/accounts", response_model=list[EmailAccountOut])
async def list_accounts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[EmailAccountOut]:
    """내가 멤버인 계정(ADMIN 은 테넌트 전체)."""
    if _is_admin(user):
        rows = (
            await db.execute(
                select(EmailAccount)
                .where(EmailAccount.tenant_id == user.tenant_id)
                .order_by(EmailAccount.display_name)
            )
        ).scalars().all()
        members = {
            m.account_id: m
            for m in (
                await db.execute(
                    select(EmailAccountMember).where(
                        EmailAccountMember.user_id == user.id
                    )
                )
            ).scalars()
        }
        return [_account_out(a, members.get(a.id)) for a in rows]

    q = (
        select(EmailAccount, EmailAccountMember)
        .join(
            EmailAccountMember,
            EmailAccountMember.account_id == EmailAccount.id,
        )
        .where(EmailAccountMember.user_id == user.id)
        .order_by(EmailAccount.display_name)
    )
    return [_account_out(a, m) for a, m in (await db.execute(q)).all()]


# ---------------------------------------------------------------------------
# 라벨 (계정 단위 공유, 로컬 전용 — IMAP 동기화 안 함)
# ---------------------------------------------------------------------------


@router.get("/accounts/{account_id}/labels", response_model=list[EmailLabelOut])
async def list_labels(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[EmailLabelOut]:
    """계정의 라벨 목록(멤버 공유)."""
    await _load_account(db, user, account_id)
    rows = (
        await db.execute(
            select(EmailLabel)
            .where(EmailLabel.account_id == account_id)
            .order_by(EmailLabel.name)
        )
    ).scalars().all()
    return [EmailLabelOut.model_validate(r) for r in rows]


@router.post("/labels", response_model=EmailLabelOut, status_code=201)
async def create_label(
    payload: EmailLabelCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailLabelOut:
    """라벨 생성. (account_id, name) 중복이면 409."""
    await _load_account(db, user, payload.account_id)
    dup = (
        await db.execute(
            select(EmailLabel.id).where(
                EmailLabel.account_id == payload.account_id,
                EmailLabel.name == payload.name,
            )
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status_code=409, detail="이미 있는 라벨 이름입니다")
    label = EmailLabel(
        tenant_id=user.tenant_id,
        account_id=payload.account_id,
        name=payload.name,
        color=payload.color,
    )
    db.add(label)
    await db.commit()
    await db.refresh(label)
    logger.info("라벨 생성 [account=%s label=%s]", payload.account_id, label.id)
    return EmailLabelOut.model_validate(label)


async def _load_label(db: AsyncSession, user: User, label_id: UUID) -> EmailLabel:
    label = (
        await db.execute(
            select(EmailLabel).where(
                EmailLabel.id == label_id, EmailLabel.tenant_id == user.tenant_id
            )
        )
    ).scalar_one_or_none()
    if label is None:
        raise HTTPException(status_code=404, detail="라벨을 찾을 수 없습니다")
    await _load_account(db, user, label.account_id)  # 멤버십 검증
    return label


@router.patch("/labels/{label_id}", response_model=EmailLabelOut)
async def update_label(
    label_id: UUID,
    payload: EmailLabelUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailLabelOut:
    label = await _load_label(db, user, label_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] != label.name:
        dup = (
            await db.execute(
                select(EmailLabel.id).where(
                    EmailLabel.account_id == label.account_id,
                    EmailLabel.name == data["name"],
                    EmailLabel.id != label.id,
                )
            )
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status_code=409, detail="이미 있는 라벨 이름입니다")
    for k, v in data.items():
        setattr(label, k, v)
    await db.commit()
    await db.refresh(label)
    logger.info("라벨 수정 [account=%s label=%s]", label.account_id, label.id)
    return EmailLabelOut.model_validate(label)


@router.delete("/labels/{label_id}", status_code=204)
async def delete_label(
    label_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> None:
    label = await _load_label(db, user, label_id)
    await db.delete(label)  # links 는 FK ON DELETE CASCADE 로 정리
    await db.commit()
    logger.info("라벨 삭제 [account=%s label=%s]", label.account_id, label_id)


@router.post("/labels/apply")
async def apply_label(
    payload: EmailLabelApply,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    """선택 메일들에 라벨 붙이기/떼기. attach=false 면 해제."""
    label = await _load_label(db, user, payload.label_id)
    # 라벨 계정에 속한 메일만 대상(멤버십은 _load_label 에서 검증됨).
    emails = (
        await db.execute(
            select(Email.id).where(
                Email.id.in_(payload.email_ids),
                Email.account_id == label.account_id,
                Email.tenant_id == user.tenant_id,
            )
        )
    ).scalars().all()
    changed = 0
    if payload.attach:
        existing = set(
            (
                await db.execute(
                    select(EmailLabelLink.email_id).where(
                        EmailLabelLink.label_id == label.id,
                        EmailLabelLink.email_id.in_(emails),
                    )
                )
            ).scalars()
        )
        for eid in emails:
            if eid in existing:
                continue
            db.add(
                EmailLabelLink(
                    tenant_id=user.tenant_id, email_id=eid, label_id=label.id
                )
            )
            changed += 1
    else:
        res = await db.execute(
            delete(EmailLabelLink).where(
                EmailLabelLink.label_id == label.id,
                EmailLabelLink.email_id.in_(emails),
            )
        )
        changed = res.rowcount or 0
    await db.commit()
    logger.info(
        "라벨 %s [label=%s] 대상 %d건 변경 %d건",
        "적용" if payload.attach else "해제",
        label.id,
        len(emails),
        changed,
    )
    return {"ok": True, "changed": changed}


@router.post("/accounts", response_model=EmailAccountOut, status_code=201)
async def create_account(
    payload: EmailAccountCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailAccountOut:
    """계정 생성. SHARED 는 emails.manage 필요. 생성자는 OWNER 멤버로 등록."""
    if payload.kind == "SHARED" and not role_has(user.role, "emails.manage"):
        raise HTTPException(
            status_code=403, detail="공유 계정 생성은 emails.manage 권한이 필요합니다"
        )
    # 중복 주소 방지(tenant 내 유일).
    dup = (
        await db.execute(
            select(EmailAccount.id).where(
                EmailAccount.tenant_id == user.tenant_id,
                EmailAccount.email_addr == payload.email_addr,
            )
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status_code=409, detail="이미 등록된 메일 주소입니다")

    data = payload.model_dump(exclude={"password", "smtp_password"})
    account = EmailAccount(tenant_id=user.tenant_id, created_by=user.id, **data)
    db.add(account)
    await db.flush()

    # 생성자 = OWNER 멤버.
    db.add(
        EmailAccountMember(
            tenant_id=user.tenant_id,
            account_id=account.id,
            user_id=user.id,
            role="OWNER",
            can_send=True,
            can_manage=True,
        )
    )
    await set_account_secrets(
        db,
        user.tenant_id,
        account.id,
        password=payload.password,
        smtp_password=payload.smtp_password,
    )
    await db.commit()
    await db.refresh(account)
    member = (
        await db.execute(
            select(EmailAccountMember).where(
                EmailAccountMember.account_id == account.id,
                EmailAccountMember.user_id == user.id,
            )
        )
    ).scalar_one()
    return _account_out(account, member)


@router.get("/accounts/{account_id}", response_model=EmailAccountOut)
async def get_account(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailAccountOut:
    account, member = await _load_account(db, user, account_id)
    out = _account_out(account, member)
    # 저장된 비밀번호(평문) — 편집 폼에서 확인·수정 가능하게 단건 조회에만 포함.
    # ⚠️ 평문 노출: emails.read + 계정 멤버십 통과자에게만(목록 API 는 비움). 운영
    #    편의(저장값 eye 토글)를 위한 의도적 노출 — 마스킹 정책으로 되돌리려면 여기와
    #    EmailAccountOut.password_plain / 프론트 startEdit 을 함께 수정.
    secrets = await get_account_secrets(db, user.tenant_id, account.id)
    out.password_plain = secrets.get("password") or None
    out.smtp_password_plain = secrets.get("smtp_password") or None
    return out


@router.patch("/accounts/{account_id}", response_model=EmailAccountOut)
async def update_account(
    account_id: UUID,
    payload: EmailAccountUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailAccountOut:
    account, member = await _load_account(db, user, account_id, need_manage=True)
    data = payload.model_dump(exclude_unset=True, exclude={"password", "smtp_password"})
    # 주소 변경 시 tenant 내 중복(자기 자신 제외) 방지 — 생성 시와 동일 규약.
    new_addr = data.get("email_addr")
    if new_addr is not None and new_addr != account.email_addr:
        dup = (
            await db.execute(
                select(EmailAccount.id).where(
                    EmailAccount.tenant_id == user.tenant_id,
                    EmailAccount.email_addr == new_addr,
                    EmailAccount.id != account.id,
                )
            )
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status_code=409, detail="이미 등록된 메일 주소입니다")
    for k, v in data.items():
        setattr(account, k, v)
    if payload.password is not None or payload.smtp_password is not None:
        await set_account_secrets(
            db,
            user.tenant_id,
            account.id,
            password=payload.password,
            smtp_password=payload.smtp_password,
        )
    await db.commit()
    await db.refresh(account)
    return _account_out(account, member)


@router.delete("/accounts/{account_id}", status_code=204)
async def delete_account(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> None:
    account, _ = await _load_account(db, user, account_id, need_manage=True)
    await delete_account_secrets(db, user.tenant_id, account.id)
    await db.delete(account)
    await db.commit()


@router.post("/accounts/{account_id}/test")
async def test_account(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    """저장된 자격증명으로 접속·인증 테스트. 폴더 수 반환."""
    account, _ = await _load_account(db, user, account_id)
    secrets = await get_account_secrets(db, user.tenant_id, account.id)
    if not secrets.get("password"):
        raise HTTPException(status_code=400, detail="비밀번호가 설정되지 않았습니다")
    cls = ADAPTERS.get(account.protocol)
    if cls is None:
        raise HTTPException(status_code=400, detail=f"미지원 프로토콜({account.protocol})")
    adapter = cls(
        AccountConn(
            host=account.host,
            port=account.port,
            security=account.security,
            username=account.username,
            password=secrets["password"],
        )
    )
    try:
        await adapter.connect()
        folders = await adapter.list_folders()
    except EmailFetchError as exc:
        # 테스트 실패도 last_error 에 반영해 배너를 최신 상태로 유지.
        account.last_error = str(exc)[:500]
        await db.commit()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        await adapter.close()
    # 접속·인증 성공 → 묵은 동기화 오류 배너 해제(전체 sync 를 기다리지 않음).
    account.last_error = None
    account.last_ok_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "folder_count": len(folders)}


@router.post("/accounts/{account_id}/sync")
async def sync_account_endpoint(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    """수동 동기화(MANUAL). 동기적으로 1회 PULL 실행."""
    account, _ = await _load_account(db, user, account_id)
    summary = await run_one(
        db, account.id, trigger_kind="MANUAL", triggered_by=user.id
    )
    return {
        "status": summary.status,
        "fetched": summary.fetched,
        "inserted": summary.inserted,
        "updated": summary.updated,
        "skipped": summary.skipped,
        "error": summary.error,
    }


@router.get("/accounts/{account_id}/folders", response_model=list[EmailFolderOut])
async def list_folders(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[EmailFolderOut]:
    account, _ = await _load_account(db, user, account_id)
    rows = (
        await db.execute(
            select(EmailFolder)
            .where(EmailFolder.account_id == account.id)
            .order_by(EmailFolder.name)
        )
    ).scalars().all()

    # total/unseen 을 로컬 DB 기준으로 실시간 계산(동기화 STATUS 스냅샷 대신).
    # 읽음 규칙은 목록(list_messages)과 동일: shared_seen 이면 email.is_seen,
    # 아니면 현재 사용자의 EmailUserState(없으면 미읽음).
    base = [
        Email.account_id == account.id,
        Email.server_deleted.is_(False),
        Email.is_archived.is_(False),
    ]
    total_rows = (
        await db.execute(
            select(Email.folder_id, func.count())
            .where(*base)
            .group_by(Email.folder_id)
        )
    ).all()
    total_map = {fid: c for fid, c in total_rows}

    if account.shared_seen:
        unseen_conds = [*base, Email.is_seen.is_(False)]
    else:
        seen_ids = select(EmailUserState.email_id).where(
            EmailUserState.user_id == user.id, EmailUserState.is_seen.is_(True)
        )
        unseen_conds = [*base, Email.id.not_in(seen_ids)]
    unseen_rows = (
        await db.execute(
            select(Email.folder_id, func.count())
            .where(*unseen_conds)
            .group_by(Email.folder_id)
        )
    ).all()
    unseen_map = {fid: c for fid, c in unseen_rows}

    out = []
    for f in rows:
        o = EmailFolderOut.model_validate(f)
        o.total_count = total_map.get(f.id, 0)
        o.unseen_count = unseen_map.get(f.id, 0)
        out.append(o)
    return out


# ---------------------------------------------------------------------------
# 멤버십 (공유 메일함)
# ---------------------------------------------------------------------------


@router.get("/accounts/{account_id}/members", response_model=list[EmailAccountMemberOut])
async def list_members(
    account_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[EmailAccountMemberOut]:
    await _load_account(db, user, account_id)
    rows = (
        await db.execute(
            select(EmailAccountMember, User.name)
            .join(User, User.id == EmailAccountMember.user_id)
            .where(EmailAccountMember.account_id == account_id)
        )
    ).all()
    out = []
    for m, uname in rows:
        item = EmailAccountMemberOut.model_validate(m)
        item.user_name = uname
        out.append(item)
    return out


@router.post(
    "/accounts/{account_id}/members",
    response_model=EmailAccountMemberOut,
    status_code=201,
)
async def add_member(
    account_id: UUID,
    payload: EmailAccountMemberCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailAccountMemberOut:
    account, _ = await _load_account(db, user, account_id, need_manage=True)
    # 대상 사용자가 같은 테넌트인지 확인.
    target = (
        await db.execute(
            select(User).where(
                User.id == payload.user_id, User.tenant_id == user.tenant_id
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="대상 사용자를 찾을 수 없습니다")
    exists = (
        await db.execute(
            select(EmailAccountMember.id).where(
                EmailAccountMember.account_id == account_id,
                EmailAccountMember.user_id == payload.user_id,
            )
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status_code=409, detail="이미 멤버입니다")
    member = EmailAccountMember(
        tenant_id=user.tenant_id,
        account_id=account_id,
        user_id=payload.user_id,
        role=payload.role,
        can_send=payload.can_send,
        can_manage=payload.can_manage,
    )
    db.add(member)
    await db.commit()
    await db.refresh(member)
    item = EmailAccountMemberOut.model_validate(member)
    item.user_name = target.name
    return item


@router.patch(
    "/accounts/{account_id}/members/{member_id}",
    response_model=EmailAccountMemberOut,
)
async def update_member(
    account_id: UUID,
    member_id: UUID,
    payload: EmailAccountMemberUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailAccountMemberOut:
    await _load_account(db, user, account_id, need_manage=True)
    member = (
        await db.execute(
            select(EmailAccountMember).where(
                EmailAccountMember.id == member_id,
                EmailAccountMember.account_id == account_id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="멤버를 찾을 수 없습니다")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(member, k, v)
    await db.commit()
    await db.refresh(member)
    return EmailAccountMemberOut.model_validate(member)


@router.delete("/accounts/{account_id}/members/{member_id}", status_code=204)
async def remove_member(
    account_id: UUID,
    member_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> None:
    await _load_account(db, user, account_id, need_manage=True)
    member = (
        await db.execute(
            select(EmailAccountMember).where(
                EmailAccountMember.id == member_id,
                EmailAccountMember.account_id == account_id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="멤버를 찾을 수 없습니다")
    await db.delete(member)
    await db.commit()


# ---------------------------------------------------------------------------
# 메시지 조회 (read-only). 플래그/이동/아카이브/발송은 Stage 4·5.
# ---------------------------------------------------------------------------


@router.get("/messages", response_model=Page[EmailListItem])
async def list_messages(
    account_id: UUID = Query(...),
    folder_id: UUID | None = Query(default=None),
    label_id: UUID | None = Query(default=None),
    q: str | None = Query(default=None),
    is_archived: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> Page[EmailListItem]:
    account, _ = await _load_account(db, user, account_id)
    conds = [Email.account_id == account_id, Email.server_deleted.is_(False)]
    if folder_id is not None:
        conds.append(Email.folder_id == folder_id)
    if label_id is not None:
        # 이 라벨이 붙은 메일만.
        conds.append(
            Email.id.in_(
                select(EmailLabelLink.email_id).where(
                    EmailLabelLink.label_id == label_id
                )
            )
        )
    if is_archived is not None:
        conds.append(Email.is_archived.is_(is_archived))
    if q:
        # pg_bigm 부분일치(search_text). 인덱스 미설치 환경도 seq scan 으로 동작.
        conds.append(Email.search_text.ilike(f"%{q}%"))

    total = (
        await db.execute(select(func.count()).select_from(Email).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Email)
            .where(*conds)
            .order_by(Email.received_at.desc().nullslast())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    items = [EmailListItem.model_validate(e) for e in rows]
    # 공유함 유저별 읽음(shared_seen=false) — email_user_state 오버레이로 is_seen 대체.
    if not account.shared_seen and rows:
        seen_map = dict(
            (
                await db.execute(
                    select(EmailUserState.email_id, EmailUserState.is_seen).where(
                        EmailUserState.user_id == user.id,
                        EmailUserState.email_id.in_([e.id for e in rows]),
                    )
                )
            ).all()
        )
        for it in items:
            it.is_seen = bool(seen_map.get(it.id, False))
    # 라벨 id 주입 — 한 메일에 여러 라벨(배지).
    if rows:
        link_rows = (
            await db.execute(
                select(EmailLabelLink.email_id, EmailLabelLink.label_id).where(
                    EmailLabelLink.email_id.in_([e.id for e in rows])
                )
            )
        ).all()
        labels_by_email: dict = {}
        for eid, lid in link_rows:
            labels_by_email.setdefault(eid, []).append(lid)
        for it in items:
            it.label_ids = labels_by_email.get(it.id, [])
    return Page(items=items, total=total, limit=limit, offset=offset)


@router.get("/messages/{email_id}", response_model=EmailDetail)
async def get_message(
    email_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> EmailDetail:
    email = (
        await db.execute(
            select(Email)
            .where(Email.id == email_id, Email.tenant_id == user.tenant_id)
            # attachments 를 eager-load — model_validate 시 async lazy-load(MissingGreenlet) 방지.
            .options(selectinload(Email.attachments))
        )
    ).scalar_one_or_none()
    if email is None:
        raise HTTPException(status_code=404, detail="메일을 찾을 수 없습니다")
    # 멤버십 검증.
    account, _ = await _load_account(db, user, email.account_id)
    detail = EmailDetail.model_validate(email)
    if not account.shared_seen:
        us = (
            await db.execute(
                select(EmailUserState.is_seen).where(
                    EmailUserState.email_id == email_id,
                    EmailUserState.user_id == user.id,
                )
            )
        ).scalar_one_or_none()
        detail.is_seen = bool(us)
    detail.attachments = [
        EmailAttachmentOut(
            id=a.id,
            filename=a.filename,
            content_type=a.content_type,
            is_inline=a.is_inline,
            size_bytes=a.size_bytes,
            cached=a.file_path is not None,
        )
        for a in email.attachments
    ]
    detail.label_ids = list(
        (
            await db.execute(
                select(EmailLabelLink.label_id).where(
                    EmailLabelLink.email_id == email_id
                )
            )
        ).scalars()
    )
    return detail


async def _load_message(db: AsyncSession, user: User, email_id: UUID) -> Email:
    """메일 로드 + 멤버십 검증."""
    email = (
        await db.execute(
            select(Email).where(
                Email.id == email_id, Email.tenant_id == user.tenant_id
            )
        )
    ).scalar_one_or_none()
    if email is None:
        raise HTTPException(status_code=404, detail="메일을 찾을 수 없습니다")
    await _load_account(db, user, email.account_id)
    return email


def _safe_filename(name: str, default: str) -> str:
    """다운로드 파일명 — 경로 구분자·널 제거."""
    cleaned = (name or "").replace("/", "_").replace("\\", "_").replace("\x00", "").strip()
    return cleaned or default


@router.get("/messages/{email_id}/raw")
async def download_raw(
    email_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> FileResponse:
    """원본 .eml 다운로드(blob). 프론트는 axios responseType:'blob' (CLAUDE.md §6)."""
    email = await _load_message(db, user, email_id)
    if not email.raw_path:
        raise HTTPException(status_code=404, detail="원본이 보관되어 있지 않습니다")
    abs_path = resolve_upload_path(email.raw_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="원본 파일이 디스크에 없습니다")
    fname = _safe_filename((email.subject or "message")[:80], "message") + ".eml"
    return FileResponse(str(abs_path), filename=fname, media_type="message/rfc822")


async def _ensure_attachment_file(
    db: AsyncSession, email: Email, att: EmailAttachment
) -> str | None:
    """첨부를 디스크에 캐시(없으면 보관된 .eml 에서 추출)하고 상대경로 반환.

    캐시 시 att.file_path/sha256/fetched_at/content_type 을 채운다(commit 은 호출자).
    추출 불가(원본 없음/디스크 누락/파트 못 찾음) 시 None. (설계 §7 lazy 캐시)
    """
    if att.file_path:
        cached = resolve_upload_path(att.file_path)
        if cached.exists():
            return att.file_path
    if not email.raw_path:
        return None
    raw_abs = resolve_upload_path(email.raw_path)
    if not raw_abs.exists():
        return None
    found = extract_attachment(
        raw_abs.read_bytes(), filename=att.filename, content_id=att.content_id
    )
    if found is None:
        return None
    data, detected_type = found
    ext = Path(att.filename or "").suffix or ".bin"
    stored_rel, _ = await save_bytes(data, f"emails/{email.id}", ext)
    att.file_path = stored_rel
    att.sha256 = hashlib.sha256(data).hexdigest()
    att.fetched_at = datetime.now(timezone.utc)
    if not att.content_type:
        att.content_type = detected_type
    return stored_rel


@router.get("/messages/{email_id}/attachments/{attachment_id}/download")
async def download_attachment(
    email_id: UUID,
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> FileResponse:
    """첨부 다운로드 — lazy: 캐시 없으면 보관된 .eml 에서 추출 후 캐시(설계 §7)."""
    email = await _load_message(db, user, email_id)
    att = (
        await db.execute(
            select(EmailAttachment).where(
                EmailAttachment.id == attachment_id,
                EmailAttachment.email_id == email_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다")

    rel = await _ensure_attachment_file(db, email, att)
    if rel is None:
        raise HTTPException(status_code=404, detail="원본에서 첨부를 찾을 수 없습니다")
    await db.commit()
    return FileResponse(
        str(resolve_upload_path(rel)),
        filename=_safe_filename(att.filename, "attachment"),
        media_type=att.content_type or "application/octet-stream",
    )


_FLAG_ACTION = {True: {"is_seen": "SEEN", "is_flagged": "FLAG"},
                False: {"is_seen": "UNSEEN", "is_flagged": "UNFLAG"}}


def _enqueue(
    db: AsyncSession,
    account: EmailAccount,
    email: Email,
    action: str,
    user_id: UUID,
    target_folder: str | None = None,
) -> None:
    db.add(
        EmailPendingAction(
            tenant_id=account.tenant_id,
            user_id=user_id,
            account_id=account.id,
            email_id=email.id,
            action=action,
            target_folder=target_folder,
            status="PENDING",
        )
    )


async def _set_user_seen(
    db: AsyncSession, tenant_id: UUID, email_id: UUID, user_id: UUID, seen: bool
) -> None:
    """공유함(shared_seen=false) 유저별 읽음 오버레이 — 서버 push 안 함."""
    row = (
        await db.execute(
            select(EmailUserState).where(
                EmailUserState.email_id == email_id,
                EmailUserState.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(
            EmailUserState(
                tenant_id=tenant_id,
                email_id=email_id,
                user_id=user_id,
                is_seen=seen,
                seen_at=datetime.now(timezone.utc) if seen else None,
            )
        )
    else:
        row.is_seen = seen
        row.seen_at = datetime.now(timezone.utc) if seen else None


async def _apply_action(
    db: AsyncSession,
    account: EmailAccount,
    email: Email,
    user: User,
    action: str,
    target_folder: str | None = None,
) -> None:
    """단건 액션을 로컬 낙관 반영 + 서버 push 아웃박스 적재."""
    if action in ("SEEN", "UNSEEN"):
        seen = action == "SEEN"
        if account.shared_seen:
            email.is_seen = seen
            _enqueue(db, account, email, action, user.id)
        else:
            await _set_user_seen(db, account.tenant_id, email.id, user.id, seen)
    elif action in ("FLAG", "UNFLAG"):
        email.is_flagged = action == "FLAG"
        _enqueue(db, account, email, action, user.id)
    elif action == "ARCHIVE":
        email.is_archived = True
        email.archived_at = datetime.now(timezone.utc)
        email.archived_by = user.id
        _enqueue(db, account, email, "ARCHIVE", user.id)
    elif action == "TRASH":
        # 목록에서 즉시 제외(낙관). 서버 push 는 큐로 처리.
        email.server_deleted = True
        email.server_deleted_at = datetime.now(timezone.utc)
        _enqueue(db, account, email, "TRASH", user.id)
        logger.info("메일 휴지통 [account=%s email=%s]", account.id, email.id)
    elif action == "DELETE":
        email.server_deleted = True
        email.server_deleted_at = datetime.now(timezone.utc)
        _enqueue(db, account, email, "DELETE", user.id)
        logger.info("메일 영구삭제 [account=%s email=%s]", account.id, email.id)
    elif action == "MOVE":
        _enqueue(db, account, email, "MOVE", user.id, target_folder=target_folder)


@router.patch("/messages/{email_id}")
async def update_message_flags(
    email_id: UUID,
    payload: EmailFlagUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    """읽음/별표 토글 — 로컬 낙관 반영 + 서버 push 큐(공유함 읽음은 shared_seen 정책)."""
    email = await _load_message(db, user, email_id)
    account, _ = await _load_account(db, user, email.account_id)
    if payload.is_seen is not None:
        await _apply_action(
            db, account, email, user, "SEEN" if payload.is_seen else "UNSEEN"
        )
    if payload.is_flagged is not None:
        await _apply_action(
            db, account, email, user, "FLAG" if payload.is_flagged else "UNFLAG"
        )
    await db.commit()
    return {"ok": True}


@router.post("/messages/{email_id}/archive")
async def archive_message(
    email_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    email = await _load_message(db, user, email_id)
    account, member = await _load_account(db, user, email.account_id, need_send=True)
    await _apply_action(db, account, email, user, "ARCHIVE")
    await db.commit()
    return {"ok": True}


@router.post("/messages/{email_id}/move")
async def move_message(
    email_id: UUID,
    payload: EmailMoveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    email = await _load_message(db, user, email_id)
    account, _ = await _load_account(db, user, email.account_id, need_send=True)
    await _apply_action(db, account, email, user, "MOVE", target_folder=payload.target_folder)
    await db.commit()
    return {"ok": True}


@router.post("/messages/{email_id}/trash")
async def trash_message(
    email_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    email = await _load_message(db, user, email_id)
    account, _ = await _load_account(db, user, email.account_id, need_send=True)
    await _apply_action(db, account, email, user, "TRASH")
    await db.commit()
    return {"ok": True}


@router.post("/messages/bulk")
async def bulk_action(
    payload: EmailBulkAction,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> dict:
    """여러 건 일괄 액션. 모든 메일은 멤버인 계정의 것이어야 함."""
    n = 0
    acct_cache: dict[UUID, EmailAccount] = {}
    for eid in payload.email_ids:
        email = (
            await db.execute(
                select(Email).where(
                    Email.id == eid, Email.tenant_id == user.tenant_id
                )
            )
        ).scalar_one_or_none()
        if email is None:
            continue
        account = acct_cache.get(email.account_id)
        if account is None:
            need_send = payload.action not in ("SEEN", "UNSEEN", "FLAG", "UNFLAG")
            account, _ = await _load_account(
                db, user, email.account_id, need_send=need_send
            )
            acct_cache[email.account_id] = account
        await _apply_action(
            db, account, email, user, payload.action, target_folder=payload.target_folder
        )
        n += 1
    await db.commit()
    logger.info(
        "메일 일괄 작업 [user=%s action=%s] 요청 %d건 적용 %d건",
        user.id,
        payload.action,
        len(payload.email_ids),
        n,
    )
    return {"ok": True, "applied": n}


# ---------------------------------------------------------------------------
# 발송 (SMTP) — Stage 5
# ---------------------------------------------------------------------------


def _outbox_out(ob: EmailOutbox, sender_name: str | None) -> EmailOutboxOut:
    out = EmailOutboxOut.model_validate(ob)
    out.sender_name = sender_name
    return out


async def _do_send(
    db: AsyncSession, outbox: EmailOutbox, account: EmailAccount, user: User
) -> None:
    """발송 실행 — 실패 시 status=FAILED 기록 후 400."""
    in_reply_msgid = None
    if outbox.in_reply_to:
        in_reply_msgid = (
            await db.execute(
                select(Email.message_id).where(Email.id == outbox.in_reply_to)
            )
        ).scalar_one_or_none()
    try:
        await send_outbox(db, outbox, account, user, in_reply_to_msgid=in_reply_msgid)
    except Exception as exc:
        outbox.status = "FAILED"
        outbox.error_message = str(exc)[:500]
        await db.commit()
        logger.warning("메일 발송 실패 [%s]: %s", account.id, exc)
        raise HTTPException(status_code=400, detail=f"발송 실패: {exc}") from exc


_OUTBOX_UPLOAD_SUBDIR = "emails/outbox"


def _is_safe_outbox_attachment(rel: str) -> bool:
    """업로드 첨부의 file_path 검증 — 반드시 emails/outbox/ 상대경로(traversal 차단).

    /email/outbox/upload 가 돌려준 경로만 통과시켜, 클라이언트가 임의 파일
    (다른 메일 .eml 등)을 첨부로 빼돌리는 것을 막는다.
    """
    if not rel:
        return False
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts:
        return False
    return p.parts[:2] == ("emails", "outbox")


@router.post("/outbox/upload")
async def upload_outbox_attachment(
    file: UploadFile = File(...),
    user: User = Depends(require_permission("emails.send")),
) -> dict:
    """발송 첨부 업로드 — 저장 후 참조를 반환. 클라이언트는 이 값을
    compose 의 attachments[] 에 그대로 echo (file_path 는 서버가 재검증)."""
    rel, size = await save_upload(file, _OUTBOX_UPLOAD_SUBDIR)
    return {
        "filename": file.filename or "attachment",
        "file_path": rel,
        "content_type": file.content_type,
        "size_bytes": size,
    }


@router.post("/outbox", response_model=EmailOutboxOut)
async def compose(
    payload: EmailComposeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.send")),
) -> EmailOutboxOut:
    """작성 — status=QUEUED 면 즉시 발송, DRAFT 면 임시 저장."""
    account, _ = await _load_account(db, user, payload.account_id, need_send=True)
    outbox = EmailOutbox(
        tenant_id=user.tenant_id,
        user_id=user.id,
        account_id=account.id,
        in_reply_to=payload.in_reply_to,
        to_addrs=[str(a) for a in payload.to_addrs],
        cc_addrs=[str(a) for a in payload.cc_addrs] if payload.cc_addrs else None,
        bcc_addrs=[str(a) for a in payload.bcc_addrs] if payload.bcc_addrs else None,
        subject=payload.subject,
        body_text=payload.body_text,
        body_html=payload.body_html,
        status="DRAFT",
    )
    db.add(outbox)
    await db.flush()

    atts: list[dict] = []

    # 전달: 원본 메일의 비인라인 첨부를 .eml 에서 추출·캐시해 함께 발송.
    if payload.attach_from_email:
        src = await _load_message(db, user, payload.attach_from_email)
        src_atts = (
            await db.execute(
                select(EmailAttachment).where(
                    EmailAttachment.email_id == src.id,
                    EmailAttachment.is_inline.is_(False),
                )
            )
        ).scalars().all()
        for a in src_atts:
            rel = await _ensure_attachment_file(db, src, a)
            if rel:
                atts.append(
                    {
                        "filename": a.filename,
                        "file_path": rel,
                        "content_type": a.content_type,
                    }
                )
            else:
                logger.warning(
                    "전달 첨부 추출 실패(건너뜀) [email=%s attachment=%s] — 원본 .eml 없음/추출 불가",
                    src.id,
                    a.id,
                )

    # 사용자가 업로드한 첨부 — file_path 는 emails/outbox/ 하위만 허용(traversal 방지).
    for ua in payload.attachments or []:
        if not _is_safe_outbox_attachment(ua.file_path):
            raise HTTPException(status_code=400, detail="잘못된 첨부 경로입니다")
        atts.append(
            {
                "filename": ua.filename,
                "file_path": ua.file_path,
                "content_type": ua.content_type,
            }
        )

    if atts:
        outbox.attachments = atts

    if payload.status == "QUEUED":
        await _do_send(db, outbox, account, user)
    await db.commit()
    await db.refresh(outbox)
    logger.info(
        "메일 작성 [account=%s outbox=%s] status=%s 첨부=%d",
        account.id,
        outbox.id,
        outbox.status,
        len(atts),
    )
    return _outbox_out(outbox, user.name)


@router.patch("/outbox/{outbox_id}", response_model=EmailOutboxOut)
async def update_outbox(
    outbox_id: UUID,
    payload: EmailOutboxUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.send")),
) -> EmailOutboxOut:
    """임시보관(DRAFT) 수정. 발송 완료된 항목은 수정 불가."""
    outbox = (
        await db.execute(
            select(EmailOutbox).where(
                EmailOutbox.id == outbox_id, EmailOutbox.tenant_id == user.tenant_id
            )
        )
    ).scalar_one_or_none()
    if outbox is None:
        raise HTTPException(status_code=404, detail="발송 항목을 찾을 수 없습니다")
    if outbox.status == "SENT":
        raise HTTPException(status_code=409, detail="이미 발송된 메일은 수정할 수 없습니다")
    await _load_account(db, user, outbox.account_id, need_send=True)

    data = payload.model_dump(exclude_unset=True, exclude={"add_attachments"})
    if "to_addrs" in data:
        outbox.to_addrs = [str(a) for a in (data["to_addrs"] or [])]
    if "cc_addrs" in data:
        outbox.cc_addrs = [str(a) for a in data["cc_addrs"]] if data["cc_addrs"] else None
    if "bcc_addrs" in data:
        outbox.bcc_addrs = [str(a) for a in data["bcc_addrs"]] if data["bcc_addrs"] else None
    for k in ("subject", "body_text", "body_html"):
        if k in data:
            setattr(outbox, k, data[k])

    # 새 업로드 첨부 덧붙임(기존 서버측 첨부는 보존).
    if payload.add_attachments:
        existing = list(outbox.attachments or [])
        for ua in payload.add_attachments:
            if not _is_safe_outbox_attachment(ua.file_path):
                raise HTTPException(status_code=400, detail="잘못된 첨부 경로입니다")
            existing.append(
                {
                    "filename": ua.filename,
                    "file_path": ua.file_path,
                    "content_type": ua.content_type,
                }
            )
        outbox.attachments = existing

    await db.commit()
    await db.refresh(outbox)
    return _outbox_out(outbox, user.name)


@router.post("/outbox/{outbox_id}/send", response_model=EmailOutboxOut)
async def send_draft(
    outbox_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.send")),
) -> EmailOutboxOut:
    outbox = (
        await db.execute(
            select(EmailOutbox).where(
                EmailOutbox.id == outbox_id, EmailOutbox.tenant_id == user.tenant_id
            )
        )
    ).scalar_one_or_none()
    if outbox is None:
        raise HTTPException(status_code=404, detail="발송 항목을 찾을 수 없습니다")
    if outbox.status == "SENT":
        raise HTTPException(status_code=409, detail="이미 발송되었습니다")
    account, _ = await _load_account(db, user, outbox.account_id, need_send=True)
    await _do_send(db, outbox, account, user)
    await db.commit()
    await db.refresh(outbox)
    return _outbox_out(outbox, user.name)


@router.get("/outbox", response_model=list[EmailOutboxOut])
async def list_outbox(
    account_id: UUID = Query(...),
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[EmailOutboxOut]:
    """발송함/임시보관함 — 공유 계정은 멤버 모두가 본다(보낸 사람 표시)."""
    await _load_account(db, user, account_id)
    conds = [EmailOutbox.account_id == account_id]
    if status_filter:
        conds.append(EmailOutbox.status == status_filter)
    rows = (
        await db.execute(
            select(EmailOutbox, User.name)
            .join(User, User.id == EmailOutbox.user_id, isouter=True)
            .where(*conds)
            .order_by(EmailOutbox.created_at.desc())
            .limit(limit)
        )
    ).all()
    return [_outbox_out(ob, name) for ob, name in rows]


@router.delete("/outbox/{outbox_id}", status_code=204)
async def delete_draft(
    outbox_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.send")),
) -> None:
    outbox = (
        await db.execute(
            select(EmailOutbox).where(
                EmailOutbox.id == outbox_id, EmailOutbox.tenant_id == user.tenant_id
            )
        )
    ).scalar_one_or_none()
    if outbox is None:
        raise HTTPException(status_code=404, detail="발송 항목을 찾을 수 없습니다")
    if outbox.status == "SENT":
        raise HTTPException(status_code=409, detail="발송된 메일은 삭제할 수 없습니다")
    await db.delete(outbox)
    await db.commit()


@router.get("/sync-runs", response_model=list[EmailSyncRunOut])
async def list_sync_runs(
    account_id: UUID = Query(...),
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("emails.read")),
) -> list[EmailSyncRunOut]:
    await _load_account(db, user, account_id)
    rows = (
        await db.execute(
            select(EmailSyncRun)
            .where(EmailSyncRun.account_id == account_id)
            .order_by(EmailSyncRun.started_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [EmailSyncRunOut.model_validate(r) for r in rows]
