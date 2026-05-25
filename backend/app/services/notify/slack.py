"""Slack provider — chat.postMessage (Bot Token) + Incoming Webhook fallback.

호출자는 직접 import 하지 말 것 — `notify_service.send()` 통해 dispatch.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import SlackProviderConfig
from app.services.notify.base import NotifyProvider

logger = logging.getLogger(__name__)


class SlackService(NotifyProvider):
    def __init__(self, cfg: SlackProviderConfig) -> None:
        self._cfg = cfg

    def is_configured(self) -> bool:
        return bool(self._cfg.bot_token or self._cfg.default_webhook_url)

    async def send(
        self,
        text: str,
        *,
        channels: list[str] | None = None,
        user_emails: list[str] | None = None,
        user_ids: list[str] | None = None,
        blocks: list[dict[str, Any]] | None = None,
    ) -> bool:
        cfg = self._cfg
        channels = list(channels or cfg.default_channels)
        user_emails = list(user_emails or cfg.default_user_emails)
        user_ids = list(user_ids or cfg.default_user_ids)

        prefix = (cfg.emoji_prefix or "").strip()
        message = f"{prefix} {text}" if prefix else text

        if not channels and not user_emails and not user_ids:
            logger.warning("Slack: no channels or users to notify; skipping")
            return False

        delivered = False
        async with httpx.AsyncClient(timeout=cfg.timeout_seconds) as client:
            if user_emails and cfg.bot_token:
                resolved = await self._resolve_emails(client, user_emails)
                user_ids.extend(uid for uid in resolved if uid not in user_ids)
            elif user_emails and not cfg.bot_token:
                logger.warning(
                    "Slack: user emails provided but bot_token not set; "
                    "cannot DM users without a bot token"
                )

            targets: list[str] = []
            targets.extend(channels)
            targets.extend(user_ids)

            if cfg.bot_token:
                for target in targets:
                    ok = await self._post_message(client, target, message, blocks)
                    delivered = delivered or ok
            elif cfg.default_webhook_url:
                ok = await self._post_webhook(client, message, blocks)
                delivered = delivered or ok
            else:
                logger.warning("Slack: no bot_token or webhook configured")

        return delivered

    async def _resolve_emails(
        self, client: httpx.AsyncClient, emails: list[str]
    ) -> list[str]:
        cfg = self._cfg
        ids: list[str] = []
        for email in emails:
            try:
                r = await client.get(
                    f"{cfg.api_base_url}/users.lookupByEmail",
                    params={"email": email},
                    headers={"Authorization": f"Bearer {cfg.bot_token}"},
                )
                data = r.json()
                if data.get("ok") and data.get("user", {}).get("id"):
                    ids.append(data["user"]["id"])
                else:
                    logger.warning(
                        "Slack users.lookupByEmail failed for %s: %s",
                        email,
                        data.get("error"),
                    )
            except Exception as exc:
                logger.warning("Slack lookup error for %s: %s", email, exc, exc_info=True)
        return ids

    async def _post_message(
        self,
        client: httpx.AsyncClient,
        target: str,
        text: str,
        blocks: list[dict[str, Any]] | None,
    ) -> bool:
        cfg = self._cfg
        payload: dict[str, Any] = {"channel": target, "text": text}
        if blocks:
            payload["blocks"] = blocks
        try:
            r = await client.post(
                f"{cfg.api_base_url}/chat.postMessage",
                json=payload,
                headers={
                    "Authorization": f"Bearer {cfg.bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
            )
            data = r.json()
            if data.get("ok"):
                return True
            logger.warning("Slack postMessage failed for %s: %s", target, data.get("error"))
            return False
        except Exception as exc:
            logger.warning("Slack postMessage error for %s: %s", target, exc, exc_info=True)
            return False

    async def _post_webhook(
        self,
        client: httpx.AsyncClient,
        text: str,
        blocks: list[dict[str, Any]] | None,
    ) -> bool:
        cfg = self._cfg
        payload: dict[str, Any] = {"text": text}
        if blocks:
            payload["blocks"] = blocks
        try:
            r = await client.post(cfg.default_webhook_url, json=payload)
            if 200 <= r.status_code < 300:
                return True
            logger.warning("Slack webhook failed: %s %s", r.status_code, r.text)
            return False
        except Exception as exc:
            logger.warning("Slack webhook error: %s", exc, exc_info=True)
            return False
