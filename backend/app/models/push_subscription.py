"""Web Push 구독 (PushSubscription) — 사용자가 PWA 에서 알림 동의 시 1행 추가.

브라우저의 PushManager.subscribe() 가 반환하는 PushSubscription 객체의 핵심
필드(endpoint, keys.p256dh, keys.auth) 를 그대로 저장. webpush 라이브러리가
이 셋과 VAPID 키만 있으면 push 발송 가능.

한 사용자가 여러 기기를 쓰면 여러 row. endpoint 가 unique 키.
브라우저 측에서 구독 해제하면 push 발송 시 410 Gone 응답 → 서버가 그 row 삭제.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class PushSubscription(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "push_subscriptions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # PushManager.subscribe() 가 돌려주는 endpoint URL — 브라우저별 푸시 서비스
    # (FCM/APNS 등). unique — 같은 endpoint 가 두 번 등록되지 않도록.
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # 암호화 키 (브라우저가 발급) — webpush 발송 시 payload 암호화에 사용.
    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    auth: Mapped[str] = mapped_column(String(255), nullable=False)
    # 어떤 기기/브라우저인지 — UI 에서 "내 구독 기기" 목록 표시용.
    user_agent: Mapped[str | None] = mapped_column(String(500))
    # 마지막 발송 성공 시각 — 자주 안 쓰는 구독을 정리하는 데 참고.
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
