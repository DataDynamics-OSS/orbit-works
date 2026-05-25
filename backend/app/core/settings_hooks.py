"""설정 변경 콜백 등록소.

`/api/v1/settings/{section}` PUT 핸들러가 DB 반영 + 캐시 invalidate 후
`dispatch(section)` 을 호출하면 해당 섹션에 등록된 훅이 차례로 실행된다.

서비스별로 반영 방식이 다르다 (scheduler 는 reschedule_job, notify/mail 은
매 호출마다 get_settings() 재참조 등). 각 서비스 모듈이 자신의 갱신 로직을 등록한다.

사용 예:

    from app.core.settings_hooks import on_settings_change

    @on_settings_change("logging")
    def _apply_log_level() -> None:
        import logging
        from app.core.config import get_settings
        logging.getLogger().setLevel(get_settings().logging.level)

섹션 이름은 `Settings` 모델 필드명과 일치 (`scheduler`, `notify`, ...).
하나의 함수가 여러 섹션을 구독하려면 데코레이터를 여러 번 적용.
"""

from __future__ import annotations

import logging
from typing import Callable

logger = logging.getLogger(__name__)

_HOOKS: dict[str, list[Callable[[], None]]] = {}


# ---------------------------------------------------------------------------
# 내장 훅 — logging.level 은 여기서 직접 적용 (다른 모듈이 등록할 필요 없음).
# ---------------------------------------------------------------------------


def _apply_logging_level() -> None:
    from app.core.config import get_settings

    level_name = get_settings().logging.level.upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.getLogger().setLevel(level)
    logger.info("루트 로그 레벨 변경: %s", level_name)


def on_settings_change(section: str) -> Callable[[Callable[[], None]], Callable[[], None]]:
    """지정 섹션 변경 시 호출될 함수를 등록하는 데코레이터."""
    def deco(fn: Callable[[], None]) -> Callable[[], None]:
        _HOOKS.setdefault(section, []).append(fn)
        return fn
    return deco


def dispatch(section: str) -> None:
    """해당 섹션에 등록된 모든 훅을 순서대로 실행. 훅 예외는 로그만 남기고 무시."""
    for fn in _HOOKS.get(section, []):
        try:
            fn()
        except Exception as exc:  # pragma: no cover
            logger.warning("settings hook 실패 (%s / %s): %s", section, fn.__name__, exc, exc_info=True)


# logging 섹션 변경 시 자동으로 root logger 레벨 조정.
on_settings_change("logging")(_apply_logging_level)
