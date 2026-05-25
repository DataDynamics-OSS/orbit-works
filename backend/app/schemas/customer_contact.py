"""CustomerContact Pydantic 스키마.

프런트 `/contacts` 페이지 4-tab 중 "고객" · "협력사" 탭의 직렬화 계약.
`kind` 필드가 DB 컬럼과 1:1 대응하며 탭 구분에 사용된다. Update 는 부분 갱신이라
모든 필드 Optional (kind 변경도 허용 — 같은 연락처를 고객 ↔ 협력사로 이동 가능).

회사 식별:
- 입력: `customer_id` 만 받는다 (UUID 또는 NULL). 자유 문자열 회사명은 받지 않음.
- 출력: `company_name` 은 customers.name 에서 derive 된 표시 전용 필드.
  router 가 응답 객체의 transient 속성으로 채운다.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


# DB `customer_contacts.kind` 컬럼의 허용 값. 프런트 ContactKind 타입과 동기화.
ContactKind = Literal["CUSTOMER", "PARTNER"]


class CustomerContactBase(BaseModel):
    kind: ContactKind = "CUSTOMER"
    name: str
    customer_id: UUID | None = None
    title: str | None = None
    phone: str | None = None
    mobile: str | None = None
    email: str | None = None
    memo: str | None = None


class CustomerContactCreate(CustomerContactBase):
    pass


class CustomerContactUpdate(BaseModel):
    kind: ContactKind | None = None
    name: str | None = None
    customer_id: UUID | None = None
    title: str | None = None
    phone: str | None = None
    mobile: str | None = None
    email: str | None = None
    memo: str | None = None


class CustomerContactOut(CustomerContactBase):
    id: UUID
    # JOIN 으로 채워지는 표시 회사명. 컬럼이 아니므로 입력엔 영향 없음.
    company_name: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
