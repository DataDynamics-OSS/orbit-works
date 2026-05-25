"""Pure ASGI 미들웨어 — JWT 의 tenant_id 를 ContextVar 에 주입.

이전 구현은 `BaseHTTPMiddleware` 를 상속했는데, Starlette 의 알려진 이슈로
`BaseHTTPMiddleware.dispatch` 내부에서 `ContextVar.set()` 한 값이 ASGI 호출자
task (uvicorn 의 HTTP cycle task) 까지 전파되지 않는다. 결과적으로
`uvicorn.access` 로그 emit 시점에 ContextVar 가 None 으로 보여 `[-]` 만 찍히는
문제 발생.

Pure ASGI middleware 는 추가 task 를 spawn 하지 않아 같은 task 안에서
ContextVar 를 set → 라우터 + access log emit 양쪽 모두 일관되게 본다.

토큰이 없거나 invalid 한 요청(login, healthz 등)은 ContextVar=None 유지 —
그런 요청은 도메인 모델 INSERT 를 시도하지 않으므로 NOT NULL 제약이 막아준다.
"""

from __future__ import annotations

from uuid import UUID

from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.security import decode_token
from app.core.tenant_context import set_current_is_super_admin, set_current_tenant_id


class TenantContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # HTTP 외 lifespan/websocket 은 pass-through. ContextVar 변경은 HTTP 요청
        # 경계에서만 일어나도 충분 — websocket 인증이 들어오면 그때 확장.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        tid: UUID | None = None
        is_super = False
        # ASGI scope 의 headers 는 list[tuple[bytes, bytes]] 로 이름은 lowercase.
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                auth = value.decode("latin-1")
                if auth.lower().startswith("bearer "):
                    token = auth[7:].strip()
                    try:
                        payload = decode_token(token)
                        raw = payload.get("tenant_id")
                        if raw:
                            try:
                                tid = UUID(str(raw))
                            except ValueError:
                                tid = None
                        if payload.get("role") == "SUPER_ADMIN":
                            is_super = True
                    except Exception:
                        tid = None
                        is_super = False
                break

        set_current_tenant_id(tid)
        set_current_is_super_admin(is_super)
        await self.app(scope, receive, send)
