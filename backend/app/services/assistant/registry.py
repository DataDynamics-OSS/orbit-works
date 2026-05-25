"""도구 레지스트리 — provider 가 인식할 수 있도록 캐노니컬 JSON Schema 보존.

신규 tool 추가는 `tools/<area>.py` 안에서 `registry.register(Tool(...))` 만 호출.
각 모듈은 `tools/__init__.py` 의 `import_all()` 에서 1회 import 되어 부작용으로
등록을 마친다.
"""

from __future__ import annotations

import logging
from typing import Iterable

from app.services.assistant.types import Tool, ToolContext

logger = logging.getLogger(__name__)


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            # 중복 등록은 dev 환경 hot-reload 에선 빈번. 경고만 찍고 덮어쓴다.
            logger.debug("어시스턴트 도구 재등록: %s", tool.name)
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all_for(self, user_role: str) -> list[Tool]:
        """이 user_role 이 호출 가능한 도구만 반환 — 모델 prompt 에 노출되는 set 도 좁힌다.

        scopes 가 비어있는 도구 = 모두 허용. 그 외에는 role-based permission
        매트릭스(`app.core.roles`) 와 교집합 검사.
        """
        from app.core.roles import has as role_has

        out: list[Tool] = []
        for t in self._tools.values():
            if not t.scopes:
                out.append(t)
                continue
            if all(role_has(user_role, s) for s in t.scopes):
                out.append(t)
        return out

    def names(self) -> Iterable[str]:
        return self._tools.keys()

    async def invoke(self, name: str, args: dict, ctx: ToolContext) -> dict:
        """도구 실행 — 미등록 / 권한 부족이면 dict 형태 error 반환 (예외 X).

        예외를 raise 하지 않는 이유: orchestrator 가 결과를 다시 모델에 넣어야
        하므로 어떤 실패도 직렬화 가능한 dict 여야 함.
        """
        from app.core.roles import has as role_has

        tool = self._tools.get(name)
        if tool is None:
            return {"error": f"unknown tool: {name}"}
        for scope in tool.scopes:
            if not role_has(ctx.user.role, scope):
                return {"error": f"permission denied (scope={scope})"}
        try:
            return await tool.handler(args or {}, ctx)
        except Exception as exc:  # pragma: no cover — model 에 전달
            logger.warning("도구 실행 실패: %s args=%s", name, args, exc_info=True)
            return {"error": f"{type(exc).__name__}: {exc}"}


# 모듈 레벨 싱글턴 — import 해서 사용.
registry = ToolRegistry()


def import_all() -> None:
    """모든 도구 모듈을 한 번 import 하여 register 부작용을 발생시킨다.

    `app.api.v1.assistant` 라우터 import 시점, 또는 main.py 의 lifespan 에서 호출.
    """
    # 도메인이 늘 때마다 여기에 추가. 순서는 무관.
    from app.services.assistant.tools import cloud_cost as _cc  # noqa: F401
