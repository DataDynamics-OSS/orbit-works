"""공급업체 중립 DTO + Provider 프로토콜.

바로빌 외 다른 업체(팝빌·비즈플레이)로 갈아탈 때 이 인터페이스만 맞추면 되도록
내부 데이터 모델을 vendor 중립으로 유지한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal, Protocol


@dataclass
class TaxInvoiceItemDTO:
    position: int = 0
    item_name: str | None = None
    spec: str | None = None
    quantity: Decimal | None = None
    unit_price: Decimal | None = None
    supply_amount: Decimal | None = None
    tax_amount: Decimal | None = None
    memo: str | None = None


@dataclass
class TaxInvoiceDTO:
    """공급업체 응답을 내부 중립 포맷으로 파싱한 단건."""

    # 'SALES' (매출) | 'PURCHASE' (매입)
    kind: Literal["SALES", "PURCHASE"]

    approval_no: str                        # 국세청 승인번호 (UNIQUE 키)
    issue_date: date
    written_date: date | None = None

    mgt_key: str | None = None              # 공급자 내부 식별자 (PDF 조회 시 필요)

    supplier_biz_no: str | None = None
    supplier_name: str | None = None
    supplier_ceo: str | None = None
    buyer_biz_no: str | None = None
    buyer_name: str | None = None
    buyer_ceo: str | None = None

    supply_amount: Decimal = Decimal(0)
    tax_amount: Decimal = Decimal(0)
    total_amount: Decimal = Decimal(0)

    tax_type: str | None = None             # TAX / NONTAX / ZERO
    issue_type: str | None = None           # NORMAL / MODIFIED
    status: str = "ISSUED"                  # ISSUED / CANCELED / MODIFIED

    external_id: str | None = None
    raw: dict | None = None                 # 원본 응답 (raw_payload 컬럼에 저장)

    items: list[TaxInvoiceItemDTO] = field(default_factory=list)


class TaxInvoiceProvider(Protocol):
    """세금계산서 공급업체 공통 인터페이스."""

    name: str

    @property
    def configured(self) -> bool:
        """필수 크레덴셜 (API 키/사업자번호 등) 이 모두 설정돼 있는지."""
        ...

    async def fetch_daily(
        self,
        kind: Literal["SALES", "PURCHASE"],
        target: date,
    ) -> list[TaxInvoiceDTO]:
        """특정 일자(target) 작성일자 기준 세금계산서 목록."""
        ...

    async def fetch_period(
        self,
        kind: Literal["SALES", "PURCHASE"],
        start: date,
        end: date,
    ) -> list[TaxInvoiceDTO]:
        """기간 범위 조회 (최대 제한은 공급자별 상이)."""
        ...

    async def download_pdf(
        self,
        kind: Literal["SALES", "PURCHASE"],
        mgt_key: str,
    ) -> bytes | None:
        """세금계산서 PDF 바이너리. 미지원/실패 시 None."""
        ...
