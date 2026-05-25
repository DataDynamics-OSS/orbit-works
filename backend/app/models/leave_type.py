"""휴가 유형 (LeaveType) — 자사 휴가 종류 마스터.

Settings 화면에서 관리자가 등록·수정. 기존 `LeaveRequest.leave_type` (varchar enum)
과 별개로 운영되는 reference 테이블 — UI 의 select 옵션 채우기, 카테고리·색상·
규칙(연차 차감 여부·유급 여부·증빙 필수 여부·연 한도) 등 메타데이터 보관.

LeaveRequest 와 FK 연결은 향후 PR 에서 마이그레이션 (이번 단계는 별개 등록).
"""

from sqlalchemy import Boolean, Numeric, SmallInteger, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class LeaveType(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "leave_types"
    # tenant 별로 동일 code 를 가질 수 있어야 함 — (tenant_id, code) 복합 UNIQUE.
    __table_args__ = (UniqueConstraint("tenant_id", "code", name="uq_leave_types_tenant_code"),)

    # 시스템 식별자 — 영문/숫자/언더스코어. tenant 내 UNIQUE.
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    # UI 표시 이름 — "연차", "경조 (결혼)" 등.
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # 카테고리 — UI 그룹핑/필터/색상 기본값에 사용.
    # ANNUAL | LIFE_EVENT | PUBLIC_DUTY | SICK | REWARD | OTHER
    category: Mapped[str] = mapped_column(String(30), nullable=False)
    # 일수 단위. DAY (1일) | HALF (반일=0.5) | HOUR (시간 단위, 향후 확장).
    unit: Mapped[str] = mapped_column(String(10), nullable=False, default="DAY")
    # 연차 잔여에서 차감할지 여부. 연차/반차 = true, 그 외 = false.
    deducts_annual: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 유급 여부. 무급 병가·무급 휴가 = false, 그 외 = true.
    paid: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 연간 한도 — 일수 기준. NULL = 무제한.
    max_days_per_year: Mapped[float | None] = mapped_column(Numeric(4, 1))
    # 연간 사용 횟수 한도. NULL = 무제한.
    max_uses_per_year: Mapped[int | None] = mapped_column(SmallInteger)
    # 증빙 첨부 필수 (진단서·청첩장·통지서 등).
    requires_evidence: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    # 신청 시 사유 텍스트 입력 필수.
    requires_reason: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    # HEX 색상 — UI 캘린더·뱃지 표시. 카테고리 기본색을 prefil 하면 됨.
    color: Mapped[str | None] = mapped_column(String(7))
    description: Mapped[str | None] = mapped_column(Text)
    # 정렬 순서 (낮은 값이 위). 같은 값은 created_at 으로 tie-break.
    sort_order: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
