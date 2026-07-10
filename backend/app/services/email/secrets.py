"""메일 계정 자격증명(비밀) 저장 — app_settings(section='email') JSONB.

설계 §8·§12: 계정 메타(host/port/user) 는 email_accounts 테이블, **비밀만** 여기.
기존 settings 메커니즘과 동일하게 Fernet 으로 암호화(`enc:` prefix) 저장하고,
응답엔 `***last4` 마스킹. 이 모듈 한 곳만 비밀 read/write 를 담당해 추후 변경(키 회전
등) 시 격리된다.

저장 구조 (AppSetting.value, tenant 별 row):
    {"accounts": {"<account_uuid>": {"password": "enc:...", "smtp_password": "enc:..."}}}
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.core.secrets_crypto import decrypt_secret, encrypt_secret
from app.models import AppSetting

_SECTION = "email"
_MASK_PREFIX = "***"


def mask_secret(plain: str) -> str:
    """평문(복호화된) 비밀 → `***last4` 마스킹."""
    if not plain:
        return ""
    if len(plain) <= 4:
        return _MASK_PREFIX
    return f"{_MASK_PREFIX}{plain[-4:]}"


def _is_masked_or_blank(value: str | None) -> bool:
    """PUT 시 '유지' 로 해석할 값 — 빈문자열/None/마스킹 접두."""
    return value is None or value == "" or value.startswith(_MASK_PREFIX)


async def _get_row(db: AsyncSession, tenant_id: UUID) -> AppSetting | None:
    q = select(AppSetting).where(
        AppSetting.section == _SECTION, AppSetting.tenant_id == tenant_id
    )
    return (await db.execute(q)).scalar_one_or_none()


async def get_account_secrets(
    db: AsyncSession, tenant_id: UUID, account_id: UUID
) -> dict[str, str]:
    """복호화된 {password, smtp_password} 반환. 없으면 빈 문자열."""
    row = await _get_row(db, tenant_id)
    accounts = (row.value or {}).get("accounts", {}) if row else {}
    rec = accounts.get(str(account_id), {})
    return {
        "password": decrypt_secret(rec.get("password", "")),
        "smtp_password": decrypt_secret(rec.get("smtp_password", "")),
    }


async def set_account_secrets(
    db: AsyncSession,
    tenant_id: UUID,
    account_id: UUID,
    *,
    password: str | None = None,
    smtp_password: str | None = None,
) -> None:
    """비밀 저장(암호화). 마스킹/빈값은 기존 값 유지. flush 까지만(commit 은 호출자)."""
    row = await _get_row(db, tenant_id)
    if row is None:
        row = AppSetting(tenant_id=tenant_id, section=_SECTION, value={"accounts": {}})
        db.add(row)
        await db.flush()
    value = dict(row.value or {})
    accounts = dict(value.get("accounts", {}))
    rec = dict(accounts.get(str(account_id), {}))

    if not _is_masked_or_blank(password):
        rec["password"] = encrypt_secret(password)
    if not _is_masked_or_blank(smtp_password):
        rec["smtp_password"] = encrypt_secret(smtp_password)

    accounts[str(account_id)] = rec
    value["accounts"] = accounts
    row.value = value
    flag_modified(row, "value")  # JSONB in-place 변경 감지
    await db.flush()


async def delete_account_secrets(
    db: AsyncSession, tenant_id: UUID, account_id: UUID
) -> None:
    """계정 삭제 시 비밀 정리."""
    row = await _get_row(db, tenant_id)
    if row is None:
        return
    value = dict(row.value or {})
    accounts = dict(value.get("accounts", {}))
    if str(account_id) in accounts:
        del accounts[str(account_id)]
        value["accounts"] = accounts
        row.value = value
        flag_modified(row, "value")
        await db.flush()
