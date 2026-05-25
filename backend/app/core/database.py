from collections.abc import AsyncGenerator

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.tenant_context import (
    current_bypass_rls,
    current_is_super_admin,
    current_tenant_id,
)

settings = get_settings()

engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_pre_ping=settings.database.pool_pre_ping,
    pool_size=settings.database.pool_size,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


# ---------------------------------------------------------------------------
# tenant context → PostgreSQL session GUC 동기화
# ---------------------------------------------------------------------------
#
# SQLAlchemy AsyncSession.commit() 은 사용중이던 connection 을 pool 로 반환한다.
# 다음 operation 은 다른 connection 을 차용할 수 있어, session 시작 시 1회만
# `set_config(...)` 했다가는 두 번째 transaction 부터 GUC 가 비어있어 RLS 가
# 의도치 않게 0 row 를 보거나 (SELECT) WITH CHECK 위반을 일으킨다 (INSERT).
#
# 따라서 매 transaction 시작 (`after_begin`) 시 ContextVar 를 읽어 GUC 를 다시
# set 한다. ContextVar:
#   - current_tenant_id: 현재 사용자의 tenant_id (None = SUPER_ADMIN/익명)
#   - current_is_super_admin: SUPER_ADMIN flag
#   - current_bypass_rls: cross-tenant 시스템 작업이 True 로 set
#
# 이 이벤트는 sync 컨텍스트에서 호출되지만 (SQLAlchemy event 시스템이 그렇게
# 호출), connection 은 async 세션의 underlying sync proxy 로 `exec_driver_sql`
# 사용 가능. greenlet 이 async 호출을 중계한다.


@event.listens_for(Session, "after_begin")
def _reapply_tenant_guc(session: Session, transaction, connection) -> None:
    """매 transaction 시작 시 ContextVar → GUC 재적용.

    set_config 의 3번째 인자를 `false` (session-scoped) 로 주는 이유: PostgreSQL
    의 SET LOCAL 은 transaction-scoped 이지만 우리는 transaction 사이에도 같은
    값이 유지되길 원한다 (다음 transaction 시작 시 어차피 다시 set 되지만, 첫
    statement 가 transaction begin 전에 실행되는 케이스도 안전 처리).
    """
    tid = current_tenant_id.get()
    is_super = current_is_super_admin.get()
    bypass = current_bypass_rls.get()

    tid_str = str(tid) if tid else ""
    is_super_str = "true" if is_super else "false"
    bypass_str = "true" if bypass else "false"

    # SQL 인젝션 방지 — UUID/'true'/'false'/'' 외엔 들어올 수 없음.
    # 한 statement 로 묶어 RTT 1회.
    connection.exec_driver_sql(
        f"SELECT set_config('app.tenant_id', '{tid_str}', false), "
        f"set_config('app.is_super_admin', '{is_super_str}', false), "
        f"set_config('app.bypass_rls', '{bypass_str}', false)"
    )


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """일반 요청 세션. ContextVar 는 미들웨어가 JWT 로부터 set 해 둠.

    `after_begin` 이 매 transaction 시작 시 GUC 를 ContextVar 로 재적용하므로
    여기서는 별도 set_config 호출 불필요.
    """
    async with SessionLocal() as session:
        yield session


# 시스템 세션 — 백그라운드 작업·CLI·테스트 등 *요청 컨텍스트가 없는* 코드에서
# SessionLocal() 대신 사용. ContextVar(current_bypass_rls 또는 current_tenant_id)
# 를 일시 set 한 채 세션을 돌리므로 `after_begin` 이 자동으로 GUC 적용.
#
#   async with system_session() as db:               # bypass_rls=true
#       await db.execute(...)
#   async with system_session(tenant_id=tid) as db:  # 그 tenant 컨텍스트
#       await db.execute(...)
#
# 도메인 테이블에 INSERT 시 tenant_id 를 *반드시* 명시해야 한다 (bypass_rls 모드면
# tenant_listener 가 None 컨텍스트라 채우지 못함; tenant 모드면 자동 채움).
class system_session:
    def __init__(self, *, tenant_id: str | None = None) -> None:
        self._tenant_id = tenant_id
        self._sess: AsyncSession | None = None
        # 진입 시점의 ContextVar 토큰 — 빠질 때 reset.
        self._tid_tok = None
        self._bypass_tok = None
        self._super_tok = None

    async def __aenter__(self) -> AsyncSession:
        from uuid import UUID

        if self._tenant_id:
            # tenant 컨텍스트로 진입 — 그 tenant 만 보임 (RLS 정상 적용).
            self._tid_tok = current_tenant_id.set(UUID(self._tenant_id))
            self._bypass_tok = current_bypass_rls.set(False)
        else:
            # 시스템 컨텍스트 — RLS 우회.
            self._tid_tok = current_tenant_id.set(None)
            self._bypass_tok = current_bypass_rls.set(True)
        self._super_tok = current_is_super_admin.set(False)

        self._sess = SessionLocal()
        await self._sess.__aenter__()
        return self._sess

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._sess is not None:
            await self._sess.__aexit__(exc_type, exc, tb)
            self._sess = None
        # ContextVar 복원 — 호출자 컨텍스트(API 요청 등) 가 영향받지 않게.
        if self._super_tok is not None:
            current_is_super_admin.reset(self._super_tok)
            self._super_tok = None
        if self._bypass_tok is not None:
            current_bypass_rls.reset(self._bypass_tok)
            self._bypass_tok = None
        if self._tid_tok is not None:
            current_tenant_id.reset(self._tid_tok)
            self._tid_tok = None
