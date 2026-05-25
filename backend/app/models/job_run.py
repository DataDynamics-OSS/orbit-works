"""작업 이력 (JobRun) — 백그라운드 jobs 통합 실행 로그.

스케줄러로 도는 일간 작업 (FX·금리·주가·백업·공고·세금계산서·일일알림 등) 과
사용자 수동 트리거 (예: 알람 "지금 테스트 발송") 가 모두 이 한 테이블에 row 를
남긴다. 도메인별 상세 테이블(`alarm_sends`, `announcement_fetch_runs`) 은 그대로
유지 — 본 테이블은 통합 모니터링 + 이상 탐지용.

보존 기간 14일 — 매일 새벽 cleanup job 이 오래된 row 삭제. 자기 자신도 job_runs
에 기록됨 (재귀적이지만 항상 1 row 씩만 추가하고 삭제하므로 안전).

tenant_id 는 **NULL 허용** — 스케줄러가 모든 tenant 에 걸쳐 시스템 레벨로 도는
job (DB 백업, 사업공고 수집, 환율 등) 은 단일 tenant 에 귀속할 수 없다.
사용자가 자기 tenant 컨텍스트에서 MANUAL 트리거하면 tenant_listener 가 자동으로
채워준다. /admin/job-runs 는 SUPER_ADMIN 전용이라 격리상 영향 없음.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class JobRun(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "job_runs"

    # tenant 별 — NULL 이면 시스템 레벨 (스케줄러 cron). MANUAL 트리거 시
    # before_flush listener 가 ContextVar 의 current_tenant_id 로 채움.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )

    # 사람 읽는 이름 — "환율 자동 수집", "DB 자동 백업", 등.
    job_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 코드 식별자 — FX_FETCH, ECOS_INTEREST, FRED_STOCK, DB_BACKUP, ALARM_DISPATCH 등.
    job_kind: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    # RUNNING | SUCCESS | FAILED | SKIPPED
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="RUNNING", index=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 시작~종료 ms. RUNNING 동안엔 NULL.
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # SCHEDULER | MANUAL | API
    triggered_by: Mapped[str] = mapped_column(
        String(20), nullable=False, default="SCHEDULER"
    )
    triggered_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    # 사람 읽기 좋은 한 줄 요약 — "311 rows fetched", "2 alarms sent" 등.
    result_summary: Mapped[str | None] = mapped_column(Text)
    # 실패 시 traceback 또는 에러 메시지.
    error_message: Mapped[str | None] = mapped_column(Text)
    # job 별 구조화 데이터 (소스별 통계, 영향 row 수 등).
    extra: Mapped[dict | None] = mapped_column(JSONB)

    # JOIN 용 — API 응답에서 사용자 이름을 함께 보이려면 selectinload 로 미리 적재.
    triggered_by_user = relationship(
        "User", foreign_keys=[triggered_by_user_id], lazy="raise"
    )
