"""전자세금계산서 API (매입·매출 조회·수집·매칭).

Endpoints:
- `GET    /tax-invoices`                    페이지네이션·필터 목록
- `GET    /tax-invoices/summary`            기간 집계 (요약 카드)
- `GET    /tax-invoices/{id}`               단건 + 품목 + 매칭 정보
- `PATCH  /tax-invoices/{id}`               memo/linked_customer_id/linked_invoice_id 편집
- `POST   /tax-invoices/fetch`              수동 수집 (daily 또는 period)
- `POST   /tax-invoices/backfill-items`     기존 row 의 빈 품목 백필 (운영)
- `GET    /tax-invoices/fetches`            수집 이력
- `GET    /tax-invoices/{id}/pdf`           PDF blob

품목(`tax_invoice_items`) 수집 흐름:
1) 신규 수집 시 list API 응답의 ItemName 으로 1줄 미리 합성 (대표명)
2) 같은 dto 에 대해 detail API(GetTaxInvoice) 호출. 결과가 있으면 1줄을
   진짜 다품목 라인으로 덮어쓰기. 빈 응답(-21002 등) 이면 1줄 합성 유지.
3) 운영 중 발견된 헤더-only row 는 `backfill-items` endpoint 로 일괄 보강.

권한:
- read:   tax_invoices.read  (HR/ADMIN/SALES)
- manage: tax_invoices.manage (HR/ADMIN/SALES)
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_permission
from app.core.database import get_db
from app.models import TaxInvoice, TaxInvoiceFetch, TaxInvoiceItem, User
from app.services.storage import resolve_upload_path
from app.services.tax_invoice import fetch_and_upsert_daily
from app.services.tax_invoice.service import backfill_missing_items

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tax-invoices", tags=["tax-invoices"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class TaxInvoiceItemOut(BaseModel):
    id: UUID
    position: int
    item_name: str | None
    spec: str | None
    quantity: float | None
    unit_price: float | None
    supply_amount: float | None
    tax_amount: float | None
    memo: str | None


class TaxInvoiceOut(BaseModel):
    id: UUID
    kind: str
    status: str
    approval_no: str
    mgt_key: str | None
    issue_date: date
    written_date: date | None
    supplier_biz_no: str | None
    supplier_name: str | None
    supplier_ceo: str | None
    buyer_biz_no: str | None
    buyer_name: str | None
    buyer_ceo: str | None
    supply_amount: float
    tax_amount: float
    total_amount: float
    tax_type: str | None
    issue_type: str | None
    source: str
    has_pdf: bool
    linked_customer_id: UUID | None
    linked_customer_name: str | None = None
    linked_invoice_id: UUID | None
    linked_invoice_number: str | None = None
    linked_project_id: UUID | None
    linked_project_name: str | None = None
    memo: str | None
    items: list[TaxInvoiceItemOut] = []
    created_at: datetime
    updated_at: datetime


class TaxInvoicePageOut(BaseModel):
    items: list[TaxInvoiceOut]
    total: int
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=2000)


class TaxInvoiceSummaryOut(BaseModel):
    kind: str
    count: int
    supply_amount: float
    tax_amount: float
    total_amount: float
    matched_customer_count: int
    matched_invoice_count: int


class YearlyComparisonPeriod(BaseModel):
    """분기(q) 또는 월(m) 한 칸의 비교 데이터.

    `current`/`prev` 모두 supply_amount(공급가액) 합계.
    """

    period: int  # 분기: 1~4, 월: 1~12
    sales_current: float
    sales_prev: float
    purchase_current: float
    purchase_prev: float


class YearlyComparisonOut(BaseModel):
    """매입/매출 현황 페이지용 연도 비교 집계 (분기 + 월)."""

    year: int  # 기준 (current)
    prev_year: int
    # 누적 (KPI 카드용).
    sales_current_total: float
    sales_prev_total: float
    purchase_current_total: float
    purchase_prev_total: float
    quarters: list[YearlyComparisonPeriod]  # 4 entries (q=1..4)
    months: list[YearlyComparisonPeriod]    # 12 entries (m=1..12)


class SalesCustomerBucket(BaseModel):
    biz_no: str | None
    name: str | None
    total_amount: float


class SalesCustomerTopOut(BaseModel):
    """매출처 집계 — buyer_biz_no 별 SUM(total_amount) 상위 N + 전체 합계."""

    date_from: date
    date_to: date
    total_amount: float  # 전체 SALES 합계 (top N 외 포함). 비율 분모.
    items: list[SalesCustomerBucket]


class TaxInvoicePatch(BaseModel):
    memo: str | None = None
    linked_customer_id: UUID | None = None
    linked_invoice_id: UUID | None = None
    linked_project_id: UUID | None = None


class TaxInvoiceFetchRequest(BaseModel):
    """수동 수집 요청.

    `date_target` 지정 시 단일 일자(DAILY), `date_from`+`date_to` 지정 시 기간(PERIOD).
    kinds 지정 시 해당 방향만, 미지정 시 SALES+PURCHASE 모두.
    """
    date_target: date | None = None
    date_from: date | None = None
    date_to: date | None = None
    kinds: list[Literal["SALES", "PURCHASE"]] | None = None
    catchup_days: int | None = None   # daily 호출 시 며칠치 되돌아갈지 (기본 7)


class TaxInvoiceBackfillItemsOut(BaseModel):
    """`POST /tax-invoices/backfill-items` 결과 요약."""

    candidates: int      # items 가 비어있던 row 수
    filled: int          # detail API 로 품목 채운 row 수
    skipped: int         # mgt_key 누락 / detail 응답에 품목 없음
    errors: int          # detail 호출 실패


class TaxInvoiceFetchOut(BaseModel):
    id: UUID
    kind: str
    method: str
    period_start: date | None
    period_end: date | None
    trigger_kind: str
    source: str
    status: str
    fetched_count: int
    created_count: int
    updated_count: int
    skipped_count: int
    error_message: str | None
    started_at: datetime
    finished_at: datetime | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_out(row: TaxInvoice) -> TaxInvoiceOut:
    return TaxInvoiceOut(
        id=row.id,
        kind=row.kind,
        status=row.status,
        approval_no=row.approval_no,
        mgt_key=row.mgt_key,
        issue_date=row.issue_date,
        written_date=row.written_date,
        supplier_biz_no=row.supplier_biz_no,
        supplier_name=row.supplier_name,
        supplier_ceo=row.supplier_ceo,
        buyer_biz_no=row.buyer_biz_no,
        buyer_name=row.buyer_name,
        buyer_ceo=row.buyer_ceo,
        supply_amount=float(row.supply_amount or 0),
        tax_amount=float(row.tax_amount or 0),
        total_amount=float(row.total_amount or 0),
        tax_type=row.tax_type,
        issue_type=row.issue_type,
        source=row.source,
        has_pdf=bool(row.pdf_path),
        linked_customer_id=row.linked_customer_id,
        linked_invoice_id=row.linked_invoice_id,
        linked_project_id=row.linked_project_id,
        memo=row.memo,
        items=[
            TaxInvoiceItemOut(
                id=it.id,
                position=it.position,
                item_name=it.item_name,
                spec=it.spec,
                quantity=float(it.quantity) if it.quantity is not None else None,
                unit_price=float(it.unit_price) if it.unit_price is not None else None,
                supply_amount=float(it.supply_amount) if it.supply_amount is not None else None,
                tax_amount=float(it.tax_amount) if it.tax_amount is not None else None,
                memo=it.memo,
            )
            for it in row.items
        ],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _enrich_linked_names(
    db: AsyncSession, outs: list[TaxInvoiceOut]
) -> None:
    """linked_{customer,invoice,project}_id 에 대응되는 이름/번호 채워 넣기."""
    from app.models import Customer, Invoice, Project

    cust_ids = {o.linked_customer_id for o in outs if o.linked_customer_id}
    inv_ids = {o.linked_invoice_id for o in outs if o.linked_invoice_id}
    proj_ids = {o.linked_project_id for o in outs if o.linked_project_id}
    cust_name: dict[UUID, str] = {}
    inv_no: dict[UUID, str] = {}
    proj_name: dict[UUID, str] = {}
    if cust_ids:
        rows = (
            await db.execute(
                select(Customer.id, Customer.name).where(Customer.id.in_(cust_ids))
            )
        ).all()
        cust_name = {r[0]: r[1] for r in rows}
    if inv_ids:
        rows = (
            await db.execute(
                select(Invoice.id, Invoice.number).where(Invoice.id.in_(inv_ids))
            )
        ).all()
        inv_no = {r[0]: r[1] for r in rows}
    if proj_ids:
        rows = (
            await db.execute(
                select(Project.id, Project.name).where(Project.id.in_(proj_ids))
            )
        ).all()
        proj_name = {r[0]: r[1] for r in rows}
    for o in outs:
        if o.linked_customer_id:
            o.linked_customer_name = cust_name.get(o.linked_customer_id)
        if o.linked_invoice_id:
            o.linked_invoice_number = inv_no.get(o.linked_invoice_id)
        if o.linked_project_id:
            o.linked_project_name = proj_name.get(o.linked_project_id)


# ---------------------------------------------------------------------------
# List / summary
# ---------------------------------------------------------------------------


@router.get("", response_model=TaxInvoicePageOut)
async def list_tax_invoices(
    kind: Literal["SALES", "PURCHASE"] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    q: str | None = None,
    linked: Literal["all", "matched", "unmatched"] = "all",
    linked_project_id: UUID | None = None,
    linked_customer_id: UUID | None = None,
    page: int = 1,
    page_size: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
) -> TaxInvoicePageOut:
    page = max(1, page)
    # 프론트가 클라이언트 페이징을 쓰므로 한 번에 많이 받아도 되도록 상한 2000.
    page_size = max(1, min(2000, page_size))
    stmt = select(TaxInvoice).options(selectinload(TaxInvoice.items))
    if kind:
        stmt = stmt.where(TaxInvoice.kind == kind)
    # 날짜 필터는 작성일(written_date) 기준. written_date 가 NULL 이면 발행일을
    # 대체로 사용 — 과거 manual 입력 데이터 누락 방지.
    if date_from:
        stmt = stmt.where(
            func.coalesce(TaxInvoice.written_date, TaxInvoice.issue_date) >= date_from
        )
    if date_to:
        stmt = stmt.where(
            func.coalesce(TaxInvoice.written_date, TaxInvoice.issue_date) <= date_to
        )
    if q:
        q_trim = q.strip()
        like = f"%{q_trim}%"
        conds = [
            TaxInvoice.supplier_name.ilike(like),
            TaxInvoice.buyer_name.ilike(like),
        ]
        # 사업자번호·승인번호는 DB 저장값에 하이픈이 섞여 있음 (manual 입력=포함,
        # barobill 자동수집=미포함). 사용자 입력도 둘 다 가능 → 저장값·입력값 둘
        # 다 숫자만 남겨 비교하면 포맷 차이를 흡수.
        q_digits = re.sub(r"\D", "", q_trim)
        if q_digits:
            digits_like = f"%{q_digits}%"
            conds.extend([
                func.regexp_replace(TaxInvoice.supplier_biz_no, r"\D", "", "g").ilike(digits_like),
                func.regexp_replace(TaxInvoice.buyer_biz_no, r"\D", "", "g").ilike(digits_like),
                func.regexp_replace(TaxInvoice.approval_no, r"\D", "", "g").ilike(digits_like),
            ])
        else:
            # q 에 숫자가 없으면(한글·영문만) 문자열 ilike 만.
            conds.extend([
                TaxInvoice.supplier_biz_no.ilike(like),
                TaxInvoice.buyer_biz_no.ilike(like),
                TaxInvoice.approval_no.ilike(like),
            ])
        stmt = stmt.where(or_(*conds))
    if linked == "matched":
        stmt = stmt.where(TaxInvoice.linked_customer_id.isnot(None))
    elif linked == "unmatched":
        stmt = stmt.where(TaxInvoice.linked_customer_id.is_(None))
    if linked_project_id is not None:
        stmt = stmt.where(TaxInvoice.linked_project_id == linked_project_id)
    if linked_customer_id is not None:
        stmt = stmt.where(TaxInvoice.linked_customer_id == linked_customer_id)

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = (
        stmt.order_by(TaxInvoice.issue_date.desc(), TaxInvoice.approval_no.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = list((await db.execute(stmt)).scalars())
    outs = [_to_out(r) for r in rows]
    await _enrich_linked_names(db, outs)
    return TaxInvoicePageOut(items=outs, total=total, page=page, page_size=page_size)


@router.get("/summary", response_model=list[TaxInvoiceSummaryOut])
async def get_summary(
    date_from: date | None = None,
    date_to: date | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
) -> list[TaxInvoiceSummaryOut]:
    """매입/매출별 건수 · 공급가액 · 부가세 · 매칭률 요약."""
    out: list[TaxInvoiceSummaryOut] = []
    for kind in ("SALES", "PURCHASE"):
        stmt = select(
            func.count(TaxInvoice.id),
            func.coalesce(func.sum(TaxInvoice.supply_amount), 0),
            func.coalesce(func.sum(TaxInvoice.tax_amount), 0),
            func.coalesce(func.sum(TaxInvoice.total_amount), 0),
        ).where(TaxInvoice.kind == kind)
        # 날짜 필터는 작성일 기준. written_date 누락 시 issue_date 로 fallback.
        date_expr = func.coalesce(TaxInvoice.written_date, TaxInvoice.issue_date)
        if date_from:
            stmt = stmt.where(date_expr >= date_from)
        if date_to:
            stmt = stmt.where(date_expr <= date_to)
        cnt, supply, tax, tot = (await db.execute(stmt)).one()

        matched_cust = await db.execute(
            select(func.count(TaxInvoice.id)).where(
                and_(
                    TaxInvoice.kind == kind,
                    TaxInvoice.linked_customer_id.isnot(None),
                    *([date_expr >= date_from] if date_from else []),
                    *([date_expr <= date_to] if date_to else []),
                )
            )
        )
        matched_inv = await db.execute(
            select(func.count(TaxInvoice.id)).where(
                and_(
                    TaxInvoice.kind == kind,
                    TaxInvoice.linked_invoice_id.isnot(None),
                    *([date_expr >= date_from] if date_from else []),
                    *([date_expr <= date_to] if date_to else []),
                )
            )
        )
        out.append(
            TaxInvoiceSummaryOut(
                kind=kind,
                count=int(cnt),
                supply_amount=float(supply),
                tax_amount=float(tax),
                total_amount=float(tot),
                matched_customer_count=int(matched_cust.scalar_one()),
                matched_invoice_count=int(matched_inv.scalar_one()),
            )
        )
    return out


@router.get("/yearly-comparison", response_model=YearlyComparisonOut)
async def get_yearly_comparison(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
) -> YearlyComparisonOut:
    """올해(또는 지정 연도) 와 작년의 매입·매출 분기·월별 비교 (공급가액).

    written_date 기준 (`written_date` 누락 시 `issue_date` fallback) — TSV 적재와 동일.
    """
    today = date.today()
    cur_year = year or today.year
    prev_year = cur_year - 1

    # 한 번의 GROUP BY 로 4가지 시계열을 모두 채운다.
    # kind × year × quarter × month 단위로 집계.
    date_expr = func.coalesce(TaxInvoice.written_date, TaxInvoice.issue_date)
    year_expr = func.extract("year", date_expr).label("yr")
    q_expr = func.extract("quarter", date_expr).label("q")
    m_expr = func.extract("month", date_expr).label("m")

    rows = (
        await db.execute(
            select(
                TaxInvoice.kind,
                year_expr,
                q_expr,
                m_expr,
                func.coalesce(func.sum(TaxInvoice.supply_amount), 0).label("amt"),
            )
            .where(
                date_expr >= date(prev_year, 1, 1),
                date_expr < date(cur_year + 1, 1, 1),
            )
            .group_by(TaxInvoice.kind, year_expr, q_expr, m_expr)
        )
    ).all()

    # (kind, year, period) → amount 집계 dict.
    by_q: dict[tuple[str, int, int], float] = {}
    by_m: dict[tuple[str, int, int], float] = {}
    totals: dict[tuple[str, int], float] = {}
    for kind, yr, q, m, amt in rows:
        yr_i, q_i, m_i = int(yr), int(q), int(m)
        amt_f = float(amt)
        by_q[(kind, yr_i, q_i)] = by_q.get((kind, yr_i, q_i), 0.0) + amt_f
        by_m[(kind, yr_i, m_i)] = by_m.get((kind, yr_i, m_i), 0.0) + amt_f
        totals[(kind, yr_i)] = totals.get((kind, yr_i), 0.0) + amt_f

    def _q(kind: str, yr: int, q: int) -> float:
        return by_q.get((kind, yr, q), 0.0)

    def _m(kind: str, yr: int, m: int) -> float:
        return by_m.get((kind, yr, m), 0.0)

    quarters = [
        YearlyComparisonPeriod(
            period=q,
            sales_current=_q("SALES", cur_year, q),
            sales_prev=_q("SALES", prev_year, q),
            purchase_current=_q("PURCHASE", cur_year, q),
            purchase_prev=_q("PURCHASE", prev_year, q),
        )
        for q in range(1, 5)
    ]
    months = [
        YearlyComparisonPeriod(
            period=m,
            sales_current=_m("SALES", cur_year, m),
            sales_prev=_m("SALES", prev_year, m),
            purchase_current=_m("PURCHASE", cur_year, m),
            purchase_prev=_m("PURCHASE", prev_year, m),
        )
        for m in range(1, 13)
    ]

    sales_cur = totals.get(("SALES", cur_year), 0.0)
    purchase_cur = totals.get(("PURCHASE", cur_year), 0.0)
    logger.info(
        "매입/매출 현황 조회: year=%s (vs %s) sales=%s purchase=%s",
        cur_year, prev_year, sales_cur, purchase_cur,
    )
    return YearlyComparisonOut(
        year=cur_year,
        prev_year=prev_year,
        sales_current_total=sales_cur,
        sales_prev_total=totals.get(("SALES", prev_year), 0.0),
        purchase_current_total=purchase_cur,
        purchase_prev_total=totals.get(("PURCHASE", prev_year), 0.0),
        quarters=quarters,
        months=months,
    )


@router.get("/sales-customers-top", response_model=SalesCustomerTopOut)
async def get_sales_customers_top(
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 10,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
):
    """매출세금계산서 매출처 집계 — buyer_biz_no 기준 SUM(total_amount) 상위 N.

    기본 기간: 올해 1/1 ~ 오늘. 작성일(written_date, fallback issue_date) 기준.
    Null/빈 사업자번호는 하나의 "(미지정)" 버킷으로 집계.
    """
    today = date.today()
    if date_from is None:
        date_from = date(today.year, 1, 1)
    if date_to is None:
        date_to = today

    date_expr = func.coalesce(TaxInvoice.written_date, TaxInvoice.issue_date)
    base_where = (
        TaxInvoice.kind == "SALES",
        date_expr >= date_from,
        date_expr <= date_to,
    )

    total_amount = (
        await db.execute(
            select(func.coalesce(func.sum(TaxInvoice.total_amount), 0)).where(*base_where)
        )
    ).scalar_one()

    rows = (
        await db.execute(
            select(
                TaxInvoice.buyer_biz_no,
                func.max(TaxInvoice.buyer_name),
                func.sum(TaxInvoice.total_amount),
            )
            .where(*base_where)
            .group_by(TaxInvoice.buyer_biz_no)
            .order_by(func.sum(TaxInvoice.total_amount).desc())
            .limit(limit)
        )
    ).all()

    items = [
        SalesCustomerBucket(
            biz_no=biz or None,
            name=name or None,
            total_amount=float(amt or 0),
        )
        for biz, name, amt in rows
    ]
    return SalesCustomerTopOut(
        date_from=date_from,
        date_to=date_to,
        total_amount=float(total_amount or 0),
        items=items,
    )


# ---------------------------------------------------------------------------
# 단건 조회/수정
# ---------------------------------------------------------------------------


@router.get("/{inv_id}", response_model=TaxInvoiceOut)
async def get_tax_invoice(
    inv_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
) -> TaxInvoiceOut:
    row = (
        await db.execute(
            select(TaxInvoice)
            .options(selectinload(TaxInvoice.items))
            .where(TaxInvoice.id == inv_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="세금계산서를 찾을 수 없습니다.")
    out = _to_out(row)
    await _enrich_linked_names(db, [out])
    return out


@router.patch("/{inv_id}", response_model=TaxInvoiceOut)
async def patch_tax_invoice(
    inv_id: UUID,
    payload: TaxInvoicePatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tax_invoices.manage")),
) -> TaxInvoiceOut:
    row = (
        await db.execute(
            select(TaxInvoice)
            .options(selectinload(TaxInvoice.items))
            .where(TaxInvoice.id == inv_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="세금계산서를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row, attribute_names=["items"])
    logger.info(
        "세금계산서 수정: id=%s keys=%s 사용자=%s", row.id, list(data.keys()), user.id
    )
    out = _to_out(row)
    await _enrich_linked_names(db, [out])
    return out


@router.get("/{inv_id}/pdf")
async def download_pdf(
    inv_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
) -> FileResponse:
    row = (
        await db.execute(select(TaxInvoice).where(TaxInvoice.id == inv_id))
    ).scalar_one_or_none()
    if row is None or not row.pdf_path:
        raise HTTPException(status_code=404, detail="PDF 가 없습니다.")
    abs_path = resolve_upload_path(row.pdf_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 없습니다.")
    return FileResponse(
        str(abs_path),
        media_type="application/pdf",
        filename=f"{row.approval_no}.pdf",
    )


# ---------------------------------------------------------------------------
# 수집
# ---------------------------------------------------------------------------


@router.post("/fetch", response_model=list[TaxInvoiceFetchOut])
async def manual_fetch(
    req: TaxInvoiceFetchRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tax_invoices.manage")),
) -> list[TaxInvoiceFetchOut]:
    """수동 수집. 기본: "어제 ~ 지난 3일" daily fetch."""
    kinds = tuple(req.kinds or ["SALES", "PURCHASE"])
    records: list[TaxInvoiceFetch] = []

    # 호출자 tenant 의 tax_invoice 설정으로 provider 자격증명 결정.
    from app.core.config import get_tenant_section
    tcfg = await get_tenant_section(user.tenant_id, "tax_invoice")

    if req.date_from and req.date_to:
        # Period mode — 단일 호출 (daily 반복 대신)
        # TODO: provider.fetch_period 연동. 현재는 daily 로 기간 펼쳐서 호출.
        day = req.date_from
        while day <= req.date_to:
            records.extend(
                await fetch_and_upsert_daily(
                    db, target=day, kinds=kinds, triggered_by=user.id, cfg=tcfg,
                )
            )
            day += timedelta(days=1)
    else:
        target = req.date_target or (date.today() - timedelta(days=1))
        catchup = req.catchup_days if req.catchup_days is not None else 7
        for off in range(catchup):
            day = target - timedelta(days=off)
            records.extend(
                await fetch_and_upsert_daily(
                    db, target=day, kinds=kinds, triggered_by=user.id, cfg=tcfg,
                )
            )

    return [
        TaxInvoiceFetchOut(
            id=r.id,
            kind=r.kind,
            method=r.method,
            period_start=r.period_start,
            period_end=r.period_end,
            trigger_kind=r.trigger_kind,
            source=r.source,
            status=r.status,
            fetched_count=r.fetched_count,
            created_count=r.created_count,
            updated_count=r.updated_count,
            skipped_count=r.skipped_count,
            error_message=r.error_message,
            started_at=r.started_at,
            finished_at=r.finished_at,
        )
        for r in records
    ]


@router.post("/backfill-items", response_model=TaxInvoiceBackfillItemsOut)
async def backfill_items(
    limit: int = 500,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("tax_invoices.manage")),
) -> TaxInvoiceBackfillItemsOut:
    """`tax_invoice_items` 가 비어 있는 기존 row 를 detail API 호출로 채움.

    list API 만으로 수집되어 헤더만 있고 품목이 없는 row 가 운영 데이터에 다수
    존재 — 본 entry 로 일괄 보강. mgt_key 가 NULL 이면 skip. detail 호출 실패
    건은 errors 카운트.
    """
    from app.core.config import get_tenant_section
    tcfg = await get_tenant_section(user.tenant_id, "tax_invoice")
    result = await backfill_missing_items(db, limit=limit, cfg=tcfg)
    logger.info(
        "세금계산서 품목 백필: candidates=%d filled=%d skipped=%d errors=%d (호출자=%s)",
        result["candidates"], result["filled"], result["skipped"], result["errors"], user.id,
    )
    return TaxInvoiceBackfillItemsOut(**result)


@router.get("/fetches", response_model=list[TaxInvoiceFetchOut])
async def list_fetches(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("tax_invoices.read")),
) -> list[TaxInvoiceFetchOut]:
    limit = max(1, min(500, limit))
    rows = list(
        (
            await db.execute(
                select(TaxInvoiceFetch)
                .order_by(TaxInvoiceFetch.started_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    return [
        TaxInvoiceFetchOut(
            id=r.id,
            kind=r.kind,
            method=r.method,
            period_start=r.period_start,
            period_end=r.period_end,
            trigger_kind=r.trigger_kind,
            source=r.source,
            status=r.status,
            fetched_count=r.fetched_count,
            created_count=r.created_count,
            updated_count=r.updated_count,
            skipped_count=r.skipped_count,
            error_message=r.error_message,
            started_at=r.started_at,
            finished_at=r.finished_at,
        )
        for r in rows
    ]
