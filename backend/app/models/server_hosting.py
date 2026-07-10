"""서버 호스팅 — 자원 > 서버 호스팅 메뉴.

회사가 사용 중인 서버(전용서버 / VPS / 클라우드 IaaS / 코로케이션) 의 IP·스펙
(Core / RAM / Disk / OS)·용도·호스팅 업체·시작일·종료일·월 비용·유형 관리.

정책:
  - `expiry_alarm=true` 인 항목은 `services/daily_alerts.py` 의 D-30 검사
    대상 → tenant 의 ADMIN/HR/SUPER_ADMIN 에게 mattermost DM (도메인과 같은
    채널, 별도 feature key `server_hosting_expiry_alert`).
  - `hosting_type` 은 4 종 enum — DB CHECK 없이 앱 단에서만 검증. 신규 유형
    추가 시 `SERVER_HOSTING_TYPES` 튜플과 `schemas.HostingType` 둘 다 갱신.
  - `monthly_cost` 는 KRW 정수 전용 (소수점 단위 환산 안 함). 해외 호스팅도
    환산 후 입력하는 운영 약속. 통화 다양화가 필요해지면 도메인처럼 currency
    컬럼을 추가.

테이블 RLS:
  - `tenant_iso` 정책 (in `backend/sql/rls_policies.sql`) — backend startup
    시 자동 적용.
  - INSERT trigger `fn_auto_tenant_id` 가 tenant_id 자동 채움 (앱 단의 명시적
    set 과 idempotent — trigger 가 NULL 일 때만 채움).
  - FK `tenant_id → tenants(id) ON DELETE RESTRICT` — tenant 삭제 시 호스팅
    row 가 남아 있으면 거부 (의도적).
"""

from __future__ import annotations

from datetime import date as date_cls
from decimal import Decimal

from sqlalchemy import Boolean, Date, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


# 호스팅 유형 — 프런트 select 와 동기화. 신규 추가 시 양쪽 모두 갱신.
SERVER_HOSTING_TYPES = ("DEDICATED", "VPS", "CLOUD", "COLOCATION")


class ServerHosting(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """서버 호스팅 단건 — IP 단위로 1 row."""

    __tablename__ = "server_hostings"
    __table_args__ = (
        UniqueConstraint("tenant_id", "ip", name="uq_server_hostings_tenant_ip"),
    )

    # IP — 식별자. IPv4/IPv6 모두 문자열로 보관 (검증은 입력 단계에서).
    ip: Mapped[str] = mapped_column(String(45), nullable=False, index=True)
    # CPU 코어 수 (vCPU 포함).
    cpu_cores: Mapped[int | None] = mapped_column(Integer)
    # RAM (GB 단위 정수).
    ram_gb: Mapped[int | None] = mapped_column(Integer)
    # Disk 총량 (GB 단위 정수).
    disk_gb: Mapped[int | None] = mapped_column(Integer)
    # OS 표기 — "Ubuntu 22.04", "Rocky Linux 9", "Windows Server 2022" 등.
    os: Mapped[str | None] = mapped_column(String(120))
    # 용도 — 자유 입력. "운영 DB", "백업", "스테이징", "사내 GitLab" 등.
    purpose: Mapped[str | None] = mapped_column(Text)
    # 호스팅 업체 — KT Cloud / NHN Cloud / Smileserv / AWS / Azure 등.
    vendor: Mapped[str | None] = mapped_column(String(200))
    start_date: Mapped[date_cls | None] = mapped_column(Date)
    end_date: Mapped[date_cls | None] = mapped_column(Date, index=True)
    # 월 비용 (KRW 고정). 해외 호스팅은 환산 후 입력.
    monthly_cost: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    # 호스팅 유형 — SERVER_HOSTING_TYPES 중 하나. 앱 단에서만 검증.
    hosting_type: Mapped[str | None] = mapped_column(String(20))
    # 만료 임박 알림 ON 여부 — cron 이 expiry_alarm=true 인 항목만 통지.
    expiry_alarm: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    memo: Mapped[str | None] = mapped_column(Text)
