"""Web Push 발송 서비스.

VAPID 키 + PushSubscription row 들을 가지고 webpush 라이브러리로 단건/일괄 발송.
브라우저가 구독을 만료(410 Gone) 또는 무효화(404) 한 경우 해당 row 자동 삭제.

JSON payload 모양은 service worker (mobile/public/sw.js) 와 합의:
    {
        "title": "공지사항",
        "body":  "원문 첫 100자…",
        "url":   "/m/notice/<uuid>",
        "tag":   "notice-<uuid>"   (선택, 같은 tag 끼리 누적 안 되고 갱신)
    }
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from pywebpush import WebPushException, webpush
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import system_session
from app.models import PushSubscription

logger = logging.getLogger(__name__)


def _vapid_claims() -> dict[str, str]:
    """webpush 호출에 필요한 VAPID claims dict."""
    cfg = get_settings().push
    return {"sub": cfg.vapid_subject}


def _send_one(sub: PushSubscription, payload: dict[str, Any]) -> tuple[bool, int]:
    """단건 발송 (블로킹). 성공 → (True, 200/201), 만료/무효 → (False, 4xx)."""
    cfg = get_settings().push
    try:
        resp = webpush(
            subscription_info={
                "endpoint": sub.endpoint,
                "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
            },
            data=json.dumps(payload),
            vapid_private_key=cfg.vapid_private_key,
            vapid_claims=dict(_vapid_claims()),
            ttl=60 * 60 * 24,  # 24h — 단말이 오프라인이어도 그동안은 큐잉.
        )
        return True, resp.status_code
    except WebPushException as exc:
        # 만료/무효 → row 삭제 마킹.
        status_code = getattr(exc.response, "status_code", 0)
        return False, status_code


async def send_push_to_users(user_ids: list, payload: dict[str, Any]) -> dict[str, int]:
    """주어진 user_id 들의 모든 구독에 발송. 결과 카운트 반환."""
    cfg = get_settings().push
    if not cfg.enabled or not cfg.vapid_private_key:
        return {"skipped_disabled": 1, "sent": 0, "failed": 0, "purged": 0}

    sent = 0
    failed = 0
    purged = 0
    async with system_session() as db:
        subs = list(
            (
                await db.execute(
                    select(PushSubscription).where(
                        PushSubscription.user_id.in_(user_ids)
                    )
                )
            ).scalars()
        )
        if not subs:
            return {"sent": 0, "failed": 0, "purged": 0}

        loop = asyncio.get_running_loop()
        # 블로킹 webpush 호출을 thread pool 로 동시 실행.
        results = await asyncio.gather(
            *[loop.run_in_executor(None, _send_one, s, payload) for s in subs],
            return_exceptions=True,
        )

        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        purge_ids: list = []
        for sub, res in zip(subs, results):
            if isinstance(res, Exception):
                failed += 1
                logger.warning("push 예외: endpoint=%s err=%s", sub.endpoint[:80], res)
                continue
            ok, code = res
            if ok:
                sub.last_sent_at = now
                sent += 1
            else:
                # 410 Gone (구독 만료), 404 Not Found (endpoint 무효) → 삭제.
                if code in (404, 410):
                    purge_ids.append(sub.id)
                    purged += 1
                else:
                    failed += 1
                    logger.info(
                        "push 발송 실패: endpoint=%s status=%s",
                        sub.endpoint[:80], code,
                    )
        if purge_ids:
            await db.execute(
                delete(PushSubscription).where(PushSubscription.id.in_(purge_ids))
            )
        await db.commit()

    return {"sent": sent, "failed": failed, "purged": purged}


async def broadcast_push(payload: dict[str, Any]) -> dict[str, int]:
    """모든 활성 구독에 발송 — 공지사항 발행 등 전사 알림용.

    user 활성 여부는 따로 검증 안 함 — push_subscriptions 가 cascade 삭제되기
    때문에 정리는 자동.
    """
    cfg = get_settings().push
    if not cfg.enabled or not cfg.vapid_private_key:
        return {"skipped_disabled": 1, "sent": 0, "failed": 0, "purged": 0}

    async with system_session() as db:
        all_user_ids = list(
            (
                await db.execute(
                    select(PushSubscription.user_id).distinct()
                )
            ).scalars()
        )
    if not all_user_ids:
        return {"sent": 0, "failed": 0, "purged": 0, "no_subscribers": 1}
    return await send_push_to_users(all_user_ids, payload)
