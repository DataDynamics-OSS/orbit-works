"""견적서 / 청구서 공통 로직 — 번호 발번, 금액 계산, 스냅샷 생성."""

from __future__ import annotations

import secrets
from datetime import date
from decimal import Decimal
from typing import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Customer, Invoice, Quote, Tenant


_HUN = Decimal("100")
_Q2 = Decimal("0.01")


# ---------------------------------------------------------------------------
# Numbering — PREFIX{Q|I}-YYYYMMDD-XXXX (4자 Crockford base32 랜덤)
# 중앙 시퀀스가 아니라 날짜+랜덤이라 advisory lock 불필요.
# UNIQUE 제약으로 충돌을 감지하고 최대 5회 재시도.
# ---------------------------------------------------------------------------


# Crockford base32 — 혼동 문자 I, L, O, U 제외.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _rand_suffix(length: int = 4) -> str:
    return "".join(_ALPHABET[secrets.randbelow(32)] for _ in range(length))


async def _get_prefix(db: AsyncSession) -> str:
    # RLS 가 현재 tenant 1행만 노출. SUPER_ADMIN/익명은 비어 있을 수 있어 "DD" fallback.
    t = (await db.execute(select(Tenant).limit(1))).scalar_one_or_none()
    return (t.number_prefix if t and t.number_prefix else "DD").strip() or "DD"


async def _generate_number(
    db: AsyncSession,
    *,
    kind_letter: str,
    issue_date: date,
    model,
) -> str:
    """PREFIX{K}-YYYYMMDD-XXXX 를 UNIQUE 보장까지 포함해서 발번."""
    prefix = await _get_prefix(db)
    ts = issue_date.strftime("%Y%m%d")
    base = f"{prefix}{kind_letter}-{ts}-"
    for _attempt in range(5):
        candidate = f"{base}{_rand_suffix(4)}"
        existing = await db.execute(
            select(model.id).where(model.number == candidate).limit(1)
        )
        if existing.scalar_one_or_none() is None:
            return candidate
    # 5회 모두 충돌 (확률 ~0) 이면 5자리로 늘려 재시도.
    for _attempt in range(5):
        candidate = f"{base}{_rand_suffix(5)}"
        existing = await db.execute(
            select(model.id).where(model.number == candidate).limit(1)
        )
        if existing.scalar_one_or_none() is None:
            return candidate
    raise RuntimeError("번호 발번에 실패했습니다 (충돌 반복).")


async def next_quote_number(
    db: AsyncSession, year: int, *, issue_date: date | None = None
) -> tuple[str, int | None]:
    """반환값: (number, seq). 신규 포맷은 seq=None."""
    d = issue_date or date.today()
    number = await _generate_number(db, kind_letter="Q", issue_date=d, model=Quote)
    return number, None


async def next_invoice_number(
    db: AsyncSession, year: int, *, issue_date: date | None = None
) -> tuple[str, int | None]:
    d = issue_date or date.today()
    number = await _generate_number(db, kind_letter="I", issue_date=d, model=Invoice)
    return number, None


# ---------------------------------------------------------------------------
# 계산
# ---------------------------------------------------------------------------


def compute_line(
    *,
    quantity: Decimal,
    unit_price: Decimal,
    discount_rate: Decimal,
    years: Decimal | int | str | None = 1,
) -> tuple[Decimal, Decimal, Decimal]:
    q = Decimal(quantity or 0)
    u = Decimal(unit_price or 0)
    d = Decimal(discount_rate or 0)
    y = Decimal(years or 1)
    # years 는 최소 1 로 보정 (음수·0 입력 방어).
    if y < 1:
        y = Decimal(1)
    subtotal = (q * u * y).quantize(_Q2)
    discount = (subtotal * d / _HUN).quantize(_Q2)
    total = (subtotal - discount).quantize(_Q2)
    return subtotal, discount, total


def compute_totals(
    *, items: Iterable[tuple[Decimal, Decimal, Decimal]],
    tax_mode: str,
    tax_rate: Decimal,
) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """Return (subtotal, discount_total, tax_amount, total_amount) — 모두 KRW quantize."""
    subtotal = Decimal(0)
    discount_total = Decimal(0)
    for ls, ld, _lt in items:
        subtotal += ls
        discount_total += ld
    taxable = subtotal - discount_total
    rate = Decimal(tax_rate or 0)
    if tax_mode == "INCLUSIVE":
        # 포함: 총액 = taxable, 세액 = taxable * rate / (100 + rate)
        denom = _HUN + rate
        tax_amount = (taxable * rate / denom).quantize(_Q2) if denom > 0 else Decimal(0)
        total_amount = taxable.quantize(_Q2)
    else:  # EXCLUSIVE (default). tax_rate=0 → 영세율, 여전히 세액 0 으로 표시.
        tax_amount = (taxable * rate / _HUN).quantize(_Q2)
        total_amount = (taxable + tax_amount).quantize(_Q2)
    return subtotal.quantize(_Q2), discount_total.quantize(_Q2), tax_amount, total_amount


# ---------------------------------------------------------------------------
# 스냅샷
# ---------------------------------------------------------------------------


async def snapshot_customer(db: AsyncSession, customer_id: UUID | None) -> dict | None:
    """발행 시점의 고객사 정보를 JSON 으로 동결. 나중에 고객사 정보가 바뀌어도
    이미 발행된 견적서/청구서의 PDF 재생성은 당시 값으로 고정돼야 하기 때문."""
    if not customer_id:
        return None
    c = (await db.execute(select(Customer).where(Customer.id == customer_id))).scalar_one_or_none()
    if not c:
        return None
    return {
        "id": str(c.id),
        "name": c.name,
        "business_no": c.business_no,
        "representative": c.representative,
        "address": c.address,
        "is_overseas": bool(c.is_overseas),
    }


async def snapshot_issuer(db: AsyncSession) -> dict | None:
    """발행 시점의 자사(발행자) 프로필을 한글/영문 필드까지 포함해 동결."""
    # RLS 가 현재 tenant 1행만 SELECT 허용.
    t = (await db.execute(select(Tenant).limit(1))).scalar_one_or_none()
    if not t:
        return None
    return {
        # 한글
        "name": t.name,
        "business_no": t.business_no,
        "representative": t.representative,
        "address": t.address,
        "phone": t.phone,
        "fax": t.fax,
        "email": t.contact_email,  # tenant.contact_email ↔ legacy 'email'
        "bank_name": t.bank_name,
        "bank_account": t.bank_account,
        "bank_holder": t.bank_holder,
        # 영문 (Invoice PDF 에서 우선 사용)
        "name_en": t.name_en,
        "representative_en": t.representative_en,
        "address_en": t.address_en,
        "bank_name_en": t.bank_name_en,
        "bank_holder_en": t.bank_holder_en,
    }


# ---------------------------------------------------------------------------
# 스마트 기본값 — 통화·해외법인 조합으로 tax_rate 추천
# ---------------------------------------------------------------------------


async def suggest_tax_rate(
    db: AsyncSession, *, currency: str, customer_id: UUID | None
) -> Decimal:
    if currency == "USD":
        if customer_id:
            c = (
                await db.execute(select(Customer).where(Customer.id == customer_id))
            ).scalar_one_or_none()
            if c and c.is_overseas:
                return Decimal("0")  # 영세율
    return Decimal("10")
