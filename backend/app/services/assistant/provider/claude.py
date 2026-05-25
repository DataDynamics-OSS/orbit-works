"""Claude provider — anthropic SDK + prompt caching.

Anthropic 의 prompt caching 은 명시적으로 `cache_control: {"type":"ephemeral"}` 을
시스템/도구 메시지의 마지막 블록에 붙여 활성화. cache hit 시 입력 토큰 비용
90% 감면. 우리 stream 은 system + tools 를 매번 동일하게 보내므로 거의 항상 hit.
"""

from __future__ import annotations

import logging
from typing import AsyncIterator

from app.services.assistant.provider.base import LLMProvider, ProviderError
from app.services.assistant.types import ChunkEvent, Message, Tool

logger = logging.getLogger(__name__)


class ClaudeProvider(LLMProvider):
    name = "claude"

    def __init__(self, *, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def stream(
        self,
        messages: list[Message],
        tools: list[Tool],
        system: str,
    ) -> AsyncIterator[ChunkEvent]:
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:  # pragma: no cover
            raise ProviderError(
                "anthropic 패키지가 설치되지 않았습니다."
            ) from exc

        client = AsyncAnthropic(api_key=self.api_key)

        # tool 변환 — 마지막 도구에 cache_control 부착해 prefix 캐싱 트리거.
        sdk_tools: list[dict] = []
        for i, t in enumerate(tools):
            entry: dict = {
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters or {"type": "object", "properties": {}},
            }
            if i == len(tools) - 1 and tools:
                entry["cache_control"] = {"type": "ephemeral"}
            sdk_tools.append(entry)

        # 메시지 변환.
        sdk_messages: list[dict] = []
        for m in messages:
            if m.role == "user":
                sdk_messages.append({"role": "user", "content": m.content or ""})
            elif m.role == "assistant":
                blocks: list[dict] = []
                if m.content:
                    blocks.append({"type": "text", "text": m.content})
                for fc in (m.tool_calls or []):
                    blocks.append({
                        "type": "tool_use",
                        "id": fc["id"],
                        "name": fc["name"],
                        "input": fc.get("args") or {},
                    })
                if blocks:
                    sdk_messages.append({"role": "assistant", "content": blocks})
            elif m.role == "tool":
                # Claude 는 tool 결과를 user role 안의 tool_result 블록으로.
                result = m.tool_result or {}
                payload = result.get("result") if "result" in result else result
                is_error = "error" in result
                sdk_messages.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id or result.get("id", ""),
                        "content": str(payload) if not isinstance(payload, str) else payload,
                        "is_error": is_error,
                    }],
                })

        # system 도 cache_control 로 캐시.
        system_blocks = [{
            "type": "text",
            "text": system,
            "cache_control": {"type": "ephemeral"},
        }]

        try:
            async with client.messages.stream(
                model=self.model,
                max_tokens=4096,
                system=system_blocks,
                tools=sdk_tools or [],
                messages=sdk_messages,
            ) as stream:
                pending_tool_call: dict | None = None
                async for event in stream:
                    et = getattr(event, "type", "")
                    if et == "content_block_start":
                        cb = getattr(event, "content_block", None)
                        if cb and getattr(cb, "type", "") == "tool_use":
                            pending_tool_call = {
                                "id": cb.id,
                                "name": cb.name,
                                "args": "",  # JSON delta accumulator
                            }
                    elif et == "content_block_delta":
                        delta = getattr(event, "delta", None)
                        if delta is None:
                            continue
                        dt = getattr(delta, "type", "")
                        if dt == "text_delta":
                            yield ChunkEvent(type="text_delta", data={"text": delta.text})
                        elif dt == "input_json_delta" and pending_tool_call is not None:
                            pending_tool_call["args"] += getattr(delta, "partial_json", "") or ""
                    elif et == "content_block_stop":
                        if pending_tool_call is not None:
                            try:
                                import json
                                args_obj = json.loads(pending_tool_call["args"] or "{}")
                            except Exception:
                                args_obj = {}
                            yield ChunkEvent(type="tool_call", data={
                                "id": pending_tool_call["id"],
                                "name": pending_tool_call["name"],
                                "args": args_obj,
                            })
                            pending_tool_call = None
                final = await stream.get_final_message()
                u = getattr(final, "usage", None)
                if u is not None:
                    yield ChunkEvent(type="usage", data={
                        "tokens_in": int(getattr(u, "input_tokens", 0) or 0),
                        "tokens_out": int(getattr(u, "output_tokens", 0) or 0),
                        "cached_tokens": int(
                            (getattr(u, "cache_read_input_tokens", 0) or 0)
                            + (getattr(u, "cache_creation_input_tokens", 0) or 0)
                        ),
                    })
        except Exception as exc:
            logger.warning("Claude 호출 실패: %s", exc, exc_info=True)
            yield ChunkEvent(type="error", data={"reason": f"Claude 호출 실패: {exc}"})
