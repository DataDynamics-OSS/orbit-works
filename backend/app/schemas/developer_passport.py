"""임직원 여권 — Pydantic 직렬화. passport_number 는 평문 입출력
(DB 저장 시 Fernet 암호화, 응답 시 복호화)."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel

PassportType = Literal["REGULAR", "OFFICIAL", "DIPLOMATIC"]
Gender = Literal["M", "F"]


class PassportIn(BaseModel):
    passport_number: str | None = None
    gender: Gender | None = None
    surname_en: str | None = None
    given_name_en: str | None = None
    nationality: str | None = None
    issue_date: date | None = None
    expiry_date: date | None = None
    issue_country: str | None = None
    passport_type: PassportType | None = None


class PassportOut(PassportIn):
    pass
