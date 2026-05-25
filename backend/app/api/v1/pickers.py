"""공용 picker 엔드포인트 — 메뉴 권한과 무관하게 모든 사용자가 조회.

목적:
  회의록 / 내 액션 / 주간보고 등의 다이얼로그에서 고객·프로젝트 cascading
  combo 를 채우려면 **모든 role** 이 list 를 받을 수 있어야 한다. 그러나 도메인
  라우터(`customers`, `projects`)는 `_menu(...)` 로 차단돼 ETC/DEV 등 일부
  role 은 호출 시 403. 메뉴 권한과 picker 조회는 본질이 다르므로
  분리된 ungated 라우터를 둔다.

원칙:
  - 반환 필드는 **이름·매핑** 만 (예산·금액·연락처·QUOTE 등 민감 정보 X).
  - 라우터 전체에 `_menu(...)` 부착하지 않는다. `get_current_user` 만으로
    인증되면 누구나 호출 가능.
  - tenant 격리는 RLS 가 보장하므로 별도 where 절 없이 안전.

대체 대상:
  - 기존 `/customers/projects-picker` 는 customers 메뉴 권한자 전용 (SALES/SUPPORT).
    이 라우터는 그 보다 더 넓은 범위 — 회의록 등 모든 사용자의 다이얼로그용.
"""

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Assignment, Customer, Project, User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/pickers", tags=["pickers"])


class _CustomerPickerOut(BaseModel):
    id: UUID
    name: str

    class Config:
        from_attributes = True


class _ProjectPickerOut(BaseModel):
    id: UUID
    name: str
    customer_id: UUID | None = None

    class Config:
        from_attributes = True


@router.get("/customers", response_model=list[_CustomerPickerOut])
async def list_customers_picker(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """고객사 picker — id/name 만. 모든 인증 사용자 호출 가능."""
    rows = list(
        (
            await db.execute(select(Customer).order_by(Customer.name.asc()))
        ).scalars()
    )
    # 호출 빈도가 높으므로 INFO 는 row 수만, 디버그 정보는 logger.debug 로.
    logger.info(
        "picker.customers: tenant=%s user=%s rows=%d",
        user.tenant_id, user.id, len(rows),
    )
    return rows


@router.get("/projects", response_model=list[_ProjectPickerOut])
async def list_projects_picker(
    customer_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """프로젝트 picker — id/name/customer_id 만. 모든 인증 사용자 호출 가능.

    customer_id 주어지면 그 고객사 소속만, 아니면 전체.
    """
    stmt = select(Project).order_by(Project.name.asc())
    if customer_id:
        stmt = stmt.where(Project.customer_id == customer_id)
    rows = list((await db.execute(stmt)).scalars())
    logger.info(
        "picker.projects: tenant=%s user=%s customer=%s rows=%d",
        user.tenant_id, user.id, customer_id, len(rows),
    )
    return rows


class _MyAssignmentOut(BaseModel):
    id: UUID
    project_id: UUID
    developer_id: UUID
    start_date: date
    end_date: date
    is_insourced: bool

    class Config:
        from_attributes = True


@router.get("/my-assignments", response_model=list[_MyAssignmentOut])
async def list_my_assignments(
    year: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 인력투입 row — 주간보고 'MyProjectsGantt' 같은 self-scope 위젯용.

    /assignments 는 `_menu("assignments")` 로 SALES/HR 만 호출 가능해 ETC 등
    임직원의 본인 투입 이력 표시가 빈다. 여기는 menu 가드 없이 본인 row 만
    필터해서 안전하게 노출 (단가·base 등 금액 필드 제외).

    매핑된 developer 가 없으면 빈 리스트 (UI 친화적).
    year 가 주어지면 그 해의 [01-01, 12-31] 과 겹치는 row 만.
    """
    if not user.mapped_developer_id:
        # 임직원 매핑이 없는 user 는 본인 투입 정의가 불가 — 본인 자료 위젯
        # 들이 비어 보이는 원인이므로 WARNING 으로 가시화.
        logger.warning(
            "picker.my-assignments: user=%s 에 mapped_developer_id 없음 — 빈 리스트 반환",
            user.id,
        )
        return []
    stmt = (
        select(Assignment)
        .where(Assignment.developer_id == user.mapped_developer_id)
        .order_by(Assignment.start_date.desc())
    )
    if year is not None:
        ys = date(year, 1, 1)
        ye = date(year, 12, 31)
        stmt = stmt.where(
            and_(Assignment.start_date <= ye, Assignment.end_date >= ys)
        )
    rows = list((await db.execute(stmt)).scalars())
    logger.info(
        "picker.my-assignments: user=%s dev=%s year=%s rows=%d",
        user.id, user.mapped_developer_id, year, len(rows),
    )
    return rows
