import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.api.deps import require_admin
from app.core.config import NotifyConfig, get_settings, get_tenant_section
from app.models import User
from app.services.daily_alerts import run_daily_alerts
from app.services.mail import mail_service
from app.services.notify import notify_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotifyTestRequest(BaseModel):
    text: str = "Orbit Works 알람 테스트 메시지"
    channels: list[str] | None = None
    user_emails: list[str] | None = None
    user_ids: list[str] | None = None


class MailTestRequest(BaseModel):
    subject: str = "Orbit Works mail test"
    body: str = "This is a test message from Orbit Works."
    to: list[str] | None = None
    html: bool = False


@router.post("/notify/test")
async def notify_test(
    req: NotifyTestRequest, user: User = Depends(require_admin)
):
    """현재 활성 provider (Slack 또는 Mattermost) 로 테스트 메시지 발송.

    Settings UI 는 tenant 별 app_settings 에 저장하므로 `send_for_tenant`
    경로로 발송 — 글로벌 config.yaml 만 보면 사용자가 UI 에 입력한 값이
    적용되지 않는다.
    `notify.enabled=false` 면 400 — UI 에서도 OFF 시 테스트 차단해야 함.
    """
    raw = await get_tenant_section(user.tenant_id, "notify")
    try:
        cfg = NotifyConfig.model_validate(raw)
    except Exception:
        cfg = get_settings().notify
    if not cfg.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="알람 시스템이 비활성 상태입니다. 활성 후 저장해 주세요.",
        )
    delivered = await notify_service.send_for_tenant(
        user.tenant_id,
        text=req.text,
        channels=req.channels,
        user_emails=req.user_emails,
        user_ids=req.user_ids,
    )
    if not delivered:
        logger.warning(
            "notify/test 실패: tenant=%s provider=%s (요청자=%s)",
            user.tenant_id, cfg.provider, user.id,
        )
    return {"delivered": delivered, "provider": cfg.provider}


@router.post("/mail/test")
async def mail_test(
    req: MailTestRequest, user: User = Depends(require_admin)
):
    """tenant 별 SMTP 설정으로 테스트 메일 발송.

    Settings UI 는 mail 도 tenant 별 app_settings 에 저장 — `send_for_tenant`
    로 가야 사용자가 입력한 SMTP 자격증명이 적용된다.
    """
    delivered = await mail_service.send_for_tenant(
        user.tenant_id,
        subject=req.subject, body=req.body, to=req.to, html=req.html,
    )
    if not delivered:
        logger.warning(
            "mail/test 실패: tenant=%s (요청자=%s)", user.tenant_id, user.id,
        )
    return {"delivered": delivered}


@router.post("/daily-alerts/run")
async def trigger_daily_alerts(
    force: bool = False, _: User = Depends(require_admin)
):
    """수동 실행용 — force=true 이면 같은날 가드를 무시하고 재전송."""
    return await run_daily_alerts(force=force)


@router.post("/goal-due-alerts/run")
async def trigger_goal_due_alerts(_: User = Depends(require_admin)):
    """목표 마감 알림 수동 실행 — dedup 으로 이미 발송된 항목은 자동 skip.

    재발송이 필요하면 goal_due_alerts 의 해당 row 삭제 후 재실행.
    """
    from app.services.goal_due import run_goal_due_alerts as _run

    return await _run()
