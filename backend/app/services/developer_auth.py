"""Developer 기반 인증 · 비밀번호 생성 유틸.

- `find_or_create_user_for_developer`: developer ↔ users 행을 동기화해서
  세션 주체로 쓸 User 반환. FK 호환성을 위해 JWT sub 는 여전히 users.id 이다.
- `generate_temp_password`: 신규 임직원 등록 시 임시 비밀번호 생성.
- `notify_new_developer_password`: HR · ADMIN 에게 Slack 으로 초기 비번 전달.
"""

from __future__ import annotations

import logging
import secrets
import string
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models import Developer, User
from app.services.notify import notify_service

logger = logging.getLogger(__name__)


async def find_or_create_user_for_developer(
    db: AsyncSession, dev: Developer
) -> User:
    """developer 에 대응하는 users 행을 찾거나 생성 (세션 프록시).

    **이중 비밀번호 저장 방지**: 비밀번호 권위는 `developers.hashed_password`.
    proxy users 행은 FK 호환 용도만 가지므로 `hashed_password` 는 항상 빈
    문자열('') 로 유지해 인증 루트에서 사용될 여지를 차단한다.

    `mapped_developer_id` 는 admin 부트스트랩 전용이라 여기서 건드리지 않는다.

    - `users.email = dev.company_email` 매칭.
    - 없으면 신규 insert (role = security_role, 비번 '').
    - 존재하면 role/활성상태만 동기화. 과거 저장됐던 hashed_password 는
      빈 값으로 강제 초기화해 stale 비번으로 로그인될 가능성을 원천 차단.
    """
    if not dev.company_email:
        raise ValueError("developer.company_email 이 비어 있어 users 행을 만들 수 없습니다.")
    user = (
        await db.execute(select(User).where(User.email == dev.company_email))
    ).scalar_one_or_none()
    if user is None:
        user = User(
            email=dev.company_email,
            hashed_password="",
            name=dev.name,
            role=dev.security_role or "ETC",
            is_active=dev.status == "ACTIVE",
            tenant_id=getattr(dev, "tenant_id", None),
        )
        db.add(user)
        await db.flush()
    else:
        changed = False
        if user.hashed_password != "":
            user.hashed_password = ""  # 이중 저장 방지
            changed = True
        if dev.security_role and user.role != dev.security_role:
            user.role = dev.security_role
            changed = True
        if user.is_active != (dev.status == "ACTIVE"):
            user.is_active = dev.status == "ACTIVE"
            changed = True
        # tenant_id 동기화: developer 의 tenant 가 user 행보다 권위 있음.
        dev_tid = getattr(dev, "tenant_id", None)
        if dev_tid and user.tenant_id != dev_tid:
            user.tenant_id = dev_tid
            changed = True
        if changed:
            await db.flush()
    return user


_PW_ALPHABET = string.ascii_letters + string.digits + "!@#$%^*_-+="


def generate_temp_password(length: int = 12) -> str:
    """최소 1자리씩 대소문자·숫자·특수문자를 포함한 임시 비밀번호."""
    upper = secrets.choice(string.ascii_uppercase)
    lower = secrets.choice(string.ascii_lowercase)
    digit = secrets.choice(string.digits)
    special = secrets.choice("!@#$%^*_-+=")
    rest = [secrets.choice(_PW_ALPHABET) for _ in range(max(4, length - 4))]
    pwd = list(upper + lower + digit + special) + rest
    secrets.SystemRandom().shuffle(pwd)
    return "".join(pwd)


async def _hr_and_admin_emails(db: AsyncSession) -> list[str]:
    rows = list(
        (
            await db.execute(
                select(User.email).where(
                    User.is_active.is_(True), User.role.in_(("ADMIN", "HR"))
                )
            )
        ).scalars()
    )
    return [e for e in rows if e and "@" in e]


async def notify_new_developer_password(
    db: AsyncSession, dev: Developer, plain_password: str
) -> None:
    """HR + ADMIN 에게 신규 임직원 비밀번호를 Slack 알림."""
    from app.core.config import get_settings

    if not get_settings().slack.enabled:
        return
    emails = await _hr_and_admin_emails(db)
    if not emails:
        logger.warning(
            "신규 임직원 비번 Slack 미발송: HR/ADMIN 이메일 없음 (dev=%s)", dev.id
        )
        return
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🆕 신규 임직원 초기 비밀번호"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*이름*\n{dev.name}"},
                {"type": "mrkdwn", "text": f"*이메일*\n{dev.company_email or '-'}"},
                {"type": "mrkdwn", "text": f"*역할*\n{dev.security_role}"},
                {
                    "type": "mrkdwn",
                    "text": f"*초기 비밀번호*\n`{plain_password}` (생년월일 6자리)",
                },
            ],
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": (
                        "직원은 최초 로그인 시 *반드시 비밀번호를 변경* 해야 하며, "
                        "생년월일 6자리로는 재설정할 수 없습니다."
                    ),
                }
            ],
        },
    ]
    # developer.tenant_id 의 notify 설정으로 발송 — 그 회사의 HR/ADMIN 채널.
    await notify_service.send_for_tenant(
        dev.tenant_id,
        text=f"신규 임직원 초기 비밀번호: {dev.name}",
        user_emails=list(set(emails)),
        blocks=blocks,
        feature="developer_auth",
    )
