import logging
from contextlib import asynccontextmanager
from datetime import date, timedelta

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.database import system_session, engine
from app.core.logging import setup_logging
from app.core.security import hash_password
from app.core.tenant_listener import install_tenant_listener
from app.core.tenant_middleware import TenantContextMiddleware
from app.models import Base, User
from app.services.exchange import backfill_fx_history
from app.services.interest import backfill_interest_history
from app.services.stock import backfill_stock_history
from app.services.scheduler import shutdown_scheduler, start_scheduler

_boot_logger = logging.getLogger(__name__)

setup_logging()
settings = get_settings()


async def _bootstrap_admin() -> None:
    """초기 admin 유저 부트스트랩.

    부트스트랩 시점엔 인증 요청이 없어 ContextVar 가 비어 있으므로 RLS 가
    SELECT/INSERT 를 막는다. 시스템 작업이므로 super_admin 컨텍스트로 set 후 진행.
    """
    from sqlalchemy import text

    admin_cfg = settings.auth.initial_admin
    async with system_session() as db:
        await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))
        result = await db.execute(select(User).where(User.email == admin_cfg.email))
        if result.scalar_one_or_none():
            return
        admin = User(
            email=admin_cfg.email,
            hashed_password=hash_password(admin_cfg.password),
            name="Administrator",
            role="ADMIN",
        )
        db.add(admin)
        await db.commit()


async def _bootstrap_stock_history() -> None:
    """앱 기동 시 ECOS(KR) + FRED(US) 주가지수를 initial_backfill_days 만큼 백필.
    양쪽 키 모두 없으면 no-op, 한쪽만 있으면 해당 region 만 수집.
    """
    ex = get_settings().exchange
    today = date.today()
    start = today - timedelta(days=max(1, ex.initial_backfill_days))
    async with system_session() as db:
        try:
            n = await backfill_stock_history(db, start, today)
            if n > 0:
                _boot_logger.info(
                    "주가 초기 백필 완료: %s ~ %s (%d rows)", start, today, n,
                )
        except Exception as exc:  # pragma: no cover
            _boot_logger.warning("주가 초기 백필 실패: %s", exc)


async def _bootstrap_interest_history() -> None:
    """앱 기동 시 ECOS 에서 initial_backfill_days (기본 90) 일치 금리 시계열 백필.
    ecos.enabled=false 거나 api_key 가 비어 있으면 no-op.
    """
    ex = get_settings().exchange  # 같은 window 공유 (FX 와 동일한 차트 축)
    today = date.today()
    start = today - timedelta(days=max(1, ex.initial_backfill_days))
    async with system_session() as db:
        try:
            n = await backfill_interest_history(db, start, today)
            if n > 0:
                _boot_logger.info(
                    "금리 초기 백필 완료: %s ~ %s (%d rows)", start, today, n,
                )
        except Exception as exc:  # pragma: no cover
            _boot_logger.warning("금리 초기 백필 실패: %s", exc)


async def _bootstrap_fx_history() -> None:
    """앱 기동 시 frankfurter.app 에서 initial_backfill_days 일치 히스토리를
    한 번에 백필. 이후 일일 cron 은 daily_backfill_days 만큼만 갱신하지만,
    초기 DB 에는 넓은 창을 미리 채워 두어야 Dashboard 의 FX 추이가 정상 표시된다.
    네트워크 실패 시 내부 로그만 남기고 기동은 계속 (non-blocking).
    """
    ex = get_settings().exchange
    today = date.today()
    start = today - timedelta(days=max(1, ex.initial_backfill_days))
    async with system_session() as db:
        try:
            n = await backfill_fx_history(db, start, today, ex.base, ex.target)
            _boot_logger.info(
                "환율 초기 백필 완료: %s/%s %s ~ %s (%d rows)",
                ex.base, ex.target, start, today, n,
            )
        except Exception as exc:  # pragma: no cover — best-effort bootstrap
            _boot_logger.warning("환율 초기 백필 실패: %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _bootstrap_admin()
    # DB 에 저장된 런타임 설정 오버라이드를 로드해 get_settings() 가 합성된 값을 반환하게.
    # scheduler 시작 전에 호출해야 cron 스펙이 최신 값으로 등록된다.
    from app.core.config import reload_db_overrides

    await reload_db_overrides()

    # tenant slug 캐시 초기 로드 — 로깅 filter 가 [<slug>] prefix 표기용.
    try:
        from app.core.tenant_context import _load_slug_cache
        await _load_slug_cache()
    except Exception as exc:  # pragma: no cover
        _boot_logger.warning("tenant slug 캐시 초기 로드 실패: %s", exc)

    await _bootstrap_fx_history()
    await _bootstrap_interest_history()
    await _bootstrap_stock_history()

    # 이전 backend 인스턴스가 SIGKILL·재기동·OOM 등으로 finally 못 돌고 죽으면
    # job_runs row 가 RUNNING 상태로 영구 고착됨. 시작 시 1회 정리 (1h 임계).
    try:
        from app.services.job_tracking import purge_stale_running_jobs
        cleaned = await purge_stale_running_jobs()
        if cleaned:
            _boot_logger.warning(
                "stale RUNNING job_runs %d 건 정리 (이전 인스턴스가 finally 미실행 상태로 종료된 것으로 추정)",
                cleaned,
            )
    except Exception as exc:  # pragma: no cover — 부팅 실패 막지 않음
        _boot_logger.warning("stale RUNNING job_runs 정리 실패: %s", exc)

    start_scheduler()
    try:
        yield
    finally:
        shutdown_scheduler()
        await engine.dispose()


app = FastAPI(title=settings.app.name, lifespan=lifespan)

# 멀티 테넌트 — INSERT 자동 tenant_id 채우기 위해 SQLA 이벤트 리스너 등록.
install_tenant_listener()

# 인증된 요청의 tenant_id 를 ContextVar 로 전파. CORS 보다 *내부* 에 (요청 핸들러
# 도달 직전에 set 되도록) 둔다.
app.add_middleware(TenantContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.server.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.app.api_v1_prefix)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}
