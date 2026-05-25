"""임직원 비상연락처 API (1:N, 전체 교체 패턴).

- `GET /developers/{dev_id}/emergency-contacts`  — 목록 (position ASC)
- `PUT /developers/{dev_id}/emergency-contacts`  — 전체 교체 (UI 가 보낸 list 로
  기존 row 제거 + 새로 add). 빈 entry (이름/관계/전화 모두 빈) 는 저장 X.

권한: 본인(`mapped_developer_id == dev_id`) 또는 ADMIN/HR/SUPER_ADMIN.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, has_feature
from app.core.database import get_db
from app.models import Developer, DeveloperEmergencyContact, User
from app.schemas.developer_emergency_contact import (
    EmergencyContactItem,
    EmergencyContactsList,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/developers/{dev_id}/emergency-contacts",
    tags=["developer-emergency-contacts"],
)


async def _ensure_can_access(db: AsyncSession, user: User, dev_id: UUID) -> None:
    """`employees.tab.emergency` 기능 권한 또는 본인 매핑이면 통과."""
    if user.mapped_developer_id is not None and user.mapped_developer_id == dev_id:
        return
    if await has_feature(db, user, "employees.tab.emergency"):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비상연락처 권한 없음")


async def _ensure_developer_exists(db: AsyncSession, dev_id: UUID) -> None:
    exists = (
        await db.execute(select(Developer.id).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="Developer not found")


def _to_item(row: DeveloperEmergencyContact) -> EmergencyContactItem:
    return EmergencyContactItem(
        name=row.name,
        relation=row.relation,
        phone=row.phone,
    )


@router.get("", response_model=list[EmergencyContactItem])
async def list_emergency_contacts(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_access(db, user, dev_id)
    rows = list(
        (
            await db.execute(
                select(DeveloperEmergencyContact)
                .where(DeveloperEmergencyContact.developer_id == dev_id)
                .order_by(DeveloperEmergencyContact.position.asc())
            )
        ).scalars()
    )
    return [_to_item(r) for r in rows]


@router.put("", response_model=list[EmergencyContactItem])
async def replace_emergency_contacts(
    dev_id: UUID,
    payload: EmergencyContactsList,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_can_access(db, user, dev_id)
    await _ensure_developer_exists(db, dev_id)

    # 기존 전부 제거 + 새 list 로 교체. position 은 list 인덱스.
    existing = list(
        (
            await db.execute(
                select(DeveloperEmergencyContact)
                .where(DeveloperEmergencyContact.developer_id == dev_id)
            )
        ).scalars()
    )
    for old in existing:
        await db.delete(old)
    await db.flush()

    saved: list[DeveloperEmergencyContact] = []
    for idx, item in enumerate(payload.items):
        # 이름/관계/전화 모두 비어 있으면 빈 슬롯 — 저장하지 않음.
        if not (item.name or item.relation or item.phone):
            continue
        row = DeveloperEmergencyContact(
            developer_id=dev_id,
            position=idx,
            name=(item.name or None),
            relation=(item.relation or None),
            phone=(item.phone or None),
        )
        db.add(row)
        saved.append(row)
    await db.commit()
    logger.info("비상연락처 교체: dev=%s 건수=%d (편집자=%s)", dev_id, len(saved), user.id)
    rows = list(
        (
            await db.execute(
                select(DeveloperEmergencyContact)
                .where(DeveloperEmergencyContact.developer_id == dev_id)
                .order_by(DeveloperEmergencyContact.position.asc())
            )
        ).scalars()
    )
    return [_to_item(r) for r in rows]
