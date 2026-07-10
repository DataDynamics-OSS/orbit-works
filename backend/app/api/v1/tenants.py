"""Tenants API — 멀티 테넌트 운영(SUPER_ADMIN 전용).

여기서 다루는 것은 *tenant 메타데이터 + tenant 의 admin 사용자 계정* 뿐이며,
tenant 의 도메인 데이터(직원·고객·게시판 등)는 절대 노출하지 않는다.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import forbid_in_demo_mode, get_current_user, require_super_admin
from app.core.database import get_db
from app.core.security import hash_password
from app.models import Tenant, TenantAudit, User
from app.schemas.tenant import (
    TenantAdminCreate,
    TenantAdminPasswordReset,
    TenantCreate,
    TenantOut,
    TenantUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tenants", tags=["tenants"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _email_domain(email: str) -> str:
    """이메일에서 @뒤 도메인 부분만 소문자로 반환. '@' 없으면 빈 문자열."""
    if "@" not in email:
        return ""
    return email.split("@", 1)[1].strip().lower()


async def _check_domain_conflict(
    db: AsyncSession, domains: list[str], exclude_tenant_id: UUID | None = None
) -> None:
    """주어진 도메인 중 이미 다른 tenant 가 가진 게 있으면 400."""
    if not domains:
        return
    q = select(Tenant)
    rows = (await db.execute(q)).scalars().all()
    for t in rows:
        if exclude_tenant_id and t.id == exclude_tenant_id:
            continue
        clash = set(t.domains) & set(domains)
        if clash:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"도메인 충돌: {', '.join(sorted(clash))} (tenant '{t.slug}')",
            )


async def _audit(
    db: AsyncSession,
    actor: User,
    action: str,
    tenant_id: UUID | None,
    payload: dict | None = None,
) -> None:
    """SUPER_ADMIN 의 tenant 관련 액션 기록. tenants.py 내부에서만 호출."""
    db.add(
        TenantAudit(
            actor_user_id=actor.id,
            tenant_id=tenant_id,
            action=action,
            payload=payload or {},
        )
    )


async def _check_email_unique(db: AsyncSession, email: str) -> None:
    exists = (
        await db.execute(select(User.id).where(User.email == email))
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"이미 등록된 이메일입니다: {email}",
        )


async def _build_out(db: AsyncSession, t: Tenant) -> TenantOut:
    # SUPER_ADMIN 컨텍스트에서 도메인 RLS 가 developers 를 막으므로 일시 우회.
    await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))
    counts_q = select(
        func.count(User.id).filter(User.role == "ADMIN").label("admins"),
        func.count(User.id).label("users"),
    ).where(User.tenant_id == t.id, User.is_active.is_(True))
    row = (await db.execute(counts_q)).one()
    dev_count = (
        await db.execute(
            text(
                "SELECT count(*) FROM public.developers "
                "WHERE tenant_id = :tid AND status = 'ACTIVE'"
            ),
            {"tid": str(t.id)},
        )
    ).scalar_one()
    return TenantOut(
        id=t.id,
        slug=t.slug,
        name=t.name,
        domains=list(t.domains or []),
        is_active=t.is_active,
        business_no=t.business_no,
        representative=t.representative,
        address=t.address,
        phone=t.phone,
        fax=t.fax,
        contact_email=t.contact_email,
        name_en=t.name_en,
        representative_en=t.representative_en,
        address_en=t.address_en,
        number_prefix=t.number_prefix,
        created_at=t.created_at,
        updated_at=t.updated_at,
        admin_count=int(row.admins or 0),
        user_count=int(row.users or 0),
        developer_count=int(dev_count or 0),
    )


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------


@router.get("/me", response_model=TenantOut)
async def get_my_tenant(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """현재 로그인한 사용자의 tenant 정보 (tenant admin/일반 사용자 모두 사용).

    SUPER_ADMIN(tenant_id=NULL)는 404. 일반 사용자도 자기 tenant 정보를 읽기는
    가능 (회사 프로필 표시용). 수정은 ADMIN role 만.
    """
    if user.tenant_id is None:
        raise HTTPException(status_code=404, detail="No tenant for current user")
    t = (
        await db.execute(select(Tenant).where(Tenant.id == user.tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return await _build_out(db, t)


@router.patch("/me", response_model=TenantOut)
async def update_my_tenant(
    payload: TenantUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """현재 사용자의 tenant 프로필 수정 — ADMIN role 만 가능. domains/is_active
    같은 SUPER_ADMIN 전용 필드는 무시한다.
    """
    if user.role != "ADMIN":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="tenant 수정은 ADMIN 만 가능합니다.",
        )
    if user.tenant_id is None:
        raise HTTPException(status_code=404, detail="No tenant for current user")
    t = (
        await db.execute(select(Tenant).where(Tenant.id == user.tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    data = payload.model_dump(exclude_unset=True)
    # SUPER_ADMIN 권한이 필요한 필드는 무시.
    for forbidden in ("domains", "is_active"):
        data.pop(forbidden, None)

    for k, v in data.items():
        setattr(t, k, v)
    await db.commit()
    await db.refresh(t)
    return await _build_out(db, t)


@router.get("", response_model=list[TenantOut])
async def list_tenants(
    _: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(select(Tenant).order_by(Tenant.created_at.desc()))
    ).scalars().all()
    return [await _build_out(db, t) for t in rows]


@router.post("", response_model=TenantOut, status_code=status.HTTP_201_CREATED)
async def create_tenant(
    payload: TenantCreate,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """신규 tenant + 첫 admin 유저 + 시드 데이터를 한 번에 생성.

    SUPER_ADMIN 의 컨텍스트는 app.tenant_id='' 이라 신규 tenant_id 로 INSERT 시
    RLS WITH CHECK 가 막는다. 이 cross-tenant 시스템 작업은 bypass_rls 로 우회.
    """
    await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))

    # slug 중복 검사
    dup = (
        await db.execute(select(Tenant).where(Tenant.slug == payload.slug))
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"이미 존재하는 slug 입니다: {payload.slug}",
        )

    # 도메인 충돌 검사
    await _check_domain_conflict(db, payload.domains)

    # admin 이메일 도메인이 tenant 도메인과 일치해야 함 (도메인 비어 있으면 통과)
    admin_dom = _email_domain(payload.admin_email)
    if payload.domains and admin_dom and admin_dom not in payload.domains:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"admin 이메일 도메인({admin_dom})이 tenant 도메인({payload.domains})에 없습니다."
            ),
        )

    await _check_email_unique(db, payload.admin_email)

    t = Tenant(
        slug=payload.slug,
        name=payload.name,
        domains=payload.domains,
        business_no=payload.business_no,
        representative=payload.representative,
        address=payload.address,
        phone=payload.phone,
        fax=payload.fax,
        contact_email=payload.contact_email,
        name_en=payload.name_en,
        representative_en=payload.representative_en,
        address_en=payload.address_en,
        number_prefix=payload.number_prefix or "DD",
    )
    db.add(t)
    await db.flush()

    admin_user = User(
        email=payload.admin_email,
        hashed_password=hash_password(payload.admin_password),
        name=payload.admin_name or payload.admin_email,
        role="ADMIN",
        is_active=True,
        tenant_id=t.id,
    )
    db.add(admin_user)

    # 신규 tenant 의 lookup/기본 데이터 시드 (leave_types, menu_permissions).
    # tenant_id 컨텍스트는 super admin 으로 도는 중이라 ContextVar 와 무관 —
    # 명시적으로 tenant_id 를 채워 INSERT.
    from app.services.tenant_seed import seed_new_tenant

    await seed_new_tenant(db, t.id)

    await _audit(
        db, actor, "CREATE_TENANT", t.id,
        {"slug": t.slug, "name": t.name, "domains": list(t.domains),
         "admin_email": payload.admin_email},
    )
    await db.commit()
    await db.refresh(t)

    # 로깅 filter 가 신규 tenant 의 slug 를 즉시 인식하도록 캐시 비움.
    from app.core.tenant_context import invalidate_tenant_slug_cache
    invalidate_tenant_slug_cache()

    logger.warning(
        "tenant 생성: slug=%s name=%s domains=%s admin=%s",
        t.slug, t.name, t.domains, payload.admin_email,
    )
    return await _build_out(db, t)


@router.get("/{tenant_id}", response_model=TenantOut)
async def get_tenant(
    tenant_id: UUID,
    _: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    t = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return await _build_out(db, t)


@router.patch("/{tenant_id}", response_model=TenantOut)
async def update_tenant(
    tenant_id: UUID,
    payload: TenantUpdate,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    t = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    data = payload.model_dump(exclude_unset=True)
    if "domains" in data and data["domains"] is not None:
        await _check_domain_conflict(db, data["domains"], exclude_tenant_id=t.id)

    for k, v in data.items():
        setattr(t, k, v)
    await _audit(db, actor, "UPDATE_TENANT", t.id, {"changed": list(data.keys())})
    await db.commit()
    await db.refresh(t)
    return await _build_out(db, t)


@router.delete("/{tenant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_tenant(
    tenant_id: UUID,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """soft delete — tenant 비활성화. 데이터 row 는 그대로."""
    t = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    t.is_active = False
    await _audit(db, actor, "DEACTIVATE_TENANT", t.id, {"slug": t.slug})
    await db.commit()
    logger.warning("tenant 비활성: slug=%s id=%s", t.slug, t.id)


# ---------------------------------------------------------------------------
# 하드 삭제 — tenant 와 그에 속한 모든 도메인 row 영구 삭제. 복구 불가.
# ---------------------------------------------------------------------------

# 삭제 순서: 자식(상세·첨부·item)부터 부모(developers/customers/projects 등)
# 까지 — FK 위반 방지. 공유 부모(meeting_rooms→meeting_reservations→participants)
# 같은 다단 체인은 안쪽부터.
_DELETE_ORDER: tuple[str, ...] = (
    # 첨부
    "board_attachments",
    "customer_interaction_attachments",
    "patent_attachments",
    "loan_attachments",
    "company_car_attachments",
    "company_insurance_attachments",
    "opportunity_attachments",
    "project_attachments",
    # 상세·item·version
    "quote_items", "quote_versions",
    "invoice_items", "invoice_versions",
    "license_quote_items",
    "tax_invoice_items", "tax_invoice_fetches",
    "leave_request_allocations",
    "payroll_items", "payroll_distributions",
    "project_estimate_items",
    "project_comments",
    "project_quotes",
    "project_procurements",
    "developer_tax_profile",
    "developer_certifications",
    "developer_experiences",
    "developer_research_grants",
    "developer_resumes",
    "developer_profiles",
    "developer_approvers",
    "developer_salaries",
    # 중간 자식
    "customer_interactions",
    "customer_contacts",
    "license_contacts",
    "license_quotes",
    "opportunity_activities",
    "opportunity_stage_history",
    "leave_balances",
    "leave_accruals",
    "leave_reward_grants",
    "leave_requests",
    "leave_reset_history",
    "alarm_sends",
    "meeting_reservation_participants",
    "worksite_assignments",
    "bank_transactions",
    "assignments",
    # 주요 자식
    "licenses",
    "patents",
    "loans",
    "tax_invoices",
    "quotes",
    "invoices",
    "company_cars",
    "company_insurances",
    "company_assets",
    "bank_accounts",
    "meeting_reservations",
    "alarms",
    "payroll_runs",
    "announcement_bookmarks",
    "attendances",
    "push_subscriptions",
    "board_posts",
    "menu_permissions",
    "leave_types",
    "job_runs",
    # 주요 부모 (도메인 마지막)
    "opportunities",
    "customers",
    "projects",
    "developers",
    "meeting_rooms",
    "worksites",
)


@router.delete(
    "/{tenant_id}/hard-delete", status_code=status.HTTP_204_NO_CONTENT
)
async def hard_delete_tenant(
    tenant_id: UUID,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """tenant 와 매칭되는 모든 도메인 row + tenant 자체 삭제. 복구 불가.

    - audit 는 *기록 후* tenant 를 삭제 (tenant_audit.tenant_id FK 가 SET NULL
      이라 tenant 삭제되어도 audit row 는 살아남아 슬러그·이름 추적 가능).
    - users.tenant_id 가 가리키는 tenant 사용자도 함께 삭제.
    - bypass_rls 로 정책 우회 — 정책의 USING 가 막아 다른 tenant 데이터를
      건드릴 수 없음.
    """
    t = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    slug, name = t.slug, t.name

    await db.execute(
        text("SELECT set_config('app.bypass_rls', 'true', false)")
    )

    # Audit 먼저 INSERT (flush). tenant 삭제 시 FK ON DELETE SET NULL 로
    # tenant_id 만 NULL 로 바뀌고 audit row 자체는 살아남아 추적 가능.
    await _audit(
        db, actor, "HARD_DELETE_TENANT", tenant_id, {"slug": slug, "name": name}
    )
    await db.flush()

    # 도메인 테이블 일괄 삭제 (순서 중요).
    for tbl in _DELETE_ORDER:
        await db.execute(
            text(f"DELETE FROM public.{tbl} WHERE tenant_id = :tid"),
            {"tid": str(tenant_id)},
        )

    # tenant 의 user 들 삭제.
    await db.execute(
        text("DELETE FROM public.users WHERE tenant_id = :tid"),
        {"tid": str(tenant_id)},
    )

    # 마지막으로 tenant 본체.
    await db.execute(
        text("DELETE FROM public.tenants WHERE id = :tid"),
        {"tid": str(tenant_id)},
    )

    await db.commit()
    # 캐시 비움 — section 합성값과 slug 모두 다음 요청에서 재조회되어야.
    from app.core.config import invalidate_tenant_section
    from app.core.tenant_context import invalidate_tenant_slug_cache
    invalidate_tenant_section(tenant_id)
    invalidate_tenant_slug_cache()
    logger.warning("tenant 하드 삭제: slug=%s id=%s", slug, tenant_id)


# ---------------------------------------------------------------------------
# tenant admin 관리
# ---------------------------------------------------------------------------


@router.post(
    "/{tenant_id}/admin-users",
    response_model=dict,
)
async def create_tenant_admin(
    tenant_id: UUID,
    payload: TenantAdminCreate,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """이메일이 미등록이면 신규 ADMIN 생성. 이미 같은 tenant 에 있으면 비밀번호만
    갱신 (이름이 비어 있지 않게 들어오면 함께 갱신). 다른 tenant 의 사용자가
    같은 이메일을 갖고 있으면 충돌이므로 400.
    """
    t = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found")

    dom = _email_domain(payload.email)
    if t.domains and dom and dom not in t.domains:
        raise HTTPException(
            status_code=400,
            detail=f"이메일 도메인({dom})이 tenant 도메인({t.domains})에 없습니다.",
        )

    existing = (
        await db.execute(select(User).where(User.email == payload.email))
    ).scalar_one_or_none()

    if existing is None:
        user = User(
            email=payload.email,
            hashed_password=hash_password(payload.password),
            name=payload.name or payload.email,
            role="ADMIN",
            is_active=True,
            tenant_id=t.id,
        )
        db.add(user)
        await _audit(
            db, actor, "ADD_TENANT_ADMIN", t.id, {"email": payload.email},
        )
        await db.commit()
        await db.refresh(user)
        logger.warning("tenant admin 추가: tenant=%s email=%s", t.slug, payload.email)
        return {"id": str(user.id), "email": user.email, "action": "created"}

    if existing.tenant_id is not None and existing.tenant_id != t.id:
        raise HTTPException(
            status_code=400,
            detail=f"이메일 {payload.email} 은 다른 tenant 에 이미 등록되어 있습니다.",
        )

    existing.hashed_password = hash_password(payload.password)
    if payload.name:
        existing.name = payload.name
    if existing.tenant_id is None:
        existing.tenant_id = t.id
    if existing.role != "ADMIN":
        existing.role = "ADMIN"
    existing.is_active = True
    await _audit(
        db, actor, "UPDATE_TENANT_ADMIN_PASSWORD", t.id,
        {"email": payload.email, "user_id": str(existing.id)},
    )
    await db.commit()
    await db.refresh(existing)
    logger.warning(
        "tenant admin 비밀번호 갱신: tenant=%s email=%s", t.slug, payload.email
    )
    return {"id": str(existing.id), "email": existing.email, "action": "updated"}


@router.post(
    "/{tenant_id}/admin-users/{user_id}/reset-password",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(forbid_in_demo_mode)],
)
async def reset_tenant_admin_password(
    tenant_id: UUID,
    user_id: UUID,
    payload: TenantAdminPasswordReset,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
):
    user = (
        await db.execute(
            select(User).where(User.id == user_id, User.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found in tenant")
    user.hashed_password = hash_password(payload.new_password)
    await _audit(
        db, actor, "RESET_PASSWORD", tenant_id, {"target_user": user.email},
    )
    await db.commit()
    logger.warning(
        "tenant admin 비번 리셋: tenant=%s user=%s", tenant_id, user.email
    )
