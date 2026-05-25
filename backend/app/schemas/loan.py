"""Loan + LoanAttachment Pydantic 스키마."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


LoanType = Literal["SME_FACILITY", "SME_GENERAL", "CORP_OPERATING"]
LoanStatus = Literal["ACTIVE", "CLOSED"]


class LoanAttachmentOut(BaseModel):
    id: UUID
    loan_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    description: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LoanAttachmentUpdate(BaseModel):
    file_name: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None


class LoanBase(BaseModel):
    # 등록 시 bank_account_id 만 받고 bank_name 은 라우터가 snapshot 으로 채움.
    # 그러나 외부에서 bank_name 만 알고 등록하는 케이스도 허용 (FK 미지정 + 자유 은행).
    bank_account_id: UUID | None = None
    bank_name: str | None = Field(default=None, max_length=100)
    category: str | None = Field(default=None, max_length=100)
    loan_type: LoanType
    contract_amount: Decimal = Field(ge=0)
    balance_amount: Decimal = Field(ge=0, default=Decimal("0"))
    interest_pay_day: int | None = Field(default=None, ge=1, le=31)
    maturity_date: date | None = None
    is_overdraft: bool = False
    overdraft_limit: Decimal | None = Field(default=None, ge=0)
    memo: str | None = None
    status: LoanStatus = "ACTIVE"

    @model_validator(mode="after")
    def _check_overdraft_consistency(self) -> "LoanBase":
        # is_overdraft 가 false 면 한도는 NULL 로 강제.
        if not self.is_overdraft:
            self.overdraft_limit = None
        return self


class LoanCreate(LoanBase):
    pass


class LoanUpdate(BaseModel):
    bank_account_id: UUID | None = None
    bank_name: str | None = Field(default=None, max_length=100)
    category: str | None = Field(default=None, max_length=100)
    loan_type: LoanType | None = None
    contract_amount: Decimal | None = Field(default=None, ge=0)
    balance_amount: Decimal | None = Field(default=None, ge=0)
    interest_pay_day: int | None = Field(default=None, ge=1, le=31)
    maturity_date: date | None = None
    is_overdraft: bool | None = None
    overdraft_limit: Decimal | None = Field(default=None, ge=0)
    memo: str | None = None
    status: LoanStatus | None = None


class LoanOut(LoanBase):
    id: UUID
    bank_name: str  # snapshot 항상 채워짐 (NOT NULL)
    # 연결된 bank_account 의 account_number 를 JOIN 으로 derive (표시 전용).
    # FK 가 SET NULL 되면 None.
    bank_account_number: str | None = None
    attachments: list[LoanAttachmentOut] = []
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
