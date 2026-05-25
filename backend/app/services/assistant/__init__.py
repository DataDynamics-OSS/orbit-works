"""대화형 어시스턴트 (Gemini / Claude / OpenAI 통합).

Provider 별 차이는 `provider/<name>.py` 어댑터에 격리하고, 도메인 tool 은
`tools/` 하위에 한 번만 정의 — 모든 provider 가 같은 tool 레지스트리를 본다.
오케스트레이터가 multi-turn tool-calling 루프를 정규화 ChunkEvent 스트림으로
노출.
"""

from app.services.assistant.orchestrator import stream_chat
from app.services.assistant.registry import ToolRegistry, registry
from app.services.assistant.types import (
    ChunkEvent,
    Message,
    Tool,
    ToolContext,
)

__all__ = [
    "ChunkEvent",
    "Message",
    "Tool",
    "ToolContext",
    "ToolRegistry",
    "registry",
    "stream_chat",
]
