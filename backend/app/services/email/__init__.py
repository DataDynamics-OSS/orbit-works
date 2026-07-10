"""이메일 클라이언트 서비스 — 어댑터·동기화 runner.

설계: docs/email-client-design.md
"""

from app.services.email.registry import ADAPTERS
from app.services.email.runner import RunSummary, run_all, run_one, sync_account

__all__ = ["ADAPTERS", "RunSummary", "run_all", "run_one", "sync_account"]
