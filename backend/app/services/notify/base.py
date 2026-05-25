"""알람 provider 추상 인터페이스.

신규 provider 추가 시 이 ABC 를 구현 + `notify/__init__.py` 의 dispatcher 분기에 등록.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class NotifyProvider(ABC):
    @abstractmethod
    def is_configured(self) -> bool:
        """필수 자격증명이 모두 채워졌는지. False 면 dispatcher 가 발송 스킵."""

    @abstractmethod
    async def send(
        self,
        text: str,
        *,
        channels: list[str] | None = None,
        user_emails: list[str] | None = None,
        user_ids: list[str] | None = None,
        blocks: list[dict[str, Any]] | None = None,
    ) -> bool:
        """text 를 channels/users 에 발송. 부분 성공도 True (best-effort)."""
