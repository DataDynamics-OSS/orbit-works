"""매입 인보이스 (VendorBill) 모델 — 외부 vendor 가 우리에게 발행한 청구서.

`tax_invoices` (PURCHASE) 가 한국 전자세금계산서를 자동 수집하는 반면, 이 모델은
세금계산서가 아닌 모든 수신 청구를 수동/반자동으로 기록한다:
- 해외 SaaS (Slack/GitHub/Notion 등) 의 카드 영수증
- 호스팅·도메인 결제
- 외주비·법무비 등 영수증

`bank_transactions` (통장 거래) 와 `tax_invoices` (PURCHASE) 와 매칭 가능하도록
nullable FK 보유. 매칭은 수동 또는 추후 매처가 자동 채움.

첨부는 `vendor_bill_attachments` 별도 테이블 (1:N) — 영수증·청구서 PDF·이메일
스크린샷 등 여러 파일 동시 보관.
"""

from datetime import date
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Computed, Date, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class VendorBill(Base, UUIDMixin, TenantMixin, TimestampMixin):
    __tablename__ = "vendor_bills"

    # 공급업체 정보 — 자유 텍스트 (기본). customer_id 가 set 되면 customers 테이블의
    # name 을 mirror 하지만, 컬럼은 그대로 보존해 ad-hoc 입력 (고객사 마스터에 없는
    # vendor) 도 허용. customer_id 는 우선순위 — 화면 표시 시 join 한 고객사 정보를
    # 같이 보여줌.
    vendor_name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    vendor_biz_no: Mapped[str | None] = mapped_column(String(20))
    # 공급업체 — 우리에게 청구하는 업체 (= invoice 발행자). 우리가 돈을 지불할 대상.
    customer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    # 납품업체 — 실제 물품/서비스를 우리에게 전달한 업체. 리셀러 모델 등에서
    # 공급업체와 다를 수 있음 (예: 공급업체는 SI 파트너, 납품업체는 SW 제조사).
    delivery_customer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="SET NULL"),
        index=True,
    )
    # 관련 견적서 — 우리가 발행한 quotes 중 한 건. 선택 시 그 견적서의 고객사/제목
    # 등을 자동 매핑해 vendor 입력 마찰을 줄임.
    quote_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("quotes.id", ondelete="SET NULL"),
        index=True,
    )

    # 제목 — "Slack Pro 11월 구독료" 같은 설명. 검색·목록 표시.
    title: Mapped[str | None] = mapped_column(String(200))

    # 관련 프로젝트 — 비용을 프로젝트에 귀속해 원가/마진 분석에 사용.
    project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        index=True,
    )

    # vendor 가 발행한 인보이스 번호 (자유 형식).
    invoice_no: Mapped[str | None] = mapped_column(String(80))
    # 우리가 발행한 PO 번호 — vendor 가 청구서에 표기한 그대로.
    po_no: Mapped[str | None] = mapped_column(String(80))
    # vendor 측 sales order 번호.
    sales_order_no: Mapped[str | None] = mapped_column(String(80))

    bill_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    due_date: Mapped[date | None] = mapped_column(Date)

    # 카테고리 — 코드 상수 (frontend 와 동기화). CLOUD/SAAS/SOFTWARE_SUBSCRIPTION/HOSTING/...
    # SOFTWARE_SUBSCRIPTION 가 21자라 varchar(40) 으로 여유.
    category: Mapped[str] = mapped_column(String(40), nullable=False, default="OTHER", index=True)

    # 기본 통화 USD — 해외 SaaS·구독 비중이 큰 회사 기준. 한국 vendor 면 변경.
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")
    # 부가세 모드 — INCLUSIVE (amount 안에 부가세 포함) / EXCLUSIVE (amount 는 공급가액, 별도 tax).
    tax_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="EXCLUSIVE")
    # 공급가액 (vendor 발행 금액 — 부가세 별도 표기 시 supply, 포함이면 total).
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    # 부가세 (VAT) — 별도 표기 vendor 만 채워짐. 0 이면 부가세 없음/포함 가정.
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    # 합계 = amount + tax_amount — DB 가 자동 계산 (PostgreSQL generated column).
    total_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2),
        Computed("amount + tax_amount", persisted=True),
        nullable=False,
    )

    # 결제 상태 — UNPAID | PARTIAL | PAID. paid_amount/paid_at 와 결합해 사용.
    payment_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="UNPAID", index=True
    )
    paid_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    paid_at: Mapped[date | None] = mapped_column(Date)

    memo: Mapped[str | None] = mapped_column(Text)

    # 매칭 — 한국 전자세금계산서 PURCHASE / 통장 출금. 자동 또는 수동.
    linked_tax_invoice_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tax_invoices.id", ondelete="SET NULL"),
        index=True,
    )
    linked_bank_transaction_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("bank_transactions.id", ondelete="SET NULL"),
        index=True,
    )

    created_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    attachments: Mapped[list["VendorBillAttachment"]] = relationship(
        back_populates="bill",
        cascade="all, delete-orphan",
        order_by="VendorBillAttachment.created_at",
    )


class VendorBillAttachment(Base, UUIDMixin, TenantMixin, TimestampMixin):
    """매입 인보이스의 첨부 파일 (영수증/송장/이메일 스크린샷 등 N장)."""

    __tablename__ = "vendor_bill_attachments"

    bill_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("vendor_bills.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # 파일은 storage.save_upload 가 정한 상대경로 (vendor_bills/<bill_id>/<uuid>.<ext>).
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size: Mapped[int | None] = mapped_column(Integer)

    bill: Mapped[VendorBill] = relationship(back_populates="attachments")
