import os
import uuid
from pathlib import Path

import aiofiles
from fastapi import HTTPException, UploadFile, status

from app.core.config import get_settings
from app.core.tenant_context import get_current_tenant_id

settings = get_settings()


def _max_bytes() -> int:
    return int(settings.upload.max_size_mb) * 1024 * 1024


def _tenant_prefix() -> str | None:
    """현재 요청의 tenant_id (UUID 문자열) 또는 None (시스템·익명 컨텍스트)."""
    tid = get_current_tenant_id()
    return str(tid) if tid else None


def resolve_upload_path(stored: str) -> Path:
    """DB 에 저장된 경로를 실제 디스크상의 절대/상대 경로로 변환.

    멀티 테넌트: DB 의 path 는 tenant 내 *상대경로* (예: ``patents/<id>/<uuid>.pdf``).
    실제 디스크 경로는 ``<upload.dir>/<tenant_id>/<stored>`` 로 합성.

    - 절대 경로: 역사적 잔존 데이터 방어용으로 그대로 반환.
    - stored 가 upload.dir 디렉터리명(예: 'data/...') 으로 시작: 구 포맷 — 그대로
      반환 (마이그레이션 안 된 잔존 파일).
    - tenant 컨텍스트 없음 (SUPER_ADMIN / 시스템): tenant prefix 없이 ``<upload.dir>/<stored>``
      (구 포맷 호환 — 기존 파일 접근).
    """
    p = Path(stored)
    if p.is_absolute():
        return p
    base = Path(settings.upload.dir)
    if p.parts and p.parts[0] == base.name:
        return p
    tid = _tenant_prefix()
    if tid:
        return base / tid / p
    return base / p


async def _stream_to_file(upload: UploadFile, dest: Path) -> int:
    """Stream the upload to ``dest`` while enforcing the configured size limit.

    If the stream exceeds ``upload.max_size_mb``, the partial file is removed
    and a 413 error is raised. Returns the total bytes written.
    """
    max_bytes = _max_bytes()
    size = 0
    async with aiofiles.open(dest, "wb") as f:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                await f.close()
                try:
                    dest.unlink()
                except OSError:
                    pass
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=(
                        f"파일 크기가 허용 한도({settings.upload.max_size_mb}MB)를"
                        " 초과했습니다."
                    ),
                )
            await f.write(chunk)
    return size


async def save_upload(upload: UploadFile, subdir: str) -> tuple[str, int]:
    """Save the uploaded file and return (stored_path, size).

    멀티 테넌트: 실제 디스크는 ``<upload.dir>/<tenant_id>/<subdir>/<uuid>.<ext>``,
    DB 에 저장하는 path 는 tenant 내 상대 ``<subdir>/<uuid>.<ext>``.
    tenant 컨텍스트가 없으면 구 포맷 (``<upload.dir>/<subdir>/...``) 으로 저장.

    호출자는 ContextVar(current_tenant_id) 가 set 된 요청 흐름 안에서 호출해야
    한다 (require_tenant_user dep 통과한 이후). 시스템/super_admin 컨텍스트에서는
    tenant 가 없어 호출하면 안 됨 — 호출 시 tenant prefix 없이 저장된다.
    """
    subdir_path = Path(subdir)
    base = Path(settings.upload.dir)
    tid = _tenant_prefix()
    base_abs = (base / tid / subdir_path) if tid else (base / subdir_path)
    base_abs.mkdir(parents=True, exist_ok=True)
    ext = Path(upload.filename or "").suffix.lower()
    if not ext or len(ext) > 10 or not all(ch.isalnum() or ch == "." for ch in ext):
        ext = ".bin"
    filename = f"{uuid.uuid4().hex}{ext}"
    dest_abs = base_abs / filename
    size = await _stream_to_file(upload, dest_abs)
    # DB 에는 tenant prefix 없는 상대경로만 저장 (resolve 시점에 합성).
    stored_rel = str(subdir_path / filename)
    return stored_rel, size


async def save_upload_as(
    upload: UploadFile, subdir: str, base_name: str
) -> tuple[str, int]:
    """Save the upload under <dir>/<subdir>/<uuid>.<ext>.

    ``base_name`` 은 이제 사용되지 않지만 (디스크 파일은 모두 랜덤 UUID),
    시그니처 호환을 위해 남겨둔다. "슬롯당 한 파일" 의미는 호출자가 기존
    파일을 ``delete_file(existing.file_path)`` 로 먼저 제거해야 한다.
    """
    return await save_upload(upload, subdir)


def delete_file(path: str) -> None:
    """DB 에 저장된 upload.dir-상대 경로를 받아 실제 파일을 제거.

    `resolve_upload_path` 로 실제 경로를 얻은 뒤 삭제한다. 없으면 조용히 통과.
    """
    try:
        os.remove(resolve_upload_path(path))
    except OSError:
        pass
