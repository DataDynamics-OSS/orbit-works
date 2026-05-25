"""임직원 비상연락처 — Pydantic 직렬화."""

from __future__ import annotations

from pydantic import BaseModel


class EmergencyContactItem(BaseModel):
    name: str | None = None
    relation: str | None = None
    phone: str | None = None


class EmergencyContactsList(BaseModel):
    """전체 교체용 — UI 가 N 개를 한 번에 PUT."""
    items: list[EmergencyContactItem]
