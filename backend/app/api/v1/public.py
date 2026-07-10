"""Public (unauthenticated) endpoints.

로그인 페이지 등 인증 전 화면이 필요한 메타 정보 노출.
민감 정보는 절대 포함하지 말 것 — JWT 없이 누구나 호출 가능.
"""

from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/app-info")
def get_app_info() -> dict:
    """앱의 비민감 메타데이터. 로그인 페이지가 호출해 데모 배너 등을 결정."""
    s = get_settings()
    return {
        "name": s.app.name,
        "environment": s.app.environment,
        "demo_mode": s.app.demo_mode,
    }
