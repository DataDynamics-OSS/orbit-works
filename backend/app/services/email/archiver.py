"""콜드 아카이빙 — 오래된 메일을 보관 검증 후 정리(설계 §7).

동작(계정별):
1. `received_at < now - retention_days` 인 미아카이브 메일 선정.
2. **보관 무결성 검증** — 저장된 .eml 의 sha256 이 `raw_sha256` 과 일치해야만 진행.
   불일치/누락은 건너뛰고 경고(데이터 손실 방지).
3. `is_archived=true`, (옵션) `keep_body_text=false` 면 본문 텍스트 비움(.eml 보존).
4. (opt-in) `cold_purge_server=true` 면 검증 통과분을 서버 Archive 폴더로 MOVE +
   `server_deleted` 표시. 기본은 서버 유지(복사 보관만).

파괴적 동작은 검증 통과 시에만. 한 계정 실패가 다른 계정을 막지 않는다.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Email, EmailAccount, EmailFolder
from app.services.email.base import AccountConn, EmailFetchError
from app.services.email.registry import ADAPTERS
from app.services.email.secrets import get_account_secrets
from app.services.storage import resolve_upload_path

logger = logging.getLogger(__name__)


@dataclass
class ArchiveSummary:
    account_id: UUID
    archived: int = 0
    purged: int = 0
    skipped: int = 0  # raw 누락 등 보관 불가 — 건너뜀
    failed: int = 0  # 무결성 검증 실패
    error: str | None = None


async def run_cold_archive(
    db: AsyncSession,
    account: EmailAccount,
    *,
    retention_days: int,
    keep_body_text: bool,
    cold_purge_server: bool,
) -> ArchiveSummary:
    summary = ArchiveSummary(account_id=account.id)
    if retention_days <= 0:
        return summary

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=retention_days)
    rows = (
        await db.execute(
            select(Email).where(
                Email.account_id == account.id,
                Email.is_archived.is_(False),
                Email.server_deleted.is_(False),
                Email.received_at < cutoff,
            )
        )
    ).scalars().all()
    if not rows:
        return summary

    # 폴더 raw_name 캐시(서버 정리용).
    folders: dict[UUID, str] = {}
    if cold_purge_server:
        for f in (
            await db.execute(
                select(EmailFolder).where(EmailFolder.account_id == account.id)
            )
        ).scalars():
            folders[f.id] = f.raw_name

    adapter = None
    if cold_purge_server:
        secrets = await get_account_secrets(db, account.tenant_id, account.id)
        cls = ADAPTERS.get(account.protocol)
        if cls is not None and secrets.get("password"):
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
            except EmailFetchError as exc:
                logger.warning("콜드 정리용 IMAP 접속 실패 [%s]: %s", account.id, exc)
                adapter = None

    try:
        for email in rows:
            # 1) 보관 무결성 검증.
            if not email.raw_path:
                summary.skipped += 1
                continue
            try:
                data = resolve_upload_path(email.raw_path).read_bytes()
            except OSError:
                logger.warning("콜드 아카이브 — .eml 없음 [%s]", email.id)
                summary.failed += 1
                continue
            if email.raw_sha256 and hashlib.sha256(data).hexdigest() != email.raw_sha256:
                logger.warning("콜드 아카이브 — sha256 불일치 [%s]", email.id)
                summary.failed += 1
                continue

            # 2) 로컬 아카이브 표시.
            email.is_archived = True
            email.archived_at = now
            if not keep_body_text:
                email.body_text = None
                email.body_html = None
            summary.archived += 1

            # 3) (opt-in) 서버 정리 — 검증 통과분만.
            if adapter is not None and email.folder_id and email.imap_uid:
                raw_name = folders.get(email.folder_id)
                if raw_name:
                    try:
                        await adapter.move(
                            raw_name, email.imap_uid, account.archive_folder or "Archive"
                        )
                        email.server_deleted = True
                        email.server_deleted_at = now
                        summary.purged += 1
                    except EmailFetchError as exc:
                        logger.warning(
                            "콜드 정리 MOVE 실패 [%s uid=%s]: %s",
                            email.id, email.imap_uid, exc,
                        )
    finally:
        if adapter is not None:
            try:
                await adapter.close()
            except Exception:  # pragma: no cover
                pass
        await db.commit()

    return summary


async def run_cold_archive_all(
    db: AsyncSession,
    *,
    retention_days: int,
    keep_body_text: bool,
    cold_purge_server: bool,
) -> list[ArchiveSummary]:
    """활성 계정 전체 콜드 아카이브(스케줄러용, tenant 컨텍스트 안에서 호출)."""
    accounts = (
        await db.execute(select(EmailAccount).where(EmailAccount.enabled.is_(True)))
    ).scalars().all()
    out: list[ArchiveSummary] = []
    for account in accounts:
        try:
            out.append(
                await run_cold_archive(
                    db,
                    account,
                    retention_days=retention_days,
                    keep_body_text=keep_body_text,
                    cold_purge_server=cold_purge_server,
                )
            )
        except Exception as exc:  # pragma: no cover
            logger.exception("콜드 아카이브 예외 [%s]", account.id)
            out.append(ArchiveSummary(account_id=account.id, error=str(exc)))
    return out
