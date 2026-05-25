"""클라우드 비용 일별 스냅샷 + 수집 이력.

- `CloudCost`: (tenant_id, provider, account_id, service, usage_date) UNIQUE.
  service NULL = account 합계 row. provider 가 service 별 분해를 못 주거나
  설정상 분해가 비활성일 때 사용.
- `CloudCostFetch`: 1회 수집 시도의 결과 — tax_invoice_fetches 와 동일 골격.

상세는 `app/services/cloud_cost/service.py` 의 docstring 참고.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class CloudCost(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """일별 클라우드 비용 스냅샷.

    upsert 키는 `(tenant_id, provider, account_id, service, usage_date)`. service
    가 NULL 이면 PostgreSQL UNIQUE 가 "다른 row 와 NULL 충돌 안 함" 으로 동작
    하므로, 운영 시 같은 (provider, account_id, NULL, date) 가 한 번만 만들어지
    도록 `service=''` 로 채우는 보수적 처리는 service.py 에서 수행.
    """

    __tablename__ = "cloud_costs"

    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)  # AWS | AZURE | GCP
    account_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    usage_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # service NULL/'' = account 합계 row. UI 차트는 service IS NOT NULL 만 표시.
    service: Mapped[str | None] = mapped_column(String(120))

    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0)
    # KRW 환산 캐시 — 미환산 시 NULL. service.py 가 services/exchange 호출로 채움.
    amount_krw: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))

    raw: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "provider", "account_id", "usage_date", "service",
            name="uq_cloud_costs_natural",
        ),
    )


class CloudCostFetch(Base, UUIDMixin, TenantMixin):
    """수집 이력 — daily cron + 수동 trigger 모두 기록."""

    __tablename__ = "cloud_cost_fetches"

    provider: Mapped[str] = mapped_column(String(20), nullable=False)  # AWS | AZURE | GCP
    period_start: Mapped[date | None] = mapped_column(Date)
    period_end: Mapped[date | None] = mapped_column(Date)
    # SCHEDULED_DAILY | MANUAL
    trigger_kind: Mapped[str] = mapped_column(String(30), nullable=False, default="MANUAL")
    triggered_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    # SUCCESS | FAILED | PARTIAL | SKIPPED (creds 없을 때)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="SUCCESS")
    fetched_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
