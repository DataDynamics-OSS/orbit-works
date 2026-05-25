import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import and_, extract, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Customer,
    Developer,
    ExchangeRate,
    Opportunity,
    OpportunityActivity,
    OpportunityAttachment,
    OpportunityStageHistory,
    User,
)
from app.schemas.opportunity import (
    OpportunityActivityCreate,
    OpportunityActivityOut,
    OpportunityActivityUpdate,
    OpportunityAttachmentOut,
    OpportunityAttachmentUpdate,
    OpportunityConvert,
    OpportunityCreate,
    OpportunityDetail,
    OpportunityOut,
    OpportunityStageHistoryOut,
    OpportunitySummary,
    OpportunityUpdate,
    StageBucket,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/opportunities", tags=["opportunities"])


STAGE_DEFAULT_PROBABILITY: dict[str, int] = {
    "LEAD": 10,
    "QUALIFIED": 25,
    "PROPOSAL": 50,
    "NEGOTIATION": 75,
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _latest_fx_rate(db: AsyncSession) -> Decimal | None:
    row = (
        await db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.base == "USD", ExchangeRate.target == "KRW")
            .order_by(ExchangeRate.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return row.rate if row else None


def _weighted(o: Opportunity) -> Decimal:
    amt = Decimal(o.expected_amount or 0)
    prob = Decimal(o.probability or 0) / Decimal(100)
    return (amt * prob).quantize(Decimal("0.01"))


def _normalize_to_krw(amount: Decimal, currency: str, fx: Decimal | None) -> Decimal:
    if currency == "KRW":
        return amount
    if currency == "USD" and fx and fx > 0:
        return (amount * fx).quantize(Decimal("0.01"))
    return amount  # best-effort when fx missing


async def _resolve_names(
    db: AsyncSession, ops: list[Opportunity]
) -> tuple[dict[UUID, str], dict[UUID, str], dict[UUID, str]]:
    cust_ids = {o.customer_id for o in ops if o.customer_id}
    owner_ids = {o.owner_id for o in ops if o.owner_id}
    rep_ids = {o.sales_rep_id for o in ops if o.sales_rep_id}
    customers: dict[UUID, str] = {}
    owners: dict[UUID, str] = {}
    reps: dict[UUID, str] = {}
    if cust_ids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cust_ids)))
        ).scalars():
            customers[c.id] = c.name
    if owner_ids:
        for u in (
            await db.execute(select(User).where(User.id.in_(owner_ids)))
        ).scalars():
            owners[u.id] = u.name or u.email
    if rep_ids:
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(rep_ids)))
        ).scalars():
            reps[d.id] = d.name
    return customers, owners, reps


def _to_out(
    o: Opportunity,
    customers: dict[UUID, str],
    owners: dict[UUID, str],
    reps: dict[UUID, str],
) -> OpportunityOut:
    return OpportunityOut(
        id=o.id,
        name=o.name,
        customer_id=o.customer_id,
        owner_id=o.owner_id,
        sales_rep_id=o.sales_rep_id,
        stage=o.stage,  # type: ignore[arg-type]
        status=o.status,  # type: ignore[arg-type]
        probability=o.probability,
        expected_amount=o.expected_amount,
        currency=o.currency,  # type: ignore[arg-type]
        expected_close_date=o.expected_close_date,
        registered_at=o.registered_at,
        closed_at=o.closed_at,
        source=o.source,
        business_type=o.business_type,  # type: ignore[arg-type]
        description=o.description,
        memo=o.memo,
        contact_name=o.contact_name,
        contact_department=o.contact_department,
        contact_phone=o.contact_phone,
        contact_email=o.contact_email,
        converted_license_id=o.converted_license_id,
        converted_project_id=o.converted_project_id,
        customer_name=customers.get(o.customer_id) if o.customer_id else None,
        owner_name=owners.get(o.owner_id) if o.owner_id else None,
        sales_rep_name=reps.get(o.sales_rep_id) if o.sales_rep_id else None,
        weighted_amount=_weighted(o),
        created_at=o.created_at,
    )


async def _log_stage_change(
    db: AsyncSession,
    opp: Opportunity,
    from_stage: str,
    to_stage: str,
    from_status: str,
    to_status: str,
    changed_by: UUID | None,
    note: str | None,
):
    db.add(
        OpportunityStageHistory(
            opportunity_id=opp.id,
            from_stage=from_stage,
            to_stage=to_stage,
            from_status=from_status,
            to_status=to_status,
            changed_at=datetime.now(timezone.utc),
            changed_by=changed_by,
            note=note,
        )
    )


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[OpportunityOut])
async def list_opportunities(
    year: int | None = None,
    stage: str | None = None,
    status_: str | None = None,
    q: str | None = None,
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Opportunity).order_by(
        Opportunity.expected_close_date.asc().nullslast(), Opportunity.created_at
    )
    if year is not None:
        stmt = stmt.where(extract("year", Opportunity.expected_close_date) == year)
    if stage:
        stmt = stmt.where(Opportunity.stage == stage)
    if status_:
        stmt = stmt.where(Opportunity.status == status_)
    if q:
        stmt = stmt.where(Opportunity.name.ilike(f"%{q}%"))
    if customer_id is not None:
        stmt = stmt.where(Opportunity.customer_id == customer_id)

    rows = list((await db.execute(stmt)).scalars())
    customers, owners, reps = await _resolve_names(db, rows)
    return [_to_out(o, customers, owners, reps) for o in rows]


@router.get("/summary", response_model=OpportunitySummary)
async def opportunity_summary(
    year: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Opportunity).where(
        extract("year", Opportunity.expected_close_date) == year
    )
    rows = list((await db.execute(stmt)).scalars())
    fx = await _latest_fx_rate(db)

    zero = Decimal("0")
    total_amount = zero
    weighted_amount = zero
    won_amount = zero
    won_amount_krw = zero
    won_amount_usd = zero
    lost_amount = zero
    per_stage: dict[str, dict[str, Decimal | int]] = {}

    for o in rows:
        native = Decimal(o.expected_amount or 0)
        amt_krw = _normalize_to_krw(native, o.currency, fx)
        weighted_amount += (
            amt_krw * Decimal(o.probability or 0) / Decimal(100)
        ).quantize(Decimal("0.01"))
        if o.status == "WON":
            won_amount += amt_krw
            if o.currency == "USD":
                won_amount_usd += native
            else:
                won_amount_krw += native
            total_amount += amt_krw
        elif o.status == "LOST":
            lost_amount += amt_krw
        elif o.status == "ABANDONED":
            pass
        else:  # OPEN
            total_amount += amt_krw
            bucket = per_stage.setdefault(
                o.stage, {"count": 0, "amount": zero, "weighted": zero}
            )
            bucket["count"] = int(bucket["count"]) + 1  # type: ignore[operator]
            bucket["amount"] = Decimal(bucket["amount"]) + amt_krw  # type: ignore[operator]
            bucket["weighted"] = Decimal(bucket["weighted"]) + (
                amt_krw * Decimal(o.probability or 0) / Decimal(100)
            )

    won_lost = won_amount + lost_amount
    win_rate = float(won_amount / won_lost) if won_lost > 0 else 0.0

    ordered_stages = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION"]
    by_stage = [
        StageBucket(
            stage=s,
            count=int(per_stage.get(s, {}).get("count", 0) or 0),
            amount=Decimal(per_stage.get(s, {}).get("amount", 0) or 0).quantize(
                Decimal("0.01")
            ),
            weighted=Decimal(per_stage.get(s, {}).get("weighted", 0) or 0).quantize(
                Decimal("0.01")
            ),
        )
        for s in ordered_stages
    ]

    return OpportunitySummary(
        year=year,
        total_count=len(rows),
        total_amount=total_amount.quantize(Decimal("0.01")),
        weighted_amount=weighted_amount.quantize(Decimal("0.01")),
        won_amount=won_amount.quantize(Decimal("0.01")),
        won_amount_krw=won_amount_krw.quantize(Decimal("0.01")),
        won_amount_usd=won_amount_usd.quantize(Decimal("0.01")),
        lost_amount=lost_amount.quantize(Decimal("0.01")),
        win_rate=round(win_rate, 4),
        by_stage=by_stage,
    )


@router.post("", response_model=OpportunityOut, status_code=status.HTTP_201_CREATED)
async def create_opportunity(
    payload: OpportunityCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    # Align probability to stage if the caller left it at default.
    if "probability" not in payload.model_fields_set:
        data["probability"] = STAGE_DEFAULT_PROBABILITY.get(data["stage"], 10)
    if data.get("status") == "OPEN":
        data["closed_at"] = None
    # 등록일 미지정 시 오늘로.
    if not data.get("registered_at"):
        data["registered_at"] = date.today()
    opp = Opportunity(**data)
    db.add(opp)
    await db.flush()
    # Initial history entry for audit.
    await _log_stage_change(
        db,
        opp,
        from_stage="",
        to_stage=opp.stage,
        from_status="",
        to_status=opp.status,
        changed_by=user.id,
        note="생성",
    )
    await db.commit()
    await db.refresh(opp)
    logger.info(
        "영업기회 등록: id=%s name=%s stage=%s amount=%s %s (등록자=%s)",
        opp.id,
        opp.name,
        opp.stage,
        opp.expected_amount,
        opp.currency,
        user.id,
    )

    customers, owners, reps = await _resolve_names(db, [opp])
    return _to_out(opp, customers, owners, reps)


@router.get("/{opportunity_id}", response_model=OpportunityDetail)
async def get_opportunity(
    opportunity_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    opp = (
        await db.execute(
            select(Opportunity)
            .options(
                selectinload(Opportunity.activities),
                selectinload(Opportunity.stage_history),
            )
            .where(Opportunity.id == opportunity_id)
        )
    ).scalar_one_or_none()
    if not opp:
        raise HTTPException(status_code=404, detail="Opportunity not found")

    customers, owners, reps = await _resolve_names(db, [opp])
    base = _to_out(opp, customers, owners, reps)
    return OpportunityDetail(
        **base.model_dump(),
        activities=[
            OpportunityActivityOut.model_validate(a, from_attributes=True)
            for a in sorted(opp.activities, key=lambda a: a.happened_at, reverse=True)
        ],
        stage_history=[
            OpportunityStageHistoryOut.model_validate(h, from_attributes=True)
            for h in sorted(opp.stage_history, key=lambda h: h.changed_at)
        ],
    )


@router.patch("/{opportunity_id}", response_model=OpportunityOut)
async def update_opportunity(
    opportunity_id: UUID,
    payload: OpportunityUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    opp = (
        await db.execute(
            select(Opportunity).where(Opportunity.id == opportunity_id)
        )
    ).scalar_one_or_none()
    if not opp:
        raise HTTPException(status_code=404, detail="Opportunity not found")

    data = payload.model_dump(exclude_unset=True)
    note = data.pop("stage_change_note", None)

    prev_stage = opp.stage
    prev_status = opp.status

    # Apply patch.
    for k, v in data.items():
        setattr(opp, k, v)

    # If stage changed and caller didn't explicitly set probability, align.
    if "stage" in data and "probability" not in data:
        opp.probability = STAGE_DEFAULT_PROBABILITY.get(opp.stage, opp.probability)

    # Status transitions.
    if "status" in data:
        if opp.status in ("WON", "LOST", "ABANDONED") and opp.closed_at is None:
            opp.closed_at = datetime.now(timezone.utc)
        if opp.status == "OPEN":
            opp.closed_at = None
        # Align probability for WON/LOST
        if opp.status == "WON":
            opp.probability = 100
        elif opp.status == "LOST":
            opp.probability = 0

    if opp.stage != prev_stage or opp.status != prev_status:
        await _log_stage_change(
            db,
            opp,
            from_stage=prev_stage,
            to_stage=opp.stage,
            from_status=prev_status,
            to_status=opp.status,
            changed_by=user.id,
            note=note,
        )
        logger.info(
            "영업기회 단계/상태 변경: id=%s %s/%s → %s/%s note=%r (변경자=%s)",
            opp.id,
            prev_stage,
            prev_status,
            opp.stage,
            opp.status,
            note,
            user.id,
        )

    await db.commit()
    await db.refresh(opp)
    logger.info(
        "영업기회 수정: id=%s 변경필드=%s (수정자=%s)",
        opp.id,
        list(data.keys()),
        user.id,
    )
    customers, owners, reps = await _resolve_names(db, [opp])
    return _to_out(opp, customers, owners, reps)


@router.delete("/{opportunity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_opportunity(
    opportunity_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    opp = (
        await db.execute(
            select(Opportunity).where(Opportunity.id == opportunity_id)
        )
    ).scalar_one_or_none()
    if not opp:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    logger.warning(
        "영업기회 삭제: id=%s name=%s (삭제자=%s)", opp.id, opp.name, user.id
    )
    await db.delete(opp)
    await db.commit()


# ---------------------------------------------------------------------------
# activities
# ---------------------------------------------------------------------------


@router.get(
    "/{opportunity_id}/activities", response_model=list[OpportunityActivityOut]
)
async def list_activities(
    opportunity_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(OpportunityActivity)
            .where(OpportunityActivity.opportunity_id == opportunity_id)
            .order_by(OpportunityActivity.happened_at.desc())
        )
    ).scalars()
    return list(rows)


@router.post(
    "/{opportunity_id}/activities",
    response_model=OpportunityActivityOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_activity(
    opportunity_id: UUID,
    payload: OpportunityActivityCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    exists = (
        await db.execute(select(Opportunity).where(Opportunity.id == opportunity_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    act = OpportunityActivity(
        opportunity_id=opportunity_id,
        activity_type=payload.activity_type,
        happened_at=payload.happened_at or datetime.now(timezone.utc),
        summary=payload.summary,
        owner_id=user.id,
    )
    db.add(act)
    await db.commit()
    await db.refresh(act)
    logger.info(
        "영업기회 활동 등록: opp_id=%s type=%s summary=%r (등록자=%s)",
        opportunity_id,
        act.activity_type,
        act.summary[:50],
        user.id,
    )
    return act


@router.patch(
    "/activities/{activity_id}", response_model=OpportunityActivityOut
)
async def update_activity(
    activity_id: UUID,
    payload: OpportunityActivityUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    act = (
        await db.execute(
            select(OpportunityActivity).where(OpportunityActivity.id == activity_id)
        )
    ).scalar_one_or_none()
    if not act:
        raise HTTPException(status_code=404, detail="Activity not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(act, k, v)
    await db.commit()
    await db.refresh(act)
    logger.info("영업기회 활동 수정: id=%s (수정자=%s)", act.id, user.id)
    return act


@router.delete(
    "/activities/{activity_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_activity(
    activity_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    act = (
        await db.execute(
            select(OpportunityActivity).where(OpportunityActivity.id == activity_id)
        )
    ).scalar_one_or_none()
    if not act:
        raise HTTPException(status_code=404, detail="Activity not found")
    logger.info(
        "영업기회 활동 삭제: id=%s opp_id=%s (삭제자=%s)",
        act.id,
        act.opportunity_id,
        user.id,
    )
    await db.delete(act)
    await db.commit()


# ---------------------------------------------------------------------------
# attachments
# ---------------------------------------------------------------------------


@router.get(
    "/{opportunity_id}/attachments",
    response_model=list[OpportunityAttachmentOut],
)
async def list_attachments(
    opportunity_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(OpportunityAttachment)
            .where(OpportunityAttachment.opportunity_id == opportunity_id)
            .order_by(OpportunityAttachment.created_at.desc())
        )
    ).scalars()
    return list(rows)


@router.post(
    "/{opportunity_id}/attachments",
    response_model=OpportunityAttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    opportunity_id: UUID,
    file: UploadFile = File(...),
    description: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    exists = (
        await db.execute(
            select(Opportunity).where(Opportunity.id == opportunity_id)
        )
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    stored, size = await save_upload(file, f"opportunities/{opportunity_id}")
    att = OpportunityAttachment(
        opportunity_id=opportunity_id,
        file_name=file.filename or "upload.bin",
        file_path=stored,
        mime_type=file.content_type,
        size=size,
        description=description,
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    logger.info(
        "영업기회 첨부 업로드: opp_id=%s file=%s size=%s (업로드자=%s)",
        opportunity_id,
        att.file_name,
        size,
        user.id,
    )
    return att


@router.patch(
    "/attachments/{attachment_id}", response_model=OpportunityAttachmentOut
)
async def update_attachment(
    attachment_id: UUID,
    payload: OpportunityAttachmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """첨부 파일의 표시 파일명/설명을 수정. 디스크의 실제 파일은 그대로."""
    att = (
        await db.execute(
            select(OpportunityAttachment).where(
                OpportunityAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(att, k, v)
    await db.commit()
    await db.refresh(att)
    logger.info(
        "영업기회 첨부 수정: id=%s 변경필드=%s (수정자=%s)",
        att.id,
        list(data.keys()),
        user.id,
    )
    return att


@router.delete(
    "/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    att = (
        await db.execute(
            select(OpportunityAttachment).where(
                OpportunityAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    logger.info(
        "영업기회 첨부 삭제: id=%s file=%s opp_id=%s (삭제자=%s)",
        att.id,
        att.file_name,
        att.opportunity_id,
        user.id,
    )
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()


@router.get("/attachments/{attachment_id}/download")
async def download_attachment(
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    att = (
        await db.execute(
            select(OpportunityAttachment).where(
                OpportunityAttachment.id == attachment_id
            )
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )


# ---------------------------------------------------------------------------
# convert (WON → link license or project)
# ---------------------------------------------------------------------------


@router.post("/{opportunity_id}/convert", response_model=OpportunityOut)
async def convert_opportunity(
    opportunity_id: UUID,
    payload: OpportunityConvert,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    opp = (
        await db.execute(
            select(Opportunity).where(Opportunity.id == opportunity_id)
        )
    ).scalar_one_or_none()
    if not opp:
        raise HTTPException(status_code=404, detail="Opportunity not found")

    prev_stage = opp.stage
    prev_status = opp.status

    if payload.target == "LICENSE":
        opp.converted_license_id = payload.license_id
    else:
        opp.converted_project_id = payload.project_id
    opp.status = "WON"
    opp.probability = 100
    if opp.closed_at is None:
        opp.closed_at = datetime.now(timezone.utc)

    await _log_stage_change(
        db,
        opp,
        from_stage=prev_stage,
        to_stage=opp.stage,
        from_status=prev_status,
        to_status=opp.status,
        changed_by=user.id,
        note=payload.note or f"{payload.target} 전환",
    )
    await db.commit()
    await db.refresh(opp)
    logger.info(
        "영업기회 전환: id=%s target=%s license_id=%s project_id=%s (전환자=%s)",
        opp.id,
        payload.target,
        payload.license_id,
        payload.project_id,
        user.id,
    )
    customers, owners, reps = await _resolve_names(db, [opp])
    return _to_out(opp, customers, owners, reps)
