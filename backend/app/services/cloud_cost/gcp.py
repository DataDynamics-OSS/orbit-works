"""GCP BigQuery billing export 어댑터.

GCP 는 actual cost 를 반환하는 직접 API 가 없어, 사용자가 콘솔에서 1회 활성화
하는 *BigQuery billing export* 가 사실상 유일한 데이터 소스다:
   GCP Console → Billing → Billing export → BigQuery export → enable

활성화 후 dataset 안에 다음 두 테이블이 자동 생성:
   gcp_billing_export_v1_<billing_account_underscore>           -- standard usage
   gcp_billing_export_resource_v1_<billing_account_underscore>  -- 리소스 단위
MVP 는 standard 테이블만 사용 (서비스 단위까지 커버).

쿼리 비용: on-demand 가격 — 일 1회, 1일치 partition 만 스캔하므로 매월 $0~$0.5 수준.
partitioned 테이블이라 _PARTITIONTIME 으로 잘라야 cost 안정.

비동기: google-cloud-bigquery 는 sync — to_thread 로 감싸 호출.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, timedelta
from decimal import Decimal

from app.services.cloud_cost.aws import _topn_dtos
from app.services.cloud_cost.provider import CloudCostDTO

logger = logging.getLogger(__name__)


class GCPProvider:
    name = "GCP"

    def __init__(
        self,
        *,
        service_account_json: str = "",
        billing_account_id: str = "",
        bigquery_dataset: str = "",
        bigquery_table_suffix: str = "",
    ) -> None:
        self._sa_json = service_account_json
        self._billing_account_id = billing_account_id
        self._dataset = bigquery_dataset
        self._table_suffix = bigquery_table_suffix or _suffix_from_billing_account(billing_account_id)

    @property
    def configured(self) -> bool:
        return bool(self._sa_json and self._dataset and self._table_suffix)

    async def fetch_daily(
        self,
        target: date,
        *,
        service_top_n: int = 20,
    ) -> list[CloudCostDTO]:
        return await self.fetch_range(target, target, service_top_n=service_top_n)

    async def fetch_range(
        self,
        start: date,
        end: date,
        *,
        service_top_n: int = 20,
    ) -> list[CloudCostDTO]:
        if not self.configured:
            logger.debug("GCP BigQuery 호출 skip — 자격증명/dataset 미설정")
            return []

        logger.info(
            "GCP BigQuery fetch_range start=%s end=%s dataset=%s",
            start, end, self._dataset,
        )

        def _call() -> list[dict]:
            from google.cloud import bigquery
            from google.oauth2 import service_account

            try:
                info = json.loads(self._sa_json)
            except json.JSONDecodeError as exc:
                raise ValueError(f"GCP service_account_json 이 올바른 JSON 이 아닙니다: {exc}")

            creds = service_account.Credentials.from_service_account_info(info)
            client = bigquery.Client(
                credentials=creds,
                project=info.get("project_id"),
            )
            sql = f"""
                SELECT
                    DATE(usage_start_time) AS usage_date,
                    project.id AS project_id,
                    service.description AS service,
                    SUM(cost) AS amount,
                    currency AS currency
                FROM `{self._dataset}.gcp_billing_export_v1_{self._table_suffix}`
                WHERE _PARTITIONTIME BETWEEN TIMESTAMP(@start) AND TIMESTAMP(@end)
                  AND DATE(usage_start_time) BETWEEN @start AND @end
                GROUP BY usage_date, project_id, service, currency
            """
            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("start", "DATE", start.isoformat()),
                    bigquery.ScalarQueryParameter("end", "DATE", end.isoformat()),
                ]
            )
            rows = client.query(sql, job_config=job_config).result()
            return [dict(r.items()) for r in rows]

        try:
            rows = await asyncio.to_thread(_call)
        except Exception as exc:
            logger.warning(
                "GCP BigQuery 호출 실패 dataset=%s: %s",
                self._dataset, exc, exc_info=True,
            )
            raise

        # (usage_date, project_id) → {service: (amount, currency)}
        per_day_project: dict[tuple, dict[str, tuple[Decimal, str]]] = {}
        for r in rows:
            usage_date = r.get("usage_date")
            if usage_date is None:
                continue
            pid = r.get("project_id") or self._billing_account_id or "gcp-default"
            svc = r.get("service") or "UNKNOWN"
            amt = Decimal(str(r.get("amount", 0) or 0))
            cur = r.get("currency", "USD") or "USD"
            key = (usage_date, pid)
            agg = per_day_project.setdefault(key, {})
            prev = agg.get(svc)
            agg[svc] = (amt if prev is None else prev[0] + amt, cur)

        all_dtos: list[CloudCostDTO] = []
        for (usage_date, pid), per_svc in per_day_project.items():
            all_dtos.extend(_topn_dtos(
                provider="GCP",
                account_id=pid,
                target=usage_date,
                per_service=per_svc,
                service_top_n=service_top_n,
                raw_full={},
            ))
        logger.info(
            "GCP BigQuery fetch_range done — projects=%d rows=%d dtos=%d",
            len({p for _, p in per_day_project}), len(rows), len(all_dtos),
        )
        return all_dtos


def _suffix_from_billing_account(ba_id: str) -> str:
    """`011130-7C85FE-92EE07` → `011130_7C85FE_92EE07`."""
    return (ba_id or "").replace("-", "_")
