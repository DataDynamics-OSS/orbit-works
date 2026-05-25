"""바로빌(BaroBill) 세금계산서 Provider 구현.

공식 엔드포인트 (SOAP ASMX):
- 운영:  https://ws.baroservice.com/TI.asmx
- 테스트: https://testws.baroservice.com/TI.asmx

사용 함수 (WSDL 확인 완료):
- `GetDailyTaxInvoiceSalesList`     매출 — 일자 단건 (BaseDate, CountPerPage/CurrentPage)
- `GetDailyTaxInvoicePurchaseList`  매입 — 일자 단건
- `GetPeriodTaxInvoiceSalesList`    매출 — 기간 (StartDate/EndDate)
- `GetPeriodTaxInvoicePurchaseList` 매입 — 기간
- `GetTaxInvoice`                   단건 상세 (MgtNumType + MgtNum) — 품목라인 포함
- `GetTaxInvoicePDFURL`             PDF 다운로드 URL 획득

공통 요청 파라미터:
- CERTKEY · CorpNum · UserID (자사 크레덴셜, app_settings.tax_invoice)
- TaxType   : 1=정발행 · 2=역발행 · 3=위수탁 — 전부 조회해 합산
- DateType  : 1=작성일자 · 2=전송일자 · 3=국세청 승인일자 (우리는 작성일자 기준=1)
- CountPerPage / CurrentPage : 페이징

응답 구조 `SimpleTaxInvoiceExList` → `SimpleTaxInvoiceEx[]` 를 DTO 에 매핑.
에러는 응답 envelope 내부의 `CurrentPage` 필드가 음수 (-1xxxx 대) 로 반환됨.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Iterable, Literal
from xml.etree import ElementTree as ET

import httpx

from app.services.tax_invoice.provider import TaxInvoiceDTO, TaxInvoiceItemDTO

logger = logging.getLogger(__name__)


_SALES_FN = {
    "daily": "GetDailyTaxInvoiceSalesList",
    "period": "GetPeriodTaxInvoiceSalesList",
}
_PURCHASE_FN = {
    "daily": "GetDailyTaxInvoicePurchaseList",
    "period": "GetPeriodTaxInvoicePurchaseList",
}

_PRODUCTION_URL = "https://ws.baroservice.com/TI.asmx"
_TEST_URL = "https://testws.baroservice.com/TI.asmx"

_NS = "http://ws.baroservice.com/"
# 응답 파싱용 namespace map. SOAP envelope 과 서비스 namespace 둘 다 필요.
_NSMAP = {
    "soap": "http://schemas.xmlsoap.org/soap/envelope/",
    "b": _NS,
}

# 매 호출마다 모든 TaxType(1/2/3) 순회 — 2=역발행·3=위수탁 데이터 누락 방지.
_TAX_TYPES: tuple[int, ...] = (1, 2, 3)
# DateType=1 = 작성일자 (세금계산서 issueDate 와 의미상 일치).
_DATE_TYPE = 1
# Barobill 페이지당 최대값은 공식적으로 1000 근방 — 100 이면 안전하게 여러 페이지 순회.
_PAGE_SIZE = 100


class BarobillProvider:
    """바로빌 세금계산서 API wrapper."""

    name = "barobill"

    def __init__(
        self,
        *,
        certkey: str = "",
        corpnum: str = "",
        user_id: str = "",
        environment: str = "production",  # 'production' | 'test'
    ) -> None:
        self.certkey = (certkey or "").strip()
        # 하이픈이 포함된 사업자번호는 Barobill 가 허용하지 않는 경우가 있어 숫자만.
        self.corpnum = re.sub(r"\D", "", (corpnum or ""))
        self.user_id = (user_id or "").strip()
        self.base_url = (
            _PRODUCTION_URL if environment != "test" else _TEST_URL
        )

    @property
    def configured(self) -> bool:
        return bool(self.certkey and self.corpnum and self.user_id)

    async def fetch_daily(
        self,
        kind: Literal["SALES", "PURCHASE"],
        target: date,
    ) -> list[TaxInvoiceDTO]:
        if not self.configured:
            logger.info("BarobillProvider: 크레덴셜 미설정 — fetch_daily 스킵")
            return []
        fn_name = (_SALES_FN if kind == "SALES" else _PURCHASE_FN)["daily"]
        dtos = await self._call_list_api(fn_name, kind, date_from=target, date_to=target)
        await self._enrich_items(dtos, kind)
        return dtos

    async def fetch_period(
        self,
        kind: Literal["SALES", "PURCHASE"],
        start: date,
        end: date,
    ) -> list[TaxInvoiceDTO]:
        if not self.configured:
            logger.info("BarobillProvider: 크레덴셜 미설정 — fetch_period 스킵")
            return []
        fn_name = (_SALES_FN if kind == "SALES" else _PURCHASE_FN)["period"]
        dtos = await self._call_list_api(fn_name, kind, date_from=start, date_to=end)
        await self._enrich_items(dtos, kind)
        return dtos

    async def _enrich_items(
        self, dtos: list[TaxInvoiceDTO], kind: Literal["SALES", "PURCHASE"]
    ) -> None:
        """list API 응답(헤더만) 에 detail API 결과(품목라인) 를 in-place 보강.

        per-row N+1 SOAP 호출이지만 일 수집량이 수십 건 수준이라 허용. 실패한
        건은 items 가 비어있는 채로 남고 다음 백필/재수집 때 재시도된다.

        detail 응답이 비어도 _row_to_dto 가 list 응답의 ItemName 으로 1줄
        품목을 미리 합성해 두므로 빈 items 로 끝나는 일은 거의 없다 (ItemName
        조차 없는 극단적 케이스만).
        """
        detail_hit = 0
        for dto in dtos:
            mgt_key = dto.mgt_key or dto.approval_no
            if not mgt_key:
                continue
            items = await self.fetch_detail(kind, mgt_key)
            if items:
                dto.items = items
                detail_hit += 1
            # detail 빈 응답 → _row_to_dto 가 채워둔 1줄 합성 items 유지.
        if dtos:
            logger.info(
                "detail 보강 결과: kind=%s rows=%d detail_hit=%d fallback=%d",
                kind, len(dtos), detail_hit, len(dtos) - detail_hit,
            )

    async def fetch_detail(
        self,
        kind: Literal["SALES", "PURCHASE"],
        mgt_key: str,
    ) -> list[TaxInvoiceItemDTO]:
        """단건 상세 — 품목라인(TradeLineItem) 만 추출해서 반환.

        list API (SimpleTaxInvoiceEx) 는 품목을 포함하지 않으므로 헤더 수집 후
        본 메소드로 보강. MgtNumType: 1=Sell(매출), 2=Buy(매입).
        실패하면 빈 리스트 반환 (해당 row 만 items 빈 채로 저장).
        """
        if not self.configured or not mgt_key:
            return []
        fn_name = "GetTaxInvoice"
        mgt_num_type = 1 if kind == "SALES" else 2
        body = self._build_detail_envelope(fn_name, mgt_num_type, mgt_key)
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(
                    self.base_url,
                    content=body,
                    headers={
                        "Content-Type": "text/xml; charset=utf-8",
                        "SOAPAction": f'"{_NS}{fn_name}"',
                    },
                )
                resp.raise_for_status()
            except Exception as exc:
                logger.warning(
                    "BarobillProvider %s 호출 실패 (mgt_key=%s, kind=%s): %s",
                    fn_name, mgt_key, kind, exc,
                )
                return []
        try:
            return self._parse_detail_items(resp.text)
        except Exception as exc:
            logger.exception(
                "BarobillProvider %s 응답 파싱 실패 (mgt_key=%s): %s",
                fn_name, mgt_key, exc,
            )
            return []

    async def download_pdf(
        self,
        kind: Literal["SALES", "PURCHASE"],
        mgt_key: str,
    ) -> bytes | None:
        # Barobill 의 PDF 는 `GetTaxInvoicePDFURL` 로 URL 을 먼저 얻고 해당 URL
        # 에서 다운받는다. 현 버전은 수집만 우선 — PDF 기능은 필요 시 추가.
        if not self.configured or not mgt_key:
            return None
        return None

    # ------------------------------------------------------------------
    # 내부 SOAP 호출
    # ------------------------------------------------------------------

    async def _call_list_api(
        self,
        fn_name: str,
        kind: Literal["SALES", "PURCHASE"],
        *,
        date_from: date,
        date_to: date,
    ) -> list[TaxInvoiceDTO]:
        """`GetDaily/Period TaxInvoice Sales/Purchase List` 공용 entry.

        - fn_name 에 'Daily' 가 포함되면 BaseDate 단건, 'Period' 면 Start/End.
        - TaxType 1/2/3 모두 순회.
        - CurrentPage 를 증가시켜 MaxPageNum 까지 페이징.
        - 음수 CurrentPage 는 Barobill 에러코드 → warning 로그 + skip.
        """
        is_daily = "Daily" in fn_name
        out: list[TaxInvoiceDTO] = []
        async with httpx.AsyncClient(timeout=30) as client:
            for tax_type in _TAX_TYPES:
                page = 1
                while True:
                    body = self._build_envelope(
                        fn_name, tax_type, date_from, date_to, page, is_daily
                    )
                    try:
                        resp = await client.post(
                            self.base_url,
                            content=body,
                            headers={
                                "Content-Type": "text/xml; charset=utf-8",
                                "SOAPAction": f'"{_NS}{fn_name}"',
                            },
                        )
                        resp.raise_for_status()
                    except Exception as exc:
                        logger.warning(
                            "BarobillProvider %s 호출 실패 (page=%d, TaxType=%d): %s",
                            fn_name, page, tax_type, exc,
                        )
                        break
                    try:
                        current, max_page, items = self._parse_list_response(resp.text, kind)
                    except Exception as exc:
                        logger.exception(
                            "BarobillProvider %s 응답 파싱 실패 (page=%d, TaxType=%d): %s",
                            fn_name, page, tax_type, exc,
                        )
                        break
                    if current < 0:
                        # Barobill 은 에러를 CurrentPage 필드에 음수로 꽂아 반환.
                        # -11010 같은 파라미터 오류는 warning 에서 그치고 이 조합 skip.
                        logger.warning(
                            "BarobillProvider %s 에러코드 %d (TaxType=%d, %s~%s)",
                            fn_name, current, tax_type, date_from, date_to,
                        )
                        break
                    out.extend(items)
                    if max_page <= page or max_page == 0:
                        break
                    page += 1
        logger.info(
            "BarobillProvider %s 수집: kind=%s %s~%s rows=%d",
            fn_name, kind, date_from, date_to, len(out),
        )
        return out

    # ------------------------------------------------------------------
    # SOAP envelope + 응답 파서
    # ------------------------------------------------------------------

    def _build_envelope(
        self,
        fn_name: str,
        tax_type: int,
        date_from: date,
        date_to: date,
        page: int,
        is_daily: bool,
    ) -> bytes:
        if is_daily:
            date_xml = f"<BaseDate>{date_from.strftime('%Y%m%d')}</BaseDate>"
        else:
            date_xml = (
                f"<StartDate>{date_from.strftime('%Y%m%d')}</StartDate>"
                f"<EndDate>{date_to.strftime('%Y%m%d')}</EndDate>"
            )
        env = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
            "<soap:Body>"
            f'<{fn_name} xmlns="{_NS}">'
            f"<CERTKEY>{self.certkey}</CERTKEY>"
            f"<CorpNum>{self.corpnum}</CorpNum>"
            f"<UserID>{self.user_id}</UserID>"
            f"<TaxType>{tax_type}</TaxType>"
            f"<DateType>{_DATE_TYPE}</DateType>"
            f"{date_xml}"
            f"<CountPerPage>{_PAGE_SIZE}</CountPerPage>"
            f"<CurrentPage>{page}</CurrentPage>"
            f"</{fn_name}>"
            "</soap:Body>"
            "</soap:Envelope>"
        )
        return env.encode("utf-8")

    def _build_detail_envelope(
        self, fn_name: str, mgt_num_type: int, mgt_key: str
    ) -> bytes:
        """단건 상세(`GetTaxInvoice`) SOAP envelope.

        시그니처: GetTaxInvoice(CERTKEY, CorpNum, UserID, MgtNumType, MgtNum)
        - MgtNumType: 1=Sell(매출), 2=Buy(매입)
        - MgtNum: 자사가 발급/수신 시 부여한 관리번호 (우리 DB 의 mgt_key)
        """
        env = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
            "<soap:Body>"
            f'<{fn_name} xmlns="{_NS}">'
            f"<CERTKEY>{self.certkey}</CERTKEY>"
            f"<CorpNum>{self.corpnum}</CorpNum>"
            f"<UserID>{self.user_id}</UserID>"
            f"<MgtNumType>{mgt_num_type}</MgtNumType>"
            f"<MgtNum>{mgt_key}</MgtNum>"
            f"</{fn_name}>"
            "</soap:Body>"
            "</soap:Envelope>"
        )
        return env.encode("utf-8")

    def _parse_detail_items(self, xml_text: str) -> list[TaxInvoiceItemDTO]:
        """상세 응답에서 TradeLineItem (품목라인) 만 추출.

        바로빌 응답은 `TaxInvoice` 객체 안에 `TradeLineItem` 또는
        `TaxInvoiceTradeLineItem` collection 을 포함. 응답 schema 미세 차이를
        흡수하기 위해 element 이름이 "TradeLineItem" / "LineItem" / "Item"
        suffix 로 끝나는 모든 children 을 후보로 보고, 필드명도 여러 변형 시도.

        품목라인이 아닌 헤더 자체에 같은 suffix 가 있을 수 있어 — 자식 필드 중
        품목 식별성 있는 필드(Name/ItemName + Supply/Tax/Quantity 중 하나) 가
        있어야만 채택.
        """
        root = ET.fromstring(xml_text)
        items: list[TaxInvoiceItemDTO] = []
        seen_positions: set[int] = set()
        for el in root.iter():
            tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
            if not (
                tag.endswith("TradeLineItem")
                or tag.endswith("LineItem")
                or tag == "Item"
            ):
                continue
            fields = _all_children_map(el)
            # 품목 식별성: 이름 + (수량/공급/세액) 중 하나 이상 존재해야.
            name = (
                fields.get("Name")
                or fields.get("ItemName")
                or fields.get("ProductName")
            )
            qty_raw = fields.get("Quantity")
            supply_raw = fields.get("Supply") or fields.get("SupplyAmount")
            tax_raw = fields.get("Tax") or fields.get("TaxAmount")
            unit_raw = fields.get("UnitCost") or fields.get("UnitPrice")
            spec = (
                fields.get("Information")
                or fields.get("Standard")
                or fields.get("Spec")
            )
            memo = fields.get("Description") or fields.get("Memo") or fields.get("Etc")
            # position 은 응답에 없으면 등장순서.
            pos_raw = fields.get("PurchaseDT") or fields.get("Position") or ""
            try:
                position = int(pos_raw)
            except (TypeError, ValueError):
                position = len(items) + 1
            if not name and not (qty_raw or supply_raw or tax_raw):
                continue
            # 같은 position 중복 방지 (헤더+lines 가 같은 suffix 갖는 경우).
            if position in seen_positions:
                position = len(items) + 1
            seen_positions.add(position)
            items.append(
                TaxInvoiceItemDTO(
                    position=position,
                    item_name=name,
                    spec=spec,
                    quantity=_to_decimal(qty_raw) if qty_raw else None,
                    unit_price=_to_decimal(unit_raw) if unit_raw else None,
                    supply_amount=_to_decimal(supply_raw) if supply_raw else None,
                    tax_amount=_to_decimal(tax_raw) if tax_raw else None,
                    memo=memo,
                )
            )
        return items

    def _parse_list_response(
        self, xml_text: str, kind: Literal["SALES", "PURCHASE"]
    ) -> tuple[int, int, list[TaxInvoiceDTO]]:
        root = ET.fromstring(xml_text)
        # 응답의 Result 루트 (함수명 + "Result")
        result = root.find(".//b:*Result", _NSMAP)
        if result is None:
            # 일부 서버가 local-name 이 'Result' 로 끝나는 여러 요소를 가짐 → 첫 번째 찾음.
            for el in root.iter():
                if el.tag.endswith("Result"):
                    result = el
                    break
        if result is None:
            return -1, 0, []

        current = _to_int(_child_text(result, "CurrentPage"), 0)
        max_page = _to_int(_child_text(result, "MaxPageNum"), 0)
        rows: list[TaxInvoiceDTO] = []
        for row in result.iter():
            if not row.tag.endswith("SimpleTaxInvoiceEx"):
                continue
            dto = _row_to_dto(row, kind)
            if dto is not None:
                rows.append(dto)
        return current, max_page, rows


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------


def _child_text(parent: ET.Element, local: str) -> str | None:
    for el in parent:
        if el.tag.endswith("}" + local) or el.tag == local:
            return (el.text or "").strip() or None
    return None


def _all_children_map(parent: ET.Element) -> dict[str, str | None]:
    """element 바로 아래 자식들을 {localname: text} dict 로."""
    out: dict[str, str | None] = {}
    for el in parent:
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        out[tag] = (el.text or "").strip() or None
    return out


def synthesize_items_from_raw(raw: dict | None) -> list[TaxInvoiceItemDTO]:
    """list API 응답(raw_payload) 의 헤더 필드로 1줄짜리 품목 합성.

    배경: 바로빌 `SimpleTaxInvoiceEx` 는 다품목 분해 라인을 주지 않는 대신 대표
    `ItemName` 만 헤더에 끼워준다. 그리고 detail API(`GetTaxInvoice`) 호출은
    자사가 부여한 MgtNum 이 있어야 하는데 list 응답에 MgtNum 이 없는 경우
    (대부분의 수신 매입 건) -21002 (데이터 없음) 으로 응답한다. 결과적으로
    detail 만으로는 품목을 못 받는 row 가 다수.

    그래서 list 응답의 ItemName + AmountTotal + TaxTotal 을 한 줄 품목으로
    합성해 최소한의 표시값을 보장. 진짜 다품목 분해는 아니지만 회의·정산에서
    제목줄 정도로는 충분.

    raw 가 None 이거나 ItemName 이 비어 있으면 빈 리스트. 호출자가 그 결과를
    확인해 별도 fallback 처리 (보통 'items 없음' 메시지) 한다.
    """
    if not raw:
        return []
    name = (raw.get("ItemName") or "").strip() if isinstance(raw.get("ItemName"), str) else None
    if not name:
        return []
    logger.debug(
        "list 헤더 ItemName 으로 1줄 품목 합성: name=%s supply=%s tax=%s",
        name, raw.get("AmountTotal"), raw.get("TaxTotal"),
    )
    return [
        TaxInvoiceItemDTO(
            position=1,
            item_name=name,
            spec=None,
            quantity=None,
            unit_price=None,
            supply_amount=_to_decimal(raw.get("AmountTotal")) if raw.get("AmountTotal") else None,
            tax_amount=_to_decimal(raw.get("TaxTotal")) if raw.get("TaxTotal") else None,
            memo=None,
        )
    ]


def _row_to_dto(
    row: ET.Element, kind: Literal["SALES", "PURCHASE"]
) -> TaxInvoiceDTO | None:
    d = _all_children_map(row)

    # 필수 최소값: NTSSendKey 를 approval_no·external_id 로 사용.
    approval_no = d.get("NTSSendKey") or d.get("MgtNum") or ""
    write_date = _parse_barobill_date(d.get("WriteDate"))
    issue_date = (
        _parse_barobill_datetime(d.get("IssueDT"))
        or _parse_barobill_datetime(d.get("NTSSendDT"))
        or write_date
    )
    if not approval_no or issue_date is None:
        # 승인번호도 발행일자도 못 구하면 스킵.
        return None

    tax_type_num = _to_int(d.get("TaxType"), 1)
    tax_type_map = {1: "TAX", 2: "ZERO", 3: "NONTAX"}
    # Barobill 의 TaxType 는 정발행 분류지 과세구분이 아님. 우리 DTO 의 tax_type
    # 은 과세/영세/면세 분류라 엄밀히 다름 — 원본 값만 raw 에 보존하고 기본 TAX.
    tax_type = "TAX"

    modify_code = (d.get("ModifyCode") or "").strip()
    issue_type = "MODIFIED" if modify_code and modify_code != "01" else "NORMAL"

    raw_payload = {**d, "_barobill_tax_type": tax_type_num}
    return TaxInvoiceDTO(
        kind=kind,
        approval_no=approval_no,
        issue_date=issue_date if isinstance(issue_date, date) else write_date or date.today(),
        written_date=write_date,
        mgt_key=d.get("MgtNum") or approval_no,
        supplier_biz_no=d.get("InvoicerCorpNum"),
        supplier_name=d.get("InvoicerCorpName"),
        supplier_ceo=d.get("InvoicerCEOName"),
        buyer_biz_no=d.get("InvoiceeCorpNum"),
        buyer_name=d.get("InvoiceeCorpName"),
        buyer_ceo=d.get("InvoiceeCEOName"),
        supply_amount=_to_decimal(d.get("AmountTotal")),
        tax_amount=_to_decimal(d.get("TaxTotal")),
        total_amount=_to_decimal(d.get("TotalAmount")),
        tax_type=tax_type,
        issue_type=issue_type,
        status="ISSUED",
        external_id=approval_no,
        raw=raw_payload,
        # list API 의 ItemName 으로 1줄 미리 채움. detail API 응답이 진짜
        # 다품목을 주면 _enrich_items 가 이 1줄을 덮어쓴다.
        items=synthesize_items_from_raw(raw_payload),
    )


def _to_int(s: str | None, default: int) -> int:
    if s is None:
        return default
    try:
        return int(s.strip())
    except (ValueError, AttributeError):
        return default


def _to_decimal(s: str | None) -> Decimal:
    if not s:
        return Decimal(0)
    try:
        return Decimal(s.strip().replace(",", ""))
    except (InvalidOperation, AttributeError):
        return Decimal(0)


def _parse_barobill_date(s: str | None) -> date | None:
    if not s:
        return None
    s = s.strip()
    # YYYYMMDD or YYYY-MM-DD 허용.
    try:
        if len(s) == 8 and s.isdigit():
            return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _parse_barobill_datetime(s: str | None) -> date | None:
    """Barobill 'YYYYMMDDHHMMSS' 또는 ISO8601 → date 변환."""
    if not s:
        return None
    s = s.strip()
    try:
        if len(s) >= 8 and s[:8].isdigit():
            return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))
        dt = datetime.fromisoformat(s.replace(" ", "T"))
        return dt.date()
    except (ValueError, TypeError):
        return None


# iter-safe helper (사용 안 함 — 남겨두면 향후 상세 항목 파싱 시 재활용 가능)
def _iter_items(el: Iterable[ET.Element]) -> list[dict[str, str | None]]:
    return [_all_children_map(child) for child in el]
