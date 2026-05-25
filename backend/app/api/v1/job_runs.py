"""작업 이력 (`job_runs`) API — ADMIN 전용 모니터링.

스케줄러 job·수동 트리거·수집 작업 등 백그라운드 실행 흔적을 통합 그리드로 노출.

Endpoints:
- `GET    /job-runs`              — 목록 (필터: kind/status/days)
- `GET    /job-runs/{id}`         — 단건 (extra/error_message 포함)
- `DELETE /job-runs/cleanup`      — 14 일 이전 row 삭제 (수동 트리거)

ADMIN 외에는 403. 메뉴 자체도 ADMIN 만 보이지만 (menu permissions) API 가드도
중복 적용 — 직접 URL 호출 차단.
"""

from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_super_admin
from app.core.database import get_db
from app.models import JobRun, User
from app.schemas.job_run import JobRunOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/job-runs", tags=["job-runs"])


def _to_out(row: JobRun) -> JobRunOut:
    """JOIN 으로 가져온 user.name 을 transient 필드로 옮긴 뒤 직렬화."""
    user_name = None
    # selectinload 한 user relationship 이 있으면 거기서 이름 추출.
    rel = getattr(row, "triggered_by_user", None)
    if rel is not None:
        user_name = getattr(rel, "name", None)
    return JobRunOut(
        id=row.id,
        job_name=row.job_name,
        job_kind=row.job_kind,
        status=row.status,  # type: ignore[arg-type]
        started_at=row.started_at,
        finished_at=row.finished_at,
        duration_ms=row.duration_ms,
        triggered_by=row.triggered_by,  # type: ignore[arg-type]
        triggered_by_user_id=row.triggered_by_user_id,
        triggered_by_user_name=user_name,
        result_summary=row.result_summary,
        error_message=row.error_message,
        extra=row.extra,
    )


@router.get("", response_model=list[JobRunOut])
async def list_job_runs(
    kind: str | None = Query(None, description="job_kind 정확 일치"),
    status: Literal["RUNNING", "SUCCESS", "FAILED", "SKIPPED"] | None = None,
    days: int = Query(14, ge=1, le=90, description="최근 N 일치만"),
    limit: int = Query(500, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_super_admin),
):
    """필터링된 작업 이력. 기본 14 일·최대 500 행. SUPER_ADMIN 은 모든 tenant job 노출."""
    await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))
    stmt = (
        select(JobRun)
        .options(selectinload(JobRun.triggered_by_user))
        .where(JobRun.started_at >= text(f"NOW() - INTERVAL '{int(days)} days'"))
        .order_by(JobRun.started_at.desc())
        .limit(limit)
    )
    if kind:
        stmt = stmt.where(JobRun.job_kind == kind)
    if status:
        stmt = stmt.where(JobRun.status == status)
    rows = list((await db.execute(stmt)).scalars())
    return [_to_out(r) for r in rows]


@router.get("/{run_id}", response_model=JobRunOut)
async def get_job_run(
    run_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_super_admin),
):
    await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))
    row = (
        await db.execute(
            select(JobRun)
            .options(selectinload(JobRun.triggered_by_user))
            .where(JobRun.id == run_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "작업 이력을 찾을 수 없습니다.")
    return _to_out(row)


@router.delete("/cleanup", response_model=dict)
async def cleanup_old_runs(
    days: int = Query(14, ge=1, le=365),
    user: User = Depends(require_super_admin),
):
    """관리자 수동 정리 — 정상 동작 중에는 매일 03:00 cleanup job 이 자동 수행."""
    from app.services.job_tracking import purge_old_job_runs

    deleted = await purge_old_job_runs(days=days)
    logger.info("job_runs 수동 정리: %d rows 삭제 (>%d 일) by %s", deleted, days, user.id)
    return {"deleted": deleted, "days": days}
