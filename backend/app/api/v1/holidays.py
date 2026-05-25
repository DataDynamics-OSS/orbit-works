"""캘린더 (일정) API — 사이드바 "개요 > 일정" 메뉴.

API path 는 `/calendar` 이지만 데이터는 여전히 `holidays` 테이블의 공휴일 row.
파일명·모델명·DB 테이블명은 도메인 의미("holidays") 를 유지.

Endpoints:
- GET    /calendar?year=YYYY               목록 (연도별)
- GET    /calendar/check?date=YYYY-MM-DD   is-holiday?
- POST   /calendar                          단건 등록 (ADMIN)
- POST   /calendar/bulk                     다건 일괄 등록 (ADMIN)
- PATCH  /calendar/{hid}                    수정 (ADMIN)
- DELETE /calendar/{hid}                    삭제 (ADMIN)

토/일 주말은 DB 저장 안 함 — 날짜의 weekday() 로 판단. 이 API 가 반환하는
`is_weekend` 는 저장된 공휴일과 무관하게 단순 요일 판정.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date as date_cls, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.core.config import PayrollConfig, get_tenant_section
from app.core.database import get_db
from app.models import Developer, Holiday, HolidayAlarmRecipient, User
from app.services.payday import compute_paydays_for_year
from app.schemas.holiday import (
    AlarmRecipientOut,
    HolidayBulkCreate,
    HolidayCheckOut,
    HolidayCreate,
    HolidayOut,
    HolidayUpdate,
)

# 비공개 일정은 HR/ADMIN/SUPER_ADMIN 만 보기.
_PRIVILEGED_ROLES = {"ADMIN", "HR", "SUPER_ADMIN"}


async def _serialize(db: AsyncSession, row: Holiday) -> HolidayOut:
    """Holiday → HolidayOut. 알람 수신자의 developer 이름을 join 으로 채움."""
    recipients: list[AlarmRecipientOut] = []
    if row.alarm_recipients:
        dev_ids = {r.developer_id for r in row.alarm_recipients}
        name_by: dict = {}
        if dev_ids:
            res = await db.execute(
                select(Developer.id, Developer.name).where(Developer.id.in_(dev_ids))
            )
            name_by = {did: nm for did, nm in res.all()}
        recipients = [
            AlarmRecipientOut(
                developer_id=r.developer_id,
                developer_name=name_by.get(r.developer_id),
                notified_at=r.notified_at,
            )
            for r in row.alarm_recipients
        ]
    out = HolidayOut.model_validate(row, from_attributes=True)
    out.alarm_recipients = recipients
    return out


async def _replace_recipients(
    db: AsyncSession, holiday_id, recipient_ids: list, holiday_type: str
) -> None:
    """일정의 알람 수신자 전체 교체. EVENT_PRIVATE 외 type 은 모두 제거.

    구현 노트: ORM 로 row 를 로드 → ``db.delete(obj)`` → ``db.add(new)`` 패턴은
    같은 (holiday_id, developer_id) 조합이 새 목록에도 포함될 때 SQLAlchemy 의
    flush 순서·identity map 캐시와 맞물려 UNIQUE 위반이 발생할 수 있다.
    bulk DELETE 한 번 → flush → bulk add 로 분리해 안전화.
    """
    # 1) 기존 row 일괄 DELETE (Core 문 — identity map 우회) + flush 확정.
    await db.execute(
        delete(HolidayAlarmRecipient).where(
            HolidayAlarmRecipient.holiday_id == holiday_id
        )
    )
    await db.flush()

    # 2) EVENT_PRIVATE 가 아니면 신규 등록 안 함 (silently drop).
    if holiday_type != "EVENT_PRIVATE":
        return

    # 3) 입력 dedupe — 프런트에서 같은 사람을 두 번 선택해 보내도 1건만.
    seen: set = set()
    for did in recipient_ids:
        if did in seen:
            continue
        seen.add(did)
        db.add(HolidayAlarmRecipient(holiday_id=holiday_id, developer_id=did))

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/calendar", tags=["calendar"])


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@router.get("", response_model=list[HolidayOut])
async def list_holidays(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(Holiday)
        .options(selectinload(Holiday.alarm_recipients))
        .order_by(Holiday.date.asc())
    )
    if year is not None:
        stmt = stmt.where(
            Holiday.date >= date_cls(year, 1, 1),
            Holiday.date <= date_cls(year, 12, 31),
        )
    # 비공개 일정 (EVENT_PRIVATE) — HR/ADMIN/SUPER_ADMIN 만.
    # 개인 일정 (EVENT_PERSONAL) — 작성자 본인만.
    if user.role not in _PRIVILEGED_ROLES:
        stmt = stmt.where(Holiday.type != "EVENT_PRIVATE")
    stmt = stmt.where(
        (Holiday.type != "EVENT_PERSONAL") | (Holiday.created_by == user.id)
    )
    rows = list((await db.execute(stmt)).scalars())
    out = [await _serialize(db, r) for r in rows]

    # 합성 급여일 row — 모든 임직원 가시. 요청 연도(없으면 올해) 기준 12개월.
    # DB 저장 X, 매 fetch 마다 payroll 설정 + holidays 종합으로 재계산.
    target_year = year if year is not None else date_cls.today().year
    raw_cfg = await get_tenant_section(user.tenant_id, "payroll")
    try:
        cfg = PayrollConfig.model_validate(raw_cfg)
    except Exception:  # pragma: no cover — 잘못된 설정 fallback.
        cfg = PayrollConfig()
    paydays = await compute_paydays_for_year(db, year=target_year, settings=cfg)
    payday_ns = uuid.UUID("00000000-0000-0000-0000-000000000001")
    for p in paydays:
        sid = uuid.uuid5(payday_ns, f"payday-{p.actual_date.isoformat()}")
        out.append(HolidayOut(
            id=sid,
            date=p.actual_date,
            name=(
                f"💰 급여일 ({p.scheduled_date.isoformat()} → {p.actual_date.isoformat()})"
                if p.rolled_back
                else "💰 급여일"
            ),
            type="EVENT_PAYDAY",
            description=(
                f"급여 설정: 매월 {cfg.payday_of_month}일 ({cfg.rollback_strategy} 영업일 보정)"
            ),
            created_by=None,
            created_at=None,
            alarm_recipients=[],
        ))
    return out


@router.get("/check", response_model=HolidayCheckOut)
async def check_holiday(
    date: date_cls,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    is_weekend = date.weekday() >= 5  # 5=토, 6=일
    row = (
        await db.execute(select(Holiday).where(Holiday.date == date))
    ).scalar_one_or_none()
    # 일반 사용자가 EVENT_PRIVATE 를 조회한 경우 가리기 (휴일 판정에서도 제외).
    if (
        row is not None
        and row.type == "EVENT_PRIVATE"
        and user.role not in _PRIVILEGED_ROLES
    ):
        row = None
    # EVENT_PERSONAL 도 작성자 외에는 가리기.
    if (
        row is not None
        and row.type == "EVENT_PERSONAL"
        and row.created_by != user.id
    ):
        row = None
    # is_holiday 는 STATUTORY/TEMPORARY/COMPANY 만 차감 — 일정(EVENT_*) 은 비차감.
    is_real_holiday = row is not None and row.type in (
        "STATUTORY",
        "TEMPORARY",
        "COMPANY",
    )
    return HolidayCheckOut(
        date=date,
        is_weekend=is_weekend,
        is_holiday=is_weekend or is_real_holiday,
        name=row.name if row else None,
        type=row.type if row else None,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# Write — ADMIN only
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=HolidayOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_holiday(
    payload: HolidayCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    권한:
      - 휴일 (STATUTORY/TEMPORARY/COMPANY) 와 EVENT_PRIVATE (HR 내부)
        는 holidays.manage (HR/ADMIN) 만.
      - EVENT_PUBLIC / EVENT_PERSONAL 은 모든 인증 사용자 가능.
    """
    from app.schemas.holiday import USER_CREATABLE_TYPES
    from app.core.roles import has as role_has

    if payload.type not in USER_CREATABLE_TYPES:
        if not role_has(user.role, "holidays.manage"):
            raise HTTPException(
                status_code=403, detail="HR/ADMIN 권한이 필요합니다.",
            )

    row = Holiday(
        date=payload.date,
        name=payload.name,
        type=payload.type,
        description=payload.description,
        created_by=user.id,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        # partial unique index 는 휴일 3종에만 적용 — 같은 날 휴일이 이미
        # 있으면 충돌. 그 외 위반(CHECK 등) 은 별도 사유 표기.
        msg = str(exc.orig) if exc.orig else ""
        if "uq_holidays_tenant_date_holiday" in msg or "duplicate key" in msg:
            detail = f"{payload.date} 에는 이미 다른 공휴일이 등록되어 있습니다."
        else:
            detail = f"등록 실패: {msg[:200] or 'IntegrityError'}"
        raise HTTPException(status_code=400, detail=detail)
    # EVENT_PRIVATE 일 때만 alarm_recipients 등록 (다른 type 은 silently drop).
    if payload.alarm_recipients:
        await _replace_recipients(
            db, row.id, payload.alarm_recipients, row.type
        )
    await db.commit()
    await db.refresh(row, attribute_names=["alarm_recipients"])
    logger.info(
        "공휴일/일정 등록: %s %s (%s) 알람=%d명 작성자=%s",
        row.date, row.name, row.type, len(row.alarm_recipients or []), user.id,
    )
    return await _serialize(db, row)


@router.post(
    "/bulk",
    response_model=list[HolidayOut],
    status_code=status.HTTP_201_CREATED,
)
async def bulk_create_holidays(
    payload: HolidayBulkCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("holidays.manage")),
):
    """여러 날짜에 같은 이름/type 의 휴일을 일괄 등록. 이미 존재하는 날짜는 스킵."""
    if not payload.dates:
        return []
    # 중복 방지: 이미 있는 날짜 사전조회.
    existing = set(
        (
            await db.execute(
                select(Holiday.date).where(Holiday.date.in_(payload.dates))
            )
        ).scalars()
    )
    added: list[Holiday] = []
    for d in payload.dates:
        if d in existing:
            continue
        row = Holiday(
            date=d,
            name=payload.name,
            type=payload.type,
            description=payload.description,
            created_by=user.id,
        )
        db.add(row)
        added.append(row)
    await db.commit()
    for r in added:
        await db.refresh(r)
    logger.info(
        "공휴일 일괄 등록: %s (%s건, 요청=%s) 작성자=%s",
        payload.name,
        len(added),
        len(payload.dates),
        user.id,
    )
    return [HolidayOut.model_validate(r, from_attributes=True) for r in added]


@router.patch("/{hid}", response_model=HolidayOut)
async def update_holiday(
    hid: UUID,
    payload: HolidayUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    수정 권한:
      - EVENT_PUBLIC / EVENT_PERSONAL : 본인이 작성한 항목 (created_by==me).
      - EVENT_PRIVATE : HR/ADMIN/SUPER_ADMIN.
      - 휴일 (STATUTORY/TEMPORARY/COMPANY) : holidays.manage (HR/ADMIN).
    """
    from app.core.roles import has as role_has

    row = (
        await db.execute(
            select(Holiday)
            .options(selectinload(Holiday.alarm_recipients))
            .where(Holiday.id == hid)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Holiday not found")
    # 비공개 일정은 HR/ADMIN/SUPER_ADMIN 만 수정.
    if row.type == "EVENT_PRIVATE" and user.role not in _PRIVILEGED_ROLES:
        raise HTTPException(status_code=404, detail="Holiday not found")
    # 일반 사용자는 본인이 작성한 EVENT_PUBLIC / EVENT_PERSONAL 만 수정.
    is_user_event = row.type in ("EVENT_PUBLIC", "EVENT_PERSONAL")
    if not role_has(user.role, "holidays.manage"):
        if not (is_user_event and row.created_by == user.id):
            raise HTTPException(status_code=403, detail="권한 없음")
    data = payload.model_dump(exclude_unset=True)
    # alarm_recipients 는 별도 처리.
    new_recipients = data.pop("alarm_recipients", None)
    for k, v in data.items():
        setattr(row, k, v)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig) if exc.orig else ""
        if "uq_holidays_tenant_date_holiday" in msg or "duplicate key" in msg:
            detail = "해당 날짜에 이미 다른 공휴일이 등록되어 있습니다."
        else:
            detail = f"수정 실패: {msg[:200] or 'IntegrityError'}"
        raise HTTPException(status_code=400, detail=detail)
    # EVENT_PRIVATE → 다른 type 으로 변경 시 자동으로 recipients 모두 제거.
    if new_recipients is not None or row.type != "EVENT_PRIVATE":
        await _replace_recipients(
            db, row.id, new_recipients or [], row.type
        )
    await db.commit()
    await db.refresh(row, attribute_names=["alarm_recipients"])
    logger.info(
        "공휴일/일정 수정: id=%s 변경=%s 수정자=%s",
        hid,
        list(data.keys()) + (["alarm_recipients"] if new_recipients is not None else []),
        user.id,
    )
    return await _serialize(db, row)


@router.delete("/{hid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_holiday(
    hid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    삭제 권한:
      - EVENT_PUBLIC / EVENT_PERSONAL : 본인이 작성한 항목.
      - EVENT_PRIVATE : HR/ADMIN/SUPER_ADMIN.
      - 휴일 : holidays.manage (HR/ADMIN).
    """
    from app.core.roles import has as role_has

    row = (
        await db.execute(select(Holiday).where(Holiday.id == hid))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Holiday not found")
    if row.type == "EVENT_PRIVATE" and user.role not in _PRIVILEGED_ROLES:
        raise HTTPException(status_code=404, detail="Holiday not found")
    is_user_event = row.type in ("EVENT_PUBLIC", "EVENT_PERSONAL")
    if not role_has(user.role, "holidays.manage"):
        if not (is_user_event and row.created_by == user.id):
            raise HTTPException(status_code=403, detail="권한 없음")
    await db.delete(row)
    await db.commit()
    logger.warning("공휴일 삭제: id=%s date=%s name=%s 삭제자=%s", hid, row.date, row.name, user.id)
