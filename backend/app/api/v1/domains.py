"""Domains API — 자원 > 도메인 메뉴.

회사가 보유한 도메인 (`orbit-works.app`, `data-dynamics.io` 등) 의 CRUD.
tenant 격리는 RLS 정책 `tenant_iso` 가 자동 처리 — 핸들러에서 별도 필터링
불필요.

운영 흐름:
  - `expiry_alarm=true` 인 도메인은 일일 cron (`services/daily_alerts.py`) 의
    D-30 검사 대상이 되어 ADMIN/HR/SUPER_ADMIN 에게 mattermost DM 발송.
  - `auto_renew` 는 표시 전용 — 알람 동작과 무관 (사람이 한눈에 갱신 필요한지
    파악하는 용도).

로깅 정책:
  - INFO: 정상 mutation (create / update / delete) — 운영자 감사 및 cron 알림
    수신자가 "왜 이 도메인이 새로 등장했는가" 추적용.
  - WARNING: unique 충돌 (사용자 입력 실수) 및 RLS·DB 레벨 거부 같이 "사용자
    가 의도와 다른 결과를 받은" 경우. 정상 흐름의 단순 GET 은 access log 로 이미
    잡히므로 별도 INFO 안 남김.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Domain, User
from app.schemas.domain import DomainCreate, DomainOut, DomainUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/domains", tags=["domains"])

# (tenant_id, name) unique 위반 SQLSTATE — 메시지 매칭 대신 constraint 이름으로
# 식별. PG 가 driver 메시지에 constraint 이름을 그대로 노출.
_UNIQUE_NAME = "uq_domains_tenant_name"


@router.get("", response_model=list[DomainOut])
async def list_domains(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """현재 tenant 의 모든 도메인 — 만료일 임박 순.

    NULL 만료일은 맨 뒤로 보내 "관리되지 않는 도메인"이 임박 항목을 가리지
    않게 함.
    """
    rows = (
        await db.execute(
            select(Domain).order_by(Domain.expiry_date.asc().nullslast(), Domain.name)
        )
    ).scalars().all()
    return rows


@router.post("", response_model=DomainOut, status_code=status.HTTP_201_CREATED)
async def create_domain(
    payload: DomainCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """도메인 신규 등록 — (tenant_id, name) 충돌 시 400.

    tenant_id 는 trigger `fn_auto_tenant_id` 가 자동 채워주지만, ORM 단에서
    명시적으로 set 해 둬야 flush 직후 객체가 일관됨 (refresh 전에도 조회 가능).
    """
    if user.tenant_id is None:
        # SUPER_ADMIN 이 tenant 미선택 상태에서 호출하는 비정상 케이스.
        logger.warning(
            "domain create rejected — user=%s 에 tenant_id 없음", user.id
        )
        raise HTTPException(status_code=400, detail="No tenant for current user")
    d = Domain(tenant_id=user.tenant_id, **payload.model_dump())
    db.add(d)
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        # 가장 흔한 충돌: (tenant_id, name) unique 위반. 사용자 입력 오류로
        # 분류해 400 + 한국어 메시지. WARNING 으로 남겨 반복 등록 시도 추적.
        if _UNIQUE_NAME in str(exc):
            logger.warning(
                "domain create 중복: tenant=%s name=%s",
                user.tenant_id, payload.name,
            )
            raise HTTPException(
                status_code=400,
                detail=f"이미 등록된 도메인입니다: {payload.name}",
            ) from exc
        # 그 외 예외는 운영자가 봐야 할 진짜 오류 (RLS 거부·FK 등). 상위로 전파
        # 되며 FastAPI 의 500 핸들러가 traceback 까지 로깅.
        logger.warning(
            "domain create 실패 (uncaught): tenant=%s name=%s exc=%s",
            user.tenant_id, payload.name, exc,
        )
        raise
    await db.refresh(d)
    logger.info(
        "domain created: %s (id=%s, tenant=%s, expiry=%s, alarm=%s)",
        d.name, d.id, user.tenant_id, d.expiry_date, d.expiry_alarm,
    )
    return d


@router.patch("/{domain_id}", response_model=DomainOut)
async def update_domain(
    domain_id: UUID,
    payload: DomainUpdate,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """부분 업데이트 — `exclude_unset` 으로 미지정 키는 기존 값 보존.

    name 변경 시 (tenant_id, name) 재충돌 가능 — 동일하게 400 처리.
    """
    d = (
        await db.execute(select(Domain).where(Domain.id == domain_id))
    ).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Domain not found")
    data = payload.model_dump(exclude_unset=True)
    if not data:
        # 빈 payload 는 의도와 다르게 비밀번호 등 다른 필드를 건드리려다
        # 누락된 경우가 많아 noop 으로 빠지지 않도록 로깅.
        logger.warning("domain update with empty payload: id=%s", domain_id)
    for k, v in data.items():
        setattr(d, k, v)
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        if _UNIQUE_NAME in str(exc):
            logger.warning(
                "domain update 중복: id=%s new_name=%s",
                domain_id, data.get("name"),
            )
            raise HTTPException(
                status_code=400,
                detail=f"이미 등록된 도메인입니다: {data.get('name')}",
            ) from exc
        logger.warning(
            "domain update 실패 (uncaught): id=%s exc=%s", domain_id, exc
        )
        raise
    await db.refresh(d)
    logger.info(
        "domain updated: %s (id=%s, fields=%s)",
        d.name, d.id, sorted(data.keys()),
    )
    return d


@router.delete("/{domain_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_domain(
    domain_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """도메인 단건 삭제. 다중 삭제는 프론트가 N 번 호출."""
    d = (
        await db.execute(select(Domain).where(Domain.id == domain_id))
    ).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Domain not found")
    name = d.name
    await db.delete(d)
    await db.commit()
    logger.info("domain deleted: %s (id=%s)", name, domain_id)
