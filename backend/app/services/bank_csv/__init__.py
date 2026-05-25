"""은행 거래내역 CSV 파서 — plug-in 어댑터 registry.

신규 은행 추가:
    1. `app/services/bank_csv/<bank>.py` 파일 작성, BankCsvAdapter 상속
    2. 아래 `ADAPTERS` dict 에 추가
    3. UI 의 "현재 지원 은행" 안내가 자동으로 반영됨

호출 측 (라우터):
    from app.services.bank_csv import parse_bank_csv, list_supported_banks
    rows = parse_bank_csv(account.bank_name, blob)   # list[ParsedTransaction]
    [r.to_db_dict() for r in rows]                    # ORM/SQL insert 용 dict
"""

from __future__ import annotations

from .base import (
    BankCsvAdapter,
    CsvParseError,
    ParsedTransaction,
)
from .ibk import IbkAdapter

# 지원 은행 등록 — 키 = bank_accounts.bank_name 표시 문자열.
ADAPTERS: dict[str, BankCsvAdapter] = {
    IbkAdapter.bank_name: IbkAdapter(),
    # 신규 은행은 여기에 추가:
    # KbAdapter.bank_name: KbAdapter(),
    # ShinhanAdapter.bank_name: ShinhanAdapter(),
    # ...
}


def parse_bank_csv(bank_name: str, blob: bytes) -> list[ParsedTransaction]:
    """은행 이름 → 적절한 어댑터 dispatch. 미지원이면 CsvParseError."""
    adapter = ADAPTERS.get(bank_name)
    if adapter is None:
        raise CsvParseError(
            f"'{bank_name}' 은행은 아직 거래내역 CSV 자동 파싱을 지원하지 않습니다. "
            "(현재 지원: " + ", ".join(ADAPTERS.keys()) + ")"
        )
    return adapter.parse(blob)


def list_supported_banks() -> list[str]:
    """UI 안내·자동 완성용. 가나다 정렬."""
    return sorted(ADAPTERS.keys())


def get_adapter(bank_name: str) -> BankCsvAdapter | None:
    return ADAPTERS.get(bank_name)


__all__ = [
    "BankCsvAdapter",
    "CsvParseError",
    "ParsedTransaction",
    "ADAPTERS",
    "parse_bank_csv",
    "list_supported_banks",
    "get_adapter",
]
