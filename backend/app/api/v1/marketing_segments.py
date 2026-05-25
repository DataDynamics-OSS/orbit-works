"""고객 세그먼트 — 캠페인 수신자 추출 조건 관리."""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Customer,
    CustomerContact,
    CustomerSegment,
    Developer,
    User,
)
from app.schemas.marketing import (
    CustomerSegmentCreate,
    CustomerSegmentOut,
    CustomerSegmentUpdate,
    SegmentRecipient,
)
from app.services.marketing import resolve_recipients

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing/segments", tags=["marketing-segments"])


def _to_out(seg: CustomerSegment, recipient_count: int | None = None) -> CustomerSegmentOut:
    return CustomerSegmentOut(
        id=seg.id,
        name=seg.name,
        description=seg.description,
        customer_ids=list(seg.customer_ids or []),
        contact_ids=list(seg.contact_ids or []),
        developer_ids=list(seg.developer_ids or []),
        include_kinds=list(seg.include_kinds or []),  # type: ignore[arg-type]
        created_by=seg.created_by,
        created_at=seg.created_at,
        updated_at=seg.updated_at,
        recipient_count=recipient_count,
    )


async def _materialize_employee_contacts(
    db: AsyncSession,
    *,
    tenant_id: UUID,
    developer_ids: list[UUID],
) -> list[UUID]:
    """각 developer 의 company_email 을 키로 kind='EMPLOYEE' shadow CustomerContact
    를 lookup-or-create. 반환은 (순서 보존된) contact id 리스트.

    customer_id 는 NULL — 회사 자체가 임직원의 '소속' 이라기보다 tenant 의 내부
    인원이므로 contact 의 회사 FK 와는 다른 차원. 표시는 segment 페이지가 tenant.name
    으로 그룹핑.
    """
    if not developer_ids:
        return []
    devs = list(
        (
            await db.execute(
                select(Developer).where(
                    Developer.id.in_(developer_ids),
                    Developer.tenant_id == tenant_id,
                )
            )
        ).scalars()
    )
    # developer_ids 입력 순서 보존하려고 lookup map 사용.
    by_id = {d.id: d for d in devs}
    out: list[UUID] = []
    for did in developer_ids:
        d = by_id.get(did)
        if d is None or not d.company_email:
            continue
        email_norm = d.company_email.strip().lower()
        existing = (
            await db.execute(
                select(CustomerContact).where(
                    CustomerContact.tenant_id == tenant_id,
                    CustomerContact.kind == "EMPLOYEE",
                    CustomerContact.email == d.company_email,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            existing = CustomerContact(
                tenant_id=tenant_id,
                kind="EMPLOYEE",
                name=d.name,
                customer_id=None,
                email=d.company_email,
                memo=f"내부 임직원 (developer_id={d.id})",
            )
            db.add(existing)
            await db.flush()
            logger.info(
                "세그먼트 — 임직원 shadow contact 생성: dev=%s email=%s contact=%s",
                d.id, email_norm, existing.id,
            )
        # 이름이 바뀌었을 수도 있어 매번 동기화 (가벼움).
        if existing.name != d.name:
            existing.name = d.name
        out.append(existing.id)
    return out


def _merge_unique(a: list[UUID], b: list[UUID]) -> list[UUID]:
    """순서 보존 + 중복 제거."""
    seen: set[UUID] = set()
    result: list[UUID] = []
    for x in list(a) + list(b):
        if x in seen:
            continue
        seen.add(x)
        result.append(x)
    return result


@router.get("", response_model=list[CustomerSegmentOut])
async def list_segments(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(CustomerSegment).order_by(CustomerSegment.updated_at.desc())
            )
        ).scalars()
    )
    out: list[CustomerSegmentOut] = []
    for seg in rows:
        # 발송 전 수신자 수를 같이 반환 — list 화면에서 가독성 높임. 비용은 작음.
        recipients = await resolve_recipients(db, seg)
        out.append(_to_out(seg, recipient_count=len(recipients)))
    return out


@router.post(
    "", response_model=CustomerSegmentOut, status_code=status.HTTP_201_CREATED
)
async def create_segment(
    payload: CustomerSegmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # developer_ids → shadow CustomerContact materialize 후 contact_ids 에 머지.
    extra_contact_ids = await _materialize_employee_contacts(
        db, tenant_id=user.tenant_id, developer_ids=list(payload.developer_ids),
    )
    merged_contact_ids = _merge_unique(list(payload.contact_ids), extra_contact_ids)
    seg = CustomerSegment(
        name=payload.name,
        description=payload.description,
        customer_ids=list(payload.customer_ids),
        contact_ids=merged_contact_ids,
        developer_ids=list(payload.developer_ids),
        include_kinds=list(payload.include_kinds),
        created_by=user.id,
    )
    db.add(seg)
    await db.commit()
    await db.refresh(seg)
    logger.info(
        "세그먼트 등록: id=%s name=%s 고객수=%d 컨택수=%d 직원수=%d (등록자=%s)",
        seg.id,
        seg.name,
        len(seg.customer_ids),
        len(seg.contact_ids),
        len(seg.developer_ids),
        user.id,
    )
    recipients = await resolve_recipients(db, seg)
    return _to_out(seg, recipient_count=len(recipients))


@router.get("/{segment_id}", response_model=CustomerSegmentOut)
async def get_segment(
    segment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    seg = (
        await db.execute(select(CustomerSegment).where(CustomerSegment.id == segment_id))
    ).scalar_one_or_none()
    if not seg:
        raise HTTPException(404, "세그먼트를 찾을 수 없습니다.")
    recipients = await resolve_recipients(db, seg)
    return _to_out(seg, recipient_count=len(recipients))


@router.patch("/{segment_id}", response_model=CustomerSegmentOut)
async def update_segment(
    segment_id: UUID,
    payload: CustomerSegmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    seg = (
        await db.execute(select(CustomerSegment).where(CustomerSegment.id == segment_id))
    ).scalar_one_or_none()
    if not seg:
        raise HTTPException(404, "세그먼트를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    # developer_ids 가 들어오면 shadow contact materialize 후 contact_ids 와 머지.
    if "developer_ids" in data:
        dev_ids = list(data.get("developer_ids") or [])
        extra = await _materialize_employee_contacts(
            db, tenant_id=user.tenant_id, developer_ids=dev_ids,
        )
        # contact_ids 가 같은 payload 에 같이 왔으면 그것을 base 로, 아니면 기존 seg 값을 base 로.
        base_contacts = (
            list(data["contact_ids"])
            if "contact_ids" in data
            else list(seg.contact_ids or [])
        )
        data["contact_ids"] = _merge_unique(base_contacts, extra)
    for k, v in data.items():
        setattr(seg, k, v)
    await db.commit()
    await db.refresh(seg)
    logger.info("세그먼트 수정: id=%s 변경=%s (수정자=%s)", seg.id, list(data.keys()), user.id)
    recipients = await resolve_recipients(db, seg)
    return _to_out(seg, recipient_count=len(recipients))


@router.delete("/{segment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_segment(
    segment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    seg = (
        await db.execute(select(CustomerSegment).where(CustomerSegment.id == segment_id))
    ).scalar_one_or_none()
    if not seg:
        raise HTTPException(404, "세그먼트를 찾을 수 없습니다.")
    logger.warning("세그먼트 삭제: id=%s name=%s (삭제자=%s)", seg.id, seg.name, user.id)
    await db.delete(seg)
    await db.commit()


@router.get("/{segment_id}/recipients", response_model=list[SegmentRecipient])
async def preview_recipients(
    segment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """발송 전 수신자 미리보기. 캠페인 화면에서 발송 전 확인용."""
    seg = (
        await db.execute(select(CustomerSegment).where(CustomerSegment.id == segment_id))
    ).scalar_one_or_none()
    if not seg:
        raise HTTPException(404, "세그먼트를 찾을 수 없습니다.")
    pairs = await resolve_recipients(db, seg)
    out: list[SegmentRecipient] = []
    for contact, customer in pairs:
        out.append(
            SegmentRecipient(
                customer_id=contact.customer_id,
                customer_name=customer.name if customer else None,
                customer_contact_id=contact.id,
                contact_name=contact.name,
                email=contact.email or "",
                kind=contact.kind,  # type: ignore[arg-type]
            )
        )
    return out
