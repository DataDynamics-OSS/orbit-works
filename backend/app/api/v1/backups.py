r"""DB / Data 디렉토리 백업 관리 API (SUPER_ADMIN 전용).

Endpoints:
- `GET    /backups[?kind=db|data]` — 백업 디렉터리 절대경로 + 파일 목록 (mtime desc)
- `POST   /backups/run[?kind=db|data]` — 수동 백업 실행 (동기, 성공 시 새 파일 정보)
- `GET    /backups/{name}/download` — zip 다운로드
- `DELETE /backups/{name}`         — 단일 파일 삭제

파일명 화이트리스트 (`^\d{8}(-\d{6})?-(db|data)\.zip$`) 와 `Path.resolve()`
경계 검사로 경로 탈출을 이중 방어.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import require_super_admin
from app.models import User
from app.services.backup import (
    BackupFile,
    backup_dir,
    delete_backup,
    list_backups,
    resolve_backup_path,
    run_data_backup,
    run_db_backup,
)

BackupKind = Literal["db", "data"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/backups", tags=["backups"])


class BackupFileOut(BaseModel):
    name: str
    size: int
    mtime: datetime


class BackupListOut(BaseModel):
    """백업 디렉터리 절대경로 + 파일 목록."""

    dir: str
    files: list[BackupFileOut]


class BackupRunOut(BaseModel):
    file: BackupFileOut


def _to_out(f: BackupFile) -> BackupFileOut:
    return BackupFileOut(name=f.name, size=f.size, mtime=f.mtime)


@router.get("", response_model=BackupListOut)
async def get_backup_list(
    kind: BackupKind | None = Query(default=None),
    _: User = Depends(require_super_admin),
) -> BackupListOut:
    return BackupListOut(
        dir=str(backup_dir()),
        files=[_to_out(f) for f in list_backups(kind=kind)],
    )


@router.post("/run", response_model=BackupRunOut)
async def trigger_backup(
    kind: BackupKind = Query(default="db"),
    user: User = Depends(require_super_admin),
) -> BackupRunOut:
    """수동 백업 실행. pg_dump / zip 압축이 끝날 때까지 요청이 블로킹된다.

    - kind=db  : pg_dump → zip
    - kind=data: upload.dir 전체 → zip (backup.dir 자체는 제외)
    Data 백업은 부피·파일 수에 따라 수십 초~수 분 걸릴 수 있다.
    """
    if kind == "data":
        zip_path = await run_data_backup(manual=True)
    else:
        zip_path = await run_db_backup(manual=True)
    if zip_path is None:
        raise HTTPException(
            status_code=500,
            detail="백업 실행에 실패했습니다. 서버 로그를 확인하세요.",
        )
    try:
        st = zip_path.stat()
    except OSError as exc:
        raise HTTPException(
            status_code=500, detail=f"백업 파일 상태 조회 실패: {exc}"
        ) from exc
    from datetime import timezone
    logger.info(
        "수동 백업 실행: kind=%s file=%s size=%d 관리자=%s",
        kind, zip_path.name, st.st_size, user.id,
    )
    return BackupRunOut(
        file=BackupFileOut(
            name=zip_path.name,
            size=st.st_size,
            mtime=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
        )
    )


@router.get("/{name}/download")
async def download_backup(name: str, _: User = Depends(require_super_admin)) -> FileResponse:
    try:
        path = resolve_backup_path(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.exists():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return FileResponse(
        str(path),
        media_type="application/zip",
        filename=name,
    )


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_backup_file(name: str, user: User = Depends(require_super_admin)) -> None:
    try:
        ok = delete_backup(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    logger.warning("백업 파일 삭제: %s (관리자=%s)", name, user.id)
