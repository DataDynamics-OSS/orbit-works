"""Mattermost provider — REST API v4 (Bot Account Token).

인증: `Authorization: Bearer <token>`. 발송 흐름:
  1. channel name 들을 channel id 로 해석 (`/teams/name/{team}/channels/name/{name}`).
  2. user email 들을 user id 로 해석 (`/users/email/{email}`) → DM 채널 id 확보
     (`/channels/direct ["bot_id","user_id"]`).
  3. `POST /api/v4/posts` 로 `channel_id` + `message` 게시.

Webhook 은 미지원 (요구사항: Bot Token 만).

Slack block kit (`blocks`) 입력 시 → Mattermost markdown 으로 변환해 게시:
  - `header` → `### <text>`
  - `section.fields` → 2-col markdown table (`| 항목 | 내용 |`)
  - `section.text` (mrkdwn) → 일반 markdown 문단, Slack 의 `<url|text>` 는
    `[text](url)` 로 치환.
  - 위 외 블록 타입은 무시.

blocks 가 없으면 단순 `text` 사용 (기존 호환).
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from app.core.config import MattermostProviderConfig
from app.services.notify.base import NotifyProvider


_SLACK_LINK_RE = re.compile(r"<(https?://[^|>]+)\|([^>]+)>")


def _slack_link_to_md(s: str) -> str:
    """Slack mrkdwn `<url|text>` → markdown `[text](url)`."""
    return _SLACK_LINK_RE.sub(r"[\2](\1)", s)


def _blocks_to_markdown(blocks: list[dict[str, Any]]) -> str:
    """Slack block kit → Mattermost markdown.

    header / section(fields|text) 만 처리. 결재·휴가 등 *_notify 서비스가
    공통으로 쓰는 minimal 구조 기준.
    """
    lines: list[str] = []
    for b in blocks:
        t = b.get("type")
        if t == "header":
            txt = (b.get("text") or {}).get("text", "")
            if txt:
                # `### ...` 는 Mattermost 에서 너무 크게 렌더 — bold 만 적용.
                lines.append(f"**{txt}**")
                lines.append("")
        elif t == "section":
            fields = b.get("fields") or []
            if fields:
                lines.append("| 항목 | 내용 |")
                lines.append("|------|------|")
                for f in fields:
                    raw = _slack_link_to_md((f.get("text") or "").strip())
                    # Slack 관례: "*label*\nvalue".
                    parts = raw.split("\n", 1)
                    if len(parts) == 2:
                        label = parts[0].strip("* ").strip()
                        # 표 셀 안의 줄바꿈은 markdown 표가 처리 못 하므로 공백 치환.
                        value = parts[1].replace("\n", " ").strip()
                    else:
                        label = ""
                        value = raw
                    # `|` 가 값에 있으면 표 깨짐 — 이스케이프.
                    value = value.replace("|", "\\|")
                    lines.append(f"| **{label}** | {value} |")
                lines.append("")
            text = (b.get("text") or {}).get("text", "")
            if text:
                lines.append(_slack_link_to_md(text))
                lines.append("")
    return "\n".join(lines).rstrip()

logger = logging.getLogger(__name__)


class MattermostService(NotifyProvider):
    def __init__(self, cfg: MattermostProviderConfig) -> None:
        self._cfg = cfg
        self._bot_user_id: str | None = None

    def is_configured(self) -> bool:
        return bool(self._cfg.base_url and self._cfg.bot_token)

    def _api(self, path: str) -> str:
        base = self._cfg.base_url.rstrip("/")
        return f"{base}/api/v4{path}"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._cfg.bot_token}",
            "Content-Type": "application/json; charset=utf-8",
        }

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
        user_ids = list(user_ids or [])

        if not channels and not user_emails and not user_ids:
            logger.warning("Mattermost: no channels or users to notify; skipping")
            return False

        # blocks 가 있으면 markdown 으로 변환해 게시. 없으면 plain text.
        message = _blocks_to_markdown(blocks) if blocks else text

        delivered = False
        async with httpx.AsyncClient(timeout=cfg.timeout_seconds) as client:
            target_ids: list[str] = []

            # channel name → id
            for ch in channels:
                cid = await self._resolve_channel(client, ch)
                if cid:
                    target_ids.append(cid)

            # email → user_id → DM channel id
            for email in user_emails:
                uid = await self._resolve_user_email(client, email)
                if not uid:
                    continue
                dm = await self._open_dm(client, uid)
                if dm:
                    target_ids.append(dm)

            # 직접 user_id 가 들어오면 DM 채널 생성
            for uid in user_ids:
                dm = await self._open_dm(client, uid)
                if dm:
                    target_ids.append(dm)

            for cid in target_ids:
                ok = await self._post(client, cid, message)
                delivered = delivered or ok

        return delivered

    async def _resolve_channel(self, client: httpx.AsyncClient, name: str) -> str | None:
        """channel name → id. 이미 id 형식(26자 영숫자) 이면 그대로 사용.

        team scoped lookup. team 이 미설정이면 fail (mattermost API 강제).
        """
        name = name.strip().lstrip("#")
        if len(name) == 26 and name.isalnum():
            return name
        if not self._cfg.default_team:
            logger.warning("Mattermost: default_team 미설정 — channel '%s' 해석 불가", name)
            return None
        team = self._cfg.default_team
        try:
            url = self._api(f"/teams/name/{team}/channels/name/{name}")
            r = await client.get(url, headers=self._headers())
            if r.status_code == 200:
                return r.json().get("id")
            logger.warning(
                "Mattermost channel lookup 실패 team=%s name=%s status=%s",
                team, name, r.status_code,
            )
        except Exception as exc:
            logger.warning("Mattermost channel lookup error: %s", exc, exc_info=True)
        return None

    async def _resolve_user_email(self, client: httpx.AsyncClient, email: str) -> str | None:
        try:
            url = self._api(f"/users/email/{email}")
            r = await client.get(url, headers=self._headers())
            if r.status_code == 200:
                return r.json().get("id")
            logger.warning(
                "Mattermost user lookup 실패 email=%s status=%s", email, r.status_code
            )
        except Exception as exc:
            logger.warning("Mattermost user lookup error: %s", exc, exc_info=True)
        return None

    async def _bot_id(self, client: httpx.AsyncClient) -> str | None:
        if self._bot_user_id:
            return self._bot_user_id
        try:
            r = await client.get(self._api("/users/me"), headers=self._headers())
            if r.status_code == 200:
                self._bot_user_id = r.json().get("id")
                return self._bot_user_id
            logger.warning("Mattermost /users/me 실패 status=%s", r.status_code)
        except Exception as exc:
            logger.warning("Mattermost /users/me error: %s", exc, exc_info=True)
        return None

    async def _open_dm(self, client: httpx.AsyncClient, user_id: str) -> str | None:
        bot_id = await self._bot_id(client)
        if not bot_id:
            return None
        try:
            r = await client.post(
                self._api("/channels/direct"),
                json=[bot_id, user_id],
                headers=self._headers(),
            )
            if r.status_code in (200, 201):
                return r.json().get("id")
            logger.warning(
                "Mattermost DM open 실패 user=%s status=%s", user_id, r.status_code
            )
        except Exception as exc:
            logger.warning("Mattermost DM open error: %s", exc, exc_info=True)
        return None

    async def _post(
        self, client: httpx.AsyncClient, channel_id: str, message: str
    ) -> bool:
        try:
            r = await client.post(
                self._api("/posts"),
                json={"channel_id": channel_id, "message": message},
                headers=self._headers(),
            )
            if r.status_code in (200, 201):
                return True
            logger.warning(
                "Mattermost post 실패 channel=%s status=%s body=%s",
                channel_id, r.status_code, r.text[:200],
            )
        except Exception as exc:
            logger.warning("Mattermost post error: %s", exc, exc_info=True)
        return False
