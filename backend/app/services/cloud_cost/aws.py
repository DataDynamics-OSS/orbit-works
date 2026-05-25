"""AWS Cost Explorer (`ce:GetCostAndUsage`) 어댑터.

- Cost Explorer endpoint 는 us-east-1 에서만 응답한다 (region 설정 무관 — 자동 강제).
- `Granularity=DAILY` + `GroupBy=SERVICE` + `Metric=UnblendedCost` 가 표준.
- 호출 1건당 $0.01 — 일 1회 호출이면 월 $0.30 수준.
- account 별 비용을 분해하려면 `Filter={"Dimensions":{"Key":"LINKED_ACCOUNT", ...}}` 를
  추가 호출하거나 GroupBy 에 LINKED_ACCOUNT 를 같이 넣어야 한다. MVP 는 단일 자격
  증명의 모든 account 합계만 service 단위로 가져온다 (account_id 는 자격증명의
  caller-account 로 표기).

비동기: boto3 는 sync 라 asyncio.to_thread 로 감싸 호출.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal

from app.services.cloud_cost.provider import CloudCostDTO

logger = logging.getLogger(__name__)


class AWSProvider:
    name = "AWS"

    def __init__(
        self,
        *,
        access_key_id: str = "",
        secret_access_key: str = "",
        region: str = "us-east-1",
        accounts: list[str] | None = None,
    ) -> None:
        self._access_key_id = access_key_id
        self._secret_access_key = secret_access_key
        self._region = region or "us-east-1"
        # Cost Explorer 는 us-east-1 만 지원 — 사용자 region 설정과 무관하게 강제.
        self._ce_region = "us-east-1"
        self._accounts = list(accounts or [])

    @property
    def configured(self) -> bool:
        return bool(self._access_key_id and self._secret_access_key)

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
        if not self.configured:
            logger.debug("AWS Cost Explorer 호출 skip — 자격증명 미설정")
            return []

        logger.info(
            "AWS Cost Explorer fetch_range start=%s end=%s accounts=%s",
            start, end, self._accounts or ["(default)"],
        )

        def _call() -> dict:
            import boto3  # lazy import — cloud_cost 미사용 환경에서 import 비용 회피
            client = boto3.client(
                "ce",
                aws_access_key_id=self._access_key_id,
                aws_secret_access_key=self._secret_access_key,
                region_name=self._ce_region,
            )
            # End 는 exclusive — start ~ end 양 끝 포함하려면 end+1day.
            return client.get_cost_and_usage(
                TimePeriod={
                    "Start": start.isoformat(),
                    "End": (end + timedelta(days=1)).isoformat(),
                },
                Granularity="DAILY",
                Metrics=["UnblendedCost"],
                GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
            )

        try:
            resp = await asyncio.to_thread(_call)
        except Exception as exc:
            logger.warning(
                "AWS Cost Explorer 호출 실패 start=%s end=%s: %s",
                start, end, exc, exc_info=True,
            )
            raise

        account_id = (self._accounts[0] if self._accounts else "aws-default")

        # AWS 응답: ResultsByTime 의 각 element 가 한 일자.
        all_dtos: list[CloudCostDTO] = []
        for slot in resp.get("ResultsByTime", []) or []:
            period_start_str = (slot.get("TimePeriod") or {}).get("Start")
            if not period_start_str:
                continue
            try:
                slot_date = datetime.strptime(period_start_str, "%Y-%m-%d").date()
            except Exception:
                continue
            per_service: dict[str, tuple[Decimal, str]] = {}
            for grp in slot.get("Groups", []) or []:
                svc = (grp.get("Keys") or ["UNKNOWN"])[0]
                m = grp.get("Metrics", {}).get("UnblendedCost", {})
                amt = Decimal(m.get("Amount", "0") or "0")
                cur = m.get("Unit", "USD")
                prev = per_service.get(svc)
                if prev is None:
                    per_service[svc] = (amt, cur)
                else:
                    per_service[svc] = (prev[0] + amt, prev[1])
            all_dtos.extend(_topn_dtos(
                provider="AWS",
                account_id=account_id,
                target=slot_date,
                per_service=per_service,
                service_top_n=service_top_n,
                raw_full={},  # 일자별 raw 는 안 보존 (전체 응답 너무 큼)
            ))
        logger.info(
            "AWS Cost Explorer fetch_range done — days=%d dtos=%d",
            len(resp.get("ResultsByTime", []) or []), len(all_dtos),
        )
        return all_dtos


def _topn_dtos(
    *,
    provider,
    account_id: str,
    target: date,
    per_service: dict[str, tuple[Decimal, str]],
    service_top_n: int,
    raw_full: dict,
) -> list[CloudCostDTO]:
    """공통 — top-N 자르고 나머지는 OTHER 로 합산. 합계 row 도 함께 생성."""
    items = sorted(per_service.items(), key=lambda kv: kv[1][0], reverse=True)
    dtos: list[CloudCostDTO] = []

    if service_top_n > 0 and len(items) > service_top_n:
        kept = items[:service_top_n]
        rest = items[service_top_n:]
        rest_amt = sum((v[0] for _, v in rest), Decimal(0))
        rest_cur = rest[0][1][1] if rest else "USD"
        items = list(kept) + [("OTHER", (rest_amt, rest_cur))]

    total_amt = Decimal(0)
    total_cur = "USD"
    for svc, (amt, cur) in items:
        total_amt += amt
        total_cur = cur
        dtos.append(CloudCostDTO(
            provider=provider, account_id=account_id, usage_date=target,
            service=svc, currency=cur, amount=amt, raw={},
        ))
    # 합계 row — service='' (UNIQUE 가 NULL 들끼리 충돌 안 하는 문제 회피).
    dtos.append(CloudCostDTO(
        provider=provider, account_id=account_id, usage_date=target,
        service="", currency=total_cur, amount=total_amt, raw=raw_full,
    ))
    return dtos
