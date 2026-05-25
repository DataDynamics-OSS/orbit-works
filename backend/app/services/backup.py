"""DB / Data 디렉토리 자동·수동 백업 서비스.

두 종류의 백업을 같은 `<backup.dir>` 아래에 저장 (`-db.zip` / `-data.zip` 접미사):
- DB:   `pg_dump` → ZIP — 자동(cron) + 수동
- Data: upload.dir 전체 → ZIP — 수동만 (자동 cron 없음)

스케줄러(scheduler.py) 가 매월 1일 02:00 KST 에 DB 백업만 자동 호출하고,
관리자가 `POST /backups/run?kind=db|data` 로 수동 실행할 수도 있다. 파일명에
HHMMSS 가 포함돼 같은 날 여러 번 실행해도 서로 덮어쓰지 않는다.

부가 헬퍼:
- `list_backups(kind=None)`: kind 필터(`"db"|"data"|None`) 로 파일 목록 반환.
- `resolve_backup_path(name)`: 파일명 유효성 검사 + 절대경로 반환. 경로 탈출
  방어를 위해 `Path.resolve()` 가 백업 디렉터리 하위에 있는지 확인.
- `delete_backup(name)`: 단일 파일 안전 삭제.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.core.config import get_settings

logger = logging.getLogger(__name__)


# 백업 전용 SUPERUSER 자격증명 누락 경고 — 프로세스 생명주기 동안 1회만.
# `backup.db_username` / `db_password` 가 비어 있으면 `database.username`
# (orbit_app, NOBYPASSRLS) 으로 fallback 하는데 pg_dump 가 RLS 정책에 막힘.
# 운영자가 config.yaml 을 안 채운 경우 즉시 알 수 있도록 첫 호출 시 WARNING.
_fallback_warned: bool = False


# 백업 파일명 화이트리스트 — 경로 탈출 방어.
#   <date or datetime>-(db|data).zip
# date only (레거시 db): 20260101-db.zip
# with time (신규):     20260421-143012-db.zip / 20260421-143012-data.zip
_BACKUP_NAME_RE = re.compile(r"^\d{8}(?:-\d{6})?-(db|data)\.zip$")


def backup_dir() -> Path:
    """설정된 백업 디렉터리(절대경로) 를 반환하고 없으면 생성."""
    cfg = get_settings().backup
    p = Path(cfg.dir).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _purge_old(dir_: Path, retention_days: int, *, kind: str = "db") -> None:
    """retention_days 이상 된 *-<kind>.zip 파일 제거. 0 이면 no-op."""
    if retention_days <= 0:
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    for f in dir_.glob(f"*-{kind}.zip"):
        try:
            mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
            if mtime < cutoff:
                f.unlink()
                logger.info("오래된 백업 제거: %s", f.name)
        except OSError as exc:
            logger.warning("백업 제거 실패 (%s): %s", f.name, exc)


@dataclass
class BackupFile:
    """파일 메타데이터 — API/프런트 표시에 그대로 사용."""

    name: str
    size: int
    mtime: datetime  # UTC


def list_backups(kind: str | None = None) -> list[BackupFile]:
    """백업 디렉터리의 *-<kind>.zip 을 최신 mtime 내림차순으로 나열.

    - kind=None  → db / data 모두
    - kind="db"  → DB 덤프만
    - kind="data"→ Data 디렉토리 백업만
    """
    if kind not in (None, "db", "data"):
        raise ValueError(f"알 수 없는 kind: {kind}")
    patterns = (f"*-{kind}.zip",) if kind else ("*-db.zip", "*-data.zip")
    out: list[BackupFile] = []
    base = backup_dir()
    for pat in patterns:
        for f in base.glob(pat):
            try:
                st = f.stat()
            except OSError:
                continue
            out.append(
                BackupFile(
                    name=f.name,
                    size=st.st_size,
                    mtime=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                ),
            )
    out.sort(key=lambda b: b.mtime, reverse=True)
    return out


def resolve_backup_path(name: str) -> Path:
    """파일명 검증 + 실제 경로 반환. 디렉터리 탈출 시도는 ValueError.

    - 화이트리스트 regex 로 이름 형식 확인 (`[0-9-]{8,15}-db.zip`).
    - 최종 경로가 backup_dir() 바로 아래인지 확인 (심볼릭 링크 등 우회 방어).
    """
    if not _BACKUP_NAME_RE.match(name):
        raise ValueError("허용되지 않는 파일명")
    base = backup_dir()
    candidate = (base / name).resolve()
    if candidate.parent != base:
        raise ValueError("백업 디렉터리 밖 경로")
    return candidate


def delete_backup(name: str) -> bool:
    """파일 삭제. 없으면 False, 삭제 성공 시 True."""
    path = resolve_backup_path(name)
    if not path.exists():
        return False
    path.unlink()
    logger.warning("백업 파일 삭제: %s", path.name)
    return True


async def run_db_backup(*, manual: bool = False) -> Path | None:
    """현재 DB 를 pg_dump 로 덤프 → ZIP 압축. 성공 시 생성된 파일 경로 반환.

    `manual` 여부와 무관하게 파일명에 HHMMSS 를 포함해 덮어쓰기를 방지.
    호출자가 로그로 구분할 수 있게 파라미터만 유지.
    """
    cfg = get_settings()
    bcfg = cfg.backup
    if not bcfg.enabled and not manual:
        logger.info("백업 비활성 (config.backup.enabled=false)")
        return None

    db = cfg.database
    out_dir = backup_dir()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    zip_path = out_dir / f"{stamp}-db.zip"

    if shutil.which(bcfg.pg_dump_bin) is None and not Path(bcfg.pg_dump_bin).exists():
        logger.warning(
            "pg_dump 바이너리를 찾을 수 없습니다 (config.backup.pg_dump_bin=%s) — "
            "PATH 또는 절대경로 확인 필요",
            bcfg.pg_dump_bin,
        )
        return None

    # tmp 디렉터리에 .sql 덤프 → zip 으로 묶은 뒤 .sql 삭제.
    with tempfile.TemporaryDirectory() as tmpdir:
        dump_path = Path(tmpdir) / f"{stamp}-db.sql"

        # 백업 전용 자격증명이 설정돼 있으면 그것을 사용 (RLS 우회 권한 보유).
        # 없으면 일반 앱 자격증명으로 시도 (FORCE RLS 테이블이 있으면 실패 가능).
        dump_user = bcfg.db_username or db.username
        dump_pw = bcfg.db_password or db.password

        # 운영 함정: backup.db_username 누락 시 orbit_app (NOBYPASSRLS) 로 시도해
        # pg_dump 가 RLS 정책에 차단됨. 첫 호출 시 WARNING 1회.
        global _fallback_warned
        if not bcfg.db_username and not _fallback_warned:
            logger.warning(
                "backup.db_username 미설정 — database.username(%s) 로 fallback. "
                "RLS 정책으로 pg_dump 가 실패할 수 있음. config.yaml 의 backup 섹션에 "
                "orbit_super(SUPERUSER) 자격증명 명시 권장.",
                dump_user,
            )
            _fallback_warned = True

        env = os.environ.copy()
        env["PGPASSWORD"] = dump_pw

        cmd = [
            bcfg.pg_dump_bin,
            "-h",
            db.host,
            "-p",
            str(db.port),
            "-U",
            dump_user,
            "-d",
            db.name,
            "--no-owner",
            "--no-privileges",
            "-f",
            str(dump_path),
        ]

        logger.info("DB 백업 시작 (%s): %s", "수동" if manual else "자동", zip_path)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await proc.communicate()
        except FileNotFoundError as exc:
            logger.warning(
                "pg_dump 실행 실패 (FileNotFoundError): bin=%s err=%s",
                bcfg.pg_dump_bin, exc, exc_info=True,
            )
            return None

        if proc.returncode != 0:
            logger.warning(
                "pg_dump 실패 (rc=%s) user=%s db=%s host=%s: %s",
                proc.returncode, dump_user, db.name, db.host,
                stderr.decode("utf-8", errors="replace").strip(),
            )
            return None

        try:
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(dump_path, arcname=dump_path.name)
        except OSError as exc:
            logger.warning(
                "백업 zip 생성 실패: path=%s err=%s", zip_path, exc, exc_info=True,
            )
            if zip_path.exists():
                zip_path.unlink(missing_ok=True)
            return None

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    logger.info("DB 백업 완료: %s (%.2f MB)", zip_path, size_mb)

    _purge_old(out_dir, bcfg.retention_days, kind="db")
    return zip_path


async def run_data_backup(*, manual: bool = False) -> Path | None:
    """upload.dir 전체를 ZIP 으로 압축 → `<backup.dir>/YYYYMMDD-HHMMSS-data.zip`.

    수동만 — 자동 cron 등록 안 함. backup.dir 자체(자기 자신) 가 upload.dir
    하위에 있을 때 zip 에 포함되지 않도록 walk 단계에서 제외 (무한 누적 방지).

    압축 중 read 실패한 개별 파일은 skip 하고 경고 로그만 남김 — 부분 백업
    이라도 성공시키는 게 낫다는 판단.

    `manual` 여부와 무관하게 파일명에 HHMMSS 를 포함해 덮어쓰기 방지.
    """
    cfg = get_settings()
    bcfg = cfg.backup

    upload_dir = Path(cfg.upload.dir).resolve()
    if not upload_dir.exists() or not upload_dir.is_dir():
        logger.warning("upload.dir 가 존재하지 않거나 디렉토리가 아닙니다: %s", upload_dir)
        return None

    out_dir = backup_dir()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    zip_path = out_dir / f"{stamp}-data.zip"

    # backup.dir 이 upload.dir 의 하위면 zip 에서 제외 (자기 자신 포함 방지).
    # 그 외 (운영자가 별도 디렉토리로 분리한 경우) 는 제외할 게 없음.
    excluded_root = out_dir if _is_subpath(out_dir, upload_dir) else None

    logger.info(
        "Data 디렉토리 백업 시작 (%s): %s ← %s%s",
        "수동" if manual else "자동",
        zip_path,
        upload_dir,
        f" (제외: {excluded_root})" if excluded_root else "",
    )

    file_count = 0
    skipped = 0
    try:
        with zipfile.ZipFile(
            zip_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True
        ) as zf:
            for root, dirs, files in os.walk(upload_dir, followlinks=False):
                root_path = Path(root).resolve()
                # backup.dir 트리는 통째로 skip — 진입 자체를 차단.
                if excluded_root and (
                    root_path == excluded_root
                    or excluded_root in root_path.parents
                ):
                    dirs[:] = []
                    continue
                # excluded_root 가 바로 다음 자식인 케이스도 차단 (현 root 의 자식 목록에서 제거).
                if excluded_root:
                    dirs[:] = [
                        d for d in dirs
                        if (root_path / d).resolve() != excluded_root
                    ]
                for f in files:
                    fp = Path(root) / f
                    try:
                        arcname = fp.relative_to(upload_dir)
                    except ValueError:
                        continue
                    try:
                        zf.write(fp, arcname=str(arcname))
                        file_count += 1
                    except OSError as exc:
                        skipped += 1
                        logger.warning(
                            "Data 백업 — 파일 skip: %s (%s)", fp, exc,
                        )
    except OSError as exc:
        logger.warning(
            "Data 백업 zip 생성 실패: path=%s err=%s", zip_path, exc, exc_info=True,
        )
        if zip_path.exists():
            zip_path.unlink(missing_ok=True)
        return None

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    logger.info(
        "Data 디렉토리 백업 완료: %s (%.2f MB, files=%d, skipped=%d)",
        zip_path, size_mb, file_count, skipped,
    )

    _purge_old(out_dir, bcfg.data_retention_days, kind="data")
    return zip_path


def _is_subpath(child: Path, parent: Path) -> bool:
    """child 가 parent 의 동일/하위 경로인지. 둘 다 resolve() 된 절대경로 가정."""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False
