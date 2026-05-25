"""전자세금계산서 수집·관리 서비스.

- `provider.py`: 공급업체 중립 DTO + Provider protocol
- `barobill.py`: 바로빌 SOAP 구현 (기본)
- `service.py`: upsert / PDF 다운로드 / fetch 이력 기록
"""

from app.services.tax_invoice.provider import (
    TaxInvoiceDTO,
    TaxInvoiceItemDTO,
    TaxInvoiceProvider,
)
from app.services.tax_invoice.barobill import BarobillProvider
from app.services.tax_invoice.service import (
    fetch_and_upsert_daily,
    upsert_tax_invoices,
    download_missing_pdfs,
    get_provider,
)

__all__ = [
    "TaxInvoiceDTO",
    "TaxInvoiceItemDTO",
    "TaxInvoiceProvider",
    "BarobillProvider",
    "fetch_and_upsert_daily",
    "upsert_tax_invoices",
    "download_missing_pdfs",
    "get_provider",
]
