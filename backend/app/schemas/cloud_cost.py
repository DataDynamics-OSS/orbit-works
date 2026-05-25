"""클라우드 비용 — 프런트 ↔ 백엔드 직렬화 계약."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

CloudProvider = Literal["AWS", "AZURE", "GCP"]
FetchStatus = Literal["SUCCESS", "FAILED", "PARTIAL", "SKIPPED"]


class CloudCostOut(BaseModel):
    id: UUID
    provider: CloudProvider
    account_id: str
    usage_date: date
    service: str | None
    currency: str
    amount: Decimal
    amount_krw: Decimal | None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CloudCostSummaryRow(BaseModel):
    """대시보드용 일별/서비스별 집계 row."""

    usage_date: date
    provider: CloudProvider
    service: str | None
    amount_krw: Decimal


class CloudCostFetchOut(BaseModel):
    id: UUID
    provider: CloudProvider
    period_start: date | None
    period_end: date | None
    trigger_kind: str
    status: FetchStatus
    fetched_count: int
    created_count: int
    updated_count: int
    skipped_count: int
    error_message: str | None
    started_at: datetime
    finished_at: datetime | None
    triggered_by: UUID | None

    class Config:
        from_attributes = True


class FetchTriggerRequest(BaseModel):
    """수동 수집 요청. providers 미지정 시 enabled 인 모든 provider."""

    providers: list[CloudProvider] | None = None
    # 어제부터 N일치. 기본 1 = 어제 하루.
    since_days: int = Field(default=1, ge=1, le=14)


class FetchTriggerResponse(BaseModel):
    results: list[CloudCostFetchOut]
