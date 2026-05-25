"""Provider 추상 인터페이스. 어댑터는 이 protocol 을 구현."""

from __future__ import annotations

from typing import AsyncIterator, Protocol, runtime_checkable

from app.services.assistant.types import ChunkEvent, Message, Tool


class ProviderError(Exception):
    """provider 호출 중 복구 불가 오류 — 호출자가 사용자에게 표시."""


class ProviderNotConfigured(ProviderError):
    """API key / model 미설정. UI 에서 설정 안내."""


@runtime_checkable
class LLMProvider(Protocol):
    """모든 LLM 어댑터의 공통 형태.

    `stream()` 은 multi-turn loop 의 1턴(한 번의 모델 호출)을 처리한다.
    오케스트레이터가 결과의 tool_call 이벤트를 받아 도구를 실행하고, tool 결과를
    messages 에 누적해 다시 stream() 을 호출하는 방식. 어댑터는 SDK 별 메시지
    형식을 들고만 있고, 외부에는 정규화 ChunkEvent 만 노출.
    """

    name: str
    model: str

    async def stream(
        self,
        messages: list[Message],
        tools: list[Tool],
        system: str,
    ) -> AsyncIterator[ChunkEvent]:
        ...
