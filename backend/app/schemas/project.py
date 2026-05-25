from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


ContractType = Literal["SOLO", "CONSORTIUM", "SUBCONTRACT"]
BusinessType = Literal["RESEARCH", "PUBLIC", "PRIVATE"]
ContractCurrency = Literal["KRW", "USD"]
ProjectNature = Literal[
    "CONSULTING", "DEVELOPMENT", "OPERATIONS_MAINTENANCE", "TECHNICAL_SUPPORT"
]
AttachmentSlot = Literal["CONTRACT", "QUOTE", "PROPOSAL", "TECH_NEGOTIATION", "OTHER"]


class ProjectQuoteOut(BaseModel):
    id: UUID
    project_id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    description: str | None = None

    class Config:
        from_attributes = True


class ProjectQuoteUpdate(BaseModel):
    file_name: str | None = None
    description: str | None = None


class ProjectAttachmentUpdate(BaseModel):
    file_name: str | None = None


class ProjectAttachmentOut(BaseModel):
    id: UUID
    project_id: UUID
    slot: AttachmentSlot
    file_name: str
    mime_type: str | None = None
    size: int | None = None

    class Config:
        from_attributes = True


class ProjectCommentCreate(BaseModel):
    content: str


class ProjectCommentOut(BaseModel):
    id: UUID
    project_id: UUID
    author_id: UUID | None
    author_name: str | None
    content: str
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectBase(BaseModel):
    name: str
    customer_id: UUID | None = None
    orderer_id: UUID | None = None
    start_date: date
    end_date: date
    total_contract_amount: Decimal = Decimal("0")
    contract_currency: ContractCurrency = "KRW"
    description: str | None = None
    memo: str | None = None
    contract_type: ContractType | None = None
    business_type: BusinessType | None = None
    project_nature: ProjectNature | None = None
    alarm_days_before: list[int] | None = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: str | None = None
    customer_id: UUID | None = None
    orderer_id: UUID | None = None
    start_date: date | None = None
    end_date: date | None = None
    total_contract_amount: Decimal | None = None
    contract_currency: ContractCurrency | None = None
    description: str | None = None
    memo: str | None = None
    contract_type: ContractType | None = None
    business_type: BusinessType | None = None
    project_nature: ProjectNature | None = None
    alarm_days_before: list[int] | None = None


class ProjectMemoUpdate(BaseModel):
    memo: str | None = None


class ProjectOut(ProjectBase):
    id: UUID
    created_at: datetime
    ended_at: datetime | None = None
    quotes: list[ProjectQuoteOut] = []
    attachments: list[ProjectAttachmentOut] = []

    class Config:
        from_attributes = True


class ProjectCostSummary(BaseModel):
    project_id: UUID
    total_contract_amount: Decimal
    contract_currency: ContractCurrency
    # USD 계약이면 최신 FX 로 환산된 KRW 금액. KRW 계약이면 총 사업비와 동일.
    contract_amount_krw: Decimal
    fx_rate_used: Decimal | None = None
    # 원가 분해. total_cost = personnel_cost + procurement_cost.
    personnel_cost: Decimal
    procurement_cost: Decimal
    total_cost: Decimal
    margin: Decimal
    margin_ratio: float
    assignment_count: int
    procurement_count: int


# 프로젝트 매입 (파트너 기업 위탁 금액).
class ProcurementBase(BaseModel):
    supplier_id: UUID
    amount: Decimal = Decimal("0")
    description: str | None = None
    memo: str | None = None


class ProcurementCreate(ProcurementBase):
    pass


class ProcurementUpdate(BaseModel):
    supplier_id: UUID | None = None
    amount: Decimal | None = None
    description: str | None = None
    memo: str | None = None


class ProcurementOut(ProcurementBase):
    id: UUID
    project_id: UUID
    supplier_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# 월별 비용 계산 (per-developer cost matrix)
# ---------------------------------------------------------------------------


class MonthlyCostCell(BaseModel):
    month: str  # "YYYY-MM"
    monthly_comp: Decimal
    insurance: Decimal
    freelancer: Decimal
    overlap_days: int
    days_in_month: int
    cost: Decimal
    revenue: Decimal = Decimal("0")
    profit: Decimal = Decimal("0")
    # True when the salary contract covering this month has expired and the
    # calculation is a carry-forward projection from the latest known row.
    projected: bool = False


class MonthlyCostRow(BaseModel):
    developer_id: UUID
    developer_name: str
    employment_type: str
    cells: list[MonthlyCostCell]
    total: Decimal
    total_revenue: Decimal = Decimal("0")
    total_profit: Decimal = Decimal("0")


class MonthlyCostMatrix(BaseModel):
    project_id: UUID
    start_date: date
    end_date: date
    months: list[str]
    # Months falling strictly after project.end_date — useful for the UI to
    # visually mark delay/overrun columns.
    delay_months: list[str] = []
    rows: list[MonthlyCostRow]
    monthly_totals: list[Decimal]
    monthly_revenues: list[Decimal] = []
    monthly_profits: list[Decimal] = []
    grand_total: Decimal
    grand_revenue: Decimal = Decimal("0")
    grand_profit: Decimal = Decimal("0")


# ---------------------------------------------------------------------------
# 견적서 라인아이템
# ---------------------------------------------------------------------------


EstimateGrade = Literal["PREMIUM", "HIGH", "MID", "JUNIOR"]


class EstimateItemIn(BaseModel):
    # Optional id — present for existing rows, absent for newly-added ones.
    # Server uses this to upsert so assignment.estimate_item_id FKs survive.
    id: UUID | None = None
    name: str = ""
    grade: EstimateGrade = "MID"
    unit_rate: Decimal = Decimal("0")
    months: Decimal = Decimal("1")
    discount_rate: Decimal = Decimal("0")


class EstimateItemOut(EstimateItemIn):
    id: UUID
    project_id: UUID
    position: int

    class Config:
        from_attributes = True


class EstimateItemsSave(BaseModel):
    items: list[EstimateItemIn]


# ---------------------------------------------------------------------------
# 견적서 기반 투입 현황 (estimate fulfillment)
# ---------------------------------------------------------------------------


FulfillmentStatus = Literal["DONE", "PARTIAL", "EMPTY"]


class FulfillmentAssignment(BaseModel):
    id: UUID
    developer_id: UUID
    developer_name: str
    employment_type: str
    start_date: date
    end_date: date
    is_insourced: bool
    monthly_rate: Decimal


class FulfillmentItem(BaseModel):
    estimate_item: EstimateItemOut
    required_months: Decimal
    assigned_months: Decimal
    status: FulfillmentStatus
    assignments: list[FulfillmentAssignment]


class EstimateFulfillment(BaseModel):
    project_id: UUID
    project_start: date
    project_end: date
    items: list[FulfillmentItem]
    unassigned: list[FulfillmentAssignment]
