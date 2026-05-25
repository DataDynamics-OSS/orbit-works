"""로깅 filter — `LogRecord` 에 `tenant` 속성 자동 주입.

format string 에 `%(tenant)s` 를 쓰면 현재 ContextVar(current_tenant_id) 의
slug 가 들어간다. 시스템 cron·부팅·login 이전 등 ContextVar 미설정 컨텍스트는
"-" 로 표시.

slug 가 캐시에 없으면 (캐시 미로드 또는 신규 tenant) UUID 의 짧은 prefix 를
fallback 으로 표기 (`?abc123`).

사용:
    handler.addFilter(TenantLogFilter())
    formatter = logging.Formatter("%(asctime)s %(levelname)s [%(tenant)s] [%(name)s] %(message)s")
"""

from __future__ import annotations

import logging

from app.core.tenant_context import current_tenant_id, get_tenant_slug_sync


class TenantLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        tid = current_tenant_id.get()
        if tid is None:
            record.tenant = "-"
        else:
            slug = get_tenant_slug_sync(tid)
            if slug:
                record.tenant = slug
            else:
                # 캐시 미로드 또는 신규 tenant — UUID 앞 6자만.
                record.tenant = f"?{str(tid)[:6]}"
        return True
