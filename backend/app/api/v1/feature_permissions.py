"""기능 권한 API.

페이지 내부의 버튼·필드·탭 노출을 보안등급(Security Role) 별로 설정.

`menu_permissions` 가 사이드바 노출만 제어한다면, 이 테이블은 같은 페이지를 본
사용자가 그 안에서 무엇을 할 수 있는지 결정한다. 예:
- `employees.salary.view` — 급여 컬럼·차트 표시
- `employees.password.reset` — 비밀번호 재설정 버튼
- `employees.tab.passport` — 여권 정보 탭 노출 (본인 예외는 코드로 별도 처리)

Endpoints:
- `GET  /feature-permissions` — 모든 인증 사용자. { feature_key: [role, ...] } 반환.
  테이블이 비어 있으면 DEFAULT_FEATURE_PERMISSIONS 를 그 자리에서 seed.
- `PUT  /feature-permissions` — ADMIN 전용. 전체 맵을 replace.

주의:
- ADMIN 은 항상 모든 기능 허용 (저장하지 않음).
- `feature_key` 의 화이트리스트는 프런트 `feature-registry.ts` 와 동기화 필요.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.core.roles import ROLES
from app.models import FeaturePermission, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feature-permissions", tags=["feature-permissions"])


# 기본값 — 임직원 메뉴의 9개 기능. 운영자가 한 번이라도 PUT 하면 이후 DB 우선.
#
# 새 기능을 추가할 때는: (1) 프런트 `feature-registry.ts` 에 엔트리 추가,
# (2) 아래 dict 에 기본 역할 목록 추가. 두 곳이 어긋나면 기본값 반환 시 일부 기능
# 권한이 누락된다.
DEFAULT_FEATURE_PERMISSIONS: dict[str, list[str]] = {
    # 임직원 신규 등록 — HR 전용 (ADMIN 자동).
    "employees.create": ["HR"],
    # 급여 컬럼·차트 조회 — HR 전용. 마스킹 해제.
    "employees.salary.view": ["HR"],
    # 급여 입력·수정 — HR 전용.
    "employees.salary.edit": ["HR"],
    # 보안 역할(security_role) 변경 — HR 전용. HR→ADMIN 차단은 코드 invariant.
    "employees.role.edit": ["HR"],
    # 비밀번호 재설정 버튼 — HR 전용. HR→ADMIN 대상자 차단은 코드 invariant.
    "employees.password.reset": ["HR"],
    # 여권 정보 탭 — HR 전용. 본인은 자기 여권 항상 열람 (코드 hard).
    "employees.tab.passport": ["HR"],
    # 비상연락처 탭 — HR 전용. 본인 예외 동일.
    "employees.tab.emergency": ["HR"],
    # 면담(HR 평가) 탭 — HR 전용. 본인 예외 없음 (의도된 비공개).
    "employees.tab.interview": ["HR"],
    # 결재선 변경 — 기본 비허용 (ADMIN 만). 운영자가 필요 시 HR 등록.
    "employees.approvers.edit": [],
    # KB 작성·편집 — SUPPORT/HR 기본 부여. SALES/ETC 는 조회만.
    # ADMIN/SUPER_ADMIN 은 코드 invariant 로 항상 통과. 삭제는 kb.delete 로 분리.
    "kb.write": ["SUPPORT", "HR"],
    # KB 삭제 — write 와 분리해 오삭제 방지 (HR 만). 작성자 본인은 항상 가능.
    "kb.delete": ["HR"],
    # KB visibility=manager|admin 글 작성·승격 — 전사 공개 차단. HR 만.
    "kb.publish_admin": ["HR"],
    # 고객사 현황 카드 작성·편집 — SUPPORT/HR 기본. SALES/ETC 조회만.
    "customer-status.write": ["SUPPORT", "HR"],
    # 고객사 현황 삭제 — write 와 분리. 작성자 본인은 항상 가능.
    "customer-status.delete": ["HR"],
    # 기술지원 케이스 생성·편집 — SUPPORT/HR. SALES/ETC 조회만.
    # ADMIN 은 invariant 로 통과. menu_permissions 가드와 별개로 mutation 통제.
    "support_cases.write": ["SUPPORT", "HR", "SALES"],
    # 케이스 삭제 — 별도. 오삭제 방지로 HR 만. 작성자 본인 예외 없음.
    "support_cases.delete": ["HR"],
    # 케이스 종료(CLOSED 전환) — 매니저급. SUPPORT 의 책임자 + HR.
    "support_cases.close": ["SUPPORT", "HR"],
    # 활동 로그 작성·편집 — SUPPORT/HR/SALES.
    "support_logs.write": ["SUPPORT", "HR", "SALES"],
    # 활동 로그 삭제 — HR 만.
    "support_logs.delete": ["HR"],
}


async def _load_tenant_features(
    db: AsyncSession, tenant_id
) -> dict[str, list[str]]:
    """tenant 의 feature_permissions 맵을 dict 로 로드.

    빈 상태면 `DEFAULT_FEATURE_PERMISSIONS` 를 seed 후 반환.
    seed 이후에는 DB 가 진실의 원천 — `require_feature`/`has_feature` 도 같은 테이블만 본다.
    """
    rows = list(
        (
            await db.execute(
                select(FeaturePermission).where(
                    FeaturePermission.tenant_id == tenant_id
                )
            )
        ).scalars()
    )
    if rows:
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r.feature_key, []).append(r.role)
        # 등록되지 않은 키도 빈 배열로 노출 — 설정 UI 에서 매트릭스 cell 이 그려지도록.
        for key in DEFAULT_FEATURE_PERMISSIONS:
            out.setdefault(key, [])
        return out

    for key, roles in DEFAULT_FEATURE_PERMISSIONS.items():
        for r in roles:
            db.add(
                FeaturePermission(tenant_id=tenant_id, feature_key=key, role=r)
            )
    await db.commit()
    logger.info(
        "기능 권한 기본값 seed: tenant=%s features=%d",
        tenant_id,
        len(DEFAULT_FEATURE_PERMISSIONS),
    )
    return {k: list(v) for k, v in DEFAULT_FEATURE_PERMISSIONS.items()}


@router.get("", response_model=dict[str, list[str]])
async def get_feature_permissions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, list[str]]:
    """현재 tenant 의 기능 권한 맵을 조회.

    테이블이 비어 있으면 기본값을 seed 후 반환.
    """
    return await _load_tenant_features(db, user.tenant_id)


@router.put("", response_model=dict[str, list[str]])
async def set_feature_permissions(
    payload: dict[str, list[str]],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, list[str]]:
    """기능 권한 맵 전체를 교체 (ADMIN only).

    Validation:
    - `feature_key` 는 비어 있지 않은 문자열.
    - `roles` 는 list. ADMIN 은 조용히 필터, 알 수 없는 역할은 400.
    - 같은 role 을 한 feature_key 에 두 번 넣어도 normalize 단계에서 중복 제거.
    """
    cleaned: dict[str, list[str]] = {}
    for key, roles in payload.items():
        if not isinstance(key, str) or not key:
            raise HTTPException(400, f"잘못된 기능 키: {key!r}")
        if not isinstance(roles, list):
            raise HTTPException(400, f"역할 목록이 배열이 아닙니다: {key}")
        normalized: list[str] = []
        for r in roles:
            if r == "ADMIN":
                continue
            if r not in ROLES:
                raise HTTPException(400, f"허용되지 않은 역할: {r}")
            if r not in normalized:
                normalized.append(r)
        cleaned[key] = normalized

    # tenant 별 격리 — 다른 tenant 의 권한 행은 건드리지 않는다.
    await db.execute(
        delete(FeaturePermission).where(
            FeaturePermission.tenant_id == user.tenant_id
        )
    )
    total_rows = 0
    for key, roles in cleaned.items():
        for r in roles:
            db.add(
                FeaturePermission(
                    tenant_id=user.tenant_id, feature_key=key, role=r
                )
            )
            total_rows += 1
    await db.commit()

    logger.info(
        "기능 권한 저장: features=%d rows=%d 관리자=%s",
        len(cleaned),
        total_rows,
        user.id,
    )
    return cleaned
