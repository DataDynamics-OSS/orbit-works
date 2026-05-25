"""결재선 평가 엔진.

approval_template.approval_rules JSON 을 form_data 와 매칭해 결재 단계
(ApprovalStep snapshot) 을 생성한다.

룰 구조:
{
    "rules": [
        {
            "name": "100만 이하 — 매니저",
            "when": { "form_data.amount": { "lte": 1000000 } } | null,
            "approvers": [
                { "type": "manager",          "step_name": "1차 결재" },
                { "type": "rank_min_level",   "level": 600, ... },
                { "type": "rank_in",          "names": ["이사"], ... },
                { "type": "title_min_level",  "level": 400, ... },
                { "type": "title_in",         "names": ["팀장"], ... },
                { "type": "specific_user",    "developer_id": "...", ... }
            ]
        }, ...
    ]
}

Approver 타입:
- manager           — developers.manager_id 직접
- rank_min_level    — 매니저 chain 거슬러 첫 rank.level >= N 인 사람
- rank_in           — chain 에서 rank.name 매치 첫 사람
- title_min_level   — chain 에서 position.level >= N 첫 사람
- title_in          — chain 에서 position.name 매치 첫 사람
- specific_user     — 명시 developer_id

매칭 정책:
- 위에서부터 순회해 첫 매칭 룰만 사용 (단순). when=null 은 무조건 매치 (default).
- 매칭 룰 없으면 빈 step 리스트 반환.

연산자 (when 조건):
- eq, ne, lt, lte, gt, gte, in, nin
- AND only (객체의 모든 키가 모두 만족해야 매치)
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Developer, JobPosition, JobRank

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 조건 평가
# ---------------------------------------------------------------------------


def _get_path(data: dict, path: str) -> Any:
    """ 'form_data.amount' 같이 dot path 로 nested 값 추출. 없으면 None. """
    parts = path.split(".")
    cur: Any = data
    for p in parts:
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return None
    return cur


def _match_op(value: Any, op: str, ref: Any) -> bool:
    if op == "eq":
        return value == ref
    if op == "ne":
        return value != ref
    if op == "lt":
        return value is not None and value < ref
    if op == "lte":
        return value is not None and value <= ref
    if op == "gt":
        return value is not None and value > ref
    if op == "gte":
        return value is not None and value >= ref
    if op == "in":
        return value in (ref or [])
    if op == "nin":
        return value not in (ref or [])
    return False


def match_when(when: dict | None, form_data: dict) -> bool:
    """when=null 또는 {} 는 항상 매치. AND-only."""
    if not when:
        return True
    # 평가 컨텍스트 — 외부에서 form_data 를 root 로 접근하기 위한 wrap.
    ctx = {"form_data": form_data}
    for path, cond in when.items():
        actual = _get_path(ctx, path)
        if not isinstance(cond, dict):
            # shorthand: { "form_data.x": 5 } → eq
            if not _match_op(actual, "eq", cond):
                return False
            continue
        for op, ref in cond.items():
            if not _match_op(actual, op, ref):
                return False
    return True


# ---------------------------------------------------------------------------
# 매니저 chain 탐색
# ---------------------------------------------------------------------------


async def _manager_chain(
    db: AsyncSession, requester_id: UUID, max_depth: int = 10
) -> list[Developer]:
    """신청자 본인 → manager → manager.manager → ... 거슬러 올라간 list.

    본인은 chain[0], 매니저가 chain[1], ...
    chain 길이는 본인 1명 ~ 최대 max_depth+1.
    """
    chain: list[Developer] = []
    visited: set[UUID] = set()
    current_id: UUID | None = requester_id
    depth = 0
    while current_id and current_id not in visited and depth <= max_depth:
        visited.add(current_id)
        dev = (
            await db.execute(select(Developer).where(Developer.id == current_id))
        ).scalar_one_or_none()
        if not dev:
            break
        chain.append(dev)
        current_id = dev.manager_id
        depth += 1
    return chain


# ---------------------------------------------------------------------------
# Approver resolver
# ---------------------------------------------------------------------------


async def _rank_level(db: AsyncSession, dev: Developer) -> float | None:
    if not dev.rank_id:
        return None
    r = (
        await db.execute(select(JobRank).where(JobRank.id == dev.rank_id))
    ).scalar_one_or_none()
    return float(r.level) if r else None


async def _rank_name(db: AsyncSession, dev: Developer) -> str | None:
    if not dev.rank_id:
        return None
    r = (
        await db.execute(select(JobRank).where(JobRank.id == dev.rank_id))
    ).scalar_one_or_none()
    return r.name if r else None


async def _position_level(db: AsyncSession, dev: Developer) -> float | None:
    if not dev.position_id:
        return None
    p = (
        await db.execute(select(JobPosition).where(JobPosition.id == dev.position_id))
    ).scalar_one_or_none()
    return float(p.level) if p else None


async def _position_name(db: AsyncSession, dev: Developer) -> str | None:
    if not dev.position_id:
        return None
    p = (
        await db.execute(select(JobPosition).where(JobPosition.id == dev.position_id))
    ).scalar_one_or_none()
    return p.name if p else None


async def resolve_approver(
    spec: dict, requester_id: UUID, db: AsyncSession, exclude: set[UUID] | None = None
) -> UUID | None:
    """approver 정의 1개를 실제 임직원 id 로 변환.

    exclude: 이미 다른 step 에 할당된 사람들 (중복 방지). 본인도 자동 제외.
    """
    exclude = set(exclude or set())
    exclude.add(requester_id)
    chain = await _manager_chain(db, requester_id)
    # chain[0] = 본인. 매니저 후보는 chain[1:].
    candidates = [d for d in chain[1:] if d.id not in exclude]
    t = spec.get("type")

    if t == "manager":
        # 직속 매니저.
        return candidates[0].id if candidates else None

    if t == "specific_user":
        did = spec.get("developer_id")
        if not did:
            return None
        try:
            uid = UUID(did) if isinstance(did, str) else did
        except (ValueError, TypeError):
            return None
        if uid in exclude:
            return None
        # 실제 존재·active 검증.
        dev = (
            await db.execute(
                select(Developer).where(Developer.id == uid, Developer.status == "ACTIVE")
            )
        ).scalar_one_or_none()
        return dev.id if dev else None

    if t in ("rank_min_level", "title_min_level"):
        level = spec.get("level")
        if level is None:
            return None
        for d in candidates:
            v = (
                await _rank_level(db, d)
                if t == "rank_min_level"
                else await _position_level(db, d)
            )
            if v is not None and v >= float(level):
                return d.id
        return None

    if t in ("rank_in", "title_in"):
        names = spec.get("names") or []
        for d in candidates:
            v = (
                await _rank_name(db, d)
                if t == "rank_in"
                else await _position_name(db, d)
            )
            if v in names:
                return d.id
        return None

    return None


# ---------------------------------------------------------------------------
# 룰 평가 → step 정의 (DB row 가 아닌 dict 형식 — 호출자가 ApprovalStep 으로 변환)
# ---------------------------------------------------------------------------


class ResolvedStep(dict):
    """편의 typed dict 대용.
    keys: step_no, step_name, rule_index, approver_index, approver_id (UUID|None)
    """


def find_matching_rule(
    approval_rules: dict, form_data: dict
) -> tuple[int, dict] | None:
    """rules 배열에서 첫 매치 반환 (idx, rule). 없으면 None."""
    rules = (approval_rules or {}).get("rules") or []
    for idx, r in enumerate(rules):
        if match_when(r.get("when"), form_data):
            return idx, r
    return None


async def evaluate_rules(
    *,
    requester_id: UUID,
    approval_rules: dict,
    form_data: dict,
    db: AsyncSession,
) -> list[ResolvedStep]:
    """룰 매칭 + approver 해결 → step 리스트 (snapshot).

    동작 (UX 친화적):
      - 중복 approver 자동 제거 (앞 step 에 같은 사람이 있으면 skip).
      - **미해결 (approver_id=None) step 은 생성하지 않음** — 매니저 chain 이
        spec 을 만족할 사람 부족(예: rank_min_level=600 인데 chain 에 600 이상
        없음) 인 경우, 그 spec 은 "이미 더 높은 결재자가 chain 에 존재해
        의미가 사라진" 케이스가 대부분이라 자동 drop 한다 (chain 의 '결재자
        미정' 표시 회피). 모두 drop 되어 0 step 이 되는 경우만 호출자가
        에러 처리.
      - **상위 등급으로 이미 만족된 grade spec 도 drop** — 예: step 1 manager
        이 rank=1000 인데 step 2 spec 이 rank_min_level=600 이면, step 1 의
        결재자가 이미 그 요건을 충족하므로 step 2 는 redundant. 자동 drop.
        승인 시점의 _auto_skip_downstream 과 정책 동일 (생성 시점에 미리 압축).
      - step_no 는 살아남은 step 들 기준으로 1, 2, 3 … 으로 재번호.
    """
    matched = find_matching_rule(approval_rules, form_data)
    if not matched:
        logger.warning(
            "approval_engine: 매칭되는 룰이 없습니다. requester=%s rules=%d",
            requester_id, len(approval_rules.get("rules") or []),
        )
        return []
    rule_idx, rule = matched
    approvers = rule.get("approvers") or []
    out: list[ResolvedStep] = []
    used: set[UUID] = set()
    # chain 내 누적 최대 등급 — 후행 grade spec 의 redundancy 체크에 사용.
    cum_rank_level: float | None = None
    cum_position_level: float | None = None
    dropped_unresolved = 0
    dropped_redundant = 0
    for ai, spec in enumerate(approvers):
        # (1) 이미 cum max 등급이 spec 의 grade 요건을 충족하면 redundant — drop.
        t = spec.get("type")
        level = spec.get("level")
        if level is not None:
            try:
                ref = float(level)
            except (TypeError, ValueError):
                ref = None
            if ref is not None:
                if t == "rank_min_level" and cum_rank_level is not None and cum_rank_level >= ref:
                    dropped_redundant += 1
                    continue
                if t == "title_min_level" and cum_position_level is not None and cum_position_level >= ref:
                    dropped_redundant += 1
                    continue

        approver_id = await resolve_approver(spec, requester_id, db, exclude=used)
        if approver_id and approver_id in used:
            continue
        if not approver_id:
            # 미해결 — chain 이 spec 을 만족할 사람을 찾지 못함. UX 차원에서 drop.
            dropped_unresolved += 1
            continue
        used.add(approver_id)
        # 결정된 결재자의 등급을 cum max 에 반영 (DB 조회 1회).
        dev = (
            await db.execute(select(Developer).where(Developer.id == approver_id))
        ).scalar_one_or_none()
        if dev is not None:
            rl = await _rank_level(db, dev)
            pl = await _position_level(db, dev)
            if rl is not None and (cum_rank_level is None or rl > cum_rank_level):
                cum_rank_level = rl
            if pl is not None and (cum_position_level is None or pl > cum_position_level):
                cum_position_level = pl

        out.append(ResolvedStep({
            "step_no": len(out) + 1,
            "step_name": spec.get("step_name") or f"{len(out) + 1}차 결재",
            "rule_index": rule_idx,
            "approver_index": ai,
            "approver_id": approver_id,
        }))
    logger.info(
        "approval_engine: 룰 매치='%s' steps=%d 미해결drop=%d redundant drop=%d requester=%s",
        rule.get("name", f"#{rule_idx}"),
        len(out),
        dropped_unresolved,
        dropped_redundant,
        requester_id,
    )
    if dropped_unresolved:
        # 미해결 drop 은 룰/조직도 mismatch 신호 — 운영자가 추적해야 의도된 단순화인지
        # 룰 설정 실수인지 판단 가능.
        logger.warning(
            "approval_engine: %d 단계가 매니저 chain 부족으로 drop 됨 (룰='%s' requester=%s)",
            dropped_unresolved, rule.get("name", f"#{rule_idx}"), requester_id,
        )
    return out
