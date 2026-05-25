"""근무지(Worksite) + 직원 매핑 엔드포인트.

권한: `worksites.manage` (HR + ADMIN). 일반 사용자는 본인이 매핑된 근무지만
출퇴근 페이지에서 간접 노출되며, 직접 CRUD 는 HR/ADMIN 만.

LIST 는 매핑 직원 수 + project_name 을 derived 로 채워 N+1 회피.
"""

from __future__ import annotations

import logging
from datetime import date as date_t
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.models import Developer, Project, User, Worksite, WorksiteAssignment
from app.schemas.worksite import (
    WorksiteAssignmentCreate,
    WorksiteAssignmentOut,
    WorksiteAssignmentUpdate,
    WorksiteCreate,
    WorksiteDetail,
    WorksiteOut,
    WorksiteUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/worksites", tags=["worksites"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _attach_derived(db: AsyncSession, sites: Iterable[Worksite]) -> None:
    """`assignment_count` transient 속성 채움. `projects` 는 selectinload 가
    이미 채워줌 (LIST 의 selectinload(Worksite.projects))."""
    sites = list(sites)
    if not sites:
        return
    site_ids = [s.id for s in sites]
    counts: dict[UUID, int] = {}
    if site_ids:
        rows = (
            await db.execute(
                select(
                    WorksiteAssignment.worksite_id, func.count()
                )
                .where(WorksiteAssignment.worksite_id.in_(site_ids))
                .group_by(WorksiteAssignment.worksite_id)
            )
        ).all()
        counts = {row[0]: int(row[1]) for row in rows}
    for s in sites:
        s.assignment_count = counts.get(s.id, 0)  # type: ignore[attr-defined]


def _attach_developer(assignments: Iterable[WorksiteAssignment]) -> None:
    for a in assignments:
        a.developer_name = a.developer.name if a.developer else None  # type: ignore[attr-defined]
        a.developer_status = a.developer.status if a.developer else None  # type: ignore[attr-defined]


async def _ensure_projects(db: AsyncSession, project_ids: list[UUID]) -> None:
    if not project_ids:
        return
    found = {
        pid
        for (pid,) in (
            await db.execute(
                select(Project.id).where(Project.id.in_(project_ids))
            )
        ).all()
    }
    missing = [str(pid) for pid in project_ids if pid not in found]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"지정한 프로젝트를 찾을 수 없습니다: {', '.join(missing)}",
        )


async def _ensure_developer(db: AsyncSession, developer_id: UUID) -> None:
    exists = (
        await db.execute(select(Developer.id).where(Developer.id == developer_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="지정한 직원을 찾을 수 없습니다.")


async def _load_worksite(db: AsyncSession, worksite_id: UUID) -> Worksite:
    site = (
        await db.execute(
            select(Worksite)
            .options(
                selectinload(Worksite.projects),
                selectinload(Worksite.assignments).selectinload(
                    WorksiteAssignment.developer
                ),
            )
            .where(Worksite.id == worksite_id)
        )
    ).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="근무지를 찾을 수 없습니다.")
    return site


# ---------------------------------------------------------------------------
# Worksite CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[WorksiteOut])
async def list_worksites(
    project_id: UUID | None = None,
    status_filter: str | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("worksites.manage")),
):
    stmt = (
        select(Worksite)
        .options(selectinload(Worksite.projects))
        .order_by(Worksite.name)
    )
    if project_id is not None:
        # M:N — link 테이블에 해당 project_id 가 있는 worksite 만.
        from app.models.worksite import worksite_projects as wp

        stmt = stmt.where(
            Worksite.id.in_(
                select(wp.c.worksite_id).where(wp.c.project_id == project_id)
            )
        )
    if status_filter:
        stmt = stmt.where(Worksite.status == status_filter)
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            (Worksite.name.ilike(pattern)) | (Worksite.address.ilike(pattern))
        )
    rows = list((await db.execute(stmt)).scalars().all())
    await _attach_derived(db, rows)
    return rows


@router.post("", response_model=WorksiteOut, status_code=status.HTTP_201_CREATED)
async def create_worksite(
    payload: WorksiteCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("worksites.manage")),
):
    await _ensure_projects(db, payload.project_ids)
    data = payload.model_dump()
    project_ids: list[UUID] = data.pop("project_ids", []) or []
    site = Worksite(**data)
    if project_ids:
        # 해당 ID 들로 Project 객체 fetch 후 relationship 에 셋팅.
        site.projects = list(
            (
                await db.execute(
                    select(Project).where(Project.id.in_(project_ids))
                )
            ).scalars()
        )
    db.add(site)
    await db.commit()
    await db.refresh(site, attribute_names=["projects"])
    await _attach_derived(db, [site])
    logger.info(
        "근무지 등록: id=%s name=%s projects=%s 반경=%sm (등록자=%s)",
        site.id,
        site.name,
        [p.id for p in site.projects],
        site.radius_meters,
        user.id,
    )
    return site


@router.get("/{worksite_id}", response_model=WorksiteDetail)
async def get_worksite(
    worksite_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("worksites.manage")),
):
    site = await _load_worksite(db, worksite_id)
    _attach_developer(site.assignments)
    await _attach_derived(db, [site])
    return site


@router.patch("/{worksite_id}", response_model=WorksiteOut)
async def update_worksite(
    worksite_id: UUID,
    payload: WorksiteUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("worksites.manage")),
):
    site = (
        await db.execute(
            select(Worksite)
            .options(selectinload(Worksite.projects))
            .where(Worksite.id == worksite_id)
        )
    ).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="근무지를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    project_ids: list[UUID] | None = None
    if "project_ids" in data:
        project_ids = data.pop("project_ids")
        await _ensure_projects(db, project_ids or [])
    for k, v in data.items():
        setattr(site, k, v)
    if project_ids is not None:
        site.projects = list(
            (
                await db.execute(
                    select(Project).where(Project.id.in_(project_ids))
                )
            ).scalars()
        ) if project_ids else []
    await db.commit()
    await db.refresh(site, attribute_names=["projects"])
    await _attach_derived(db, [site])
    logger.info(
        "근무지 수정: id=%s 변경필드=%s (수정자=%s)",
        site.id,
        list(data.keys()) + (["project_ids"] if project_ids is not None else []),
        user.id,
    )
    return site


@router.delete("/{worksite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_worksite(
    worksite_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("worksites.manage")),
):
    """soft delete — status=INACTIVE 로 전환 (출퇴근 이력 보존)."""
    site = (
        await db.execute(select(Worksite).where(Worksite.id == worksite_id))
    ).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="근무지를 찾을 수 없습니다.")
    site.status = "INACTIVE"
    await db.commit()
    logger.warning(
        "근무지 비활성화: id=%s name=%s (실행자=%s)",
        site.id,
        site.name,
        user.id,
    )


# ---------------------------------------------------------------------------
# Worksite Assignments
# ---------------------------------------------------------------------------


@router.post(
    "/{worksite_id}/assignments",
    response_model=WorksiteAssignmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_assignment(
    worksite_id: UUID,
    payload: WorksiteAssignmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("worksites.manage")),
):
    site = (
        await db.execute(select(Worksite.id).where(Worksite.id == worksite_id))
    ).scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="근무지를 찾을 수 없습니다.")
    await _ensure_developer(db, payload.developer_id)
    # 같은 직원이 같은 근무지에 진행중(end_date IS NULL) 매핑 중복 방지.
    existing = (
        await db.execute(
            select(WorksiteAssignment).where(
                WorksiteAssignment.worksite_id == worksite_id,
                WorksiteAssignment.developer_id == payload.developer_id,
                WorksiteAssignment.end_date.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=409,
            detail="이미 진행 중인 매핑이 있습니다. 먼저 종료해주세요.",
        )
    data = payload.model_dump()
    # 입력 미지정 시 오늘 — 매핑 시점 = 시작 시점이라 가정.
    if data.get("start_date") is None:
        data["start_date"] = date_t.today()
    assignment = WorksiteAssignment(worksite_id=worksite_id, **data)
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment, attribute_names=["developer"])
    _attach_developer([assignment])
    logger.info(
        "근무지 매핑 추가: worksite=%s developer=%s (실행자=%s)",
        worksite_id,
        payload.developer_id,
        user.id,
    )
    return assignment


@router.patch(
    "/assignments/{assignment_id}", response_model=WorksiteAssignmentOut
)
async def update_assignment(
    assignment_id: UUID,
    payload: WorksiteAssignmentUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission("worksites.manage")),
):
    a = (
        await db.execute(
            select(WorksiteAssignment)
            .options(selectinload(WorksiteAssignment.developer))
            .where(WorksiteAssignment.id == assignment_id)
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="매핑을 찾을 수 없습니다.")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(a, k, v)
    await db.commit()
    await db.refresh(a, attribute_names=["developer"])
    _attach_developer([a])
    return a


@router.delete(
    "/assignments/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_assignment(
    assignment_id: UUID,
    end_now: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("worksites.manage")),
):
    """매핑 제거. `end_now=true` 면 hard delete 대신 end_date=오늘 로 종료."""
    a = (
        await db.execute(
            select(WorksiteAssignment).where(
                WorksiteAssignment.id == assignment_id
            )
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="매핑을 찾을 수 없습니다.")
    if end_now:
        a.end_date = date_t.today()
        await db.commit()
        logger.info(
            "근무지 매핑 종료: id=%s end_date=오늘 (실행자=%s)",
            a.id,
            user.id,
        )
    else:
        await db.delete(a)
        await db.commit()
        logger.warning(
            "근무지 매핑 삭제(hard): id=%s (실행자=%s)", a.id, user.id
        )
