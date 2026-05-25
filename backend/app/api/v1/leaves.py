"""연차 API.

PR1 범위:
- GET   /leaves/balance/me                            본인 잔여
- GET   /leaves/balance                               ADMIN — 전체/개인
- GET   /leaves/balances/missing                      ADMIN — 초기화 필요 연도/직원
- POST  /leaves/balances/initialize                   ADMIN — 연도 초기화 (dry_run)
- POST  /leaves/balances/accrue                       ADMIN — 월 개근 적립 (수동/배치)
- POST  /leaves/reward-grants                         ADMIN — 포상 부여
- GET   /leaves/reward-grants                         본인/ADMIN
- PATCH /leaves/reward-grants/{id}/revoke             ADMIN — 미사용분만 회수
- GET   /leaves/reset-history                         ADMIN

PR2 에서 확장: POST/PATCH/DELETE /leaves, /approve, /reject 등.
"""

from __future__ import annotations

import calendar
import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db, system_session
from app.models import (
    Developer,
    DeveloperApprover,
    Holiday,
    LeaveAccrual,
    LeaveBalance,
    LeaveRequest,
    LeaveRequestAllocation,
    LeaveResetHistory,
    LeaveRewardGrant,
    User,
)
from app.schemas.leave import (
    AccrualResponse,
    AllocationOut,
    InitializePreviewRow,
    InitializeRequest,
    InitializeResponse,
    LeaveBalanceMissingDetail,
    LeaveRequestCreate,
    LeaveRequestOut,
    LeaveRequestUpdate,
    MissingBalanceRow,
    MyBalanceOut,
    RejectRequest,
    RewardGrantCreate,
    RewardGrantOut,
    RewardGrantRevoke,
    RewardSummaryOut,
    StatutoryBalanceOut,
    TeamBalanceRow,
)
from app.services import leave_notify
from app.services.leave_allocation import (
    Allocation,
    RewardGrantSnapshot,
    StatutoryBalanceSnapshot,
    build_allocation_plan,
    split_days_by_year,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leaves", tags=["leaves"])


# ---------------------------------------------------------------------------
# 공통 헬퍼
# ---------------------------------------------------------------------------


async def _resolve_my_developer_id_or_none(
    db: AsyncSession, user: User
) -> UUID | None:
    stmt = select(Developer.id).where(
        Developer.status == "ACTIVE",
        (Developer.company_email == user.email) | (Developer.personal_email == user.email),
    )
    dev_id = (await db.execute(stmt)).scalars().first()
    return dev_id


async def _resolve_my_developer_id(db: AsyncSession, user: User) -> UUID:
    """로그인 사용자의 이메일을 Developer 의 email 필드와 매칭해 developer_id 를 찾는다.

    일치하는 임직원이 없으면 403.
    """
    stmt = select(Developer).where(
        Developer.status == "ACTIVE",
        (Developer.company_email == user.email) | (Developer.personal_email == user.email),
    )
    dev = (await db.execute(stmt)).scalars().first()
    if dev is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="현재 로그인 계정과 연결된 활성 임직원 레코드가 없습니다.",
        )
    return dev.id


def _tenure_months(hire_date: date | None, as_of: date) -> int | None:
    if hire_date is None:
        return None
    months = (as_of.year - hire_date.year) * 12 + (as_of.month - hire_date.month)
    if as_of.day < hire_date.day:
        months -= 1
    return max(0, months)


async def _sum_reward_remaining(
    db: AsyncSession, developer_id: UUID
) -> Decimal:
    result = await db.execute(
        select(func.coalesce(func.sum(LeaveRewardGrant.remaining_days), 0)).where(
            LeaveRewardGrant.developer_id == developer_id,
            LeaveRewardGrant.revoked_at.is_(None),
        )
    )
    return Decimal(str(result.scalar_one() or 0))


async def _load_reward_grants(
    db: AsyncSession, developer_id: UUID, include_revoked: bool = False
) -> list[LeaveRewardGrant]:
    stmt = select(LeaveRewardGrant).where(LeaveRewardGrant.developer_id == developer_id)
    if not include_revoked:
        stmt = stmt.where(LeaveRewardGrant.revoked_at.is_(None))
    stmt = stmt.order_by(LeaveRewardGrant.granted_at.asc())
    return list((await db.execute(stmt)).scalars())


async def _build_balance(
    db: AsyncSession, developer_id: UUID, year: int
) -> MyBalanceOut:
    row = (
        await db.execute(
            select(LeaveBalance).where(
                LeaveBalance.developer_id == developer_id,
                LeaveBalance.year == year,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        statutory = StatutoryBalanceOut(
            year=year,
            granted=Decimal("0.0"),
            used=Decimal("0.0"),
            pending=Decimal("0.0"),
            remaining=Decimal("0.0"),
            accrual_strategy="ANNUAL_15",
            expires_on=date(year, 12, 31),
            initialized_at=None,
        )
    else:
        remaining = row.granted_days - row.used_days - row.pending_days
        statutory = StatutoryBalanceOut(
            year=row.year,
            granted=row.granted_days,
            used=row.used_days,
            pending=row.pending_days,
            remaining=remaining,
            accrual_strategy=row.accrual_strategy,  # type: ignore[arg-type]
            expires_on=date(year, 12, 31),
            initialized_at=row.initialized_at,
        )

    grants = await _load_reward_grants(db, developer_id)
    reward_remaining = sum((g.remaining_days for g in grants), start=Decimal("0"))
    reward = RewardSummaryOut(
        remaining=reward_remaining,
        grants=[RewardGrantOut.model_validate(g, from_attributes=True) for g in grants],
    )

    # 본인의 지정 승인자 목록 (primary 먼저)
    approver_rows = list(
        (
            await db.execute(
                select(DeveloperApprover, User)
                .join(User, User.id == DeveloperApprover.approver_user_id)
                .where(DeveloperApprover.developer_id == developer_id)
                .order_by(
                    DeveloperApprover.is_primary.desc(),
                    DeveloperApprover.position.asc(),
                )
            )
        ).all()
    )
    approvers = [
        {
            "name": u.name or None,
            "email": u.email,
            "is_primary": a.is_primary,
        }
        for a, u in approver_rows
    ]

    return MyBalanceOut(
        year=year,
        statutory=statutory,
        reward=reward,
        total_remaining=statutory.remaining + reward.remaining,
        approvers=approvers,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# 잔여 조회
# ---------------------------------------------------------------------------


@router.get("/balance/me", response_model=MyBalanceOut)
async def get_my_balance(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    developer_id = await _resolve_my_developer_id(db, user)
    target_year = year or datetime.now(timezone.utc).year
    return await _build_balance(db, developer_id, target_year)


@router.get("/balance", response_model=MyBalanceOut)
async def get_balance(
    developer_id: UUID,
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    target_year = year or datetime.now(timezone.utc).year
    return await _build_balance(db, developer_id, target_year)


@router.get("/balances", response_model=list[TeamBalanceRow])
async def list_team_balances(
    year: int | None = None,
    employment_type: str | None = "FULL_TIME",
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """관리자 전체 보기 — 직원별 잔여 요약 일괄 반환.

    한 연도에 대해 활성 + 지정 고용형태(기본 FULL_TIME) 직원 전부의
    법정·포상 잔여와 PENDING 신청 수를 한 번에 돌려준다.
    """
    target_year = year or datetime.now(timezone.utc).year
    today = datetime.now(timezone.utc).date()

    dev_stmt = select(Developer).where(
        Developer.status == "ACTIVE",
        (Developer.resigned_date.is_(None)) | (Developer.resigned_date > today),
    )
    if employment_type:
        dev_stmt = dev_stmt.where(Developer.employment_type == employment_type)
    dev_stmt = dev_stmt.order_by(Developer.name.asc())
    devs = list((await db.execute(dev_stmt)).scalars())
    if not devs:
        return []

    ids = [d.id for d in devs]

    # 대상 연도 법정 balance 일괄
    bal_rows = {
        r.developer_id: r
        for r in (
            await db.execute(
                select(LeaveBalance).where(
                    LeaveBalance.developer_id.in_(ids),
                    LeaveBalance.year == target_year,
                )
            )
        ).scalars()
    }

    # 포상 잔여 합계 (revoked 제외)
    reward_sum_rows = list(
        (
            await db.execute(
                select(
                    LeaveRewardGrant.developer_id,
                    func.coalesce(func.sum(LeaveRewardGrant.remaining_days), 0),
                )
                .where(
                    LeaveRewardGrant.developer_id.in_(ids),
                    LeaveRewardGrant.revoked_at.is_(None),
                )
                .group_by(LeaveRewardGrant.developer_id)
            )
        ).all()
    )
    reward_map = {dev_id: Decimal(str(s or 0)) for dev_id, s in reward_sum_rows}

    # PENDING 건수
    pending_rows = list(
        (
            await db.execute(
                select(
                    LeaveRequest.developer_id,
                    func.count(LeaveRequest.id),
                )
                .where(
                    LeaveRequest.developer_id.in_(ids),
                    LeaveRequest.status == "PENDING",
                )
                .group_by(LeaveRequest.developer_id)
            )
        ).all()
    )
    pending_map = {dev_id: int(c) for dev_id, c in pending_rows}

    out: list[TeamBalanceRow] = []
    for d in devs:
        bal = bal_rows.get(d.id)
        if bal is None:
            stat_granted = stat_used = stat_pending = stat_remain = Decimal("0")
            initialized = False
            strategy = None
        else:
            stat_granted = Decimal(str(bal.granted_days))
            stat_used = Decimal(str(bal.used_days))
            stat_pending = Decimal(str(bal.pending_days))
            stat_remain = stat_granted - stat_used - stat_pending
            initialized = True
            strategy = bal.accrual_strategy
        reward_remain = reward_map.get(d.id, Decimal("0"))
        out.append(
            TeamBalanceRow(
                developer_id=d.id,
                name=d.name,
                tag=d.tag,
                employment_type=d.employment_type,
                hire_date=d.hire_date,
                initialized=initialized,
                accrual_strategy=strategy,  # type: ignore[arg-type]
                statutory_granted=stat_granted,
                statutory_used=stat_used,
                statutory_pending=stat_pending,
                statutory_remaining=stat_remain,
                reward_remaining=reward_remain,
                total_remaining=stat_remain + reward_remain,
                pending_request_count=pending_map.get(d.id, 0),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 초기화 / missing
# ---------------------------------------------------------------------------


def _first_full_month(hire_date: date) -> tuple[int, int]:
    """hire_date 가 속한 달이 '완전한 근무월' 이면 (year, month), 아니면 다음 달 반환.

    day == 1 이면 해당 월이 입사 첫날부터 시작 → 완전한 근무월로 간주.
    그 외엔 입사한 달은 미완성이므로 다음 달부터.
    """
    if hire_date.day == 1:
        return hire_date.year, hire_date.month
    if hire_date.month == 12:
        return hire_date.year + 1, 1
    return hire_date.year, hire_date.month + 1


async def _existing_lifetime_accruals(
    db: AsyncSession, developer_id: UUID
) -> int:
    """해당 직원의 leave_accruals 누적 row 수 (모든 연도 합산).

    근로기준법 60조 2항의 1년 미만 11일 상한이 lifetime 임을 반영.
    """
    res = await db.execute(
        select(func.count())
        .select_from(LeaveAccrual)
        .where(LeaveAccrual.developer_id == developer_id)
    )
    return int(res.scalar() or 0)


def _anniversary_in_year(hire_date: date | None, year: int) -> date | None:
    """대상 연도(year) 내의 입사 anniversary 일자. None 이면 anniversary 가
    그 해에 없거나 hire_date 미입력.

    윤년 hire(2024-02-29) → 비윤년 anniversary 는 02-28 로 fallback.
    """
    if hire_date is None:
        return None
    try:
        return date(year, hire_date.month, hire_date.day)
    except ValueError:
        # 2/29 hire 의 비윤년 anniversary 처리
        return date(year, hire_date.month, 28)


def _retroactive_accrual_months(
    hire_date: date | None,
    year: int,
    as_of: date,
    lifetime_cap_remaining: int = 11,
) -> list[tuple[int, int]]:
    """`year` 범위 안에서 오늘(as_of) 이전에 이미 종료된 완전한 근무월 목록.

    - 입사 이전 월은 제외.
    - 아직 월말이 지나지 않은 진행중 월 제외.
    - **만 1년 anniversary 가 그 해에 있으면 그 이후 월은 제외**
      (anniversary 시점부터 ANNUAL_15 로 전환되어야 하므로 monthly 적립 X).
    - lifetime 상한 11 적용 — 호출자가 기존 누적 수를 빼고 남은 cap 을 전달.
    """
    if hire_date is None:
        # hire_date 모름 → 1월부터 가능성 있는 모든 완료월 반환
        start_y, start_m = year, 1
    else:
        start_y, start_m = _first_full_month(hire_date)
    if start_y > year:
        return []
    first_month = start_m if start_y == year else 1

    # 만 1년 anniversary 가 그 해에 있으면 그 시점 이후 월은 누적 X.
    anniv = _anniversary_in_year(hire_date, year)

    out: list[tuple[int, int]] = []
    for m in range(first_month, 13):
        last_day = calendar.monthrange(year, m)[1]
        month_end = date(year, m, last_day)
        if month_end >= as_of:
            break
        # anniversary 가 이 월의 마지막 날 이전이면 → 그 이후 월은 monthly 적립 대상 아님.
        if anniv is not None and month_end >= anniv:
            break
        out.append((year, m))
    return out[: max(0, lifetime_cap_remaining)]


# 법정 최저 (근로기준법 60조) — 1~21년차 총 부여 일수.
# 회사가 더 후하게 부여 시 settings.leaves.annual_days_by_year 로 override.
_LEGAL_ANNUAL_DAYS_BY_YEAR: list[int] = [
    15, 15, 16, 16, 17, 17, 18, 18, 19, 19,
    20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25,
]


async def _annual_days_for(tenant_id, tenure_months: int) -> int:
    """근속 개월 → 총 부여 일수 (회사 정책 적용).

    - settings.leaves.annual_days_by_year 가 21개 정수 list 면 그대로 사용.
      - tenure 1년차 = index 0, 21년차+ = index 20.
    - 누락/오류 시 법정 최저 fallback.
    """
    from app.core.config import get_tenant_section

    cfg = await get_tenant_section(tenant_id, "leaves") if tenant_id else {}
    table = cfg.get("annual_days_by_year") if isinstance(cfg, dict) else None
    if not isinstance(table, list) or len(table) != 21:
        table = _LEGAL_ANNUAL_DAYS_BY_YEAR
    year_idx = max(0, min(20, (tenure_months // 12) - 1))
    try:
        return int(table[year_idx])
    except (ValueError, TypeError):
        return _LEGAL_ANNUAL_DAYS_BY_YEAR[year_idx]


async def _suggest_strategy(
    hire_date: date | None, year: int, tenant_id=None
) -> tuple[str, Decimal, int | None]:
    """
    정책:
    - hire_date 없음 → ANNUAL_15 가정 (안전 기본값, 일수는 1년차 기준)
    - 대상 연도 1/1 기준 근속 12개월 이상 → ANNUAL_15, 회사 정책 lookup 으로 일수 결정
      (근로기준법 60조 4항: 3년+ 가산. 회사 정책이 더 후하면 그 값 사용)
    - 미만 → MONTHLY_ACCRUAL, 0일 (월 배치가 쌓음)
    (전년도 출근율 80% 판정은 근태 데이터가 들어오기 전이라 여기서 일단 근속만 본다.)
    """
    reference = date(year, 1, 1)
    tenure = _tenure_months(hire_date, reference)
    if tenure is None or tenure >= 12:
        # tenure None 인 경우 1년차 (15) 적용. 그 외엔 회사 정책 lookup.
        days = await _annual_days_for(tenant_id, tenure if tenure is not None else 12)
        return "ANNUAL_15", Decimal(str(days)), tenure
    return "MONTHLY_ACCRUAL", Decimal("0.0"), tenure


async def _candidate_developers(
    db: AsyncSession, developer_ids: list[UUID] | None
) -> list[Developer]:
    today = datetime.now(timezone.utc).date()
    stmt = select(Developer).where(
        Developer.status == "ACTIVE",
        Developer.employment_type == "FULL_TIME",
        # 퇴사일이 없거나 오늘보다 미래 → 재직중으로 간주.
        (Developer.resigned_date.is_(None)) | (Developer.resigned_date > today),
    )
    if developer_ids:
        stmt = stmt.where(Developer.id.in_(developer_ids))
    stmt = stmt.order_by(Developer.name.asc())
    return list((await db.execute(stmt)).scalars())


@router.get("/balances/missing", response_model=list[MissingBalanceRow])
async def list_missing_balances(
    year: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    devs = await _candidate_developers(db, None)
    existing = set(
        (
            await db.execute(
                select(LeaveBalance.developer_id).where(LeaveBalance.year == year)
            )
        ).scalars()
    )
    out: list[MissingBalanceRow] = []
    reference = date(year, 1, 1)
    for d in devs:
        if d.id in existing:
            continue
        strategy, _granted, tenure = await _suggest_strategy(
            d.hire_date, year, admin.tenant_id
        )
        out.append(
            MissingBalanceRow(
                developer_id=d.id,
                name=d.name,
                tag=d.tag,
                hire_date=d.hire_date,
                tenure_months=tenure,
                suggested_strategy=strategy,  # type: ignore[arg-type]
            )
        )
    return out


@router.post("/balances/initialize", response_model=InitializeResponse)
async def initialize_balances(
    payload: InitializeRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    current_year = datetime.now(timezone.utc).year
    if payload.year < current_year:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{payload.year}년은 이미 지난 연도라 초기화할 수 없습니다. "
                f"{current_year}년 이후만 초기화 가능합니다."
            ),
        )
    devs = await _candidate_developers(
        db, payload.developer_ids if payload.developer_ids else None
    )

    existing = {
        r.developer_id: r
        for r in (
            await db.execute(
                select(LeaveBalance).where(LeaveBalance.year == payload.year)
            )
        ).scalars()
    }

    preview: list[InitializePreviewRow] = []
    to_create: list[
        tuple[Developer, str, Decimal, int | None, list[tuple[int, int]]]
    ] = []
    skipped = 0
    today = datetime.now(timezone.utc).date()
    for d in devs:
        if d.id in existing:
            skipped += 1
            continue
        strategy, granted, tenure = await _suggest_strategy(
            d.hire_date, payload.year, admin.tenant_id
        )
        # MONTHLY_ACCRUAL + 대상 연도가 이미 시작된 상태라면, 지금까지 이미
        # 지나간 완전한 근무월을 소급 적립. 단:
        #   - 만 1년 anniversary 가 그 해에 있으면 anniversary 이후 월은 제외
        #   - lifetime 11 cap (다른 연도 leave_accruals 합산) 차감 후 잔여 cap 만큼
        retro: list[tuple[int, int]] = []
        if strategy == "MONTHLY_ACCRUAL" and payload.year <= today.year:
            existing_lifetime = await _existing_lifetime_accruals(db, d.id)
            remaining_cap = max(0, 11 - existing_lifetime)
            retro = _retroactive_accrual_months(
                d.hire_date, payload.year, today, lifetime_cap_remaining=remaining_cap
            )
            granted = Decimal(str(len(retro)))
        preview.append(
            InitializePreviewRow(
                developer_id=d.id,
                name=d.name,
                tag=d.tag,
                hire_date=d.hire_date,
                tenure_months=tenure,
                prev_attendance_rate=None,
                suggested_strategy=strategy,  # type: ignore[arg-type]
                suggested_granted_days=granted,
            )
        )
        to_create.append((d, strategy, granted, tenure, retro))

    initialized = 0
    if not payload.dry_run:
        now = datetime.now(timezone.utc)
        for d, strategy, granted, _tenure, retro in to_create:
            db.add(
                LeaveBalance(
                    developer_id=d.id,
                    year=payload.year,
                    granted_days=granted,
                    used_days=Decimal("0.0"),
                    pending_days=Decimal("0.0"),
                    accrual_strategy=strategy,
                    initialized_at=now,
                    initialized_by=admin.id,
                )
            )
            # 소급 적립 — 입사 후 완료된 월별로 leave_accruals row 생성.
            for (ry, rm) in retro:
                db.add(
                    LeaveAccrual(
                        developer_id=d.id,
                        year=ry,
                        month=rm,
                        days=Decimal("1.0"),
                        reason="RETROACTIVE_INITIAL",
                    )
                )
            db.add(
                LeaveResetHistory(
                    year=payload.year,
                    developer_id=d.id,
                    strategy=strategy,
                    granted_days=granted,
                    reset_by=admin.id,
                    note=payload.note,
                )
            )
            initialized += 1
        await db.commit()
        logger.info(
            "연차 초기화: year=%s 초기화=%d skipped=%d admin=%s",
            payload.year,
            initialized,
            skipped,
            admin.id,
        )

    return InitializeResponse(
        year=payload.year,
        dry_run=payload.dry_run,
        preview=preview,
        initialized_count=initialized,
        skipped_count=skipped,
    )


# ---------------------------------------------------------------------------
# 월 개근 적립
# ---------------------------------------------------------------------------


@router.post("/balances/catchup")
async def catchup_monthly_accrual(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """MONTHLY_ACCRUAL 직원에 대해 **오늘까지 완료된 모든 근무월**을 일괄 보정.

    - 입사 월 이전은 skip.
    - 이미 `leave_accruals` row 가 있는 월은 skip (중복 방지).
    - **lifetime 11일 상한** (모든 연도 leave_accruals 합산) 도달 시 skip.
    - 만 1년 anniversary 이후 월은 _retroactive_accrual_months 가 자동 제외.

    매월 말 수동 누르는 운영 부담을 덜기 위한 catch-up 헬퍼.
    """
    target_year = year or datetime.now(timezone.utc).year
    today = datetime.now(timezone.utc).date()

    balances = list(
        (
            await db.execute(
                select(LeaveBalance).where(
                    LeaveBalance.year == target_year,
                    LeaveBalance.accrual_strategy == "MONTHLY_ACCRUAL",
                )
            )
        ).scalars()
    )
    if not balances:
        return {
            "year": target_year,
            "added_rows": 0,
            "per_developer": {},
        }

    dev_ids = [b.developer_id for b in balances]
    hires = {
        d.id: d.hire_date
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
        ).scalars()
    }
    existing_map: dict[UUID, set[int]] = {}
    for row in (
        await db.execute(
            select(LeaveAccrual.developer_id, LeaveAccrual.month).where(
                LeaveAccrual.developer_id.in_(dev_ids),
                LeaveAccrual.year == target_year,
            )
        )
    ).all():
        existing_map.setdefault(row[0], set()).add(row[1])

    # lifetime accrual 누적 (모든 연도 합산) — 11 cap 의 lifetime 적용을 위해 사전 집계.
    lifetime_map: dict[UUID, int] = {}
    for row in (
        await db.execute(
            select(LeaveAccrual.developer_id, func.count())
            .where(LeaveAccrual.developer_id.in_(dev_ids))
            .group_by(LeaveAccrual.developer_id)
        )
    ).all():
        lifetime_map[row[0]] = int(row[1] or 0)

    per_dev: dict[str, int] = {}
    total_added = 0
    for bal in balances:
        hire_d = hires.get(bal.developer_id)
        existing_lifetime = lifetime_map.get(bal.developer_id, 0)
        remaining_cap = max(0, 11 - existing_lifetime)
        needed = _retroactive_accrual_months(
            hire_d, target_year, today, lifetime_cap_remaining=remaining_cap
        )
        already = existing_map.get(bal.developer_id, set())
        added_here = 0
        for (y, m) in needed:
            if m in already:
                continue
            # lifetime 11 상한 — 다른 연도 누적 + 현재 추가 합계.
            if existing_lifetime + added_here >= 11:
                break
            db.add(
                LeaveAccrual(
                    developer_id=bal.developer_id,
                    year=y,
                    month=m,
                    days=Decimal("1.0"),
                    reason="CATCHUP",
                )
            )
            bal.granted_days = Decimal(str(bal.granted_days)) + Decimal("1.0")
            added_here += 1
        if added_here > 0:
            per_dev[str(bal.developer_id)] = added_here
            total_added += added_here

    await db.commit()
    logger.info(
        "월 적립 catch-up: year=%s added_rows=%d 대상=%d admin=%s",
        target_year,
        total_added,
        len(per_dev),
        admin.id,
    )
    return {
        "year": target_year,
        "added_rows": total_added,
        "per_developer": per_dev,
    }


@router.delete("/balances/all")
async def delete_all_balances(
    year: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """선택 연도의 모든 leave_balance + leave_accrual 일괄 삭제.

    - leave_balances 삭제 → CASCADE 로 leave_request_allocations 도 정리
    - leave_accruals 의 year 일치 row 도 삭제
    - leave_requests / leave_reward_grants 는 건드리지 않음 (별도 lifecycle)
    - 위험한 동작 — 프론트엔드에서 "모든 연차 삭제" 입력 확인 후 호출.
    """
    # accruals 먼저 (FK 없으니 순서 무관하지만 명시적으로).
    res_acc = await db.execute(
        select(LeaveAccrual).where(LeaveAccrual.year == year)
    )
    accruals = list(res_acc.scalars())
    for a in accruals:
        await db.delete(a)

    res_bal = await db.execute(
        select(LeaveBalance).where(LeaveBalance.year == year)
    )
    balances = list(res_bal.scalars())
    for b in balances:
        await db.delete(b)

    await db.commit()
    logger.warning(
        "연차 전체 삭제: year=%s balances=%d accruals=%d 삭제자=%s",
        year, len(balances), len(accruals), admin.id,
    )
    return {
        "year": year,
        "deleted_balances": len(balances),
        "deleted_accruals": len(accruals),
    }


@router.patch("/balances/used-days")
async def bulk_update_used_days(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """ADMIN — 연차 사용 일수 일괄 직접 수정 (override).

    payload: {year: int, items: [{developer_id, used_days}]}

    - 0.5 단위 + 0 이상 검증
    - 일치하는 leave_balance row 의 used_days 만 변경 (다른 컬럼 손대지 X)
    - 변경되지 않은 항목은 호출자가 보내지 않으므로 noop
    - 모든 변경은 logger.warning + LeaveResetHistory(strategy='USED_OVERRIDE') 로 감사
    """
    year = int(payload.get("year") or 0)
    items = payload.get("items") or []
    if not year or not isinstance(items, list):
        raise HTTPException(status_code=400, detail="year + items 필수.")

    # 0.5 단위 검증.
    parsed: list[tuple[UUID, Decimal]] = []
    for it in items:
        try:
            dev_id = UUID(str(it["developer_id"]))
            used = Decimal(str(it["used_days"]))
        except Exception:
            raise HTTPException(status_code=400, detail=f"잘못된 항목: {it}")
        if used < 0:
            raise HTTPException(
                status_code=400,
                detail=f"{dev_id}: 사용 일수는 0 이상이어야 합니다.",
            )
        if (used * 2) % 1 != 0:
            raise HTTPException(
                status_code=400,
                detail=f"{dev_id}: 0.5 단위만 입력 가능합니다.",
            )
        parsed.append((dev_id, used))

    updated = 0
    for dev_id, new_used in parsed:
        bal = (
            await db.execute(
                select(LeaveBalance).where(
                    LeaveBalance.developer_id == dev_id,
                    LeaveBalance.year == year,
                )
            )
        ).scalar_one_or_none()
        if bal is None:
            continue
        old_used = Decimal(str(bal.used_days))
        if old_used == new_used:
            continue
        bal.used_days = new_used
        db.add(
            LeaveResetHistory(
                year=year,
                developer_id=dev_id,
                strategy="USED_OVERRIDE",
                granted_days=new_used,  # 새 used_days 값을 기록 (감사용)
                reset_by=admin.id,
                note=f"사용 일수 직접 수정: {old_used} → {new_used}",
            )
        )
        updated += 1
        logger.warning(
            "연차 사용 직접 수정: dev=%s year=%s %s → %s admin=%s",
            dev_id, year, old_used, new_used, admin.id,
        )

    await db.commit()
    return {"year": year, "updated": updated, "submitted": len(parsed)}


# ---------------------------------------------------------------------------
# 만 1년 anniversary 자동 전환 — daily 01:00 cron 에서 호출.
# MONTHLY_ACCRUAL 직원이 입사 anniversary 에 도달하면 ANNUAL_15 로 전환하고
# 회사 정책 lookup 의 일수를 granted_days 에 가산.
# ---------------------------------------------------------------------------


async def run_anniversary_transition(*, as_of: date | None = None) -> dict:
    """오늘이 만 1년 anniversary 인 MONTHLY_ACCRUAL row 를 ANNUAL_15 로 전환.

    - leave_balance.year 가 anniversary 해와 일치하는 row 만 대상
    - granted_days 는 추가 (덮어쓰지 않음) — 이미 누적된 monthly 일수 보존
    - 다른 연도 row 는 손대지 않음
    """
    from app.core.tenant_context import set_current_tenant_id
    from app.core.database import system_session
    from app.models import Tenant

    today = as_of or date.today()
    transitioned = 0
    per_tenant: list[dict] = []

    async with system_session() as db:
        tenants = list(
            (
                await db.execute(
                    select(Tenant.id, Tenant.slug).where(Tenant.is_active.is_(True))
                )
            ).all()
        )

    for tid, slug in tenants:
        set_current_tenant_id(tid)
        count = 0
        async with system_session(tenant_id=str(tid)) as db:
            balances = list(
                (
                    await db.execute(
                        select(LeaveBalance, Developer)
                        .join(Developer, Developer.id == LeaveBalance.developer_id)
                        .where(
                            LeaveBalance.year == today.year,
                            LeaveBalance.accrual_strategy == "MONTHLY_ACCRUAL",
                            Developer.hire_date.is_not(None),
                            Developer.status == "ACTIVE",
                        )
                    )
                ).all()
            )
            for bal, dev in balances:
                anniv = _anniversary_in_year(dev.hire_date, today.year)
                if anniv is None or anniv > today:
                    continue
                # 만 1년 도달 — ANNUAL 전환.
                tenure = _tenure_months(dev.hire_date, today) or 12
                days = await _annual_days_for(tid, tenure)
                bal.accrual_strategy = "ANNUAL_15"
                bal.granted_days = Decimal(str(bal.granted_days)) + Decimal(str(days))
                db.add(
                    LeaveResetHistory(
                        year=today.year,
                        developer_id=dev.id,
                        strategy="ANNUAL_15",
                        granted_days=Decimal(str(days)),
                        reset_by=None,
                        note=f"만 {tenure // 12}년 도달 자동 전환 ({anniv})",
                    )
                )
                count += 1
            await db.commit()
        if count:
            per_tenant.append({"tenant": slug, "count": count})
        transitioned += count
        if count:
            logger.info(
                "만 1년 anniversary 전환 tenant=%s 인원=%d", slug, count
            )

    return {"as_of": today.isoformat(), "transitioned": transitioned, "tenants": per_tenant}


@router.post("/balances/anniversary-transition")
async def manual_anniversary_transition(
    as_of: date | None = None,
    _: User = Depends(require_admin),
):
    """ADMIN 수동 트리거 — 평소엔 daily 01:00 cron 이 자동 실행.

    `as_of` 미지정 시 오늘 날짜. 테스트 / 누락 보정에 사용.
    """
    return await run_anniversary_transition(as_of=as_of)


@router.post("/balances/accrue", response_model=AccrualResponse)
async def accrue_monthly(
    year: int,
    month: int,
    developer_ids: list[UUID] | None = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """월 개근 1일 적립.

    현재는 단순화 버전: 출근 데이터가 없으므로 "호출 받은 month 에 대해
    MONTHLY_ACCRUAL 인 row 에 1일 추가" 로 동작. 향후 attendance 배치에서
    실제 개근 여부를 계산해 본 엔드포인트를 호출하도록 변경될 예정.

    상한(11일) 체크: 모든 연도 합산 leave_accruals row count >= 11 이면 skip
    (lifetime cap — 1년 미만 monthly 누적의 법정 상한).
    또한 만 1년 anniversary 이후 월에는 적립 안 함.
    """
    if month < 1 or month > 12:
        raise HTTPException(status_code=400, detail="month 는 1~12 사이여야 합니다.")

    bal_stmt = select(LeaveBalance).where(
        LeaveBalance.year == year,
        LeaveBalance.accrual_strategy == "MONTHLY_ACCRUAL",
    )
    if developer_ids:
        bal_stmt = bal_stmt.where(LeaveBalance.developer_id.in_(developer_ids))
    balances = list((await db.execute(bal_stmt)).scalars())

    added = skipped_cap = skipped_exists = skipped_strategy = 0

    # 입사 월 이전인지 판정하기 위해 hire_date 일괄 로딩
    dev_ids = [b.developer_id for b in balances]
    hires = (
        {
            d.id: d.hire_date
            for d in (
                await db.execute(
                    select(Developer).where(Developer.id.in_(dev_ids))
                )
            ).scalars()
        }
        if dev_ids
        else {}
    )

    for bal in balances:
        # 입사 이전 월에는 적립하지 않음
        hire_d = hires.get(bal.developer_id)
        if hire_d is not None:
            first_y, first_m = _first_full_month(hire_d)
            if (year, month) < (first_y, first_m):
                skipped_strategy += 1
                continue
            # 만 1년 anniversary 이후 월은 적립 X (ANNUAL 로 전환되어야 함).
            anniv = _anniversary_in_year(hire_d, year)
            if anniv is not None:
                last_day = calendar.monthrange(year, month)[1]
                if date(year, month, last_day) >= anniv:
                    skipped_strategy += 1
                    continue

        # 이미 같은 month 적립 있는지
        has = (
            await db.execute(
                select(LeaveAccrual.id).where(
                    LeaveAccrual.developer_id == bal.developer_id,
                    LeaveAccrual.year == year,
                    LeaveAccrual.month == month,
                )
            )
        ).scalar_one_or_none()
        if has is not None:
            skipped_exists += 1
            continue

        # 상한 11일 체크 — lifetime (모든 연도 합산)
        count = (
            await db.execute(
                select(func.count(LeaveAccrual.id)).where(
                    LeaveAccrual.developer_id == bal.developer_id,
                )
            )
        ).scalar_one()
        if count >= 11:
            skipped_cap += 1
            continue

        db.add(
            LeaveAccrual(
                developer_id=bal.developer_id,
                year=year,
                month=month,
                days=Decimal("1.0"),
                reason="PERFECT_ATTENDANCE",
            )
        )
        bal.granted_days = bal.granted_days + Decimal("1.0")
        added += 1

    await db.commit()
    logger.info(
        "월 개근 적립: year=%s month=%s added=%d skipped_cap=%d admin=%s",
        year,
        month,
        added,
        skipped_cap,
        admin.id,
    )
    return AccrualResponse(
        year=year,
        month=month,
        added=added,
        skipped_capped=skipped_cap,
        skipped_strategy=skipped_strategy,
        skipped_existing=skipped_exists,
    )


# ---------------------------------------------------------------------------
# 포상 연차
# ---------------------------------------------------------------------------


@router.post(
    "/reward-grants",
    response_model=RewardGrantOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_reward_grant(
    payload: RewardGrantCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    dev = (
        await db.execute(select(Developer).where(Developer.id == payload.developer_id))
    ).scalar_one_or_none()
    if dev is None or dev.status != "ACTIVE":
        raise HTTPException(status_code=404, detail="활성 임직원을 찾을 수 없습니다.")

    grant = LeaveRewardGrant(
        developer_id=dev.id,
        granted_days=payload.granted_days,
        remaining_days=payload.granted_days,
        reason=payload.reason,
        granted_by=admin.id,
    )
    db.add(grant)
    await db.commit()
    await db.refresh(grant)
    logger.info(
        "포상 연차 부여: id=%s dev=%s days=%s admin=%s reason=%s",
        grant.id,
        dev.id,
        payload.granted_days,
        admin.id,
        payload.reason,
    )
    return RewardGrantOut.model_validate(grant, from_attributes=True)


@router.get("/reward-grants", response_model=list[RewardGrantOut])
async def list_reward_grants(
    developer_id: UUID | None = None,
    include_revoked: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # 일반 사용자는 본인만 조회 가능. ADMIN 은 developer_id 지정 or 전체.
    if user.role != "ADMIN":
        target = await _resolve_my_developer_id(db, user)
        if developer_id is not None and developer_id != target:
            raise HTTPException(status_code=403, detail="본인만 조회할 수 있습니다.")
        developer_id = target

    stmt = select(LeaveRewardGrant)
    if developer_id is not None:
        stmt = stmt.where(LeaveRewardGrant.developer_id == developer_id)
    if not include_revoked:
        stmt = stmt.where(LeaveRewardGrant.revoked_at.is_(None))
    stmt = stmt.order_by(LeaveRewardGrant.granted_at.asc())
    rows = list((await db.execute(stmt)).scalars())
    return [RewardGrantOut.model_validate(r, from_attributes=True) for r in rows]


@router.patch("/reward-grants/{grant_id}/revoke", response_model=RewardGrantOut)
async def revoke_reward_grant(
    grant_id: UUID,
    payload: RewardGrantRevoke,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    row = (
        await db.execute(
            select(LeaveRewardGrant).where(LeaveRewardGrant.id == grant_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="포상 연차를 찾을 수 없습니다.")
    if row.revoked_at is not None:
        raise HTTPException(status_code=400, detail="이미 회수된 포상입니다.")
    used = row.granted_days - row.remaining_days
    # 이미 사용된 일수는 회수 불가 → remaining_days 만 0 으로 만들고 revoked 표식.
    row.remaining_days = Decimal("0")
    row.revoked_at = datetime.now(timezone.utc)
    row.revoked_by = admin.id
    row.revoked_reason = payload.reason
    await db.commit()
    await db.refresh(row)
    logger.warning(
        "포상 연차 회수: id=%s dev=%s 사용=%s 회수=%s admin=%s",
        row.id,
        row.developer_id,
        used,
        row.granted_days - used,
        admin.id,
    )
    return RewardGrantOut.model_validate(row, from_attributes=True)


# ---------------------------------------------------------------------------
# 초기화 감사
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 신청 / 승인 — PR2
# ---------------------------------------------------------------------------


async def _load_holidays(db: AsyncSession, years: list[int]) -> set[date]:
    """연차 차감용 — 진짜 휴일(STATUTORY/TEMPORARY/COMPANY)만.

    EVENT_PUBLIC / EVENT_PRIVATE 는 캘린더 일정이라 정상 근무일 → 차감.
    """
    if not years:
        return set()
    rows = list(
        (
            await db.execute(
                select(Holiday.date).where(
                    Holiday.date.between(
                        date(min(years), 1, 1), date(max(years), 12, 31)
                    ),
                    Holiday.type.in_(("STATUTORY", "TEMPORARY", "COMPANY")),
                )
            )
        ).scalars()
    )
    return set(rows)


async def _load_balance_snapshots(
    db: AsyncSession, developer_id: UUID, years: list[int]
) -> dict[int, StatutoryBalanceSnapshot]:
    if not years:
        return {}
    rows = list(
        (
            await db.execute(
                select(LeaveBalance).where(
                    LeaveBalance.developer_id == developer_id,
                    LeaveBalance.year.in_(years),
                )
            )
        ).scalars()
    )
    return {
        r.year: StatutoryBalanceSnapshot(
            year=r.year,
            granted=Decimal(str(r.granted_days)),
            used=Decimal(str(r.used_days)),
            pending=Decimal(str(r.pending_days)),
        )
        for r in rows
    }


async def _load_reward_snapshots(
    db: AsyncSession, developer_id: UUID
) -> list[RewardGrantSnapshot]:
    grants = await _load_reward_grants(db, developer_id, include_revoked=False)
    return [
        RewardGrantSnapshot(
            id=g.id,
            remaining=Decimal(str(g.remaining_days)),
            granted_at_key=g.granted_at,
        )
        for g in grants
    ]


def _raise_missing_balance(missing: list[int]) -> None:
    year_text = ", ".join(f"{y}년" for y in sorted(missing))
    detail = (
        f"{year_text} 연차 잔여가 아직 초기화되지 않아 신청할 수 없습니다. "
        "관리자에게 해당 연도 초기화 요청 후 다시 시도해 주세요."
    )
    body = LeaveBalanceMissingDetail(detail=detail, missing_years=sorted(missing))
    raise HTTPException(status_code=409, detail=body.model_dump())


async def _serialize_request(
    row: LeaveRequest,
    dev_name: str | None,
    dev_tag: str | None = None,
) -> LeaveRequestOut:
    return LeaveRequestOut(
        id=row.id,
        developer_id=row.developer_id,
        developer_name=dev_name,
        developer_tag=dev_tag,
        requester_user_id=row.requester_user_id,
        leave_type=row.leave_type,  # type: ignore[arg-type]
        half_kind=row.half_kind,  # type: ignore[arg-type]
        category=row.category,
        start_date=row.start_date,
        end_date=row.end_date,
        days_total=row.days_total,
        status=row.status,  # type: ignore[arg-type]
        reason=row.reason,
        evidence_path=row.evidence_path,
        approver_user_id=row.approver_user_id,
        approved_at=row.approved_at,
        rejected_reason=row.rejected_reason,
        allocations=[
            AllocationOut.model_validate(a, from_attributes=True)
            for a in row.allocations
        ],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _apply_allocations(
    db: AsyncSession,
    request_row: LeaveRequest,
    allocations: list[Allocation],
) -> None:
    """DB 차감 반영 — pending_days ↑, reward remaining ↓."""
    bal_cache: dict[int, LeaveBalance] = {}
    grant_cache: dict[UUID, LeaveRewardGrant] = {}
    for a in allocations:
        db.add(
            LeaveRequestAllocation(
                request_id=request_row.id,
                source_type=a.source_type,
                year=a.year,
                grant_id=a.grant_id,
                days=a.days,
            )
        )
        if a.source_type == "STATUTORY":
            assert a.year is not None
            bal = bal_cache.get(a.year)
            if bal is None:
                bal = (
                    await db.execute(
                        select(LeaveBalance).where(
                            LeaveBalance.developer_id == request_row.developer_id,
                            LeaveBalance.year == a.year,
                        )
                    )
                ).scalar_one()
                bal_cache[a.year] = bal
            bal.pending_days = Decimal(str(bal.pending_days)) + a.days
        else:
            assert a.grant_id is not None
            grant = grant_cache.get(a.grant_id)
            if grant is None:
                grant = (
                    await db.execute(
                        select(LeaveRewardGrant).where(
                            LeaveRewardGrant.id == a.grant_id
                        )
                    )
                ).scalar_one()
                grant_cache[a.grant_id] = grant
            grant.remaining_days = Decimal(str(grant.remaining_days)) - a.days


async def _revert_allocations(
    db: AsyncSession, row: LeaveRequest, *, from_status: str
) -> None:
    """신청 취소/반려 시 allocation 을 반대로 되돌린다.

    from_status=PENDING  → balance.pending -= days, grant.remaining += days
    from_status=APPROVED → balance.used -= days,    grant.remaining += days
    """
    bal_cache: dict[int, LeaveBalance] = {}
    grant_cache: dict[UUID, LeaveRewardGrant] = {}
    for a in row.allocations:
        if a.source_type == "STATUTORY":
            assert a.year is not None
            bal = bal_cache.get(a.year)
            if bal is None:
                bal = (
                    await db.execute(
                        select(LeaveBalance).where(
                            LeaveBalance.developer_id == row.developer_id,
                            LeaveBalance.year == a.year,
                        )
                    )
                ).scalar_one()
                bal_cache[a.year] = bal
            if from_status == "PENDING":
                bal.pending_days = Decimal(str(bal.pending_days)) - Decimal(str(a.days))
            else:  # APPROVED
                bal.used_days = Decimal(str(bal.used_days)) - Decimal(str(a.days))
        else:
            assert a.grant_id is not None
            grant = grant_cache.get(a.grant_id)
            if grant is None:
                grant = (
                    await db.execute(
                        select(LeaveRewardGrant).where(
                            LeaveRewardGrant.id == a.grant_id
                        )
                    )
                ).scalar_one()
                grant_cache[a.grant_id] = grant
            grant.remaining_days = Decimal(str(grant.remaining_days)) + Decimal(
                str(a.days)
            )
    # allocation row 는 CASCADE 로 남겨두지 않고 삭제 (재사용 없도록).
    for a in list(row.allocations):
        await db.delete(a)


async def _resolve_target_developer(
    db: AsyncSession, payload_dev_id: UUID | None, user: User
) -> tuple[UUID, str, str | None]:
    if payload_dev_id is None:
        dev_id = await _resolve_my_developer_id(db, user)
    else:
        if user.role != "ADMIN":
            my = await _resolve_my_developer_id(db, user)
            if my != payload_dev_id:
                raise HTTPException(
                    status_code=403, detail="본인 것만 신청할 수 있습니다."
                )
        dev_id = payload_dev_id
    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if dev is None or dev.status != "ACTIVE":
        raise HTTPException(status_code=404, detail="활성 임직원을 찾을 수 없습니다.")
    return dev_id, dev.name, dev.tag


def _run_notify_bg_created(request_id: UUID):
    async def _inner():
        async with system_session() as db:
            try:
                await leave_notify.notify_created(db, request_id)
            except Exception as exc:  # pragma: no cover
                logger.warning("leave_notify(created) 실패: %s", exc, exc_info=True)

    return _inner


def _run_notify_bg_status(request_id: UUID, new_status: str):
    async def _inner():
        async with system_session() as db:
            try:
                await leave_notify.notify_status_change(db, request_id, new_status)
            except Exception as exc:  # pragma: no cover
                logger.warning("leave_notify(%s) 실패: %s", new_status, exc, exc_info=True)

    return _inner


@router.post("", response_model=LeaveRequestOut, status_code=status.HTTP_201_CREATED)
async def create_leave_request(
    payload: LeaveRequestCreate,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dev_id, dev_name, dev_tag = await _resolve_target_developer(db, payload.developer_id, user)

    # UNPAID_PUBLIC 은 잔여 영향 없이 기록만.
    row = LeaveRequest(
        developer_id=dev_id,
        requester_user_id=user.id,
        leave_type=payload.leave_type,
        half_kind=payload.half_kind,
        category=payload.category,
        start_date=payload.start_date,
        end_date=payload.end_date,
        days_total=payload.days_total,
        reason=payload.reason,
        status="PENDING",
    )

    if payload.leave_type != "UNPAID_PUBLIC":
        years = sorted({payload.start_date.year, payload.end_date.year})
        holidays = await _load_holidays(db, years)
        try:
            days_by_year = split_days_by_year(
                payload.start_date,
                payload.end_date,
                holidays,
                payload.half_kind,
                payload.days_total,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        bals = await _load_balance_snapshots(db, dev_id, list(days_by_year.keys()))
        missing = [y for y in days_by_year if y not in bals]
        if missing:
            _raise_missing_balance(missing)

        grants = await _load_reward_snapshots(db, dev_id)
        plan = build_allocation_plan(days_by_year, bals, grants)
        if not plan.ok:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"연차 잔여가 부족합니다. 필요 {payload.days_total}일, "
                    f"{plan.insufficient_days}일 부족."
                ),
            )

        db.add(row)
        await db.flush()
        await _apply_allocations(db, row, plan.allocations)
    else:
        db.add(row)
        await db.flush()

    await db.commit()
    await db.refresh(row, ["allocations"])
    logger.info(
        "연차 신청: id=%s dev=%s type=%s %s~%s %s일",
        row.id,
        dev_id,
        payload.leave_type,
        row.start_date,
        row.end_date,
        row.days_total,
    )
    bg.add_task(_run_notify_bg_created(row.id))
    return await _serialize_request(row, dev_name, dev_tag)


async def _can_approve_for(db: AsyncSession, user: User, dev_id: UUID) -> bool:
    """ADMIN 이거나, 해당 직원의 지정 승인자에 포함돼 있으면 True."""
    if user.role == "ADMIN":
        return True
    existing = (
        await db.execute(
            select(DeveloperApprover.id).where(
                DeveloperApprover.developer_id == dev_id,
                DeveloperApprover.approver_user_id == user.id,
            )
        )
    ).first()
    return existing is not None


@router.get("", response_model=list[LeaveRequestOut])
async def list_leave_requests(
    developer_id: UUID | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    assigned_to_me: bool = Query(default=False, alias="assigned_to_me"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if user.role != "ADMIN" and not assigned_to_me:
        my = await _resolve_my_developer_id(db, user)
        if developer_id is not None and developer_id != my:
            raise HTTPException(status_code=403, detail="본인 것만 조회 가능합니다.")
        developer_id = my

    stmt = select(LeaveRequest).options(selectinload(LeaveRequest.allocations))
    if developer_id is not None:
        stmt = stmt.where(LeaveRequest.developer_id == developer_id)
    if assigned_to_me:
        # 내가 담당 승인자인 직원들의 신청만
        stmt = stmt.where(
            LeaveRequest.developer_id.in_(
                select(DeveloperApprover.developer_id).where(
                    DeveloperApprover.approver_user_id == user.id
                )
            )
        )
    if status_filter:
        stmt = stmt.where(LeaveRequest.status == status_filter)
    if from_date:
        stmt = stmt.where(LeaveRequest.end_date >= from_date)
    if to_date:
        stmt = stmt.where(LeaveRequest.start_date <= to_date)
    stmt = stmt.order_by(LeaveRequest.created_at.desc())
    rows = list((await db.execute(stmt)).scalars().unique())

    # 이름 + 태그 join
    dev_ids = {r.developer_id for r in rows}
    dev_map: dict[UUID, Developer] = (
        {
            d.id: d
            for d in (
                await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
            ).scalars()
        }
        if dev_ids
        else {}
    )
    out: list[LeaveRequestOut] = []
    for r in rows:
        d = dev_map.get(r.developer_id)
        out.append(await _serialize_request(r, d.name if d else None, d.tag if d else None))
    return out


@router.get("/{rid}", response_model=LeaveRequestOut)
async def get_leave_request(
    rid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(LeaveRequest)
            .where(LeaveRequest.id == rid)
            .options(selectinload(LeaveRequest.allocations))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다.")
    if user.role != "ADMIN":
        my = await _resolve_my_developer_id(db, user)
        if row.developer_id != my:
            raise HTTPException(status_code=403, detail="본인 것만 조회 가능합니다.")
    dev = (
        await db.execute(select(Developer).where(Developer.id == row.developer_id))
    ).scalar_one_or_none()
    return await _serialize_request(row, dev.name if dev else None, dev.tag if dev else None)


@router.patch("/{rid}", response_model=LeaveRequestOut)
async def update_leave_request(
    rid: UUID,
    payload: LeaveRequestUpdate,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(LeaveRequest)
            .where(LeaveRequest.id == rid)
            .options(selectinload(LeaveRequest.allocations))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다.")
    if row.status != "PENDING":
        raise HTTPException(status_code=400, detail="PENDING 상태만 수정 가능합니다.")
    if user.role != "ADMIN":
        my = await _resolve_my_developer_id(db, user)
        if row.developer_id != my:
            raise HTTPException(status_code=403, detail="본인 것만 수정 가능합니다.")

    # 기존 allocation 되돌리고 새 payload 로 재계산.
    await _revert_allocations(db, row, from_status="PENDING")

    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.flush()

    if row.leave_type != "UNPAID_PUBLIC":
        years = sorted({row.start_date.year, row.end_date.year})
        holidays = await _load_holidays(db, years)
        try:
            days_by_year = split_days_by_year(
                row.start_date,
                row.end_date,
                holidays,
                row.half_kind,
                row.days_total,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        bals = await _load_balance_snapshots(db, row.developer_id, list(days_by_year.keys()))
        missing = [y for y in days_by_year if y not in bals]
        if missing:
            _raise_missing_balance(missing)
        grants = await _load_reward_snapshots(db, row.developer_id)
        plan = build_allocation_plan(days_by_year, bals, grants)
        if not plan.ok:
            raise HTTPException(
                status_code=400,
                detail=f"연차 잔여가 부족합니다 ({plan.insufficient_days}일 부족).",
            )
        await _apply_allocations(db, row, plan.allocations)

    await db.commit()
    await db.refresh(row, ["allocations"])
    dev = (
        await db.execute(select(Developer).where(Developer.id == row.developer_id))
    ).scalar_one_or_none()
    return await _serialize_request(row, dev.name if dev else None, dev.tag if dev else None)


@router.post("/{rid}/cancel", response_model=LeaveRequestOut)
async def cancel_leave_request(
    rid: UUID,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(LeaveRequest)
            .where(LeaveRequest.id == rid)
            .options(selectinload(LeaveRequest.allocations))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다.")
    if row.status in ("CANCELLED", "REJECTED"):
        return await _serialize_request(row, None)
    if user.role != "ADMIN":
        my = await _resolve_my_developer_id(db, user)
        if row.developer_id != my:
            raise HTTPException(status_code=403, detail="본인 것만 취소 가능합니다.")
    prev = row.status
    await _revert_allocations(db, row, from_status=prev)
    row.status = "CANCELLED"
    await db.commit()
    await db.refresh(row, ["allocations"])
    bg.add_task(_run_notify_bg_status(row.id, "CANCELLED"))
    return await _serialize_request(row, None)


@router.post("/{rid}/approve", response_model=LeaveRequestOut)
async def approve_leave_request(
    rid: UUID,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(LeaveRequest)
            .where(LeaveRequest.id == rid)
            .options(selectinload(LeaveRequest.allocations))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다.")
    if row.status != "PENDING":
        raise HTTPException(status_code=400, detail="PENDING 상태만 승인 가능합니다.")
    if not await _can_approve_for(db, admin, row.developer_id):
        raise HTTPException(
            status_code=403,
            detail="이 직원의 승인 권한이 없습니다 (지정 승인자 또는 ADMIN 만 가능).",
        )
    # 본인 자기승인 차단
    self_dev = await _resolve_my_developer_id_or_none(db, admin)
    if self_dev is not None and self_dev == row.developer_id:
        raise HTTPException(status_code=403, detail="본인 신청은 본인이 승인할 수 없습니다.")

    # pending → used 이동 (법정만). 포상은 이미 신청 시점에서 remaining 차감됨.
    bal_cache: dict[int, LeaveBalance] = {}
    for a in row.allocations:
        if a.source_type != "STATUTORY":
            continue
        assert a.year is not None
        bal = bal_cache.get(a.year)
        if bal is None:
            bal = (
                await db.execute(
                    select(LeaveBalance).where(
                        LeaveBalance.developer_id == row.developer_id,
                        LeaveBalance.year == a.year,
                    )
                )
            ).scalar_one()
            bal_cache[a.year] = bal
        bal.pending_days = Decimal(str(bal.pending_days)) - Decimal(str(a.days))
        bal.used_days = Decimal(str(bal.used_days)) + Decimal(str(a.days))

    row.status = "APPROVED"
    row.approver_user_id = admin.id
    row.approved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row, ["allocations"])
    logger.info("연차 승인: id=%s admin=%s", row.id, admin.id)
    bg.add_task(_run_notify_bg_status(row.id, "APPROVED"))
    return await _serialize_request(row, None)


@router.post("/{rid}/reject", response_model=LeaveRequestOut)
async def reject_leave_request(
    rid: UUID,
    payload: RejectRequest,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_user),
):
    row = (
        await db.execute(
            select(LeaveRequest)
            .where(LeaveRequest.id == rid)
            .options(selectinload(LeaveRequest.allocations))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다.")
    if not await _can_approve_for(db, admin, row.developer_id):
        raise HTTPException(
            status_code=403,
            detail="이 직원의 반려 권한이 없습니다.",
        )
    if row.status != "PENDING":
        raise HTTPException(status_code=400, detail="PENDING 상태만 반려 가능합니다.")

    await _revert_allocations(db, row, from_status="PENDING")
    row.status = "REJECTED"
    row.approver_user_id = admin.id
    row.rejected_reason = payload.reason
    await db.commit()
    await db.refresh(row, ["allocations"])
    logger.info("연차 반려: id=%s admin=%s", row.id, admin.id)
    bg.add_task(_run_notify_bg_status(row.id, "REJECTED"))
    return await _serialize_request(row, None)


@router.get("/reset-history")
async def list_reset_history(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    stmt = select(LeaveResetHistory)
    if year is not None:
        stmt = stmt.where(LeaveResetHistory.year == year)
    stmt = stmt.order_by(LeaveResetHistory.reset_at.desc())
    rows = list((await db.execute(stmt)).scalars())
    return [
        {
            "id": str(r.id),
            "year": r.year,
            "developer_id": str(r.developer_id) if r.developer_id else None,
            "strategy": r.strategy,
            "granted_days": float(r.granted_days),
            "reset_by": str(r.reset_by) if r.reset_by else None,
            "reset_at": r.reset_at.isoformat() if r.reset_at else None,
            "note": r.note,
        }
        for r in rows
    ]
