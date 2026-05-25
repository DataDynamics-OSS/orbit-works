"""Gemini provider — google-genai SDK.

Function calling 의미는 OpenAI 와 같지만 SDK 형태가 다름:
- tool 정의: `types.Tool(function_declarations=[FunctionDeclaration(...)])`
- 호출: `model.generate_content_stream(contents, tools=...)`
- 응답: `chunk.candidates[0].content.parts[i]` 가 text 또는 function_call.

prompt caching 은 Gemini 의 implicit caching 으로 자동 적용. explicit
context caching (`client.caches.create`) 은 정적 prefix 가 매우 클 때만 의미가
있어 우선 미사용 — system prompt + tool schema 정도는 implicit 으로 충분.
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from app.services.assistant.provider.base import LLMProvider, ProviderError
from app.services.assistant.types import ChunkEvent, Message, Tool

logger = logging.getLogger(__name__)


def _to_genai_schema(schema: dict) -> dict:
    """OpenAI-style JSON Schema → Gemini schema. 거의 그대로 통과되지만 일부
    필드는 SDK 가 거부 — 안전하게 정제."""
    if not isinstance(schema, dict):
        return {"type": "object"}
    out: dict = {}
    for k in ("type", "description", "enum", "items", "properties", "required"):
        if k in schema:
            v = schema[k]
            if k == "type" and isinstance(v, str):
                # Gemini 는 type 을 UPPERCASE 로 기대하는 버전이 있음.
                out[k] = v
            elif k == "properties" and isinstance(v, dict):
                out[k] = {pk: _to_genai_schema(pv) for pk, pv in v.items()}
            elif k == "items" and isinstance(v, dict):
                out[k] = _to_genai_schema(v)
            else:
                out[k] = v
    return out


class GeminiProvider(LLMProvider):
    name = "gemini"

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
            from google import genai
            from google.genai import types as gt
        except ImportError as exc:  # pragma: no cover
            raise ProviderError(
                "google-genai 패키지가 설치되지 않았습니다. "
                "`pip install google-genai` 후 재시도하세요."
            ) from exc

        client = genai.Client(api_key=self.api_key)

        # tool 변환.
        function_declarations = [
            gt.FunctionDeclaration(
                name=t.name,
                description=t.description,
                parameters=_to_genai_schema(t.parameters),
            )
            for t in tools
        ]
        sdk_tools = (
            [gt.Tool(function_declarations=function_declarations)]
            if function_declarations else None
        )

        # message → genai contents 변환.
        contents: list = []
        for m in messages:
            if m.role == "user":
                contents.append(gt.Content(role="user", parts=[gt.Part(text=m.content or "")]))
            elif m.role == "assistant":
                parts: list = []
                if m.content:
                    parts.append(gt.Part(text=m.content))
                for fc in (m.tool_calls or []):
                    parts.append(gt.Part(function_call=gt.FunctionCall(
                        name=fc["name"], args=fc.get("args") or {},
                    )))
                if parts:
                    contents.append(gt.Content(role="model", parts=parts))
            elif m.role == "tool":
                # Gemini 는 tool 결과를 "function" role 로 받는다.
                result_payload = m.tool_result or {}
                contents.append(gt.Content(
                    role="user",
                    parts=[gt.Part(function_response=gt.FunctionResponse(
                        name=(m.tool_result or {}).get("name", ""),
                        response=result_payload,
                    ))],
                ))

        config = gt.GenerateContentConfig(
            system_instruction=system,
            tools=sdk_tools,
            # 자유로운 tool 호출 결정에 맡김. 모델이 충분히 답할 수 있다고 판단하면
            # 추가 호출 없이 텍스트만 반환.
            tool_config=gt.ToolConfig(
                function_calling_config=gt.FunctionCallingConfig(mode="AUTO")
            ) if sdk_tools else None,
        )

        try:
            stream = await client.aio.models.generate_content_stream(
                model=self.model,
                contents=contents,
                config=config,
            )
        except Exception as exc:
            logger.warning("Gemini 호출 실패: %s", exc, exc_info=True)
            yield ChunkEvent(type="error", data={"reason": f"Gemini 호출 실패: {exc}"})
            return

        usage_in = usage_out = cached = 0
        try:
            async for chunk in stream:
                # 텍스트 / function_call 분리.
                cands = getattr(chunk, "candidates", None) or []
                for cand in cands:
                    parts = getattr(getattr(cand, "content", None), "parts", None) or []
                    for p in parts:
                        text = getattr(p, "text", None)
                        if text:
                            yield ChunkEvent(type="text_delta", data={"text": text})
                        fc = getattr(p, "function_call", None)
                        if fc and getattr(fc, "name", None):
                            args = dict(getattr(fc, "args", {}) or {})
                            yield ChunkEvent(type="tool_call", data={
                                "id": getattr(fc, "id", "") or fc.name,
                                "name": fc.name,
                                "args": args,
                            })
                # usage_metadata 는 마지막 chunk 에 부착되는 경우가 많음.
                um = getattr(chunk, "usage_metadata", None)
                if um is not None:
                    usage_in = int(getattr(um, "prompt_token_count", 0) or 0)
                    usage_out = int(getattr(um, "candidates_token_count", 0) or 0)
                    cached = int(getattr(um, "cached_content_token_count", 0) or 0)
        except Exception as exc:
            logger.warning("Gemini 스트림 중단: %s", exc, exc_info=True)
            yield ChunkEvent(type="error", data={"reason": f"Gemini 스트림 오류: {exc}"})
            return

        yield ChunkEvent(type="usage", data={
            "tokens_in": usage_in, "tokens_out": usage_out, "cached_tokens": cached,
        })
