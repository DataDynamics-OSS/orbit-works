"""대칭키 application-level 암호화 (Fernet / AES-128-CBC + HMAC-SHA256).

목적: settings 에 저장되는 외부 자격증명(클라우드 access key, GCP SA JSON 등)
이 DB 백업·로그 dump 에 평문으로 노출되지 않게 한다. 마스터 키는 config.yaml
의 `security.secrets_key` (Fernet base64 32-byte key) — host 파일시스템에만
존재하므로 DB 백업 유출만으로는 복호화 불가.

저장 포맷: `enc:<base64 ciphertext>` 형태로 prefix 를 붙여 평문/암호문 식별.
prefix 없는 값은 그대로 반환 (평문 → 암호문 마이그레이션 중간 상태 안전 처리).

키 회전: 새 Fernet key 발급 → `MultiFernet([new, old])` 로 디코드 호환 → 모든
값 재암호화 → config 에 신키만 두고 구키 제거. 본 모듈은 단일 키만 운용.

사용:
    enc = encrypt_secret("AKIAEXAMPLE")        # → "enc:gAAAAABl..."
    plain = decrypt_secret(enc)                # → "AKIAEXAMPLE"
    decrypt_secret("AKIAEXAMPLE")              # → "AKIAEXAMPLE" (prefix 없음 → 그대로)
    is_encrypted("enc:...")                    # True

config.yaml:
    security:
      secrets_key: "<Fernet key — `python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"`>"
"""

from __future__ import annotations

import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

ENC_PREFIX = "enc:"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    """런타임 마스터 키. 매 호출마다 config 다시 읽지 않도록 LRU 캐시."""
    from app.core.config import get_settings

    key = (get_settings().security.secrets_key or "").encode("ascii")
    if not key:
        raise RuntimeError(
            "security.secrets_key 가 설정되지 않았습니다. "
            "config.yaml 또는 ENV 로 Fernet 키를 지정하세요."
        )
    try:
        return Fernet(key)
    except Exception as exc:
        raise RuntimeError(
            f"security.secrets_key 가 유효한 Fernet 키가 아닙니다: {exc}"
        ) from exc


def reset_fernet_cache() -> None:
    """키 회전·테스트 등 마스터 키가 바뀐 경우 캐시 폐기."""
    _fernet.cache_clear()


def is_encrypted(value: object) -> bool:
    return isinstance(value, str) and value.startswith(ENC_PREFIX)


def encrypt_secret(plain: str | None) -> str:
    """평문 → `enc:` prefix 붙은 암호문. 빈문자열/None → 빈문자열."""
    if not plain:
        return ""
    if is_encrypted(plain):
        # 이미 암호화된 값을 다시 암호화하지 않는다 (UI 가 마스킹된 값을 저장하려는 경우 대비).
        return plain
    token = _fernet().encrypt(plain.encode("utf-8")).decode("ascii")
    return f"{ENC_PREFIX}{token}"


def decrypt_secret(value: str | None) -> str:
    """`enc:` prefix 면 복호화, 아니면 그대로. 빈문자열/None → 빈문자열.

    복호화 실패는 로깅 후 빈문자열 반환 (운영 중 키 불일치 시에도 앱이 죽지 않도록).
    """
    if not value:
        return ""
    if not is_encrypted(value):
        return value
    token = value[len(ENC_PREFIX):]
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        logger.warning("secret 복호화 실패 — Fernet 키 불일치 또는 손상된 토큰")
        return ""
    except Exception as exc:  # pragma: no cover
        logger.warning("secret 복호화 예외: %s", exc)
        return ""
