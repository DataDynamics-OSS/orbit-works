"""Azure Cost Management 어댑터 (`Microsoft.CostManagement/query`).

- 인증: ClientSecretCredential (Service Principal).
- API: Cost Management Reader 권한 필요.
- subscription_ids 의 모든 subscription 을 순회 — subscription 당 1회 query.
- granularity=Daily, grouping=ServiceName.

비동기: azure-mgmt SDK 는 sync — to_thread 로 감싸 호출.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import date, datetime, time, timezone
from decimal import Decimal

from app.services.cloud_cost.aws import _topn_dtos
from app.services.cloud_cost.provider import CloudCostDTO

logger = logging.getLogger(__name__)


class AzureProvider:
    name = "AZURE"

    def __init__(
        self,
        *,
        tenant_id: str = "",
        client_id: str = "",
        client_secret: str = "",
        subscription_ids: list[str] | None = None,
    ) -> None:
        self._tenant_id = tenant_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._subscription_ids = list(subscription_ids or [])

    @property
    def configured(self) -> bool:
        return bool(
            self._tenant_id and self._client_id and self._client_secret
            and self._subscription_ids
        )

    async def fetch_daily(
        self,
        target: date,
        *,
        service_top_n: int = 20,
    ) -> list[CloudCostDTO]:
        """단일 일자 — fetch_range 위임."""
        return await self.fetch_range(target, target, service_top_n=service_top_n)

    async def fetch_range(
        self,
        start: date,
        end: date,
        *,
        service_top_n: int = 20,
    ) -> list[CloudCostDTO]:
        """Azure 의 단일 일자 query 는 데이터 1% 만 반환하는 알려진 이슈가 있어
        반드시 range 호출 사용. fetch_daily 도 내부적으로 fetch_range 위임."""
        if not self.configured:
            logger.debug("Azure Cost Management 호출 skip — 자격증명 미설정")
            return []

        logger.info(
            "Azure Cost Management fetch_range start=%s end=%s subs=%d",
            start, end, len(self._subscription_ids),
        )

        all_dtos: list[CloudCostDTO] = []
        for sub_id in self._subscription_ids:
            try:
                dtos = await self._fetch_one_subscription_range(sub_id, start, end, service_top_n)
            except Exception as exc:
                # 한 sub 실패가 다른 sub 까지 막지 않도록 격리. 429 / Invalid 등 흔함.
                logger.warning(
                    "Azure cost query 실패 subscription=%s range=%s~%s: %s",
                    sub_id, start, end, exc, exc_info=True,
                )
                continue
            logger.info(
                "  subscription=%s dtos=%d",
                sub_id, len(dtos),
            )
            all_dtos.extend(dtos)
        logger.info(
            "Azure Cost Management fetch_range done — total dtos=%d", len(all_dtos),
        )
        return all_dtos

    async def _fetch_one_subscription_range(
        self,
        subscription_id: str,
        start: date,
        end: date,
        service_top_n: int,
    ) -> list[CloudCostDTO]:
        """단일 subscription, 범위 query — 응답 row 를 (date, service) 별로 그룹화."""
        def _call() -> object:
            # lazy import — 미사용 환경에서 SDK import 비용 회피.
            from azure.identity import ClientSecretCredential
            from azure.mgmt.costmanagement import CostManagementClient
            from azure.mgmt.costmanagement.models import (
                QueryAggregation,
                QueryDataset,
                QueryDefinition,
                QueryGrouping,
                QueryTimePeriod,
            )

            cred = ClientSecretCredential(
                tenant_id=self._tenant_id,
                client_id=self._client_id,
                client_secret=self._client_secret,
            )
            client = CostManagementClient(cred)
            scope = f"/subscriptions/{subscription_id}"

            start_dt = datetime.combine(start, time.min, tzinfo=timezone.utc)
            from datetime import timedelta as _td
            end_dt = datetime.combine(end, time.min, tzinfo=timezone.utc) + _td(days=1)

            params = QueryDefinition(
                type="ActualCost",
                timeframe="Custom",
                time_period=QueryTimePeriod(from_property=start_dt, to=end_dt),
                dataset=QueryDataset(
                    granularity="Daily",
                    aggregation={
                        "totalCost": QueryAggregation(name="Cost", function="Sum"),
                    },
                    grouping=[
                        QueryGrouping(type="Dimension", name="ServiceName"),
                    ],
                ),
            )
            return client.query.usage(scope=scope, parameters=params)

        resp = await asyncio.to_thread(_call)

        # 응답: rows = [[Cost, UsageDate(int YYYYMMDD), ServiceName, Currency], ...]
        cols = [c.name for c in (resp.columns or [])]
        idx_cost = cols.index("Cost") if "Cost" in cols else 0
        # date 컬럼 — Azure SDK 버전에 따라 UsageDate / BillingMonth / Date.
        idx_date = next(
            (i for i, c in enumerate(cols) if c in ("UsageDate", "BillingMonth", "Date")),
            None,
        )
        idx_svc = cols.index("ServiceName") if "ServiceName" in cols else None
        idx_cur = cols.index("Currency") if "Currency" in cols else None

        # (slot_date) → {service: (amount, currency)}
        per_day: dict[date, dict[str, tuple[Decimal, str]]] = {}
        for row in (resp.rows or []):
            try:
                amt = Decimal(str(row[idx_cost]))
            except Exception:
                continue
            # date 파싱 — 보통 정수 YYYYMMDD.
            slot_date = start  # fallback (range 내 첫 day)
            if idx_date is not None:
                raw_d = row[idx_date]
                try:
                    if isinstance(raw_d, int):
                        s = str(raw_d)
                        slot_date = date(int(s[:4]), int(s[4:6]), int(s[6:8]))
                    elif isinstance(raw_d, str):
                        # "2026-04-15" 또는 "20260415"
                        s = raw_d.replace("-", "")
                        slot_date = date(int(s[:4]), int(s[4:6]), int(s[6:8]))
                except Exception:
                    pass
            svc = str(row[idx_svc]) if idx_svc is not None else "UNKNOWN"
            cur = str(row[idx_cur]) if idx_cur is not None else "USD"
            day_map = per_day.setdefault(slot_date, {})
            prev = day_map.get(svc)
            if prev is None:
                day_map[svc] = (amt, cur)
            else:
                day_map[svc] = (prev[0] + amt, prev[1])

        all_dtos: list[CloudCostDTO] = []
        for slot_date, per_service in per_day.items():
            all_dtos.extend(_topn_dtos(
                provider="AZURE",
                account_id=subscription_id,
                target=slot_date,
                per_service=per_service,
                service_top_n=service_top_n,
                raw_full={},
            ))
        return all_dtos
