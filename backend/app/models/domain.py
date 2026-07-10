"""회사 도메인 — 자원 > 도메인 메뉴.

도메인명·구매일·만료일·구매처·구매금액·용도·자동갱신·만료알람 관리.

정책:
  - `expiry_alarm=true` 인 도메인은 `services/daily_alerts.py` 의 D-30 검사
    대상 → tenant 의 ADMIN/HR/SUPER_ADMIN 에게 mattermost DM.
  - `auto_renew` 은 표시 전용 — 알람 동작과 무관. 사람이 한눈에 "이 도메인은
    벤더에서 자동으로 갱신되니 신경 안 써도 됨"을 보기 위한 메모 성격.

테이블 RLS:
  - `tenant_iso` 정책 (in `backend/sql/rls_policies.sql`).
  - INSERT trigger `fn_auto_tenant_id` 가 tenant_id 자동 채움 (앱 단의 명시적
    set 과 중복돼도 idempotent — trigger 가 NULL 일 때만 채움).
"""

from __future__ import annotations

from datetime import date as date_cls, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Domain(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """회사가 보유한 도메인 항목 — `orbit-works.app`, `example.co.kr` 등."""

    __tablename__ = "domains"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_domains_tenant_name"),
    )

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    purchase_date: Mapped[date_cls | None] = mapped_column(Date)
    expiry_date: Mapped[date_cls | None] = mapped_column(Date, index=True)
    purchase_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")
    vendor: Mapped[str | None] = mapped_column(String(200))
    # 용도 — 자유 입력. "운영 사이트", "데모 사이트", "마케팅 랜딩" 등.
    purpose: Mapped[str | None] = mapped_column(Text)
    auto_renew: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 만료 임박 알림 ON 여부 — cron 이 expiry_alarm=true 인 도메인만 통지.
    expiry_alarm: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    memo: Mapped[str | None] = mapped_column(Text)
