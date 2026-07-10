"""메일 동기화 실행자 — announcements.runner 와 동일 골격.

Stage 1(수신 read-only, PULL):
1. EmailSyncRun(RUNNING) 생성
2. 비밀 복호화 → 없으면 SKIPPED
3. 어댑터 connect → list_folders → email_folders UPSERT(STATUS 토큰 갱신)
4. 폴더별 fetch_new(since_uid=last_synced_uid) → 원본 .eml 저장 + emails UPSERT
   + email_attachments 메타(lazy) → last_synced_uid 전진
5. run 종료 status=OK/FAILED/SKIPPED + 카운트, account.last_* 갱신

소스(계정)별 실패 격리 — 한 계정 실패가 다른 계정을 멈추지 않는다(announcements 동형).
PUSH(양방향)·플래그 증분은 Stage 3·4.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import literal_column, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Email,
    EmailAccount,
    EmailAttachment,
    EmailFolder,
    EmailPendingAction,
    EmailSyncRun,
)
from app.services.email.base import (
    AccountConn,
    EmailAdapter,
    EmailFetchError,
    FolderState,
    RawEmail,
)
from app.services.email.registry import ADAPTERS
from app.services.email.secrets import get_account_secrets
from app.services.storage import save_bytes

logger = logging.getLogger(__name__)

# 한 폴더에서 한 사이클에 받는 최대 메시지 수(대용량 메일함 OOM 방지, 설계 §5).
DEFAULT_BATCH = 200


@dataclass
class RunSummary:
    account_id: UUID
    status: str  # OK | FAILED | SKIPPED
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    flag_synced: int = 0  # 플래그 증분 반영 건수
    expunged: int = 0  # 서버 삭제 반영 건수
    pushed: int = 0  # 로컬→서버 반영 건수
    skipped: int = 0
    error: str | None = None


# 로컬 액션 → IMAP 플래그 add/remove 매핑.
_FLAG_ACTIONS = {
    "SEEN": ({"\\Seen"}, set()),
    "UNSEEN": (set(), {"\\Seen"}),
    "FLAG": ({"\\Flagged"}, set()),
    "UNFLAG": (set(), {"\\Flagged"}),
}
_MAX_PUSH_ATTEMPTS = 5


def _build_adapter(account: EmailAccount, password: str) -> EmailAdapter | None:
    cls = ADAPTERS.get(account.protocol)
    if cls is None:
        return None
    conn = AccountConn(
        host=account.host,
        port=account.port,
        security=account.security,
        username=account.username,
        password=password,
    )
    return cls(conn)


async def _upsert_folder(
    db: AsyncSession, account: EmailAccount, fs: FolderState
) -> EmailFolder:
    """email_folders UPSERT — STATUS 토큰 갱신. UIDVALIDITY 변경 시 last_synced_uid 리셋."""
    q = select(EmailFolder).where(
        EmailFolder.account_id == account.id, EmailFolder.raw_name == fs.raw_name
    )
    folder = (await db.execute(q)).scalar_one_or_none()
    if folder is None:
        folder = EmailFolder(
            tenant_id=account.tenant_id,
            account_id=account.id,
            name=fs.name,
            raw_name=fs.raw_name,
            role=fs.role,
            uid_validity=fs.uid_validity,
            uid_next=fs.uid_next,
            total_count=fs.total,
            unseen_count=fs.unseen,
            last_synced_uid=0,
        )
        db.add(folder)
        await db.flush()
        return folder

    # UIDVALIDITY 변경 → 서버가 UID 무효화. 재동기화(새 uid_validity 로 새 row 생성).
    if (
        fs.uid_validity is not None
        and folder.uid_validity is not None
        and fs.uid_validity != folder.uid_validity
    ):
        logger.warning(
            "UIDVALIDITY 변경 [%s/%s]: %s → %s, 재동기화",
            account.id, fs.raw_name, folder.uid_validity, fs.uid_validity,
        )
        folder.last_synced_uid = 0
    folder.name = fs.name
    folder.role = fs.role
    folder.uid_validity = fs.uid_validity
    folder.uid_next = fs.uid_next
    folder.total_count = fs.total
    folder.unseen_count = fs.unseen
    await db.flush()
    return folder


async def _store_one(
    db: AsyncSession,
    account: EmailAccount,
    folder: EmailFolder,
    raw: RawEmail,
    *,
    now: datetime,
) -> str:
    """원본 .eml 저장 + emails UPSERT + 첨부 메타. 반환 'inserted'|'updated'."""
    uid_validity = folder.uid_validity or 0
    raw_path = None
    raw_sha = None
    if raw.raw_bytes:
        recv = raw.received_at or now
        subdir = f"emails/{account.id}/{recv:%Y}/{recv:%m}"
        raw_path, _ = await save_bytes(raw.raw_bytes, subdir, ".eml")
        raw_sha = hashlib.sha256(raw.raw_bytes).hexdigest()

    values = {
        "tenant_id": account.tenant_id,
        "account_id": account.id,
        "folder_id": folder.id,
        "imap_uid": raw.imap_uid,
        "uid_validity": uid_validity,
        "message_id": raw.message_id,
        "thread_id": raw.thread_id,
        "subject": raw.subject,
        "from_addr": raw.from_addr,
        "from_name": raw.from_name,
        "to_addrs": raw.to_addrs or None,
        "cc_addrs": raw.cc_addrs or None,
        "bcc_addrs": raw.bcc_addrs or None,
        "reply_to": raw.reply_to,
        "sent_at": raw.sent_at,
        "received_at": raw.received_at,
        "body_text": raw.body_text,
        "body_html": raw.body_html,
        "snippet": raw.snippet,
        "has_attachments": raw.has_attachments,
        "size_bytes": raw.size_bytes,
        "is_seen": raw.is_seen,
        "is_flagged": raw.is_flagged,
        "is_answered": raw.is_answered,
        "is_draft": raw.is_draft,
        "raw_path": raw_path,
        "raw_sha256": raw_sha,
    }
    stmt = pg_insert(Email).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["account_id", "folder_id", "uid_validity", "imap_uid"],
        set_={
            "is_seen": stmt.excluded.is_seen,
            "is_flagged": stmt.excluded.is_flagged,
            "is_answered": stmt.excluded.is_answered,
            "is_draft": stmt.excluded.is_draft,
            "subject": stmt.excluded.subject,
            "snippet": stmt.excluded.snippet,
            "updated_at": now,
        },
    ).returning(Email.id, literal_column("(xmax = 0)").label("inserted"))
    row = (await db.execute(stmt)).first()
    email_id, inserted = row[0], bool(row[1])

    if inserted and raw.attachments:
        for att in raw.attachments:
            db.add(
                EmailAttachment(
                    tenant_id=account.tenant_id,
                    email_id=email_id,
                    filename=att.filename[:512],
                    content_type=att.content_type,
                    content_id=att.content_id,
                    is_inline=att.is_inline,
                    size_bytes=att.size_bytes,
                    # lazy — file_path/part_ref 는 열람 시(Stage 2) 채움.
                )
            )
    return "inserted" if inserted else "updated"


async def push_pending(
    db: AsyncSession, account: EmailAccount, adapter: EmailAdapter
) -> int:
    """로컬→서버 반영 아웃박스 처리(PULL 전에 실행). 반환: 성공 push 수.

    충돌: 메일이 서버에서 이미 사라졌으면(MOVE/STORE 실패) 재시도 후
    _MAX_PUSH_ATTEMPTS 초과 시 FAILED. 로컬 메일/UID 없으면 no-op(DONE).
    """
    rows = (
        await db.execute(
            select(EmailPendingAction, Email, EmailFolder)
            .join(Email, Email.id == EmailPendingAction.email_id, isouter=True)
            .join(EmailFolder, EmailFolder.id == Email.folder_id, isouter=True)
            .where(
                EmailPendingAction.account_id == account.id,
                EmailPendingAction.status == "PENDING",
            )
            .order_by(EmailPendingAction.created_at.asc())
        )
    ).all()
    now = datetime.now(timezone.utc)
    pushed = 0
    for pa, email, folder in rows:
        if email is None or folder is None or not email.imap_uid:
            pa.status = "DONE"  # 로컬에서 사라짐 → 반영할 대상 없음
            pa.done_at = now
            continue
        raw_name = folder.raw_name
        uid = email.imap_uid
        try:
            if pa.action in _FLAG_ACTIONS:
                add, remove = _FLAG_ACTIONS[pa.action]
                await adapter.store_flags(raw_name, uid, add=add, remove=remove)
            elif pa.action == "MOVE":
                await adapter.move(raw_name, uid, pa.target_folder or "")
            elif pa.action == "ARCHIVE":
                await adapter.move(raw_name, uid, account.archive_folder or "Archive")
            elif pa.action == "TRASH":
                # 이미 Trash 폴더 안의 메일을 또 휴지통으로 보내면 (Trash→Trash)
                # 새 UID 로 복사돼 동기화 시 새 row 로 되살아난다. Trash 안에서의
                # 삭제는 영구삭제(EXPUNGE)로 처리.
                if (folder.role or "").upper() == "TRASH":
                    await adapter.delete_message(raw_name, uid)
                else:
                    await adapter.move(raw_name, uid, account.trash_folder or "Trash")
            elif pa.action == "DELETE":
                await adapter.delete_message(raw_name, uid)
            else:
                pa.status = "FAILED"
                pa.last_error = f"알 수 없는 액션: {pa.action}"
                continue
            pa.status = "DONE"
            pa.done_at = datetime.now(timezone.utc)
            pushed += 1
        except NotImplementedError:
            pa.status = "FAILED"
            pa.last_error = "어댑터가 push 를 지원하지 않습니다"
        except Exception as exc:
            pa.attempts += 1
            pa.last_error = str(exc)[:500]
            if pa.attempts >= _MAX_PUSH_ATTEMPTS:
                pa.status = "FAILED"
            logger.warning(
                "pending push 실패 [%s uid=%s try=%d]: %s",
                pa.action, uid, pa.attempts, exc,
            )
    await db.flush()
    return pushed


async def _pending_flag_uids(
    db: AsyncSession, account: EmailAccount, folder: EmailFolder
) -> set[int]:
    """이 폴더에서 PENDING 플래그 액션이 걸린 UID — 서버 플래그 덮어쓰기 제외(로컬 우선)."""
    rows = (
        await db.execute(
            select(Email.imap_uid)
            .join(EmailPendingAction, EmailPendingAction.email_id == Email.id)
            .where(
                EmailPendingAction.account_id == account.id,
                EmailPendingAction.status == "PENDING",
                EmailPendingAction.action.in_(list(_FLAG_ACTIONS.keys())),
                Email.folder_id == folder.id,
            )
        )
    ).scalars().all()
    return {u for u in rows if u is not None}


async def _apply_flag_changes(
    db: AsyncSession,
    account: EmailAccount,
    folder: EmailFolder,
    changes: list,
    *,
    now: datetime,
    skip_uids: set[int] | None = None,
) -> int:
    """서버 플래그 증분을 emails 에 반영. 반환: 매칭된 row 수.

    `skip_uids`: PENDING 로컬 액션이 걸린 UID 는 덮어쓰지 않는다(충돌 — 로컬 우선).
    """
    uid_validity = folder.uid_validity or 0
    skip = skip_uids or set()
    n = 0
    for ch in changes:
        if ch.imap_uid in skip:
            continue
        res = await db.execute(
            update(Email)
            .where(
                Email.account_id == account.id,
                Email.folder_id == folder.id,
                Email.uid_validity == uid_validity,
                Email.imap_uid == ch.imap_uid,
                Email.server_deleted.is_(False),
            )
            .values(
                is_seen=ch.is_seen,
                is_flagged=ch.is_flagged,
                is_answered=ch.is_answered,
                is_draft=ch.is_draft,
                updated_at=now,
            )
        )
        n += res.rowcount or 0
    return n


async def _mark_expunged(
    db: AsyncSession,
    account: EmailAccount,
    folder: EmailFolder,
    server_uids: set[int],
    *,
    now: datetime,
) -> int:
    """서버에 더 이상 없는 로컬 메일을 server_deleted 로 표시(.eml 은 보존)."""
    uid_validity = folder.uid_validity or 0
    conds = [
        Email.account_id == account.id,
        Email.folder_id == folder.id,
        Email.uid_validity == uid_validity,
        Email.server_deleted.is_(False),
    ]
    if server_uids:
        conds.append(Email.imap_uid.notin_(server_uids))
    # server_uids 가 비면(폴더가 서버에서 비었음) 로컬 전부 삭제 표시.
    res = await db.execute(
        update(Email).where(*conds).values(server_deleted=True, server_deleted_at=now)
    )
    return res.rowcount or 0


async def sync_account(
    db: AsyncSession,
    account: EmailAccount,
    *,
    trigger_kind: str = "MANUAL",
    triggered_by: UUID | None = None,
    batch_size: int = DEFAULT_BATCH,
) -> RunSummary:
    now = datetime.now(timezone.utc)
    run = EmailSyncRun(
        tenant_id=account.tenant_id,
        account_id=account.id,
        trigger_kind=trigger_kind,
        triggered_by=triggered_by,
        direction="BOTH",
        started_at=now,
        status="RUNNING",
    )
    db.add(run)
    await db.flush()

    summary = RunSummary(account_id=account.id, status="OK")

    secrets = await get_account_secrets(db, account.tenant_id, account.id)
    if not secrets.get("password"):
        summary.status = "SKIPPED"
        summary.error = "비밀번호 미설정"
        run.status = "SKIPPED"
        run.finished_at = datetime.now(timezone.utc)
        run.error_message = summary.error
        account.last_sync_at = now
        account.last_error = summary.error
        await db.commit()
        return summary

    adapter = _build_adapter(account, secrets["password"])
    if adapter is None:
        summary.status = "SKIPPED"
        summary.error = f"어댑터 미구현({account.protocol})"
        run.status = "SKIPPED"
        run.finished_at = datetime.now(timezone.utc)
        run.error_message = summary.error
        await db.commit()
        return summary

    try:
        await adapter.connect()
        # PUSH 먼저 — 로컬 변경을 서버에 반영한 뒤 PULL 로 최신화(설계 §6).
        try:
            summary.pushed = await push_pending(db, account, adapter)
        except NotImplementedError:
            pass
        folders = await adapter.list_folders()
        for fs in folders:
            folder = await _upsert_folder(db, account, fs)
            raws = await adapter.fetch_new(
                fs.raw_name, since_uid=folder.last_synced_uid, limit=batch_size
            )
            summary.fetched += len(raws)
            max_uid = folder.last_synced_uid
            for raw in raws:
                if not raw.imap_uid:
                    summary.skipped += 1
                    continue
                outcome = await _store_one(db, account, folder, raw, now=now)
                if outcome == "inserted":
                    summary.inserted += 1
                else:
                    summary.updated += 1
                max_uid = max(max_uid, raw.imap_uid)
            folder.last_synced_uid = max_uid

            # 플래그 증분(CONDSTORE/fallback) — 미지원 어댑터(POP3)는 skip.
            try:
                changes, new_modseq = await adapter.fetch_flag_changes(
                    fs.raw_name, since_modseq=folder.highest_modseq
                )
                if changes:
                    skip = await _pending_flag_uids(db, account, folder)
                    summary.flag_synced += await _apply_flag_changes(
                        db, account, folder, changes, now=now, skip_uids=skip
                    )
                if new_modseq is not None:
                    folder.highest_modseq = new_modseq
            except NotImplementedError:
                pass

            # EXPUNGE 반영 — 서버에 없는 로컬 메일 표시.
            try:
                server_uids = await adapter.list_uids(fs.raw_name)
                summary.expunged += await _mark_expunged(
                    db, account, folder, server_uids, now=now
                )
            except NotImplementedError:
                pass

            await db.flush()
        run.status = "OK"
        account.last_ok_at = datetime.now(timezone.utc)
        account.last_error = None
        logger.info(
            "메일 동기화 완료 [%s] fetched=%d inserted=%d updated=%d skipped=%d",
            account.id,
            summary.fetched,
            summary.inserted,
            summary.updated,
            summary.skipped,
        )
    except EmailFetchError as exc:
        logger.warning("메일 동기화 실패 [%s]: %s", account.id, exc)
        summary.status = "FAILED"
        summary.error = str(exc)
        run.status = "FAILED"
        run.error_message = summary.error
        account.last_error = summary.error[:500]
    except Exception as exc:  # pragma: no cover
        logger.exception("메일 동기화 예외 [%s]", account.id)
        summary.status = "FAILED"
        summary.error = f"{type(exc).__name__}: {exc}"
        run.status = "FAILED"
        run.error_message = summary.error
        account.last_error = summary.error[:500]
    finally:
        try:
            await adapter.close()
        except Exception:  # pragma: no cover
            pass
        run.finished_at = datetime.now(timezone.utc)
        run.fetched_count = summary.fetched
        run.inserted_count = summary.inserted
        # 변경 = 내용 갱신 + 플래그 증분 + EXPUNGE 반영.
        run.updated_count = summary.updated + summary.flag_synced + summary.expunged
        run.pushed_count = summary.pushed
        run.skipped_count = summary.skipped
        account.last_sync_at = datetime.now(timezone.utc)
        await db.commit()

    return summary


async def run_one(
    db: AsyncSession,
    account_id: UUID,
    *,
    trigger_kind: str = "MANUAL",
    triggered_by: UUID | None = None,
) -> RunSummary:
    account = (
        await db.execute(select(EmailAccount).where(EmailAccount.id == account_id))
    ).scalar_one_or_none()
    if account is None:
        return RunSummary(account_id=account_id, status="SKIPPED", error="계정 없음")
    return await sync_account(
        db, account, trigger_kind=trigger_kind, triggered_by=triggered_by
    )


async def run_all(
    db: AsyncSession,
    *,
    trigger_kind: str = "SCHEDULED",
    triggered_by: UUID | None = None,
) -> list[RunSummary]:
    """활성 + sync_enabled 계정 전체 순차 동기화(스케줄러용)."""
    q = select(EmailAccount).where(
        EmailAccount.enabled.is_(True), EmailAccount.sync_enabled.is_(True)
    )
    accounts = (await db.execute(q)).scalars().all()
    results: list[RunSummary] = []
    for account in accounts:
        results.append(
            await sync_account(
                db, account, trigger_kind=trigger_kind, triggered_by=triggered_by
            )
        )
    return results
