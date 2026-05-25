"""계정과목 (account_codes) API — 수입·지출 항목 마스터 CRUD + 시드.

권한:
- 읽기/쓰기: ADMIN / HR (재무 관련 마스터). 그 외 역할은 메뉴 자체 비노출.
- 시드 가져오기는 ADMIN 만.

soft delete: `is_active=false`. 향후 budget_actuals 등과 FK 가 걸리면 hard
delete 는 제한 — 현재는 단순 삭제 허용 (P1 범위).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import AccountCode, User
from app.schemas.account_code import (
    AccountCodeCreate,
    AccountCodeOut,
    AccountCodeReorderItem,
    AccountCodeUpdate,
    SeedSummary,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/account-codes", tags=["account-codes"])


_SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "account_code_seeds.json"


def _require_admin_or_hr(user: User) -> None:
    if user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="권한 없음 (ADMIN/HR)")


@router.get("", response_model=list[AccountCodeOut])
async def list_codes(
    kind: str | None = None,
    category: str | None = None,
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    stmt = select(AccountCode)
    if kind:
        stmt = stmt.where(AccountCode.kind == kind)
    if category:
        stmt = stmt.where(AccountCode.category == category)
    if not include_inactive:
        stmt = stmt.where(AccountCode.is_active.is_(True))
    stmt = stmt.order_by(
        AccountCode.kind.asc(),
        AccountCode.category.asc(),
        AccountCode.sort_order.asc(),
        AccountCode.name.asc(),
    )
    rows = (await db.execute(stmt)).scalars().all()
    return rows


@router.post("", response_model=AccountCodeOut, status_code=201)
async def create_code(
    payload: AccountCodeCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = AccountCode(**payload.model_dump())
    db.add(row)
    try:
        await db.commit()
    except Exception as exc:  # uq_account_code 충돌 등
        await db.rollback()
        logger.warning(
            "계정과목 생성 실패: kind=%s category=%s name=%s err=%s (요청자=%s)",
            payload.kind, payload.category, payload.name, exc, user.id,
        )
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    logger.info(
        "계정과목 생성: id=%s kind=%s category=%s name=%s (등록자=%s)",
        row.id, row.kind, row.category, row.name, user.id,
    )
    return row


@router.patch("/{code_id}", response_model=AccountCodeOut)
async def update_code(
    code_id: UUID,
    payload: AccountCodeUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (
        await db.execute(select(AccountCode).where(AccountCode.id == code_id))
    ).scalar_one_or_none()
    if not row:
        logger.warning(
            "계정과목 PATCH 실패 (없음): id=%s (요청자=%s)", code_id, user.id
        )
        raise HTTPException(status_code=404, detail="계정과목을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.warning(
            "계정과목 수정 실패: id=%s err=%s (요청자=%s)",
            code_id, exc, user.id,
        )
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    logger.info(
        "계정과목 수정: id=%s fields=%s (요청자=%s)",
        row.id, list(data.keys()), user.id,
    )
    return row


@router.delete("/{code_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_code(
    code_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (
        await db.execute(select(AccountCode).where(AccountCode.id == code_id))
    ).scalar_one_or_none()
    if not row:
        logger.warning(
            "계정과목 삭제 실패 (없음): id=%s (요청자=%s)", code_id, user.id
        )
        raise HTTPException(status_code=404, detail="계정과목을 찾을 수 없습니다.")
    await db.delete(row)
    await db.commit()
    logger.warning(
        "계정과목 삭제: id=%s name=%s (요청자=%s)",
        code_id, row.name, user.id,
    )


@router.post("/reorder", response_model=list[AccountCodeOut])
async def reorder(
    items: list[AccountCodeReorderItem],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    if not items:
        return []
    ids = [it.id for it in items]
    rows = (
        await db.execute(select(AccountCode).where(AccountCode.id.in_(ids)))
    ).scalars().all()
    by_id = {r.id: r for r in rows}
    for it in items:
        r = by_id.get(it.id)
        if r:
            r.sort_order = it.sort_order
    await db.commit()
    return await list_codes(
        kind=None, category=None, include_inactive=True, db=db, user=user
    )


@router.post("/seed", response_model=SeedSummary)
async def seed(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """표준 한국 SME 수입·지출 항목 일괄 등록.

    이미 (kind, category, name) 중복은 INSERT 스킵.
    ADMIN 만 호출 가능.
    """
    if user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="ADMIN 만 시드를 가져올 수 있습니다.")

    if not _SEED_PATH.exists():
        raise HTTPException(status_code=500, detail="시드 파일이 없습니다.")
    data = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail="시드 파일 형식 오류.")

    # 기존 시드(v1) → v2 카테고리 자동 마이그레이션 — "정부지원금" 통합 카테고리를
    # R&D / 고용 / 수출 별로 분리. 항목 이름은 유지, 카테고리만 이동.
    # (kind, category, name) UNIQUE 와 충돌 가능성 X — 새 카테고리에 동일 이름이
    # 존재하지 않음 (시드에 별도 항목명만 추가).
    migrations = [
        ("INCOME", "정부지원금", "고용장려금",   "고용지원금"),
        ("INCOME", "정부지원금", "R&D 출연금",   "R&D 지원금"),
        ("INCOME", "정부지원금", "수출지원금",   "수출지원금"),
    ]
    for kind_, old_cat, name_, new_cat in migrations:
        await db.execute(
            update(AccountCode)
            .where(
                AccountCode.kind == kind_,
                AccountCode.category == old_cat,
                AccountCode.name == name_,
            )
            .values(category=new_cat)
        )

    # 현재 테넌트의 기존 (kind, category, name) 셋
    existing_rows = (
        await db.execute(
            select(AccountCode.kind, AccountCode.category, AccountCode.name)
        )
    ).all()
    existing = {(r[0], r[1], r[2]) for r in existing_rows}

    inserted = 0
    skipped = 0
    for item in data:
        key = (item.get("kind"), item.get("category"), item.get("name"))
        if key in existing:
            skipped += 1
            continue
        row = AccountCode(
            kind=item["kind"],
            category=item["category"],
            name=item["name"],
            description=item.get("description"),
            usage_guide=item.get("usage_guide"),
            account_code=item.get("account_code"),
            account_name=item.get("account_name"),
            is_pl=bool(item.get("is_pl", True)),
            sort_order=int(item.get("sort_order", 0)),
            is_active=True,
        )
        db.add(row)
        inserted += 1
    await db.commit()
    logger.info(
        "계정과목 시드 적용: 사용자=%s 신규=%d 스킵=%d / 전체=%d",
        user.id, inserted, skipped, len(data),
    )
    return SeedSummary(inserted=inserted, skipped=skipped, total=len(data))
