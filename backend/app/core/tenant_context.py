"""멀티 테넌트 — 현재 요청의 tenant_id 를 ContextVar 로 전파.

- 미들웨어가 매 요청마다 JWT 의 tenant_id 를 추출해 set 한다.
- SQLAlchemy `before_flush` 이벤트가 INSERT 되는 새 객체의 tenant_id 가 비어
  있으면 이 ContextVar 값으로 채운다 (수동 지정은 그대로 유지).

SUPER_ADMIN 이나 인증 전 요청은 tenant_id=None — 이때 INSERT 가 시도되면
모델의 NOT NULL 제약이 막아준다.
"""

from __future__ import annotations

from contextvars import ContextVar
from uuid import UUID

current_tenant_id: ContextVar[UUID | None] = ContextVar(
    "current_tenant_id", default=None
)
# SUPER_ADMIN 여부 — 이 플래그가 True 면 tenants 테이블 RLS 정책이 모든 row 허용.
# 도메인 테이블의 정책은 `app.tenant_id` 만 본다 — SUPER_ADMIN 도 도메인 데이터
# 비노출 (`get_db()` 가 빈 tenant_id 를 set 하므로).
current_is_super_admin: ContextVar[bool] = ContextVar(
    "current_is_super_admin", default=False
)
# RLS 우회 모드 — 시스템 cron / cross-tenant 작업이 system_session() 안에서 set.
# `after_begin` 이벤트가 매 transaction 시작 시 이 값을 GUC `app.bypass_rls` 로 반영.
current_bypass_rls: ContextVar[bool] = ContextVar(
    "current_bypass_rls", default=False
)
# 현재 user 의 부여(grant)된 feature_key 집합. get_current_user 가 요청 진입 시
# 한 번 로드해 set — `_can_read_report` 같은 hot path 에서 DB 재조회 회피.
# default frozenset() — 비인증/시스템 컨텍스트는 grant 없음.
current_user_grants: ContextVar[frozenset[str]] = ContextVar(
    "current_user_grants", default=frozenset()
)


def set_current_tenant_id(tid: UUID | None) -> None:
    current_tenant_id.set(tid)


def get_current_tenant_id() -> UUID | None:
    return current_tenant_id.get()


def set_current_is_super_admin(flag: bool) -> None:
    current_is_super_admin.set(flag)


def get_current_is_super_admin() -> bool:
    return current_is_super_admin.get()


def set_current_bypass_rls(flag: bool) -> None:
    current_bypass_rls.set(flag)


def get_current_bypass_rls() -> bool:
    return current_bypass_rls.get()


# ---------------------------------------------------------------------------
# tenant_id ↔ slug 캐시 — 로깅 등에서 ID 보다 사람 읽는 slug 가 더 유용.
# slug 는 거의 안 바뀌므로 메모리에 lazy load + tenant CRUD 시 invalidate.
# ---------------------------------------------------------------------------
_slug_cache: dict[UUID, str] = {}
_slug_cache_loaded: bool = False


async def _load_slug_cache() -> None:
    """active tenants 의 (id → slug) 매핑을 메모리에 한 번 로드."""
    global _slug_cache, _slug_cache_loaded
    from sqlalchemy import select

    # 지연 import — 순환참조 방지.
    from app.core.database import system_session
    from app.models.tenant import Tenant

    async with system_session() as db:
        rows = (await db.execute(select(Tenant.id, Tenant.slug))).all()
    _slug_cache = {tid: slug for tid, slug in rows}
    _slug_cache_loaded = True


def invalidate_tenant_slug_cache() -> None:
    """tenants CRUD 후 호출. 다음 lookup 에서 재로드."""
    global _slug_cache, _slug_cache_loaded
    _slug_cache = {}
    _slug_cache_loaded = False


def get_tenant_slug_sync(tid: UUID | None) -> str:
    """현재 캐시된 slug 반환 (DB 조회 X). 캐시 미로드 또는 미존재 시 None.

    동기 함수 — logging filter 같은 hot path 에서 사용.
    """
    if tid is None:
        return ""
    return _slug_cache.get(tid, "")


def get_current_tenant_slug() -> str:
    """현재 요청·작업 컨텍스트의 tenant slug. 없으면 빈 문자열."""
    return get_tenant_slug_sync(current_tenant_id.get())
