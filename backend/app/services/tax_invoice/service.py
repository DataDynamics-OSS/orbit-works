"""세금계산서 수집/저장 오케스트레이션.

기능:
- `get_provider()` — 현재 설정에 맞는 Provider 인스턴스 반환 (app_settings.tax_invoice).
- `upsert_tax_invoices(dtos)` — approval_no 기반 idempotent upsert + 아이템 재생성.
- `download_missing_pdfs(dtos)` — PDF 미보유건 다운로드 → data/tax_invoices/YYYY/MM/.
- `fetch_and_upsert_daily(kind, target)` — Provider 호출 + upsert + PDF + 이력 기록.

Fetch 이력 (tax_invoice_fetches) 은 성공/실패 모두 남겨 UI 의 "수집 이력" 리스트에
쓰고, 스케줄러는 실패 시 Slack 알림을 띄우게 한다 (scheduler 쪽에서 처리).
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import TaxInvoice, TaxInvoiceFetch, TaxInvoiceItem
from app.services.tax_invoice.barobill import BarobillProvider, synthesize_items_from_raw
from app.services.tax_invoice.provider import TaxInvoiceDTO, TaxInvoiceProvider

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider factory
# ---------------------------------------------------------------------------


def _global_tax_invoice_settings() -> dict:
    """app_settings.tax_invoice (글로벌 row, tenant_id IS NULL) 머지된 값.

    하위호환용 — 단일테넌트 시절 코드가 `cfg` 인자 없이 호출하던 자리에서만 사용.
    멀티테넌트 흐름에서는 호출자가 `get_tenant_section(tenant_id, "tax_invoice")`
    로 명시적으로 가져와 `get_provider(cfg=...)` 에 넘겨야 한다.
    """
    from app.core.config import _db_overrides  # noqa: WPS433

    return _db_overrides.get("tax_invoice", {}) or {}


def get_provider(cfg: dict | None = None) -> TaxInvoiceProvider:
    """주어진 cfg dict 로 바로빌 provider 인스턴스 생성. 크레덴셜 없으면 configured=False.

    cfg=None 이면 글로벌 설정 fallback (단일테넌트/하위호환). 멀티테넌트 호출자는
    `get_tenant_section(tenant_id, "tax_invoice")` 결과를 직접 넘긴다.
    """
    if cfg is None:
        cfg = _global_tax_invoice_settings()
    return BarobillProvider(
        certkey=cfg.get("certkey", ""),
        corpnum=cfg.get("corpnum", ""),
        user_id=cfg.get("user_id", ""),
        environment=cfg.get("environment", "production"),
    )


# ---------------------------------------------------------------------------
# upsert
# ---------------------------------------------------------------------------


def _to_decimal(v) -> Decimal:
    if v is None:
        return Decimal(0)
    if isinstance(v, Decimal):
        return v
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal(0)


async def upsert_tax_invoices(
    db: AsyncSession,
    dtos: list[TaxInvoiceDTO],
) -> tuple[int, int, int]:
    """DTO 리스트를 `approval_no` 기준 upsert. (created, updated, skipped) 반환.

    - 신규 → INSERT + items 생성
    - 기존 + total 등 다르면 → UPDATE + items 전량 재생성 (간단화)
    - 기존 + 동일 → skipped (변경 없이 pass)
    """
    created = updated = skipped = 0
    for dto in dtos:
        existing = (
            await db.execute(
                select(TaxInvoice)
                .options(selectinload(TaxInvoice.items))
                .where(TaxInvoice.approval_no == dto.approval_no)
            )
        ).scalar_one_or_none()

        if existing is None:
            row = TaxInvoice(
                kind=dto.kind,
                status=dto.status or "ISSUED",
                approval_no=dto.approval_no,
                mgt_key=dto.mgt_key,
                issue_date=dto.issue_date,
                written_date=dto.written_date,
                supplier_biz_no=dto.supplier_biz_no,
                supplier_name=dto.supplier_name,
                supplier_ceo=dto.supplier_ceo,
                buyer_biz_no=dto.buyer_biz_no,
                buyer_name=dto.buyer_name,
                buyer_ceo=dto.buyer_ceo,
                supply_amount=_to_decimal(dto.supply_amount),
                tax_amount=_to_decimal(dto.tax_amount),
                total_amount=_to_decimal(dto.total_amount),
                tax_type=dto.tax_type,
                issue_type=dto.issue_type,
                source="barobill",
                external_id=dto.external_id,
                raw_payload=dto.raw,
            )
            for it in dto.items:
                row.items.append(
                    TaxInvoiceItem(
                        position=it.position,
                        item_name=it.item_name,
                        spec=it.spec,
                        quantity=_to_decimal(it.quantity) if it.quantity is not None else None,
                        unit_price=_to_decimal(it.unit_price) if it.unit_price is not None else None,
                        supply_amount=_to_decimal(it.supply_amount) if it.supply_amount is not None else None,
                        tax_amount=_to_decimal(it.tax_amount) if it.tax_amount is not None else None,
                        memo=it.memo,
                    )
                )
            db.add(row)
            created += 1
            continue

        # 기존: 주요 금액·상태 비교로 변경 감지 (approval_no 는 UNIQUE 라 동일)
        header_changed = (
            existing.status != (dto.status or "ISSUED")
            or existing.total_amount != _to_decimal(dto.total_amount)
            or existing.supply_amount != _to_decimal(dto.supply_amount)
            or existing.tax_amount != _to_decimal(dto.tax_amount)
            or existing.issue_type != dto.issue_type
        )
        # 헤더는 그대로지만 기존 row 의 items 가 비어있고 DTO 가 items 를
        # 가져왔다면 items 만 채워준다 (detail API 추가 후 첫 재수집·백필).
        items_fillable = len(existing.items) == 0 and len(dto.items) > 0

        if not header_changed and not items_fillable:
            skipped += 1
            continue

        if header_changed:
            existing.status = dto.status or "ISSUED"
            existing.supply_amount = _to_decimal(dto.supply_amount)
            existing.tax_amount = _to_decimal(dto.tax_amount)
            existing.total_amount = _to_decimal(dto.total_amount)
            existing.issue_type = dto.issue_type
            existing.raw_payload = dto.raw

        # items 전량 재생성 — 간단화. 실무상 세금계산서 수정은 드뭄.
        # items_fillable 케이스는 헤더 변경 없이 items 만 새로 들어옴.
        if header_changed or items_fillable:
            existing.items.clear()
            await db.flush()
            for it in dto.items:
                existing.items.append(
                    TaxInvoiceItem(
                        position=it.position,
                        item_name=it.item_name,
                        spec=it.spec,
                        quantity=_to_decimal(it.quantity) if it.quantity is not None else None,
                        unit_price=_to_decimal(it.unit_price) if it.unit_price is not None else None,
                        supply_amount=_to_decimal(it.supply_amount) if it.supply_amount is not None else None,
                        tax_amount=_to_decimal(it.tax_amount) if it.tax_amount is not None else None,
                        memo=it.memo,
                    )
                )
        updated += 1

    await db.commit()
    return created, updated, skipped


# ---------------------------------------------------------------------------
# PDF 다운로드
# ---------------------------------------------------------------------------


async def download_missing_pdfs(
    db: AsyncSession,
    *,
    cfg: dict | None = None,
    max_files: int = 100,
) -> int:
    """pdf_path NULL 인 tax_invoices 를 가져와 provider 로부터 PDF 다운로드.

    한번에 최대 max_files 건만 처리 (스케줄러 1회 실행 상한). 실패 건은 다음
    실행 시 재시도 (pdf_path 는 계속 NULL 이므로).

    cfg 미지정 시 글로벌 설정 fallback. 멀티테넌트 호출자는 그 tenant 의 cfg 를
    명시적으로 넘겨 자기 자격증명으로 다운로드.
    """
    provider = get_provider(cfg)
    if not provider.configured:
        return 0

    rows = list(
        (
            await db.execute(
                select(TaxInvoice)
                .where(TaxInvoice.pdf_path.is_(None), TaxInvoice.mgt_key.isnot(None))
                .order_by(TaxInvoice.issue_date.desc())
                .limit(max_files)
            )
        ).scalars()
    )
    if not rows:
        return 0

    downloaded = 0
    for row in rows:
        try:
            pdf_bytes = await provider.download_pdf(row.kind, row.mgt_key or "")  # type: ignore[arg-type]
        except Exception as exc:
            logger.warning("PDF 다운로드 예외: %s — %s", row.approval_no, exc)
            continue
        if not pdf_bytes:
            continue
        # 저장 경로: data/tax_invoices/YYYY/MM/<approval_no>.pdf
        rel_dir = Path("tax_invoices") / f"{row.issue_date:%Y}" / f"{row.issue_date:%m}"
        abs_dir = Path(get_settings().upload.dir) / rel_dir
        abs_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{row.approval_no}.pdf"
        abs_path = abs_dir / filename
        try:
            abs_path.write_bytes(pdf_bytes)
        except OSError as exc:
            logger.warning("PDF 저장 실패: %s — %s", row.approval_no, exc)
            continue
        row.pdf_path = str(rel_dir / filename)
        downloaded += 1
    await db.commit()
    logger.info("PDF 수집: %d/%d", downloaded, len(rows))
    return downloaded


# ---------------------------------------------------------------------------
# 메인 entry — 스케줄러/수동 호출 모두 이 함수를 사용
# ---------------------------------------------------------------------------


async def fetch_and_upsert_daily(
    db: AsyncSession,
    *,
    target: date,
    kinds: tuple[Literal["SALES", "PURCHASE"], ...] = ("SALES", "PURCHASE"),
    triggered_by: UUID | None = None,
    trigger_kind: str = "MANUAL",
    cfg: dict | None = None,
) -> list[TaxInvoiceFetch]:
    """target 일자의 매출·매입 세금계산서를 가져와 upsert + PDF 저장 + 이력 기록.

    각 kind 별로 별도 `TaxInvoiceFetch` row 가 생성된다. 크레덴셜 미설정이면
    status='SKIPPED' 로 기록 후 다음 kind 로 넘어간다.

    cfg 는 tenant 의 tax_invoice 설정 dict — provider 자격증명·옵션이 들어 있다.
    None 이면 글로벌 설정 fallback (단일테넌트/하위호환).
    """
    provider = get_provider(cfg)
    records: list[TaxInvoiceFetch] = []

    for kind in kinds:
        rec = TaxInvoiceFetch(
            kind=kind,
            method="DAILY",
            period_start=target,
            period_end=target,
            trigger_kind=trigger_kind,
            source="barobill",
            triggered_by=triggered_by,
            started_at=datetime.now(timezone.utc),
        )
        if not provider.configured:
            rec.status = "SKIPPED"
            rec.error_message = "바로빌 크레덴셜이 설정되지 않았습니다."
            rec.finished_at = datetime.now(timezone.utc)
            db.add(rec)
            await db.commit()
            records.append(rec)
            logger.info("세금계산서 수집 스킵 (creds 없음): kind=%s date=%s", kind, target)
            continue
        try:
            dtos = await provider.fetch_daily(kind, target)
            created, updated, skipped = await upsert_tax_invoices(db, dtos)
            rec.fetched_count = len(dtos)
            rec.created_count = created
            rec.updated_count = updated
            rec.skipped_count = skipped
            rec.status = "SUCCESS"
            logger.info(
                "세금계산서 수집 완료: kind=%s date=%s fetched=%d created=%d updated=%d skipped=%d",
                kind, target, len(dtos), created, updated, skipped,
            )
        except Exception as exc:
            rec.status = "FAILED"
            rec.error_message = f"{type(exc).__name__}: {exc}"[:4000]
            logger.exception("세금계산서 수집 실패: kind=%s date=%s", kind, target)
        rec.finished_at = datetime.now(timezone.utc)
        db.add(rec)
        await db.commit()
        records.append(rec)

    # 2. PDF 보조 수집 (설정된 경우만)
    pdf_cfg = cfg if cfg is not None else _global_tax_invoice_settings()
    if pdf_cfg.get("download_pdf", True):
        try:
            await download_missing_pdfs(db, cfg=cfg)
        except Exception:
            logger.exception("PDF 수집 실패 (전체 건 중)")

    return records


# ---------------------------------------------------------------------------
# 백필 — 기존 row 의 빈 items 채우기
# ---------------------------------------------------------------------------


async def backfill_missing_items(
    db: AsyncSession,
    *,
    limit: int = 500,
    cfg: dict | None = None,
) -> dict[str, int]:
    """items 가 비어있는 tax_invoices 를 골라 detail API 로 품목 채움.

    list-API 시절 수집된 row (헤더만 있고 품목 없음) 보강용. 한 번에 최대 limit
    건 처리. mgt_key 누락 / detail 응답 비어있음은 skipped, SOAP 실패는 errors.
    반환: {candidates, filled, skipped, errors}.
    """
    from app.models import TaxInvoiceItem as _Item  # noqa: WPS433

    provider = get_provider(cfg)
    if not provider.configured:
        return {"candidates": 0, "filled": 0, "skipped": 0, "errors": 0}

    # items 가 한 건도 없는 row 만 → LEFT JOIN + COUNT IS NULL 패턴 (subquery 로 단순화).
    sub = (
        select(_Item.tax_invoice_id)
        .group_by(_Item.tax_invoice_id)
    ).subquery()
    rows = list(
        (
            await db.execute(
                select(TaxInvoice)
                .where(~TaxInvoice.id.in_(select(sub.c.tax_invoice_id)))
                .order_by(TaxInvoice.issue_date.desc())
                .limit(limit)
            )
        ).scalars()
    )
    candidates = len(rows)
    filled = skipped = errors = 0
    # 어떤 source 로 채워졌는지 분리 추적 — 운영 시 detail 가능률 파악용.
    filled_via_detail = 0
    filled_via_fallback = 0
    logger.info("세금계산서 품목 백필 시작: candidates=%d limit=%d", candidates, limit)

    for row in rows:
        mgt_key = row.mgt_key or row.approval_no
        items = []
        via_detail = False
        if mgt_key:
            try:
                items = await provider.fetch_detail(row.kind, mgt_key)  # type: ignore[arg-type]
                if items:
                    via_detail = True
            except Exception as exc:
                logger.warning(
                    "백필 detail 실패: approval_no=%s mgt_key=%s err=%s",
                    row.approval_no, mgt_key, exc,
                )
                errors += 1
                continue
        # detail API 가 빈 응답 (자사 MgtNum 부재 등) 이면 list-API 시절 저장된
        # raw_payload 의 ItemName 으로 1줄 합성해 폴백.
        if not items:
            items = synthesize_items_from_raw(row.raw_payload)
        if not items:
            logger.debug(
                "백필 스킵 — detail·fallback 모두 빈 응답: approval_no=%s",
                row.approval_no,
            )
            skipped += 1
            continue
        for it in items:
            db.add(
                TaxInvoiceItem(
                    tax_invoice_id=row.id,
                    tenant_id=row.tenant_id,
                    position=it.position,
                    item_name=it.item_name,
                    spec=it.spec,
                    quantity=_to_decimal(it.quantity) if it.quantity is not None else None,
                    unit_price=_to_decimal(it.unit_price) if it.unit_price is not None else None,
                    supply_amount=_to_decimal(it.supply_amount) if it.supply_amount is not None else None,
                    tax_amount=_to_decimal(it.tax_amount) if it.tax_amount is not None else None,
                    memo=it.memo,
                )
            )
        filled += 1
        if via_detail:
            filled_via_detail += 1
        else:
            filled_via_fallback += 1

    await db.commit()
    logger.info(
        "세금계산서 품목 백필 완료: candidates=%d filled=%d "
        "(detail=%d fallback=%d) skipped=%d errors=%d",
        candidates, filled, filled_via_detail, filled_via_fallback, skipped, errors,
    )
    return {
        "candidates": candidates,
        "filled": filled,
        "skipped": skipped,
        "errors": errors,
    }
