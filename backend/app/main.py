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
            # 이 계정은 tenant_id 가 NULL — roles.py / db.sql 의 규약상
            # tenant_id IS NULL 인 유저는 SUPER_ADMIN 이어야 한다.
            # "ADMIN" 으로 만들면 tenant_middleware 가 is_super 를 세우지 않아
            # app.tenant_id GUC 가 빈 값이 되고, RLS 의 tenant_iso 정책이
            # 자기 자신의 users row 조회부터 막아 (deps.get_current_user)
            # 모든 인증 요청이 401 "User not found" 로 떨어진다.
            role="SUPER_ADMIN",
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


async def _bootstrap_db_roles() -> None:
    """앱 DB 롤 (database.username) 이 없으면 SUPERUSER 권한으로 자동 생성.

    PostgreSQL 컨테이너는 POSTGRES_USER 의 SUPERUSER 롤만 만든다. RLS 의
    전제인 NOSUPERUSER NOBYPASSRLS 앱 롤은 별도 CREATE ROLE 이 필요한데,
    이걸 manual 로 처리하면 신규 OSS 사용자의 첫 `docker compose up` 이
    backend 인증 실패로 crash 한다.

    backup 자격증명 (SUPERUSER) 으로 별도 connection 만들어:
      1) database.username 롤 존재 확인 → 없으면 CREATE ROLE
      2) DB / SCHEMA / TABLES / SEQUENCES 권한 부여
      3) ALTER DEFAULT PRIVILEGES — 향후 만들어지는 테이블에도 자동 부여

    멱등 — 매 startup 마다 호출해도 안전.
    backup 자격증명 미설정 시 SKIP (사용자가 manual 로 만든 것으로 가정).
    """
    s = get_settings()
    super_user = s.backup.db_username if s.backup else None
    super_pw = s.backup.db_password if s.backup else None
    if not (super_user and super_pw):
        _boot_logger.warning(
            "backup.db_username/password 미설정 — DB 롤 자동 생성 SKIP. "
            "database.username 롤이 없으면 backend 첫 connection 실패."
        )
        return

    db = s.database
    app_user = db.username
    app_pw = db.password
    if not (app_user and app_pw):
        _boot_logger.warning("database.username/password 미설정 — DB 롤 생성 SKIP")
        return
    # 정상적인 식별자만 — SQL injection 방어 (영숫자·언더스코어만 허용)
    if not all(ch.isalnum() or ch == "_" for ch in app_user):
        _boot_logger.warning("database.username '%s' 에 비표준 문자 — SKIP", app_user)
        return

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    super_url = (
        f"postgresql+asyncpg://{super_user}:{super_pw}"
        f"@{db.host}:{db.port}/{db.name}"
    )
    super_engine = create_async_engine(super_url, isolation_level="AUTOCOMMIT")
    try:
        async with super_engine.connect() as conn:
            exists = await conn.scalar(
                text("SELECT 1 FROM pg_roles WHERE rolname = :n"),
                {"n": app_user},
            )
            if not exists:
                escaped_pw = app_pw.replace("'", "''")
                await conn.execute(text(
                    f'CREATE ROLE "{app_user}" WITH LOGIN '
                    f"PASSWORD '{escaped_pw}' NOSUPERUSER NOBYPASSRLS"
                ))
                _boot_logger.warning(
                    "신규 DB 롤 생성: %s (NOSUPERUSER NOBYPASSRLS) — RLS 적용 대상",
                    app_user,
                )
            # 권한 — 반복 실행해도 idempotent (이미 부여돼도 부작용 없음).
            # REFERENCES 포함 — FK 가진 신규 테이블의 CREATE 가 ALTER TABLE
            # 단계에서 'permission denied for table <referenced>' 막히지 않게.
            for stmt in [
                f'GRANT ALL ON DATABASE "{db.name}" TO "{app_user}"',
                f'GRANT ALL ON SCHEMA public TO "{app_user}"',
                f'GRANT ALL ON ALL TABLES IN SCHEMA public TO "{app_user}"',
                f'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "{app_user}"',
                f'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
                f'  GRANT ALL ON TABLES TO "{app_user}"',
                f'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
                f'  GRANT ALL ON SEQUENCES TO "{app_user}"',
            ]:
                await conn.execute(text(stmt))
    except Exception as exc:  # noqa: BLE001
        _boot_logger.exception("DB 롤 부트스트랩 실패 — 계속 진행: %s", exc)
    finally:
        await super_engine.dispose()


async def _apply_rls_policies() -> None:
    """RLS 정책 일괄 적용 — Base.metadata.create_all 이 만든 테이블 위에.

    Base 는 RLS 정책·트리거를 만들지 않으므로 별도 SUPERUSER 권한이 필요.
    config.yaml 의 backup.db_username / db_password (SUPERUSER 자격증명) 가
    있을 때만 동작. 멱등 — 매 startup 마다 호출해도 안전.

    asyncpg 는 multi-statement SQL 을 한 번에 실행 못 하므로 (DO $$ 블록 +
    개별 ALTER + CREATE POLICY 가 섞임) `psql -f` subprocess 로 처리.
    """
    import asyncio
    import os
    import shutil
    from pathlib import Path

    s = get_settings()
    super_user = s.backup.db_username if s.backup else None
    super_pw = s.backup.db_password if s.backup else None
    if not (super_user and super_pw):
        _boot_logger.warning(
            "backup.db_username/password 미설정 — RLS 정책 자동 적용 SKIP. "
            "RLS 가 필요하면 backup 자격증명을 채우거나 SUPERUSER 로 "
            "backend/sql/rls_policies.sql 을 수동 적용하세요."
        )
        return

    sql_path = Path(__file__).resolve().parents[1] / "sql" / "rls_policies.sql"
    if not sql_path.exists():
        _boot_logger.warning("RLS sql 파일 없음: %s", sql_path)
        return

    psql = shutil.which("psql")
    if psql is None:
        _boot_logger.warning("psql 바이너리 없음 — RLS 적용 SKIP")
        return

    db = s.database
    env = os.environ.copy()
    env["PGPASSWORD"] = super_pw
    try:
        proc = await asyncio.create_subprocess_exec(
            psql,
            "-h", db.host, "-p", str(db.port),
            "-U", super_user, "-d", db.name,
            "-v", "ON_ERROR_STOP=1",
            "-q", "-f", str(sql_path),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            _boot_logger.warning(
                "RLS 정책 적용 실패 — 계속 진행. rc=%s stderr=%s",
                proc.returncode, stderr.decode("utf-8", errors="replace")[:500],
            )
        else:
            _boot_logger.info("RLS 정책 적용 완료 (rls_policies.sql)")
    except Exception as exc:  # noqa: BLE001
        _boot_logger.exception("RLS 적용 중 예외: %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 1) DB 롤 부트스트랩 — orbit_app (또는 database.username) 자동 생성.
    #    이게 없으면 아래 engine.begin() 의 첫 connection 이 인증 실패.
    await _bootstrap_db_roles()
    # 2) 테이블 생성 + RLS 정책 적용 + admin 부트스트랩.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _apply_rls_policies()
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

    # 임직원 가동율 — 빈 테이블이면 올해분 자동 백필 (멱등).
    # 백엔드 startup 자체는 안 막도록 BackgroundTasks 가 아닌 직접 await 지만
    # 24명 × 6개월 ≈ 1~2초 수준. 첫 부팅에서만 의미 있고 이후엔 즉시 skip.
    try:
        from app.services.utilization_recompute import (
            backfill_current_year_if_empty,
        )
        result = await backfill_current_year_if_empty()
        if result:
            _boot_logger.info("임직원 가동율 startup 백필: %s", result)
    except Exception as exc:  # pragma: no cover — 부팅 실패 막지 않음
        _boot_logger.warning("임직원 가동율 백필 실패: %s", exc, exc_info=True)

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
