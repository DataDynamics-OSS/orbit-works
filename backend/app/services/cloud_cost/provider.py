"""클라우드 비용 — provider 중립 DTO + Protocol.

DTO 의 currency 는 provider 가 반환한 값을 그대로 보존 (USD, KRW 등).
amount 는 항상 양수 (할인·크레딧은 음수로 들어올 수 있어 그대로 유지).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal, Protocol

CloudProvider = Literal["AWS", "AZURE", "GCP"]


@dataclass
class CloudCostDTO:
    """단일 (provider, account, usage_date, service) row.

    service=None 이면 그 account 의 일별 합계.
    """

    provider: CloudProvider
    account_id: str
    usage_date: date
    service: str | None
    currency: str
    amount: Decimal
    raw: dict = field(default_factory=dict)


class CloudCostProvider(Protocol):
    """provider 공통 인터페이스 — service.py 가 이걸 통해 호출."""

    name: CloudProvider

    @property
    def configured(self) -> bool:
        """필수 자격증명·범위가 모두 설정돼 있는지."""
        ...

    async def fetch_daily(
        self,
        target: date,
        *,
        service_top_n: int = 20,
    ) -> list[CloudCostDTO]:
        """target 일자(UTC) 의 service 별 비용. 내부에서 fetch_range delegate."""
        ...

    async def fetch_range(
        self,
        start: date,
        end: date,
        *,
        service_top_n: int = 20,
    ) -> list[CloudCostDTO]:
        """[start, end] 범위 (양 끝 포함) 의 일별 service 별 비용. **단일 API 호출**.

        장점:
        - Azure 의 단일 일자 query 정확도 문제 회피 (좁은 window 가 데이터 일부만 반환)
        - API rate limit 부담 ↓ (180일 백필이 1 호출)
        - 처리 시간 단축

        반환 DTO 는 (provider, account_id, usage_date, service) 키로 unique.
        각 일자별로 service top_n 적용 + 합계 row(service='') 포함.
        """
        ...
