"""신규 tenant 생성 직후 호출되는 초기 데이터 시드.

- `leave_types` 17 종 — 휴가 신청 UI 의 select 옵션 (없으면 신청 자체 불가)
- `menu_permissions` — DEFAULT_MENU_PERMISSIONS 의 기본 매핑을 명시 row 로 저장.
  비워 두면 backend 가 fallback 으로 기본값을 반환하긴 하지만, Settings > 메뉴 권한
  화면이 row 기준으로 동작하므로 토글 UX 가 자연스러우려면 명시 seed 가 좋다.
- `holidays` — 한국 법정 공휴일 2024~2027 (확정 공시 분).
- `job_ranks` / `job_positions` — 직위 10개 + 직책 12개 (결재선 hierarchy).
- `approval_templates` — 결재 양식 10종 (시드 JSON 파일에서 로드).

호출자는 tenant_id 가 채워진 row 를 만들도록 미리 ContextVar/세션 GUC 를 설정해
두어야 한다 (RLS WITH CHECK 통과 위함). `create_tenant` 의 흐름에서는 이미
ContextVar 가 새 tenant 의 id 를 갖도록 set 한 뒤 호출.
"""

from __future__ import annotations

import json
from datetime import date as date_cls
from pathlib import Path
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.menu_permissions import DEFAULT_MENU_PERMISSIONS
from app.models import (
    ApprovalTemplate,
    HelpArticle,
    Holiday,
    JobPosition,
    JobRank,
    LeaveType,
    MenuPermission,
)

# 시드 JSON 위치 — backend/app/data/approval_templates_seed.json
_APPROVAL_TEMPLATES_SEED_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "approval_templates_seed.json"
)

# 도움말 default seed — 운영자가 prod 에서 작성한 컨텐츠를 `/help-articles/export`
# 로 받아 이 자리에 commit. 신규 tenant 가입 시 ON CONFLICT DO NOTHING 시드.
# 파일 형식: {"version": 1, "items": [{menu_key, title, group, sort_order, summary, body_html, body_text}, ...]}
_HELP_SEED_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "help_seed.json"
)

# (code, name, category, unit, deducts_annual, paid, max_days, requires_evidence, color, sort_order)
_LEAVE_TYPES_SEED: tuple[tuple, ...] = (
    # 경조 (LIFE_EVENT)
    ("FAMILY_WEDDING",      "경조 - 결혼",        "LIFE_EVENT",  "DAY",  False, True,  5,    True,  "#F59E0B", 10),
    ("FAMILY_FUNERAL",      "경조 - 조의(사망)",   "LIFE_EVENT",  "DAY",  False, True,  5,    True,  "#F59E0B", 11),
    ("FAMILY_70TH",         "경조 - 칠순",        "LIFE_EVENT",  "DAY",  False, True,  1,    True,  "#F59E0B", 12),
    ("FAMILY_60TH",         "경조 - 회갑",        "LIFE_EVENT",  "DAY",  False, True,  1,    True,  "#F59E0B", 13),
    # 공가 (PUBLIC_DUTY)
    ("PUBLIC_HEALTH_CHECK", "공가 - 건강검진",     "PUBLIC_DUTY", "DAY",  False, True,  None, True,  "#8B5CF6", 20),
    ("PUBLIC_CIVIL_DEFENSE","공가 - 민방위",      "PUBLIC_DUTY", "DAY",  False, True,  None, True,  "#8B5CF6", 21),
    ("PUBLIC_RESERVE_DUTY", "공가 - 예비군",      "PUBLIC_DUTY", "DAY",  False, True,  None, True,  "#8B5CF6", 22),
    # 병가 (SICK)
    ("SICK_HEALTH",         "병가 - 보건휴가",     "SICK",        "DAY",  False, True,  None, False, "#EF4444", 30),
    ("SICK_PAID",           "병가 - 유급 병가",    "SICK",        "DAY",  False, True,  None, True,  "#EF4444", 31),
    ("SICK_UNPAID",         "병가 - 무급 병가",    "SICK",        "DAY",  False, False, None, False, "#EF4444", 32),
    # 연차 (ANNUAL)
    ("ANNUAL_FULL",         "연차",              "ANNUAL",      "DAY",  True,  True,  None, False, "#3B82F6", 1),
    ("ANNUAL_HALF_AM",      "반차 (오전)",        "ANNUAL",      "HALF", True,  True,  None, False, "#3B82F6", 2),
    ("ANNUAL_HALF_PM",      "반차 (오후)",        "ANNUAL",      "HALF", True,  True,  None, False, "#3B82F6", 3),
    # 포상 (REWARD)
    ("REWARD_TENURE_5Y",    "포상 - 장기근속 5년",  "REWARD",      "DAY",  False, True,  None, False, "#10B981", 40),
    ("REWARD_TENURE_7Y",    "포상 - 장기근속 7년",  "REWARD",      "DAY",  False, True,  None, False, "#10B981", 41),
    ("REWARD_TENURE_10Y",   "포상 - 장기근속 10년", "REWARD",      "DAY",  False, True,  None, False, "#10B981", 42),
    # 기타
    ("MATERNITY",           "출산휴가",           "LIFE_EVENT",  "DAY",  False, True,  90,   True,  "#F59E0B", 50),
    ("UNPAID_LEAVE",        "무급휴가",           "OTHER",       "DAY",  False, False, None, False, "#6B7280", 60),
)


# 한국 법정 공휴일 — 2024~2027 확정. db.sql 의 신규 deployment seed 와 동일 list.
# 신규 tenant 추가 시 이 시드가 자동 적용 (회사·임시 휴일은 ADMIN 이 수동 등록).
_LEGAL_HOLIDAYS_SEED: tuple[tuple[str, str], ...] = (
    ("2024-01-01", "신정"),
    ("2024-02-09", "설 연휴"),
    ("2024-02-10", "설날"),
    ("2024-02-11", "설 연휴"),
    ("2024-02-12", "대체공휴일(설)"),
    ("2024-03-01", "3·1절"),
    ("2024-05-05", "어린이날"),
    ("2024-05-06", "대체공휴일(어린이날)"),
    ("2024-05-15", "부처님오신날"),
    ("2024-06-06", "현충일"),
    ("2024-08-15", "광복절"),
    ("2024-09-16", "추석 연휴"),
    ("2024-09-17", "추석"),
    ("2024-09-18", "추석 연휴"),
    ("2024-10-01", "국군의 날"),
    ("2024-10-03", "개천절"),
    ("2024-10-09", "한글날"),
    ("2024-12-25", "성탄절"),
    ("2025-01-01", "신정"),
    ("2025-01-28", "설 연휴"),
    ("2025-01-29", "설날"),
    ("2025-01-30", "설 연휴"),
    ("2025-03-01", "3·1절"),
    ("2025-03-03", "대체공휴일(3·1절)"),
    ("2025-05-05", "어린이날/부처님오신날"),
    ("2025-05-06", "대체공휴일"),
    ("2025-06-06", "현충일"),
    ("2025-08-15", "광복절"),
    ("2025-10-03", "개천절"),
    ("2025-10-05", "추석 연휴"),
    ("2025-10-06", "추석"),
    ("2025-10-07", "추석 연휴"),
    ("2025-10-08", "대체공휴일(추석)"),
    ("2025-10-09", "한글날"),
    ("2025-12-25", "성탄절"),
    ("2026-01-01", "신정"),
    ("2026-02-16", "설 연휴"),
    ("2026-02-17", "설날"),
    ("2026-02-18", "설 연휴"),
    ("2026-03-01", "3·1절"),
    ("2026-03-02", "대체공휴일(3·1절)"),
    ("2026-05-05", "어린이날"),
    ("2026-05-24", "부처님오신날"),
    ("2026-05-25", "대체공휴일(부처님오신날)"),
    ("2026-06-06", "현충일"),
    ("2026-08-15", "광복절"),
    ("2026-08-17", "대체공휴일(광복절)"),
    ("2026-09-24", "추석 연휴"),
    ("2026-09-25", "추석"),
    ("2026-09-26", "추석 연휴"),
    ("2026-10-03", "개천절"),
    ("2026-10-05", "대체공휴일(개천절)"),
    ("2026-10-09", "한글날"),
    ("2026-12-25", "성탄절"),
    ("2027-01-01", "신정"),
    ("2027-02-06", "설 연휴"),
    ("2027-02-07", "설날"),
    ("2027-02-08", "설 연휴"),
    ("2027-02-09", "대체공휴일(설)"),
    ("2027-03-01", "3·1절"),
    ("2027-05-05", "어린이날"),
    ("2027-05-13", "부처님오신날"),
    ("2027-06-06", "현충일"),
    ("2027-06-07", "대체공휴일(현충일)"),
    ("2027-08-15", "광복절"),
    ("2027-08-16", "대체공휴일(광복절)"),
    ("2027-09-14", "추석 연휴"),
    ("2027-09-15", "추석"),
    ("2027-09-16", "추석 연휴"),
    ("2027-10-03", "개천절"),
    ("2027-10-04", "대체공휴일(개천절)"),
    ("2027-10-09", "한글날"),
    ("2027-12-25", "성탄절"),
)


# 직위(Rank) — career grade. 모든 임직원이 1개씩 보유. (name, level, sort_order)
_JOB_RANKS_SEED: tuple[tuple[str, int, int], ...] = (
    ("연구원",         100,  1),
    ("주임연구원",     200,  2),
    ("선임연구원",     300,  3),
    ("책임연구원",     400,  4),
    ("수석연구원",     500,  5),
    ("이사",           600,  6),
    ("상무이사",       700,  7),
    ("전무이사",       800,  8),
    ("부대표",         900,  9),
    ("대표이사",      1000, 10),
)

# 직책(Position) — 선택적 job role. (name, level, sort_order)
_JOB_POSITIONS_SEED: tuple[tuple[str, int, int], ...] = (
    ("파트장",     100,  1),
    ("팀장",       200,  2),
    ("실장",       300,  3),
    ("본부장",     400,  4),
    ("사업부장",   500,  5),
    ("연구소장",   600,  6),
    ("전문위원",   650,  7),
    ("사업총괄",   700,  8),
    ("CIO",        800,  9),
    ("CDO",        850, 10),
    ("CFO",        900, 11),
    ("CEO",       1000, 12),
)


async def seed_new_tenant(db: AsyncSession, tenant_id: UUID) -> None:
    """새 tenant 의 필수 lookup 데이터를 채운다."""
    for (
        code, name, category, unit, deducts_annual, paid, max_days,
        requires_evidence, color, sort_order,
    ) in _LEAVE_TYPES_SEED:
        db.add(
            LeaveType(
                tenant_id=tenant_id,
                code=code,
                name=name,
                category=category,
                unit=unit,
                deducts_annual=deducts_annual,
                paid=paid,
                max_days_per_year=max_days,
                requires_evidence=requires_evidence,
                color=color,
                sort_order=sort_order,
            )
        )

    # menu_permissions — DEFAULT 매핑을 명시 row 로.
    for menu_key, roles in DEFAULT_MENU_PERMISSIONS.items():
        for role in roles:
            db.add(
                MenuPermission(
                    tenant_id=tenant_id, menu_key=menu_key, role=role,
                )
            )

    # holidays — 한국 법정 공휴일 (확정 분 2024~2027).
    for date_str, name in _LEGAL_HOLIDAYS_SEED:
        db.add(
            Holiday(
                tenant_id=tenant_id,
                date=date_cls.fromisoformat(date_str),
                name=name,
                type="STATUTORY",
            )
        )

    # 직위(Rank) / 직책(Position) — 결재선 hierarchy 마스터.
    for name, level, sort_order in _JOB_RANKS_SEED:
        db.add(
            JobRank(
                tenant_id=tenant_id,
                name=name,
                level=level,
                sort_order=sort_order,
                is_active=True,
            )
        )
    for name, level, sort_order in _JOB_POSITIONS_SEED:
        db.add(
            JobPosition(
                tenant_id=tenant_id,
                name=name,
                level=level,
                sort_order=sort_order,
                is_active=True,
            )
        )

    # approval_templates — 결재 양식 10종.
    if _APPROVAL_TEMPLATES_SEED_PATH.exists():
        try:
            templates = json.loads(_APPROVAL_TEMPLATES_SEED_PATH.read_text(encoding="utf-8"))
        except Exception:
            templates = []
        for t in templates:
            db.add(
                ApprovalTemplate(
                    tenant_id=tenant_id,
                    kind=t["kind"],
                    name=t["name"],
                    icon=t.get("icon"),
                    form_schema=t.get("form_schema") or {},
                    ui_schema=t.get("ui_schema"),
                    approval_rules=t.get("approval_rules") or {},
                    version=1,
                    is_active=t.get("default_active", True),
                    description=t.get("description"),
                )
            )

    # help_articles — 도움말 default seed (운영자가 `/help-articles/export` 로
    # 만든 JSON 을 repo 에 commit 한 결과). items 가 비어 있으면 noop.
    if _HELP_SEED_PATH.exists():
        try:
            seed = json.loads(_HELP_SEED_PATH.read_text(encoding="utf-8"))
        except Exception:
            seed = {"items": []}
        for it in seed.get("items", []) or []:
            db.add(
                HelpArticle(
                    tenant_id=tenant_id,
                    menu_key=it["menu_key"],
                    title=it.get("title") or it["menu_key"],
                    group=it.get("group"),
                    sort_order=int(it.get("sort_order") or 0),
                    summary=it.get("summary"),
                    body_html=it.get("body_html") or "",
                    body_text=it.get("body_text"),
                )
            )
