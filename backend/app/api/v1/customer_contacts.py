"""외부 주소록 API (고객 · 협력사 공용).

`customers` 테이블과 강결합된 주소록. 회사 식별은 `customer_id` (FK) 로만 받고,
응답에 `company_name` 은 `customers.name` 에서 JOIN 으로 derive 한다 (드리프트 차단).

`kind` 파라미터로 CUSTOMER / PARTNER 를 구분 — `/contacts` 페이지가 탭별로
별도의 GET 을 발행해 목록을 분리 로드한다. kind 미지정 시 전체 반환.
`customer_id` 파라미터로 특정 회사의 담당자만 가져올 수 있다 (회사 360° 에서 사용).

Endpoints:
- `GET    /customer-contacts`              — 검색(q) · 카테고리(kind) · 회사(customer_id) 필터
- `POST   /customer-contacts`              — 신규 생성 (customer_id 가 있으면 존재 검증)
- `PATCH  /customer-contacts/{contact_id}` — 부분 수정 (exclude_unset)
- `DELETE /customer-contacts/{contact_id}` — 삭제 (hard delete — 이력 보존 불필요)

모든 엔드포인트는 로그인 사용자라면 누구나 접근 가능 (ADMIN 전용 아님).
삭제·변경은 감사 목적으로 INFO/WARNING 로그에 요청자 · 대상 ID 를 남긴다.
"""

from __future__ import annotations

import logging
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Customer, User
from app.models.customer_contact import CustomerContact
from app.schemas.customer_contact import (
    CustomerContactCreate,
    CustomerContactOut,
    CustomerContactUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/customer-contacts", tags=["customer-contacts"])


def _attach_company(contacts: Iterable[CustomerContact]) -> None:
    """transient `company_name` 속성을 customer.name 에서 채움.

    CustomerContactOut 의 from_attributes 가 이 transient 값을 그대로 직렬화한다.
    relationship `CustomerContact.customer` 가 selectinload 로 미리 로드돼 있어야 함.
    """
    for c in contacts:
        c.company_name = c.customer.name if c.customer else None  # type: ignore[attr-defined]


async def _ensure_customer(db: AsyncSession, customer_id: UUID | None) -> None:
    """입력으로 들어온 customer_id 가 실제 존재하는지 확인. 없으면 404.

    FK 제약이 어차피 막아주지만, 422/IntegrityError 보다 명시적인 메시지를 위해
    선검증한다. None 이면 통과 (NULL 허용 — 회사 미배정).
    """
    if customer_id is None:
        return
    exists = (
        await db.execute(select(Customer.id).where(Customer.id == customer_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="지정한 회사를 찾을 수 없습니다.",
        )


@router.get("", response_model=list[CustomerContactOut])
async def list_customer_contacts(
    q: str | None = None,
    kind: str | None = None,
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """주소록 조회 — 이름 오름차순.

    검색 `q` 는 contact 의 이름·직함·전화·휴대·이메일 + 회사(customer.name) 컬럼을
    OR ILIKE. 회사명 검색은 LEFT JOIN customers 로 처리한다 (회사 미지정 row 도 포함).
    """
    stmt = (
        select(CustomerContact)
        .options(selectinload(CustomerContact.customer))
        .order_by(CustomerContact.name.asc())
    )
    if kind:
        stmt = stmt.where(CustomerContact.kind == kind)
    if customer_id is not None:
        stmt = stmt.where(CustomerContact.customer_id == customer_id)
    if q:
        pattern = f"%{q}%"
        stmt = stmt.outerjoin(
            Customer, Customer.id == CustomerContact.customer_id
        ).where(
            or_(
                CustomerContact.name.ilike(pattern),
                CustomerContact.title.ilike(pattern),
                CustomerContact.phone.ilike(pattern),
                CustomerContact.mobile.ilike(pattern),
                CustomerContact.email.ilike(pattern),
                Customer.name.ilike(pattern),
            )
        )
    rows = list((await db.execute(stmt)).scalars().all())
    _attach_company(rows)
    return rows


@router.post("", response_model=CustomerContactOut, status_code=status.HTTP_201_CREATED)
async def create_customer_contact(
    payload: CustomerContactCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_customer(db, payload.customer_id)
    contact = CustomerContact(**payload.model_dump())
    db.add(contact)
    await db.commit()
    await db.refresh(contact, attribute_names=["customer"])
    _attach_company([contact])
    logger.info(
        "주소록 등록: id=%s kind=%s name=%s customer_id=%s (등록자=%s)",
        contact.id,
        contact.kind,
        contact.name,
        contact.customer_id,
        user.id,
    )
    return contact


@router.patch("/{contact_id}", response_model=CustomerContactOut)
async def update_customer_contact(
    contact_id: UUID,
    payload: CustomerContactUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    contact = (
        await db.execute(
            select(CustomerContact)
            .options(selectinload(CustomerContact.customer))
            .where(CustomerContact.id == contact_id)
        )
    ).scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail="주소록 항목을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    if "customer_id" in data:
        await _ensure_customer(db, data["customer_id"])
    for k, v in data.items():
        setattr(contact, k, v)
    await db.commit()
    await db.refresh(contact, attribute_names=["customer"])
    _attach_company([contact])
    logger.info(
        "주소록 수정: id=%s kind=%s 변경필드=%s (수정자=%s)",
        contact.id,
        contact.kind,
        list(data.keys()),
        user.id,
    )
    return contact


@router.delete("/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_customer_contact(
    contact_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    contact = (
        await db.execute(select(CustomerContact).where(CustomerContact.id == contact_id))
    ).scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail="주소록 항목을 찾을 수 없습니다.")
    logger.warning(
        "주소록 삭제: id=%s kind=%s name=%s (삭제자=%s)",
        contact.id,
        contact.kind,
        contact.name,
        user.id,
    )
    await db.delete(contact)
    await db.commit()
