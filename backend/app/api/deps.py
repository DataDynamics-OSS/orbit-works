import logging

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.roles import has as role_has
from app.core.security import decode_token
from app.core.tenant_context import current_user_grants
from app.models import FeaturePermission, MenuPermission, User, UserFeatureGrant

logger = logging.getLogger(__name__)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    try:
        payload = decode_token(token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from exc

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # 요청 진입 시 grants 한 번 로드 → ContextVar. hot path (e.g. _can_read_report)
    # 에서 DB 재조회 없이 검사 가능. ADMIN/SUPER_ADMIN 도 동일하게 로드하지만
    # 어차피 권한 체크에서 role 이 먼저 통과되어 grants 값은 사실상 미사용.
    grant_rows = await db.execute(
        select(UserFeatureGrant.feature_key).where(
            UserFeatureGrant.tenant_id == user.tenant_id,
            UserFeatureGrant.user_id == user.id,
        )
    )
    current_user_grants.set(frozenset(grant_rows.scalars().all()))
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """ADMIN 전용 — tenant 운영자. SUPER_ADMIN 은 도메인 데이터 비대상이라 별도."""
    if user.role != "ADMIN":
        logger.warning(
            "ADMIN 전용 차단: role=%s user=%s", user.role, user.id
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return user


def forbid_in_demo_mode() -> None:
    """데모 환경(`app.demo_mode: true`)에서 호출 시 403.

    데모 사이트는 매일 03:00 KST 데이터·비밀번호가 reset 되므로 사용자가
    비밀번호를 변경하면 본인·다른 방문자가 모두 다음 reset 까지 못 들어옴.
    비밀번호 변경 류 endpoint 에 의존성으로 끼움.
    """
    from app.core.config import get_settings

    if get_settings().app.demo_mode:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "데모 환경에서는 비밀번호를 변경할 수 없습니다. "
                "매일 03:00 KST 에 데이터가 초기화됩니다."
            ),
        )


async def require_super_admin(user: User = Depends(get_current_user)) -> User:
    """SUPER_ADMIN 전용 — 멀티 테넌트 운영자. 도메인 데이터 절대 비노출."""
    if user.role != "SUPER_ADMIN":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Super admin only"
        )
    return user


def require_permission(perm: str):
    """역할→권한 매트릭스 기반 엔드포인트 가드.

    사용 예:
        @router.post("/leaves/balances/initialize")
        async def init(..., admin: User = Depends(require_permission("leaves.admin"))):
            ...

    역할 값이 매트릭스에 없거나 해당 perm 을 갖지 않으면 403.
    ADMIN 은 모든 권한을 자동 포함.
    """

    async def _dep(user: User = Depends(get_current_user)) -> User:
        if not role_has(user.role, perm):
            # 인증된 사용자가 권한 매트릭스에 의해 차단된 케이스 — 의도된 차단/오용
            # 둘 다 운영자가 추적해야 하므로 WARNING audit trail.
            logger.warning(
                "권한 차단 (require_permission): perm=%s role=%s user=%s",
                perm, user.role, user.id,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"권한 없음 ({perm})",
            )
        return user

    return _dep


async def has_feature(
    db: AsyncSession, user: User, feature_key: str
) -> bool:
    """기능 권한 inline 체크 — 의존성으로 못 쓰는 컨텍스트에서 사용.

    `require_feature` 는 endpoint 전체를 차단하는 데 쓰지만, 한 endpoint 안에서
    필드 마스킹·동작 분기처럼 *부분* 게이트가 필요할 때는 이 함수를 직접 호출.

    예: developers.list 의 salary 컬럼 마스킹, PATCH 의 salary 필드 변경 가드.

    동작:
      - ADMIN/SUPER_ADMIN → True (코드 invariant, DB 미조회)
      - 해당 (tenant, feature_key, role) row 존재 → True
      - 0건이면 빈 테이블 여부 추가 확인 → 빈 테이블이면 DEFAULT 로 fail-safe.
        (sidebar 가 menu/feature_permissions 를 첫 GET 으로 seed 하지만, 그 전에
        다른 API 가 먼저 호출되는 race 를 대비.)
    """
    if user.role in ("ADMIN", "SUPER_ADMIN"):
        return True
    row = await db.execute(
        select(FeaturePermission).where(
            FeaturePermission.tenant_id == user.tenant_id,
            FeaturePermission.feature_key == feature_key,
            FeaturePermission.role == user.role,
        )
    )
    if row.scalar_one_or_none() is not None:
        return True
    # 빈 테이블 — seed 전 fail-safe.
    any_row = await db.execute(
        select(FeaturePermission.feature_key)
        .where(FeaturePermission.tenant_id == user.tenant_id)
        .limit(1)
    )
    if any_row.scalar_one_or_none() is None:
        from app.api.v1.feature_permissions import DEFAULT_FEATURE_PERMISSIONS

        return user.role in DEFAULT_FEATURE_PERMISSIONS.get(feature_key, [])
    return False


def require_feature(feature_key: str):
    """Settings > 기능 권한 매트릭스 기반 endpoint 가드.

    `feature_permissions` 테이블에서 `(tenant_id, feature_key, user.role)` 조회.
    ADMIN/SUPER_ADMIN 항상 통과. 권한 없으면 403.

    사용 예:
        @router.post("/{dev_id}/password/reset")
        async def reset(..., user: User = Depends(require_feature("employees.password.reset"))):
            ...
    """

    async def _dep(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if await has_feature(db, user, feature_key):
            return user
        logger.warning(
            "기능 권한 차단 (require_feature): feature=%s role=%s user=%s",
            feature_key, user.role, user.id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"기능 접근 권한 없음 ({feature_key})",
        )

    return _dep


def require_menu(menu_key: str):
    """Settings > 메뉴 권한 매트릭스 기반 라우터 가드.

    프런트의 사이드바 가시성·route guard 와 같은 진실의 원천(menu_permissions)
    을 백엔드 API 까지 적용해 curl 우회를 차단하는 2차선.

    사용처:
      - `router.py` 의 `include_router(..., dependencies=[Depends(require_menu("..."))])`
        형태로 한 라우터의 모든 endpoint 에 일괄 부착.
      - **단, 같은 라우터 안에 다른 메뉴/공통 endpoint 가 섞여 있으면 부착 금지.**
        예: `developers.router` 는 `/me/*`·`/org-chart`·`/directory` 가 함께 있어
        router-wide 게이트를 걸면 ETC 사용자의 본인 비번 변경·결재선 조회까지 차단됨
        (실제 사고 — 커밋 e72cefd 로 게이트 제거). 이 경우 endpoint 별 require_feature
        로만 보호하고 router-wide 게이트는 생략.

    동작:
      - ADMIN/SUPER_ADMIN → 통과
      - (tenant, menu_key, role) row 존재 → 통과
      - 빈 테이블 (seed 전) → DEFAULT_MENU_PERMISSIONS 로 fail-safe 판단
      - 외 → 403 + WARNING audit log
    """

    async def _dep(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if user.role in ("ADMIN", "SUPER_ADMIN"):
            return user
        row = await db.execute(
            select(MenuPermission).where(
                MenuPermission.tenant_id == user.tenant_id,
                MenuPermission.menu_key == menu_key,
                MenuPermission.role == user.role,
            )
        )
        if row.scalar_one_or_none() is not None:
            return user
        # user_menu_grants — 개별 사용자에게 명시적으로 부여된 메뉴. Sidebar
        # 의 OR 필터와 일관성. 임직원 상세의 '추가 메뉴' 에서 부여한 row 가 여기서 통과.
        from app.models import UserMenuGrant

        grant = await db.execute(
            select(UserMenuGrant.menu_key).where(
                UserMenuGrant.tenant_id == user.tenant_id,
                UserMenuGrant.user_id == user.id,
                UserMenuGrant.menu_key == menu_key,
            )
        )
        if grant.scalar_one_or_none() is not None:
            return user
        # 0건 매칭 — 두 가지 가능성을 구분: (1) 진짜 권한 없음, (2) seed 전 빈 테이블.
        # 빈 테이블이면 DEFAULT_MENU_PERMISSIONS 로 판단 (frontend 가 sidebar 로드 시
        # seed 하지만, 그 전에 API 가 먼저 호출될 수 있어 fail-safe 필요).
        any_row = await db.execute(
            select(MenuPermission.menu_key)
            .where(MenuPermission.tenant_id == user.tenant_id)
            .limit(1)
        )
        if any_row.scalar_one_or_none() is None:
            # 순환 import 회피 — lazy import.
            from app.api.v1.menu_permissions import DEFAULT_MENU_PERMISSIONS

            if user.role in DEFAULT_MENU_PERMISSIONS.get(menu_key, []):
                return user
        logger.warning(
            "메뉴 접근 차단 (require_menu): menu=%s role=%s user=%s",
            menu_key, user.role, user.id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"메뉴 접근 권한 없음 ({menu_key})",
        )

    return _dep
