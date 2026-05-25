"""Tenant — 다중 회사(멀티 테넌트) 격리의 단위.

- 이메일 도메인으로 사용자→tenant 매핑 (tenants.domains text[]).
- SUPER_ADMIN 만 CRUD 가능.
- 회사 프로필 (사업자번호·대표자·주소·로고·도장·직인 등) 은 모두 이 한 row 의
  컬럼으로 통합 저장. (구) company_profile 테이블이 여기로 흡수됨.
"""

from sqlalchemy import ARRAY, Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class Tenant(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "tenants"

    # 시스템 식별자 (URL/로그용 — 영숫자+하이픈 권장).
    slug: Mapped[str] = mapped_column(
        String(60), unique=True, nullable=False, index=True
    )
    # 화면 표시 이름.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 이 tenant 의 사용자가 가진 이메일 도메인 목록 (예: ['example.com']).
    # 한 tenant 가 여러 도메인 (인수합병 등) 보유 가능. 도메인 충돌 검증은 application 단.
    domains: Mapped[list[str]] = mapped_column(
        ARRAY(String(120)), nullable=False, default=list
    )
    # 비활성화 시 이 tenant 의 사용자는 로그인 차단.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # ---- 회사 프로필 (한글) ----
    business_no: Mapped[str | None] = mapped_column(String(20))
    representative: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(50))
    fax: Mapped[str | None] = mapped_column(String(50))
    contact_email: Mapped[str | None] = mapped_column(String(200))

    # ---- 회사 프로필 (영문) ----
    name_en: Mapped[str | None] = mapped_column(String(200))
    representative_en: Mapped[str | None] = mapped_column(String(100))
    address_en: Mapped[str | None] = mapped_column(Text)

    # 견적·청구 발번 prefix.
    number_prefix: Mapped[str] = mapped_column(String(12), nullable=False, default="DD")

    # ---- 은행 계좌 (한글) ----
    bank_name: Mapped[str | None] = mapped_column(String(100))
    bank_account: Mapped[str | None] = mapped_column(String(100))
    bank_holder: Mapped[str | None] = mapped_column(String(100))

    # ---- 은행 계좌 (영문) ----
    bank_name_en: Mapped[str | None] = mapped_column(String(100))
    bank_holder_en: Mapped[str | None] = mapped_column(String(100))

    # ---- 회사 자산 (이미지 — 로고/도장/직인) ----
    # 파일 자체는 /app/data/<tenant_uuid>/company-profile/* 에 저장 (storage.py 의
    # tenant prefix 가 자동 합성 — ContextVar 의 current_tenant_id 기반).
    logo_name: Mapped[str | None] = mapped_column(String(255))
    logo_path: Mapped[str | None] = mapped_column(String(1024))
    logo_mime: Mapped[str | None] = mapped_column(String(120))

    stamp_name: Mapped[str | None] = mapped_column(String(255))
    stamp_path: Mapped[str | None] = mapped_column(String(1024))
    stamp_mime: Mapped[str | None] = mapped_column(String(120))

    seal_name: Mapped[str | None] = mapped_column(String(255))
    seal_path: Mapped[str | None] = mapped_column(String(1024))
    seal_mime: Mapped[str | None] = mapped_column(String(120))
