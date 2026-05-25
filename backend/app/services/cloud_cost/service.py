"""클라우드 비용 수집 오케스트레이션.

기능:
- `get_providers(cfg)` — cfg 의 enabled provider 만 인스턴스화 (자격증명 자동 복호화).
- `upsert_costs(dtos)` — (provider, account, date, service) UNIQUE 기반 idempotent.
- `fetch_and_upsert_daily(target, providers, cfg)` — 1 provider 1회 수집 + 이력 기록.

스케줄러 entry 는 `app/services/scheduler.py::_daily_cloud_cost_job` 에서 tenant
별로 system_session(tenant_id=) 을 열고 이 함수를 provider 별로 호출.

KRW 환산: services/exchange 의 ExchangeRate 테이블에서 (currency, target_date)
가까운 환율 조회. 없으면 amount_krw=NULL 로 둔다 (UI 가 환산 표시 보류).
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.secrets_crypto import decrypt_secret
from app.models import CloudCost, CloudCostFetch
from app.services.cloud_cost.aws import AWSProvider
from app.services.cloud_cost.azure import AzureProvider
from app.services.cloud_cost.gcp import GCPProvider
from app.services.cloud_cost.provider import CloudCostDTO, CloudCostProvider

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider factory
# ---------------------------------------------------------------------------


def get_providers(cfg: dict) -> dict[str, CloudCostProvider]:
    """cfg 의 각 sub-section 으로부터 enabled=true 인 provider 인스턴스만 반환.

    자격증명은 enc:… prefix 면 decrypt_secret 가 평문으로 변환. configured 여부는
    각 provider 의 `configured` 가 판정.
    """
    out: dict[str, CloudCostProvider] = {}

    aws_cfg = cfg.get("aws") or {}
    if aws_cfg.get("enabled"):
        out["AWS"] = AWSProvider(
            access_key_id=decrypt_secret(aws_cfg.get("access_key_id", "")),
            secret_access_key=decrypt_secret(aws_cfg.get("secret_access_key", "")),
            region=aws_cfg.get("region", "us-east-1") or "us-east-1",
            accounts=aws_cfg.get("accounts") or [],
        )

    azure_cfg = cfg.get("azure") or {}
    if azure_cfg.get("enabled"):
        out["AZURE"] = AzureProvider(
            tenant_id=azure_cfg.get("tenant_id", ""),
            client_id=azure_cfg.get("client_id", ""),
            client_secret=decrypt_secret(azure_cfg.get("client_secret", "")),
            subscription_ids=azure_cfg.get("subscription_ids") or [],
        )

    gcp_cfg = cfg.get("gcp") or {}
    if gcp_cfg.get("enabled"):
        out["GCP"] = GCPProvider(
            service_account_json=decrypt_secret(gcp_cfg.get("service_account_json", "")),
            billing_account_id=gcp_cfg.get("billing_account_id", ""),
            bigquery_dataset=gcp_cfg.get("bigquery_dataset", ""),
            bigquery_table_suffix=gcp_cfg.get("bigquery_table_suffix", ""),
        )

    return out


# ---------------------------------------------------------------------------
# Upsert
# ---------------------------------------------------------------------------


def _to_decimal(v) -> Decimal:
    if v is None:
        return Decimal(0)
    if isinstance(v, Decimal):
        return v
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal(0)


async def _to_krw(db: AsyncSession, amount: Decimal, currency: str, target: date) -> Decimal | None:
    """services/exchange 환율로 KRW 환산. 환율 없으면 None.

    target 일자의 정확한 row 가 없을 경우 가장 가까운 *과거* row 를 찾는다.
    """
    if currency == "KRW":
        return amount
    from app.models import ExchangeRate
    # base = USD, target = KRW 만 저장하므로 currency 가 USD 가 아닌 경우는 보류.
    if currency != "USD":
        return None
    row = (await db.execute(
        select(ExchangeRate)
        .where(ExchangeRate.base == "USD", ExchangeRate.target == "KRW",
               ExchangeRate.date <= target)
        .order_by(ExchangeRate.date.desc())
        .limit(1)
    )).scalar_one_or_none()
    if row is None:
        return None
    return amount * _to_decimal(row.rate)


async def upsert_costs(
    db: AsyncSession,
    dtos: list[CloudCostDTO],
) -> tuple[int, int, int]:
    """(provider, account_id, usage_date, service) 자연키 upsert.

    반환: (created, updated, skipped). 변경 없으면 skipped.
    """
    created = updated = skipped = 0
    for dto in dtos:
        # service NULL 대신 빈문자열로 정규화 — UNIQUE 정상 동작.
        svc_norm = dto.service if dto.service is not None else ""
        existing = (await db.execute(
            select(CloudCost).where(
                CloudCost.provider == dto.provider,
                CloudCost.account_id == dto.account_id,
                CloudCost.usage_date == dto.usage_date,
                CloudCost.service == svc_norm,
            )
        )).scalar_one_or_none()

        amount = _to_decimal(dto.amount)
        amount_krw = await _to_krw(db, amount, dto.currency, dto.usage_date)

        if existing is None:
            db.add(CloudCost(
                provider=dto.provider,
                account_id=dto.account_id,
                usage_date=dto.usage_date,
                service=svc_norm,
                currency=dto.currency,
                amount=amount,
                amount_krw=amount_krw,
                raw=dto.raw,
            ))
            created += 1
            continue

        changed = (
            existing.amount != amount
            or existing.currency != dto.currency
            or existing.amount_krw != amount_krw
        )
        if not changed:
            skipped += 1
            continue
        existing.amount = amount
        existing.currency = dto.currency
        existing.amount_krw = amount_krw
        existing.raw = dto.raw
        updated += 1

    await db.commit()
    return created, updated, skipped


# ---------------------------------------------------------------------------
# 메인 entry — provider 1개 1일치 수집 + 이력 기록
# ---------------------------------------------------------------------------


async def fetch_and_upsert_daily(
    db: AsyncSession,
    *,
    provider_name: str,
    provider: CloudCostProvider,
    target: date,
    triggered_by: UUID | None = None,
    trigger_kind: str = "MANUAL",
    service_top_n: int = 20,
) -> CloudCostFetch:
    """단일 일자 — fetch_and_upsert_range delegate (코드 단순화).

    Azure 의 단일 일자 API 가 데이터 일부만 반환하는 문제 회피를 위해 내부적으로는
    range 호출을 사용. 주의: 이 함수는 기존 호출자 호환용. 신규 코드는
    fetch_and_upsert_range 직접 사용 권장.
    """
    return await fetch_and_upsert_range(
        db,
        provider_name=provider_name,
        provider=provider,
        start=target,
        end=target,
        triggered_by=triggered_by,
        trigger_kind=trigger_kind,
        service_top_n=service_top_n,
    )


async def fetch_and_upsert_range(
    db: AsyncSession,
    *,
    provider_name: str,
    provider: CloudCostProvider,
    start: date,
    end: date,
    triggered_by: UUID | None = None,
    trigger_kind: str = "MANUAL",
    service_top_n: int = 20,
) -> CloudCostFetch:
    """범위 fetch — provider 가 단일 API 호출로 [start, end] 모든 일자 데이터 반환.

    AWS Cost Explorer / Azure Cost Management / GCP BigQuery 모두 daily granularity
    range query 를 한 번에 처리하므로 효율적. 결과 DTO 는 (provider, account_id,
    usage_date, service) 키로 구성되며 upsert_costs 가 idempotent UPSERT.

    이력 row 1개 생성 — period_start/end 가 range 양 끝.
    """
    rec = CloudCostFetch(
        provider=provider_name,
        period_start=start,
        period_end=end,
        trigger_kind=trigger_kind,
        triggered_by=triggered_by,
        started_at=datetime.now(timezone.utc),
    )
    if not provider.configured:
        rec.status = "SKIPPED"
        rec.error_message = f"{provider_name} 크레덴셜이 설정되지 않았습니다."
        rec.finished_at = datetime.now(timezone.utc)
        db.add(rec)
        await db.commit()
        logger.info(
            "클라우드 비용 수집 스킵 (creds 없음): provider=%s range=%s~%s",
            provider_name, start, end,
        )
        return rec

    try:
        dtos = await provider.fetch_range(start, end, service_top_n=service_top_n)
        created, updated_, skipped = await upsert_costs(db, dtos)
        rec.fetched_count = len(dtos)
        rec.created_count = created
        rec.updated_count = updated_
        rec.skipped_count = skipped
        rec.status = "SUCCESS"
        logger.info(
            "클라우드 비용 수집 완료: provider=%s range=%s~%s fetched=%d created=%d updated=%d skipped=%d",
            provider_name, start, end, len(dtos), created, updated_, skipped,
        )
    except Exception as exc:
        rec.status = "FAILED"
        rec.error_message = f"{type(exc).__name__}: {exc}"[:4000]
        logger.warning(
            "클라우드 비용 수집 실패: provider=%s range=%s~%s",
            provider_name, start, end, exc_info=True,
        )

    rec.finished_at = datetime.now(timezone.utc)
    db.add(rec)
    await db.commit()
    return rec
