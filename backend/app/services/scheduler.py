"""APScheduler 래퍼 — 런타임 설정 변경에 즉시 반응.

FastAPI lifespan 에서 `start_scheduler()` 을 호출하면 config 기반으로 모든
job 을 등록한다. 이후 UI 에서 scheduler/backup/exchange 설정이 바뀌면
`settings_hooks.dispatch(section)` 이 아래 훅을 호출해 해당 job 만
`reschedule_job` 으로 갱신한다. 앱 재시작 불필요.

등록 job:
- `daily_alerts` (scheduler.daily_alert_hour/minute) — 일일 알림
- `fetch_fx_rate` (exchange.refresh_cron_hour) — 환율 수집
- `db_backup` (backup.{day_of_month,hour,minute}) — 월간 DB 백업
- `fetch_announcements` (announcements.auto_fetch.{hour,minute}) — 사업공고 일간 수집
"""

from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from datetime import date, datetime, timedelta, timezone

from app.core.config import get_settings
from app.core.database import system_session
from app.core.settings_hooks import on_settings_change
from app.services.backup import run_db_backup
from app.services.daily_alerts import run_calendar_event_alarms, run_daily_alerts
from app.services.goal_due import run_goal_due_alerts
from app.services.exchange import backfill_fx_history
from app.services.interest import backfill_interest_history
from app.services.job_tracking import purge_old_job_runs, purge_stale_running_jobs, track_job_run
from app.services.stock import backfill_stock_history

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


async def _fetch_fx_job() -> None:
    """매일 지정 시각에 frankfurter.app 으로부터 daily_backfill_days 일치 범위를
    가져와 upsert. 단건이 아니라 범위 백필을 하는 이유 — 주말·공휴일 휴장 후
    월요일에 재공시되는 이전 평일치 보정값, 그리고 이전 실패 일자 catch-up.
    """
    cfg = get_settings().exchange
    today = date.today()
    start = today - timedelta(days=max(1, cfg.daily_backfill_days))
    async with track_job_run(job_name="환율 자동 수집", job_kind="FX_FETCH") as ctx:
        async with system_session() as db:
            n = await backfill_fx_history(db, start, today, cfg.base, cfg.target)
        ctx.set_summary(f"{cfg.base}/{cfg.target} {start} ~ {today} ({n} rows)")
        ctx.update_extra(base=cfg.base, target=cfg.target, rows=n)
        logger.info(
            "환율 자동 수집 성공: %s/%s %s ~ %s (%d rows)",
            cfg.base, cfg.target, start, today, n,
        )


async def _fetch_interest_job() -> None:
    """금리 자동 수집 — FX 와 같은 daily_backfill_days 윈도우로 범위 백필."""
    cfg = get_settings().exchange
    today = date.today()
    start = today - timedelta(days=max(1, cfg.daily_backfill_days))
    async with track_job_run(
        job_name="금리 자동 수집 (ECOS)", job_kind="ECOS_INTEREST"
    ) as ctx:
        async with system_session() as db:
            n = await backfill_interest_history(db, start, today)
        ctx.set_summary(f"{start} ~ {today} ({n} rows)")
        ctx.update_extra(rows=n)
        if n > 0:
            logger.info("금리 자동 수집 성공: %s ~ %s (%d rows)", start, today, n)


async def _fetch_stock_job() -> None:
    """주가 자동 수집 — FX·금리와 동일한 윈도우. 양 소스(ECOS+FRED) 개별 키 상태
    무관하게 안전하게 동작 (키 없으면 해당 시리즈 건너뜀)."""
    cfg = get_settings().exchange
    today = date.today()
    start = today - timedelta(days=max(1, cfg.daily_backfill_days))
    async with track_job_run(
        job_name="주가 자동 수집 (ECOS+FRED)", job_kind="STOCK_FETCH"
    ) as ctx:
        async with system_session() as db:
            n = await backfill_stock_history(db, start, today)
        ctx.set_summary(f"{start} ~ {today} ({n} rows)")
        ctx.update_extra(rows=n)
        if n > 0:
            logger.info("주가 자동 수집 성공: %s ~ %s (%d rows)", start, today, n)


def _daily_alerts_trigger(tz: str) -> CronTrigger:
    s = get_settings().scheduler
    return CronTrigger(hour=s.daily_alert_hour, minute=s.daily_alert_minute, timezone=tz)


def _fetch_fx_trigger(tz: str) -> CronTrigger:
    e = get_settings().exchange
    return CronTrigger(hour=e.refresh_cron_hour, minute=0, timezone=tz)


def _backup_trigger(tz: str) -> CronTrigger:
    """frequency 별 cron 트리거 생성. DAILY/WEEKLY/MONTHLY 분기."""
    b = get_settings().backup
    freq = (b.frequency or "DAILY").upper()
    if freq == "WEEKLY":
        return CronTrigger(
            day_of_week=b.day_of_week, hour=b.hour, minute=b.minute, timezone=tz,
        )
    if freq == "MONTHLY":
        return CronTrigger(
            day=b.day_of_month, hour=b.hour, minute=b.minute, timezone=tz,
        )
    # DAILY (default)
    return CronTrigger(hour=b.hour, minute=b.minute, timezone=tz)


# ---------------------------------------------------------------------------
# 전자세금계산서 (바로빌) 일간 수집
# ---------------------------------------------------------------------------


def _tax_invoice_config() -> dict:
    """app_settings.tax_invoice 머지된 override. 없으면 빈 dict."""
    from app.core.config import _db_overrides

    return _db_overrides.get("tax_invoice", {}) or {}


def _tax_invoice_trigger(tz: str) -> CronTrigger:
    cfg = _tax_invoice_config().get("auto_fetch", {}) or {}
    hour = int(cfg.get("hour", 3))
    minute = int(cfg.get("minute", 0))
    return CronTrigger(hour=hour, minute=minute, timezone=tz)


# ---------------------------------------------------------------------------
# 클라우드 비용 일간 수집
# ---------------------------------------------------------------------------


def _cloud_cost_config() -> dict:
    """app_settings.cloud_cost 머지된 override (글로벌 fallback). 없으면 빈 dict."""
    from app.core.config import _db_overrides

    return _db_overrides.get("cloud_cost", {}) or {}


def _cloud_cost_trigger(tz: str) -> CronTrigger:
    cfg = _cloud_cost_config().get("auto_fetch", {}) or {}
    hour = int(cfg.get("hour", 4))
    minute = int(cfg.get("minute", 0))
    return CronTrigger(hour=hour, minute=minute, timezone=tz)


async def _daily_cloud_cost_job() -> None:
    """매일 새벽 — tenant 별로 enabled provider 의 일별 비용을 가져온다.

    `fetch_interval_days` > 1 이면 마지막 SUCCESS row 가 그 일수 이내일 때 skip.
    target = 어제 (UTC), `auto_fetch.catchup_days` 만큼 과거를 함께 재수집해
    delayed billing 데이터 정정 반영.
    """
    from sqlalchemy import select as sa_select
    from app.core.config import get_tenant_section
    from app.core.tenant_context import set_current_tenant_id
    from app.models import CloudCostFetch, Tenant
    from app.services.cloud_cost import fetch_and_upsert_range, get_providers

    target = date.today() - timedelta(days=1)
    async with track_job_run(
        job_name="클라우드 비용 일간 수집", job_kind="CLOUD_COST_FETCH"
    ) as ctx:
        async with system_session() as db:
            tenants = list(
                (await db.execute(
                    sa_select(Tenant.id, Tenant.slug)
                    .where(Tenant.is_active.is_(True))
                )).all()
            )

        per_tenant: list[dict] = []
        for tid, slug in tenants:
            tcfg = await get_tenant_section(tid, "cloud_cost")
            if not tcfg.get("enabled"):
                per_tenant.append({"tenant": slug, "status": "SKIPPED", "reason": "disabled"})
                continue

            providers = get_providers(tcfg)
            if not providers:
                per_tenant.append({"tenant": slug, "status": "SKIPPED", "reason": "no_provider"})
                continue

            interval_days = int(tcfg.get("fetch_interval_days", 1) or 1)
            catchup = int((tcfg.get("auto_fetch", {}) or {}).get("catchup_days", 2))
            service_top_n = int(tcfg.get("service_top_n", 20) or 20)

            set_current_tenant_id(tid)
            tenant_summary: dict = {"tenant": slug, "providers": {}}
            try:
                async with system_session(tenant_id=str(tid)) as db:
                    for prov_name, provider in providers.items():
                        # interval gate — 이 provider 의 마지막 SUCCESS 가 N일 이내면 skip.
                        if interval_days > 1:
                            recent = (await db.execute(
                                sa_select(CloudCostFetch)
                                .where(
                                    CloudCostFetch.provider == prov_name,
                                    CloudCostFetch.status == "SUCCESS",
                                )
                                .order_by(CloudCostFetch.started_at.desc())
                                .limit(1)
                            )).scalar_one_or_none()
                            if recent and recent.started_at:
                                age_days = (datetime.now(timezone.utc) - recent.started_at).days
                                if age_days < interval_days:
                                    tenant_summary["providers"][prov_name] = {
                                        "status": "SKIPPED",
                                        "reason": f"interval (last SUCCESS {age_days}d ago)",
                                    }
                                    continue

                        # 단일 range 호출 (catchup_days 만큼) — 1 호출에 모든 일자 처리.
                        range_start = target - timedelta(days=max(0, catchup - 1))
                        rec = await fetch_and_upsert_range(
                            db,
                            provider_name=prov_name,
                            provider=provider,
                            start=range_start,
                            end=target,
                            trigger_kind="SCHEDULED_DAILY",
                            service_top_n=service_top_n,
                        )
                        tenant_summary["providers"][prov_name] = {
                            "range": f"{range_start} ~ {target}",
                            "status": rec.status,
                            "fetched": rec.fetched_count,
                            "created": rec.created_count,
                            "updated": rec.updated_count,
                        }

                    # 알람 규칙 평가 — 수집 끝난 후 같은 tenant 세션에서 실행.
                    from app.services.cloud_cost import evaluate_all_rules
                    try:
                        fired = await evaluate_all_rules(db, target_date=target)
                        tenant_summary["alerts_fired"] = fired
                    except Exception:
                        logger.warning(
                            "알람 평가 실패 tenant=%s", slug, exc_info=True,
                        )
                        tenant_summary["alerts_fired"] = -1
            finally:
                set_current_tenant_id(None)
            per_tenant.append(tenant_summary)

        total_processed = sum(
            1 for r in per_tenant if r.get("status") != "SKIPPED"
        )
        ctx.set_summary(f"tenant {len(per_tenant)} (processed={total_processed})")
        ctx.update_extra(per_tenant=per_tenant)


def _announcements_trigger(tz: str) -> CronTrigger:
    a = get_settings().announcements.auto_fetch
    return CronTrigger(hour=a.hour, minute=a.minute, timezone=tz)


async def _fetch_announcements_job() -> None:
    """매일 새벽에 모든 활성 소스에서 공고 수집. 소스별 예외는 개별 run 에 기록."""
    from app.services.announcements import run_all

    async with track_job_run(
        job_name="사업공고 일간 수집", job_kind="ANNOUNCEMENT_FETCH"
    ) as ctx:
        async with system_session() as db:
            results = await run_all(db, trigger_kind="SCHEDULED")
        ok = sum(1 for r in results if r.status == "OK")
        failed = sum(1 for r in results if r.status == "FAILED")
        skipped = sum(1 for r in results if r.status == "SKIPPED")
        inserted = sum(r.inserted for r in results)
        updated = sum(r.updated for r in results)
        ctx.set_summary(
            f"소스 {len(results)} (ok={ok}, failed={failed}, skipped={skipped}), "
            f"신규={inserted}, 변경={updated}"
        )
        ctx.update_extra(
            sources=len(results),
            ok=ok,
            failed=failed,
            skipped=skipped,
            inserted=inserted,
            updated=updated,
            per_source=[
                {
                    "source": r.source_code,
                    "status": r.status,
                    "fetched": r.fetched,
                    "inserted": r.inserted,
                    "updated": r.updated,
                    "skipped": r.skipped,
                    "error": r.error,
                }
                for r in results
            ],
        )
        logger.info(
            "사업공고 수집 완료: 소스 %d (ok=%d, failed=%d, skipped=%d), "
            "신규=%d, 변경=%d",
            len(results), ok, failed, skipped, inserted, updated,
        )


async def _daily_tax_invoice_job() -> None:
    """스케줄러가 매일 새벽에 호출 — **활성 tenant 별로 분기 실행**.

    각 tenant 의 tax_invoice 설정을 읽어 enabled=true 인 tenant 만 처리.
    tenant 별로 system_session(tenant_id=) 을 열어 RLS 컨텍스트 set + INSERT 시
    tenant_listener 가 tenant_id 자동 채움 → 그 tenant 의 row 로만 적재.
    """
    from sqlalchemy import select as sa_select
    from app.core.config import get_tenant_section
    from app.core.tenant_context import set_current_tenant_id
    from app.models import Tenant
    from app.services.tax_invoice import fetch_and_upsert_daily

    target = date.today() - timedelta(days=1)
    async with track_job_run(
        job_name="전자세금계산서 일간 수집", job_kind="TAX_INVOICE_FETCH"
    ) as ctx:
        # 활성 tenant 목록을 한 번 가져온다 (system 컨텍스트 — bypass_rls=true).
        async with system_session() as db:
            tenants = list(
                (await db.execute(
                    sa_select(Tenant.id, Tenant.slug)
                    .where(Tenant.is_active.is_(True))
                )).all()
            )

        per_tenant: list[dict] = []
        for tid, slug in tenants:
            tcfg = await get_tenant_section(tid, "tax_invoice")
            if not tcfg.get("enabled"):
                per_tenant.append({"tenant": slug, "status": "SKIPPED", "reason": "disabled"})
                continue
            catchup = int((tcfg.get("auto_fetch", {}) or {}).get("catchup_days", 7))
            succeeded: list[str] = []
            failures: list[dict] = []
            # tenant scoped 세션 — INSERT 시 tenant_listener 가 자동 채움.
            set_current_tenant_id(tid)
            try:
                async with system_session(tenant_id=str(tid)) as db:
                    for off in range(catchup):
                        day = target - timedelta(days=off)
                        try:
                            await fetch_and_upsert_daily(
                                db,
                                target=day,
                                trigger_kind="SCHEDULED_DAILY",
                                cfg=tcfg,
                            )
                            succeeded.append(day.isoformat())
                        except Exception as exc:  # pragma: no cover
                            logger.warning(
                                "일간 세금계산서 수집 실패 tenant=%s date=%s: %s",
                                slug, day, exc,
                                exc_info=True,
                            )
                            failures.append({"date": day.isoformat(), "error": str(exc)})
            finally:
                set_current_tenant_id(None)
            per_tenant.append({
                "tenant": slug,
                "status": "OK" if not failures else "PARTIAL",
                "ok_days": succeeded,
                "failed_days": failures,
            })

        total_ok = sum(1 for r in per_tenant if r["status"] == "OK")
        total_partial = sum(1 for r in per_tenant if r["status"] == "PARTIAL")
        total_skipped = sum(1 for r in per_tenant if r["status"] == "SKIPPED")
        ctx.set_summary(
            f"tenant {len(per_tenant)} (ok={total_ok}, partial={total_partial}, "
            f"skipped={total_skipped})"
        )
        ctx.update_extra(per_tenant=per_tenant)


def start_scheduler() -> None:
    """앱 시작 시 1회 호출. enabled=false 면 스케줄러를 아예 생성하지 않는다.

    이 경우 `@on_settings_change("scheduler")` 훅이 enabled=true 로 바뀌면
    재시작 없이 start 하도록 아래에서 처리.
    """
    global _scheduler
    if _scheduler is not None:
        return
    cfg = get_settings().scheduler
    if not cfg.enabled:
        logger.info("스케줄러 비활성 (settings.scheduler.enabled=false)")
        return

    _scheduler = AsyncIOScheduler(timezone=cfg.timezone)
    tz = cfg.timezone

    async def _daily_alerts_job() -> None:
        async with track_job_run(
            job_name="일일 알림 (D-30)", job_kind="DAILY_ALERT"
        ):
            await run_daily_alerts()
            # 만 1년 anniversary 자동 전환 (MONTHLY_ACCRUAL → ANNUAL).
            try:
                from app.api.v1.leaves import run_anniversary_transition
                await run_anniversary_transition()
            except Exception as exc:  # pragma: no cover
                logger.warning("anniversary 전환 실패: %s", exc, exc_info=True)

    _scheduler.add_job(
        _daily_alerts_job,
        trigger=_daily_alerts_trigger(tz),
        id="daily_alerts",
        name="일일 알림 (프로젝트·투입·라이센스 D-30)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # 비공개 일정 당일 09:00 알람 — 같은 daily_alerts 모듈 함수 재사용.
    async def _calendar_alarm_job() -> None:
        async with track_job_run(
            job_name="비공개 일정 알람 (당일 09:00)", job_kind="CALENDAR_ALARM"
        ):
            await run_calendar_event_alarms()

    _scheduler.add_job(
        _calendar_alarm_job,
        trigger=CronTrigger(hour=9, minute=0, timezone=tz),
        id="calendar_alarm",
        name="비공개 일정 알람 (당일 09:00)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # 회의록 액션 아이템 마감 알림 (D-3 / D-1 / D-Day) — 매일 09:05 KST.
    async def _action_item_alerts_job() -> None:
        from app.services.action_item_notify import cron_run_action_item_alerts

        async with track_job_run(
            job_name="회의록 액션 마감 DM (D-3/D-1/D-Day)",
            job_kind="ACTION_ITEM_DUE",
        ):
            await cron_run_action_item_alerts()

    _scheduler.add_job(
        _action_item_alerts_job,
        trigger=CronTrigger(hour=9, minute=5, timezone=tz),
        id="action_item_due_alerts",
        name="회의록 액션 마감 DM (D-3/D-1/D-Day)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # 목표 마감 알림 — D-30 / D-Day 후 첫 영업일. 매일 09:10 KST.
    async def _goal_due_alerts_job() -> None:
        async with track_job_run(
            job_name="목표 마감 알림 (D-30 / 영업일 OVERDUE)",
            job_kind="GOAL_DUE_ALERT",
        ):
            await run_goal_due_alerts()

    _scheduler.add_job(
        _goal_due_alerts_job,
        trigger=CronTrigger(hour=9, minute=10, timezone=tz),
        id="goal_due_alerts",
        name="목표 마감 알림 (D-30 / 영업일 OVERDUE)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    _scheduler.add_job(
        _fetch_fx_job,
        trigger=_fetch_fx_trigger(tz),
        id="fetch_fx_rate",
        name="환율 자동 수집",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # 금리 자동 수집 — FX 와 같은 시각에 함께 실행 (둘 다 당일 마감 후 가용).
    _scheduler.add_job(
        _fetch_interest_job,
        trigger=_fetch_fx_trigger(tz),
        id="fetch_interest_rate",
        name="금리 자동 수집 (ECOS)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # 주가 자동 수집 — ECOS(국내) + FRED(미국) 통합. FX 와 같은 시각.
    _scheduler.add_job(
        _fetch_stock_job,
        trigger=_fetch_fx_trigger(tz),
        id="fetch_stock_price",
        name="주가 자동 수집 (ECOS+FRED)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    async def _db_backup_job() -> None:
        async with track_job_run(
            job_name="DB 자동 백업", job_kind="DB_BACKUP"
        ) as ctx:
            result = await run_db_backup()
            # run_db_backup 이 dict 또는 path 를 반환하는 경우 요약에 사용.
            if isinstance(result, dict):
                ctx.set_summary(
                    str(result.get("path") or result.get("file") or result)
                )
                ctx.update_extra(**result)
            elif result:
                ctx.set_summary(str(result))

    bcfg = get_settings().backup
    if bcfg.enabled:
        _scheduler.add_job(
            _db_backup_job,
            trigger=_backup_trigger(tz),
            id="db_backup",
            name="DB 자동 백업 (pg_dump → zip)",
            coalesce=True,
            misfire_grace_time=3600,
            replace_existing=True,
        )

    # 사업공고 일간 수집 — announcements.auto_fetch.enabled 기본 true.
    ann_auto = get_settings().announcements.auto_fetch
    if get_settings().announcements.enabled and ann_auto.enabled:
        _scheduler.add_job(
            _fetch_announcements_job,
            trigger=_announcements_trigger(tz),
            id="fetch_announcements",
            name="사업공고 일간 수집",
            coalesce=True,
            misfire_grace_time=3600,
            replace_existing=True,
        )

    # 알람 이력 정리 — 매일 04:00 KST 에 7일 지난 alarm_sends 삭제.
    from app.services.alarm import purge_old_alarm_sends

    async def _purge_alarm_sends_job() -> None:
        async with track_job_run(
            job_name="알람 이력 정리", job_kind="ALARM_HISTORY_CLEANUP"
        ) as ctx:
            deleted = await purge_old_alarm_sends(days=7)
            if deleted is not None:
                ctx.set_summary(f"{deleted} rows 삭제 (>7일)")
                ctx.update_extra(deleted=int(deleted))

    _scheduler.add_job(
        _purge_alarm_sends_job,
        trigger=CronTrigger(hour=4, minute=0, timezone=tz),
        id="purge_alarm_sends",
        name="알람 이력 정리 (>7일)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # 작업 이력(job_runs) 정리 — 매일 03:00 에 14 일 이상 지난 row 삭제.
    # 자기 자신도 1 row 를 남기므로 cleanup 은 항상 자기를 제외한 양을 줄인다.
    async def _purge_job_runs_job() -> None:
        async with track_job_run(
            job_name="작업 이력 정리", job_kind="JOB_RUN_CLEANUP"
        ) as ctx:
            deleted = await purge_old_job_runs(days=14)
            ctx.set_summary(f"{deleted} rows 삭제 (>14일)")
            ctx.update_extra(deleted=deleted)

    _scheduler.add_job(
        _purge_job_runs_job,
        trigger=CronTrigger(hour=3, minute=0, timezone=tz),
        id="purge_job_runs",
        name="작업 이력 정리 (>14일)",
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )

    # stale RUNNING job_runs 정리 — 15분마다. 외부 API hang 으로 살아있는 process
    # 안에서 1h+ 묶인 경우도 잡아낸다 (시작 시 hook 만으로는 부족). 이 job 자체는
    # track_job_run 으로 감싸지 않음 — 자기 자신을 정리하면 안 되므로.
    async def _purge_stale_running_job() -> None:
        try:
            n = await purge_stale_running_jobs()
            if n:
                logger.warning("stale RUNNING job_runs %d 건 → FAILED 일괄 변환", n)
        except Exception:
            logger.warning("stale RUNNING job_runs cleanup 실패", exc_info=True)

    _scheduler.add_job(
        _purge_stale_running_job,
        trigger=IntervalTrigger(minutes=15),
        id="purge_stale_running",
        name="stale RUNNING job_runs 정리 (>1h)",
        coalesce=True,
        misfire_grace_time=600,
        replace_existing=True,
    )

    # 전자세금계산서 일간 수집 — app_settings.tax_invoice.auto_fetch.enabled 기본 true.
    ti_auto = (_tax_invoice_config().get("auto_fetch") or {})
    if ti_auto.get("enabled", True):
        _scheduler.add_job(
            _daily_tax_invoice_job,
            trigger=_tax_invoice_trigger(tz),
            id="tax_invoice_daily_fetch",
            name="전자세금계산서 일간 수집 (바로빌)",
            coalesce=True,
            misfire_grace_time=3600,
            replace_existing=True,
        )

    # 클라우드 비용 일간 수집 — app_settings.cloud_cost.auto_fetch.enabled.
    cc_auto = (_cloud_cost_config().get("auto_fetch") or {})
    if cc_auto.get("enabled", True):
        _scheduler.add_job(
            _daily_cloud_cost_job,
            trigger=_cloud_cost_trigger(tz),
            id="cloud_cost_daily_fetch",
            name="클라우드 비용 일간 수집 (AWS/Azure/GCP)",
            coalesce=True,
            misfire_grace_time=3600,
            replace_existing=True,
        )

    _scheduler.start()
    s = get_settings().scheduler
    e = get_settings().exchange
    backup_when = (
        f"매일 {bcfg.hour:02d}:{bcfg.minute:02d}" if bcfg.frequency == "DAILY"
        else (
            f"매주 dow={bcfg.day_of_week} {bcfg.hour:02d}:{bcfg.minute:02d}"
            if bcfg.frequency == "WEEKLY"
            else f"매월 {bcfg.day_of_month:02d}일 {bcfg.hour:02d}:{bcfg.minute:02d}"
        )
    )
    logger.info(
        "스케줄러 시작: daily_alerts @ %02d:%02d, fetch_fx @ %02d:00, "
        "db_backup @ %s (retention=%dd, enabled=%s) %s",
        s.daily_alert_hour,
        s.daily_alert_minute,
        e.refresh_cron_hour,
        backup_when,
        bcfg.retention_days,
        bcfg.enabled,
        cfg.timezone,
    )

    # 사용자 등록 알람(alarms 테이블) 을 DB 에서 읽어 job 으로 등록.
    # 스케줄러가 start 된 후에 sync 해야 add_job 이 즉시 fire 되지 않고 cron 계산.
    import asyncio

    from app.services.alarm import sync_all_alarm_jobs

    try:
        asyncio.get_event_loop().create_task(sync_all_alarm_jobs())
    except Exception as exc:  # pragma: no cover
        logger.warning("알람 초기 동기화 예약 실패: %s", exc, exc_info=True)


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    try:
        _scheduler.shutdown(wait=False)
        logger.info("스케줄러 종료")
    except Exception as exc:  # pragma: no cover
        logger.warning("스케줄러 종료 중 예외: %s", exc)
    finally:
        _scheduler = None


# ---------------------------------------------------------------------------
# Settings reload hooks — 런타임 cron 재등록.
# ---------------------------------------------------------------------------


@on_settings_change("scheduler")
def _on_scheduler_settings_changed() -> None:
    """scheduler 섹션 변경 시 일일 알림 cron 재등록 or 스케줄러 전체 on/off."""
    global _scheduler
    cfg = get_settings().scheduler
    if not cfg.enabled:
        # 스케줄러 종료.
        if _scheduler is not None:
            shutdown_scheduler()
            logger.info("스케줄러 중단됨 (enabled=false)")
        return
    if _scheduler is None:
        # 기존엔 꺼져 있었는데 enabled 가 true 로 바뀐 경우.
        start_scheduler()
        return
    # daily_alerts trigger 재설정.
    _scheduler.reschedule_job(
        "daily_alerts",
        trigger=_daily_alerts_trigger(cfg.timezone),
    )
    logger.info(
        "daily_alerts 재등록 → %02d:%02d",
        cfg.daily_alert_hour,
        cfg.daily_alert_minute,
    )


@on_settings_change("exchange")
def _on_exchange_settings_changed() -> None:
    """exchange.refresh_cron_hour 변경 → fetch_fx_rate job 재등록."""
    if _scheduler is None:
        return
    cfg = get_settings().scheduler
    _scheduler.reschedule_job(
        "fetch_fx_rate",
        trigger=_fetch_fx_trigger(cfg.timezone),
    )
    e = get_settings().exchange
    logger.info("fetch_fx_rate 재등록 → %02d:00", e.refresh_cron_hour)


@on_settings_change("tax_invoice")
def _on_tax_invoice_settings_changed() -> None:
    """tax_invoice 섹션 변경 → daily fetch job 재등록/추가/제거."""
    if _scheduler is None:
        return
    cfg = get_settings().scheduler
    ti_auto = (_tax_invoice_config().get("auto_fetch") or {})
    existing = _scheduler.get_job("tax_invoice_daily_fetch")
    if ti_auto.get("enabled", True):
        if existing is None:
            _scheduler.add_job(
                _daily_tax_invoice_job,
                trigger=_tax_invoice_trigger(cfg.timezone),
                id="tax_invoice_daily_fetch",
                name="전자세금계산서 일간 수집 (바로빌)",
                coalesce=True,
                misfire_grace_time=3600,
                replace_existing=True,
            )
        else:
            _scheduler.reschedule_job(
                "tax_invoice_daily_fetch",
                trigger=_tax_invoice_trigger(cfg.timezone),
            )
        logger.info(
            "tax_invoice_daily_fetch 재등록 → %02d:%02d",
            int(ti_auto.get("hour", 3)),
            int(ti_auto.get("minute", 0)),
        )
    elif existing is not None:
        _scheduler.remove_job("tax_invoice_daily_fetch")
        logger.info("tax_invoice_daily_fetch 제거됨 (enabled=false)")


@on_settings_change("cloud_cost")
def _on_cloud_cost_settings_changed() -> None:
    """cloud_cost 섹션 변경 → daily fetch job 재등록/추가/제거."""
    if _scheduler is None:
        return
    cfg = get_settings().scheduler
    cc_auto = (_cloud_cost_config().get("auto_fetch") or {})
    existing = _scheduler.get_job("cloud_cost_daily_fetch")
    if cc_auto.get("enabled", True):
        if existing is None:
            _scheduler.add_job(
                _daily_cloud_cost_job,
                trigger=_cloud_cost_trigger(cfg.timezone),
                id="cloud_cost_daily_fetch",
                name="클라우드 비용 일간 수집 (AWS/Azure/GCP)",
                coalesce=True,
                misfire_grace_time=3600,
                replace_existing=True,
            )
        else:
            _scheduler.reschedule_job(
                "cloud_cost_daily_fetch",
                trigger=_cloud_cost_trigger(cfg.timezone),
            )
        logger.info(
            "cloud_cost_daily_fetch 재등록 → %02d:%02d",
            int(cc_auto.get("hour", 4)),
            int(cc_auto.get("minute", 0)),
        )
    elif existing is not None:
        _scheduler.remove_job("cloud_cost_daily_fetch")
        logger.info("cloud_cost_daily_fetch 제거됨 (enabled=false)")


@on_settings_change("announcements")
def _on_announcements_settings_changed() -> None:
    """announcements 섹션 변경 → fetch job 재등록/추가/제거."""
    if _scheduler is None:
        return
    cfg = get_settings().scheduler
    a = get_settings().announcements
    existing = _scheduler.get_job("fetch_announcements")
    if a.enabled and a.auto_fetch.enabled:
        if existing is None:
            _scheduler.add_job(
                _fetch_announcements_job,
                trigger=_announcements_trigger(cfg.timezone),
                id="fetch_announcements",
                name="사업공고 일간 수집",
                coalesce=True,
                misfire_grace_time=3600,
                replace_existing=True,
            )
        else:
            _scheduler.reschedule_job(
                "fetch_announcements",
                trigger=_announcements_trigger(cfg.timezone),
            )
        logger.info(
            "fetch_announcements 재등록 → %02d:%02d",
            a.auto_fetch.hour, a.auto_fetch.minute,
        )
    elif existing is not None:
        _scheduler.remove_job("fetch_announcements")
        logger.info("fetch_announcements 제거됨 (enabled=false)")


@on_settings_change("backup")
def _on_backup_settings_changed() -> None:
    """backup 섹션 변경 → db_backup job 재등록/추가/제거."""
    if _scheduler is None:
        return
    cfg = get_settings().scheduler
    bcfg = get_settings().backup
    existing = _scheduler.get_job("db_backup")
    if bcfg.enabled:
        if existing is None:
            _scheduler.add_job(
                run_db_backup,
                trigger=_backup_trigger(cfg.timezone),
                id="db_backup",
                name="DB 자동 백업 (pg_dump → zip)",
                coalesce=True,
                misfire_grace_time=3600,
                replace_existing=True,
            )
        else:
            _scheduler.reschedule_job(
                "db_backup",
                trigger=_backup_trigger(cfg.timezone),
            )
        logger.info(
            "db_backup 재등록 → 매월 %02d일 %02d:%02d",
            bcfg.day_of_month,
            bcfg.hour,
            bcfg.minute,
        )
    else:
        if existing is not None:
            _scheduler.remove_job("db_backup")
            logger.info("db_backup 제거됨 (enabled=false)")
