"""BankAccount Pydantic 스키마."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


BankAccountStatus = Literal["ACTIVE", "INACTIVE"]


class BankAccountBase(BaseModel):
    bank_name: str = Field(min_length=1, max_length=100)
    account_number: str = Field(min_length=1, max_length=50)
    holder_name: str = Field(min_length=1, max_length=100)
    # ISO 4217 — 3 letter uppercase. KRW/USD/EUR/JPY/CNY/GBP 등.
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    purpose: str | None = None
    swift_code: str | None = None
    iban: str | None = None
    bank_address: str | None = None
    is_primary: bool = False
    status: BankAccountStatus = "ACTIVE"
    memo: str | None = None


class BankAccountCreate(BankAccountBase):
    pass


class BankAccountUpdate(BaseModel):
    bank_name: str | None = Field(default=None, min_length=1, max_length=100)
    account_number: str | None = Field(default=None, min_length=1, max_length=50)
    holder_name: str | None = Field(default=None, min_length=1, max_length=100)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    purpose: str | None = None
    swift_code: str | None = None
    iban: str | None = None
    bank_address: str | None = None
    is_primary: bool | None = None
    status: BankAccountStatus | None = None
    memo: str | None = None
    # 첨부 표시 파일명 변경 — 디스크 파일은 그대로 (UUID), 메타만 갱신.
    passbook_name: str | None = Field(default=None, min_length=1, max_length=255)


class BankAccountOut(BankAccountBase):
    id: UUID
    # 통장사본 첨부 메타 — 경로는 응답에 포함하지 않음.
    passbook_name: str | None = None
    passbook_size: int | None = None
    passbook_mime: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
