"""Provider 무관 핵심 타입.

`ChunkEvent` 는 provider 어댑터가 SDK 차이를 흡수해 정규화한 이벤트. 오케스트레이터·
SSE 핸들러·프론트엔드가 모두 이 모양으로 소비. SDK 신구 버전 차이가 새도 이 layer
밖으로는 새지 않음.

Tool handler 는 `(args: dict, ctx: ToolContext) -> Awaitable[dict]`. ctx 에는
요청 사용자·DB 세션이 박혀 있어 기존 service 함수에 그대로 통과시킬 수 있다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User


# ---------------------------------------------------------------------------
# Messages — provider 어댑터가 SDK 형태로 변환해 들고감.
# ---------------------------------------------------------------------------


@dataclass
class Message:
    """대화 한 턴. role 별 의미:

    - user: content 만.
    - assistant: content (자연어 응답) + tool_calls (함수 호출 의도).
    - tool: tool_result (한 tool 호출의 응답). tool_call_id 로 assistant 의 호출과 매칭.
    """

    role: Literal["user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[dict] | None = None  # [{id, name, args}, ...]
    tool_call_id: str | None = None       # role=tool 일 때만
    tool_result: dict | None = None       # role=tool 일 때만 — {result | error}


# ---------------------------------------------------------------------------
# 정규화된 스트리밍 이벤트.
# ---------------------------------------------------------------------------


@dataclass
class ChunkEvent:
    """SSE 로 프론트에 흐를 단일 이벤트.

    type 별 페이로드:
    - text_delta : {"text": "..."}
    - tool_call  : {"id", "name", "args"}   (모델이 호출하기로 결정한 tool)
    - tool_result: {"id", "name", "result"|"error"}  (실행 결과)
    - usage      : {"tokens_in", "tokens_out", "cached_tokens"}
    - done       : {} (이번 stream 정상 종료)
    - error      : {"reason": "..."}
    """

    type: Literal[
        "text_delta", "tool_call", "tool_result", "usage", "done", "error"
    ]
    data: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Tool 레지스트리 — 도메인 1번, 모델 N번.
# ---------------------------------------------------------------------------


@dataclass
class ToolContext:
    """tool handler 에 주입되는 요청 컨텍스트.

    user/db 는 요청 핸들러에서 그대로 통과 → 기존 service 함수와 동일한 권한·
    RLS 가 자동 적용됨. tenant_id 는 user 에서 추출.
    """

    user: User
    db: AsyncSession
    request_id: str = ""

    @property
    def tenant_id(self):
        return self.user.tenant_id


ToolHandler = Callable[[dict, ToolContext], Awaitable[dict]]


@dataclass
class Tool:
    """단일 도구 정의 — provider 무관 형태.

    `parameters` 는 OpenAI function-calling 의 JSON Schema 캐노니컬 형태:
        {"type":"object","properties":{...},"required":[...]}
    각 어댑터가 SDK 별 형태로 변환 (Gemini function_declarations,
    Anthropic tools[].input_schema, OpenAI tools[].function.parameters).
    """

    name: str
    description: str
    parameters: dict
    handler: ToolHandler
    # 권한 스코프 — 빈 set 이면 인증된 사용자 누구나. 그 외엔 user 가 해당
    # role/permission 을 보유해야 호출 가능 (오케스트레이터에서 검사).
    scopes: set[str] = field(default_factory=set)
