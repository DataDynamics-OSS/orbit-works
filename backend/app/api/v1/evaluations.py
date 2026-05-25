"""임직원 평가 API.

Endpoints:
  Cycles (HR/ADMIN):
    GET    /evaluations/cycles
    POST   /evaluations/cycles
    PATCH  /evaluations/cycles/{id}
    POST   /evaluations/cycles/{id}/open      DRAFT → OPEN, 자동 evaluations row 생성
    POST   /evaluations/cycles/{id}/close     OPEN → CLOSED
    DELETE /evaluations/cycles/{id}           DRAFT 만

  Dimensions (read: 모든 인증 / write: ADMIN):
    GET    /evaluations/dimensions            첫 호출 시 default 7종 자동 시드
    PUT    /evaluations/dimensions            ADMIN — bulk upsert + sort

  Evaluations:
    GET    /evaluations?cycle_id=&owner=me|team|all
    GET    /evaluations/{id}
    PATCH  /evaluations/{id}/self             본인 — narrative + competency self_score
    POST   /evaluations/{id}/self/submit
    POST   /evaluations/{id}/self/reopen
    PATCH  /evaluations/{id}/manager          매니저 — narrative + competency manager_score
    POST   /evaluations/{id}/manager/submit
    POST   /evaluations/{id}/manager/reopen
    PATCH  /evaluations/{id}/calibrate        HR — final_*
    POST   /evaluations/{id}/finalize         CALIBRATED → FINALIZED (본인 공개)
    POST   /evaluations/{id}/admin-reopen     HR — 어느 단계든 되돌리기

권한:
  - HR/ADMIN — cycle 관리 + 모든 evaluation calibration·열람.
  - 매니저 (직속 부하 1명 이상) — 부하의 manager_score / manager_narrative.
  - 본인 — 본인 self_*. FINALIZED 후에만 manager_* / final_* 조회 가능.
  - calibration_note — HR/ADMIN 전용 (본인·매니저 미노출).

Logging:
  INFO  — cycle 생성/오픈/종료, evaluation 단계 transition, dimension 갱신.
  WARNING — 권한 거부 (silent skip 추적), HR admin-reopen.
"""

from __future__ import annotations

import logging
from datetime import date as date_cls, datetime, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.roles import has as role_has
from app.models import (
    CompetencyDimension,
    Developer,
    Evaluation,
    EvaluationCompetencyScore,
    EvaluationCycle,
    Goal,
    User,
)
from app.models.evaluation import DEFAULT_DIMENSIONS
from app.services.evaluation_notify import (
    notify_cycle_opened,
    notify_finalized,
    notify_manager_submitted,
    notify_self_submitted,
)
from app.schemas.evaluation import (
    CalibratePayload,
    CompetencyScoreInput,
    CompetencyScoreOut,
    CycleCreate,
    CycleOut,
    CycleUpdate,
    DimensionsBulkUpsert,
    DimensionOut,
    EvaluationGoalSummary,
    EvaluationOut,
    EvaluationRowOut,
    ManagerPayload,
    SelfPayload,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/evaluations", tags=["evaluations"])


# ===========================================================================
# Helpers — 권한, 가시성, 자동 집계
# ===========================================================================


def _is_admin_hr(user: User) -> bool:
    """HR / ADMIN / SUPER_ADMIN — cycle 관리·calibration·전체 열람."""
    return user.role in ("SUPER_ADMIN", "ADMIN", "HR") or role_has(
        user.role, "evaluations.manage"
    )


def _require_admin_hr(user: User) -> None:
    if not _is_admin_hr(user):
        raise HTTPException(status_code=403, detail="HR/ADMIN 권한이 필요합니다.")


def _require_admin(user: User) -> None:
    if user.role not in ("SUPER_ADMIN", "ADMIN"):
        raise HTTPException(status_code=403, detail="ADMIN 권한이 필요합니다.")


async def _ensure_default_dimensions(db: AsyncSession) -> None:
    """tenant 가 처음 dimensions 를 조회할 때 default 7종 자동 시드.

    SQLAlchemy listener (`fn_auto_tenant_id`) 가 INSERT 시 GUC 의 tenant_id
    를 자동 채움. 이미 row 가 있으면 no-op.
    """
    n = await db.scalar(select(func.count(CompetencyDimension.id)))
    if n and n > 0:
        return
    for d in DEFAULT_DIMENSIONS:
        db.add(CompetencyDimension(**d))
    await db.commit()
    logger.info("competency_dimensions seed: %d 종 default 시드", len(DEFAULT_DIMENSIONS))


def _self_owns(evaluation: Evaluation, user: User) -> bool:
    return (
        user.mapped_developer_id is not None
        and evaluation.developer_id == user.mapped_developer_id
    )


def _is_evaluation_manager(evaluation: Evaluation, user: User) -> bool:
    """이 평가의 직속 매니저인가 (cycle open 시점의 스냅샷)."""
    return (
        user.mapped_developer_id is not None
        and evaluation.manager_id is not None
        and evaluation.manager_id == user.mapped_developer_id
    )


def _can_view(evaluation: Evaluation, user: User) -> bool:
    if _is_admin_hr(user):
        return True
    if _self_owns(evaluation, user):
        return True
    if _is_evaluation_manager(evaluation, user):
        return True
    return False


def _can_self_edit(evaluation: Evaluation, user: User) -> bool:
    """본인 self stage 작성 — SELF_DRAFT 상태에서 + 본인."""
    if not _self_owns(evaluation, user):
        return False
    return evaluation.status in ("NOT_STARTED", "SELF_DRAFT")


def _can_self_submit(evaluation: Evaluation, user: User) -> bool:
    return _self_owns(evaluation, user) and evaluation.status in (
        "NOT_STARTED",
        "SELF_DRAFT",
    )


def _can_self_reopen(evaluation: Evaluation, user: User) -> bool:
    """본인 self 재오픈 — 매니저가 작성 시작 전까지 (SELF_SUBMITTED 만)."""
    return _self_owns(evaluation, user) and evaluation.status == "SELF_SUBMITTED"


def _can_manager_edit(evaluation: Evaluation, user: User) -> bool:
    if not _is_evaluation_manager(evaluation, user):
        return False
    return evaluation.status in ("SELF_SUBMITTED", "MGR_DRAFT")


def _can_manager_submit(evaluation: Evaluation, user: User) -> bool:
    return _is_evaluation_manager(evaluation, user) and evaluation.status in (
        "SELF_SUBMITTED",
        "MGR_DRAFT",
    )


def _can_manager_reopen(evaluation: Evaluation, user: User) -> bool:
    """매니저 재오픈 — HR calibration 전까지 (MGR_SUBMITTED 만)."""
    return _is_evaluation_manager(evaluation, user) and evaluation.status == "MGR_SUBMITTED"


def _can_calibrate(evaluation: Evaluation, user: User) -> bool:
    if not _is_admin_hr(user):
        return False
    return evaluation.status in ("MGR_SUBMITTED", "CALIBRATED")


def _can_finalize(evaluation: Evaluation, user: User) -> bool:
    return _is_admin_hr(user) and evaluation.status == "CALIBRATED"


# ---------------------------------------------------------------------------
# 가시성 — 본인이 본인 평가를 조회할 때 권한별 None 처리.
# ---------------------------------------------------------------------------


def _scrub_for_viewer(out: EvaluationOut, evaluation: Evaluation, user: User) -> EvaluationOut:
    """매니저 평가·HR 메모는 권한별로 가린다.

    - 본인 (자기 평가 조회): manager_* / final_* 는 FINALIZED 후에만 보임.
      calibration_note 는 항상 안 보임.
    - 매니저 (부하 평가 조회): self / manager 다 보임. final_* 는 CALIBRATED
      후. calibration_note 안 보임.
    - HR/ADMIN: 모두 보임.
    """
    if _is_admin_hr(user):
        return out

    if _is_evaluation_manager(evaluation, user):
        # 매니저 — calibration_note 만 가림. final 은 CALIBRATED 후 노출.
        out.calibration_note = None
        if evaluation.status not in ("CALIBRATED", "FINALIZED"):
            out.final_grade = None
            out.final_overall_score = None
            out.goal_score_final = None
            out.competency_avg_final = None
            for c in out.competencies:
                c.final_score = None
                c.final_comment = None
        return out

    # 본인 — manager_* 와 final_* 는 FINALIZED 후만.
    out.calibration_note = None
    if evaluation.status != "FINALIZED":
        out.manager_narrative = None
        out.goal_score_manager = None
        out.competency_avg_manager = None
        out.final_grade = None
        out.final_overall_score = None
        out.goal_score_final = None
        out.competency_avg_final = None
        for c in out.competencies:
            c.manager_score = None
            c.manager_comment = None
            c.final_score = None
            c.final_comment = None
    return out


# ---------------------------------------------------------------------------
# 목표 자동 집계 — cycle.start_date~end_date 의 PERSONAL goal.
# ---------------------------------------------------------------------------


async def _compute_goal_summary(
    db: AsyncSession, cycle: EvaluationCycle, developer_id: UUID,
) -> EvaluationGoalSummary:
    """cycle.year 의 PERSONAL goal 집계.

    1H / 2H 둘 다 cycle.year 의 같은 goals 를 보지만, 그 시점의 progress 가
    다르므로 자연스럽게 반기 차별화. status='DRAFT' 는 미진행 — 제외.
    prefill_score 는 progress_pct 선형 변환 (0%→1.0, 100%→5.0).
    """
    rows = list(
        (
            await db.execute(
                select(Goal).where(
                    Goal.scope == "PERSONAL",
                    Goal.owner_id == developer_id,
                    Goal.year == cycle.year,
                    Goal.status != "DRAFT",
                )
            )
        ).scalars()
    )
    if not rows:
        return EvaluationGoalSummary()
    total = len(rows)
    completed = sum(1 for g in rows if g.status == "DONE")
    progress = sum(float(g.progress_pct or 0) for g in rows) / total
    sum_self = sum(float(g.self_score or 0) for g in rows)
    sum_mgr = sum(float(g.manager_score or 0) for g in rows)
    prefill = max(1.0, min(5.0, 1.0 + 4.0 * progress / 100.0))
    return EvaluationGoalSummary(
        count=total,
        completed=completed,
        avg_progress=round(progress, 1),
        sum_self_score=round(sum_self, 1),
        sum_manager_score=round(sum_mgr, 1),
        prefill_score=round(prefill, 2),
    )


# ---------------------------------------------------------------------------
# 역량 평균 재계산.
# ---------------------------------------------------------------------------


def _recompute_avgs(evaluation: Evaluation) -> None:
    """competencies 변경 후 self/manager/final 평균 갱신 (NULL 제외)."""
    self_scores = [c.self_score for c in evaluation.competencies if c.self_score is not None]
    mgr_scores = [c.manager_score for c in evaluation.competencies if c.manager_score is not None]
    fin_scores = [c.final_score for c in evaluation.competencies if c.final_score is not None]
    evaluation.competency_avg_self = (
        Decimal(sum(self_scores) / len(self_scores)).quantize(Decimal("0.01"))
        if self_scores
        else None
    )
    evaluation.competency_avg_manager = (
        Decimal(sum(mgr_scores) / len(mgr_scores)).quantize(Decimal("0.01"))
        if mgr_scores
        else None
    )
    evaluation.competency_avg_final = (
        Decimal(sum(fin_scores) / len(fin_scores)).quantize(Decimal("0.01"))
        if fin_scores
        else None
    )


def _apply_competency_input(
    evaluation: Evaluation,
    items: list[CompetencyScoreInput],
    *,
    stage: str,
) -> None:
    """stage='self'/'manager'/'final' 에 해당하는 컬럼만 update."""
    by_key = {c.dimension_key: c for c in evaluation.competencies}
    for item in items:
        c = by_key.get(item.dimension_key)
        if c is None:
            c = EvaluationCompetencyScore(
                evaluation_id=evaluation.id,
                dimension_key=item.dimension_key,
            )
            evaluation.competencies.append(c)
            by_key[item.dimension_key] = c
        if stage == "self":
            c.self_score = item.score
            c.self_comment = item.comment
        elif stage == "manager":
            c.manager_score = item.score
            c.manager_comment = item.comment
        elif stage == "final":
            c.final_score = item.score
            c.final_comment = item.comment
    _recompute_avgs(evaluation)


# ---------------------------------------------------------------------------
# Row → DTO 변환.
# ---------------------------------------------------------------------------


async def _name_maps(
    db: AsyncSession, dev_ids: set[UUID]
) -> dict[UUID, str]:
    if not dev_ids:
        return {}
    rows = (
        await db.execute(
            select(Developer.id, Developer.name).where(Developer.id.in_(dev_ids))
        )
    ).all()
    return {r[0]: r[1] for r in rows}


def _row_out(
    evaluation: Evaluation,
    *,
    dev_name: str | None,
    mgr_name: str | None,
    user: User,
    rank_id: UUID | None = None,
    rank_name: str | None = None,
    rank_sort_order: int | None = None,
) -> EvaluationRowOut:
    from app.schemas.evaluation import CompetencyScoreLite

    return EvaluationRowOut(
        id=evaluation.id,
        cycle_id=evaluation.cycle_id,
        developer_id=evaluation.developer_id,
        developer_name=dev_name,
        manager_id=evaluation.manager_id,
        manager_name=mgr_name,
        status=evaluation.status,  # type: ignore[arg-type]
        final_grade=evaluation.final_grade,  # type: ignore[arg-type]
        final_overall_score=evaluation.final_overall_score,
        self_submitted_at=evaluation.self_submitted_at,
        manager_submitted_at=evaluation.manager_submitted_at,
        finalized_at=evaluation.finalized_at,
        can_self=_can_self_edit(evaluation, user),
        can_manager=_can_manager_edit(evaluation, user),
        can_calibrate=_can_calibrate(evaluation, user),
        competencies=[
            CompetencyScoreLite.model_validate(c, from_attributes=True)
            for c in (evaluation.competencies or [])
        ],
        rank_id=rank_id,
        rank_name=rank_name,
        rank_sort_order=rank_sort_order,
        updated_at=evaluation.updated_at,
    )


async def _detail_out(
    db: AsyncSession,
    evaluation: Evaluation,
    *,
    user: User,
    cycle: EvaluationCycle | None = None,
) -> EvaluationOut:
    name_map = await _name_maps(
        db,
        {evaluation.developer_id} | ({evaluation.manager_id} if evaluation.manager_id else set()),
    )
    base = _row_out(
        evaluation,
        dev_name=name_map.get(evaluation.developer_id),
        mgr_name=name_map.get(evaluation.manager_id) if evaluation.manager_id else None,
        user=user,
    )
    # base 의 competencies(lite) 는 detail 용(CompetencyScoreOut, 코멘트 포함) 으로
    # 덮어쓰기. 같은 키워드를 두 번 넘기지 않도록 dict 에서 제거.
    base_dict = base.model_dump()
    base_dict.pop("competencies", None)
    out = EvaluationOut(
        **base_dict,
        self_narrative=evaluation.self_narrative,
        manager_narrative=evaluation.manager_narrative,
        calibration_note=evaluation.calibration_note,
        goal_score_self=evaluation.goal_score_self,
        goal_score_manager=evaluation.goal_score_manager,
        goal_score_final=evaluation.goal_score_final,
        competency_avg_self=evaluation.competency_avg_self,
        competency_avg_manager=evaluation.competency_avg_manager,
        competency_avg_final=evaluation.competency_avg_final,
        competencies=[
            CompetencyScoreOut.model_validate(c, from_attributes=True)
            for c in (evaluation.competencies or [])
        ],
    )
    # goal summary — cycle 정보가 필요. 호출자가 미리 넣어주거나 여기서 fetch.
    if cycle is None:
        cycle = (
            await db.execute(
                select(EvaluationCycle).where(EvaluationCycle.id == evaluation.cycle_id)
            )
        ).scalar_one_or_none()
    if cycle is not None:
        out.goal_summary = await _compute_goal_summary(
            db, cycle, evaluation.developer_id
        )
    return _scrub_for_viewer(out, evaluation, user)


# ---------------------------------------------------------------------------
# Cycle 통계 (rows 자동 생성 후 카운트).
# ---------------------------------------------------------------------------


async def _cycle_counts(
    db: AsyncSession, cycle_id: UUID
) -> tuple[int, int, int]:
    total = await db.scalar(
        select(func.count(Evaluation.id)).where(Evaluation.cycle_id == cycle_id)
    ) or 0
    submitted = await db.scalar(
        select(func.count(Evaluation.id)).where(
            Evaluation.cycle_id == cycle_id,
            Evaluation.status.in_(["MGR_SUBMITTED", "CALIBRATED", "FINALIZED"]),
        )
    ) or 0
    finalized = await db.scalar(
        select(func.count(Evaluation.id)).where(
            Evaluation.cycle_id == cycle_id,
            Evaluation.status == "FINALIZED",
        )
    ) or 0
    return total, submitted, finalized


def _cycle_out(c: EvaluationCycle, *, total: int = 0, sub: int = 0, fin: int = 0) -> CycleOut:
    return CycleOut(
        id=c.id,
        year=c.year,
        period=c.period,  # type: ignore[arg-type]
        name=c.name,
        start_date=c.start_date,
        end_date=c.end_date,
        self_due=c.self_due,
        manager_due=c.manager_due,
        finalize_due=c.finalize_due,
        status=c.status,  # type: ignore[arg-type]
        opened_at=c.opened_at,
        closed_at=c.closed_at,
        created_at=c.created_at,
        updated_at=c.updated_at,
        evaluation_count=total,
        submitted_count=sub,
        finalized_count=fin,
    )


# ===========================================================================
# Cycles
# ===========================================================================


@router.get("/cycles", response_model=list[CycleOut])
async def list_cycles(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """HR/ADMIN — 전체. 그 외 — 본인 evaluation 이 1건이라도 있는 cycle 만."""
    if _is_admin_hr(user):
        rows = list(
            (
                await db.execute(
                    select(EvaluationCycle).order_by(
                        EvaluationCycle.year.desc(), EvaluationCycle.period.desc()
                    )
                )
            ).scalars()
        )
    else:
        if not user.mapped_developer_id:
            return []
        # 본인 evaluation 이 있는 cycle 만 (자기 평가 + 부하 평가).
        rows = list(
            (
                await db.execute(
                    select(EvaluationCycle)
                    .join(Evaluation, Evaluation.cycle_id == EvaluationCycle.id)
                    .where(
                        (Evaluation.developer_id == user.mapped_developer_id)
                        | (Evaluation.manager_id == user.mapped_developer_id)
                    )
                    .distinct()
                    .order_by(EvaluationCycle.year.desc(), EvaluationCycle.period.desc())
                )
            ).scalars()
        )
    out: list[CycleOut] = []
    for c in rows:
        total, sub, fin = await _cycle_counts(db, c.id)
        out.append(_cycle_out(c, total=total, sub=sub, fin=fin))
    return out


@router.post("/cycles", response_model=CycleOut, status_code=status.HTTP_201_CREATED)
async def create_cycle(
    payload: CycleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    c = EvaluationCycle(
        year=payload.year,
        period=payload.period,
        name=payload.name,
        start_date=payload.start_date,
        end_date=payload.end_date,
        self_due=payload.self_due,
        manager_due=payload.manager_due,
        finalize_due=payload.finalize_due,
        created_by_user_id=user.id,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info(
        "평가 cycle 생성: id=%s %d-%s name=%s (요청자=%s)",
        c.id, c.year, c.period, c.name, user.id,
    )
    return _cycle_out(c)


@router.patch("/cycles/{cycle_id}", response_model=CycleOut)
async def update_cycle(
    cycle_id: UUID,
    payload: CycleUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    c = (
        await db.execute(
            select(EvaluationCycle).where(EvaluationCycle.id == cycle_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="cycle 을 찾을 수 없습니다.")
    # OPEN 이후엔 deadline 외 변경 차단 (이름·일정 미세 조정만 허용).
    data = payload.model_dump(exclude_unset=True)
    if c.status != "DRAFT":
        forbidden = {"start_date", "end_date"}
        bad = forbidden & data.keys()
        if bad:
            raise HTTPException(
                status_code=400,
                detail=f"OPEN 이후엔 {', '.join(bad)} 변경 불가.",
            )
    for k, v in data.items():
        setattr(c, k, v)
    await db.commit()
    await db.refresh(c)
    total, sub, fin = await _cycle_counts(db, c.id)
    logger.info("평가 cycle 갱신: id=%s (요청자=%s)", c.id, user.id)
    return _cycle_out(c, total=total, sub=sub, fin=fin)


@router.delete("/cycles/{cycle_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cycle(
    cycle_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    c = (
        await db.execute(
            select(EvaluationCycle).where(EvaluationCycle.id == cycle_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="cycle 을 찾을 수 없습니다.")
    if c.status != "DRAFT":
        raise HTTPException(
            status_code=400, detail="DRAFT 상태에서만 삭제할 수 있습니다.",
        )
    await db.delete(c)
    await db.commit()
    logger.warning("평가 cycle 삭제: id=%s (요청자=%s)", cycle_id, user.id)


@router.post("/cycles/{cycle_id}/open", response_model=CycleOut)
async def open_cycle(
    cycle_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """DRAFT → OPEN. 모든 active+FULL_TIME developer 에 evaluations row 자동 생성.

    매니저 = developer.manager_id 스냅샷. 매니저가 없으면 NULL (대표·고위직).
    이미 row 가 있으면 (재진입) 추가 생성 안 함.
    """
    _require_admin_hr(user)
    c = (
        await db.execute(
            select(EvaluationCycle).where(EvaluationCycle.id == cycle_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="cycle 을 찾을 수 없습니다.")
    if c.status != "DRAFT":
        raise HTTPException(
            status_code=400, detail=f"이미 {c.status} 상태입니다.",
        )

    # 대상자 — ACTIVE + FULL_TIME.
    devs = list(
        (
            await db.execute(
                select(Developer.id, Developer.manager_id).where(
                    Developer.status == "ACTIVE",
                    Developer.employment_type == "FULL_TIME",
                )
            )
        ).all()
    )

    # 기존 row (재오픈·재진입 대비) — 새로 INSERT 안 함.
    existing = set(
        (
            await db.execute(
                select(Evaluation.developer_id).where(Evaluation.cycle_id == c.id)
            )
        ).scalars()
    )
    created = 0
    for dev_id, mgr_id in devs:
        if dev_id in existing:
            continue
        db.add(Evaluation(
            cycle_id=c.id, developer_id=dev_id, manager_id=mgr_id,
        ))
        created += 1

    c.status = "OPEN"
    c.opened_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(c)
    logger.info(
        "평가 cycle OPEN: id=%s 자동 생성=%d명 (요청자=%s)",
        cycle_id, created, user.id,
    )
    # broadcast 알림 — 발송 실패가 cycle 상태를 망가뜨리지 않도록 try/except.
    try:
        await notify_cycle_opened(db, c.id)
    except Exception as exc:  # pragma: no cover
        logger.warning("notify_cycle_opened 실패 (cycle=%s): %s", c.id, exc)
    total, sub, fin = await _cycle_counts(db, c.id)
    return _cycle_out(c, total=total, sub=sub, fin=fin)


@router.post("/cycles/{cycle_id}/close", response_model=CycleOut)
async def close_cycle(
    cycle_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    c = (
        await db.execute(
            select(EvaluationCycle).where(EvaluationCycle.id == cycle_id)
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="cycle 을 찾을 수 없습니다.")
    if c.status not in ("OPEN", "CALIBRATING"):
        raise HTTPException(
            status_code=400, detail=f"{c.status} 상태에선 종료할 수 없습니다.",
        )
    c.status = "CLOSED"
    c.closed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(c)
    logger.info("평가 cycle CLOSE: id=%s (요청자=%s)", cycle_id, user.id)
    total, sub, fin = await _cycle_counts(db, c.id)
    return _cycle_out(c, total=total, sub=sub, fin=fin)


# ===========================================================================
# Dimensions
# ===========================================================================


@router.get("/dimensions", response_model=list[DimensionOut])
async def list_dimensions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """모든 인증 사용자가 조회 (양식 표시용). 첫 호출 시 default 7종 자동 시드."""
    await _ensure_default_dimensions(db)
    rows = list(
        (
            await db.execute(
                select(CompetencyDimension).order_by(
                    CompetencyDimension.sort_order.asc(),
                    CompetencyDimension.label.asc(),
                )
            )
        ).scalars()
    )
    return [DimensionOut.model_validate(r, from_attributes=True) for r in rows]


@router.put("/dimensions", response_model=list[DimensionOut])
async def upsert_dimensions(
    payload: DimensionsBulkUpsert,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """ADMIN — bulk upsert. payload 에 없는 기존 key 는 active=false 로 비활성화."""
    _require_admin(user)
    existing = list(
        (
            await db.execute(select(CompetencyDimension))
        ).scalars()
    )
    by_key = {d.key: d for d in existing}
    incoming_keys = {item.key for item in payload.items}
    # upsert.
    for item in payload.items:
        d = by_key.get(item.key)
        if d:
            d.label = item.label
            d.description = item.description
            d.sort_order = item.sort_order
            d.active = item.active
        else:
            db.add(CompetencyDimension(**item.model_dump()))
    # payload 에 없는 기존 — soft 비활성화 (이미 진행 중인 평가의 score row 보존).
    for d in existing:
        if d.key not in incoming_keys:
            d.active = False
    await db.commit()
    rows = list(
        (
            await db.execute(
                select(CompetencyDimension).order_by(
                    CompetencyDimension.sort_order.asc()
                )
            )
        ).scalars()
    )
    logger.info("competency_dimensions upsert: %d종 (요청자=%s)", len(rows), user.id)
    return [DimensionOut.model_validate(r, from_attributes=True) for r in rows]


# ===========================================================================
# Evaluations
# ===========================================================================


async def _load_eval_or_404(
    db: AsyncSession, eid: UUID,
) -> Evaluation:
    e = (
        await db.execute(
            select(Evaluation)
            .options(selectinload(Evaluation.competencies))
            .where(Evaluation.id == eid)
        )
    ).scalar_one_or_none()
    if not e:
        raise HTTPException(status_code=404, detail="평가를 찾을 수 없습니다.")
    return e


@router.get("", response_model=list[EvaluationRowOut])
async def list_evaluations(
    cycle_id: UUID | None = None,
    owner: str = "me",   # me | team | all
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """평가 목록.

    owner:
      - me   : 본인 row 만.
      - team : 직속 부하 (manager_id == 본인) — 매니저 권한.
      - all  : 전체 — HR/ADMIN 만.
    """
    # competencies 는 _row_out 에서 카드 mini 게이지로 직렬화 — async lazy load
    # 방지 위해 selectinload.
    stmt = (
        select(Evaluation)
        .options(selectinload(Evaluation.competencies))
        .order_by(Evaluation.developer_id.asc())
    )

    if owner == "me":
        if not user.mapped_developer_id:
            return []
        stmt = stmt.where(Evaluation.developer_id == user.mapped_developer_id)
    elif owner == "team":
        if not user.mapped_developer_id:
            return []
        stmt = stmt.where(Evaluation.manager_id == user.mapped_developer_id)
    elif owner == "all":
        if not _is_admin_hr(user):
            logger.warning(
                "평가 전체 조회 거부: role=%s user_id=%s", user.role, user.id
            )
            return []
    else:
        raise HTTPException(status_code=400, detail="owner 는 me|team|all.")

    if cycle_id:
        stmt = stmt.where(Evaluation.cycle_id == cycle_id)
    rows = list((await db.execute(stmt)).scalars())
    name_map = await _name_maps(
        db,
        {r.developer_id for r in rows} | {r.manager_id for r in rows if r.manager_id},
    )
    # developer → rank(직위) 정보. 카드 그룹핑·정렬용. left join: rank 미배정도 통과.
    from app.models import JobRank
    rank_rows = (
        await db.execute(
            select(
                Developer.id,
                JobRank.id,
                JobRank.name,
                JobRank.sort_order,
            )
            .outerjoin(JobRank, JobRank.id == Developer.rank_id)
            .where(Developer.id.in_({r.developer_id for r in rows} or {None}))
        )
    ).all()
    rank_map: dict[UUID, tuple[UUID | None, str | None, int | None]] = {
        dev_id: (rid, rname, rsort) for (dev_id, rid, rname, rsort) in rank_rows
    }
    return [
        _row_out(
            r,
            dev_name=name_map.get(r.developer_id),
            mgr_name=name_map.get(r.manager_id) if r.manager_id else None,
            user=user,
            rank_id=rank_map.get(r.developer_id, (None, None, None))[0],
            rank_name=rank_map.get(r.developer_id, (None, None, None))[1],
            rank_sort_order=rank_map.get(r.developer_id, (None, None, None))[2],
        )
        for r in rows
    ]


@router.get("/bulk", response_model=list[EvaluationOut])
async def get_evaluations_bulk(
    ids: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """선택된 evaluation 들의 detail 일괄 반환. PDF 인쇄 페이지가 한 번에
    여러 평가를 fetch 할 때 사용. HR/ADMIN 만.

    Query: `ids=uuid1,uuid2,...` (comma-sep). 최대 200개.

    `EvaluationOut` list 반환 — competencies + grade + comments 포함.
    각 평가에 대해 detail 권한 체크 후 visibility 적용.
    """
    if not _is_admin_hr(user):
        logger.warning(
            "evaluations/bulk 접근 거부: role=%s user_id=%s", user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="HR/ADMIN 권한 필요.")

    raw_ids = [s.strip() for s in (ids or "").split(",") if s.strip()]
    if not raw_ids:
        return []
    if len(raw_ids) > 200:
        raise HTTPException(status_code=400, detail="한 번에 최대 200개까지 요청 가능.")
    try:
        uuid_ids = [UUID(s) for s in raw_ids]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="잘못된 UUID 형식.") from exc

    rows = list(
        (
            await db.execute(
                select(Evaluation)
                .options(selectinload(Evaluation.competencies))
                .where(Evaluation.id.in_(uuid_ids))
            )
        ).scalars()
    )
    cycle_ids = {r.cycle_id for r in rows}
    cycles = (
        await db.execute(
            select(EvaluationCycle).where(EvaluationCycle.id.in_(cycle_ids))
        )
    ).scalars()
    cycle_map = {c.id: c for c in cycles}
    out: list[EvaluationOut] = []
    for r in rows:
        out.append(
            await _detail_out(db, r, user=user, cycle=cycle_map.get(r.cycle_id))
        )
    return out


@router.get("/{eid}", response_model=EvaluationOut)
async def get_evaluation(
    eid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_view(e, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    return await _detail_out(db, e, user=user)


# ---------------------------------------------------------------------------
# Self stage
# ---------------------------------------------------------------------------


@router.patch("/{eid}/self", response_model=EvaluationOut)
async def update_self(
    eid: UUID,
    payload: SelfPayload,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_self_edit(e, user):
        logger.warning("self update 거부: eid=%s status=%s user=%s", eid, e.status, user.id)
        raise HTTPException(status_code=403, detail="자기평가 작성 권한이 없습니다.")
    if e.status == "NOT_STARTED":
        e.status = "SELF_DRAFT"
    if payload.self_narrative is not None:
        e.self_narrative = payload.self_narrative
    if payload.goal_score_self is not None:
        e.goal_score_self = payload.goal_score_self
    if payload.competencies:
        _apply_competency_input(e, payload.competencies, stage="self")
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    return await _detail_out(db, e, user=user)


@router.post("/{eid}/self/submit", response_model=EvaluationOut)
async def submit_self(
    eid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_self_submit(e, user):
        raise HTTPException(status_code=403, detail="제출 권한이 없습니다.")
    e.status = "SELF_SUBMITTED"
    e.self_submitted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.info("평가 SELF_SUBMITTED: eid=%s (요청자=%s)", eid, user.id)
    try:
        await notify_self_submitted(db, e.id)
    except Exception as exc:  # pragma: no cover
        logger.warning("notify_self_submitted 실패 (eid=%s): %s", e.id, exc)
    return await _detail_out(db, e, user=user)


@router.post("/{eid}/self/reopen", response_model=EvaluationOut)
async def reopen_self(
    eid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_self_reopen(e, user):
        raise HTTPException(status_code=403, detail="재오픈 권한이 없습니다.")
    e.status = "SELF_DRAFT"
    e.self_submitted_at = None
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.info("평가 self reopen: eid=%s (요청자=%s)", eid, user.id)
    return await _detail_out(db, e, user=user)


# ---------------------------------------------------------------------------
# Manager stage
# ---------------------------------------------------------------------------


@router.patch("/{eid}/manager", response_model=EvaluationOut)
async def update_manager(
    eid: UUID,
    payload: ManagerPayload,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_manager_edit(e, user):
        logger.warning("manager update 거부: eid=%s status=%s user=%s", eid, e.status, user.id)
        raise HTTPException(status_code=403, detail="매니저 평가 권한이 없습니다.")
    if e.status == "SELF_SUBMITTED":
        e.status = "MGR_DRAFT"
    if payload.manager_narrative is not None:
        e.manager_narrative = payload.manager_narrative
    if payload.goal_score_manager is not None:
        e.goal_score_manager = payload.goal_score_manager
    if payload.competencies:
        _apply_competency_input(e, payload.competencies, stage="manager")
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    return await _detail_out(db, e, user=user)


@router.post("/{eid}/manager/submit", response_model=EvaluationOut)
async def submit_manager(
    eid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_manager_submit(e, user):
        raise HTTPException(status_code=403, detail="제출 권한이 없습니다.")
    e.status = "MGR_SUBMITTED"
    e.manager_submitted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.info("평가 MGR_SUBMITTED: eid=%s (요청자=%s)", eid, user.id)
    try:
        await notify_manager_submitted(db, e.id)
    except Exception as exc:  # pragma: no cover
        logger.warning("notify_manager_submitted 실패 (eid=%s): %s", e.id, exc)
    return await _detail_out(db, e, user=user)


@router.post("/{eid}/manager/reopen", response_model=EvaluationOut)
async def reopen_manager(
    eid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_manager_reopen(e, user):
        raise HTTPException(status_code=403, detail="재오픈 권한이 없습니다.")
    e.status = "MGR_DRAFT"
    e.manager_submitted_at = None
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.info("평가 manager reopen: eid=%s (요청자=%s)", eid, user.id)
    return await _detail_out(db, e, user=user)


# ---------------------------------------------------------------------------
# Calibration / Finalize
# ---------------------------------------------------------------------------


@router.patch("/{eid}/calibrate", response_model=EvaluationOut)
async def calibrate(
    eid: UUID,
    payload: CalibratePayload,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_calibrate(e, user):
        logger.warning("calibrate 거부: eid=%s status=%s user=%s", eid, e.status, user.id)
        raise HTTPException(status_code=403, detail="HR calibration 권한이 없습니다.")
    if e.status == "MGR_SUBMITTED":
        e.status = "CALIBRATED"
        e.calibrated_at = datetime.now(timezone.utc)
    if payload.calibration_note is not None:
        e.calibration_note = payload.calibration_note
    if payload.goal_score_final is not None:
        e.goal_score_final = payload.goal_score_final
    if payload.final_overall_score is not None:
        e.final_overall_score = payload.final_overall_score
    if payload.final_grade is not None:
        e.final_grade = payload.final_grade
    if payload.competencies:
        _apply_competency_input(e, payload.competencies, stage="final")
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.info("평가 calibrate: eid=%s grade=%s (요청자=%s)", eid, e.final_grade, user.id)
    return await _detail_out(db, e, user=user)


@router.post("/{eid}/finalize", response_model=EvaluationOut)
async def finalize(
    eid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    e = await _load_eval_or_404(db, eid)
    if not _can_finalize(e, user):
        raise HTTPException(status_code=403, detail="공개 권한이 없습니다.")
    if e.final_grade is None:
        raise HTTPException(
            status_code=400, detail="등급(final_grade) 이 비어있어 공개할 수 없습니다.",
        )
    e.status = "FINALIZED"
    e.finalized_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.info("평가 FINALIZED: eid=%s grade=%s (요청자=%s)", eid, e.final_grade, user.id)
    try:
        await notify_finalized(db, e.id)
    except Exception as exc:  # pragma: no cover
        logger.warning("notify_finalized 실패 (eid=%s): %s", e.id, exc)
    return await _detail_out(db, e, user=user)


@router.post("/{eid}/admin-reopen", response_model=EvaluationOut)
async def admin_reopen(
    eid: UUID,
    target_status: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """HR/ADMIN — 임의 단계로 되돌리기 (예외 처리). target_status 지정."""
    _require_admin_hr(user)
    e = await _load_eval_or_404(db, eid)
    valid = (
        "NOT_STARTED", "SELF_DRAFT", "SELF_SUBMITTED",
        "MGR_DRAFT", "MGR_SUBMITTED", "CALIBRATED", "FINALIZED",
    )
    if target_status not in valid:
        raise HTTPException(status_code=400, detail="target_status 가 유효하지 않습니다.")
    e.status = target_status
    # timestamp 정리 — 이전 단계로 가면 그 이후 timestamp 는 NULL.
    if target_status in ("NOT_STARTED", "SELF_DRAFT"):
        e.self_submitted_at = None
    if target_status in ("NOT_STARTED", "SELF_DRAFT", "SELF_SUBMITTED", "MGR_DRAFT"):
        e.manager_submitted_at = None
    if target_status not in ("CALIBRATED", "FINALIZED"):
        e.calibrated_at = None
    if target_status != "FINALIZED":
        e.finalized_at = None
    await db.commit()
    await db.refresh(e, attribute_names=["competencies"])
    logger.warning(
        "평가 admin reopen: eid=%s → %s (요청자=%s)",
        eid, target_status, user.id,
    )
    return await _detail_out(db, e, user=user)
