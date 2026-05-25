"""휴가 유형 (LeaveType) — CRUD + 시드 일괄 등록.

권한: `leave_types.manage` (HR + ADMIN). 일반 사용자는 메뉴 미노출.

`/leave-types/seed` — 미등록 시 기본 19개 유형 (경조·공가·병가·연차·포상·출산·
무급·출장) 을 idempotent INSERT. 이미 같은 code 가 있으면 skip.
"""

from __future__ import annotations

import logging
import uuid as _uuid
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import LeaveType, User
from app.schemas.leave_type import (
    LeaveTypeCreate,
    LeaveTypeOut,
    LeaveTypeUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leave-types", tags=["leave-types"])


# 기본 시드 — code 는 ASCII 대문자/숫자/_ 로 구성. UI 표시명은 name.
# 사용자 요구사항 그대로 (반차만 HALF, 무급병가/무급휴가만 paid=False).
SEED_LEAVE_TYPES: list[dict] = [
    # 경조 (LIFE_EVENT)
    {"code": "FAMILY_WEDDING",    "name": "경조 - 결혼",           "category": "LIFE_EVENT",  "color": "#F59E0B", "max_days_per_year": 5, "requires_evidence": True,  "sort_order": 10},
    {"code": "FAMILY_FUNERAL",    "name": "경조 - 조의(사망)",      "category": "LIFE_EVENT",  "color": "#F59E0B", "max_days_per_year": 5, "requires_evidence": True,  "sort_order": 11},
    {"code": "FAMILY_70TH",       "name": "경조 - 칠순",           "category": "LIFE_EVENT",  "color": "#F59E0B", "max_days_per_year": 1, "requires_evidence": True,  "sort_order": 12},
    {"code": "FAMILY_60TH",       "name": "경조 - 회갑",           "category": "LIFE_EVENT",  "color": "#F59E0B", "max_days_per_year": 1, "requires_evidence": True,  "sort_order": 13},
    # 공가 (PUBLIC_DUTY) — 유급 + 연차 차감 X
    {"code": "PUBLIC_HEALTH_CHECK", "name": "공가 - 건강검진",      "category": "PUBLIC_DUTY", "color": "#8B5CF6", "requires_evidence": True,  "sort_order": 20},
    {"code": "PUBLIC_CIVIL_DEFENSE","name": "공가 - 민방위",        "category": "PUBLIC_DUTY", "color": "#8B5CF6", "requires_evidence": True,  "sort_order": 21},
    {"code": "PUBLIC_RESERVE_DUTY", "name": "공가 - 예비군",        "category": "PUBLIC_DUTY", "color": "#8B5CF6", "requires_evidence": True,  "sort_order": 22},
    # 병가 (SICK)
    {"code": "SICK_HEALTH",       "name": "병가 - 보건휴가",        "category": "SICK",        "color": "#EF4444", "sort_order": 30},
    {"code": "SICK_PAID",         "name": "병가 - 유급 병가",       "category": "SICK",        "color": "#EF4444", "requires_evidence": True,  "sort_order": 31},
    {"code": "SICK_UNPAID",       "name": "병가 - 무급 병가",       "category": "SICK",        "color": "#EF4444", "paid": False, "sort_order": 32},
    # 연차휴가 (ANNUAL) — 연차 차감
    {"code": "ANNUAL_FULL",       "name": "연차",                  "category": "ANNUAL",      "color": "#3B82F6", "deducts_annual": True,  "sort_order": 1},
    {"code": "ANNUAL_HALF_AM",    "name": "반차 (오전)",            "category": "ANNUAL",      "unit": "HALF", "color": "#3B82F6", "deducts_annual": True,  "sort_order": 2},
    {"code": "ANNUAL_HALF_PM",    "name": "반차 (오후)",            "category": "ANNUAL",      "unit": "HALF", "color": "#3B82F6", "deducts_annual": True,  "sort_order": 3},
    # 포상 (REWARD)
    {"code": "REWARD_TENURE_5Y",  "name": "포상 - 장기근속 5년",     "category": "REWARD",      "color": "#10B981", "sort_order": 40},
    {"code": "REWARD_TENURE_7Y",  "name": "포상 - 장기근속 7년",     "category": "REWARD",      "color": "#10B981", "sort_order": 41},
    {"code": "REWARD_TENURE_10Y", "name": "포상 - 장기근속 10년",    "category": "REWARD",      "color": "#10B981", "sort_order": 42},
    # 출산휴가
    {"code": "MATERNITY",         "name": "출산휴가",               "category": "LIFE_EVENT",  "color": "#F59E0B", "max_days_per_year": 90, "requires_evidence": True, "sort_order": 50},
    # 무급휴가
    {"code": "UNPAID_LEAVE",      "name": "무급휴가",               "category": "OTHER",       "color": "#6B7280", "paid": False, "sort_order": 60},
]


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[LeaveTypeOut])
async def list_leave_types(
    is_active: bool | None = None,
    category: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("leave_types.manage")),
):
    stmt = select(LeaveType).order_by(LeaveType.sort_order, LeaveType.created_at)
    if is_active is not None:
        stmt = stmt.where(LeaveType.is_active.is_(is_active))
    if category:
        stmt = stmt.where(LeaveType.category == category)
    return list((await db.execute(stmt)).scalars().all())


def _generate_code() -> str:
    """UI 에서 code 를 받지 않을 때 자동 생성. UNIQUE 충돌 가능성은 사실상 0."""
    return f"LEAVE_{_uuid.uuid4().hex[:10].upper()}"


@router.post(
    "", response_model=LeaveTypeOut, status_code=status.HTTP_201_CREATED
)
async def create_leave_type(
    payload: LeaveTypeCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("leave_types.manage")),
):
    data = payload.model_dump()
    # code 미지정 → 자동 생성. 시드 등 명시 입력 시에는 그대로 사용.
    if not data.get("code"):
        data["code"] = _generate_code()
    # code 중복 검사 — UNIQUE 제약이 있지만 친절 에러 메시지 위해 선체크.
    existing = (
        await db.execute(
            select(LeaveType).where(LeaveType.code == data["code"])
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"이미 존재하는 코드입니다: {data['code']}",
        )
    row = LeaveType(**data)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "휴가 유형 등록: id=%s code=%s name=%s (등록자=%s)",
        row.id,
        row.code,
        row.name,
        user.id,
    )
    return row


@router.get("/{leave_type_id}", response_model=LeaveTypeOut)
async def get_leave_type(
    leave_type_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("leave_types.manage")),
):
    row = (
        await db.execute(
            select(LeaveType).where(LeaveType.id == leave_type_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="휴가 유형을 찾을 수 없습니다.")
    return row


@router.patch("/{leave_type_id}", response_model=LeaveTypeOut)
async def update_leave_type(
    leave_type_id: UUID,
    payload: LeaveTypeUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("leave_types.manage")),
):
    row = (
        await db.execute(
            select(LeaveType).where(LeaveType.id == leave_type_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="휴가 유형을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    if "code" in data and data["code"] and data["code"] != row.code:
        # code 변경 시 중복 검사.
        clash = (
            await db.execute(
                select(LeaveType).where(LeaveType.code == data["code"])
            )
        ).scalar_one_or_none()
        if clash:
            raise HTTPException(
                status_code=409, detail=f"이미 존재하는 코드입니다: {data['code']}"
            )
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "휴가 유형 수정: id=%s 변경필드=%s (수정자=%s)",
        row.id,
        list(data.keys()),
        user.id,
    )
    return row


@router.delete("/{leave_type_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_leave_type(
    leave_type_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("leave_types.manage")),
):
    """soft delete — is_active=False. hard delete 는 향후 LeaveRequest FK 도입
    후 복잡해질 수 있어 일단 soft 만 제공."""
    row = (
        await db.execute(
            select(LeaveType).where(LeaveType.id == leave_type_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="휴가 유형을 찾을 수 없습니다.")
    row.is_active = False
    await db.commit()
    logger.warning(
        "휴가 유형 비활성화: id=%s code=%s (실행자=%s)",
        row.id,
        row.code,
        user.id,
    )


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------


@router.post("/seed", response_model=dict)
async def seed_leave_types(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("leave_types.manage")),
):
    """기본 휴가 유형 19개 일괄 등록 (idempotent — 같은 code 는 skip).

    응답: { inserted: int, skipped: int, codes: list[str] }
    """
    existing_codes = set(
        c
        for (c,) in (
            await db.execute(select(LeaveType.code))
        ).all()
    )
    inserted = 0
    skipped = 0
    skipped_codes: list[str] = []
    for spec in SEED_LEAVE_TYPES:
        if spec["code"] in existing_codes:
            skipped += 1
            skipped_codes.append(spec["code"])
            continue
        # 기본값 채움 — paid 명시 안 한 시드는 True, deducts_annual 명시 안 한 시드는 False.
        defaults = {
            "unit": "DAY",
            "deducts_annual": False,
            "paid": True,
            "requires_evidence": False,
            "is_active": True,
        }
        merged = {**defaults, **spec}
        db.add(LeaveType(**merged))
        inserted += 1
    await db.commit()
    logger.info(
        "휴가 유형 시드: inserted=%s skipped=%s (실행자=%s)",
        inserted,
        skipped,
        user.id,
    )
    return {
        "inserted": inserted,
        "skipped": skipped,
        "skipped_codes": skipped_codes,
    }
