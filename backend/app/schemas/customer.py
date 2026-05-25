from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, EmailStr


class LicenseContactBase(BaseModel):
    name: str
    phone: str | None = None
    email: EmailStr | None = None


class LicenseContactCreate(LicenseContactBase):
    pass


class LicenseContactOut(LicenseContactBase):
    id: UUID
    customer_id: UUID

    class Config:
        from_attributes = True


class CustomerBase(BaseModel):
    name: str
    business_no: str | None = None
    representative: str | None = None
    address: str | None = None
    memo: str | None = None
    owner_id: UUID | None = None


class CustomerCreate(CustomerBase):
    # Optional initial contact created together with the customer
    initial_contact: LicenseContactCreate | None = None


class CustomerUpdate(BaseModel):
    name: str | None = None
    business_no: str | None = None
    representative: str | None = None
    address: str | None = None
    memo: str | None = None
    owner_id: UUID | None = None


class CustomerOut(CustomerBase):
    id: UUID
    contacts: list[LicenseContactOut] = []
    business_license_name: str | None = None
    business_license_size: int | None = None
    business_license_mime: str | None = None
    bank_account_name: str | None = None
    bank_account_size: int | None = None
    bank_account_mime: str | None = None
    # Owner denormalized — 리스트 뷰에서 N+1 회피.
    owner_name: str | None = None
    owner_status: str | None = None  # ACTIVE | INACTIVE — UI 에서 (퇴사) 표시용
    # 영업기회·프로젝트(고객 또는 발주사)·청구·라이센스·인터랙션 중 어느
    # 하나라도 이 회사를 참조하는 row 가 있으면 True. LIST 응답에서만 계산.
    has_related: bool = False

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Customer 360° overview — 회사 1곳에 묶인 영업기회·프로젝트·청구·라이센스·
# 인터랙션 요약을 한 번에 반환. /customers/{id}/overview 엔드포인트가 사용.
# ---------------------------------------------------------------------------


class OverviewStats(BaseModel):
    open_opportunities: int
    won_opportunities: int
    active_projects: int
    completed_projects: int
    active_licenses: int
    # 통화별 합계 — KRW / USD 두 가지로 분리해 표시(환산은 프런트에서).
    invoices_total_krw: Decimal = Decimal("0")
    invoices_total_usd: Decimal = Decimal("0")
    invoices_unpaid_krw: Decimal = Decimal("0")
    invoices_unpaid_usd: Decimal = Decimal("0")
    interaction_count: int


class OverviewOpportunity(BaseModel):
    id: UUID
    name: str
    stage: str
    status: str
    expected_amount: Decimal
    currency: str
    expected_close_date: date | None = None


class OverviewProject(BaseModel):
    id: UUID
    name: str
    start_date: date
    end_date: date
    total_contract_amount: Decimal
    contract_currency: str
    is_orderer: bool = False  # customer 가 발주사로 매칭됐는지 (고객사인지 발주사인지)


class OverviewInvoice(BaseModel):
    id: UUID
    number: str
    title: str
    issue_date: date
    due_date: date | None = None
    currency: str
    total_amount: Decimal
    paid_amount: Decimal
    status: str


class OverviewLicense(BaseModel):
    id: UUID
    product_name: str
    start_date: date
    end_date: date
    currency: str
    amount: Decimal
    status: str


class OverviewInteraction(BaseModel):
    id: UUID
    type: str
    occurred_at: datetime
    title: str
    author_name: str | None = None


class CustomerOverview(BaseModel):
    customer: CustomerOut
    stats: OverviewStats
    recent_opportunities: list[OverviewOpportunity] = []
    recent_projects: list[OverviewProject] = []
    recent_invoices: list[OverviewInvoice] = []
    recent_licenses: list[OverviewLicense] = []
    recent_interactions: list[OverviewInteraction] = []


class CustomerDeletionBlocking(BaseModel):
    """삭제를 가로막는(RESTRICT) 관계 카운트."""

    invoice_count: int = 0
    license_count: int = 0
    procurement_count: int = 0


class CustomerDeletionPreview(BaseModel):
    """회사 삭제 시 영향 범위.

    - blocking: DB FK 가 RESTRICT 라 삭제 자체를 막는 row 수.
    - 그 외 카운트들은 SET NULL/CASCADE 로 처리되며 UI 에서 confirm 메시지에 표시.
    """

    blocking: CustomerDeletionBlocking
    contact_count: int = 0           # SET NULL — 담당자 정보는 보존, 회사만 미지정
    interaction_count: int = 0       # CASCADE — 같이 삭제됨
    opportunity_count: int = 0       # SET NULL — 영업기회는 회사 미지정으로
    project_count: int = 0           # SET NULL (customer_id or orderer_id)
    license_contact_count: int = 0   # CASCADE — 라이센스 담당자 row 동반 삭제
