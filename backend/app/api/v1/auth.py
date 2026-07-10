import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import forbid_in_demo_mode, get_current_user, require_admin
from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.models import Developer, Tenant, User
from app.schemas.auth import (
    LoginRequest,
    MeOut,
    MemoOut,
    MemoUpdate,
    PasswordChangeRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserPasswordReset,
    UserUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _email_domain(email: str) -> str:
    if "@" not in email:
        return ""
    return email.split("@", 1)[1].strip().lower()


async def _resolve_tenant_by_domain(
    db: AsyncSession, domain: str
) -> Tenant | None:
    """email 의 @뒤 도메인 으로 활성 tenant 1개 조회. 없으면 None."""
    if not domain:
        return None
    return (
        await db.execute(
            select(Tenant)
            .where(text(":d = ANY(domains)"), Tenant.is_active.is_(True))
            .params(d=domain)
        )
    ).scalar_one_or_none()


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    """로그인.

    경로 우선순위:
      1) email 도메인 → tenant 매칭 → 해당 tenant 내 user/developer 검색.
      2) tenant 매칭 실패 시 글로벌 폴백 (SUPER_ADMIN, 시스템 admin).

    비밀번호 권위:
      - SUPER_ADMIN·tenant ADMIN: `users.hashed_password`.
      - 일반 임직원: `developers.hashed_password`.
    session-proxy users 행은 FK 호환 용도라 인증에 사용 안 함.
    """
    from app.core.security import hash_password
    from app.services.developer_auth import find_or_create_user_for_developer

    # 로그인 자체는 RLS 우회가 필요 — 어느 tenant 의 user/developer 인지 모르는
    # 상태에서 email 로 룩업해야 함. 이 세션 한정으로 우회.
    await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))

    # 도메인으로 tenant 결정 (없으면 None — 단일 테넌트 호환 폴백 또는 SUPER_ADMIN).
    domain = _email_domain(payload.email)
    tenant = await _resolve_tenant_by_domain(db, domain)

    # SUPER_ADMIN / tenant admin 경로 — developer 없이 users 테이블만으로 인증.
    # /tenants API 가 만든 admin 유저, 또는 멀티 테넌트 운영자가 여기로 들어옴.
    direct_user_q = select(User).where(
        User.email == payload.email.lower(),
        User.is_active.is_(True),
    )
    if tenant is not None:
        # 도메인 매칭 → 해당 tenant 의 user 만. SUPER_ADMIN 은 도메인 매칭이 안 돼
        # 이 경로로 못 옴 (다음 폴백에서 잡힘).
        direct_user_q = direct_user_q.where(User.tenant_id == tenant.id)
    direct_user = (await db.execute(direct_user_q)).scalar_one_or_none()
    if (
        direct_user is not None
        and direct_user.hashed_password
        and direct_user.role in ("SUPER_ADMIN", "ADMIN")
    ):
        if verify_password(payload.password, direct_user.hashed_password):
            # L3 defensive — mapped_developer_id 누락이면 이메일 매칭 재시도.
            from app.services.user_developer_sync import ensure_user_dev_mapping
            if await ensure_user_dev_mapping(db, direct_user):
                await db.commit()
            token = create_access_token(
                subject=str(direct_user.id),
                extra={
                    "role": direct_user.role,
                    "kind": "user",
                    "tenant_id": str(direct_user.tenant_id)
                    if direct_user.tenant_id
                    else None,
                },
            )
            logger.info(
                "user 로그인: email=%s role=%s",
                direct_user.email, direct_user.role,
            )
            return TokenResponse(access_token=token)

    # SUPER_ADMIN 폴백: 도메인 매칭 실패해도 글로벌 lookup 으로 잡는다.
    if tenant is None:
        sa = (
            await db.execute(
                select(User).where(
                    User.email == payload.email.lower(),
                    User.is_active.is_(True),
                    User.role == "SUPER_ADMIN",
                )
            )
        ).scalar_one_or_none()
        if sa is not None and sa.hashed_password and verify_password(
            payload.password, sa.hashed_password
        ):
            token = create_access_token(
                subject=str(sa.id),
                extra={"role": "SUPER_ADMIN", "kind": "user", "tenant_id": None},
            )
            logger.info("super admin 로그인: email=%s", sa.email)
            return TokenResponse(access_token=token)

    # 일반 임직원(developer) 로그인 — 비번 권위는 developers.hashed_password.
    # 도메인이 매칭되면 해당 tenant 안에서만 검색.
    dev_q = select(Developer).where(Developer.company_email == payload.email)
    if tenant is not None:
        dev_q = dev_q.where(Developer.tenant_id == tenant.id)
    dev = (await db.execute(dev_q)).scalar_one_or_none()
    if dev is None or dev.status != "ACTIVE":
        logger.warning("로그인 실패(미존재/비활성): email=%s", payload.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    authed = False
    if dev.hashed_password:
        authed = verify_password(payload.password, dev.hashed_password)
    # 폴백: hashed_password 가 비어 있고 주민번호가 있으면, 입력 비번이
    # 주민번호 앞 6자리(생년월일)와 일치할 때만 허용 + 즉시 해시 저장.
    if not authed and not dev.hashed_password and dev.resident_number:
        first6 = dev.resident_number.split("-")[0].strip()
        if first6 and payload.password == first6:
            dev.hashed_password = hash_password(first6)
            authed = True
            logger.info(
                "developer 로그인 폴백(생년월일 해시 초기화): email=%s",
                dev.company_email,
            )
    if not authed:
        logger.warning("로그인 실패(비번 불일치): email=%s", payload.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # session-proxy users 행 확보 (FK 호환). 비번은 저장 안 하고 '' 로 둠.
    session_user = await find_or_create_user_for_developer(db, dev)
    # L3 defensive — mapped_developer_id 누락이면 이메일 매칭 재시도.
    from app.services.user_developer_sync import ensure_user_dev_mapping
    await ensure_user_dev_mapping(db, session_user)
    await db.commit()
    # tenant_id 우선순위: developer.tenant_id → session_user.tenant_id.
    tid = getattr(dev, "tenant_id", None) or session_user.tenant_id
    token = create_access_token(
        subject=str(session_user.id),
        extra={
            "role": dev.security_role,
            "kind": "developer",
            "tenant_id": str(tid) if tid else None,
        },
    )
    logger.info(
        "developer 로그인: email=%s name=%s role=%s",
        dev.company_email, dev.name, dev.security_role,
    )
    return TokenResponse(access_token=token)


@router.post("/token", response_model=TokenResponse, include_in_schema=False)
async def login_form(
    form: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)
):
    await db.execute(text("SELECT set_config('app.bypass_rls', 'true', false)"))
    result = await db.execute(select(User).where(User.email == form.username))
    user = result.scalar_one_or_none()
    if not user or not user.is_active or not verify_password(form.password, user.hashed_password):
        logger.warning("OAuth2 폼 로그인 실패: username=%s", form.username)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid")
    token = create_access_token(
        subject=str(user.id),
        extra={
            "role": user.role,
            "tenant_id": str(user.tenant_id) if user.tenant_id else None,
        },
    )
    logger.info("OAuth2 폼 로그인 성공: user_id=%s email=%s", user.id, user.email)
    return TokenResponse(access_token=token)


_RRN_PWD_MATCH_CACHE: dict[tuple, bool] = {}


def _password_matches_rrn_cached(dev_id, hashed: str, first6: str) -> bool:
    """주민번호 앞 6자리 == 현재 비밀번호 인지 (bcrypt verify) 캐시.

    bcrypt 는 의도적으로 느려 매 호출당 200-300ms — /auth/me 가 페이지마다
    호출되므로 사용자당 매번 이 비용을 치르면 페이지 진입이 체감상 느려짐.
    동일 (dev_id, hash) 조합은 결과가 같으므로 hash 가 바뀔 때까지 (=비밀번호
    변경) 캐시. 비밀번호가 바뀌면 hash 가 달라져 자동 cache miss.

    캐시 무한 증가 방지: 1000개 넘으면 통째로 비움 (LRU 도구 없이 단순화).
    """
    key = (dev_id, hashed)
    cached = _RRN_PWD_MATCH_CACHE.get(key)
    if cached is not None:
        return cached
    result = verify_password(first6, hashed)
    if len(_RRN_PWD_MATCH_CACHE) > 1000:
        _RRN_PWD_MATCH_CACHE.clear()
    _RRN_PWD_MATCH_CACHE[key] = result
    return result


@router.get("/me", response_model=MeOut)
async def me(
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.core.roles import permissions_for

    # must_change_password 플래그는 두 조건의 OR:
    #   1) 관리자가 재설정한 직후 (developers.password_reset_required = true)
    #   2) 현재 비밀번호가 주민번호 앞 6자리(생년월일) — 신입 초기 상태
    # SUPER_ADMIN/admin 시스템 계정은 별도 관리라 제외.
    must_change_password = False
    if current.role != "SUPER_ADMIN" and current.email != "admin":
        dev = (
            await db.execute(
                select(Developer).where(Developer.company_email == current.email)
            )
        ).scalar_one_or_none()
        if dev:
            if dev.password_reset_required:
                must_change_password = True
            elif dev.resident_number and dev.hashed_password:
                first6 = (dev.resident_number.split("-")[0]).strip()
                if first6 and _password_matches_rrn_cached(
                    dev.id, dev.hashed_password, first6
                ):
                    must_change_password = True
    # 사용자별 메뉴 추가 부여 — Sidebar 가 role 매트릭스와 OR 로 처리.
    from app.models import UserMenuGrant

    grant_rows = (
        await db.execute(
            select(UserMenuGrant.menu_key).where(
                UserMenuGrant.tenant_id == current.tenant_id,
                UserMenuGrant.user_id == current.id,
            )
        )
    ).all()
    menu_grants = [r[0] for r in grant_rows]

    # 매니저 자동 메뉴 부여 — 직속 부하(FULL_TIME ACTIVE) 1명 이상이면
    # 'utilization' (임직원 가동율) 메뉴를 본인 grants 에 자동 추가.
    # /weekly-reports 와 같은 매트릭스 절단면(team) 을 위해 — HR 전용으로 두면
    # 일반 매니저가 못 봄. menu_grants 는 추가만 (없는 항목 차단 X) 이라
    # role 매트릭스와 OR 처리되므로 안전.
    # 매니저 자동 메뉴 부여 — 직속 부하(FULL_TIME ACTIVE) 1명 이상이면
    # 'utilization' (임직원 가동율) 메뉴를 menu_grants 에 자동 추가.
    # menu_grants 는 isMenuVisible 가드에서 role 매트릭스와 **OR** 처리되므로
    # 추가만으로 충분 (없는 메뉴 차단 X). 매니저는 다른 곳에서 접근 권한이
    # 제어돼야 하면 별도 미들웨어를 쓸 것 — 여기는 가시성만 담당.
    #
    # 주의: Developer 는 파일 상단(line 13)에 import 돼 있음. 함수 안에서 재
    # import 하면 Python 스코프 분석이 Developer 를 함수 전역 local 로 잡아
    # 위쪽 line 252 의 `select(Developer)` 가 UnboundLocalError 가 됨.
    if current.mapped_developer_id:
        n = await db.scalar(
            select(func.count(Developer.id)).where(
                Developer.manager_id == current.mapped_developer_id,
                Developer.employment_type == "FULL_TIME",
                Developer.status == "ACTIVE",
            )
        )
        if n and n > 0 and "utilization" not in menu_grants:
            menu_grants.append("utilization")

    return MeOut(
        id=current.id,
        email=current.email,
        name=current.name,
        role=current.role,
        is_active=current.is_active,
        created_at=current.created_at,
        permissions=sorted(permissions_for(current.role)),
        mapped_developer_id=current.mapped_developer_id,
        must_change_password=must_change_password,
        tenant_id=current.tenant_id,
        is_super_admin=(current.role == "SUPER_ADMIN"),
        menu_grants=menu_grants,
    )


@router.get("/me/memo", response_model=MemoOut)
async def get_my_memo(current: User = Depends(get_current_user)):
    """사용자별 전역 스크래치패드 메모 조회."""
    return MemoOut(memo=current.memo or "", updated_at=current.memo_updated_at)


@router.patch("/me/memo", response_model=MemoOut)
async def update_my_memo(
    payload: MemoUpdate,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """사용자별 전역 스크래치패드 메모 저장. last-writer-wins."""
    from datetime import datetime, timezone

    current.memo = payload.memo
    current.memo_updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(current)
    return MemoOut(memo=current.memo or "", updated_at=current.memo_updated_at)


@router.post(
    "/change-password",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(forbid_in_demo_mode)],
)
async def change_password(
    payload: PasswordChangeRequest,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not verify_password(payload.current_password, current.hashed_password):
        logger.warning("비밀번호 변경 실패: user_id=%s (현재 비밀번호 불일치)", current.id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    current.hashed_password = hash_password(payload.new_password)
    await db.commit()
    logger.info("비밀번호 변경 완료: user_id=%s email=%s", current.id, current.email)


@router.get("/users", response_model=list[UserOut])
async def list_users(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """시스템 계정 목록.

    실질적으로 `email = 'admin'` 하나만 반환. 임직원 로그인 시 FK 호환을 위해
    자동 생성되는 session-proxy 행은 감사용으로 DB 에는 남지만 UI 에 노출하지
    않는다 (혼란 방지).
    """
    result = await db.execute(
        select(User).where(User.email == "admin").order_by(User.created_at.desc())
    )
    return list(result.scalars().all())


@router.get("/users/directory", response_model=list[UserOut])
async def list_users_directory(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """인증 사용자면 조회 가능한 활성 사용자 목록.

    비밀번호 해시는 UserOut 스키마에서 이미 제외됨.
    """
    stmt = select(User).where(User.is_active.is_(True)).order_by(User.name.asc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: UserCreate,
    current: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(select(User).where(User.email == payload.email))
    if existing.scalar_one_or_none():
        logger.warning(
            "사용자 등록 실패: 이미 등록된 email=%s (요청자=%s)", payload.email, current.id
        )
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=payload.email,
        name=payload.name,
        role=payload.role,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    # 자동 매핑 (L2) — 같은 이메일 developer 가 있으면 mapped_developer_id 채움.
    # helper 는 user 가 session 에 있는 상태에서 안전하게 변경만 가함.
    from app.services.user_developer_sync import ensure_user_dev_mapping
    await db.flush()  # user.id / tenant_id 보장
    await ensure_user_dev_mapping(db, user)
    await db.commit()
    await db.refresh(user)
    logger.info(
        "사용자 등록: email=%s name=%s role=%s (요청자=%s)",
        user.email,
        user.name,
        user.role,
        current.id,
    )
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: UUID,
    payload: UserUpdate,
    current: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """사용자 기본 정보(name/role/is_active) 수정 — 관리자만."""
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    data = payload.model_dump(exclude_unset=True)
    # 본인 계정을 비활성화하거나 권한을 낮추는 것을 막아 자기 잠금(lockout) 방지.
    if user.id == current.id:
        if "is_active" in data and not data["is_active"]:
            raise HTTPException(400, detail="본인 계정은 비활성화할 수 없습니다.")
        if "role" in data and data["role"] != current.role:
            raise HTTPException(400, detail="본인의 권한은 변경할 수 없습니다.")

    # 마지막 ADMIN 은 해제/비활성화 금지 — 시스템 잠금 방지.
    losing_admin = (
        user.role == "ADMIN"
        and (
            ("role" in data and data["role"] != "ADMIN")
            or ("is_active" in data and not data["is_active"])
        )
    )
    if losing_admin:
        active_admins = (
            await db.execute(
                select(func.count(User.id)).where(
                    User.role == "ADMIN", User.is_active.is_(True)
                )
            )
        ).scalar_one()
        if active_admins <= 1:
            raise HTTPException(
                400,
                detail="마지막 관리자(ADMIN) 는 해제하거나 비활성화할 수 없습니다.",
            )

    for k, v in data.items():
        setattr(user, k, v)
    await db.commit()
    await db.refresh(user)
    logger.info(
        "사용자 수정: id=%s 변경필드=%s (수정자=%s)",
        user.id,
        list(data.keys()),
        current.id,
    )
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: UUID,
    current: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """사용자 완전 삭제 — 관리자만. 본인 / 초기 관리자 계정은 삭제 불가."""
    if user_id == current.id:
        raise HTTPException(400, detail="본인 계정은 삭제할 수 없습니다.")
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    initial_admin_email = get_settings().auth.initial_admin.email
    if user.email == initial_admin_email:
        raise HTTPException(
            400, detail="기본 관리자 계정은 삭제할 수 없습니다."
        )
    logger.warning(
        "사용자 삭제: id=%s email=%s (삭제자=%s)", user.id, user.email, current.id
    )
    await db.delete(user)
    await db.commit()


@router.post(
    "/users/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT
)
async def admin_reset_password(
    user_id: UUID,
    payload: UserPasswordReset,
    current: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """관리자가 사용자 비밀번호를 강제 재설정."""
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.hashed_password = hash_password(payload.new_password)
    await db.commit()
    logger.info(
        "사용자 비밀번호 관리자 재설정: id=%s email=%s (재설정자=%s)",
        user.id,
        user.email,
        current.id,
    )
