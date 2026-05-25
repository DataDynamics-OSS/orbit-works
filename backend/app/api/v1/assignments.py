import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Assignment, Developer, Project, User
from app.schemas.assignment import AssignmentCreate, AssignmentOut, AssignmentUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/assignments", tags=["assignments"])


async def _with_names(db: AsyncSession, assignments: list[Assignment]) -> list[AssignmentOut]:
    dev_ids = {a.developer_id for a in assignments}
    proj_ids = {a.project_id for a in assignments}
    devs = {
        d.id: d.name
        for d in (await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))).scalars()
    }
    projs = {
        p.id: p.name
        for p in (await db.execute(select(Project).where(Project.id.in_(proj_ids)))).scalars()
    }
    out = []
    for a in assignments:
        out.append(
            AssignmentOut(
                id=a.id,
                project_id=a.project_id,
                developer_id=a.developer_id,
                start_date=a.start_date,
                end_date=a.end_date,
                monthly_rate=a.monthly_rate,
                base_monthly=a.base_monthly,
                insurance_monthly=a.insurance_monthly,
                overhead_monthly=a.overhead_monthly,
                freelancer_monthly=a.freelancer_monthly,
                is_insourced=a.is_insourced,
                color=a.color,
                memo=a.memo,
                estimate_item_id=a.estimate_item_id,
                developer_name=devs.get(a.developer_id),
                project_name=projs.get(a.project_id),
            )
        )
    return out


@router.get("", response_model=list[AssignmentOut])
async def list_assignments(
    project_id: UUID | None = None,
    developer_id: UUID | None = None,
    month_start: date | None = None,
    month_end: date | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Assignment).order_by(Assignment.start_date.desc())
    if project_id:
        stmt = stmt.where(Assignment.project_id == project_id)
    if developer_id:
        stmt = stmt.where(Assignment.developer_id == developer_id)
    if month_start and month_end:
        stmt = stmt.where(
            and_(Assignment.start_date <= month_end, Assignment.end_date >= month_start)
        )
    result = await db.execute(stmt)
    assignments = list(result.scalars().all())
    return await _with_names(db, assignments)


@router.post("", response_model=AssignmentOut, status_code=status.HTTP_201_CREATED)
async def create_assignment(
    payload: AssignmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    assignment = Assignment(**payload.model_dump())
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)
    logger.info(
        "투입 배정 등록: id=%s project=%s developer=%s 기간=%s~%s monthly=%s (등록자=%s)",
        assignment.id,
        assignment.project_id,
        assignment.developer_id,
        assignment.start_date,
        assignment.end_date,
        assignment.monthly_rate,
        user.id,
    )
    out = await _with_names(db, [assignment])
    return out[0]


@router.patch("/{assignment_id}", response_model=AssignmentOut)
async def update_assignment(
    assignment_id: UUID,
    payload: AssignmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Assignment).where(Assignment.id == assignment_id))
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(assignment, k, v)
    await db.commit()
    await db.refresh(assignment)
    logger.info(
        "투입 배정 수정: id=%s 변경필드=%s (수정자=%s)",
        assignment.id,
        list(data.keys()),
        user.id,
    )
    out = await _with_names(db, [assignment])
    return out[0]


@router.delete("/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_assignment(
    assignment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Assignment).where(Assignment.id == assignment_id))
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    logger.info(
        "투입 배정 삭제: id=%s project=%s developer=%s (삭제자=%s)",
        assignment.id,
        assignment.project_id,
        assignment.developer_id,
        user.id,
    )
    await db.delete(assignment)
    await db.commit()
