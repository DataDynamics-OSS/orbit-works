"""런타임 설정 관리 API (ADMIN 전용).

`config.yaml` 섹션을 UI 에서 오버라이드. 저장된 값은 `app_settings` 테이블에
섹션 JSONB 로 기록되며, get_settings() 가 반환하는 런타임 설정에 즉시 반영된다.

Endpoints:
- `GET    /settings`              — 편집 가능한 모든 섹션 반환 (마스킹된 시크릿 포함)
- `GET    /settings/{section}`    — 단일 섹션
- `PUT    /settings/{section}`    — 섹션 오버라이드 저장 + 캐시 invalidate + 훅 실행
- `DELETE /settings/{section}`    — DB 행 제거 (config.yaml 기본값으로 복원)

편집 가능 섹션과 키는 아래 `EDITABLE_KEYS` 에서 화이트리스트로 강제. 그 외
키는 요청에 섞여 와도 무시한다 (서버 재기동·DB·로그 파일 경로 등은 UI 로
변경 불가).

시크릿 필드 (`auth.jwt_secret`, `auth.initial_admin.password`) 는 GET 시
앞 4자 + `***` 로 마스킹되어 반환된다. PUT 요청에 해당 필드가 비어 있거나
마스킹 접두사(`***`) 로 시작하면 **기존 값 유지**, 그 외엔 교체로 해석.

`slack.bot_token` 과 `mail.sender.app_password` 는 사용자 요청으로 평문 노출
— 워크스페이스 내부 공유 전제. 다른 tenant 로의 누수는 DEFAULT_CLEAR_KEYS
가 차단.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin, require_super_admin
from app.core.config import (
    get_settings,
    invalidate_settings_cache,
    invalidate_tenant_section,
    reload_db_overrides,
)
from app.core.database import get_db
from app.core.secrets_crypto import (
    decrypt_secret,
    encrypt_secret,
    is_encrypted,
)
from app.core.settings_hooks import dispatch
from app.models import AppSetting, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# 편집 가능한 키 매트릭스. config.py 의 Settings 필드명을 기준으로 한다.
# 여기 없는 key 는 PUT 요청에 와도 무시. 보안·인프라 키 보호.
# 중첩은 "a.b.c" dot-path 로 표기 (nested dict 까지 흘러감).
# ---------------------------------------------------------------------------
# SUPER_ADMIN 만 접근 가능한 섹션 (시스템 전역 자원).
# - backup: DB 전체 백업 (시스템 레벨)
# - ecos / fred / exchange: 국가 통계·외부 시장 데이터 API key
# - announcements: 공공 데이터포털 source 관리
# - auth: JWT 만료 시간 (전 tenant 공통)
# - upload: 파일 업로드 한도 (FastAPI 단일 프로세스 적용)
# - logging: 로그 레벨 (단일 프로세스 root logger)
# - push: PWA Web Push (VAPID) — deployment 단일 키쌍
SUPER_ADMIN_SECTIONS: set[str] = {
    "backup", "ecos", "fred", "exchange", "announcements",
    "auth", "upload", "logging", "push",
}


def _gate_section(section: str, user: User) -> None:
    """섹션별 접근 권한 가드. SUPER_ADMIN 섹션 / 그 외(tenant ADMIN) 분기."""
    if section in SUPER_ADMIN_SECTIONS:
        if user.role != "SUPER_ADMIN":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="SUPER_ADMIN 만 접근 가능한 섹션입니다.",
            )
    else:
        if user.role != "ADMIN":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin only",
            )


EDITABLE_KEYS: dict[str, list[str]] = {
    "scheduler": [
        "enabled",
        "daily_alert_hour",
        "daily_alert_minute",
        "project_alert_days",
        "assignment_alert_days",
        "license_alert_days",
    ],
    "backup": [
        "enabled",
        "frequency",
        "hour",
        "minute",
        "day_of_week",
        "day_of_month",
        "retention_days",
        # Data 디렉토리 백업 — 자동 cron 없음. retention 만 ops 에서 조정 가능.
        "data_retention_days",
    ],
    "notify": [
        "enabled",
        "provider",
        "slack.bot_token",
        "slack.default_webhook_url",
        "slack.default_channels",
        "slack.default_user_emails",
        "slack.default_user_ids",
        "slack.emoji_prefix",
        "mattermost.base_url",
        "mattermost.bot_token",
        "mattermost.default_team",
        "mattermost.default_channels",
        "mattermost.default_user_emails",
        "notifications.license_expiry_days_before",
        "notifications.license_renewal_prep",
        # 피처별 on/off — Sidebar > 알림 페이지에서 토글. enabled=true 일 때만 효과.
        "gates.approval",
        "gates.leave",
        "gates.meeting",
        "gates.meeting_note",
        "gates.weekly_report",
        "gates.goal",
        "gates.evaluation",
        "gates.alarm",
        "gates.action_item",
        "gates.cloud_cost",
        "gates.developer_auth",
        "gates.expiry_alert",
        "gates.calendar_event",
        "gates.support_case",
        "gates.support_case_comment",
    ],
    "mail": [
        "enabled",
        "default_recipients",
        "smtp.host",
        "smtp.port",
        "smtp.use_tls",
        "smtp.use_ssl",
        "smtp.timeout_seconds",
        "sender.email",
        "sender.name",
        "sender.app_password",
        "notifications.license_expiry_days_before",
        "notifications.license_renewal_prep",
        "notifications.subject_prefix",
    ],
    "auth": [
        "jwt_expires_minutes",
    ],
    "upload": [
        "max_size_mb",
    ],
    "exchange": [
        "base",
        "target",
        "refresh_cron_hour",
    ],
    "ecos": [
        "enabled",
        "api_key",
    ],
    "fred": [
        "enabled",
        "api_key",
    ],
    "kakao_map": [
        "enabled",
        "javascript_key",
        "sdk_version",
        "integrity",
    ],
    "google_map": [
        "enabled",
        "javascript_key",
    ],
    # NHN Cloud SMS — SMS 발송 게이트웨이.
    # 사용자 요청에 따라 값들은 마스킹 없이 평문 표시 (Slack bot_token 과 동일 정책).
    # 신규 tenant 는 enabled=false, app_key/secret_key 빈값으로 시작.
    # url 은 NHN 의 글로벌 엔드포인트 기본값 유지.
    "nhn_cloud_sms": [
        "enabled",
        "url",
        "app_key",
        "secret_key",
    ],
    # 주소록·인력 picker 에서 자동 숨길 임직원 UUID 목록.
    # `/developers?include_hidden=true` 로만 우회 가능 (Employees 페이지 전용).
    "directory": [
        "excluded_developer_ids",
    ],
    "logging": [
        "level",
    ],
    "push": [
        "enabled",
        "vapid_subject",
        "vapid_public_key",
        "vapid_private_key",
    ],
    "tax_invoice": [
        "enabled",
        "provider",
        "certkey",
        "corpnum",
        "user_id",
        "environment",
        "download_pdf",
        "auto_fetch.enabled",
        "auto_fetch.hour",
        "auto_fetch.minute",
        "auto_fetch.catchup_days",
    ],
    "announcements": [
        "enabled",
        "auto_fetch.enabled",
        "auto_fetch.hour",
        "auto_fetch.minute",
        "auto_fetch.catchup_days",
        # sources 는 {code: {enabled, api_key}} 동적 dict — 통째로 허용.
        "sources",
    ],
    "leaves": [
        # 근속 1~21년 차 총 부여 일수 배열. 22년+ 은 마지막 값 적용.
        # 기본값(법정 최저): [15,15,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25]
        "annual_days_by_year",
    ],
    "cloud_cost": [
        "enabled",
        "fetch_interval_days",
        "service_top_n",
        "alert_threshold_krw",
        "auto_fetch.enabled",
        "auto_fetch.hour",
        "auto_fetch.minute",
        "auto_fetch.catchup_days",
        "aws.enabled",
        "aws.access_key_id",
        "aws.secret_access_key",
        "aws.region",
        "aws.accounts",
        "azure.enabled",
        "azure.tenant_id",
        "azure.client_id",
        "azure.client_secret",
        "azure.subscription_ids",
        "gcp.enabled",
        "gcp.service_account_json",
        "gcp.billing_account_id",
        "gcp.bigquery_dataset",
        "gcp.bigquery_table_suffix",
    ],
    "assistant": [
        "enabled",
        "default_provider",
        "max_turns",
        "rate_limit_per_minute",
        "persist_conversations",
        "gemini.enabled",
        "gemini.api_key",
        "gemini.model",
        "claude.enabled",
        "claude.api_key",
        "claude.model",
        "openai.enabled",
        "openai.api_key",
        "openai.model",
        "openai.base_url",
    ],
    # 급여일 — 대시보드 '다음 급여일' 타일 + 향후 급여 모듈 공유.
    "payroll": [
        "payday_of_month",
        "rollback_strategy",
        "include_holidays",
    ],
}

# 마스킹 대상 — GET 시 `***<last4>` 로 치환, PUT 시 `***` 접두사/빈문자열은 "유지".
# Slack bot_token 은 사용자 요청으로 평문 노출 (워크스페이스 내부 공유 전제).
# 대신 DB 에 저장된 값은 admin 만 조회 가능하고, config.yaml 은 과거 커밋에 남으니
# 신규 토큰은 UI 입력 → DB 저장만 사용하고 yaml 은 빈 값 유지 권장.
# 실 저장 값을 GET 응답에서 마스킹(`***xxxx`) 할 필드.
# 여기 등록된 필드는 PUT 시 마스킹값으로 들어오면 현재 값으로 자동 복원됨.
SECRET_KEYS: dict[str, set[str]] = {
    # mail.sender.app_password 는 평문 노출 (사용자 요청 — Slack bot_token 과 동일
    # 정책). DEFAULT_CLEAR_KEYS 가 여전히 다른 tenant 로의 누수는 막아준다.
    "auth": {"jwt_secret", "initial_admin.password"},
}

# 자동 암호화 대상. PUT 시 평문이면 encrypt_secret() 으로 enc:… 변환,
# GET 응답에서는 마스킹(`***<last4>`) 후 반환. SECRET_KEYS 와 차이:
#   - SECRET_KEYS: 마스킹만 (DB 평문 저장).
#   - ENCRYPTED_FIELDS: DB 도 암호문 저장 + 응답 마스킹 + service-time 자동 복호화.
# 따라서 보안 등급이 한 단계 높음. SUPER_ADMIN 의 `/reveal` 엔드포인트로만 평문 노출.
ENCRYPTED_FIELDS: dict[str, set[str]] = {
    "cloud_cost": {
        "aws.access_key_id",
        "aws.secret_access_key",
        "azure.client_secret",
        "gcp.service_account_json",
    },
    "assistant": {
        "gemini.api_key",
        "claude.api_key",
        "openai.api_key",
    },
}

# tenant section 의 row 가 없을 때 config.yaml fallback 에서 *블랭크 처리* 할
# 필드 — 자사 secret 이 다른 tenant 로 새지 않도록. SECRET_KEYS 와 다름:
# 여기 등록된 필드는 마스킹은 안 되지만 (admin 이 자기 row 저장 후엔 평문 표시),
# config.yaml 의 자사 값이 default fallback 으로 새는 건 차단.
DEFAULT_CLEAR_KEYS: dict[str, set[str]] = {
    "notify": {"slack.bot_token", "mattermost.bot_token"},
    "mail": {"sender.app_password"},
    "auth": {"jwt_secret", "initial_admin.password"},
    "tax_invoice": {"certkey"},
    "ecos": {"api_key"},
    "fred": {"api_key"},
    "cloud_cost": {
        "aws.access_key_id", "aws.secret_access_key",
        "azure.client_secret",
        "gcp.service_account_json",
    },
    "assistant": {
        "gemini.api_key", "claude.api_key", "openai.api_key",
    },
    # NHN Cloud SMS 키는 자사 값이 다른 tenant 로 누수되지 않도록 fallback 차단.
    # (url 은 글로벌 엔드포인트라 누수 위험 없어 fallback 허용. 마스킹은 안 함 —
    # 본인 tenant 가 저장한 값은 평문 표시.)
    "nhn_cloud_sms": {"app_key", "secret_key"},
}

# tenant section 의 row 가 없을 때 fallback 에서 *false 강제* 할 boolean 필드.
# config.yaml 에 운영자(자사) 가 켜놓은 enabled=true 가 신규 tenant 의 UI 에
# 그대로 반영되면, 미설정 토큰/키로 잘못된 발송 시도하거나 사용자 혼란 유발.
# 따라서 신규 tenant 는 항상 OFF 로 시작.
DEFAULT_DISABLE_KEYS: dict[str, set[str]] = {
    "notify": {"enabled"},
    "mail": {"enabled"},
    "tax_invoice": {"enabled", "auto_fetch.enabled"},
    "kakao_map": {"enabled"},
    "google_map": {"enabled"},
    "nhn_cloud_sms": {"enabled"},
    "cloud_cost": {
        "enabled",
        "aws.enabled", "azure.enabled", "gcp.enabled",
    },
    "assistant": {
        "enabled",
        "gemini.enabled", "claude.enabled", "openai.enabled",
    },
}

MASK_PREFIX = "***"


def _mask_secret(value: Any) -> str:
    if not value or not isinstance(value, str):
        return ""
    if len(value) <= 4:
        return MASK_PREFIX
    return f"{MASK_PREFIX}{value[-4:]}"


def _is_masked(value: Any) -> bool:
    return isinstance(value, str) and (value == "" or value.startswith(MASK_PREFIX))


def _get_by_path(d: dict, path: str) -> Any:
    parts = path.split(".")
    cur: Any = d
    for p in parts:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur


def _set_by_path(d: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    cur = d
    for p in parts[:-1]:
        if p not in cur or not isinstance(cur[p], dict):
            cur[p] = {}
        cur = cur[p]
    cur[parts[-1]] = value


def _filter_to_editable(section: str, body: dict) -> dict:
    """payload 에서 허용된 키만 추출. 순수 JSON-serializable dict 반환."""
    editable = EDITABLE_KEYS.get(section, [])
    out: dict = {}
    for path in editable:
        v = _get_by_path(body, path)
        if v is None and path not in _flat_keys(body):
            continue
        _set_by_path(out, path, v)
    return out


def _flat_keys(d: dict, prefix: str = "") -> set[str]:
    """dict 를 재귀 탐색해 dot-path 키 집합 반환. None 도 포함 (명시적 null)."""
    out: set[str] = set()
    for k, v in d.items():
        path = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(_flat_keys(v, path))
        else:
            out.add(path)
    return out


def _mask_section(section: str, merged: dict) -> dict:
    """GET 응답용 — 시크릿 필드 마스킹.

    - SECRET_KEYS: 평문 저장이지만 마스킹.
    - ENCRYPTED_FIELDS: 암호문 저장 — 마스킹 시 enc: prefix 떼고 일관 마스크 표시.
      (운영자 UX 상 enc:… 가 그대로 노출되면 혼란.)
    """
    secrets = SECRET_KEYS.get(section, set())
    encrypted = ENCRYPTED_FIELDS.get(section, set())
    if not secrets and not encrypted:
        return merged
    out = _deep_copy_dict(merged)
    for path in secrets:
        val = _get_by_path(out, path)
        if val:
            _set_by_path(out, path, _mask_secret(val))
    for path in encrypted:
        val = _get_by_path(out, path)
        if val:
            # enc: prefix 면 "암호화됨" 표지로 통일 (last4 노출 무의미 — ciphertext 라).
            if is_encrypted(val):
                _set_by_path(out, path, MASK_PREFIX + "ENCRYPTED")
            else:
                # 마이그레이션 잔존 평문 — 일반 마스킹.
                _set_by_path(out, path, _mask_secret(val))
    return out


def _deep_copy_dict(value):
    """JSON-serializable 한정 deep copy — _mask_section 내부용."""
    if isinstance(value, dict):
        return {k: _deep_copy_dict(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy_dict(v) for v in value]
    return value


def _encrypt_section_secrets(section: str, patch: dict, current: dict) -> dict:
    """PUT 처리 — ENCRYPTED_FIELDS 의 평문 값을 enc:… 로 자동 변환.

    동작:
    - 마스킹값(`***...`) 으로 들어오면 → 기존 enc:… 값 유지.
    - 빈문자열 → 빈문자열 (의도적 클리어 허용).
    - 이미 enc:… 면 그대로.
    - 평문이면 encrypt_secret() 으로 변환.
    """
    encrypted = ENCRYPTED_FIELDS.get(section, set())
    if not encrypted:
        return patch
    out = patch
    for path in encrypted:
        new_val = _get_by_path(out, path)
        if new_val is None:
            continue
        if _is_masked(new_val):
            # 마스킹값 = "변경 없음" 의도. 기존값(현재 enc:… 또는 평문) 유지.
            cur_val = _get_by_path(current, path)
            if cur_val is None:
                _set_by_path(out, path, "")
            else:
                _set_by_path(out, path, cur_val)
            continue
        if not isinstance(new_val, str):
            continue
        if new_val == "":
            continue  # 빈문자열 → 클리어 의도, 그대로.
        if is_encrypted(new_val):
            continue  # 이미 암호화됨.
        _set_by_path(out, path, encrypt_secret(new_val))
    return out


def _merge_secrets_from_current(section: str, patch: dict, current: dict) -> dict:
    """PUT 처리 — 요청 패치 안의 시크릿 필드가 마스킹값이면 현재 값 유지."""
    secrets = SECRET_KEYS.get(section, set())
    if not secrets:
        return patch
    out = patch
    for path in secrets:
        new_val = _get_by_path(out, path)
        if _is_masked(new_val):
            cur_val = _get_by_path(current, path)
            if cur_val is not None:
                _set_by_path(out, path, cur_val)
            else:
                # 기존도 없고 새 값도 마스킹이면 필드 자체 제거.
                parts = path.split(".")
                cur_scope = out
                for p in parts[:-1]:
                    if p not in cur_scope:
                        break
                    cur_scope = cur_scope[p]
                else:
                    cur_scope.pop(parts[-1], None)
    return out


def _validate_patch(section: str, patch: dict) -> None:
    """Pydantic Settings 전체 재구성으로 타입 검증.

    section 의 현재 값에 patch 를 얹어서 Settings 로 재검증. 하나라도 실패하면
    400 으로 정제된 에러 메시지 반환.
    """
    base_dump = get_settings().model_dump()
    from app.core.config import _deep_merge, Settings  # 지연 import

    if section not in base_dump:
        raise HTTPException(status_code=400, detail=f"알 수 없는 섹션: {section}")
    merged_section = _deep_merge(base_dump[section], patch)
    trial = {**base_dump, section: merged_section}
    try:
        Settings.model_validate(trial)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"유효하지 않은 설정값: {exc}") from exc


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_settings(
    user: User = Depends(get_current_user),
) -> dict[str, dict]:
    """편집 가능한 섹션 목록. role 별 접근 가능 섹션만 반환.

    - SUPER_ADMIN: SUPER_ADMIN_SECTIONS (backup·ecos·fred·exchange·announcements)
    - tenant ADMIN: 그 외 모든 섹션
    """
    dumped = get_settings().model_dump()
    out: dict[str, dict] = {}
    for section in EDITABLE_KEYS.keys():
        if user.role == "SUPER_ADMIN":
            if section not in SUPER_ADMIN_SECTIONS:
                continue
        else:
            if user.role != "ADMIN":
                continue
            if section in SUPER_ADMIN_SECTIONS:
                continue
        current = dumped.get(section, {})
        out[section] = _mask_section(section, current)
    return out


def _target_tenant_id(section: str, user: User) -> UUID | None:
    """이 섹션이 어느 tenant 의 row 를 다뤄야 하는지.

    - SUPER_ADMIN 섹션: tenant_id IS NULL (글로벌 row)
    - 그 외 (tenant 섹션): user.tenant_id
    """
    if section in SUPER_ADMIN_SECTIONS:
        return None
    return user.tenant_id


async def _load_section_value(
    db: AsyncSession, section: str, user: User
) -> dict:
    """섹션 표시 값. tenant section 은 자기 tenant row → 없으면 config.yaml default.

    SUPER_ADMIN 섹션은 기존 흐름 유지 — get_settings() 의 글로벌 머지 결과 사용.
    """
    if section in SUPER_ADMIN_SECTIONS:
        return get_settings().model_dump().get(section, {})

    target_tid = user.tenant_id
    q = select(AppSetting).where(AppSetting.section == section)
    if target_tid is None:
        q = q.where(AppSetting.tenant_id.is_(None))
    else:
        q = q.where(AppSetting.tenant_id == target_tid)
    row = (await db.execute(q)).scalar_one_or_none()
    if row and isinstance(row.value, dict):
        return row.value
    # row 없으면 config.yaml 구조 그대로 반환하되 SECRET 필드(bot_token,
    # password, api_key 등)는 "" 로 블랭크 — 자사 secret 이 타 tenant 로 새지
    # 않으면서 프런트의 nested 필드 접근(smtp.host 등) 도 undefined 안 되도록.
    template = get_settings().model_dump().get(section, {})
    cleaned = _deep_copy(template)
    for path in DEFAULT_CLEAR_KEYS.get(section, set()):
        cur = _get_by_path(cleaned, path)
        if cur:
            _set_by_path(cleaned, path, "")
    for path in DEFAULT_DISABLE_KEYS.get(section, set()):
        if _get_by_path(cleaned, path) is not None:
            _set_by_path(cleaned, path, False)
    return cleaned


def _deep_copy(value: Any) -> Any:
    """JSON-serializable 한정 deep copy (nested dict/list 안전)."""
    if isinstance(value, dict):
        return {k: _deep_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy(v) for v in value]
    return value


@router.get("/{section}")
async def get_section(
    section: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    if section not in EDITABLE_KEYS:
        raise HTTPException(status_code=404, detail=f"편집 가능한 섹션이 아닙니다: {section}")
    _gate_section(section, user)
    current = await _load_section_value(db, section, user)
    return _mask_section(section, current)


@router.put("/{section}")
async def update_section(
    section: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    if section not in EDITABLE_KEYS:
        raise HTTPException(status_code=404, detail=f"편집 가능한 섹션이 아닙니다: {section}")
    _gate_section(section, user)

    target_tid = _target_tenant_id(section, user)

    # 1. 화이트리스트 기반 payload 정제.
    filtered = _filter_to_editable(section, body)

    # 2. 시크릿 필드는 마스킹값으로 온 경우 현재 값으로 복원.
    current = await _load_section_value(db, section, user)
    filtered = _merge_secrets_from_current(section, filtered, current)
    # 2b. 암호화 대상 필드는 평문 → enc:… 자동 변환.
    filtered = _encrypt_section_secrets(section, filtered, current)

    # 3. Pydantic 전체 재검증.
    _validate_patch(section, filtered)

    # 4. (tenant_id, section) UPSERT.
    q = select(AppSetting).where(AppSetting.section == section)
    if target_tid is None:
        q = q.where(AppSetting.tenant_id.is_(None))
    else:
        q = q.where(AppSetting.tenant_id == target_tid)
    existing = (await db.execute(q)).scalar_one_or_none()
    if existing is None:
        db.add(AppSetting(
            tenant_id=target_tid, section=section,
            value=filtered, updated_by=user.id,
        ))
    else:
        existing.value = filtered
        existing.updated_by = user.id
    await db.commit()

    # 5. 글로벌 섹션은 캐시 재로드 (백그라운드 워커가 본다).
    if target_tid is None:
        await reload_db_overrides()
        # 글로벌 변경은 모든 tenant 의 fallback 에 영향 — 모든 tenant 캐시도 비움
        # (TTL 만으로는 60초 기다려야 하지만 즉시 반영 원함).
        from app.core.config import _tenant_section_cache as _tsc
        for k in [k for k in _tsc if k[1] == section]:
            _tsc.pop(k, None)
    else:
        invalidate_tenant_section(target_tid, section)
    invalidate_settings_cache()
    dispatch(section)

    logger.info(
        "설정 변경: section=%s keys=%s tenant=%s 사용자=%s",
        section, list(_flat_keys(filtered)),
        target_tid, user.id,
    )
    return _mask_section(section, await _load_section_value(db, section, user))


@router.delete("/{section}", status_code=status.HTTP_204_NO_CONTENT)
async def reset_section(
    section: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """섹션 오버라이드 제거 → config.yaml 기본값으로 복원."""
    if section not in EDITABLE_KEYS:
        raise HTTPException(status_code=404, detail=f"편집 가능한 섹션이 아닙니다: {section}")
    _gate_section(section, user)
    target_tid = _target_tenant_id(section, user)
    q = delete(AppSetting).where(AppSetting.section == section)
    if target_tid is None:
        q = q.where(AppSetting.tenant_id.is_(None))
    else:
        q = q.where(AppSetting.tenant_id == target_tid)
    await db.execute(q)
    await db.commit()
    if target_tid is None:
        await reload_db_overrides()
        from app.core.config import _tenant_section_cache as _tsc
        for k in [k for k in _tsc if k[1] == section]:
            _tsc.pop(k, None)
    else:
        invalidate_tenant_section(target_tid, section)
    invalidate_settings_cache()
    dispatch(section)
    logger.info(
        "설정 리셋: section=%s tenant=%s 사용자=%s",
        section, target_tid, user.id,
    )


# ---------------------------------------------------------------------------
# Reveal — 암호화된 필드 평문 조회 (감사 대상, ADMIN/SUPER_ADMIN 만)
# ---------------------------------------------------------------------------


@router.get("/{section}/reveal/{field_path:path}")
async def reveal_encrypted_field(
    section: str,
    field_path: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """ENCRYPTED_FIELDS 의 단일 필드 평문 반환.

    - 권한: 해당 섹션의 일반 게이트와 동일 (super-admin 섹션이면 SUPER_ADMIN, tenant
      섹션이면 ADMIN). 일반 사용자는 접근 불가.
    - 응답: `{"value": "<plain>"}`. 키가 ENCRYPTED_FIELDS 에 없으면 400.
    - 감사 로그: 호출 자체를 logger.warning 로 남겨 추후 추적 가능.
    """
    if section not in EDITABLE_KEYS:
        raise HTTPException(status_code=404, detail=f"편집 가능한 섹션이 아닙니다: {section}")
    _gate_section(section, user)
    if field_path not in ENCRYPTED_FIELDS.get(section, set()):
        raise HTTPException(
            status_code=400,
            detail=f"평문 조회가 허용되지 않은 필드입니다: {section}.{field_path}",
        )
    current = await _load_section_value(db, section, user)
    raw = _get_by_path(current, field_path)
    plain = decrypt_secret(raw) if raw else ""
    logger.warning(
        "암호화 필드 평문 조회: section=%s field=%s tenant=%s 사용자=%s",
        section, field_path, _target_tenant_id(section, user), user.id,
    )
    return {"value": plain}
