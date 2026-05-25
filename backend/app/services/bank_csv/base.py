"""은행 CSV 어댑터 base — ABC + 공통 데이터 구조 + 인코딩/숫자 유틸.

새 은행 어댑터를 추가하려면:
    1. `app/services/bank_csv/<bank>.py` 작성, `BankCsvAdapter` 상속
    2. `parse(blob: bytes) → list[ParsedTransaction]` 구현
    3. `__init__.py` 의 `ADAPTERS` 에 인스턴스 추가
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field, fields
from datetime import datetime
from decimal import Decimal, InvalidOperation


class CsvParseError(Exception):
    """파싱 실패 — 사용자에게 메시지 그대로 노출."""


@dataclass
class ParsedTransaction:
    """은행 무관 정규화된 거래 row.

    어댑터의 출력 형식. 모든 어댑터는 자기 은행의 raw 컬럼을 이 모양으로 매핑.
    `to_db_dict()` 로 ORM/SQL insert 에 그대로 사용 가능.
    """

    tx_at: datetime
    withdrawal: Decimal = Decimal(0)
    deposit: Decimal = Decimal(0)
    balance_after: Decimal = Decimal(0)
    description: str | None = None
    counterparty_account: str | None = None
    counterparty_bank: str | None = None
    counterparty_holder: str | None = None
    memo: str | None = None
    tx_type: str | None = None
    check_amount: Decimal = Decimal(0)
    cms_code: str | None = None

    def to_db_dict(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self)}


class BankCsvAdapter(abc.ABC):
    """모든 은행 어댑터의 공통 인터페이스.

    하위 클래스 필수 정의:
        bank_name : 표시 이름 (`bank_accounts.bank_name` 매칭)
        parse()   : bytes → list[ParsedTransaction]

    선택:
        accepted_extensions : UI 가 허용 파일 확장자 안내에 사용
        instructions        : 사용자가 어디서 어떻게 다운받는지 한 줄 안내
    """

    bank_name: str = ""
    accepted_extensions: tuple[str, ...] = (".csv", ".txt")
    instructions: str = ""

    @abc.abstractmethod
    def parse(self, blob: bytes) -> list[ParsedTransaction]: ...


# ---------------------------------------------------------------------------
# 공통 유틸 — 어댑터에서 재사용
# ---------------------------------------------------------------------------


def decode_blob(blob: bytes) -> str:
    """은행 CSV 인코딩 자동 감지 — UTF-8 BOM → UTF-8 → CP949 → EUC-KR 순."""
    if blob.startswith(b"\xef\xbb\xbf"):
        return blob[3:].decode("utf-8")
    for enc in ("utf-8", "cp949", "euc-kr"):
        try:
            return blob.decode(enc)
        except UnicodeDecodeError:
            continue
    raise CsvParseError(
        "CSV 인코딩을 인식할 수 없습니다 (UTF-8/CP949/EUC-KR 시도 실패)."
    )


def to_decimal(s: str | None) -> Decimal:
    """콤마 포함 한글 표기 숫자 → Decimal. 빈 값/None 은 0."""
    if not s or not s.strip():
        return Decimal(0)
    try:
        return Decimal(s.replace(",", "").strip())
    except InvalidOperation as exc:
        raise CsvParseError(f"숫자 파싱 실패: {s!r}") from exc


def none_if_blank(s: str | None) -> str | None:
    if s is None:
        return None
    s = s.strip()
    return s or None
