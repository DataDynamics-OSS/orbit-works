import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from app.core.config import get_settings
from app.core.logging_filter import TenantLogFilter

_configured = False


def setup_logging() -> None:
    global _configured
    if _configured:
        return

    cfg = get_settings().logging
    log_dir = Path(cfg.dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(cfg.format, datefmt=cfg.date_format)
    level = getattr(logging, cfg.level.upper(), logging.INFO)

    # ContextVar(current_tenant_id) → slug 를 모든 LogRecord 에 주입.
    # format string 에 `%(tenant)s` 가 들어 있어야 노출됨.
    tenant_filter = TenantLogFilter()

    file_handler = TimedRotatingFileHandler(
        log_dir / cfg.filename,
        when="midnight",
        interval=1,
        backupCount=cfg.backup_count,
        encoding="utf-8",
        utc=False,
    )
    file_handler.suffix = "%Y-%m-%d"
    file_handler.setFormatter(formatter)
    file_handler.addFilter(tenant_filter)

    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(file_handler)

    if cfg.console:
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(formatter)
        stream.addFilter(tenant_filter)
        root.addHandler(stream)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
        lg.setLevel(level)

    _configured = True
