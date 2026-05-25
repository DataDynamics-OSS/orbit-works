"""부여 가능한 기능(feature) 카탈로그.

`user_feature_grants` 테이블에 저장될 수 있는 feature_key 의 화이트리스트.
새 기능을 user-level 위임 대상으로 추가하려면 여기에 등록.

운영자가 임직원 수정 화면에서 토글로 부여/해제할 때 이 목록이 후보로 노출된다.
등록되지 않은 키로 POST 시도하면 400.

key 명명 규약: `<domain>.<action>` 점 표기. feature_permissions (role 기반) 와
형식 일관.
"""

from __future__ import annotations

# (feature_key → 사람이 읽는 설명) 의 단순 사전. 향후 카테고리·아이콘 등이 필요해지면
# dict 값을 dataclass 로 확장.
KNOWN_GRANTABLE_FEATURES: dict[str, str] = {
    "weekly_reports.view_all": "주간보고 전체 조회 (ADMIN/HR 동등)",
}


def is_grantable(feature_key: str) -> bool:
    return feature_key in KNOWN_GRANTABLE_FEATURES
