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


# 주소록 UI(입력)가 다루는 종류 — 고객/협력사 탭. 프런트 ContactKind 타입과 동기화.
ContactKind = Literal["CUSTOMER", "PARTNER"]
# DB `customer_contacts.kind` 에 실제로 존재할 수 있는 전체 값. 마케팅 세그먼트가
# 임직원을 kind='EMPLOYEE' shadow contact 로 같은 테이블에 만들어 넣으므로, kind 필터
# 없이 전체를 조회하면 EMPLOYEE 행이 섞인다. 출력 스키마가 이를 허용하지 않으면
# response_model 검증이 목록 전체를 500 으로 떨군다 (실 사고 — 세그먼트 후보 패널이
# 통째로 빔). 입력(Create/Update)은 여전히 CUSTOMER/PARTNER 만 받는다.
StoredContactKind = Literal["CUSTOMER", "PARTNER", "EMPLOYEE"]


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
    # 출력은 EMPLOYEE shadow contact 도 직렬화해야 함 (전체 조회 시 섞임).
    kind: StoredContactKind = "CUSTOMER"
    id: UUID
    # JOIN 으로 채워지는 표시 회사명. 컬럼이 아니므로 입력엔 영향 없음.
    company_name: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
