"""OpenAI provider — 자동 prompt caching 활성 (system + tool schemas 가
1024+ 토큰 prefix 면 자동 50% 할인). 별도 토글 없음.

base_url 을 지정하면 OpenAI 호환 endpoint (Ollama, vLLM, LM Studio 등) 로
라우팅. cached_tokens · prompt caching 동작은 서버 스펙 준수 여부에 달림.
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from app.services.assistant.provider.base import LLMProvider, ProviderError
from app.services.assistant.types import ChunkEvent, Message, Tool

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, *, api_key: str, model: str, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url or None

    async def stream(
        self,
        messages: list[Message],
        tools: list[Tool],
        system: str,
    ) -> AsyncIterator[ChunkEvent]:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover
            raise ProviderError(
                "openai 패키지가 설치되지 않았습니다."
            ) from exc

        client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)

        sdk_tools = [{
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters or {"type": "object", "properties": {}},
            },
        } for t in tools]

        sdk_messages: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            if m.role == "user":
                sdk_messages.append({"role": "user", "content": m.content or ""})
            elif m.role == "assistant":
                msg: dict = {"role": "assistant", "content": m.content or ""}
                if m.tool_calls:
                    msg["tool_calls"] = [{
                        "id": fc["id"],
                        "type": "function",
                        "function": {
                            "name": fc["name"],
                            "arguments": json.dumps(fc.get("args") or {}),
                        },
                    } for fc in m.tool_calls]
                sdk_messages.append(msg)
            elif m.role == "tool":
                result = m.tool_result or {}
                payload = result.get("result") if "result" in result else result
                sdk_messages.append({
                    "role": "tool",
                    "tool_call_id": m.tool_call_id or result.get("id", ""),
                    "content": json.dumps(payload, ensure_ascii=False),
                })

        try:
            stream = await client.chat.completions.create(
                model=self.model,
                messages=sdk_messages,
                tools=sdk_tools or None,
                stream=True,
                stream_options={"include_usage": True},
            )
        except Exception as exc:
            logger.warning("OpenAI 호출 실패: %s", exc, exc_info=True)
            yield ChunkEvent(type="error", data={"reason": f"OpenAI 호출 실패: {exc}"})
            return

        # tool_call 은 delta 로 쪼개져 옴 — index 별로 누적.
        tool_acc: dict[int, dict] = {}
        async for chunk in stream:
            choices = getattr(chunk, "choices", None) or []
            for ch in choices:
                delta = getattr(ch, "delta", None)
                if delta is None:
                    continue
                if getattr(delta, "content", None):
                    yield ChunkEvent(type="text_delta", data={"text": delta.content})
                tcs = getattr(delta, "tool_calls", None) or []
                for tc in tcs:
                    idx = getattr(tc, "index", 0)
                    acc = tool_acc.setdefault(idx, {"id": "", "name": "", "args": ""})
                    if getattr(tc, "id", None):
                        acc["id"] = tc.id
                    fn = getattr(tc, "function", None)
                    if fn is not None:
                        if getattr(fn, "name", None):
                            acc["name"] = fn.name
                        if getattr(fn, "arguments", None):
                            acc["args"] += fn.arguments
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                cached = 0
                ptd = getattr(usage, "prompt_tokens_details", None)
                if ptd is not None:
                    cached = int(getattr(ptd, "cached_tokens", 0) or 0)
                yield ChunkEvent(type="usage", data={
                    "tokens_in": int(getattr(usage, "prompt_tokens", 0) or 0),
                    "tokens_out": int(getattr(usage, "completion_tokens", 0) or 0),
                    "cached_tokens": cached,
                })

        # stream 종료 후 누적된 tool_call 들을 한 번에 emit.
        for acc in tool_acc.values():
            if not acc["name"]:
                continue
            try:
                args_obj = json.loads(acc["args"] or "{}")
            except Exception:
                args_obj = {}
            yield ChunkEvent(type="tool_call", data={
                "id": acc["id"] or acc["name"],
                "name": acc["name"],
                "args": args_obj,
            })
