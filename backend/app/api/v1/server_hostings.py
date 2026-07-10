"""Server Hostings API — 자원 > 서버 호스팅 메뉴.

회사가 사용 중인 서버(전용 / VPS / 클라우드 IaaS / 코로케이션) 의 CRUD.
tenant 격리는 RLS 정책 `tenant_iso` 가 자동 처리 — 핸들러에서 별도 필터링
불필요.

운영 흐름:
  - `expiry_alarm=true` 인 항목은 일일 cron (`services/daily_alerts.py`) 의
    D-30 검사 대상이 되어 ADMIN/HR/SUPER_ADMIN 에게 mattermost DM 발송.
    도메인과 같은 채널을 쓰되 메시지 본문은 별도 (`server_hosting_expiry_alert`).
  - `hosting_type` 은 4 종 enum (`DEDICATED | VPS | CLOUD | COLOCATION`) —
    DB 레벨 CHECK 없이 앱 단(스키마) 에서만 검증. 신규 유형 추가 시
    `models.SERVER_HOSTING_TYPES` 와 `schemas.HostingType` 둘 다 갱신.
  - `monthly_cost` 는 KRW 고정 — 도메인처럼 통화 다양화가 필요하면 currency
    컬럼 추가 + 마이그레이션. 해외 호스팅도 환산 후 입력하는 운영 약속.

테이블 의존성:
  - (tenant_id, ip) UNIQUE — 동일 tenant 안에서 같은 IP 중복 등록 차단.
  - FK `tenant_id → tenants(id) ON DELETE RESTRICT` — tenant 삭제 시
    호스팅 row 가 남아 있으면 거부 (의도적 — 호스팅을 모르게 지워버리는
    걸 방지).
  - INSERT 트리거 `fn_auto_tenant_id` 가 tenant_id 자동 채움 (앱 단의
    명시적 set 과 idempotent).

로깅 정책 (domains.py 와 동일):
  - INFO: 정상 mutation (create / update / delete) — 운영자 감사 및 cron
    알림 수신자가 "왜 이 호스팅이 새로 등장했는가" 추적용.
  - WARNING: unique 충돌 (사용자 입력 실수), tenant 미선택 거부, RLS·FK
    거부 같이 "사용자가 의도와 다른 결과를 받은" 경우, 그리고 빈 update
    payload (의도와 다른 noop). 정상 GET 은 access log 가 잡으므로 별도
    INFO 안 남김.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import ServerHosting, User
from app.schemas.server_hosting import (
    ServerHostingCreate,
    ServerHostingOut,
    ServerHostingUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/server-hostings", tags=["server-hostings"])

# (tenant_id, ip) unique constraint 이름 — driver 예외 메시지에 그대로 노출돼
# 메시지 매칭보다 안전한 식별 키. constraint 이름이 바뀌면 함께 갱신 필요.
_UNIQUE_IP = "uq_server_hostings_tenant_ip"


@router.get("", response_model=list[ServerHostingOut])
async def list_server_hostings(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """현재 tenant 의 서버 호스팅 — 종료일 임박 순.

    NULL 종료일은 맨 뒤로 보내 "관리되지 않는 호스팅" 이 임박 항목을 가리지
    않게 함. 정상 조회는 access log 가 잡으므로 별도 INFO 안 남김.
    """
    rows = (
        await db.execute(
            select(ServerHosting).order_by(
                ServerHosting.end_date.asc().nullslast(),
                ServerHosting.ip,
            )
        )
    ).scalars().all()
    return rows


@router.post("", response_model=ServerHostingOut, status_code=status.HTTP_201_CREATED)
async def create_server_hosting(
    payload: ServerHostingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """서버 호스팅 신규 등록 — (tenant_id, ip) 충돌 시 400.

    tenant_id 는 trigger `fn_auto_tenant_id` 가 자동 채워주지만, ORM 단에서
    명시적으로 set 해 둬야 flush 직후 객체가 일관됨 (refresh 전에도 조회 가능).
    """
    if user.tenant_id is None:
        # SUPER_ADMIN 이 tenant 미선택 상태에서 호출하는 비정상 케이스 —
        # 정상 흐름이면 fronted 가드가 막아 여기까지 안 옴. 보안 사고/잘못 만든
        # API 클라이언트 추적을 위해 WARNING.
        logger.warning(
            "server_hosting create rejected — user=%s 에 tenant_id 없음", user.id
        )
        raise HTTPException(status_code=400, detail="No tenant for current user")
    s = ServerHosting(tenant_id=user.tenant_id, **payload.model_dump())
    db.add(s)
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        # 가장 흔한 충돌: (tenant_id, ip) unique 위반. 사용자 입력 오류로
        # 분류해 400 + 한국어 메시지. WARNING 으로 남겨 반복 등록 시도 추적.
        if _UNIQUE_IP in str(exc):
            logger.warning(
                "server_hosting create 중복: tenant=%s ip=%s",
                user.tenant_id, payload.ip,
            )
            raise HTTPException(
                status_code=400,
                detail=f"이미 등록된 IP 입니다: {payload.ip}",
            ) from exc
        # 그 외 예외는 운영자가 봐야 할 진짜 오류 (RLS 거부·FK 등). 상위로 전파
        # 되며 FastAPI 의 500 핸들러가 traceback 까지 로깅.
        logger.warning(
            "server_hosting create 실패 (uncaught): tenant=%s ip=%s exc=%s",
            user.tenant_id, payload.ip, exc,
        )
        raise
    await db.refresh(s)
    logger.info(
        "server_hosting created: %s (id=%s, tenant=%s, type=%s, end=%s, alarm=%s)",
        s.ip, s.id, user.tenant_id, s.hosting_type, s.end_date, s.expiry_alarm,
    )
    return s


@router.patch("/{hosting_id}", response_model=ServerHostingOut)
async def update_server_hosting(
    hosting_id: UUID,
    payload: ServerHostingUpdate,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """부분 업데이트 — `exclude_unset` 으로 미지정 키는 기존 값 보존.

    ip 변경 시 (tenant_id, ip) 재충돌 가능 — 동일하게 400 처리.
    """
    s = (
        await db.execute(select(ServerHosting).where(ServerHosting.id == hosting_id))
    ).scalar_one_or_none()
    if s is None:
        # 404 는 운영자 입장에서 "이미 지워졌나, URL 이 잘못됐나" 둘 중
        # 어느 쪽인지 즉시 분간이 안 돼 굳이 WARNING 까진 안 남김 (access log
        # 의 status=404 로 충분).
        raise HTTPException(status_code=404, detail="ServerHosting not found")
    data = payload.model_dump(exclude_unset=True)
    if not data:
        # 빈 payload 는 의도와 다르게 다른 필드를 건드리려다 누락된 경우가 많아
        # noop 으로 빠지지 않도록 로깅.
        logger.warning("server_hosting update with empty payload: id=%s", hosting_id)
    for k, v in data.items():
        setattr(s, k, v)
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        if _UNIQUE_IP in str(exc):
            logger.warning(
                "server_hosting update 중복: id=%s new_ip=%s",
                hosting_id, data.get("ip"),
            )
            raise HTTPException(
                status_code=400,
                detail=f"이미 등록된 IP 입니다: {data.get('ip')}",
            ) from exc
        logger.warning(
            "server_hosting update 실패 (uncaught): id=%s exc=%s", hosting_id, exc
        )
        raise
    await db.refresh(s)
    logger.info(
        "server_hosting updated: %s (id=%s, fields=%s)",
        s.ip, s.id, sorted(data.keys()),
    )
    return s


@router.delete("/{hosting_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_server_hosting(
    hosting_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """서버 호스팅 단건 삭제. 다중 삭제는 프론트가 N 번 호출."""
    s = (
        await db.execute(select(ServerHosting).where(ServerHosting.id == hosting_id))
    ).scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=404, detail="ServerHosting not found")
    ip = s.ip
    await db.delete(s)
    await db.commit()
    logger.info("server_hosting deleted: %s (id=%s)", ip, hosting_id)
