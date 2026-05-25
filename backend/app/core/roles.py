"""Security Role 매트릭스.

단일 역할 모델: `users.role` 은 아래 5가지 중 하나.
ADMIN 은 항상 모든 권한의 superset (하드코딩).

권한(permission) 은 `domain.action` 명명 규칙을 따르고, 각 역할이 어떤
권한을 갖는지 `ROLE_PERMS` 에 명시한다. 수정 시 프런트의 사이드바·페이지
가드가 `/auth/me.permissions` 로만 권한을 판단하므로 **이 파일이 단일
정답 원천(single source of truth)** 이다.
"""

from __future__ import annotations


# 실제 값 — DB CHECK 제약과 반드시 일치시킬 것.
#
# SUPER_ADMIN 은 멀티 테넌트 운영자 — `tenants.manage` 단 1개 권한만 가짐.
# tenant 의 일반 도메인 데이터(직원·고객·게시판 등)는 절대 보지 못한다.
# tenant_id IS NULL 로만 존재.
ROLES: tuple[str, ...] = (
    "SUPER_ADMIN",
    "ADMIN",
    "SALES",
    "MARKETING",
    "HR",
    "SUPPORT",
    "ETC",
)

# 역할별 권한. ADMIN 은 아래 dict 에 정의된 **모든** 권한 + 향후 추가될 권한 포함.
# 문자열은 `domain.action` 형식. 일부는 "_이름.write" 같이 특정 작업만 표현.
_BASE_ALL_USERS = {
    # 모든 사용자가 가진 기본 권한 (로그인만 되면 가능).
    "notice.read",
    "board.read",
    "board.write",
    "leaves.self",  # 본인 연차 조회·신청
    "meetings.self",  # 본인 회의실 예약
    "announcements.read",  # 사업공고 조회 + 북마크
}

ROLE_PERMS: dict[str, set[str]] = {
    # SUPER_ADMIN — 오직 tenant 관리. _BASE_ALL_USERS 도 포함하지 않음 (도메인 격리).
    "SUPER_ADMIN": {"tenants.manage"},
    "ADMIN": set(),  # 아래에서 동적으로 전체 채움
    "SALES": _BASE_ALL_USERS | {
        "opportunities.manage",
        "customers.manage",
        "licenses.manage",
        "quotes.manage",
        "invoices.manage",
        "projects.manage",
        "tax_invoices.read",
        "tax_invoices.manage",
        "announcements.manage",
        "patents.manage",
        "support.manage",
        # 마케팅 캠페인·세그먼트 열람 (편집은 MARKETING).
        "marketing.read",
    },
    # 마케팅 — 고객 대상 캠페인(이메일·Google Ads) 관리. 고객사·연락처 열람 가능.
    "MARKETING": _BASE_ALL_USERS | {
        "marketing.manage",
        "marketing.read",
        # 캠페인 수신자 추출을 위해 고객사·연락처 읽기 필요 (편집은 SALES/HR).
        "customers.read",
    },
    "HR": _BASE_ALL_USERS | {
        "developers.manage",
        "projects.manage",
        "assignments.manage",
        "payroll.manage",
        "leaves.admin",
        "leaves.approve",
        "meetings.rooms.manage",
        "holidays.manage",
        "assets.manage",
        "worksites.manage",
        "bank_accounts.manage",
        "leave_types.manage",
        "loans.manage",
        "books.manage",
        "tax_invoices.read",
        "tax_invoices.manage",
        "vendor_bills.manage",
        "events.manage",
        "attendance.admin",
        "patents.manage",
        "support.manage",
        # 고객사 관리 — HR 도 등록·삭제·활동로그 작성 가능 (ETC 만 차단).
        "customers.manage",
        # 임직원 평가 — HR 가 cycle 관리·calibration·등급 결정.
        "evaluations.manage",
    },
    "SUPPORT": _BASE_ALL_USERS | {
        "customers.manage",
        "licenses.manage",
        "meetings.rooms.manage",
        "support.manage",
    },
    "ETC": _BASE_ALL_USERS | set(),
}

# ADMIN 전용 권한 — 다른 역할엔 절대 주지 않음.
ADMIN_ONLY: set[str] = {
    "users.manage",
    "settings.manage",
    "notice.write",
}

# ADMIN = 모든 도메인 역할(SALES/HR/SUPPORT/ETC) 의 합 ∪ ADMIN_ONLY (superset).
# SUPER_ADMIN 의 `tenants.manage` 는 의도적으로 제외 — ADMIN(테넌트 내 최고권한)과
# SUPER_ADMIN(테넌트 관리) 은 직교(orthogonal) 권한.
_admin_perms: set[str] = set(ADMIN_ONLY)
for r, perms in ROLE_PERMS.items():
    if r in ("ADMIN", "SUPER_ADMIN"):
        continue
    _admin_perms |= perms
ROLE_PERMS["ADMIN"] = _admin_perms


def permissions_for(role: str) -> set[str]:
    """지정 역할의 권한 전체를 반환. 알 수 없는 역할은 ETC 취급."""
    return ROLE_PERMS.get(role, ROLE_PERMS["ETC"])


def has(role: str, perm: str) -> bool:
    """`role` 이 `perm` 권한을 가지는지 True/False."""
    return perm in permissions_for(role)


def role_labels() -> dict[str, str]:
    """UI 드롭다운용 한국어 라벨."""
    return {
        "SUPER_ADMIN": "슈퍼관리자",
        "ADMIN": "관리자",
        "SALES": "영업",
        "MARKETING": "마케팅",
        "HR": "HR",
        "SUPPORT": "지원",
        "ETC": "기타",
    }
