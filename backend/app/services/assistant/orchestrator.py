"""Multi-turn tool-calling 루프. provider 와 도구 레지스트리를 잇는다.

흐름:
  1. provider.stream(messages, tools, system) 호출 → 정규화 ChunkEvent 수신
  2. text_delta 는 그대로 패스스루.
  3. tool_call 이벤트가 오면:
        a) 즉시 호출 결과를 등록(레지스트리.invoke)
        b) tool_result 이벤트 발행 (UI 가 카드 표시)
        c) messages 에 assistant tool_calls + tool result 누적
        d) 다음 turn 으로 break
  4. 추가 tool_call 없이 done 이면 종료.
  5. max_turns 초과면 error.
"""

from __future__ import annotations

import logging
import uuid
from typing import AsyncIterator

from app.core.config import get_tenant_section
from app.services.assistant.provider import (
    ProviderError,
    ProviderNotConfigured,
    get_provider,
)
from app.services.assistant.registry import import_all, registry
from app.services.assistant.types import ChunkEvent, Message, ToolContext

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """당신은 'Orbit Works' (인력·프로젝트·영업·청구·급여·라이센스·클라우드비용 통합 운영 SaaS) 의 사내 AI 어시스턴트입니다.

원칙:
1. 사용자의 질문에 답하기 위해 필요한 데이터는 반드시 제공된 도구 (function/tool calling) 로 가져오세요. 직접 추측·창작하지 않습니다.
2. 답은 항상 한국어로 간결하게. 숫자에는 단위(₩, 일 등) 와 천단위 콤마를 표시하세요.
3. 모르거나 도구로도 알 수 없는 정보는 솔직히 "확인할 수 없습니다" 라고 답하세요.
4. 클라우드 비용 질의는 KRW 기준입니다. 환율이 적용되지 않은 일부 row 는 0 으로 잡힐 수 있음을 인지하고, 데이터가 비어있어 보이면 `get_last_fetch_status` 로 수집 상태를 확인하세요.
5. 사용자 권한 밖의 정보는 도구 호출 자체가 거부됩니다 — 그 경우 사용자에게 권한 부족을 안내하세요.
"""


async def stream_chat(
    *,
    user_message: str,
    history: list[Message],
    ctx: ToolContext,
    provider_name: str | None = None,
) -> AsyncIterator[ChunkEvent]:
    """대화 1턴 (사용자 메시지 1개에 대한 응답) 을 SSE 이벤트로 흘림.

    `history` 는 이전 user/assistant/tool 메시지들. 호출자가 영속화/메모리 중
    선택. 새 사용자 메시지는 함수 안에서 history 에 append.
    """
    import_all()  # 첫 호출 시 도구 등록.

    cfg = await get_tenant_section(ctx.tenant_id, "assistant")
    if not cfg.get("enabled"):
        yield ChunkEvent(type="error", data={"reason": "어시스턴트 비활성"})
        return
    max_turns = int(cfg.get("max_turns", 5) or 5)

    try:
        provider = await get_provider(ctx.tenant_id, provider_name)
    except ProviderNotConfigured as exc:
        yield ChunkEvent(type="error", data={"reason": str(exc)})
        return
    except ProviderError as exc:
        yield ChunkEvent(type="error", data={"reason": str(exc)})
        return

    tools = registry.all_for(ctx.user.role)
    messages = list(history) + [Message(role="user", content=user_message)]

    for turn in range(max_turns):
        invoked_any = False
        async for ev in provider.stream(messages, tools, SYSTEM_PROMPT):
            if ev.type == "tool_call":
                invoked_any = True
                tc_id = ev.data.get("id") or str(uuid.uuid4())
                name = ev.data.get("name", "")
                args = ev.data.get("args") or {}
                yield ev  # UI 에 "도구 호출 중" 표시
                result = await registry.invoke(name, args, ctx)
                # 자기 자리(messages)에 누적 — 다음 turn 의 모델 호출에 그대로 들어감.
                messages.append(Message(
                    role="assistant",
                    tool_calls=[{"id": tc_id, "name": name, "args": args}],
                ))
                messages.append(Message(
                    role="tool",
                    tool_call_id=tc_id,
                    tool_result={"id": tc_id, "name": name, **(
                        {"error": result["error"]} if isinstance(result, dict) and "error" in result
                        else {"result": result}
                    )},
                ))
                yield ChunkEvent(type="tool_result", data={
                    "id": tc_id, "name": name, "result": result,
                })
            elif ev.type == "error":
                yield ev
                return
            else:
                yield ev
        if not invoked_any:
            yield ChunkEvent(type="done")
            return

    yield ChunkEvent(type="error", data={"reason": f"max_turns({max_turns}) 초과"})
