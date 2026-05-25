"""Web Push 구독 관리 API.

Endpoints:
- GET    /push/config         — 활성 여부 + VAPID public key (브라우저용 base64url)
- POST   /push/subscribe      — 구독 추가 (endpoint + p256dh + auth)
- DELETE /push/subscribe      — 본인 endpoint 제거 (logout/unsubscribe)
- GET    /push/subscriptions  — 본인의 등록 기기 목록 (관리용)
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Header, Request, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.models import PushSubscription, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/push", tags=["push"])


class PushConfigOut(BaseModel):
    enabled: bool
    vapid_public_key: str = ""


class PushSubscribeRequest(BaseModel):
    endpoint: str
    p256dh: str
    auth: str


class PushSubscriptionOut(BaseModel):
    id: UUID
    endpoint: str
    user_agent: str | None = None


@router.get("/config", response_model=PushConfigOut)
async def get_push_config():
    """프런트가 PushManager.subscribe(applicationServerKey=…) 에 사용할 공개 키 반환.

    `enabled=false` 면 프런트는 알림 토글 자체를 표시하지 않음.
    인증 없이 호출 가능 — 공개 키는 비밀이 아님.
    """
    cfg = get_settings().push
    return PushConfigOut(
        enabled=cfg.enabled and bool(cfg.vapid_public_key),
        vapid_public_key=cfg.vapid_public_key if cfg.enabled else "",
    )


@router.post("/subscribe", status_code=status.HTTP_201_CREATED)
async def subscribe(
    payload: PushSubscribeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_agent: str | None = Header(default=None, alias="User-Agent"),
):
    """기기 1대당 1행. 같은 endpoint 중복 등록은 무시(이미 있으면 업데이트만)."""
    # 기존 row 가 있으면 업데이트 (소유자 변경 가능 — 같은 기기 다른 사용자 로그인).
    existing = (
        await db.execute(
            select(PushSubscription).where(
                PushSubscription.endpoint == payload.endpoint
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.user_id = user.id
        existing.p256dh = payload.p256dh
        existing.auth = payload.auth
        existing.user_agent = (user_agent or "")[:500] or None
        await db.commit()
        logger.info("push 구독 갱신: user=%s", user.id)
        return {"id": str(existing.id), "updated": True}

    sub = PushSubscription(
        user_id=user.id,
        endpoint=payload.endpoint,
        p256dh=payload.p256dh,
        auth=payload.auth,
        user_agent=(user_agent or "")[:500] or None,
    )
    db.add(sub)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "이미 등록된 endpoint 입니다.")
    await db.refresh(sub)
    logger.info("push 구독 등록: user=%s id=%s", user.id, sub.id)
    return {"id": str(sub.id), "created": True}


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.delete("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(
    payload: UnsubscribeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인의 endpoint 제거. 다른 사용자의 endpoint 는 영향 없음."""
    await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == payload.endpoint,
            PushSubscription.user_id == user.id,
        )
    )
    await db.commit()


@router.get("/subscriptions", response_model=list[PushSubscriptionOut])
async def list_my_subscriptions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[PushSubscriptionOut]:
    rows = list(
        (
            await db.execute(
                select(PushSubscription)
                .where(PushSubscription.user_id == user.id)
                .order_by(PushSubscription.created_at.desc())
            )
        ).scalars()
    )
    return [
        PushSubscriptionOut(id=r.id, endpoint=r.endpoint, user_agent=r.user_agent)
        for r in rows
    ]
