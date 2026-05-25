"""프런트엔드가 런타임에 읽어야 하는 외부 연동 설정.

`/settings/*` 는 ADMIN 전용이지만, 일부 연동(Kakao Map JS SDK 등) 은 일반 사용자가
브라우저에 SDK 를 로드할 때 키·integrity 가 필요하다. 그 최소한의 공개 메타만
여기서 노출한다 — 인증된 사용자라면 누구나 GET 가능.

Kakao JavaScript Key 는 어차피 브라우저 로드 시점에 노출되며 (네트워크 탭 +
window.Kakao), Kakao 측에서 등록 도메인으로 매칭 검증되므로 키 자체 노출이
보안 위험이 아님.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.models import User

router = APIRouter(prefix="/integrations", tags=["integrations"])


class KakaoMapPublic(BaseModel):
    """프런트가 SDK 스크립트 태그를 만들 때 쓰는 최소 메타.

    `enabled=False` 면 나머지 필드는 빈 문자열로 반환 — 프런트는 enabled 만 보고
    SDK 로드를 건너뛴다.
    """

    enabled: bool
    javascript_key: str = ""
    sdk_version: str = ""
    integrity: str = ""


@router.get("/kakao-map", response_model=KakaoMapPublic)
async def kakao_map_config(_: User = Depends(get_current_user)) -> KakaoMapPublic:
    cfg = get_settings().kakao_map
    if not cfg.enabled:
        return KakaoMapPublic(enabled=False)
    return KakaoMapPublic(
        enabled=True,
        javascript_key=cfg.javascript_key,
        sdk_version=cfg.sdk_version,
        integrity=cfg.integrity,
    )
