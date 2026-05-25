"""목표(Goals) API.

권한 모델:
- PERSONAL: 본인 + 매니저 chain 상위 + HR/ADMIN 조회. 작성·수정·삭제는 본인 + HR/ADMIN.
- COMPANY: 전직원 readonly. 작성·수정·삭제는 HR/ADMIN.

cascade — parent_goal_id 로 회사 목표 → 개인 목표 link.
parent 가 PERSONAL 이거나 자식이 COMPANY 인 조합은 거부 (revert).
"""

from __future__ import annotations

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Developer,
    Goal,
    GoalAttachment,
    GoalComment,
    GoalScoreBaseline,
    User,
)
from app.schemas.goal import (
    AssignmentCandidate,
    DistributionOut,
    DistributionStats,
    GoalAttachmentOut,
    GoalAttachmentRename,
    GoalCommentCreate,
    GoalCommentOut,
    GoalCommentUpdate,
    GoalCreate,
    GoalOut,
    GoalScoreBaselineIn,
    GoalScoreBaselineOut,
    GoalScoreInput,
    GoalScoreOut,
    GoalUpdate,
    TeamOverviewDeveloper,
    TeamOverviewGoal,
    TeamOverviewOut,
    TeamOverviewSummary,
    TotalScoreOut,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload
from app.services.goal_notify import notify_goal_completed
from app.services.goal_scoring import (
    DEFAULT_CATEGORY_WEIGHTS,
    auto_score_for_goal,
    total_score,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/goals", tags=["goals"])


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------


async def _resolve_my_developer(db: AsyncSession, user: User) -> Developer | None:
    """로그인 유저의 Developer row. 미연결이면 None."""
    if not user.mapped_developer_id:
        return None
    return (
        await db.execute(
            select(Developer).where(Developer.id == user.mapped_developer_id)
        )
    ).scalar_one_or_none()


async def _manager_chain_ids(
    db: AsyncSession, top_developer_id: UUID, max_depth: int = 10
) -> set[UUID]:
    """top → 부하의 부하 ... 가 아닌, top 의 매니저 + 그 매니저 ... 의 chain.

    여기서는 반대 — 어떤 PERSONAL goal 의 owner 가 me 의 부하 (또는 부하의 부하) 인가
    를 알고 싶음. 즉 me 가 owner 의 매니저 chain 안에 있는지.

    구현: owner 의 매니저 chain (위로) 에 me 가 들어 있는지 확인하는 헬퍼.
    """
    chain: set[UUID] = set()
    cur: UUID | None = top_developer_id
    visited: set[UUID] = set()
    depth = 0
    while cur and cur not in visited and depth <= max_depth:
        visited.add(cur)
        dev = (
            await db.execute(select(Developer).where(Developer.id == cur))
        ).scalar_one_or_none()
        if not dev:
            break
        chain.add(dev.id)
        cur = dev.manager_id
        depth += 1
    return chain


def _is_admin(user: User) -> bool:
    return user.role in ("ADMIN", "HR")


async def _can_view(
    db: AsyncSession, goal: Goal, me: Developer | None, user: User
) -> bool:
    if _is_admin(user):
        return True
    if goal.scope == "COMPANY":
        return True
    # PERSONAL — 본인이거나 본인이 owner 의 매니저 chain 안에 있어야 함.
    if me is None or goal.owner_id is None:
        return False
    if goal.owner_id == me.id:
        return True
    chain = await _manager_chain_ids(db, goal.owner_id)
    return me.id in chain


async def _is_direct_manager_of(
    db: AsyncSession, *, manager_id: UUID, subordinate_id: UUID
) -> bool:
    """subordinate_id 의 직속 매니저가 manager_id 인지."""
    target = (
        await db.execute(select(Developer).where(Developer.id == subordinate_id))
    ).scalar_one_or_none()
    return bool(target and target.manager_id == manager_id)


async def _can_edit(
    db: AsyncSession, goal: Goal, me: Developer | None, user: User
) -> bool:
    # COMPANY — ADMIN 전용 (HR 제외). VIEW 는 모두 허용 → _can_view 참조.
    if goal.scope == "COMPANY":
        return user.role == "ADMIN"
    # PERSONAL — HR/ADMIN 통과.
    if _is_admin(user):
        return True
    if me is None or goal.owner_id is None:
        return False
    if goal.owner_id == me.id:
        return True
    # 직속 매니저는 부하의 PERSONAL 목표 편집·삭제 가능 (작성·편집·삭제 일관 정책).
    return await _is_direct_manager_of(
        db, manager_id=me.id, subordinate_id=goal.owner_id
    )


async def _name_map(
    db: AsyncSession, ids: list[UUID]
) -> dict[UUID, str]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(Developer.id, Developer.name).where(Developer.id.in_(ids))
        )
    ).all()
    return {r[0]: r[1] for r in rows}


async def _can_score_self(
    goal: Goal, me: Developer | None
) -> bool:
    """본인의 PERSONAL goal 만 자기 평가 입력 가능."""
    if goal.scope != "PERSONAL":
        return False
    if me is None or goal.owner_id is None:
        return False
    return goal.owner_id == me.id


async def _can_score_manager(
    db: AsyncSession, goal: Goal, me: Developer | None
) -> bool:
    """직속 매니저만 부하 PERSONAL goal 에 매니저 평가 입력 가능."""
    if goal.scope != "PERSONAL":
        return False
    if me is None or goal.owner_id is None:
        return False
    if goal.owner_id == me.id:
        return False  # 본인 → 자기 평가 채널.
    return await _is_direct_manager_of(
        db, manager_id=me.id, subordinate_id=goal.owner_id,
    )


async def _build_out(
    db: AsyncSession, goal: Goal, me: Developer | None, user: User,
    *, name_cache: dict[UUID, str] | None = None,
    parent_title_cache: dict[UUID, str] | None = None,
) -> GoalOut:
    name_cache = name_cache or {}
    parent_title_cache = parent_title_cache or {}
    auto = auto_score_for_goal(goal)
    return GoalOut(
        id=goal.id,
        scope=goal.scope,  # type: ignore[arg-type]
        year=goal.year,
        owner_id=goal.owner_id,
        owner_name=name_cache.get(goal.owner_id) if goal.owner_id else None,
        parent_goal_id=goal.parent_goal_id,
        parent_title=parent_title_cache.get(goal.parent_goal_id) if goal.parent_goal_id else None,
        title=goal.title,
        description=goal.description,
        category=goal.category,  # type: ignore[arg-type]
        priority=goal.priority,  # type: ignore[arg-type]
        difficulty=goal.difficulty,  # type: ignore[arg-type]
        status=goal.status,  # type: ignore[arg-type]
        progress_pct=goal.progress_pct,
        due_date=goal.due_date,
        self_score=goal.self_score,
        self_score_comment=goal.self_score_comment,
        manager_score=goal.manager_score,
        manager_score_comment=goal.manager_score_comment,
        manager_score_by_id=goal.manager_score_by_id,
        manager_score_by_name=name_cache.get(goal.manager_score_by_id)
            if goal.manager_score_by_id else None,
        manager_score_at=goal.manager_score_at,
        auto_score=GoalScoreOut(**auto),
        created_at=goal.created_at,
        updated_at=goal.updated_at,
        can_edit=await _can_edit(db, goal, me, user),
        can_score_self=await _can_score_self(goal, me),
        can_score_manager=await _can_score_manager(db, goal, me),
    )


def _validate_parent(parent: Goal, child_scope: str) -> None:
    """cascade 룰 — parent 는 COMPANY 만 (또는 같은 scope 의 PERSONAL).

    현 MVP 는 parent=COMPANY 만 허용 (회사→개인 cascade 가 주 use-case).
    """
    if parent.scope != "COMPANY":
        raise HTTPException(
            status_code=400,
            detail="parent_goal_id 는 회사 목표(COMPANY)여야 합니다.",
        )


# ---------------------------------------------------------------------------
# 목록 / 상세
# ---------------------------------------------------------------------------


@router.get("", response_model=list[GoalOut])
async def list_goals(
    year: int | None = None,
    scope: str | None = Query(default=None, pattern="^(PERSONAL|COMPANY)$"),
    owner_id: UUID | None = None,
    parent_goal_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """목표 목록.

    - scope=COMPANY : 전체 readonly 가능.
    - scope=PERSONAL + owner_id=me : 내 목표.
    - scope=PERSONAL + owner_id=<부하> : 매니저 chain 검증.
    - 미지정 owner_id : 본인 목표 + 매니저 chain 안의 부하들 + COMPANY 모두 (HR/ADMIN 은 전체).
    """
    me = await _resolve_my_developer(db, user)
    stmt = select(Goal)
    if year is not None:
        stmt = stmt.where(Goal.year == year)
    if scope:
        stmt = stmt.where(Goal.scope == scope)
    if parent_goal_id:
        stmt = stmt.where(Goal.parent_goal_id == parent_goal_id)
    if owner_id:
        stmt = stmt.where(Goal.owner_id == owner_id)

    rows = (await db.execute(stmt.order_by(Goal.year.desc(), Goal.created_at.desc()))).scalars().all()

    # 권한 필터 (admin 은 전체 통과).
    visible: list[Goal] = []
    if _is_admin(user):
        visible = list(rows)
    else:
        # 매니저 chain 효율 계산용 — 한 번만 build.
        # 본인이 매니저 chain 의 어떤 사람의 chain 에 들어있는지 확인하려면
        # owner_id 별로 chain 해석. owner_id 가 적은 케이스라 단순 loop OK.
        for g in rows:
            if await _can_view(db, g, me, user):
                visible.append(g)

    # 이름·부모 title 캐시.
    name_cache = await _name_map(db, [g.owner_id for g in visible if g.owner_id])
    parent_ids = [g.parent_goal_id for g in visible if g.parent_goal_id]
    parents = (
        await db.execute(
            select(Goal.id, Goal.title).where(Goal.id.in_(set(parent_ids)))
        )
    ).all() if parent_ids else []
    parent_title_cache = {pid: t for pid, t in parents}

    out: list[GoalOut] = []
    for g in visible:
        out.append(
            await _build_out(db, g, me, user,
                             name_cache=name_cache,
                             parent_title_cache=parent_title_cache)
        )
    return out


async def _all_descendants_of(
    db: AsyncSession, ancestor_id: UUID, *, max_depth: int = 10
) -> set[UUID]:
    """ancestor_id 를 매니저 chain 위로 거슬러 만나는 모든 후손 (BFS).

    직속 부하 + 직속의 직속 + … (max_depth 단계까지). 자기 자신 미포함.
    """
    result: set[UUID] = set()
    queue: list[UUID] = [ancestor_id]
    visited: set[UUID] = set()
    depth = 0
    while queue and depth < max_depth:
        next_level: list[UUID] = []
        for parent_id in queue:
            if parent_id in visited:
                continue
            visited.add(parent_id)
            children = list(
                (
                    await db.execute(
                        select(Developer.id)
                        .where(
                            Developer.manager_id == parent_id,
                            Developer.status == "ACTIVE",
                        )
                    )
                ).scalars()
            )
            for cid in children:
                if cid not in result:
                    result.add(cid)
                    next_level.append(cid)
        queue = next_level
        depth += 1
    return result


@router.get("/assignment-candidates", response_model=list[AssignmentCandidate])
async def list_assignment_candidates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """목표 작성 시 owner 후보 list.

    - ADMIN / HR : 전체 ACTIVE FULL_TIME 정규직
    - 일반 직원   : 본인 + 매니저 chain 모든 후손 (_all_descendants_of)
    - developer 미매핑 사용자: 빈 list

    응답은 본인이 맨 위, 그 외 가나다순. is_self=true 로 본인 표시.
    """
    me = await _resolve_my_developer(db, user)
    rows: list[Developer]
    if _is_admin(user):
        rows = list(
            (
                await db.execute(
                    select(Developer)
                    .where(
                        Developer.status == "ACTIVE",
                        Developer.employment_type == "FULL_TIME",
                    )
                    .order_by(Developer.name)
                )
            ).scalars()
        )
    else:
        if not me:
            # developer 매핑이 없는 사용자는 후보 없음.
            return []
        ids = await _all_descendants_of(db, me.id)
        ids.add(me.id)
        # 부하는 FULL_TIME 만 (회사 정책 — 프리랜서/인턴은 PERSONAL 목표
        # 시스템 대상이 아님).
        rows = list(
            (
                await db.execute(
                    select(Developer)
                    .where(
                        Developer.id.in_(ids),
                        Developer.status == "ACTIVE",
                        Developer.employment_type == "FULL_TIME",
                    )
                    .order_by(Developer.name)
                )
            ).scalars()
        )

    me_id = me.id if me else None
    # 본인은 employment_type / status 와 무관하게 항상 후보에 포함.
    # (예: 본인이 FULL_TIME_SPECIAL 이거나 데이터 정합성 이슈로 status 가
    #  ACTIVE 가 아니어도, 자기 목표는 자기가 세울 수 있어야 한다.)
    if me and me_id and not any(d.id == me_id for d in rows):
        rows.insert(0, me)

    out: list[AssignmentCandidate] = []
    self_row: AssignmentCandidate | None = None
    for d in rows:
        cand = AssignmentCandidate(
            id=d.id, name=d.name, tag=d.tag, title=d.title,
            is_self=(d.id == me_id),
        )
        if cand.is_self:
            self_row = cand
        else:
            out.append(cand)
    # 본인 맨 위로.
    if self_row:
        out.insert(0, self_row)
    return out


# ---------------------------------------------------------------------------
# 점수 기준 (가중치 하한) — 연도별 1 행. ADMIN/HR 만 변경.
# ---------------------------------------------------------------------------


async def _get_baseline(
    db: AsyncSession, year: int
) -> GoalScoreBaseline | None:
    """tenant 의 해당 연도 baseline. 없으면 None — 호출 측에서 floor 미적용."""
    return (
        await db.execute(
            select(GoalScoreBaseline).where(GoalScoreBaseline.year == year)
        )
    ).scalar_one_or_none()


async def _baseline_args(
    db: AsyncSession, year: int
) -> dict:
    """total_score() 에 넘길 baseline kwargs."""
    bl = await _get_baseline(db, year)
    if not bl:
        return {}
    return {
        "min_total_weight": float(bl.min_total_weight),
        "min_goal_count": bl.min_goal_count,
    }


@router.get("/score/baselines", response_model=list[GoalScoreBaselineOut])
async def list_score_baselines(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """연도별 점수 기준(가중치 하한) 목록. 모든 로그인 유저 조회 가능 (UI 안내용)."""
    rows = (
        await db.execute(
            select(GoalScoreBaseline).order_by(GoalScoreBaseline.year.desc())
        )
    ).scalars().all()
    return [GoalScoreBaselineOut.model_validate(r) for r in rows]


@router.put("/score/baselines/{year}", response_model=GoalScoreBaselineOut)
async def upsert_score_baseline(
    year: int,
    body: GoalScoreBaselineIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """연도별 가중치 하한 등록/수정. ADMIN/HR 전용."""
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    if body.year != year:
        raise HTTPException(status_code=400, detail="URL 의 year 와 body 의 year 가 다릅니다.")
    existing = await _get_baseline(db, year)
    if existing:
        existing.min_total_weight = body.min_total_weight
        existing.min_goal_count = body.min_goal_count
        existing.note = body.note
    else:
        existing = GoalScoreBaseline(
            year=body.year,
            min_total_weight=body.min_total_weight,
            min_goal_count=body.min_goal_count,
            note=body.note,
        )
        db.add(existing)
    await db.commit()
    await db.refresh(existing)
    return GoalScoreBaselineOut.model_validate(existing)


@router.delete("/score/baselines/{year}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_score_baseline(
    year: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """연도별 가중치 하한 삭제. ADMIN/HR 전용. 삭제 시 floor 미적용으로 복귀."""
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    bl = await _get_baseline(db, year)
    if bl:
        await db.delete(bl)
        await db.commit()
    return None


@router.get("/score/distribution", response_model=DistributionOut)
async def score_distribution(
    year: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """전 직원 점수 분포 + 본인 위치 — 모든 정규직(FULL_TIME) 직원이 호출 가능.

    응답 scores 는 이름 없이 점수만. 본인은 my_score 로 매칭.
    """
    me = await _resolve_my_developer(db, user)
    # FULL_TIME ACTIVE 정규직만.
    devs = list(
        (
            await db.execute(
                select(Developer).where(
                    Developer.status == "ACTIVE",
                    Developer.employment_type == "FULL_TIME",
                )
            )
        ).scalars()
    )
    if not devs:
        return DistributionOut(
            year=year, my_score=None, my_rank=None, percentile=None,
            total_n=0, scores=[],
            stats=DistributionStats(avg=0.0, median=0.0, min=0.0, max=0.0),
        )

    # 한 번에 모든 PERSONAL goals 로드.
    dev_ids = [d.id for d in devs]
    goals = list(
        (
            await db.execute(
                select(Goal).where(
                    Goal.year == year,
                    Goal.scope == "PERSONAL",
                    Goal.owner_id.in_(dev_ids),
                )
            )
        ).scalars()
    )
    by_owner: dict[UUID, list[Goal]] = {}
    for g in goals:
        if g.owner_id is None:
            continue
        by_owner.setdefault(g.owner_id, []).append(g)

    baseline_kw = await _baseline_args(db, year)
    scores_with_id: list[tuple[UUID, float]] = []
    for d in devs:
        gs = by_owner.get(d.id, [])
        if not gs:
            continue  # 목표 없는 사람은 분포 제외.
        s = total_score(gs, **baseline_kw)["total"]
        scores_with_id.append((d.id, s))

    if not scores_with_id:
        return DistributionOut(
            year=year, my_score=None, my_rank=None, percentile=None,
            total_n=0, scores=[],
            stats=DistributionStats(avg=0.0, median=0.0, min=0.0, max=0.0),
        )

    scores = [s for _, s in scores_with_id]
    sorted_scores = sorted(scores, reverse=True)
    n = len(sorted_scores)

    my_score: float | None = None
    if me:
        my_score = next((s for did, s in scores_with_id if did == me.id), None)

    my_rank: int | None = None
    percentile: float | None = None
    if my_score is not None:
        # rank — 더 높은 점수의 수 + 1 (동점은 동일 rank 처리: strict >).
        higher = sum(1 for s in sorted_scores if s > my_score)
        my_rank = higher + 1
        percentile = round(my_rank / n * 100, 1)

    avg = sum(scores) / n
    sorted_asc = sorted(scores)
    if n % 2 == 1:
        median = sorted_asc[n // 2]
    else:
        median = (sorted_asc[n // 2 - 1] + sorted_asc[n // 2]) / 2

    logger.debug(
        "score_distribution: year=%d total_n=%d caller=%s my_rank=%s percentile=%s",
        year, n, user.id,
        my_rank if my_rank is not None else "—",
        percentile if percentile is not None else "—",
    )
    return DistributionOut(
        year=year,
        my_score=round(my_score, 2) if my_score is not None else None,
        my_rank=my_rank,
        percentile=percentile,
        total_n=n,
        scores=[round(s, 2) for s in scores],
        stats=DistributionStats(
            avg=round(avg, 2),
            median=round(median, 2),
            min=round(min(scores), 2),
            max=round(max(scores), 2),
        ),
    )


@router.get("/score/team-overview", response_model=TeamOverviewOut)
async def team_overview(
    year: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """직원 현황 — ADMIN/HR 전체, 매니저는 chain 후손.

    각 직원의 PERSONAL 목표 종합 점수 + 등급 + 상태 카운트.
    """
    me = await _resolve_my_developer(db, user)
    today = date.today()

    # 1) 보이는 developer id 결정. 정규직(FULL_TIME) 만 — 프리랜서/자사화 제외.
    if _is_admin(user):
        rows = list(
            (
                await db.execute(
                    select(Developer)
                    .where(
                        Developer.status == "ACTIVE",
                        Developer.employment_type == "FULL_TIME",
                    )
                    .order_by(Developer.name)
                )
            ).scalars()
        )
    else:
        if not me:
            raise HTTPException(status_code=400, detail="현재 계정이 임직원에 연결되어 있지 않습니다.")
        ids = await _all_descendants_of(db, me.id)
        ids.add(me.id)
        if not ids:
            return TeamOverviewOut(
                year=year,
                summary=TeamOverviewSummary(
                    total_developers=0, with_active_goals=0,
                    avg_score=0.0, at_risk_developers=0, overdue_developers=0,
                ),
                developers=[],
            )
        rows = list(
            (
                await db.execute(
                    select(Developer)
                    .where(
                        Developer.id.in_(ids),
                        Developer.status == "ACTIVE",
                        Developer.employment_type == "FULL_TIME",
                    )
                    .order_by(Developer.name)
                )
            ).scalars()
        )

    if not rows:
        return TeamOverviewOut(
            year=year,
            summary=TeamOverviewSummary(
                total_developers=0, with_active_goals=0,
                avg_score=0.0, at_risk_developers=0, overdue_developers=0,
            ),
            developers=[],
        )

    dev_ids = [d.id for d in rows]

    # 2) 한 번에 모든 PERSONAL goals 로드 (year 필터).
    all_goals = list(
        (
            await db.execute(
                select(Goal)
                .where(
                    Goal.year == year,
                    Goal.scope == "PERSONAL",
                    Goal.owner_id.in_(dev_ids),
                )
            )
        ).scalars()
    )

    by_owner: dict[UUID, list[Goal]] = {}
    for g in all_goals:
        if g.owner_id is None:
            continue
        by_owner.setdefault(g.owner_id, []).append(g)

    baseline_kw = await _baseline_args(db, year)
    out_devs: list[TeamOverviewDeveloper] = []
    at_risk_dev_count = 0
    overdue_dev_count = 0
    score_sum = 0.0
    score_n = 0
    with_active = 0

    for d in rows:
        goals = by_owner.get(d.id, [])
        active_goals = [g for g in goals if g.status not in ("DONE", "DROPPED")]
        at_risk = sum(1 for g in goals if g.status == "AT_RISK")
        done = sum(1 for g in goals if g.status == "DONE")
        overdue = sum(
            1 for g in goals
            if g.due_date and g.due_date < today
            and g.status not in ("DONE", "DROPPED")
        )
        score_info = total_score(goals, **baseline_kw)  # all goals (DONE 포함) — 누적 평가.
        if active_goals:
            with_active += 1
        if at_risk > 0:
            at_risk_dev_count += 1
        if overdue > 0:
            overdue_dev_count += 1
        if goals:
            score_sum += score_info["total"]
            score_n += 1
        # 각 goal 의 mini 표현 — 우선순위 desc → 진행률 asc 순 정렬
        # (PDF 에서 우선순위 높은 + 진행률 낮은 항목이 위로 와 시선 집중).
        prio_order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
        sorted_goals = sorted(
            goals,
            key=lambda g: (
                prio_order.get(g.priority, 9),
                float(g.progress_pct),
            ),
        )
        goal_minis = [
            TeamOverviewGoal(
                id=g.id, title=g.title,
                category=g.category,  # type: ignore[arg-type]
                priority=g.priority,  # type: ignore[arg-type]
                difficulty=g.difficulty,  # type: ignore[arg-type]
                status=g.status,  # type: ignore[arg-type]
                progress_pct=g.progress_pct,
                due_date=g.due_date,
            )
            for g in sorted_goals
        ]

        out_devs.append(TeamOverviewDeveloper(
            id=d.id,
            name=d.name,
            tag=d.tag,
            title=d.title,
            employment_type=d.employment_type,
            goal_count=len(goals),
            active_goal_count=len(active_goals),
            score=round(score_info["total"], 2),
            grade=score_info["grade"],  # type: ignore[arg-type]
            at_risk_count=at_risk,
            overdue_count=overdue,
            done_count=done,
            goals=goal_minis,
        ))

    return TeamOverviewOut(
        year=year,
        summary=TeamOverviewSummary(
            total_developers=len(rows),
            with_active_goals=with_active,
            avg_score=round(score_sum / score_n, 2) if score_n > 0 else 0.0,
            at_risk_developers=at_risk_dev_count,
            overdue_developers=overdue_dev_count,
        ),
        developers=out_devs,
    )


@router.get("/score/summary", response_model=TotalScoreOut)
async def score_summary_pre(
    year: int,
    owner_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """종합 점수 — literal route 가 /{goal_id} 보다 앞에 있어야 UUID 파싱 422 회피."""
    me = await _resolve_my_developer(db, user)
    target_id = owner_id or (me.id if me else None)
    if not target_id:
        raise HTTPException(status_code=400, detail="owner_id 가 필요합니다.")
    if not _is_admin(user) and target_id != (me.id if me else None):
        chain = await _manager_chain_ids(db, target_id)
        if not me or me.id not in chain:
            raise HTTPException(status_code=403, detail="조회 권한이 없습니다.")
    rows = (
        await db.execute(
            select(Goal).where(
                Goal.year == year,
                Goal.owner_id == target_id,
                Goal.scope == "PERSONAL",
            )
        )
    ).scalars().all()
    baseline_kw = await _baseline_args(db, year)
    return TotalScoreOut(**total_score(rows, **baseline_kw))


@router.get("/{goal_id}", response_model=GoalOut)
async def get_goal(
    goal_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="목표를 찾을 수 없습니다.")
    if not await _can_view(db, g, me, user):
        raise HTTPException(status_code=403, detail="이 목표를 볼 권한이 없습니다.")
    name_cache = await _name_map(db, [g.owner_id] if g.owner_id else [])
    parent_title_cache = {}
    if g.parent_goal_id:
        prow = (
            await db.execute(
                select(Goal.title).where(Goal.id == g.parent_goal_id)
            )
        ).scalar_one_or_none()
        if prow:
            parent_title_cache[g.parent_goal_id] = prow
    return await _build_out(
        db, g, me, user,
        name_cache=name_cache, parent_title_cache=parent_title_cache,
    )


# ---------------------------------------------------------------------------
# 작성 / 수정 / 삭제
# ---------------------------------------------------------------------------


@router.post("", response_model=GoalOut, status_code=201)
async def create_goal(
    payload: GoalCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)

    if payload.scope == "COMPANY":
        if user.role != "ADMIN":
            raise HTTPException(
                status_code=403, detail="회사 목표는 ADMIN 만 작성 가능합니다."
            )
    else:  # PERSONAL
        if not _is_admin(user):
            if me is None:
                raise HTTPException(
                    status_code=400,
                    detail="현재 계정이 임직원 정보에 연결되어 있지 않습니다.",
                )
            if payload.owner_id != me.id:
                # 본인이 아니면 직속 매니저인지 확인 — 1단계만 허용 (손자 부하 차단).
                is_mgr = await _is_direct_manager_of(
                    db, manager_id=me.id, subordinate_id=payload.owner_id,
                )
                if not is_mgr:
                    raise HTTPException(
                        status_code=403,
                        detail="본인 또는 직속 부하의 목표만 작성할 수 있습니다.",
                    )

    if payload.parent_goal_id:
        parent = (
            await db.execute(select(Goal).where(Goal.id == payload.parent_goal_id))
        ).scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=400, detail="parent_goal_id 가 유효하지 않습니다.")
        _validate_parent(parent, payload.scope)

    g = Goal(**payload.model_dump())
    db.add(g)
    await db.commit()
    await db.refresh(g)
    logger.info(
        "목표 생성: id=%s scope=%s year=%d owner=%s 작성자=%s",
        g.id, g.scope, g.year, g.owner_id, user.id,
    )
    return await _build_out(db, g, me, user)


@router.patch("/{goal_id}", response_model=GoalOut)
async def update_goal(
    goal_id: UUID,
    payload: GoalUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="목표를 찾을 수 없습니다.")
    if not await _can_edit(db, g, me, user):
        raise HTTPException(status_code=403, detail="이 목표를 수정할 권한이 없습니다.")

    data = payload.model_dump(exclude_unset=True)
    if "parent_goal_id" in data and data["parent_goal_id"]:
        parent = (
            await db.execute(select(Goal).where(Goal.id == data["parent_goal_id"]))
        ).scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=400, detail="parent_goal_id 가 유효하지 않습니다.")
        _validate_parent(parent, g.scope)
        # 자기 자신을 부모로 지정 금지.
        if parent.id == g.id:
            raise HTTPException(status_code=400, detail="자기 자신을 부모로 지정할 수 없습니다.")
    # 완료 알림 트랜지션 감지 — DONE 으로 새로 진입할 때만.
    prev_status = g.status
    for k, v in data.items():
        setattr(g, k, v)
    became_done = prev_status != "DONE" and g.status == "DONE"
    await db.commit()
    await db.refresh(g)
    logger.info(
        "목표 수정: id=%s 변경=%s 수정자=%s",
        goal_id, list(data.keys()), user.id,
    )
    if became_done:
        try:
            await notify_goal_completed(db, g.id)
        except Exception as exc:
            logger.warning(
                "goal_notify_completed 실패 (goal=%s): %s", goal_id, exc,
            )
    return await _build_out(db, g, me, user)


@router.delete("/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_goal(
    goal_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="목표를 찾을 수 없습니다.")
    if not await _can_edit(db, g, me, user):
        raise HTTPException(status_code=403, detail="이 목표를 삭제할 권한이 없습니다.")
    await db.delete(g)
    await db.commit()
    logger.warning(
        "목표 삭제: id=%s scope=%s year=%d 삭제자=%s",
        goal_id, g.scope, g.year, user.id,
    )


# ---------------------------------------------------------------------------
# 평가 점수 입력 — 자기 / 매니저 분리.
# ---------------------------------------------------------------------------


@router.post("/{goal_id}/score-self", response_model=GoalOut)
async def score_self(
    goal_id: UUID,
    payload: GoalScoreInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인의 PERSONAL 목표에 자기 평가 점수 (0~150) 저장."""
    me = await _resolve_my_developer(db, user)
    g = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="목표를 찾을 수 없습니다.")
    if not await _can_score_self(g, me):
        raise HTTPException(status_code=403, detail="본인의 PERSONAL 목표만 자기 평가가 가능합니다.")
    g.self_score = payload.score
    g.self_score_comment = payload.comment
    await db.commit()
    await db.refresh(g)
    logger.info("목표 자기평가: id=%s score=%s actor=%s", goal_id, payload.score, user.id)
    return await _build_out(db, g, me, user)


@router.post("/{goal_id}/score-manager", response_model=GoalOut)
async def score_manager(
    goal_id: UUID,
    payload: GoalScoreInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """직속 매니저가 부하 PERSONAL 목표에 매니저 평가 점수 (0~150) 저장."""
    me = await _resolve_my_developer(db, user)
    g = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="목표를 찾을 수 없습니다.")
    if not await _can_score_manager(db, g, me):
        raise HTTPException(
            status_code=403,
            detail="직속 매니저만 부하의 PERSONAL 목표에 매니저 평가를 입력할 수 있습니다.",
        )
    from datetime import datetime, timezone
    g.manager_score = payload.score
    g.manager_score_comment = payload.comment
    g.manager_score_by_id = me.id if me else None
    g.manager_score_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(g)
    logger.info(
        "목표 매니저평가: id=%s score=%s actor=%s", goal_id, payload.score, user.id,
    )
    return await _build_out(db, g, me, user)


# 종합 점수 endpoint 는 위쪽 (literal route /score/summary) 에 정의됨.


# ---------------------------------------------------------------------------
# 코멘트 — 조회 권한자 누구나 작성 / 작성자 + HR/ADMIN 만 편집·삭제.
# ---------------------------------------------------------------------------


async def _load_goal_or_404(db: AsyncSession, goal_id: UUID) -> Goal:
    g = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="목표를 찾을 수 없습니다.")
    return g


def _can_edit_comment(c: GoalComment, me: Developer | None, user: User) -> bool:
    if _is_admin(user):
        return True
    if me is None or c.author_id is None:
        return False
    return c.author_id == me.id


async def _serialize_comment(
    db: AsyncSession, c: GoalComment, me: Developer | None, user: User,
    *, name_cache: dict[UUID, str] | None = None,
    user_name_cache: dict[UUID, str] | None = None,
) -> GoalCommentOut:
    """이름 우선순위:
       author_id → developer.name (name_cache)
       → author_user_id → user.name (user_name_cache)
       → None (frontend "(작성자 없음)" fallback).

    cache 미명시 + 단건 조회 흐름이면 DB 직접 lookup 으로 fallback.
    """
    name_cache = name_cache or {}
    user_name_cache = user_name_cache or {}
    name: str | None = None
    if c.author_id:
        name = name_cache.get(c.author_id)
        if not name:
            dev = (
                await db.execute(
                    select(Developer).where(Developer.id == c.author_id)
                )
            ).scalar_one_or_none()
            if dev:
                name = dev.name
    if not name and c.author_user_id:
        name = user_name_cache.get(c.author_user_id)
        if not name:
            urow = (
                await db.execute(
                    select(User.name).where(User.id == c.author_user_id)
                )
            ).scalar_one_or_none()
            if urow:
                name = urow
    return GoalCommentOut(
        id=c.id,
        goal_id=c.goal_id,
        author_id=c.author_id,
        author_name=name,
        body=c.body,
        created_at=c.created_at,
        updated_at=c.updated_at,
        can_edit=_can_edit_comment(c, me, user),
    )


@router.get("/{goal_id}/comments", response_model=list[GoalCommentOut])
async def list_comments(
    goal_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_view(db, g, me, user):
        raise HTTPException(status_code=403, detail="조회 권한이 없습니다.")
    rows = list(
        (
            await db.execute(
                select(GoalComment)
                .where(GoalComment.goal_id == goal_id)
                .order_by(GoalComment.created_at.asc())
            )
        ).scalars()
    )
    name_cache = await _name_map(db, [c.author_id for c in rows if c.author_id])
    # User 이름 fallback — developer 미매핑 사용자(ADMIN 부트스트랩 등) 표시.
    user_ids = [c.author_user_id for c in rows if c.author_user_id]
    user_name_cache: dict[UUID, str] = {}
    if user_ids:
        urows = (
            await db.execute(
                select(User.id, User.name).where(User.id.in_(set(user_ids)))
            )
        ).all()
        user_name_cache = {uid: nm for uid, nm in urows}
    return [
        await _serialize_comment(
            db, c, me, user,
            name_cache=name_cache, user_name_cache=user_name_cache,
        )
        for c in rows
    ]


@router.post("/{goal_id}/comments", response_model=GoalCommentOut, status_code=201)
async def create_comment(
    goal_id: UUID,
    payload: GoalCommentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_view(db, g, me, user):
        raise HTTPException(status_code=403, detail="작성 권한이 없습니다.")
    c = GoalComment(
        goal_id=goal_id,
        author_id=me.id if me else None,
        author_user_id=user.id,   # developer 미매핑 시에도 작성자 추적.
        body=payload.body,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info("목표 코멘트 작성: goal=%s comment=%s actor=%s",
                goal_id, c.id, user.id)
    return await _serialize_comment(db, c, me, user)


@router.patch(
    "/{goal_id}/comments/{comment_id}", response_model=GoalCommentOut,
)
async def update_comment(
    goal_id: UUID,
    comment_id: UUID,
    payload: GoalCommentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    c = (
        await db.execute(
            select(GoalComment).where(
                GoalComment.id == comment_id, GoalComment.goal_id == goal_id,
            )
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    if not _can_edit_comment(c, me, user):
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")
    c.body = payload.body
    await db.commit()
    await db.refresh(c)
    logger.info("목표 코멘트 수정: goal=%s comment=%s actor=%s",
                goal_id, comment_id, user.id)
    return await _serialize_comment(db, c, me, user)


@router.delete(
    "/{goal_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_comment(
    goal_id: UUID,
    comment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    c = (
        await db.execute(
            select(GoalComment).where(
                GoalComment.id == comment_id, GoalComment.goal_id == goal_id,
            )
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    if not _can_edit_comment(c, me, user):
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다.")
    await db.delete(c)
    await db.commit()
    logger.warning("목표 코멘트 삭제: goal=%s comment=%s actor=%s",
                   goal_id, comment_id, user.id)


# ---------------------------------------------------------------------------
# 첨부파일 — 업로드/다운로드/이름변경/삭제
# 권한: 업로드·이름변경·삭제 = goal._can_edit (본인 + 직속 매니저 + HR/ADMIN).
#       다운로드 = _can_view 통과한 누구나.
# 저장: data/<tenant>/goals/<goal_id>/<uuid>.<ext>
# ---------------------------------------------------------------------------


async def _serialize_attachment(
    db: AsyncSession, a: GoalAttachment, *,
    name_cache: dict[UUID, str] | None = None,
    can_modify: bool = False,
) -> GoalAttachmentOut:
    name_cache = name_cache or {}
    return GoalAttachmentOut(
        id=a.id,
        goal_id=a.goal_id,
        file_name=a.file_name,
        mime_type=a.mime_type,
        size=a.size,
        uploaded_by_id=a.uploaded_by_id,
        uploaded_by_name=name_cache.get(a.uploaded_by_id) if a.uploaded_by_id else None,
        created_at=a.created_at,
        updated_at=a.updated_at,
        can_modify=can_modify,
    )


@router.get("/{goal_id}/attachments", response_model=list[GoalAttachmentOut])
async def list_attachments(
    goal_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_view(db, g, me, user):
        raise HTTPException(status_code=403, detail="조회 권한이 없습니다.")
    can_modify = await _can_edit(db, g, me, user)
    rows = list(
        (
            await db.execute(
                select(GoalAttachment)
                .where(GoalAttachment.goal_id == goal_id)
                .order_by(GoalAttachment.created_at.asc())
            )
        ).scalars()
    )
    name_cache = await _name_map(db, [a.uploaded_by_id for a in rows if a.uploaded_by_id])
    return [
        await _serialize_attachment(db, a, name_cache=name_cache, can_modify=can_modify)
        for a in rows
    ]


@router.post(
    "/{goal_id}/attachments", response_model=GoalAttachmentOut, status_code=201,
)
async def upload_attachment(
    goal_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_edit(db, g, me, user):
        raise HTTPException(status_code=403, detail="첨부 권한이 없습니다.")
    stored, size = await save_upload(file, f"goals/{goal_id}")
    a = GoalAttachment(
        goal_id=goal_id,
        file_name=file.filename or "file",
        mime_type=file.content_type,
        size=size,
        file_path=stored,
        uploaded_by_id=me.id if me else None,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    logger.info(
        "목표 첨부 업로드: goal=%s file=%s size=%d actor=%s",
        goal_id, a.file_name, size, user.id,
    )
    return await _serialize_attachment(db, a, can_modify=True)


@router.get("/{goal_id}/attachments/{attachment_id}/download")
async def download_attachment(
    goal_id: UUID,
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_view(db, g, me, user):
        raise HTTPException(status_code=403, detail="조회 권한이 없습니다.")
    a = (
        await db.execute(
            select(GoalAttachment).where(
                GoalAttachment.id == attachment_id,
                GoalAttachment.goal_id == goal_id,
            )
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(a.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        filename=a.file_name,
        media_type=a.mime_type or "application/octet-stream",
    )


@router.patch(
    "/{goal_id}/attachments/{attachment_id}",
    response_model=GoalAttachmentOut,
)
async def rename_attachment(
    goal_id: UUID,
    attachment_id: UUID,
    payload: GoalAttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_edit(db, g, me, user):
        raise HTTPException(status_code=403, detail="이름 변경 권한이 없습니다.")
    a = (
        await db.execute(
            select(GoalAttachment).where(
                GoalAttachment.id == attachment_id,
                GoalAttachment.goal_id == goal_id,
            )
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    a.file_name = payload.file_name.strip()
    await db.commit()
    await db.refresh(a)
    logger.info(
        "목표 첨부 이름변경: goal=%s att=%s → '%s' actor=%s",
        goal_id, attachment_id, a.file_name, user.id,
    )
    return await _serialize_attachment(db, a, can_modify=True)


@router.delete(
    "/{goal_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_attachment(
    goal_id: UUID,
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    g = await _load_goal_or_404(db, goal_id)
    if not await _can_edit(db, g, me, user):
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다.")
    a = (
        await db.execute(
            select(GoalAttachment).where(
                GoalAttachment.id == attachment_id,
                GoalAttachment.goal_id == goal_id,
            )
        )
    ).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    delete_file(a.file_path)
    await db.delete(a)
    await db.commit()
    logger.warning(
        "목표 첨부 삭제: goal=%s att=%s file=%s actor=%s",
        goal_id, attachment_id, a.file_name, user.id,
    )
