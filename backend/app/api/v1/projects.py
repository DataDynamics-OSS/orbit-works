import logging
from calendar import monthrange
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Assignment,
    Customer,
    Developer,
    DeveloperSalary,
    ExchangeRate,
    HrInsuranceRate,
    Project,
    ProjectAttachment,
    ProjectComment,
    ProjectEstimateItem,
    ProjectQuote,
    User,
)
from app.schemas.project import (
    EstimateFulfillment,
    EstimateItemOut,
    EstimateItemsSave,
    FulfillmentAssignment,
    FulfillmentItem,
    MonthlyCostCell,
    MonthlyCostMatrix,
    MonthlyCostRow,
    ProjectAttachmentOut,
    ProjectAttachmentUpdate,
    ProjectCommentCreate,
    ProjectCommentOut,
    ProjectCostSummary,
    ProjectCreate,
    ProjectOut,
    ProjectQuoteOut,
    ProjectQuoteUpdate,
    ProjectUpdate,
)
from app.services.hr import calculate_employer_insurance
from app.services.storage import delete_file, resolve_upload_path, save_upload, save_upload_as

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    q: str | None = None,
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(Project)
        .options(selectinload(Project.quotes), selectinload(Project.attachments))
        .order_by(Project.created_at.desc())
    )
    if q:
        stmt = stmt.where(Project.name.ilike(f"%{q}%"))
    if customer_id is not None:
        # 고객사 또는 발주사 어느 쪽이든 매칭.
        stmt = stmt.where(
            or_(Project.customer_id == customer_id, Project.orderer_id == customer_id)
        )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    proj = Project(**payload.model_dump())
    db.add(proj)
    await db.commit()
    await db.refresh(proj, attribute_names=["quotes", "attachments"])
    logger.info(
        "프로젝트 등록: id=%s name=%s 기간=%s~%s 계약금액=%s %s (등록자=%s)",
        proj.id,
        proj.name,
        proj.start_date,
        proj.end_date,
        proj.total_contract_amount,
        proj.contract_currency,
        user.id,
    )
    return proj


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.quotes), selectinload(Project.attachments))
        .where(Project.id == project_id)
    )
    proj = result.scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: UUID,
    payload: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.quotes), selectinload(Project.attachments))
        .where(Project.id == project_id)
    )
    proj = result.scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(proj, k, v)
    await db.commit()
    await db.refresh(proj, attribute_names=["quotes", "attachments"])
    logger.info(
        "프로젝트 수정: id=%s 변경필드=%s (수정자=%s)",
        proj.id,
        list(data.keys()),
        user.id,
    )
    return proj


@router.post("/{project_id}/end", response_model=ProjectOut)
async def end_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """프로젝트를 수동으로 종료. idempotent — 이미 종료된 경우 기존 ended_at 유지."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.quotes), selectinload(Project.attachments))
        .where(Project.id == project_id)
    )
    proj = result.scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    if proj.ended_at is None:
        proj.ended_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(proj, attribute_names=["quotes", "attachments"])
        logger.info(
            "프로젝트 종료: id=%s name=%s (종료자=%s)", proj.id, proj.name, user.id
        )
    return proj


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.quotes), selectinload(Project.attachments))
        .where(Project.id == project_id)
    )
    proj = result.scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    logger.warning(
        "프로젝트 삭제: id=%s name=%s quotes=%d attachments=%d (삭제자=%s)",
        proj.id,
        proj.name,
        len(proj.quotes),
        len(proj.attachments),
        user.id,
    )
    for q in proj.quotes:
        delete_file(q.file_path)
    for a in proj.attachments:
        delete_file(a.file_path)
    await db.delete(proj)
    await db.commit()


@router.post(
    "/{project_id}/quotes",
    response_model=ProjectQuoteOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_project_quote(
    project_id: UUID,
    file: UploadFile = File(...),
    description: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    stored, size = await save_upload(file, f"projects/{project_id}")
    quote = ProjectQuote(
        project_id=project_id,
        file_name=file.filename or "upload.bin",
        file_path=stored,
        mime_type=file.content_type,
        size=size,
        description=description,
    )
    db.add(quote)
    await db.commit()
    await db.refresh(quote)
    logger.info(
        "프로젝트 견적 업로드: project=%s file=%s size=%d (업로드자=%s)",
        project_id, quote.file_name, size, user.id,
    )
    return quote


@router.patch("/quotes/{quote_id}", response_model=ProjectQuoteOut)
async def update_project_quote(
    quote_id: UUID,
    payload: ProjectQuoteUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(ProjectQuote).where(ProjectQuote.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(quote, k, v)
    await db.commit()
    await db.refresh(quote)
    logger.info(
        "프로젝트 견적 수정: id=%s 변경필드=%s (수정자=%s)",
        quote_id, list(data.keys()), user.id,
    )
    return quote


@router.delete("/quotes/{quote_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_quote(
    quote_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(ProjectQuote).where(ProjectQuote.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    logger.info(
        "프로젝트 견적 삭제: id=%s file=%s project=%s (삭제자=%s)",
        quote_id, quote.file_name, quote.project_id, user.id,
    )
    delete_file(quote.file_path)
    await db.delete(quote)
    await db.commit()


# ---------------------------------------------------------------------------
# 프로젝트 슬롯 첨부파일 (계약서/견적서/제안서/기술협상/기타)
# 파일은 data/projects/<project_id>/<label>.<ext> 형태로 저장된다.
# ---------------------------------------------------------------------------

_PROJECT_ATTACHMENTS: dict[str, str] = {
    "CONTRACT": "계약서",
    "QUOTE": "견적서",
    "PROPOSAL": "제안서",
    "TECH_NEGOTIATION": "기술협상",
    "OTHER": "기타",
}


@router.post(
    "/{project_id}/attachments/{slot}",
    response_model=ProjectAttachmentOut,
)
async def upload_project_attachment(
    project_id: UUID,
    slot: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if slot not in _PROJECT_ATTACHMENTS:
        raise HTTPException(status_code=400, detail="Unknown attachment slot")
    proj = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    # 동일 슬롯의 기존 row/파일을 먼저 정리 (저장 파일명이 랜덤 UUID 이므로
    # glob 으로는 찾을 수 없음. 반드시 file_path 기반으로 명시 삭제).
    existing = (
        await db.execute(
            select(ProjectAttachment).where(
                ProjectAttachment.project_id == project_id,
                ProjectAttachment.slot == slot,
            )
        )
    ).scalar_one_or_none()
    if existing:
        delete_file(existing.file_path)
        await db.delete(existing)
        await db.flush()

    base_label = _PROJECT_ATTACHMENTS[slot]
    stored, size = await save_upload_as(file, f"projects/{project_id}", base_label)
    row = ProjectAttachment(
        project_id=project_id,
        slot=slot,
        file_name=file.filename or Path(stored).name,
        file_path=stored,
        mime_type=file.content_type,
        size=size,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "프로젝트 첨부 업로드: project=%s slot=%s(%s) file=%s size=%d (업로드자=%s)",
        project_id, slot, _PROJECT_ATTACHMENTS[slot], row.file_name, size, user.id,
    )
    return row


@router.get("/{project_id}/attachments/{slot}")
async def download_project_attachment(
    project_id: UUID,
    slot: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if slot not in _PROJECT_ATTACHMENTS:
        raise HTTPException(status_code=400, detail="Unknown attachment slot")
    row = (
        await db.execute(
            select(ProjectAttachment).where(
                ProjectAttachment.project_id == project_id,
                ProjectAttachment.slot == slot,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    abs_path = resolve_upload_path(row.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        filename=row.file_name,
        media_type=row.mime_type or "application/octet-stream",
    )


@router.patch(
    "/{project_id}/attachments/{slot}",
    response_model=ProjectAttachmentOut,
)
async def update_project_attachment(
    project_id: UUID,
    slot: str,
    payload: ProjectAttachmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """첨부파일의 표시 파일명을 변경. 디스크 실제 파일은 유지."""
    if slot not in _PROJECT_ATTACHMENTS:
        raise HTTPException(status_code=400, detail="Unknown attachment slot")
    row = (
        await db.execute(
            select(ProjectAttachment).where(
                ProjectAttachment.project_id == project_id,
                ProjectAttachment.slot == slot,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "프로젝트 첨부 수정: project=%s slot=%s 변경=%s (수정자=%s)",
        project_id,
        slot,
        list(data.keys()),
        user.id,
    )
    return row


@router.delete(
    "/{project_id}/attachments/{slot}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_project_attachment(
    project_id: UUID,
    slot: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if slot not in _PROJECT_ATTACHMENTS:
        raise HTTPException(status_code=400, detail="Unknown attachment slot")
    row = (
        await db.execute(
            select(ProjectAttachment).where(
                ProjectAttachment.project_id == project_id,
                ProjectAttachment.slot == slot,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    logger.info(
        "프로젝트 첨부 삭제: project=%s slot=%s file=%s (삭제자=%s)",
        project_id, slot, row.file_name, user.id,
    )
    delete_file(row.file_path)
    await db.delete(row)
    await db.commit()


@router.get("/quotes/{quote_id}/download")
async def download_project_quote(
    quote_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(ProjectQuote).where(ProjectQuote.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found")
    abs_path = resolve_upload_path(quote.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        filename=quote.file_name,
        media_type=quote.mime_type or "application/octet-stream",
    )


@router.get("/{project_id}/comments", response_model=list[ProjectCommentOut])
async def list_comments(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(ProjectComment)
        .where(ProjectComment.project_id == project_id)
        .order_by(ProjectComment.created_at.desc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.post(
    "/{project_id}/comments",
    response_model=ProjectCommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_comment(
    project_id: UUID,
    payload: ProjectCommentCreate,
    db: AsyncSession = Depends(get_db),
    current: User = Depends(get_current_user),
):
    comment = ProjectComment(
        project_id=project_id,
        author_id=current.id,
        author_name=current.name or current.email,
        content=payload.content,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    logger.info(
        "프로젝트 댓글 작성: project=%s comment=%s (작성자=%s)",
        project_id, comment.id, current.id,
    )
    return comment


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    comment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(ProjectComment).where(ProjectComment.id == comment_id))
    comment = result.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    logger.info(
        "프로젝트 댓글 삭제: id=%s project=%s (삭제자=%s)",
        comment_id, comment.project_id, user.id,
    )
    await db.delete(comment)
    await db.commit()


async def _latest_usd_krw_rate(db: AsyncSession) -> Decimal | None:
    row = (
        await db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.base == "USD", ExchangeRate.target == "KRW")
            .order_by(ExchangeRate.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return row.rate if row else None


@router.get("/{project_id}/cost-summary", response_model=ProjectCostSummary)
async def project_cost_summary(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    proj = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    # Reuse the monthly-costs matrix so "총 투입 원가" stays consistent
    # with the per-month table (salary history + daily proration + resignation
    # clipping all applied).
    matrix = await _compute_monthly_cost_matrix(db, proj)
    personnel_cost = matrix.grand_total

    assignment_count = (
        await db.execute(
            select(func.count(Assignment.id)).where(
                Assignment.project_id == project_id
            )
        )
    ).scalar_one()

    # 매입 원가 — 이 프로젝트에 매핑된 전자세금계산서(kind=PURCHASE) 의 공급가액 합.
    # (과거 project_procurements 테이블 기반 로직을 대체. 해당 테이블은 읽기 전용
    # 과거 데이터로만 보존되고 UI 에서 편집 경로는 제거됨.)
    from app.models import TaxInvoice

    procurement_sum, procurement_count = (
        await db.execute(
            select(
                func.coalesce(func.sum(TaxInvoice.supply_amount), 0),
                func.count(TaxInvoice.id),
            ).where(
                TaxInvoice.kind == "PURCHASE",
                TaxInvoice.linked_project_id == project_id,
            )
        )
    ).one()
    procurement_cost = Decimal(procurement_sum or 0)

    total_cost = (personnel_cost + procurement_cost).quantize(Decimal("0.01"))

    contract = proj.total_contract_amount or Decimal("0")
    currency = proj.contract_currency or "KRW"

    # USD 계약이면 최신 FX 로 KRW 환산해서 마진 계산. FX 가 없으면 환산 없이
    # 원액으로 뺄셈(표시를 위해). KRW 계약은 기존 동작과 동일.
    fx_used: Decimal | None = None
    if currency == "USD":
        fx_used = await _latest_usd_krw_rate(db)
        contract_krw = (contract * fx_used).quantize(Decimal("0.01")) if fx_used else contract
    else:
        contract_krw = contract

    margin = (contract_krw - total_cost).quantize(Decimal("0.01"))
    ratio = float(margin / contract_krw) if contract_krw > 0 else 0.0

    return ProjectCostSummary(
        project_id=project_id,
        total_contract_amount=contract,
        contract_currency=currency,
        contract_amount_krw=contract_krw,
        fx_rate_used=fx_used,
        personnel_cost=personnel_cost.quantize(Decimal("0.01")),
        procurement_cost=procurement_cost.quantize(Decimal("0.01")),
        total_cost=total_cost,
        margin=margin,
        margin_ratio=round(ratio, 4),
        assignment_count=int(assignment_count),
        procurement_count=int(procurement_count or 0),
    )


# ---------------------------------------------------------------------------
# 월별 비용 계산 매트릭스
#
# 월 단위 셀 = (월 보수 + 회사 부담 4대보험 + 프리랜서 월 단가)
#              × (assignment ∩ project ∩ month 일수) / 해당 월 실제 일수
# 퇴사일 이후는 0. 연봉 이력이 없으면 salary 기반 계산분은 0, 프리랜서
# monthly 금액은 assignment 의 freelancer_monthly 가 있을 때만 반영.
# ---------------------------------------------------------------------------


def _months_in_range(start: date, end: date) -> list[tuple[int, int]]:
    months: list[tuple[int, int]] = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        months.append((y, m))
        m += 1
        if m > 12:
            y += 1
            m = 1
    return months


def _salary_at(salaries: list[DeveloperSalary], at: date) -> DeveloperSalary | None:
    pool = [
        s
        for s in salaries
        if s.effective_from <= at and (s.effective_to is None or s.effective_to >= at)
    ]
    if not pool:
        return None
    pool.sort(key=lambda s: s.effective_from, reverse=True)
    return pool[0]


def _latest_salary_before(
    salaries: list[DeveloperSalary], at: date
) -> DeveloperSalary | None:
    """가장 최근에 시작된 연봉 이력 (effective_to는 무시) — 추정치용."""
    pool = [s for s in salaries if s.effective_from <= at]
    if not pool:
        return None
    pool.sort(key=lambda s: s.effective_from, reverse=True)
    return pool[0]


def _rate_at(rates: list[HrInsuranceRate], at: date) -> HrInsuranceRate | None:
    pool = [r for r in rates if r.effective_from <= at]
    if not pool:
        return None
    pool.sort(key=lambda r: r.effective_from, reverse=True)
    return pool[0]


async def _compute_monthly_cost_matrix(
    db: AsyncSession, proj: Project
) -> MonthlyCostMatrix:
    project_id = proj.id
    assignments = list(
        (
            await db.execute(
                select(Assignment).where(Assignment.project_id == project_id)
            )
        ).scalars()
    )
    dev_ids = {a.developer_id for a in assignments}
    developers = {
        d.id: d
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
        ).scalars()
    }
    salaries_by_dev: dict[UUID, list[DeveloperSalary]] = {}
    if dev_ids:
        for s in (
            await db.execute(
                select(DeveloperSalary).where(DeveloperSalary.developer_id.in_(dev_ids))
            )
        ).scalars():
            salaries_by_dev.setdefault(s.developer_id, []).append(s)
    rates = list((await db.execute(select(HrInsuranceRate))).scalars())

    # Estimate lines — needed for revenue attribution.
    estimate_items = {
        it.id: it
        for it in (
            await db.execute(
                select(ProjectEstimateItem).where(
                    ProjectEstimateItem.project_id == project_id
                )
            )
        ).scalars()
    }

    # Expand month range to cover any assignment extending past the project
    # end date (or starting before it). This makes overrun months visible.
    range_start = proj.start_date
    range_end = proj.end_date
    for a in assignments:
        if a.start_date < range_start:
            range_start = a.start_date
        if a.end_date > range_end:
            range_end = a.end_date
    months = _months_in_range(range_start, range_end)
    month_index = {(y, m): i for i, (y, m) in enumerate(months)}

    # Group assignments per developer
    per_dev: dict[UUID, list[Assignment]] = {}
    for a in assignments:
        per_dev.setdefault(a.developer_id, []).append(a)

    zero = Decimal("0")
    hundred = Decimal("100")

    # Pass 1 — compute cost cells (no project-range clipping now that we
    # expanded the matrix; the cost is whatever the assignment actually
    # incurred).  Also collect per-(assignment, month) provisional revenue
    # contributions for Pass 2 line-level capping.
    #
    # Layout notes:
    #   rows[dev_idx].cells[month_idx]  — final cells
    #   provisional[line_id] = list[(dev_idx, month_idx, pm_fraction)]
    #     where pm_fraction = overlap_days / days_in_month, i.e. person-months
    #     that assignment spent on that line in that month.

    rows: list[MonthlyCostRow] = []
    monthly_totals = [zero] * len(months)
    # Provisional revenue bookkeeping keyed by estimate line id.
    # Each entry is (dev_idx, month_idx, pm_fraction, effective_monthly_rate).
    provisional: dict[UUID, list[tuple[int, int, Decimal, Decimal]]] = {}

    for dev_id, dev_assignments in per_dev.items():
        dev = developers.get(dev_id)
        if not dev:
            continue
        resigned = dev.resigned_date
        cells: list[MonthlyCostCell] = []
        dev_total = zero
        dev_idx = len(rows)  # index this row will get

        for idx, (y, m) in enumerate(months):
            month_start = date(y, m, 1)
            days_in_month = monthrange(y, m)[1]
            month_end = date(y, m, days_in_month)

            overlap_days = 0
            # Track each assignment's overlap so we can attribute revenue
            # proportionally to the correct estimate line.
            per_asn_overlap: list[tuple[Assignment, int]] = []
            for asn in dev_assignments:
                eff_start = max(asn.start_date, month_start)
                eff_end = min(asn.end_date, month_end)
                if resigned:
                    eff_end = min(eff_end, resigned)
                if eff_start > eff_end:
                    continue
                a_days = (eff_end - eff_start).days + 1
                overlap_days += a_days
                per_asn_overlap.append((asn, a_days))

            monthly_comp = zero
            insurance = zero
            freelancer = zero
            projected = False
            if overlap_days > 0:
                salaries = salaries_by_dev.get(dev_id, [])
                salary_row = _salary_at(salaries, month_start)
                if salary_row is None:
                    # Fall back to the latest known contract (carry-forward)
                    fallback = _latest_salary_before(salaries, month_start)
                    if fallback is not None:
                        salary_row = fallback
                        projected = True

                rate = _rate_at(rates, month_start)

                if dev.employment_type in ("FULL_TIME", "INSOURCED") and salary_row:
                    annual = salary_row.annual_salary
                    monthly_comp = annual / Decimal(12)
                    if rate:
                        emp = calculate_employer_insurance(annual, rate)
                        insurance = emp["insurance_total"]

                if dev.employment_type in ("FREELANCER", "INSOURCED"):
                    # Prefer each assignment's freelancer_monthly when set.
                    # Fallback 우선순위 (FREELANCER 만):
                    #   1) developer_salaries 이력의 연봉 / 12
                    #   2) 임직원 페이지에서 입력한 legacy `developers.salary` / 12
                    #      — 이력 row 없는 프리랜서(예: 일괄 등록) 의 안전망.
                    # freelancer_monthly == 0 (또는 NULL) 은 '미설정' 으로 보고
                    # 아래 fallback (이력 / 임직원 salary) 로 넘어간다.
                    fl_candidates = [
                        a.freelancer_monthly
                        for a in dev_assignments
                        if a.freelancer_monthly is not None
                        and a.freelancer_monthly > 0
                        and not (
                            a.end_date < month_start or a.start_date > month_end
                        )
                    ]
                    if fl_candidates:
                        freelancer = max(fl_candidates)  # 단순 선택(보통 하나)
                    elif dev.employment_type == "FREELANCER":
                        if salary_row:
                            freelancer = salary_row.annual_salary / Decimal(12)
                        elif dev.salary is not None and dev.salary > 0:
                            freelancer = Decimal(dev.salary) / Decimal(12)

            month_total = monthly_comp + insurance + freelancer
            # allocation_percent 를 per-assignment 로 곱한 후 합산 — 단일 assignment·
            # 100% 케이스는 기존 식과 동일 (a_days==overlap_days, factor==1).
            cell_cost = zero
            if days_in_month > 0:
                for asn, a_days in per_asn_overlap:
                    alloc = (
                        Decimal(asn.allocation_percent)
                        if asn.allocation_percent is not None
                        else hundred
                    )
                    cell_cost += (
                        month_total
                        * Decimal(a_days)
                        / Decimal(days_in_month)
                        * (alloc / hundred)
                    )
            cell_cost = cell_cost.quantize(Decimal("0.01"))
            monthly_totals[idx] += cell_cost
            dev_total += cell_cost

            # Queue provisional revenue contributions for any assignment
            # mapped to an estimate line.
            for asn, a_days in per_asn_overlap:
                if asn.estimate_item_id is None or days_in_month <= 0:
                    continue
                line = estimate_items.get(asn.estimate_item_id)
                if line is None:
                    continue
                eff_monthly = Decimal(line.unit_rate) * (
                    Decimal("1") - Decimal(line.discount_rate) / hundred
                )
                pm_frac = Decimal(a_days) / Decimal(days_in_month)
                provisional.setdefault(line.id, []).append(
                    (dev_idx, idx, pm_frac, eff_monthly)
                )

            cells.append(
                MonthlyCostCell(
                    month=f"{y:04d}-{m:02d}",
                    monthly_comp=monthly_comp.quantize(Decimal("0.01")),
                    insurance=insurance.quantize(Decimal("0.01")),
                    freelancer=freelancer.quantize(Decimal("0.01")),
                    overlap_days=overlap_days,
                    days_in_month=days_in_month,
                    cost=cell_cost,
                    revenue=zero,
                    profit=-cell_cost,
                    projected=projected and cell_cost > 0,
                )
            )

        rows.append(
            MonthlyCostRow(
                developer_id=dev.id,
                developer_name=dev.name,
                employment_type=dev.employment_type,
                cells=cells,
                total=dev_total.quantize(Decimal("0.01")),
                total_revenue=zero,
                total_profit=-dev_total.quantize(Decimal("0.01")),
            )
        )

    # Pass 2 — attribute revenue per line.
    # 기본 정책 (T&M 모델): 투입된 MM 에 비례해 매출 인식, 과투입 시 line_total
    # 로 cap. under-assign 이면 작아진 합 그대로 → 나머지는 매출 0.
    # 예외: project_nature == "OPERATIONS_MAINTENANCE" 는 총액제(lump-sum)
    # 계약이므로 실제 투입 MM 과 무관하게 line_total 전액을 투입 달들에 비례
    # 배분. 5개월만 투입해도 12개월치 매출이 5개월에 스케일업되어 기록됨.
    is_om = proj.project_nature == "OPERATIONS_MAINTENANCE"
    for line_id, contribs in provisional.items():
        line = estimate_items[line_id]
        line_total = (
            Decimal(line.unit_rate)
            * Decimal(line.months)
            * (Decimal("1") - Decimal(line.discount_rate) / hundred)
        )
        provisional_total = sum(
            (pm * eff for _, _, pm, eff in contribs), start=zero
        )
        if provisional_total <= zero or line_total <= zero:
            continue
        if is_om:
            # 총액제: 항상 line_total 로 정규화 (up/down 모두).
            scale = line_total / provisional_total
        else:
            # T&M: 과투입이면 cap, under-assign 이면 스케일 유지.
            scale = (
                line_total / provisional_total
                if provisional_total > line_total
                else Decimal("1")
            )
        for dev_idx, month_idx, pm, eff in contribs:
            rev = (pm * eff * scale).quantize(Decimal("0.01"))
            cell = rows[dev_idx].cells[month_idx]
            cell.revenue = (cell.revenue + rev).quantize(Decimal("0.01"))

    # Pass 3 — derive profit, totals, and aggregate rows.
    monthly_revenues = [zero] * len(months)
    monthly_profits = [zero] * len(months)
    for row in rows:
        rev_total = zero
        prof_total = zero
        for i, c in enumerate(row.cells):
            c.profit = (c.revenue - c.cost).quantize(Decimal("0.01"))
            rev_total += c.revenue
            prof_total += c.profit
            monthly_revenues[i] += c.revenue
            monthly_profits[i] += c.profit
        row.total_revenue = rev_total.quantize(Decimal("0.01"))
        row.total_profit = prof_total.quantize(Decimal("0.01"))

    rows.sort(key=lambda r: (r.employment_type, r.developer_name))

    grand_total = sum(monthly_totals, start=zero).quantize(Decimal("0.01"))
    grand_revenue = sum(monthly_revenues, start=zero).quantize(Decimal("0.01"))
    grand_profit = sum(monthly_profits, start=zero).quantize(Decimal("0.01"))

    delay_months = [
        f"{y:04d}-{m:02d}"
        for (y, m) in months
        if (y, m) > (proj.end_date.year, proj.end_date.month)
    ]
    _ = month_index  # silences unused; kept for future random access

    return MonthlyCostMatrix(
        project_id=project_id,
        start_date=proj.start_date,
        end_date=proj.end_date,
        months=[f"{y:04d}-{m:02d}" for (y, m) in months],
        delay_months=delay_months,
        rows=rows,
        monthly_totals=[v.quantize(Decimal("0.01")) for v in monthly_totals],
        monthly_revenues=[v.quantize(Decimal("0.01")) for v in monthly_revenues],
        monthly_profits=[v.quantize(Decimal("0.01")) for v in monthly_profits],
        grand_total=grand_total,
        grand_revenue=grand_revenue,
        grand_profit=grand_profit,
    )


@router.get("/{project_id}/monthly-costs", response_model=MonthlyCostMatrix)
async def project_monthly_costs(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    proj = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return await _compute_monthly_cost_matrix(db, proj)


# ---------------------------------------------------------------------------
# 견적서 라인아이템 (project estimate items)
# ---------------------------------------------------------------------------


@router.get(
    "/{project_id}/estimate-items", response_model=list[EstimateItemOut]
)
async def list_estimate_items(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(ProjectEstimateItem)
        .where(ProjectEstimateItem.project_id == project_id)
        .order_by(ProjectEstimateItem.position.asc(), ProjectEstimateItem.created_at.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.put(
    "/{project_id}/estimate-items", response_model=list[EstimateItemOut]
)
async def save_estimate_items(
    project_id: UUID,
    payload: EstimateItemsSave,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from datetime import timedelta

    proj = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    # Load existing rows keyed by id for upsert semantics. This preserves FKs
    # on assignment.estimate_item_id and lets us detect months-decrease so
    # we can clamp linked assignments below.
    existing_rows = list(
        (
            await db.execute(
                select(ProjectEstimateItem).where(
                    ProjectEstimateItem.project_id == project_id
                )
            )
        ).scalars()
    )
    existing_by_id = {r.id: r for r in existing_rows}
    incoming_ids: set[UUID] = set()

    hundred = Decimal("100")
    grand_total = Decimal("0")
    # Track (item_id, new_months) for items whose months shrank so we can
    # clamp linked assignment end_dates relative to project start.
    shrunken: list[tuple[UUID, Decimal]] = []

    for idx, item in enumerate(payload.items):
        line_total = (
            item.unit_rate * item.months * (Decimal("1") - item.discount_rate / hundred)
        )
        grand_total += line_total
        if item.id and item.id in existing_by_id:
            row = existing_by_id[item.id]
            if Decimal(item.months) < Decimal(row.months):
                shrunken.append((row.id, Decimal(item.months)))
            row.name = item.name
            row.grade = item.grade
            row.unit_rate = item.unit_rate
            row.months = item.months
            row.discount_rate = item.discount_rate
            row.position = idx
            incoming_ids.add(row.id)
        else:
            new_row = ProjectEstimateItem(
                project_id=project_id,
                name=item.name,
                grade=item.grade,
                unit_rate=item.unit_rate,
                months=item.months,
                discount_rate=item.discount_rate,
                position=idx,
            )
            db.add(new_row)

    # Remove rows that are no longer present in the payload
    for old in existing_rows:
        if old.id not in incoming_ids:
            await db.delete(old)

    # Sync 총 사업비 from the estimate grand total
    prev_total = proj.total_contract_amount
    proj.total_contract_amount = grand_total.quantize(Decimal("0.01"))
    await db.flush()
    logger.info(
        "견적 라인 저장: project_id=%s 총사업비 %s → %s, 축소된 라인=%d (저장자=%s)",
        project_id,
        prev_total,
        proj.total_contract_amount,
        len(shrunken),
        user.id,
    )

    # When a line's months decreased, clamp end_date of linked assignments
    # to project.start + new_months × 30 − 1 day.
    for item_id, new_months in shrunken:
        days = int((new_months * Decimal(30)).to_integral_value(rounding="ROUND_HALF_UP"))
        new_slot_end = proj.start_date + timedelta(days=days - 1)
        affected = (
            await db.execute(
                select(Assignment).where(
                    Assignment.project_id == project_id,
                    Assignment.estimate_item_id == item_id,
                )
            )
        ).scalars()
        for a in affected:
            if a.end_date > new_slot_end:
                a.end_date = max(a.start_date, new_slot_end)

    await db.commit()

    stmt = (
        select(ProjectEstimateItem)
        .where(ProjectEstimateItem.project_id == project_id)
        .order_by(ProjectEstimateItem.position.asc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get(
    "/{project_id}/estimate-fulfillment", response_model=EstimateFulfillment
)
async def estimate_fulfillment(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    proj = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    items = list(
        (
            await db.execute(
                select(ProjectEstimateItem)
                .where(ProjectEstimateItem.project_id == project_id)
                .order_by(ProjectEstimateItem.position.asc())
            )
        ).scalars()
    )
    assignments = list(
        (
            await db.execute(
                select(Assignment).where(Assignment.project_id == project_id)
            )
        ).scalars()
    )
    dev_ids = {a.developer_id for a in assignments}
    developers = {
        d.id: d
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
        ).scalars()
    }

    def to_fulfill_assignment(a: Assignment) -> FulfillmentAssignment:
        dev = developers.get(a.developer_id)
        return FulfillmentAssignment(
            id=a.id,
            developer_id=a.developer_id,
            developer_name=dev.name if dev else "",
            employment_type=dev.employment_type if dev else "",
            start_date=a.start_date,
            end_date=a.end_date,
            is_insourced=a.is_insourced,
            monthly_rate=a.monthly_rate,
        )

    by_item: dict[UUID, list[Assignment]] = {}
    unassigned: list[Assignment] = []
    for a in assignments:
        if a.estimate_item_id is None:
            unassigned.append(a)
        else:
            by_item.setdefault(a.estimate_item_id, []).append(a)

    result_items: list[FulfillmentItem] = []
    for it in items:
        asns = by_item.get(it.id, [])
        # 배정 개월 합 (일수 / 30)
        assigned_months = Decimal("0")
        for a in asns:
            days = Decimal((a.end_date - a.start_date).days + 1)
            assigned_months += days / Decimal(30)
        required = it.months
        if assigned_months <= 0:
            status = "EMPTY"
        elif assigned_months + Decimal("0.01") >= required:
            status = "DONE"
        else:
            status = "PARTIAL"
        result_items.append(
            FulfillmentItem(
                estimate_item=it,
                required_months=required,
                assigned_months=assigned_months.quantize(Decimal("0.01")),
                status=status,
                assignments=[to_fulfill_assignment(a) for a in asns],
            )
        )

    return EstimateFulfillment(
        project_id=project_id,
        project_start=proj.start_date,
        project_end=proj.end_date,
        items=result_items,
        unassigned=[to_fulfill_assignment(a) for a in unassigned],
    )
