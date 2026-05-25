"""마케팅 이메일 트래킹 — 오픈 픽셀 / 클릭 리다이렉트 / 수신거부.

특이점: 이 라우터는 **인증 불필요** — 외부 메일 클라이언트에서 호출하는 public
endpoint. JWT 쿠키 없이도 동작해야 함. 대신 send_id 와 unsubscribe token 으로
대상을 식별.

RLS bypass: tenant 컨텍스트가 없으면 RLS 가 row 를 못 보므로, 이 endpoint 들은
`app.bypass_rls` 를 잠시 'true' 로 설정하고 row 를 조회. (감사 로그는 남김.)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import SessionLocal
from app.models import (
    MarketingCampaign,
    MarketingCampaignTouch,
    MarketingEmailSend,
    MarketingEmailUnsubscribe,
)
from app.services.marketing import verify_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing/track", tags=["marketing-tracking"])


# 1×1 투명 PNG (base64). 오픈 픽셀 응답 본문.
_TRANSPARENT_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff"
    b"\xff?\x00\x05\xfe\x02\xfe\xa75\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82"
)


async def _open_session() -> AsyncSession:
    """비인증 엔드포인트용 세션. tenant context 없이 RLS bypass 로 작업."""
    session = SessionLocal()
    await session.execute(text("SET LOCAL app.bypass_rls = 'true'"))
    return session


@router.get("/open/{send_id}.png")
async def track_open(send_id: str) -> Response:
    """오픈 픽셀. 1×1 PNG 항상 반환 — send_id 미확인이어도 200/PNG (사용자에게는
    동일하게 보임). 카운터 증분은 best-effort.
    """
    try:
        from uuid import UUID

        sid = UUID(send_id)
    except ValueError:
        return Response(content=_TRANSPARENT_PNG, media_type="image/png")

    session = await _open_session()
    try:
        send = (
            await session.execute(
                select(MarketingEmailSend).where(MarketingEmailSend.id == sid)
            )
        ).scalar_one_or_none()
        if send and send.status == "SENT":
            now = datetime.now(timezone.utc)
            send.open_count = (send.open_count or 0) + 1
            send.last_opened_at = now
            if not send.first_opened_at:
                send.first_opened_at = now
            session.add(
                MarketingCampaignTouch(
                    tenant_id=send.tenant_id,
                    campaign_id=send.campaign_id,
                    customer_id=send.customer_id,
                    customer_contact_id=send.customer_contact_id,
                    touch_type="OPENED",
                    occurred_at=now,
                )
            )
            await session.commit()
    except Exception as exc:
        logger.warning("오픈 트래킹 실패: send_id=%s err=%s", send_id, exc)
    finally:
        await session.close()

    headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
    }
    return Response(
        content=_TRANSPARENT_PNG, media_type="image/png", headers=headers
    )


@router.get("/click/{send_id}")
async def track_click(send_id: str, url: str = Query(...)):
    """클릭 리다이렉트. 카운터 증분 후 원본 URL 로 302."""
    try:
        from uuid import UUID

        sid = UUID(send_id)
    except ValueError:
        return RedirectResponse(url, status_code=302)

    session = await _open_session()
    try:
        send = (
            await session.execute(
                select(MarketingEmailSend).where(MarketingEmailSend.id == sid)
            )
        ).scalar_one_or_none()
        if send and send.status == "SENT":
            now = datetime.now(timezone.utc)
            send.click_count = (send.click_count or 0) + 1
            send.last_clicked_at = now
            if not send.first_clicked_at:
                send.first_clicked_at = now
            session.add(
                MarketingCampaignTouch(
                    tenant_id=send.tenant_id,
                    campaign_id=send.campaign_id,
                    customer_id=send.customer_id,
                    customer_contact_id=send.customer_contact_id,
                    touch_type="CLICKED",
                    occurred_at=now,
                    extra={"url": url[:500]},
                )
            )
            await session.commit()
    except Exception as exc:
        logger.warning("클릭 트래킹 실패: send_id=%s err=%s", send_id, exc)
    finally:
        await session.close()

    return RedirectResponse(url, status_code=302)


@router.get("/unsubscribe/{token}")
async def unsubscribe_get(token: str) -> Response:
    """수신거부 확인 화면 (GET) — 안내 + 확인 버튼이 POST 와 동일 URL 로 호출.

    1차에서는 단순히 GET 으로 즉시 처리해 사용자 마찰을 줄임 (POST 요구는 봇
    클릭으로 인한 잘못된 수신거부 위험이 있긴 함). 추후 확인 페이지로 분리.
    """
    return await _do_unsubscribe(token)


@router.post("/unsubscribe/{token}")
async def unsubscribe_post(token: str) -> Response:
    return await _do_unsubscribe(token)


async def _do_unsubscribe(token: str) -> Response:
    session = await _open_session()
    try:
        # send_id 가 아니라 token 에 email + tenant 가 인코딩되어 있음.
        # 그러나 tenant_id 가 모름 → 전체 sends 에서 매칭되는 row 를 찾아 tenant 식별.
        # 더 간단히: 임의 send 의 tenant_id 가 아닌, MarketingEmailSend 중 lower(to)
        # 가 token 디코드 결과 email 과 일치하는 row 의 tenant 사용.
        # token = base64(digest:email). email 단독으로 tenant 식별 불가하므로
        # send 의 to_address 와 매칭해 tenant 추출.
        import base64
        try:
            padding = "=" * (-len(token) % 4)
            decoded = base64.urlsafe_b64decode(token + padding).decode()
            _digest, _, email = decoded.partition(":")
        except Exception:
            email = None
        if not email:
            return _unsub_html_response(False, "잘못된 링크입니다.")

        candidate_sends = list(
            (
                await session.execute(
                    select(MarketingEmailSend).where(
                        MarketingEmailSend.to_address.ilike(email)
                    )
                )
            ).scalars()
        )
        # 토큰 위변조 검증 — 각 candidate 의 tenant 로 verify.
        tenant_id = None
        for s in candidate_sends:
            if verify_token(s.tenant_id, token) == email.lower():
                tenant_id = s.tenant_id
                break
        if tenant_id is None:
            return _unsub_html_response(False, "잘못된 링크이거나 만료되었습니다.")

        # 이미 등록되어 있으면 멱등 처리.
        existing = (
            await session.execute(
                select(MarketingEmailUnsubscribe).where(
                    MarketingEmailUnsubscribe.tenant_id == tenant_id,
                    MarketingEmailUnsubscribe.email == email.lower(),
                )
            )
        ).scalar_one_or_none()
        if not existing:
            session.add(
                MarketingEmailUnsubscribe(
                    tenant_id=tenant_id,
                    email=email.lower(),
                    reason="user-link",
                )
            )

        # 해당 email 의 send row 들도 unsubscribed_at 갱신.
        now = datetime.now(timezone.utc)
        for s in candidate_sends:
            if s.tenant_id == tenant_id and not s.unsubscribed_at:
                s.unsubscribed_at = now
        await session.commit()
        logger.info("수신거부 등록: tenant=%s email=%s", tenant_id, email)
        return _unsub_html_response(True, "수신거부가 완료되었습니다.")
    finally:
        await session.close()


def _unsub_html_response(ok: bool, message: str) -> Response:
    color = "#10b981" if ok else "#ef4444"
    html = f"""<!doctype html>
<html lang="ko">
<head><meta charset="utf-8" /><title>수신거부</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background:#f9fafb; color:#111827; margin:0; padding:0;
         display:flex; align-items:center; justify-content:center; min-height:100vh; }}
  .card {{ background:#fff; padding:32px 40px; border-radius:12px;
           box-shadow:0 4px 20px rgba(0,0,0,.06); max-width:480px; }}
  h1 {{ color:{color}; font-size:20px; margin:0 0 12px 0; }}
  p {{ color:#4b5563; margin:0; line-height:1.6; }}
</style></head>
<body><div class="card"><h1>{'✅' if ok else '⚠'} {message}</h1>
<p>{'앞으로 해당 메일 주소로는 마케팅 이메일이 발송되지 않습니다.' if ok else '문제가 지속되면 발송자에게 직접 문의해 주세요.'}</p>
</div></body></html>"""
    return Response(content=html, media_type="text/html; charset=utf-8")
