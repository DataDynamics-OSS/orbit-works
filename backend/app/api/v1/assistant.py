"""대화형 어시스턴트 API — SSE 스트리밍 chat + 대화 영속화.

Endpoints:
- POST   /assistant/chat                    — SSE 응답. body: {message, conversation_id?, provider?}
- GET    /assistant/conversations           — 내 대화 목록 (최근순)
- GET    /assistant/conversations/{id}      — 단일 대화 + 메시지
- DELETE /assistant/conversations/{id}      — 대화 삭제
- GET    /assistant/tools                   — 등록된 도구 목록 (디버그/문서)

영속화는 `assistant.persist_conversations=true` 일 때만 — false 면 conversation_id
파라미터가 들어와도 무시하고 휘발 메모리만 사용.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict, deque
from typing import AsyncIterator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_tenant_section
from app.core.database import get_db
from app.models import AssistantConversation, AssistantMessage, User
from app.services.assistant import (
    ChunkEvent,
    Message,
    ToolContext,
    registry,
    stream_chat,
)
from app.services.assistant.registry import import_all

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/assistant", tags=["assistant"])


# ---------------------------------------------------------------------------
# Rate limit — 사용자 단위 in-memory 슬라이딩 윈도우 (분 단위).
# ---------------------------------------------------------------------------
_rate_window: dict[str, deque[float]] = defaultdict(deque)


def _rate_limit_check(user_id, limit_per_min: int) -> bool:
    if limit_per_min <= 0:
        return True
    now = time.monotonic()
    dq = _rate_window[str(user_id)]
    cutoff = now - 60.0
    while dq and dq[0] < cutoff:
        dq.popleft()
    if len(dq) >= limit_per_min:
        return False
    dq.append(now)
    return True


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: UUID | None = None
    provider: str | None = None  # 강제 provider — 미지정 시 default_provider


class MessageOut(BaseModel):
    id: UUID
    role: str
    content: str | None
    tool_calls: list | None
    tool_result: dict | None
    tokens_in: int | None
    tokens_out: int | None
    cached_tokens: int | None
    created_at: str

    @classmethod
    def from_model(cls, m: AssistantMessage) -> "MessageOut":
        return cls(
            id=m.id,
            role=m.role,
            content=m.content,
            tool_calls=m.tool_calls,
            tool_result=m.tool_result,
            tokens_in=m.tokens_in,
            tokens_out=m.tokens_out,
            cached_tokens=m.cached_tokens,
            created_at=m.created_at.isoformat(),
        )


class ConversationOut(BaseModel):
    id: UUID
    title: str | None
    provider: str | None
    model: str | None
    created_at: str
    updated_at: str
    messages: list[MessageOut] | None = None


# ---------------------------------------------------------------------------
# 도구 목록 (디버그)
# ---------------------------------------------------------------------------


@router.get("/tools")
async def list_tools(user: User = Depends(get_current_user)) -> dict:
    import_all()
    tools = registry.all_for(user.role)
    return {
        "tools": [
            {"name": t.name, "description": t.description, "parameters": t.parameters}
            for t in tools
        ]
    }


# ---------------------------------------------------------------------------
# SSE chat
# ---------------------------------------------------------------------------


def _sse(ev: ChunkEvent) -> bytes:
    payload = json.dumps({"type": ev.type, "data": ev.data}, ensure_ascii=False)
    return f"data: {payload}\n\n".encode("utf-8")


async def _load_history(
    db: AsyncSession, conversation_id: UUID, user: User
) -> tuple[AssistantConversation | None, list[Message]]:
    row = (await db.execute(
        select(AssistantConversation).where(
            AssistantConversation.id == conversation_id,
            AssistantConversation.user_id == user.id,
        )
    )).scalar_one_or_none()
    if row is None:
        return None, []
    msg_rows = list((await db.execute(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conversation_id)
        .order_by(AssistantMessage.created_at)
    )).scalars())
    history: list[Message] = []
    for m in msg_rows:
        if m.role == "user":
            history.append(Message(role="user", content=m.content or ""))
        elif m.role == "assistant":
            history.append(Message(
                role="assistant",
                content=m.content,
                tool_calls=m.tool_calls,
            ))
        elif m.role == "tool":
            tr = m.tool_result or {}
            history.append(Message(
                role="tool",
                tool_call_id=tr.get("id"),
                tool_result=tr,
            ))
    return row, history


@router.post("/chat")
async def chat(
    body: ChatRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cfg = await get_tenant_section(user.tenant_id, "assistant")
    if not cfg.get("enabled"):
        raise HTTPException(503, detail="어시스턴트가 비활성 상태입니다.")
    if not _rate_limit_check(user.id, int(cfg.get("rate_limit_per_minute") or 0)):
        raise HTTPException(429, detail="요청이 너무 잦습니다. 잠시 후 다시 시도하세요.")

    persist = bool(cfg.get("persist_conversations"))
    convo: AssistantConversation | None = None
    history: list[Message] = []

    if persist and body.conversation_id is not None:
        convo, history = await _load_history(db, body.conversation_id, user)
        if convo is None:
            raise HTTPException(404, detail="대화를 찾을 수 없습니다.")

    if persist and convo is None:
        # 새 대화 생성 — 첫 사용자 메시지에서 title 자동 추출 (앞 60자).
        title = (body.message or "").strip().splitlines()[0][:60]
        convo = AssistantConversation(
            tenant_id=user.tenant_id,
            user_id=user.id,
            title=title or None,
        )
        db.add(convo)
        await db.flush()
        db.add(AssistantMessage(
            conversation_id=convo.id, tenant_id=user.tenant_id,
            role="user", content=body.message,
        ))
        await db.commit()

    elif persist and convo is not None:
        db.add(AssistantMessage(
            conversation_id=convo.id, tenant_id=user.tenant_id,
            role="user", content=body.message,
        ))
        await db.commit()

    ctx = ToolContext(user=user, db=db)

    async def gen() -> AsyncIterator[bytes]:
        # conversation_id 가 새로 생긴 경우 첫 chunk 로 알린다.
        if convo is not None:
            yield _sse(ChunkEvent(
                type="usage",  # 별도 channel 만들기 보다 usage 와 같은 metadata 채널 활용
                data={"conversation_id": str(convo.id)},
            ))

        # provider/model 추적용 + 영속화 로컬 누적.
        last_assistant_text: list[str] = []
        last_provider: str | None = None
        last_model: str | None = None
        usage_in = usage_out = cached = 0
        # 영속화: tool 호출 / 결과 row 도 같이 남긴다.
        pending_tool_calls: list[dict] = []
        new_msgs: list[AssistantMessage] = []

        try:
            async for ev in stream_chat(
                user_message=body.message,
                history=history,
                ctx=ctx,
                provider_name=body.provider,
            ):
                if ev.type == "text_delta":
                    last_assistant_text.append(ev.data.get("text", ""))
                elif ev.type == "tool_call":
                    pending_tool_calls.append({
                        "id": ev.data.get("id"),
                        "name": ev.data.get("name"),
                        "args": ev.data.get("args"),
                    })
                elif ev.type == "tool_result":
                    # tool_call 발생 시점에 누적된 텍스트 + tool_calls 를 1개 assistant row 로 마감.
                    if persist and convo is not None:
                        if last_assistant_text or pending_tool_calls:
                            new_msgs.append(AssistantMessage(
                                conversation_id=convo.id, tenant_id=user.tenant_id,
                                role="assistant",
                                content="".join(last_assistant_text) or None,
                                tool_calls=list(pending_tool_calls) or None,
                            ))
                            last_assistant_text.clear()
                        # tool 응답을 별도 row 로.
                        new_msgs.append(AssistantMessage(
                            conversation_id=convo.id, tenant_id=user.tenant_id,
                            role="tool",
                            tool_result={
                                "id": ev.data.get("id"),
                                "name": ev.data.get("name"),
                                "result": ev.data.get("result"),
                            },
                        ))
                        pending_tool_calls = [
                            tc for tc in pending_tool_calls
                            if tc.get("id") != ev.data.get("id")
                        ]
                elif ev.type == "usage":
                    usage_in += int(ev.data.get("tokens_in") or 0)
                    usage_out += int(ev.data.get("tokens_out") or 0)
                    cached += int(ev.data.get("cached_tokens") or 0)
                yield _sse(ev)

            # 종료 후 마지막 assistant 텍스트 저장.
            if persist and convo is not None and (last_assistant_text or pending_tool_calls):
                new_msgs.append(AssistantMessage(
                    conversation_id=convo.id, tenant_id=user.tenant_id,
                    role="assistant",
                    content="".join(last_assistant_text) or None,
                    tool_calls=list(pending_tool_calls) or None,
                    tokens_in=usage_in or None,
                    tokens_out=usage_out or None,
                    cached_tokens=cached or None,
                    provider=last_provider,
                    model=last_model,
                ))
        except Exception as exc:  # pragma: no cover
            logger.warning("어시스턴트 스트림 오류: %s", exc, exc_info=True)
            yield _sse(ChunkEvent(type="error", data={"reason": str(exc)}))
        finally:
            if persist and convo is not None and new_msgs:
                for m in new_msgs:
                    db.add(m)
                try:
                    await db.commit()
                except Exception as exc:
                    logger.warning("어시스턴트 메시지 영속화 실패: %s", exc, exc_info=True)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx proxy buffering off
        },
    )


# ---------------------------------------------------------------------------
# Conversations CRUD
# ---------------------------------------------------------------------------


@router.get("/conversations", response_model=list[ConversationOut])
async def list_conversations(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = 50,
):
    rows = list((await db.execute(
        select(AssistantConversation)
        .where(AssistantConversation.user_id == user.id)
        .order_by(AssistantConversation.updated_at.desc())
        .limit(min(max(limit, 1), 200))
    )).scalars())
    return [
        ConversationOut(
            id=r.id, title=r.title, provider=r.provider, model=r.model,
            created_at=r.created_at.isoformat(),
            updated_at=r.updated_at.isoformat(),
        ) for r in rows
    ]


@router.get("/conversations/{conv_id}", response_model=ConversationOut)
async def get_conversation(
    conv_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (await db.execute(
        select(AssistantConversation).where(
            AssistantConversation.id == conv_id,
            AssistantConversation.user_id == user.id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, detail="대화를 찾을 수 없습니다.")
    msgs = list((await db.execute(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conv_id)
        .order_by(AssistantMessage.created_at)
    )).scalars())
    return ConversationOut(
        id=row.id, title=row.title, provider=row.provider, model=row.model,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
        messages=[MessageOut.from_model(m) for m in msgs],
    )


@router.delete("/conversations/{conv_id}", status_code=204)
async def delete_conversation(
    conv_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = (await db.execute(
        select(AssistantConversation).where(
            AssistantConversation.id == conv_id,
            AssistantConversation.user_id == user.id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, detail="대화를 찾을 수 없습니다.")
    await db.delete(row)
    await db.commit()
