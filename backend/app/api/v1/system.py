"""시스템 정보 — SUPER_ADMIN 전용 운영 대시보드 데이터.

단일 호스트 (Docker Compose) 운영을 가정. docker-compose 에서 `/`, `/proc`,
`/sys` 를 read-only 로 백엔드 컨테이너에 마운트해 호스트 metric 을 읽는다.
환경변수 `HOST_PROC=/host/proc`, `HOST_ROOT=/host/root` 가 set 되어 있으면
psutil 이 호스트값을 보도록 PROCFS_PATH 를 바꾸고 disk_usage 기준 경로를
`/host/root` 로 보정.

응답에 비밀값(토큰·DSN) 은 절대 포함하지 않는다 — host 이름, 마운트 경로,
프로세스 카운트 정도만.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

import psutil
from fastapi import APIRouter, Depends
from sqlalchemy import select, text

from app.api.deps import require_super_admin
from app.core.config import NotifyConfig, get_tenant_section
from app.core.database import engine, system_session
from app.models import JobRun, Tenant, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/system", tags=["system"])


# ---------------------------------------------------------------------------
# 호스트 path 보정
# ---------------------------------------------------------------------------
# docker-compose 에서 마운트하는 경로 — 비어 있으면 컨테이너 내부 metric.

_HOST_ROOT = os.environ.get("HOST_ROOT", "")  # 예: "/host/root"
_HOST_PROC = os.environ.get("HOST_PROC", "")  # 예: "/host/proc"

if _HOST_PROC and os.path.isdir(_HOST_PROC):
    # psutil 5.x — 환경변수로 procfs 경로 변경. 프로세스 fork 후엔 못 바꾸므로
    # 모듈 import 시점에 한 번만 set.
    psutil.PROCFS_PATH = _HOST_PROC
    logger.info("system: psutil.PROCFS_PATH=%s 호스트 procfs 사용", _HOST_PROC)


def _disk_root() -> str:
    return _HOST_ROOT if _HOST_ROOT and os.path.isdir(_HOST_ROOT) else "/"


# 모듈 로드 시각 — 앱 시작과 거의 동일.
_BOOT_TS = time.time()


# ---------------------------------------------------------------------------
# /metrics — 한 번에 모음 응답 (5초 폴링 대상)
# ---------------------------------------------------------------------------


@router.get("/metrics")
async def get_metrics(_: User = Depends(require_super_admin)) -> dict:
    return {
        "cpu": _cpu(),
        "memory": _memory(),
        "disk": _disk(),
        "db_pool": _db_pool(),
        "db_conn": await _db_conn(),
        "process": _process(),
        "app": await _app_info(),
        "ts": datetime.now(timezone.utc).isoformat(),
    }


def _cpu() -> dict:
    # interval=None — 직전 호출 이후 누적 평균. 첫 호출은 0.0 가능.
    percent = psutil.cpu_percent(interval=None)
    try:
        load = psutil.getloadavg()
    except (AttributeError, OSError):  # Windows 등
        load = (0.0, 0.0, 0.0)
    return {
        "percent": round(percent, 1),
        "count": psutil.cpu_count(logical=True) or 0,
        "count_physical": psutil.cpu_count(logical=False) or 0,
        "load_avg": [round(x, 2) for x in load],
    }


def _memory() -> dict:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return {
        "total": int(vm.total),
        "available": int(vm.available),
        "used": int(vm.used),
        "percent": round(vm.percent, 1),
        "swap": {
            "total": int(sw.total),
            "used": int(sw.used),
            "percent": round(sw.percent, 1),
        },
    }


def _disk() -> list[dict]:
    """루트 + 주요 마운트 포인트.

    호스트 마운트가 있으면 `/host/root` 기준으로 보고, 없으면 컨테이너 fs.
    `psutil.disk_partitions()` 는 컨테이너 안에서 너무 많이 잡힐 수 있어 핵심
    파티션만 골라서 본다 (루트 + /data 류).
    """
    root = _disk_root()
    results: list[dict] = []
    seen: set[str] = set()

    def _add(label: str, path: str) -> None:
        if path in seen:
            return
        try:
            u = psutil.disk_usage(path)
        except (FileNotFoundError, PermissionError):
            return
        seen.add(path)
        results.append({
            "path": label,
            "total": int(u.total),
            "used": int(u.used),
            "free": int(u.free),
            "percent": round(u.percent, 1),
        })

    _add("/", root)
    # 추가로 보고 싶은 마운트들 — 호스트 root 가 마운트되어 있으면 그 안의 경로를 본다.
    for sub in ("data", "var/lib/docker", "var/log"):
        path = os.path.join(root, sub) if root != "/" else "/" + sub
        if os.path.isdir(path):
            _add("/" + sub, path)
    return results


def _db_pool() -> dict:
    pool = engine.pool
    return {
        "size": getattr(pool, "size", lambda: 0)(),
        "checked_in": getattr(pool, "checkedin", lambda: 0)(),
        "checked_out": getattr(pool, "checkedout", lambda: 0)(),
        "overflow": getattr(pool, "overflow", lambda: 0)(),
        "max_overflow": getattr(engine.pool, "_max_overflow", 0),
    }


async def _db_conn() -> dict:
    """PostgreSQL pg_stat_activity 집계 — 현재 DB 의 모든 connection.

    SUPER_ADMIN 전용이지만 시스템 세션(bypass_rls)으로 조회한다 — pg_stat_activity
    는 RLS 와 무관하지만 일관성 위해 system_session.
    """
    sql = text("""
        SELECT
            state,
            COUNT(*)::int AS n,
            COALESCE(MAX(EXTRACT(EPOCH FROM (now() - query_start)))::int, 0) AS longest_s
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
    """)
    out = {
        "total": 0,
        "active": 0,
        "idle": 0,
        "idle_in_tx": 0,
        "longest_running_s": 0,
    }
    try:
        async with system_session() as db:
            rows = (await db.execute(sql)).all()
            for state, n, longest in rows:
                out["total"] += n
                if state == "active":
                    out["active"] = n
                    out["longest_running_s"] = max(out["longest_running_s"], longest)
                elif state == "idle":
                    out["idle"] = n
                elif state == "idle in transaction":
                    out["idle_in_tx"] = n
    except Exception as exc:  # pragma: no cover
        logger.warning("pg_stat_activity 조회 실패: %s", exc)
    return out


def _process() -> dict:
    p = psutil.Process(os.getpid())
    try:
        rss = int(p.memory_info().rss)
    except psutil.Error:
        rss = 0
    try:
        threads = p.num_threads()
    except psutil.Error:
        threads = 0
    try:
        fds = p.num_fds()
    except (psutil.Error, AttributeError):
        fds = 0
    return {
        "pid": p.pid,
        "uptime_s": int(time.time() - _BOOT_TS),
        "rss": rss,
        "threads": threads,
        "fd_count": fds,
    }


async def _app_info() -> dict:
    info = {
        "name": "Orbit Works",
        "started_at": datetime.fromtimestamp(_BOOT_TS, tz=timezone.utc).isoformat(),
        "tenants_count": 0,
        "active_users_count": 0,
    }
    try:
        async with system_session() as db:
            tn = (await db.execute(select(Tenant))).scalars().all()
            info["tenants_count"] = sum(1 for t in tn if getattr(t, "is_active", True))
            users = (
                await db.execute(select(User).where(User.is_active.is_(True)))
            ).scalars().all()
            info["active_users_count"] = len(users)
    except Exception as exc:  # pragma: no cover
        logger.warning("app info 집계 실패: %s", exc)
    return info


# ---------------------------------------------------------------------------
# /health — 컴포넌트별 ok/down + 응답시간
# ---------------------------------------------------------------------------


@router.get("/health")
async def get_health(_: User = Depends(require_super_admin)) -> dict:
    """시스템 헬스 — *시스템 전역* 컴포넌트만.

    SMTP·알람은 tenant 별 설정이라 시스템 헬스가 아닌 별도 섹션으로 분리:
    - 알람: `/system/notify-tenants`
    - SMTP: 동일 패턴으로 향후 추가 가능 (현재는 Settings UI 의 mail/test 로 검증).
    """
    components = []
    components.append(await _check_db())
    components.append(await _check_recent_jobs())
    overall = "ok" if all(c["status"] == "ok" for c in components) else (
        "warn" if any(c["status"] == "warn" for c in components) else "down"
    )
    return {
        "status": overall,
        "components": components,
        "ts": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/notify-tenants")
async def get_notify_tenants(_: User = Depends(require_super_admin)) -> dict:
    """tenant 별 알람(notify) 설정 요약.

    각 tenant 의 `app_settings.section='notify'` 를 읽어 enabled/provider/
    채널 수/유저 수만 응답 (토큰·secret 비노출). 활성 tenant 만 포함.
    """
    rows: list[dict] = []
    async with system_session() as db:
        tenants = (
            await db.execute(
                select(Tenant).where(Tenant.is_active.is_(True)).order_by(Tenant.name)
            )
        ).scalars().all()
    summary_total = 0
    summary_enabled = 0
    by_provider: dict[str, int] = {}
    for t in tenants:
        try:
            raw = await get_tenant_section(t.id, "notify")
            cfg = NotifyConfig.model_validate(raw)
        except Exception as exc:  # pragma: no cover
            logger.warning("notify-tenants: tenant=%s 파싱 실패: %s", t.id, exc)
            cfg = NotifyConfig()
        summary_total += 1
        if cfg.enabled:
            summary_enabled += 1
            by_provider[cfg.provider] = by_provider.get(cfg.provider, 0) + 1
        # provider 별 채널·유저 수 추출 (NotifyConfig 의 sub-config 에 따라 분기).
        sub = getattr(cfg, cfg.provider, None)
        channels = list(getattr(sub, "default_channels", []) or [])
        emails = list(getattr(sub, "default_user_emails", []) or [])
        configured = bool(
            getattr(sub, "bot_token", None) or getattr(sub, "bot_user_oauth_token", None)
        )
        rows.append({
            "tenant_id": str(t.id),
            "tenant_slug": t.slug,
            "tenant_name": t.name,
            "enabled": cfg.enabled,
            "provider": cfg.provider,
            "configured": configured,
            "channels_count": len(channels),
            "user_emails_count": len(emails),
        })
    return {
        "summary": {
            "total": summary_total,
            "enabled": summary_enabled,
            "by_provider": by_provider,
        },
        "tenants": rows,
        "ts": datetime.now(timezone.utc).isoformat(),
    }


async def _check_db() -> dict:
    t0 = time.perf_counter()
    try:
        async with system_session() as db:
            await db.execute(text("SELECT 1"))
        return {
            "name": "PostgreSQL",
            "status": "ok",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "detail": "SELECT 1 응답",
        }
    except Exception as exc:  # pragma: no cover
        return {
            "name": "PostgreSQL",
            "status": "down",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "detail": str(exc),
        }


async def _check_recent_jobs() -> dict:
    """최근 24h 안에 실행된 cron job 들 — 모두 SUCCESS 면 ok, FAILED 있으면 warn."""
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    try:
        async with system_session() as db:
            rows = (
                await db.execute(
                    select(JobRun)
                    .where(JobRun.started_at >= cutoff)
                    .order_by(JobRun.started_at.desc())
                    .limit(50)
                )
            ).scalars().all()
        if not rows:
            return {
                "name": "백그라운드 작업",
                "status": "warn",
                "detail": "최근 24h 실행 기록 없음",
            }
        failed = [r for r in rows if r.status == "FAILED"]
        last_ok = next((r for r in rows if r.status == "SUCCESS"), None)
        if failed:
            return {
                "name": "백그라운드 작업",
                "status": "warn",
                "detail": f"FAILED {len(failed)}건 — 최근: {failed[0].job_name}",
                "last_run_at": failed[0].started_at.isoformat() if failed[0].started_at else None,
            }
        return {
            "name": "백그라운드 작업",
            "status": "ok",
            "detail": f"최근 24h 성공 {len(rows)}건",
            "last_run_at": last_ok.started_at.isoformat() if last_ok else None,
        }
    except Exception as exc:  # pragma: no cover
        return {
            "name": "백그라운드 작업",
            "status": "down",
            "detail": str(exc),
        }


