"""클라우드 비용 수집 — AWS / Azure / GCP 통합.

상위 entry:
- `get_providers(cfg)` — cfg dict 의 enabled provider 인스턴스 dict.
- `fetch_and_upsert_daily(...)` — 1 provider 1일치 수집 + 이력 기록.
- `upsert_costs(...)` — 외부에서 DTO 리스트만 갖고 직접 upsert 하고 싶을 때.
"""

from app.services.cloud_cost.alerts import evaluate_all_rules, evaluate_one_rule
from app.services.cloud_cost.provider import CloudCostDTO, CloudCostProvider
from app.services.cloud_cost.service import (
    fetch_and_upsert_daily,
    fetch_and_upsert_range,
    get_providers,
    upsert_costs,
)

__all__ = [
    "CloudCostDTO",
    "CloudCostProvider",
    "evaluate_all_rules",
    "evaluate_one_rule",
    "fetch_and_upsert_daily",
    "fetch_and_upsert_range",
    "get_providers",
    "upsert_costs",
]
