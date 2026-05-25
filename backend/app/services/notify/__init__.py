"""알람 시스템 통합 dispatcher.

`NotifyConfig.provider` 에 따라 Slack 또는 Mattermost provider 를 골라 발송한다.
호출자는 `from app.services.notify import notify_service` 후 `await notify_service.send(...)`.

provider 추가 시: services/notify/<name>.py 에 `NotifyProvider` 구현 + 아래 dispatcher
의 분기에 등록.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from app.core.config import (
    MattermostProviderConfig,
    NotifyConfig,
    SlackProviderConfig,
    get_settings,
    get_tenant_section,
)
from app.services.notify.base import NotifyProvider
from app.services.notify.mattermost import MattermostService
from app.services.notify.slack import SlackService

logger = logging.getLogger(__name__)


def _build_provider(cfg: NotifyConfig) -> tuple[str, NotifyProvider | None]:
    if not cfg.enabled:
        return cfg.provider, None
    if cfg.provider == "slack":
        return "slack", SlackService(cfg.slack)
    if cfg.provider == "mattermost":
        return "mattermost", MattermostService(cfg.mattermost)
    logger.warning("notify: 알 수 없는 provider=%r", cfg.provider)
    return cfg.provider, None


class NotifyDispatcher:
    """provider 무관 발송 진입점.

    - `send(...)` — 글로벌 설정(get_settings) 기반. tenant 모름·결정 불가한
      호출자(예: 시스템 cron 의 글로벌 알림) 전용.
    - `send_for_tenant(tenant_id, ...)` — 그 tenant 의 notify 설정으로 발송.
      알람·연차·미팅 등 tenant 가 명확한 호출자가 사용 (multi-tenant 격리).

    매 호출마다 설정을 다시 읽어 UI 변경 즉시 반영.
    """

    async def send(
        self,
        text: str,
        *,
        channels: list[str] | None = None,
        user_emails: list[str] | None = None,
        user_ids: list[str] | None = None,
        blocks: list[dict[str, Any]] | None = None,
        feature: str | None = None,
    ) -> bool:
        cfg = get_settings().notify
        return await self._dispatch(cfg, text, channels=channels,
                                    user_emails=user_emails, user_ids=user_ids,
                                    blocks=blocks, feature=feature)

    async def send_for_tenant(
        self,
        tenant_id: UUID | str | None,
        text: str,
        *,
        channels: list[str] | None = None,
        user_emails: list[str] | None = None,
        user_ids: list[str] | None = None,
        blocks: list[dict[str, Any]] | None = None,
        feature: str | None = None,
    ) -> bool:
        if tenant_id is None:
            return await self.send(
                text, channels=channels, user_emails=user_emails,
                user_ids=user_ids, blocks=blocks, feature=feature,
            )
        raw = await get_tenant_section(tenant_id, "notify")
        try:
            cfg = NotifyConfig.model_validate(raw)
        except Exception as exc:
            logger.warning(
                "notify: tenant=%s 설정 파싱 실패 — 글로벌 fallback 으로: %s",
                tenant_id, exc,
            )
            cfg = get_settings().notify
        return await self._dispatch(cfg, text, channels=channels,
                                    user_emails=user_emails, user_ids=user_ids,
                                    blocks=blocks, feature=feature)

    async def _dispatch(
        self,
        cfg: NotifyConfig,
        text: str,
        *,
        channels: list[str] | None,
        user_emails: list[str] | None,
        user_ids: list[str] | None,
        blocks: list[dict[str, Any]] | None,
        feature: str | None = None,
    ) -> bool:
        name, prov = _build_provider(cfg)
        if prov is None:
            logger.info("notify provider=%s 비활성/미설정 — skip", name)
            return False
        # 피처별 게이트 — gates.<feature> 가 false 면 차단. 미지정/알 수 없는
        # feature 는 통과 (default=True) — 새 피처 도입 시 회귀 방지.
        if feature is not None:
            allowed = getattr(cfg.gates, feature, True)
            if not allowed:
                logger.info(
                    "notify feature=%s 비활성 (gates.%s=false) — skip",
                    feature, feature,
                )
                return False
        if not prov.is_configured():
            logger.warning("notify provider=%s 자격증명 미충족 — skip", name)
            return False
        return await prov.send(
            text,
            channels=channels,
            user_emails=user_emails,
            user_ids=user_ids,
            blocks=blocks,
        )

    def is_configured(self) -> bool:
        cfg = get_settings().notify
        _, prov = _build_provider(cfg)
        return bool(prov and prov.is_configured())


notify_service = NotifyDispatcher()
