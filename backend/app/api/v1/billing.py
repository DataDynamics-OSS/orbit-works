"""견적서 / 청구서 API.

- /quotes, /quotes/{id}, /quotes/{id}/items, /quotes/{id}/copy, /quotes/{id}/convert
- /invoices, /invoices/{id}, /invoices/{id}/items
- /company-profile
"""

import logging
from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.models import (
    Customer,
    Invoice,
    InvoiceItem,
    InvoiceVersion,
    Quote,
    QuoteItem,
    QuoteVersion,
    Tenant,
    User,
)
from app.schemas.billing import (
    CompanyProfileOut,
    CompanyProfileUpdate,
    InvoiceCreate,
    InvoiceItemsSave,
    InvoiceOut,
    InvoiceSave,
    InvoiceUpdate,
    LineItemIn,
    LineItemOut,
    QuoteCreate,
    QuoteItemsSave,
    QuoteOut,
    QuoteSave,
    QuoteUpdate,
    VersionOut,
)
from app.services.billing import (
    compute_line,
    compute_totals,
    next_invoice_number,
    next_quote_number,
    snapshot_customer,
    snapshot_issuer,
    suggest_tax_rate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Quotes
# ---------------------------------------------------------------------------

quotes_router = APIRouter(prefix="/quotes", tags=["billing"])


async def _customer_name(db: AsyncSession, cid: UUID | None) -> str | None:
    """고객사 표시용 이름 조회. 리스트 응답 최소화를 위해 snapshot 대신 실시간 이름.

    list_* 응답에서 snapshot 이 비어있는 구형 row 를 보완하는 용도로 사용된다.
    """
    if not cid:
        return None
    c = (await db.execute(select(Customer).where(Customer.id == cid))).scalar_one_or_none()
    return c.name if c else None


# ---------------------------------------------------------------------------
# 버전 이력 헬퍼 — 저장 시점의 snapshot 을 dict 로 뽑아 *_versions 에 기록.
# ---------------------------------------------------------------------------


def _quote_header_snapshot(q: Quote) -> dict:
    return {
        "number": q.number,
        "version": q.version,
        "title": q.title,
        "business_name": q.business_name,
        "attention": q.attention,
        "issue_date": q.issue_date.isoformat() if q.issue_date else None,
        "valid_until": q.valid_until.isoformat() if q.valid_until else None,
        "currency": q.currency,
        "tax_mode": q.tax_mode,
        "tax_rate": str(q.tax_rate) if q.tax_rate is not None else None,
        "subtotal": str(q.subtotal),
        "discount_total": str(q.discount_total),
        "tax_amount": str(q.tax_amount),
        "total_amount": str(q.total_amount),
        "customer_id": str(q.customer_id) if q.customer_id else None,
        "customer_snapshot": q.customer_snapshot,
        "issuer_snapshot": q.issuer_snapshot,
        "project_id": str(q.project_id) if q.project_id else None,
        "opportunity_id": str(q.opportunity_id) if q.opportunity_id else None,
        "memo": q.memo,
        "terms": q.terms,
    }


def _invoice_header_snapshot(inv: Invoice) -> dict:
    return {
        "number": inv.number,
        "version": inv.version,
        "title": inv.title,
        "business_name": inv.business_name,
        "attention": inv.attention,
        "po_no": inv.po_no,
        "issue_date": inv.issue_date.isoformat() if inv.issue_date else None,
        "due_date": inv.due_date.isoformat() if inv.due_date else None,
        "currency": inv.currency,
        "tax_mode": inv.tax_mode,
        "tax_rate": str(inv.tax_rate) if inv.tax_rate is not None else None,
        "subtotal": str(inv.subtotal),
        "discount_total": str(inv.discount_total),
        "tax_amount": str(inv.tax_amount),
        "total_amount": str(inv.total_amount),
        "paid_amount": str(inv.paid_amount),
        "customer_id": str(inv.customer_id) if inv.customer_id else None,
        "customer_snapshot": inv.customer_snapshot,
        "issuer_snapshot": inv.issuer_snapshot,
        "project_id": str(inv.project_id) if inv.project_id else None,
        "opportunity_id": str(inv.opportunity_id) if inv.opportunity_id else None,
        "memo": inv.memo,
        "terms": inv.terms,
    }


def _item_snapshot(i) -> dict:
    """QuoteItem/InvoiceItem 의 필드를 JSON 직렬화 가능한 dict 로."""
    return {
        "position": i.position,
        "kind": i.kind,
        "name": i.name,
        "description": i.description,
        "unit": i.unit,
        "quantity": str(i.quantity),
        "unit_price": str(i.unit_price),
        "discount_rate": str(i.discount_rate),
        "role": i.role,
        "period_start": i.period_start.isoformat() if i.period_start else None,
        "period_end": i.period_end.isoformat() if i.period_end else None,
        "months": str(i.months) if i.months is not None else None,
        "years": str(i.years) if i.years is not None else "1",
        "line_subtotal": str(i.line_subtotal),
        "line_discount": str(i.line_discount),
        "line_total": str(i.line_total),
        "manual_total": bool(i.manual_total),
    }


def _record_quote_version(db: AsyncSession, q: Quote, user_id: UUID | None) -> None:
    db.add(
        QuoteVersion(
            quote_id=q.id,
            version=q.version,
            header=_quote_header_snapshot(q),
            items=[_item_snapshot(i) for i in q.items],
            created_by=user_id,
        )
    )


def _record_invoice_version(db: AsyncSession, inv: Invoice, user_id: UUID | None) -> None:
    db.add(
        InvoiceVersion(
            invoice_id=inv.id,
            version=inv.version,
            header=_invoice_header_snapshot(inv),
            items=[_item_snapshot(i) for i in inv.items],
            created_by=user_id,
        )
    )


def _apply_line(
    item: LineItemIn, position: int, model_cls
) -> object:
    """LineItemIn → ORM row (QuoteItem/InvoiceItem) 변환.

    발행 시점의 금액을 `line_subtotal`, `line_discount`, `line_total` 에 동결해 저장한다.
    `manual_total=True` 인 경우 사용자가 직접 입력한 `line_total` 을 그대로 쓰고
    subtotal/discount 는 참고값으로만 저장. 그 외에는 `compute_line(qty, price, disc, years)`
    을 호출해 subtotal = qty × price × years, discount = subtotal × disc%, total = subtotal - discount
    로 재계산. `years` 는 최소 1 로 보정 (음수/0 방어).
    """
    # years 를 최소 1 로 보정 후 저장.
    years = Decimal(item.years or 1)
    if years < 1:
        years = Decimal(1)

    if item.manual_total:
        # 사용자가 공급가액을 직접 입력한 경우 — qty/price/discount/years 는 참고치로만
        # 저장하고, 금액은 사용자 값을 그대로 사용한다.
        total = Decimal(item.line_total or 0)
        subtotal = total
        discount = Decimal(0)
    else:
        subtotal, discount, total = compute_line(
            quantity=item.quantity,
            unit_price=item.unit_price,
            discount_rate=item.discount_rate,
            years=years,
        )
    return model_cls(
        position=position,
        kind=item.kind,
        name=item.name,
        description=item.description,
        unit=item.unit,
        quantity=item.quantity or Decimal(0),
        unit_price=item.unit_price or Decimal(0),
        discount_rate=item.discount_rate or Decimal(0),
        role=item.role,
        period_start=item.period_start,
        period_end=item.period_end,
        months=item.months,
        years=years,
        line_subtotal=subtotal,
        line_discount=discount,
        line_total=total,
        manual_total=bool(item.manual_total),
    )


async def _quote_out(db: AsyncSession, q: Quote) -> QuoteOut:
    """Quote ORM → QuoteOut. 클라이언트 표시에 필요한 파생 필드(display_number,
    customer_name) 를 채워 반환. `{number}-{version}` 형태로 표시용 번호를 만들어
    UI 상단·PDF 상단에서 그대로 사용할 수 있도록 한다."""
    out = QuoteOut.model_validate(q, from_attributes=True)
    out.items = [LineItemOut.model_validate(i, from_attributes=True) for i in q.items]
    out.customer_name = await _customer_name(db, q.customer_id)
    out.display_number = f"{q.number}-{q.version}"
    return out


@quotes_router.get("", response_model=list[QuoteOut])
async def list_quotes(
    year: int | None = None,
    q: str | None = None,
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(Quote)
        .options(selectinload(Quote.items))
        .order_by(Quote.issue_date.desc(), Quote.seq.desc())
    )
    if year is not None:
        stmt = stmt.where(Quote.year == year)
    if customer_id:
        stmt = stmt.where(Quote.customer_id == customer_id)
    if q:
        stmt = stmt.where(Quote.title.ilike(f"%{q}%"))
    rows = list((await db.execute(stmt)).scalars().unique())
    # 고객 이름을 한번에 조회해서 매핑.
    cids = {r.customer_id for r in rows if r.customer_id}
    names: dict[UUID, str] = {}
    if cids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cids)))
        ).scalars():
            names[c.id] = c.name
    out: list[QuoteOut] = []
    for r in rows:
        item = QuoteOut.model_validate(r, from_attributes=True)
        item.items = [LineItemOut.model_validate(i, from_attributes=True) for i in r.items]
        item.customer_name = names.get(r.customer_id) if r.customer_id else None
        out.append(item)
    return out


@quotes_router.post("", response_model=QuoteOut, status_code=status.HTTP_201_CREATED)
async def create_quote(
    payload: QuoteCreate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    issue_date = payload.issue_date or date.today()
    number, seq = await next_quote_number(db, issue_date.year, issue_date=issue_date)

    # tax_rate — 사용자가 넘기지 않은 경우 스마트 기본값. EXCLUSIVE 기본.
    tax_rate = payload.tax_rate
    if tax_rate is None:
        tax_rate = await suggest_tax_rate(
            db, currency=payload.currency, customer_id=payload.customer_id
        )

    # 유효기간 — 미지정이면 발행일 기준 2주 뒤.
    from datetime import timedelta as _td

    valid_until = payload.valid_until or (issue_date + _td(days=14))

    q = Quote(
        number=number,
        year=issue_date.year,
        seq=seq,
        customer_id=payload.customer_id,
        customer_snapshot=await snapshot_customer(db, payload.customer_id),
        issuer_snapshot=await snapshot_issuer(db),
        title=payload.title or "(제목 없음)",
        business_name=payload.business_name,
        attention=payload.attention,
        issue_date=issue_date,
        valid_until=valid_until,
        currency=payload.currency,
        locale=payload.locale,
        tax_mode=payload.tax_mode,
        tax_rate=tax_rate,
        project_id=payload.project_id,
        opportunity_id=payload.opportunity_id,
        memo=payload.memo,
        terms=payload.terms,
        source_quote_id=payload.source_quote_id,
        created_by=current.id,
    )
    db.add(q)
    await db.flush()
    for idx, item in enumerate(payload.items):
        it = _apply_line(item, item.position if item.position is not None else idx, QuoteItem)
        it.quote_id = q.id
        db.add(it)
    await db.flush()
    _recompute_quote_totals(q, [i for i in payload.items])
    # 생성은 v1 — 이력 row 는 생성하지 않는다. 사용자가 "신규 버전" 저장할 때만 이력 누적.
    await db.commit()
    logger.info(
        "견적서 생성: id=%s number=%s customer=%s items=%s (생성자=%s)",
        q.id,
        q.number,
        q.customer_id,
        len(payload.items),
        current.id,
    )
    return await _get_quote_loaded(db, q.id)


def _line_triple(i: LineItemIn) -> tuple[Decimal, Decimal, Decimal]:
    """LineItemIn 하나에 대한 (subtotal, discount, total) 계산. manual_total·years 반영."""
    if i.manual_total:
        total = Decimal(i.line_total or 0)
        return total, Decimal(0), total
    return compute_line(
        quantity=i.quantity,
        unit_price=i.unit_price,
        discount_rate=i.discount_rate,
        years=i.years or Decimal(1),
    )


def _recompute_quote_totals(q: Quote, inputs: list[LineItemIn]) -> None:
    lines = [_line_triple(i) for i in inputs]
    subtotal, discount_total, tax_amount, total_amount = compute_totals(
        items=lines, tax_mode=q.tax_mode, tax_rate=q.tax_rate or Decimal(0)
    )
    q.subtotal = subtotal
    q.discount_total = discount_total
    q.tax_amount = tax_amount
    q.total_amount = total_amount


async def _get_quote_loaded(db: AsyncSession, qid: UUID) -> QuoteOut:
    """qid 로 Quote 를 selectinload 와 함께 재조회 → QuoteOut 반환.

    save 직후 호출 시 주의: SQLAlchemy identity map 이 이미 로드된 `items` 컬렉션을
    캐시하므로, delete+add 후에는 호출자가 먼저 `await db.refresh(q, attribute_names=["items"])`
    또는 `_quote_out(db, q)` 를 직접 호출해야 최신 items 가 응답에 포함된다.
    """
    q = (
        await db.execute(
            select(Quote).options(selectinload(Quote.items)).where(Quote.id == qid)
        )
    ).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")
    return await _quote_out(db, q)


@quotes_router.get("/{qid}", response_model=QuoteOut)
async def get_quote(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return await _get_quote_loaded(db, qid)


@quotes_router.patch("/{qid}", response_model=QuoteOut)
async def update_quote(
    qid: UUID,
    payload: QuoteUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    q = (
        await db.execute(
            select(Quote).options(selectinload(Quote.items)).where(Quote.id == qid)
        )
    ).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")

    data = payload.model_dump(exclude_unset=True)

    # 고객이 바뀌면 snapshot 갱신.
    if "customer_id" in data and data["customer_id"] != q.customer_id:
        q.customer_id = data.pop("customer_id")
        q.customer_snapshot = await snapshot_customer(db, q.customer_id)

    # 저장 시마다 발행자(issuer) / 고객 snapshot 을 최신 값으로 새로고침.
    q.issuer_snapshot = await snapshot_issuer(db)
    if q.customer_id:
        q.customer_snapshot = await snapshot_customer(db, q.customer_id)

    for k, v in data.items():
        setattr(q, k, v)

    # 현재 라인들로 총액 재계산 (라인 자체는 /items 엔드포인트에서 변경).
    inputs = [
        LineItemIn(
            kind=i.kind,
            name=i.name,
            description=i.description,
            unit=i.unit,
            quantity=i.quantity,
            unit_price=i.unit_price,
            discount_rate=i.discount_rate,
            role=i.role,
            period_start=i.period_start,
            period_end=i.period_end,
            months=i.months,
            years=getattr(i, "years", 1) or 1,
            manual_total=i.manual_total,
            line_total=i.line_total,
        )
        for i in q.items
    ]
    _recompute_quote_totals(q, inputs)
    await db.commit()
    logger.info("견적서 수정: id=%s 변경필드=%s (수정자=%s)", qid, list(data.keys()), current.id)
    return await _get_quote_loaded(db, qid)


@quotes_router.delete("/{qid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_quote(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    q = (await db.execute(select(Quote).where(Quote.id == qid))).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")
    await db.delete(q)
    await db.commit()
    logger.warning("견적서 삭제: id=%s number=%s (삭제자=%s)", qid, q.number, current.id)


@quotes_router.put("/{qid}/items", response_model=QuoteOut)
async def save_quote_items(
    qid: UUID,
    payload: QuoteItemsSave,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    q = (
        await db.execute(
            select(Quote).options(selectinload(Quote.items)).where(Quote.id == qid)
        )
    ).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")

    # 저장 시마다 발행자/고객 snapshot 을 최신 값으로 새로고침.
    q.issuer_snapshot = await snapshot_issuer(db)
    if q.customer_id:
        q.customer_snapshot = await snapshot_customer(db, q.customer_id)

    # 기존 라인 전부 삭제 후 재삽입 — 편집은 일괄 교체 방식.
    for existing in list(q.items):
        await db.delete(existing)
    await db.flush()

    for idx, item in enumerate(payload.items):
        it = _apply_line(item, item.position if item.position is not None else idx, QuoteItem)
        it.quote_id = q.id
        db.add(it)
    await db.flush()

    _recompute_quote_totals(q, payload.items)
    await db.commit()
    await db.refresh(q, attribute_names=["items"])
    logger.info("견적서 라인 저장: id=%s count=%s (수정자=%s)", qid, len(payload.items), current.id)
    return await _quote_out(db, q)


@quotes_router.post("/{qid}/save", response_model=QuoteOut)
async def save_quote(
    qid: UUID,
    payload: QuoteSave,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """통합 저장 — 헤더+라인을 한 트랜잭션으로 저장.

    `new_version=False` (기본) — 현재 버전 **덮어쓰기**. 버전/이력 변경 없음.
    `new_version=True` — 현재 상태를 이력에 스냅샷(as v_current) + 버전 +1.
    신규 버전은 명시적 UI 액션이 있을 때만 발생한다.
    """
    q = (
        await db.execute(
            select(Quote).options(selectinload(Quote.items)).where(Quote.id == qid)
        )
    ).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")

    if q.status == "FINAL":
        raise HTTPException(
            status_code=400,
            detail="최종 제출된 견적서는 편집할 수 없습니다. 먼저 '최종 제출 취소' 를 하세요.",
        )

    # new_version 시: 현재 Quote 의 snapshot 을 v_current 이력 row 로 **먼저** 기록.
    # 이후 payload 를 적용하고 버전을 +1 한다. UNIQUE(quote_id, version) 충돌 시
    # UPDATE (idempotent) — 과거에 자동 생성된 중복 row 가 있어도 안전.
    if payload.new_version:
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        header_snap = _quote_header_snapshot(q)
        items_snap = [_item_snapshot(i) for i in q.items]
        stmt = pg_insert(QuoteVersion.__table__).values(
            quote_id=q.id,
            version=q.version,
            header=header_snap,
            items=items_snap,
            created_by=current.id,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["quote_id", "version"],
            set_={
                "header": stmt.excluded["header"],
                "items": stmt.excluded["items"],
                "created_by": stmt.excluded["created_by"],
            },
        )
        await db.execute(stmt)

    data = payload.model_dump(exclude_unset=True, exclude={"items", "new_version"})

    if "customer_id" in data:
        q.customer_id = data.pop("customer_id")

    for k, v in data.items():
        setattr(q, k, v)

    q.issuer_snapshot = await snapshot_issuer(db)
    if q.customer_id:
        q.customer_snapshot = await snapshot_customer(db, q.customer_id)
    else:
        q.customer_snapshot = None

    for existing in list(q.items):
        await db.delete(existing)
    await db.flush()
    for idx, item in enumerate(payload.items):
        it = _apply_line(item, item.position if item.position is not None else idx, QuoteItem)
        it.quote_id = q.id
        db.add(it)
    await db.flush()

    _recompute_quote_totals(q, payload.items)

    if payload.new_version:
        q.version = (q.version or 0) + 1

    await db.commit()
    # identity map 에 남아 있는 q.items 컬렉션이 stale — 기존 아이템을 delete 하고
    # 신규를 db.add 로 넣었지만 관계 컬렉션에는 append 하지 않았기 때문. 후속 SELECT
    # 가 selectinload 를 시도해도 이미 로드된 relationship 은 재로딩하지 않는다.
    # expire → 재조회 시 강제로 다시 읽어오도록.
    await db.refresh(q, attribute_names=["items"])
    logger.info(
        "견적서 저장(v%s): id=%s number=%s count=%s (저장자=%s)",
        q.version,
        qid,
        q.number,
        len(payload.items),
        current.id,
    )
    return await _quote_out(db, q)


@quotes_router.get("/{qid}/versions", response_model=list[VersionOut])
async def list_quote_versions(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(QuoteVersion)
                .where(QuoteVersion.quote_id == qid)
                .order_by(QuoteVersion.version.desc())
            )
        ).scalars()
    )
    return [VersionOut.model_validate(r, from_attributes=True) for r in rows]


@quotes_router.post("/{qid}/finalize", response_model=QuoteOut)
async def finalize_quote(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """견적서를 최종 제출 상태(FINAL)로 잠근다. 이후 save 는 차단된다."""
    q = (await db.execute(select(Quote).where(Quote.id == qid))).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")
    q.status = "FINAL"
    await db.commit()
    logger.info(
        "견적서 최종 제출: id=%s number=%s v%s (요청자=%s)",
        qid,
        q.number,
        q.version,
        current.id,
    )
    return await _get_quote_loaded(db, qid)


@quotes_router.post("/{qid}/unfinalize", response_model=QuoteOut)
async def unfinalize_quote(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """최종 제출 상태를 다시 DRAFT 로 되돌려 편집 가능하게 한다."""
    q = (await db.execute(select(Quote).where(Quote.id == qid))).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quote not found")
    q.status = "DRAFT"
    await db.commit()
    logger.info(
        "견적서 최종 제출 취소: id=%s number=%s (요청자=%s)",
        qid,
        q.number,
        current.id,
    )
    return await _get_quote_loaded(db, qid)


@quotes_router.post("/{qid}/copy", response_model=QuoteOut, status_code=status.HTTP_201_CREATED)
async def copy_quote(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    src = (
        await db.execute(
            select(Quote).options(selectinload(Quote.items)).where(Quote.id == qid)
        )
    ).scalar_one_or_none()
    if not src:
        raise HTTPException(status_code=404, detail="Quote not found")

    today = date.today()
    number, seq = await next_quote_number(db, today.year, issue_date=today)
    valid_until = None
    if src.valid_until and src.issue_date:
        delta = (src.valid_until - src.issue_date).days
        if delta > 0:
            from datetime import timedelta as _td

            valid_until = today + _td(days=delta)

    new_q = Quote(
        number=number,
        year=today.year,
        seq=seq,
        customer_id=src.customer_id,
        customer_snapshot=await snapshot_customer(db, src.customer_id),
        issuer_snapshot=await snapshot_issuer(db),
        title=f"사본 - {src.title}",
        business_name=src.business_name,
        attention=src.attention,
        issue_date=today,
        valid_until=valid_until,
        currency=src.currency,
        locale=src.locale,
        tax_mode=src.tax_mode,
        tax_rate=src.tax_rate,
        project_id=src.project_id,
        opportunity_id=src.opportunity_id,
        memo=src.memo,
        terms=src.terms,
        source_quote_id=src.id,
        created_by=current.id,
    )
    db.add(new_q)
    await db.flush()

    inputs: list[LineItemIn] = []
    for i in src.items:
        it = QuoteItem(
            quote_id=new_q.id,
            position=i.position,
            kind=i.kind,
            name=i.name,
            description=i.description,
            unit=i.unit,
            quantity=i.quantity,
            unit_price=i.unit_price,
            discount_rate=i.discount_rate,
            role=i.role,
            period_start=i.period_start,
            period_end=i.period_end,
            months=i.months,
            years=getattr(i, "years", 1) or 1,
            line_subtotal=i.line_subtotal,
            line_discount=i.line_discount,
            line_total=i.line_total,
            manual_total=i.manual_total,
        )
        db.add(it)
        inputs.append(
            LineItemIn(
                kind=i.kind,
                name=i.name,
                description=i.description,
                unit=i.unit,
                quantity=i.quantity,
                unit_price=i.unit_price,
                discount_rate=i.discount_rate,
                role=i.role,
                period_start=i.period_start,
                period_end=i.period_end,
                months=i.months,
            years=getattr(i, "years", 1) or 1,
                manual_total=i.manual_total,
                line_total=i.line_total,
            )
        )
    await db.flush()
    _recompute_quote_totals(new_q, inputs)
    await db.commit()
    logger.info(
        "견적서 복제: src=%s → new=%s (요청자=%s)", src.number, number, current.id
    )
    return await _get_quote_loaded(db, new_q.id)


@quotes_router.post(
    "/{qid}/convert", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED
)
async def convert_quote_to_invoice(
    qid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    src = (
        await db.execute(
            select(Quote).options(selectinload(Quote.items)).where(Quote.id == qid)
        )
    ).scalar_one_or_none()
    if not src:
        raise HTTPException(status_code=404, detail="Quote not found")

    today = date.today()
    number, seq = await next_invoice_number(db, today.year, issue_date=today)
    inv = Invoice(
        number=number,
        year=today.year,
        seq=seq,
        customer_id=src.customer_id,
        customer_snapshot=await snapshot_customer(db, src.customer_id),
        issuer_snapshot=await snapshot_issuer(db),
        title=src.title,
        business_name=src.business_name,
        attention=src.attention,
        issue_date=today,
        due_date=None,
        currency=src.currency,
        tax_mode=src.tax_mode,
        tax_rate=src.tax_rate,
        subtotal=src.subtotal,
        discount_total=src.discount_total,
        tax_amount=src.tax_amount,
        total_amount=src.total_amount,
        project_id=src.project_id,
        opportunity_id=src.opportunity_id,
        source_quote_id=src.id,
        memo=src.memo,
        terms=src.terms,
        created_by=current.id,
    )
    db.add(inv)
    await db.flush()
    for i in src.items:
        db.add(
            InvoiceItem(
                invoice_id=inv.id,
                position=i.position,
                kind=i.kind,
                name=i.name,
                description=i.description,
                unit=i.unit,
                quantity=i.quantity,
                unit_price=i.unit_price,
                discount_rate=i.discount_rate,
                role=i.role,
                period_start=i.period_start,
                period_end=i.period_end,
                months=i.months,
            years=getattr(i, "years", 1) or 1,
                line_subtotal=i.line_subtotal,
                line_discount=i.line_discount,
                line_total=i.line_total,
                manual_total=i.manual_total,
            )
        )

    # 원본 견적에 전환된 invoice 를 링크.
    src.converted_invoice_id = inv.id

    await db.commit()
    logger.info(
        "견적 → 청구 전환: quote=%s → invoice=%s (요청자=%s)",
        src.number,
        number,
        current.id,
    )
    return await _get_invoice_loaded(db, inv.id)


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------

invoices_router = APIRouter(prefix="/invoices", tags=["billing"])


def _recompute_invoice_totals(inv: Invoice, inputs: list[LineItemIn]) -> None:
    lines = [_line_triple(i) for i in inputs]
    subtotal, discount_total, tax_amount, total_amount = compute_totals(
        items=lines, tax_mode=inv.tax_mode, tax_rate=inv.tax_rate or Decimal(0)
    )
    inv.subtotal = subtotal
    inv.discount_total = discount_total
    inv.tax_amount = tax_amount
    inv.total_amount = total_amount


async def _invoice_out(db: AsyncSession, inv: Invoice) -> InvoiceOut:
    out = InvoiceOut.model_validate(inv, from_attributes=True)
    out.items = [LineItemOut.model_validate(i, from_attributes=True) for i in inv.items]
    out.customer_name = await _customer_name(db, inv.customer_id)
    out.display_number = f"{inv.number}-{inv.version}"
    return out


async def _get_invoice_loaded(db: AsyncSession, iid: UUID) -> InvoiceOut:
    inv = (
        await db.execute(
            select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == iid)
        )
    ).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return await _invoice_out(db, inv)


@invoices_router.get("", response_model=list[InvoiceOut])
async def list_invoices(
    year: int | None = None,
    q: str | None = None,
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(Invoice)
        .options(selectinload(Invoice.items))
        .order_by(Invoice.issue_date.desc(), Invoice.seq.desc())
    )
    if year is not None:
        stmt = stmt.where(Invoice.year == year)
    if customer_id:
        stmt = stmt.where(Invoice.customer_id == customer_id)
    if q:
        stmt = stmt.where(Invoice.title.ilike(f"%{q}%"))
    rows = list((await db.execute(stmt)).scalars().unique())
    cids = {r.customer_id for r in rows if r.customer_id}
    names: dict[UUID, str] = {}
    if cids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cids)))
        ).scalars():
            names[c.id] = c.name
    out: list[InvoiceOut] = []
    for r in rows:
        item = InvoiceOut.model_validate(r, from_attributes=True)
        item.items = [LineItemOut.model_validate(i, from_attributes=True) for i in r.items]
        item.customer_name = names.get(r.customer_id) if r.customer_id else None
        out.append(item)
    return out


@invoices_router.post("", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
async def create_invoice(
    payload: InvoiceCreate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    issue_date = payload.issue_date or date.today()
    number, seq = await next_invoice_number(db, issue_date.year, issue_date=issue_date)

    # 청구서 기본 세율은 0% (사용자가 명시 입력하지 않은 경우).
    tax_rate = payload.tax_rate if payload.tax_rate is not None else Decimal("0")

    inv = Invoice(
        number=number,
        year=issue_date.year,
        seq=seq,
        customer_id=payload.customer_id,
        customer_snapshot=await snapshot_customer(db, payload.customer_id),
        issuer_snapshot=await snapshot_issuer(db),
        title=payload.title or "(제목 없음)",
        business_name=payload.business_name,
        attention=payload.attention,
        po_no=payload.po_no,
        issue_date=issue_date,
        due_date=payload.due_date,
        currency=payload.currency,
        tax_mode=payload.tax_mode,
        tax_rate=tax_rate,
        project_id=payload.project_id,
        opportunity_id=payload.opportunity_id,
        memo=payload.memo,
        terms=payload.terms,
        source_quote_id=payload.source_quote_id,
        source_invoice_id=payload.source_invoice_id,
        created_by=current.id,
    )
    db.add(inv)
    await db.flush()
    for idx, item in enumerate(payload.items):
        it = _apply_line(item, item.position if item.position is not None else idx, InvoiceItem)
        it.invoice_id = inv.id
        db.add(it)
    await db.flush()
    _recompute_invoice_totals(inv, payload.items)
    await db.commit()
    logger.info(
        "청구서 생성: id=%s number=%s customer=%s po=%s items=%s (생성자=%s)",
        inv.id,
        inv.number,
        inv.customer_id,
        inv.po_no,
        len(payload.items),
        current.id,
    )
    return await _get_invoice_loaded(db, inv.id)


@invoices_router.get("/{iid}", response_model=InvoiceOut)
async def get_invoice(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return await _get_invoice_loaded(db, iid)


@invoices_router.patch("/{iid}", response_model=InvoiceOut)
async def update_invoice(
    iid: UUID,
    payload: InvoiceUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    inv = (
        await db.execute(
            select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == iid)
        )
    ).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    data = payload.model_dump(exclude_unset=True)
    if "customer_id" in data and data["customer_id"] != inv.customer_id:
        inv.customer_id = data.pop("customer_id")
        inv.customer_snapshot = await snapshot_customer(db, inv.customer_id)

    # 저장 시마다 발행자/고객 snapshot 을 최신 값으로 새로고침.
    inv.issuer_snapshot = await snapshot_issuer(db)
    if inv.customer_id:
        inv.customer_snapshot = await snapshot_customer(db, inv.customer_id)

    for k, v in data.items():
        setattr(inv, k, v)

    inputs = [
        LineItemIn(
            kind=i.kind,
            name=i.name,
            description=i.description,
            unit=i.unit,
            quantity=i.quantity,
            unit_price=i.unit_price,
            discount_rate=i.discount_rate,
            role=i.role,
            period_start=i.period_start,
            period_end=i.period_end,
            months=i.months,
            years=getattr(i, "years", 1) or 1,
            manual_total=i.manual_total,
            line_total=i.line_total,
        )
        for i in inv.items
    ]
    _recompute_invoice_totals(inv, inputs)
    await db.commit()
    logger.info(
        "청구서 수정: id=%s 변경필드=%s (수정자=%s)", iid, list(data.keys()), current.id
    )
    return await _get_invoice_loaded(db, iid)


@invoices_router.delete("/{iid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invoice(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    inv = (await db.execute(select(Invoice).where(Invoice.id == iid))).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    await db.delete(inv)
    await db.commit()
    logger.warning("청구서 삭제: id=%s number=%s (삭제자=%s)", iid, inv.number, current.id)


@invoices_router.put("/{iid}/items", response_model=InvoiceOut)
async def save_invoice_items(
    iid: UUID,
    payload: InvoiceItemsSave,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    inv = (
        await db.execute(
            select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == iid)
        )
    ).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    inv.issuer_snapshot = await snapshot_issuer(db)
    if inv.customer_id:
        inv.customer_snapshot = await snapshot_customer(db, inv.customer_id)

    for existing in list(inv.items):
        await db.delete(existing)
    await db.flush()

    for idx, item in enumerate(payload.items):
        it = _apply_line(item, item.position if item.position is not None else idx, InvoiceItem)
        it.invoice_id = inv.id
        db.add(it)
    await db.flush()

    _recompute_invoice_totals(inv, payload.items)
    await db.commit()
    await db.refresh(inv, attribute_names=["items"])
    logger.info(
        "청구서 라인 저장: id=%s count=%s (수정자=%s)", iid, len(payload.items), current.id
    )
    return await _invoice_out(db, inv)


@invoices_router.post("/{iid}/save", response_model=InvoiceOut)
async def save_invoice(
    iid: UUID,
    payload: InvoiceSave,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """통합 저장 — new_version=True 시에만 버전 bump + 이력 기록."""
    inv = (
        await db.execute(
            select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == iid)
        )
    ).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    if inv.status == "FINAL":
        raise HTTPException(
            status_code=400,
            detail="최종 제출된 청구서는 편집할 수 없습니다. 먼저 '최종 제출 취소' 를 하세요.",
        )

    if payload.new_version:
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = pg_insert(InvoiceVersion.__table__).values(
            invoice_id=inv.id,
            version=inv.version,
            header=_invoice_header_snapshot(inv),
            items=[_item_snapshot(i) for i in inv.items],
            created_by=current.id,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["invoice_id", "version"],
            set_={
                "header": stmt.excluded["header"],
                "items": stmt.excluded["items"],
                "created_by": stmt.excluded["created_by"],
            },
        )
        await db.execute(stmt)

    data = payload.model_dump(exclude_unset=True, exclude={"items", "new_version"})
    if "customer_id" in data:
        inv.customer_id = data.pop("customer_id")
    for k, v in data.items():
        setattr(inv, k, v)

    inv.issuer_snapshot = await snapshot_issuer(db)
    if inv.customer_id:
        inv.customer_snapshot = await snapshot_customer(db, inv.customer_id)
    else:
        inv.customer_snapshot = None

    for existing in list(inv.items):
        await db.delete(existing)
    await db.flush()
    for idx, item in enumerate(payload.items):
        it = _apply_line(item, item.position if item.position is not None else idx, InvoiceItem)
        it.invoice_id = inv.id
        db.add(it)
    await db.flush()

    _recompute_invoice_totals(inv, payload.items)

    if payload.new_version:
        inv.version = (inv.version or 0) + 1

    await db.commit()
    # identity map stale collection 회피 — save_quote 와 동일한 패턴.
    await db.refresh(inv, attribute_names=["items"])
    logger.info(
        "청구서 저장(v%s): id=%s number=%s count=%s (저장자=%s)",
        inv.version,
        iid,
        inv.number,
        len(payload.items),
        current.id,
    )
    return await _invoice_out(db, inv)


@invoices_router.get("/{iid}/versions", response_model=list[VersionOut])
async def list_invoice_versions(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(InvoiceVersion)
                .where(InvoiceVersion.invoice_id == iid)
                .order_by(InvoiceVersion.version.desc())
            )
        ).scalars()
    )
    return [VersionOut.model_validate(r, from_attributes=True) for r in rows]


@invoices_router.post("/{iid}/finalize", response_model=InvoiceOut)
async def finalize_invoice(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """청구서를 최종 제출 상태(FINAL)로 잠근다. 이후 save 는 차단된다."""
    inv = (
        await db.execute(select(Invoice).where(Invoice.id == iid))
    ).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    inv.status = "FINAL"
    await db.commit()
    logger.info(
        "청구서 최종 제출: id=%s number=%s v%s (요청자=%s)",
        iid,
        inv.number,
        inv.version,
        current.id,
    )
    return await _get_invoice_loaded(db, iid)


@invoices_router.post("/{iid}/unfinalize", response_model=InvoiceOut)
async def unfinalize_invoice(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    inv = (
        await db.execute(select(Invoice).where(Invoice.id == iid))
    ).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    inv.status = "DRAFT"
    await db.commit()
    logger.info(
        "청구서 최종 제출 취소: id=%s number=%s (요청자=%s)",
        iid,
        inv.number,
        current.id,
    )
    return await _get_invoice_loaded(db, iid)


@invoices_router.post("/{iid}/copy", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
async def copy_invoice(
    iid: UUID,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    src = (
        await db.execute(
            select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == iid)
        )
    ).scalar_one_or_none()
    if not src:
        raise HTTPException(status_code=404, detail="Invoice not found")

    today = date.today()
    number, seq = await next_invoice_number(db, today.year, issue_date=today)
    due_date = None
    if src.due_date and src.issue_date:
        delta = (src.due_date - src.issue_date).days
        if delta > 0:
            from datetime import timedelta as _td

            due_date = today + _td(days=delta)

    new_inv = Invoice(
        number=number,
        year=today.year,
        seq=seq,
        customer_id=src.customer_id,
        customer_snapshot=await snapshot_customer(db, src.customer_id),
        issuer_snapshot=await snapshot_issuer(db),
        title=f"사본 - {src.title}",
        business_name=src.business_name,
        attention=src.attention,
        issue_date=today,
        due_date=due_date,
        currency=src.currency,
        tax_mode=src.tax_mode,
        tax_rate=src.tax_rate,
        project_id=src.project_id,
        opportunity_id=src.opportunity_id,
        memo=src.memo,
        terms=src.terms,
        source_invoice_id=src.id,
        paid_amount=Decimal(0),
        created_by=current.id,
    )
    db.add(new_inv)
    await db.flush()

    inputs: list[LineItemIn] = []
    for i in src.items:
        db.add(
            InvoiceItem(
                invoice_id=new_inv.id,
                position=i.position,
                kind=i.kind,
                name=i.name,
                description=i.description,
                unit=i.unit,
                quantity=i.quantity,
                unit_price=i.unit_price,
                discount_rate=i.discount_rate,
                role=i.role,
                period_start=i.period_start,
                period_end=i.period_end,
                months=i.months,
            years=getattr(i, "years", 1) or 1,
                line_subtotal=i.line_subtotal,
                line_discount=i.line_discount,
                line_total=i.line_total,
                manual_total=i.manual_total,
            )
        )
        inputs.append(
            LineItemIn(
                kind=i.kind,
                name=i.name,
                description=i.description,
                unit=i.unit,
                quantity=i.quantity,
                unit_price=i.unit_price,
                discount_rate=i.discount_rate,
                role=i.role,
                period_start=i.period_start,
                period_end=i.period_end,
                months=i.months,
            years=getattr(i, "years", 1) or 1,
                manual_total=i.manual_total,
                line_total=i.line_total,
            )
        )
    await db.flush()
    _recompute_invoice_totals(new_inv, inputs)
    await db.commit()
    logger.info(
        "청구서 복제: src=%s → new=%s (요청자=%s)", src.number, number, current.id
    )
    return await _get_invoice_loaded(db, new_inv.id)




# ---------------------------------------------------------------------------
# Company profile (single-row)
# ---------------------------------------------------------------------------

profile_router = APIRouter(prefix="/company-profile", tags=["settings"])


async def _get_my_tenant(db: AsyncSession, user: User) -> Tenant:
    """현재 사용자의 tenant. SUPER_ADMIN(tenant_id=NULL)은 호출 금지 — 도메인
    데이터인 회사 프로필은 super admin 영역에서 다루지 않는다."""
    if user.tenant_id is None:
        raise HTTPException(
            status_code=400,
            detail="회사 프로필은 tenant 사용자 전용입니다.",
        )
    t = (
        await db.execute(select(Tenant).where(Tenant.id == user.tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return t


def _tenant_to_profile_out(t: Tenant) -> CompanyProfileOut:
    """Tenant → 기존 CompanyProfileOut 응답 형식 매핑.

    tenant.contact_email ↔ schema.email (필드명 차이만 변환).
    """
    return CompanyProfileOut(
        id=t.id,
        name=t.name,
        business_no=t.business_no,
        representative=t.representative,
        address=t.address,
        phone=t.phone,
        fax=t.fax,
        email=t.contact_email,
        bank_name=t.bank_name,
        bank_account=t.bank_account,
        bank_holder=t.bank_holder,
        name_en=t.name_en,
        representative_en=t.representative_en,
        address_en=t.address_en,
        bank_name_en=t.bank_name_en,
        bank_holder_en=t.bank_holder_en,
        logo_name=t.logo_name,
        logo_path=t.logo_path,
        stamp_name=t.stamp_name,
        stamp_path=t.stamp_path,
        seal_name=t.seal_name,
        seal_path=t.seal_path,
        number_prefix=t.number_prefix,
    )


@profile_router.get("", response_model=CompanyProfileOut)
async def get_profile(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _tenant_to_profile_out(await _get_my_tenant(db, user))


@profile_router.patch("", response_model=CompanyProfileOut)
async def update_profile(
    payload: CompanyProfileUpdate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    t = await _get_my_tenant(db, current)
    data = payload.model_dump(exclude_unset=True)
    if "number_prefix" in data:
        pref = (data["number_prefix"] or "").strip()
        if not pref:
            raise HTTPException(status_code=400, detail="number_prefix 는 비워둘 수 없습니다.")
        data["number_prefix"] = pref
    # email → contact_email 매핑
    if "email" in data:
        data["contact_email"] = data.pop("email")
    for k, v in data.items():
        setattr(t, k, v)
    await db.commit()
    await db.refresh(t)
    logger.info(
        "회사 프로필 수정: 변경필드=%s tenant=%s (수정자=%s)",
        list(data.keys()), t.slug, current.id,
    )
    return _tenant_to_profile_out(t)


# ---------------------------------------------------------------------------
# 회사 로고 / 도장 / 직인 (이미지 업로드)
# ---------------------------------------------------------------------------

_IMG_ALLOWED_MIME = {"image/svg+xml", "image/png", "image/jpeg", "image/webp"}

# kind → (name_attr, path_attr, mime_attr, 한글 라벨)
_IMG_KINDS = {
    "logo": ("logo_name", "logo_path", "logo_mime", "로고"),
    "stamp": ("stamp_name", "stamp_path", "stamp_mime", "도장"),
    "seal": ("seal_name", "seal_path", "seal_mime", "직인"),
}


async def _upload_image(
    kind: str,
    file: UploadFile,
    db: AsyncSession,
    current: User,
) -> CompanyProfileOut:
    name_a, path_a, mime_a, label = _IMG_KINDS[kind]
    mime = (file.content_type or "").lower()
    if mime not in _IMG_ALLOWED_MIME:
        raise HTTPException(
            status_code=400,
            detail="지원하지 않는 이미지 형식입니다. SVG / PNG / JPG / WebP 업로드만 가능합니다.",
        )
    t = await _get_my_tenant(db, current)
    existing_path = getattr(t, path_a)
    if existing_path:
        delete_file(existing_path)
    path, _size = await save_upload(file, "company-profile")
    setattr(t, name_a, file.filename or kind)
    setattr(t, path_a, path)
    setattr(t, mime_a, mime)
    await db.commit()
    await db.refresh(t)
    logger.info(
        "회사 %s 업로드: mime=%s name=%s tenant=%s (요청자=%s)",
        label, mime, getattr(t, name_a), t.slug, current.id,
    )
    return _tenant_to_profile_out(t)


async def _download_image(kind: str, db: AsyncSession, user: User) -> FileResponse:
    name_a, path_a, mime_a, label = _IMG_KINDS[kind]
    t = await _get_my_tenant(db, user)
    path = getattr(t, path_a)
    if not path:
        raise HTTPException(
            status_code=404,
            detail=f"{label} 이미지가 업로드되지 않았습니다.",
        )
    abs_path = resolve_upload_path(path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"{label} 파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        media_type=getattr(t, mime_a) or "application/octet-stream",
        filename=getattr(t, name_a) or kind,
    )


async def _delete_image(
    kind: str, db: AsyncSession, current: User
) -> CompanyProfileOut:
    name_a, path_a, mime_a, label = _IMG_KINDS[kind]
    t = await _get_my_tenant(db, current)
    existing_path = getattr(t, path_a)
    if existing_path:
        delete_file(existing_path)
    setattr(t, name_a, None)
    setattr(t, path_a, None)
    setattr(t, mime_a, None)
    await db.commit()
    await db.refresh(t)
    logger.info("회사 %s 삭제 tenant=%s (요청자=%s)", label, t.slug, current.id)
    return _tenant_to_profile_out(t)


@profile_router.post("/logo", response_model=CompanyProfileOut)
async def upload_logo(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    return await _upload_image("logo", file, db, current)


@profile_router.get("/logo")
async def download_logo(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _download_image("logo", db, user)


@profile_router.delete("/logo", response_model=CompanyProfileOut)
async def delete_logo(
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    return await _delete_image("logo", db, current)


@profile_router.post("/stamp", response_model=CompanyProfileOut)
async def upload_stamp(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    return await _upload_image("stamp", file, db, current)


@profile_router.get("/stamp")
async def download_stamp(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _download_image("stamp", db, user)


@profile_router.delete("/stamp", response_model=CompanyProfileOut)
async def delete_stamp(
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    return await _delete_image("stamp", db, current)


@profile_router.post("/seal", response_model=CompanyProfileOut)
async def upload_seal(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    return await _upload_image("seal", file, db, current)


@profile_router.get("/seal")
async def download_seal(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _download_image("seal", db, user)


@profile_router.delete("/seal", response_model=CompanyProfileOut)
async def delete_seal(
    db: AsyncSession = Depends(get_db),
    current: User = Depends(require_admin),
):
    return await _delete_image("seal", db, current)
