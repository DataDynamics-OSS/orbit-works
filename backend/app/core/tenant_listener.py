"""SQLAlchemy 이벤트 — 새 객체 INSERT 시 tenant_id 자동 채움.

`session.add(obj)` 한 객체 중 tenant_id 가 비어 있고, 모델이 tenant_id 컬럼을
가지면, ContextVar 의 current_tenant_id 로 자동 채운다. 이미 명시적으로
tenant_id 를 지정한 경우 (예: SUPER_ADMIN 이 /tenants 에서 다른 tenant 의 admin
유저를 만들 때) 그 값을 보존.

flush 직전에 동작 — relationship cascade 로 추가된 자식 객체에도 적용됨.
"""

from __future__ import annotations

import logging

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.tenant_context import get_current_tenant_id

logger = logging.getLogger(__name__)


def _has_tenant_id(obj: object) -> bool:
    return "tenant_id" in getattr(obj.__class__, "__table__", type(None)).columns  # type: ignore[union-attr]


@event.listens_for(Session, "before_flush")
def _auto_fill_tenant(session: Session, _flush_context, _instances) -> None:
    tid = get_current_tenant_id()
    if tid is None:
        return
    for obj in session.new:
        # 모델 클래스가 tenant_id 컬럼을 보유하는지 확인 (TenantMixin 적용 여부).
        try:
            cols = obj.__class__.__table__.columns  # type: ignore[attr-defined]
        except AttributeError:
            continue
        if "tenant_id" not in cols:
            continue
        if getattr(obj, "tenant_id", None) is None:
            obj.tenant_id = tid


def install_tenant_listener() -> None:
    """`from app.core.tenant_listener import install_tenant_listener` 한 번만 호출.

    데코레이터가 import 시점에 자동 등록하지만, 명시적 install 함수를 두어
    main.py 에서 호출 누락 시 정적 분석으로 잡을 수 있게 한다."""
    # event.listens_for 가 이미 module import 시 등록함. 별도 작업 없음.
    logger.debug("tenant_listener installed")
