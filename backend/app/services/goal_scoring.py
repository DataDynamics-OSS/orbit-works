"""목표 점수 계산 — auto_score + 종합 점수 + 등급.

공식:
    adjusted_progress = progress_pct × difficulty_factor       (0~200)
    weight            = priority_weight × category_weight      (1~3 기본)
    goal_score        = adjusted_progress × weight
    total_score       = Σ goal_score / max(Σ weight, min_total_weight)
                                                               (가중평균, 0~200)

등급 (cutoff):
    S ≥ 120 / A ≥ 90 / B ≥ 70 / C ≥ 50 / D < 50

난이도 multiplier (0.8 / 1.0 / 1.5 / 2.0) 는 STRETCH 도전을 보상하기 위한 핵심:
- ROUTINE 100% (= adj 80) < NORMAL 100% (= adj 100) < STRETCH 50% (= adj 100)
- STRETCH 100% (= adj 200) 으로 종합 score 가 100 을 초과 가능 → S 등급.

분류 가중치 — 운영자가 Settings 에서 정의 (phase2). MVP 는 모두 1.0.

가중치 하한 (min_total_weight) — Settings > 목표 기준 에서 연도별 등록.
목표를 적게 등록하면 Σweight 가 작아져 가중평균이 인위적으로 부풀려지는 것을 차단.
실제 Σweight 가 하한보다 작으면 분모를 하한으로 고정 → 점수가 비례하여 낮아진다.
미설정이면 floor 미적용 (= 기존 동작 유지).
"""

from __future__ import annotations

import logging
from typing import Iterable

from app.models.goal import (
    DIFFICULTY_FACTOR,
    GRADE_CUTOFFS,
    PRIORITY_WEIGHT,
    Goal,
)

logger = logging.getLogger(__name__)


# 분류 가중치 default — phase2 에서 운영자 설정 가능 (Settings).
DEFAULT_CATEGORY_WEIGHTS: dict[str, float] = {
    "BUSINESS": 1.0,
    "TECH": 1.0,
    "OPERATIONS": 1.0,
    "CAREER": 1.0,
    "PERSONAL_GROWTH": 1.0,
    "OTHER": 1.0,
}


def grade_for(score: float) -> str:
    for cutoff, grade in GRADE_CUTOFFS:
        if score >= cutoff:
            return grade
    return "D"


def auto_score_for_goal(
    goal: Goal, *, category_weights: dict[str, float] | None = None
) -> dict:
    cw = (category_weights or DEFAULT_CATEGORY_WEIGHTS).get(goal.category, 1.0)
    diff = DIFFICULTY_FACTOR.get(goal.difficulty, 1.0)
    prio = PRIORITY_WEIGHT.get(goal.priority, 1)
    if goal.difficulty not in DIFFICULTY_FACTOR:
        logger.warning(
            "goal_scoring: 알 수 없는 난이도 '%s' (goal=%s) — 기본값 1.0 적용",
            goal.difficulty, goal.id,
        )
    if goal.priority not in PRIORITY_WEIGHT:
        logger.warning(
            "goal_scoring: 알 수 없는 우선순위 '%s' (goal=%s) — 기본값 1 적용",
            goal.priority, goal.id,
        )
    adjusted = float(goal.progress_pct) * diff
    return {
        "auto_score": round(adjusted, 2),
        "weight": round(prio * cw, 2),
        "difficulty_factor": diff,
        "priority_weight": prio,
        "category_weight": cw,
    }


def total_score(
    goals: Iterable[Goal],
    *,
    category_weights: dict[str, float] | None = None,
    min_total_weight: float | None = None,
    min_goal_count: int | None = None,
) -> dict:
    """목표 list 의 종합 점수 (가중평균) + 등급 + 부분 통계.

    `min_total_weight` 이 주어지면 분모에 floor 적용:
        denom = max(Σweight, min_total_weight)
    이 경우 weight_sum < min_total_weight 인 owner 는 자동으로 점수가 깎인다.
    `min_goal_count` 는 페널티 없이 안내용으로만 응답에 포함.
    """
    cw_map = category_weights or DEFAULT_CATEGORY_WEIGHTS

    score_x_weight = 0.0
    weight_sum = 0.0
    by_priority_sum: dict[str, list[float]] = {}
    by_category_sum: dict[str, list[float]] = {}
    by_difficulty: dict[str, int] = {}
    n = 0
    for g in goals:
        n += 1
        prio = PRIORITY_WEIGHT.get(g.priority, 1)
        cw = cw_map.get(g.category, 1.0)
        diff = DIFFICULTY_FACTOR.get(g.difficulty, 1.0)
        adjusted = float(g.progress_pct) * diff
        weight = prio * cw

        score_x_weight += adjusted * weight
        weight_sum += weight

        by_priority_sum.setdefault(g.priority, []).append(adjusted)
        by_category_sum.setdefault(g.category, []).append(adjusted)
        by_difficulty[g.difficulty] = by_difficulty.get(g.difficulty, 0) + 1

    floor = float(min_total_weight) if min_total_weight and min_total_weight > 0 else 0.0
    denom = max(weight_sum, floor)
    floor_applied = floor > 0 and weight_sum < floor
    total = score_x_weight / denom if denom > 0 else 0.0

    return {
        "total": round(total, 2),
        "grade": grade_for(total),
        "goal_count": n,
        "by_priority": {
            k: round(sum(v) / len(v), 2) if v else 0.0
            for k, v in by_priority_sum.items()
        },
        "by_category": {
            k: round(sum(v) / len(v), 2) if v else 0.0
            for k, v in by_category_sum.items()
        },
        "by_difficulty": by_difficulty,
        "weight_sum": round(weight_sum, 2),
        "min_total_weight": round(floor, 2) if floor > 0 else None,
        "floor_applied": floor_applied,
        "min_goal_count": min_goal_count,
    }
