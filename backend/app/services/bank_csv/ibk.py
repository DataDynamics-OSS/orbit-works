"""기업은행 (IBK) 거래내역 CSV 어댑터.

포맷 (`텍스트파일저장` 형식):
    |거래일시|출금|입금|거래후 잔액|거래내용|상대계좌번호|상대은행|메모|거래구분|수표어음금액|CMS코드|상대계좌예금주명
    1|2026-03-31 10:29:47|4,137,100|0|1,778,655,614|지방세납부||||인터넷|0||
    2|...

특이사항:
- 첫 컬럼은 의미 없는 row 번호 — 무시.
- 마지막에 `|합계|...` 행이 붙으면 break (이후 무시).
- 본문에 `|` 가 포함되면 split 으로 깨질 수 있음 — 보수적으로 raise.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from .base import (
    BankCsvAdapter,
    CsvParseError,
    ParsedTransaction,
    decode_blob,
    none_if_blank,
    to_decimal,
)

KST = ZoneInfo("Asia/Seoul")

# row_no 자리는 빈 칸으로 헤더에 등장.
HEADER_FIELDS = [
    "",
    "거래일시",
    "출금",
    "입금",
    "거래후 잔액",
    "거래내용",
    "상대계좌번호",
    "상대은행",
    "메모",
    "거래구분",
    "수표어음금액",
    "CMS코드",
    "상대계좌예금주명",
]


class IbkAdapter(BankCsvAdapter):
    bank_name = "기업은행"
    accepted_extensions = (".csv", ".txt")
    instructions = (
        "거래내역은 기업은행에 로그인하여 거래내역을 조회한 후 "
        "'텍스트파일저장'으로 저장하십시오."
    )

    def parse(self, blob: bytes) -> list[ParsedTransaction]:
        text = decode_blob(blob)
        raw_lines = [
            ln
            for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
            if ln.strip()
        ]
        if not raw_lines:
            raise CsvParseError("빈 파일입니다.")

        header = raw_lines[0].split("|")
        if [h.strip() for h in header] != HEADER_FIELDS:
            raise CsvParseError(
                "기업은행 CSV 헤더 형식이 예상과 다릅니다. "
                f"(예상 {len(HEADER_FIELDS)} 컬럼, 실제 {len(header)} 컬럼)"
            )

        rows: list[ParsedTransaction] = []
        for idx, line in enumerate(raw_lines[1:], start=2):
            cols = line.split("|")
            if len(cols) < 13:
                cols = cols + [""] * (13 - len(cols))
            elif len(cols) > 13:
                raise CsvParseError(
                    f"라인 {idx} 의 컬럼 수가 13보다 많습니다 ({len(cols)}). "
                    "본문에 '|' 가 포함된 것으로 추정."
                )

            tx_at_str = cols[1].strip()
            # 합계 row — IBK CSV 마지막에 붙는 totals 라인. 무시하고 종료.
            if tx_at_str == "합계":
                break
            try:
                tx_at = datetime.strptime(
                    tx_at_str, "%Y-%m-%d %H:%M:%S"
                ).replace(tzinfo=KST)
            except ValueError as exc:
                raise CsvParseError(
                    f"라인 {idx} 거래일시 파싱 실패: {cols[1]!r}"
                ) from exc

            rows.append(
                ParsedTransaction(
                    tx_at=tx_at,
                    withdrawal=to_decimal(cols[2]),
                    deposit=to_decimal(cols[3]),
                    balance_after=to_decimal(cols[4]),
                    description=none_if_blank(cols[5]),
                    counterparty_account=none_if_blank(cols[6]),
                    counterparty_bank=none_if_blank(cols[7]),
                    memo=none_if_blank(cols[8]),
                    tx_type=none_if_blank(cols[9]),
                    check_amount=to_decimal(cols[10]),
                    cms_code=none_if_blank(cols[11]),
                    counterparty_holder=none_if_blank(cols[12]),
                )
            )
        return rows
