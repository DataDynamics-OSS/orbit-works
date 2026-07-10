"""메뉴 권한 API.

Sidebar 메뉴의 표시 여부를 보안등급(Security Role) 별로 설정한다.

Endpoints:
- `GET  /menu-permissions` — 모든 인증 사용자. { menu_key: [role, ...] } 반환.
  테이블이 비어 있으면 하드코딩 기본값(DEFAULT_MENU_PERMISSIONS) 을 반환.
  프런트는 이 맵과 `/auth/me.role` 을 교차해 메뉴를 필터링.
- `PUT  /menu-permissions` — ADMIN 전용. 전체 맵을 replace 방식으로 저장
  (기존 행 전부 삭제 → 새 값 insert). 작은 테이블(수십 행)이라 이 방식이
  충돌·부분저장 걱정 없이 가장 단순.

주의:
- ADMIN 은 프런트 가드에서 항상 전체 메뉴를 보므로 이 테이블에 저장하지 않는다.
  PUT 요청에 ADMIN 이 섞여 들어와도 조용히 필터 아웃.
- `menu_key` 의 화이트리스트는 프런트의 `menu-registry.ts` 와 백엔드의 DEFAULT_MENU_PERMISSIONS
  두 곳에서 관리. 불일치하면 프런트는 매칭 없는 키를 무시한다.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.core.roles import ROLES
from app.models import MenuPermission, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/menu-permissions", tags=["menu-permissions"])


# 기본값 — 테이블이 비어 있을 때(초기 설치 상태) 반환. `ROLE_PERMS` 초기 매트릭스를
# 메뉴 키로 투영한 값. ADMIN 은 프런트 가드에서 암묵 허용이라 목록에 포함하지 않음.
#
# 새 메뉴를 추가할 때는: (1) 프런트 `menu-registry.ts` 에 엔트리 추가,
# (2) 아래 dict 에 기본 역할 목록 추가. 두 곳이 어긋나면 기본값 반환 시 일부 메뉴가
# UI 에 나타나지 않는다.
DEFAULT_MENU_PERMISSIONS: dict[str, list[str]] = {
    "dashboard": ["SALES", "HR", "SUPPORT", "ETC"],
    "notice": ["SALES", "HR", "SUPPORT", "ETC"],
    "board": ["SALES", "HR", "SUPPORT", "ETC"],
    "opportunities": ["SALES"],
    "announcements": ["SALES", "HR", "SUPPORT", "ETC"],
    "emails": ["SALES", "MARKETING", "HR", "SUPPORT", "ETC"],
    "licenses": ["SALES", "SUPPORT"],
    "licenses.calendar": ["SALES", "SUPPORT"],
    "quotes": ["SALES"],
    "invoices": ["SALES"],
    "tax_invoices": ["SALES", "HR"],
    "tax_invoices.dashboard": ["SALES", "HR"],
    # 클라우드 비용은 자격증명 노출 우려가 있어 ADMIN 외엔 기본 미공개.
    # 대시보드 카드 등 단순 시청 권한이 필요하면 운영자가 메뉴 권한에서 부여.
    "cloud_costs": [],
    # 서버 호스팅 — IP·스펙 등 인프라 정보. 기본 ADMIN 전용 (cloud_costs 와 동일 정책).
    "server_hostings": [],
    # 임직원 가동율 — HR 가 기본. ADMIN 자동. 매니저는 /auth/me 가 menu_grants 에
    # 'utilization' 을 자동 추가 (직속 부하 1명 이상 FULL_TIME ACTIVE 가 있으면).
    "utilization": ["HR"],
    "vendor_bills": ["HR"],
    "developers": ["HR"],
    "projects": ["SALES", "HR"],
    "assignments": ["HR"],
    "assets": ["HR"],
    "customers": ["SALES", "SUPPORT"],
    "contacts": ["SALES", "HR", "SUPPORT", "ETC"],
    "bank_accounts": ["HR"],
    "loans": ["HR"],
    "patents": ["SALES", "HR"],
    "payroll": ["HR"],
    "leaves": ["HR"],
    # 임직원 평가 — HR 가 cycle 관리·calibration. 매니저/본인 view 는 페이지
    # 안에서 role 별 탭으로 자동 분기 (메뉴는 모든 임직원에게 노출).
    "evaluations": ["SALES", "HR", "SUPPORT", "ETC"],
    # 결재 — 모든 임직원이 신청·결재 가능. 양식 편집은 Settings → 결재 양식에서 ADMIN/HR 만.
    "approvals": ["SALES", "HR", "SUPPORT", "ETC"],
    # 목표 — 모든 임직원이 본인 목표 작성·매니저는 부하 조회·HR/ADMIN 은 회사 목표 작성.
    "goals": ["SALES", "HR", "SUPPORT", "ETC"],
    # 결재선 — 회사 조직도. 모든 임직원이 조회 가능 (민감 정보는 카드 사이드 패널에서 HR/ADMIN 게이트).
    "org_chart": ["SALES", "HR", "SUPPORT", "ETC"],
    # 도서 — 회사 도서 대장. 모든 임직원이 조회 가능. 등록·삭제는 HR/ADMIN.
    "books": ["SALES", "HR", "SUPPORT", "ETC"],
    # 출장 — 본인 출장만 조회·수정. 모든 임직원에게 메뉴 노출.
    "trips": ["SALES", "HR", "SUPPORT", "ETC"],
    "events": ["HR"],
    "support_cases": ["SALES", "HR", "SUPPORT"],
    "support_logs": ["SALES", "HR", "SUPPORT"],
    # 고객사 현황 — 고객사 × 프로젝트 × 시스템 단위 운영 카드. 모든 임직원 조회.
    # 작성·편집은 feature_permissions 의 customer-status.write 로 SUPPORT/HR 기본 부여.
    "customer-status": ["SALES", "HR", "SUPPORT", "ETC"],
    # 지식 베이스 (KB) — 벤더 자료 + 사내 트러블슈팅 노하우. 모든 임직원 조회.
    # 작성·편집은 feature_permissions 의 kb.write 로 SUPPORT/HR 기본 부여.
    "kb": ["SALES", "HR", "SUPPORT", "ETC"],
    "meetings": ["SALES", "HR", "SUPPORT", "ETC"],
    "meeting_notes": ["SALES", "HR", "SUPPORT", "ETC"],
    "weekly_reports": ["SALES", "HR", "SUPPORT", "ETC"],
    "my_actions": ["SALES", "HR", "SUPPORT", "ETC"],
    # 회사 차량 — 운영 관리는 HR. 다른 역할은 운영자가 필요 시 부여.
    "cars": ["HR"],
    # 보험 — 재무·인사 마스터. HR 외엔 미공개.
    "insurances": ["HR"],
    "worksites": ["HR"],
    "leave_types": ["HR"],
    "attendance.admin": ["HR"],
    # ADMIN 전용 메뉴 — 기본적으로는 누구에게도 허용하지 않는다 (ADMIN 만 자동 표시).
    "users": [],
    "calendar": ["HR"],
    "catalog.products": ["HR"],
    "alarms": [],
    "settings": [],
    # 권한 관리 — ADMIN 자동 + HR (사용자별 추가 메뉴 부여에 HR 필요).
    # ADMIN-only 탭(메뉴/기능 권한 매트릭스, 추가 권한)은 페이지 내부에서 다시 가드.
    "permissions": ["HR"],
    # 북마크(공용) — 회사 공용 북마크 관리. ADMIN 자동 + HR.
    "settings.bookmarks": ["HR"],
    # 계정과목 — 재무 마스터. ADMIN/HR 외엔 미공개.
    "settings.accounts": ["HR"],
    # 정부 R&D 예산 — 재무 마스터. ADMIN/HR 만.
    "budget.rnd": ["HR"],
    # 운영 예산 계획 — 재무 마스터. ADMIN/HR 만.
    "budget.calc": ["HR"],
    # 마케팅 — 기존 고객 대상 캠페인. MARKETING 역할이 편집, SALES 는 읽기.
    "marketing.dashboard": ["MARKETING", "SALES"],
    "marketing.campaigns": ["MARKETING", "SALES"],
    "marketing.emails": ["MARKETING"],
    "marketing.segments": ["MARKETING", "SALES"],
    "marketing.google_ads": ["MARKETING", "SALES"],
}


async def _load_tenant_perms(
    db: AsyncSession, tenant_id
) -> dict[str, list[str]]:
    """tenant 의 menu_permissions 맵을 dict 로 로드.

    빈 상태면 `DEFAULT_MENU_PERMISSIONS` 를 그 자리에서 seed 하고 그 값을 반환.
    seed 이후에는 DB 가 진실의 원천 — 백엔드 `require_menu` 가드도 같은 테이블만 본다.
    """
    rows = list(
        (
            await db.execute(
                select(MenuPermission).where(MenuPermission.tenant_id == tenant_id)
            )
        ).scalars()
    )
    if rows:
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r.menu_key, []).append(r.role)
        return out

    # 최초 호출 — 기본값을 DB 에 seed. 이후 PUT 으로 자유 편집.
    for key, roles in DEFAULT_MENU_PERMISSIONS.items():
        for r in roles:
            db.add(MenuPermission(tenant_id=tenant_id, menu_key=key, role=r))
    await db.commit()
    logger.info("메뉴 권한 기본값 seed: tenant=%s menus=%d", tenant_id, len(DEFAULT_MENU_PERMISSIONS))
    return {k: list(v) for k, v in DEFAULT_MENU_PERMISSIONS.items()}


@router.get("", response_model=dict[str, list[str]])
async def get_menu_permissions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, list[str]]:
    """현재 tenant 의 메뉴 권한 맵을 조회.

    테이블이 비어 있으면 기본값을 seed 후 반환. 한 번 seed 되면 이후 PUT 으로만 변경.
    """
    return await _load_tenant_perms(db, user.tenant_id)


@router.put("", response_model=dict[str, list[str]])
async def set_menu_permissions(
    payload: dict[str, list[str]],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, list[str]]:
    """메뉴 권한 맵 전체를 교체 (ADMIN only).

    클라이언트는 현재 전체 상태를 보내야 하며, 서버는 기존 행을 전부 삭제한 뒤
    payload 를 그대로 insert 한다 (부분 업데이트·diff 계산 불필요).

    Validation:
    - `menu_key` 는 비어 있지 않은 문자열.
    - `roles` 는 list. ADMIN 은 조용히 필터, 알 수 없는 역할은 400.
    - 같은 role 을 한 menu_key 에 두 번 넣어도 normalize 단계에서 중복 제거.
    """
    # 입력 검증 + 정규화. 오류가 있으면 DB 변경 전에 바로 400 으로 끊는다.
    cleaned: dict[str, list[str]] = {}
    for key, roles in payload.items():
        if not isinstance(key, str) or not key:
            raise HTTPException(400, f"잘못된 메뉴 키: {key!r}")
        if not isinstance(roles, list):
            raise HTTPException(400, f"역할 목록이 배열이 아닙니다: {key}")
        normalized: list[str] = []
        for r in roles:
            # ADMIN 은 암묵 허용이라 저장 대상 아님 — 실수로 넘어와도 무시.
            if r == "ADMIN":
                continue
            if r not in ROLES:
                raise HTTPException(400, f"허용되지 않은 역할: {r}")
            if r not in normalized:
                normalized.append(r)
        cleaned[key] = normalized

    # 전체 교체: 기존 rows 삭제 → 새 rows insert. 한 트랜잭션 안에서 atomic.
    # tenant 별 격리 — 다른 tenant 의 권한 행은 건드리지 않는다.
    await db.execute(
        delete(MenuPermission).where(MenuPermission.tenant_id == user.tenant_id)
    )
    total_rows = 0
    for key, roles in cleaned.items():
        for r in roles:
            db.add(
                MenuPermission(tenant_id=user.tenant_id, menu_key=key, role=r)
            )
            total_rows += 1
    await db.commit()

    # 감사 로그 — 누가 언제 몇 개 키를 저장했는지. 실제 매트릭스는 크지 않지만
    # 무한 로그를 피하기 위해 키 개수·행 개수만 기록.
    logger.info(
        "메뉴 권한 저장: menus=%d rows=%d 관리자=%s",
        len(cleaned),
        total_rows,
        user.id,
    )
    return cleaned
