import logging
from decimal import Decimal
from pathlib import Path
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.models import (
    Customer,
    CustomerContact,
    CustomerInteraction,
    Invoice,
    License,
    LicenseContact,
    Opportunity,
    Project,
    User,
)
from app.models.procurement import ProjectProcurement
from pydantic import BaseModel
from app.schemas.customer import (
    CustomerCreate,
    CustomerDeletionBlocking,
    CustomerDeletionPreview,
    CustomerOut,
    CustomerOverview,
    CustomerUpdate,
    LicenseContactCreate,
    LicenseContactOut,
    OverviewInteraction,
    OverviewInvoice,
    OverviewLicense,
    OverviewOpportunity,
    OverviewProject,
    OverviewStats,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload_as

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/customers", tags=["customers"])


def _attach_owner(customers: Iterable[Customer]) -> None:
    """Pydantic CustomerOut 의 owner_name / owner_status 를 transient 속성으로 채움.

    relationship `Customer.owner` 는 selectinload 로 미리 로드돼 있어야 한다.
    `from_attributes=True` 가 이 transient 속성을 그대로 읽어준다.
    """
    for c in customers:
        owner = c.owner
        c.owner_name = owner.name if owner else None  # type: ignore[attr-defined]
        c.owner_status = owner.status if owner else None  # type: ignore[attr-defined]


async def _compute_has_related(
    db: AsyncSession, customer_ids: list[UUID]
) -> set[UUID]:
    """단일 UNION 쿼리로 "어느 도메인에든 row 가 있는" 회사 ID 셋 반환.

    영업기회 / 프로젝트(고객 or 발주사) / 청구 / 라이센스 / 인터랙션 중 하나라도
    이 회사를 참조하면 포함. 각 테이블의 customer_id 는 이미 FK 인덱스가 잡혀
    있어 인덱스 스캔으로 처리되므로 회사 수와 무관하게 일정한 비용.
    """
    if not customer_ids:
        return set()
    # raw SQL — UNION ALL + DISTINCT. SQLAlchemy union_all 도 가능하지만 가독성↑.
    from sqlalchemy import text

    sql = text(
        """
        SELECT DISTINCT cid FROM (
            SELECT customer_id AS cid FROM opportunities WHERE customer_id IS NOT NULL
            UNION ALL
            SELECT customer_id FROM projects               WHERE customer_id IS NOT NULL
            UNION ALL
            SELECT orderer_id  FROM projects               WHERE orderer_id  IS NOT NULL
            UNION ALL
            SELECT customer_id FROM invoices               WHERE customer_id IS NOT NULL
            UNION ALL
            SELECT customer_id FROM licenses               WHERE customer_id IS NOT NULL
            UNION ALL
            SELECT customer_id FROM customer_interactions  WHERE customer_id IS NOT NULL
        ) u
        WHERE cid = ANY(:ids)
        """
    )
    rows = (await db.execute(sql, {"ids": customer_ids})).all()
    return {row[0] for row in rows}


class _ProjectPickerOut(BaseModel):
    id: UUID
    name: str
    customer_id: UUID | None = None

    class Config:
        from_attributes = True


@router.get("/projects-picker", response_model=list[_ProjectPickerOut])
async def list_projects_picker(
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """프로젝트 picker — customer-status / support-cases / support-logs / 회의록
    다이얼로그의 cascading 콤보 용. /projects 의 mutation 권한
    (`_menu("projects")` = SALES/HR) 과 분리되어 customers 메뉴 권한자
    (SALES/SUPPORT) 모두 호출 가능. customer_id 가 주어지면 그 고객사 소속만,
    아니면 전체. 이름·고객 매핑만 노출 (예산·QUOTE 등 민감 정보 X).

    FastAPI 라우팅 — 이 path 는 `/{customer_id}` 보다 위에 정의해야 path
    매칭이 정상.
    """
    stmt = select(Project).order_by(Project.name.asc())
    if customer_id:
        stmt = stmt.where(Project.customer_id == customer_id)
    rows = list((await db.execute(stmt)).scalars())
    return rows


# 기존 customer-status frontend 가 호출 중인 경로 — 신 endpoint 위에 alias 로 유지.
# customer_id path param 형. 신규 코드는 위 query param 형을 사용한다.
@router.get(
    "/{customer_id}/projects-picker",
    response_model=list[_ProjectPickerOut],
)
async def list_customer_projects_picker(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await list_projects_picker(customer_id=customer_id, db=db, user=user)


@router.get("", response_model=list[CustomerOut])
async def list_customers(
    q: str | None = None,
    owner_id: UUID | None = None,
    # `mine=true` — 토큰의 mapped_developer_id 와 owner_id 매칭. 매핑이 없으면
    # 빈 결과를 반환 (UI 에서 토글 disable 로 막지만 방어적으로 허용).
    mine: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(Customer)
        .options(selectinload(Customer.contacts), selectinload(Customer.owner))
        .order_by(Customer.name)
    )
    if q:
        stmt = stmt.where(Customer.name.ilike(f"%{q}%"))
    if mine:
        if not user.mapped_developer_id:
            return []
        stmt = stmt.where(Customer.owner_id == user.mapped_developer_id)
    elif owner_id is not None:
        stmt = stmt.where(Customer.owner_id == owner_id)
    result = await db.execute(stmt)
    customers = list(result.scalars().all())
    _attach_owner(customers)
    related = await _compute_has_related(db, [c.id for c in customers])
    for c in customers:
        c.has_related = c.id in related  # type: ignore[attr-defined]
    return customers


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_customer(
    payload: CustomerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("customers.manage")),
):
    data = payload.model_dump()
    initial_contact = data.pop("initial_contact", None)

    # 중복 검증 — 사업자등록번호가 있으면 그것 우선, 없으면 이름으로.
    # business_no 는 컬럼 UNIQUE 가 아니라 사전 체크가 필요하고, name 은 DB
    # UNIQUE 라도 친화적 메시지 위해 같이 사전 체크.
    bno = (data.get("business_no") or "").strip()
    name = (data.get("name") or "").strip()
    existing: Customer | None = None
    if bno:
        # 입력값과 DB 값에서 모두 공백·하이픈 제거 후 비교 (123-45-67890 ↔ 1234567890).
        norm = bno.replace("-", "").replace(" ", "")
        candidates = list(
            (
                await db.execute(
                    select(Customer).where(Customer.business_no.is_not(None))
                )
            ).scalars()
        )
        for c in candidates:
            if (c.business_no or "").replace("-", "").replace(" ", "") == norm:
                existing = c
                break
    elif name:
        existing = (
            await db.execute(select(Customer).where(Customer.name == name))
        ).scalar_one_or_none()
    if existing is not None:
        key = "사업자등록번호" if bno else "고객사명"
        raise HTTPException(
            status_code=400,
            detail=(
                f"이미 등록된 {key}입니다 (기존: {existing.name}, id={existing.id})."
            ),
        )

    customer = Customer(**data)
    db.add(customer)
    try:
        await db.flush()
    except IntegrityError as exc:
        # race / 사전 체크 우회 시 — DB UNIQUE 가 마지막 방어선.
        await db.rollback()
        logger.warning("고객사 등록 IntegrityError: %s", exc)
        raise HTTPException(
            status_code=400, detail="이미 등록된 고객사입니다.",
        )
    if initial_contact and initial_contact.get("name"):
        db.add(LicenseContact(customer_id=customer.id, **initial_contact))
    await db.commit()
    await db.refresh(customer, attribute_names=["contacts", "owner"])
    _attach_owner([customer])
    logger.info(
        "고객사 등록: id=%s name=%s business_no=%s (등록자=%s)",
        customer.id,
        customer.name,
        customer.business_no,
        user.id,
    )
    return customer


@router.get("/{customer_id}", response_model=CustomerOut)
async def get_customer(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Customer)
        .options(selectinload(Customer.contacts), selectinload(Customer.owner))
        .where(Customer.id == customer_id)
    )
    customer = result.scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    _attach_owner([customer])
    return customer


@router.get("/{customer_id}/overview", response_model=CustomerOverview)
async def customer_overview(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """회사 360° aggregator. SALES + ADMIN 만 접근 가능.

    영업기회·프로젝트·청구·라이센스·인터랙션을 한 번의 round-trip 에 묶어
    반환한다. 각 섹션은 최근 N(=5) 건만 포함하고, 합계는 stats 에 정리.
    """
    if user.role not in {"ADMIN", "SALES"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="회사 360° 는 SALES/ADMIN 전용입니다.",
        )

    # 회사 본체.
    customer = (
        await db.execute(
            select(Customer)
            .options(selectinload(Customer.contacts), selectinload(Customer.owner))
            .where(Customer.id == customer_id)
        )
    ).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    _attach_owner([customer])

    # 영업기회.
    opps = list(
        (
            await db.execute(
                select(Opportunity)
                .where(Opportunity.customer_id == customer_id)
                .order_by(
                    Opportunity.expected_close_date.desc().nullslast(),
                    Opportunity.created_at.desc(),
                )
            )
        ).scalars()
    )
    open_opp_count = sum(1 for o in opps if o.status == "OPEN")
    won_opp_count = sum(1 for o in opps if o.status == "WON")
    recent_opps = [
        OverviewOpportunity(
            id=o.id,
            name=o.name,
            stage=o.stage,
            status=o.status,
            expected_amount=o.expected_amount,
            currency=o.currency,
            expected_close_date=o.expected_close_date,
        )
        for o in opps[:5]
    ]

    # 프로젝트 — 고객사 또는 발주사 어느 쪽이든.
    projects = list(
        (
            await db.execute(
                select(Project)
                .where(
                    or_(
                        Project.customer_id == customer_id,
                        Project.orderer_id == customer_id,
                    )
                )
                .order_by(Project.start_date.desc())
            )
        ).scalars()
    )
    today = func.current_date()  # noqa: F841 — Python 측에서 비교
    from datetime import date as _date

    today_d = _date.today()
    active_proj_count = sum(
        1 for p in projects if p.start_date <= today_d <= p.end_date
    )
    completed_proj_count = sum(1 for p in projects if p.end_date < today_d)
    recent_projects = [
        OverviewProject(
            id=p.id,
            name=p.name,
            start_date=p.start_date,
            end_date=p.end_date,
            total_contract_amount=p.total_contract_amount,
            contract_currency=p.contract_currency,
            is_orderer=(p.customer_id != customer_id and p.orderer_id == customer_id),
        )
        for p in projects[:5]
    ]

    # 청구서 — 발행 분만 카운트 (DRAFT 도 포함하되 미수 합산은 그대로).
    invoices = list(
        (
            await db.execute(
                select(Invoice)
                .where(Invoice.customer_id == customer_id)
                .order_by(Invoice.issue_date.desc())
            )
        ).scalars()
    )
    total_krw = Decimal(0)
    total_usd = Decimal(0)
    unpaid_krw = Decimal(0)
    unpaid_usd = Decimal(0)
    for inv in invoices:
        amt = Decimal(inv.total_amount or 0)
        paid = Decimal(inv.paid_amount or 0)
        unpaid = max(amt - paid, Decimal(0))
        if inv.currency == "USD":
            total_usd += amt
            unpaid_usd += unpaid
        else:  # KRW 등 그 외는 KRW 통계로 집계 (현재 운영상 KRW/USD 만 사용).
            total_krw += amt
            unpaid_krw += unpaid
    recent_invoices = [
        OverviewInvoice(
            id=i.id,
            number=i.number,
            title=i.title,
            issue_date=i.issue_date,
            due_date=i.due_date,
            currency=i.currency,
            total_amount=i.total_amount,
            paid_amount=i.paid_amount,
            status=i.status,
        )
        for i in invoices[:5]
    ]

    # 라이센스.
    licenses = list(
        (
            await db.execute(
                select(License)
                .where(License.customer_id == customer_id)
                .order_by(License.end_date.desc())
            )
        ).scalars()
    )
    active_lic_count = sum(
        1
        for li in licenses
        if li.status == "ACTIVE" and li.end_date >= today_d
    )
    recent_licenses = [
        OverviewLicense(
            id=li.id,
            product_name=li.product_name,
            start_date=li.start_date,
            end_date=li.end_date,
            currency=li.currency,
            amount=li.amount,
            status=li.status,
        )
        for li in licenses[:5]
    ]

    # 인터랙션.
    interaction_count = (
        await db.execute(
            select(func.count())
            .select_from(CustomerInteraction)
            .where(CustomerInteraction.customer_id == customer_id)
        )
    ).scalar_one()
    interactions = list(
        (
            await db.execute(
                select(CustomerInteraction)
                .options(selectinload(CustomerInteraction.author))
                .where(CustomerInteraction.customer_id == customer_id)
                .order_by(CustomerInteraction.occurred_at.desc())
                .limit(5)
            )
        ).scalars()
    )
    recent_interactions = [
        OverviewInteraction(
            id=ix.id,
            type=ix.type,
            occurred_at=ix.occurred_at,
            title=ix.title,
            author_name=ix.author.name if ix.author else None,
        )
        for ix in interactions
    ]

    return CustomerOverview(
        customer=CustomerOut.model_validate(customer),
        stats=OverviewStats(
            open_opportunities=open_opp_count,
            won_opportunities=won_opp_count,
            active_projects=active_proj_count,
            completed_projects=completed_proj_count,
            active_licenses=active_lic_count,
            invoices_total_krw=total_krw,
            invoices_total_usd=total_usd,
            invoices_unpaid_krw=unpaid_krw,
            invoices_unpaid_usd=unpaid_usd,
            interaction_count=interaction_count,
        ),
        recent_opportunities=recent_opps,
        recent_projects=recent_projects,
        recent_invoices=recent_invoices,
        recent_licenses=recent_licenses,
        recent_interactions=recent_interactions,
    )


@router.get(
    "/{customer_id}/deletion-preview",
    response_model=CustomerDeletionPreview,
)
async def customer_deletion_preview(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """회사 삭제 시 영향 범위.

    - blocking: invoices / licenses / project_procurements 는 FK RESTRICT 라
      한 건이라도 있으면 DELETE 자체가 IntegrityError. UI 에서 사전 차단.
    - 그 외(`contact_count` 등) 는 SET NULL/CASCADE 로 자동 처리되며 confirm
      메시지에 표시.
    """
    exists = (
        await db.execute(select(Customer.id).where(Customer.id == customer_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="Customer not found")

    async def _count(stmt) -> int:
        return int(
            (await db.execute(select(func.count()).select_from(stmt))).scalar_one()
        )

    invoice_count = await _count(
        select(Invoice).where(Invoice.customer_id == customer_id)
    )
    license_count = await _count(
        select(License).where(License.customer_id == customer_id)
    )
    procurement_count = await _count(
        select(ProjectProcurement).where(
            ProjectProcurement.supplier_id == customer_id
        )
    )
    contact_count = await _count(
        select(CustomerContact).where(CustomerContact.customer_id == customer_id)
    )
    interaction_count = await _count(
        select(CustomerInteraction).where(
            CustomerInteraction.customer_id == customer_id
        )
    )
    opportunity_count = await _count(
        select(Opportunity).where(Opportunity.customer_id == customer_id)
    )
    project_count = await _count(
        select(Project).where(
            or_(
                Project.customer_id == customer_id,
                Project.orderer_id == customer_id,
            )
        )
    )
    license_contact_count = await _count(
        select(LicenseContact).where(LicenseContact.customer_id == customer_id)
    )

    return CustomerDeletionPreview(
        blocking=CustomerDeletionBlocking(
            invoice_count=invoice_count,
            license_count=license_count,
            procurement_count=procurement_count,
        ),
        contact_count=contact_count,
        interaction_count=interaction_count,
        opportunity_count=opportunity_count,
        project_count=project_count,
        license_contact_count=license_contact_count,
    )


@router.patch("/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: UUID,
    payload: CustomerUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Customer)
        .options(selectinload(Customer.contacts), selectinload(Customer.owner))
        .where(Customer.id == customer_id)
    )
    customer = result.scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(customer, key, value)
    await db.commit()
    await db.refresh(customer, attribute_names=["contacts", "owner"])
    _attach_owner([customer])
    logger.info(
        "고객사 수정: id=%s name=%s 변경필드=%s (수정자=%s)",
        customer.id,
        customer.name,
        list(data.keys()),
        user.id,
    )
    return customer


@router.delete("/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_customer(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("customers.manage")),
):
    result = await db.execute(select(Customer).where(Customer.id == customer_id))
    customer = result.scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    logger.warning(
        "고객사 삭제: id=%s name=%s (삭제자=%s)",
        customer.id,
        customer.name,
        user.id,
    )
    await db.delete(customer)
    await db.commit()


@router.post(
    "/{customer_id}/contacts",
    response_model=LicenseContactOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_contact(
    customer_id: UUID,
    payload: LicenseContactCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    contact = LicenseContact(customer_id=customer_id, **payload.model_dump())
    db.add(contact)
    await db.commit()
    await db.refresh(contact)
    return contact


@router.patch("/contacts/{contact_id}", response_model=LicenseContactOut)
async def update_contact(
    contact_id: UUID,
    payload: LicenseContactCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(LicenseContact).where(LicenseContact.id == contact_id))
    contact = result.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(contact, k, v)
    await db.commit()
    await db.refresh(contact)
    return contact


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_contact(
    contact_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(LicenseContact).where(LicenseContact.id == contact_id))
    contact = result.scalar_one_or_none()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")
    await db.delete(contact)
    await db.commit()


# ---------------------------------------------------------------------------
# Attachments: 사업자등록증 / 통장 사본
#
# Files are saved under data/customers/<customer_id>/ with a fixed base name
# that reflects their semantic role and the original extension preserved:
#   사업자등록증.<ext>
#   통장사본.<ext>
# ---------------------------------------------------------------------------


_ATTACHMENTS: dict[str, tuple[str, str]] = {
    # url_slug → (base_filename, db_column_prefix)
    "business-license": ("사업자등록증", "business_license"),
    "bank-account": ("통장사본", "bank_account"),
}


def _set_attachment(customer: Customer, prefix: str, *, name, path, mime, size) -> None:
    setattr(customer, f"{prefix}_name", name)
    setattr(customer, f"{prefix}_path", path)
    setattr(customer, f"{prefix}_mime", mime)
    setattr(customer, f"{prefix}_size", size)


async def _load_customer(db: AsyncSession, customer_id: UUID, *, with_contacts: bool = False) -> Customer:
    stmt = select(Customer).where(Customer.id == customer_id)
    if with_contacts:
        stmt = stmt.options(
            selectinload(Customer.contacts), selectinload(Customer.owner)
        )
    result = await db.execute(stmt)
    customer = result.scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer


@router.post("/{customer_id}/business-license", response_model=CustomerOut)
async def upload_business_license(
    customer_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    out = await _upload_attachment(db, customer_id, "business-license", file)
    logger.info(
        "고객 사업자등록증 업로드: customer=%s file=%s 사용자=%s",
        customer_id, file.filename, user.id,
    )
    return out


@router.get("/{customer_id}/business-license")
async def download_business_license(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return await _download_attachment(db, customer_id, "business-license")


@router.delete(
    "/{customer_id}/business-license", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_business_license(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _delete_attachment(db, customer_id, "business-license")
    logger.info("고객 사업자등록증 삭제: customer=%s 사용자=%s", customer_id, user.id)


@router.post("/{customer_id}/bank-account", response_model=CustomerOut)
async def upload_bank_account(
    customer_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    out = await _upload_attachment(db, customer_id, "bank-account", file)
    logger.info(
        "고객 통장사본 업로드: customer=%s file=%s 사용자=%s",
        customer_id, file.filename, user.id,
    )
    return out


@router.get("/{customer_id}/bank-account")
async def download_bank_account(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return await _download_attachment(db, customer_id, "bank-account")


@router.delete(
    "/{customer_id}/bank-account", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_bank_account(
    customer_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _delete_attachment(db, customer_id, "bank-account")
    logger.info("고객 통장사본 삭제: customer=%s 사용자=%s", customer_id, user.id)


async def _upload_attachment(
    db: AsyncSession, customer_id: UUID, slug: str, file: UploadFile
) -> Customer:
    base_name, prefix = _ATTACHMENTS[slug]
    customer = await _load_customer(db, customer_id, with_contacts=True)
    # 이전 파일이 있으면 디스크에서 먼저 제거
    prev_path = getattr(customer, f"{prefix}_path", None)
    if prev_path:
        delete_file(prev_path)
    stored, size = await save_upload_as(file, f"customers/{customer_id}", base_name)
    _set_attachment(
        customer,
        prefix,
        name=file.filename or Path(stored).name,
        path=stored,
        mime=file.content_type,
        size=size,
    )
    await db.commit()
    await db.refresh(customer, attribute_names=["contacts", "owner"])
    _attach_owner([customer])
    return customer


async def _download_attachment(db: AsyncSession, customer_id: UUID, slug: str):
    _, prefix = _ATTACHMENTS[slug]
    customer = await _load_customer(db, customer_id)
    path = getattr(customer, f"{prefix}_path")
    if not path:
        raise HTTPException(status_code=404, detail="File not found")
    abs_path = resolve_upload_path(path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        filename=getattr(customer, f"{prefix}_name") or "file",
        media_type=getattr(customer, f"{prefix}_mime") or "application/octet-stream",
    )


async def _delete_attachment(db: AsyncSession, customer_id: UUID, slug: str) -> None:
    _, prefix = _ATTACHMENTS[slug]
    customer = await _load_customer(db, customer_id)
    path = getattr(customer, f"{prefix}_path")
    if path:
        delete_file(path)
    _set_attachment(customer, prefix, name=None, path=None, mime=None, size=None)
    await db.commit()
