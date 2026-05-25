"""Provider 인스턴스 생성. settings 의 자격증명을 자동 복호화하여 주입."""

from __future__ import annotations

from app.core.config import get_tenant_section
from app.core.secrets_crypto import decrypt_secret
from app.services.assistant.provider.base import (
    LLMProvider,
    ProviderError,
    ProviderNotConfigured,
)


async def get_provider(tenant_id, name: str | None = None) -> LLMProvider:
    """tenant 의 assistant 설정에서 default_provider (또는 name 강제) 의 어댑터 인스턴스.

    호출 빈도가 많지 않으므로 캐싱 안 함. 매 호출마다 settings 를 다시 읽어 키
    교체가 즉시 반영되게 한다.
    """
    cfg = await get_tenant_section(tenant_id, "assistant")
    if not cfg.get("enabled"):
        raise ProviderError("어시스턴트가 비활성 상태입니다 (설정 > AI 어시스턴트).")
    target = (name or cfg.get("default_provider") or "gemini").lower()
    sub = cfg.get(target) or {}
    if not sub.get("enabled"):
        raise ProviderNotConfigured(
            f"provider '{target}' 가 활성화되지 않았습니다. (설정 > AI 어시스턴트)"
        )
    api_key = decrypt_secret(sub.get("api_key", "") or "")
    model = (sub.get("model") or "").strip()
    # openai 는 base_url 로 OpenAI 호환 서버(Ollama, vLLM, LM Studio) 가능 — 그 경우
    # 키 검증을 완화하고 빈 값에 placeholder 를 채워준다 (Ollama 는 임의 문자열 허용).
    base_url: str | None = None
    if target == "openai":
        base_url = (sub.get("base_url") or "").strip() or None
        if base_url and not api_key:
            api_key = "ollama"
    if not api_key:
        raise ProviderNotConfigured(
            f"provider '{target}' 의 API key 가 비어 있습니다."
        )
    if not model:
        raise ProviderNotConfigured(
            f"provider '{target}' 의 model 이 지정되지 않았습니다."
        )

    if target == "gemini":
        from app.services.assistant.provider.gemini import GeminiProvider
        return GeminiProvider(api_key=api_key, model=model)
    if target == "claude":
        from app.services.assistant.provider.claude import ClaudeProvider
        return ClaudeProvider(api_key=api_key, model=model)
    if target == "openai":
        from app.services.assistant.provider.openai import OpenAIProvider
        return OpenAIProvider(api_key=api_key, model=model, base_url=base_url)
    raise ProviderError(f"unknown provider: {target}")
