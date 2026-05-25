"""작업 이력 (`job_runs`) 통합 트래커.

스케줄러 job·수동 트리거·향후 API 트리거 모두 이 한 군데를 거쳐 row 를 남긴다.
표면 API 는 async context manager `track_job_run` — 호출자는 시작/종료/실패를
신경쓰지 않고 본문만 작성. 예외는 그대로 re-raise (스케줄러 misfire/로깅 동작
유지).

라이프사이클:
1. enter — `RUNNING` row 를 INSERT 후 commit (다른 세션에서 보이도록).
2. yield `JobRunContext` — 호출자가 `summary`/`extra` 를 누적 가능.
3. exit (성공) — `SUCCESS` 로 update + duration_ms 기록.
4. exit (예외) — `FAILED` + traceback + duration_ms 기록 후 re-raise.

세션은 자체적으로 SessionLocal 새로 열어 사용 — 호출자 트랜잭션과 분리.
호출자가 db.rollback() 해도 job_runs 행은 살아남는다 (고의).
"""

from __future__ import annotations

import logging
import time
import traceback
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator
from uuid import UUID

from sqlalchemy import update

from app.core.database import system_session
from app.models import JobRun

logger = logging.getLogger(__name__)


@dataclass
class JobRunContext:
    """track_job_run 본문에서 결과를 쌓는 그릇.

    - `summary` : 사람이 읽는 한 줄 요약. 마지막 값이 row.result_summary 로 저장.
    - `extra`   : JSONB 로 저장될 구조화 데이터. 누적 dict.
    """

    run_id: UUID
    summary: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def set_summary(self, text: str) -> None:
        self.summary = text

    def update_extra(self, **kwargs: Any) -> None:
        self.extra.update(kwargs)


@asynccontextmanager
async def track_job_run(
    *,
    job_name: str,
    job_kind: str,
    triggered_by: str = "SCHEDULER",
    triggered_by_user_id: UUID | None = None,
) -> AsyncIterator[JobRunContext]:
    """작업 실행을 `job_runs` 테이블에 기록한다.

    triggered_by:
        - `SCHEDULER` : APScheduler 가 정해진 cron 으로 트리거 (기본).
        - `MANUAL`    : UI/CLI 에서 사용자가 즉시 실행 (`triggered_by_user_id` 채움).
        - `API`       : 외부 시스템의 webhook/POST (현재 미사용, 후속 작업).
    """
    started_at = datetime.now(timezone.utc)
    started_monotonic = time.monotonic()

    # 1) RUNNING row INSERT — 별도 세션, 즉시 commit.
    async with system_session() as db:
        run = JobRun(
            job_name=job_name,
            job_kind=job_kind,
            status="RUNNING",
            started_at=started_at,
            triggered_by=triggered_by,
            triggered_by_user_id=triggered_by_user_id,
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        run_id = run.id

    ctx = JobRunContext(run_id=run_id)
    try:
        yield ctx
    except Exception as exc:
        # 실패 — FAILED + traceback 기록 후 re-raise.
        finished_at = datetime.now(timezone.utc)
        duration_ms = int((time.monotonic() - started_monotonic) * 1000)
        tb = traceback.format_exc()
        async with system_session() as db:
            await db.execute(
                update(JobRun)
                .where(JobRun.id == run_id)
                .values(
                    status="FAILED",
                    finished_at=finished_at,
                    duration_ms=duration_ms,
                    result_summary=ctx.summary,
                    error_message=tb,
                    extra=ctx.extra or None,
                )
            )
            await db.commit()
        logger.warning(
            "작업 실패: %s (%s) %dms err=%s", job_name, job_kind, duration_ms, exc
        )
        raise
    else:
        # 성공.
        finished_at = datetime.now(timezone.utc)
        duration_ms = int((time.monotonic() - started_monotonic) * 1000)
        async with system_session() as db:
            await db.execute(
                update(JobRun)
                .where(JobRun.id == run_id)
                .values(
                    status="SUCCESS",
                    finished_at=finished_at,
                    duration_ms=duration_ms,
                    result_summary=ctx.summary,
                    extra=ctx.extra or None,
                )
            )
            await db.commit()


async def mark_skipped(
    *,
    job_name: str,
    job_kind: str,
    reason: str,
    triggered_by: str = "SCHEDULER",
    triggered_by_user_id: UUID | None = None,
) -> None:
    """실행 자체를 건너뛴 경우 SKIPPED row 한 줄을 남긴다 (RUNNING 거치지 않음).

    예: 사업공고 소스 키 미설정으로 즉시 스킵. 모니터링 화면에서도 "이 job 은
    오늘 돌긴 했는데 사유로 인해 건너뜀" 임을 보이려면 RUNNING/SUCCESS 가 아니라
    별도 row 로 기록하는 편이 깔끔.
    """
    now = datetime.now(timezone.utc)
    async with system_session() as db:
        db.add(
            JobRun(
                job_name=job_name,
                job_kind=job_kind,
                status="SKIPPED",
                started_at=now,
                finished_at=now,
                duration_ms=0,
                triggered_by=triggered_by,
                triggered_by_user_id=triggered_by_user_id,
                result_summary=reason,
            )
        )
        await db.commit()


async def purge_old_job_runs(*, days: int = 14) -> int:
    """`days` 일 이전의 job_runs 행을 삭제. 삭제된 행 수 반환.

    스케줄러 cleanup job 본문 — 자기 자신도 1 row 를 남기지만 (재귀적), 항상
    남기는 양보다 지우는 양이 훨씬 많으므로 안전.
    """
    from sqlalchemy import delete, text

    async with system_session() as db:
        result = await db.execute(
            delete(JobRun).where(
                JobRun.started_at < text(f"NOW() - INTERVAL '{int(days)} days'")
            )
        )
        await db.commit()
        return result.rowcount or 0


# 컨테이너 재기동·SIGKILL·OOM 등으로 track_job_run 의 finally 가 못 돌면 row 가
# RUNNING 상태로 영구 고착된다. 이 함수가 *startup hook* + *주기 cleanup* 양쪽에서
# 실행되어 stale row 를 FAILED 로 일괄 정리한다.
STALE_RUNNING_THRESHOLD_MINUTES = 60


async def purge_stale_running_jobs(*, minutes: int = STALE_RUNNING_THRESHOLD_MINUTES) -> int:
    """`minutes` 분 이상 RUNNING 인 job_runs 를 FAILED 로 일괄 update.

    finished_at = NOW(), duration_ms = 시작부터 지금까지의 ms,
    error_message = 사유. 정상 처리된 row 는 손대지 않는다 (status 가 RUNNING 인 것만).

    반환: update 된 row 수.
    """
    from sqlalchemy import text

    # minutes 는 우리가 통제하는 int — f-string inline 안전 (SQL 주입 위험 X).
    # SQLAlchemy 의 :name 바인딩은 PostgreSQL `::cast` 와 충돌하므로 회피.
    m = int(minutes)
    sql = text(
        f"""
        UPDATE public.job_runs
           SET status = 'FAILED',
               finished_at = NOW(),
               duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int,
               error_message = COALESCE(error_message, '')
                 || E'\\n[auto-cleanup] RUNNING 상태가 {m}분 이상 지속되어 '
                 || 'FAILED 처리됨 (컨테이너 재기동·외부 API hang·process kill 등으로 '
                 || 'finally 핸들러 미실행 추정).'
         WHERE status = 'RUNNING'
           AND started_at < NOW() - INTERVAL '{m} minutes'
        """
    )
    async with system_session() as db:
        result = await db.execute(sql)
        await db.commit()
        return result.rowcount or 0
