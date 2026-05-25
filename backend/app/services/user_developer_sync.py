"""User ↔ Developer 자동 매핑 helper.

배경:
  users.mapped_developer_id 가 NULL 이면 PERSONAL 목표·내 액션·공유받은
  회의록 등이 안 보임. 자동 매핑은 가입 시점(POST /users) 한 곳에서만
  동작했고, 그 외 경로(developer 가 나중에 생성됨, 이메일 변경, 직접
  SQL INSERT, 미로그인 사용자 등)는 사각지대였다.

  이 모듈은 4-layer 자동 매핑의 L1·L2·L3 helper 를 제공:

    L1  Developer 생성/수정 시 — propagate_developer_mapping()
    L2  User    생성/수정 시 — ensure_user_dev_mapping()
    L3  로그인 직후 (defensive) — ensure_user_dev_mapping()

원칙:
  * **이미 매핑된 user 는 변경 X** — 관리자 의도·기존 연결 보호.
  * 매칭 없으면 silent skip — 정상 흐름이므로 에러 X.
  * INFO logging — 매핑이 채워진 시점/이유 감사 로그로.
  * WARNING logging — 같은 이메일이 여러 developer 와 매칭되는 비정상
    케이스 (UNIQUE 제약 위반 사전 신호).
  * commit 책임은 호출자 — helper 는 변경만 가하고 flush·commit X.
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Developer, User

logger = logging.getLogger(__name__)


async def ensure_user_dev_mapping(db: AsyncSession, user: User) -> bool:
    """사용자의 mapped_developer_id 가 비어 있으면, 같은 이메일의 developer
    를 찾아 채운다.

    호출 시점:
      - POST /users (가입 시)
      - PATCH /users/{id} (이메일 변경 — 현재 schema 는 미지원이라 미사용)
      - POST /login (로그인 직후 defensive)

    반환: 새로 채워졌으면 True, 변경 없으면 False.
    """
    if user.mapped_developer_id is not None:
        return False
    # SUPER_ADMIN 은 의도적으로 NULL — tenant 소속 X. 건드리지 않는다.
    if user.role == "SUPER_ADMIN":
        return False
    email = (user.email or "").strip().lower()
    if not email:
        return False

    # tenant 동일 + 이메일 매칭. 같은 이메일이 여러 developer 에 존재하는
    # 비정상 상태에 대비해 .all() 로 가져와 1건이 아닐 경우 WARNING.
    stmt = select(Developer.id).where(
        Developer.tenant_id == user.tenant_id,
        or_(
            func.lower(Developer.company_email) == email,
            func.lower(Developer.personal_email) == email,
        ),
    )
    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        return False
    if len(rows) > 1:
        logger.warning(
            "사용자-임직원 자동 매핑: 동일 이메일에 여러 developer 매칭 — "
            "user_id=%s email=%s candidates=%s (첫 번째만 매핑)",
            user.id, email, rows,
        )
    user.mapped_developer_id = rows[0]
    logger.info(
        "사용자-임직원 자동 매핑: user_id=%s email=%s -> developer_id=%s",
        user.id, email, rows[0],
    )
    return True


async def propagate_developer_mapping(
    db: AsyncSession, developer: Developer
) -> int:
    """Developer 의 company_email / personal_email 을 가진 user 가 있으면
    그 user 의 mapped_developer_id 를 본 developer 로 채운다.

    호출 시점:
      - POST /developers (신규 등록)
      - PATCH /developers/{id} (company_email/personal_email 변경 시)

    반환: 새로 채워진 user 수.
    """
    emails: list[str] = []
    for raw in (developer.company_email, developer.personal_email):
        if raw:
            emails.append(raw.strip().lower())
    if not emails:
        return 0

    stmt = select(User).where(
        User.tenant_id == developer.tenant_id,
        User.mapped_developer_id.is_(None),
        User.role != "SUPER_ADMIN",
        func.lower(User.email).in_(emails),
    )
    users = (await db.execute(stmt)).scalars().all()
    if not users:
        return 0
    n = 0
    for u in users:
        u.mapped_developer_id = developer.id
        logger.info(
            "임직원-사용자 자동 매핑: developer_id=%s -> user_id=%s email=%s",
            developer.id, u.id, u.email,
        )
        n += 1
    return n
