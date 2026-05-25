"""결재 요청 API — 신청 / 결재함 / 내 신청 / 결재 처리 / 미리보기.

- /approvals             POST  신규 신청 (DRAFT or SUBMITTED)
- /approvals/preview     POST  결재선 미리보기
- /approvals/inbox       GET   내가 처리해야 할 결재함
- /approvals/mine        GET   내가 올린 요청들
- /approvals/{id}        GET   상세
- /approvals/{id}        PATCH DRAFT 편집
- /approvals/{id}/submit POST  DRAFT → SUBMITTED
- /approvals/{id}/cancel POST  본인 취소
- /approvals/{id}/steps/{sid}/approve  POST
- /approvals/{id}/steps/{sid}/reject   POST
- /approvals/{id}/steps/{sid}/delegate POST
- /approvals/{id}/comment              POST   감사 로그용 코멘트
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.services.storage import delete_file, resolve_upload_path, save_upload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    ApprovalAttachment,
    ApprovalHistory,
    ApprovalRequest,
    ApprovalStep,
    ApprovalTemplate,
    Developer,
    JobPosition,
    JobRank,
    User,
)
from app.schemas.approval import (
    ApprovalChainPreviewIn,
    ApprovalChainPreviewOut,
    ApprovalDecisionInput,
    ApprovalDelegateInput,
    ApprovalHistoryOut,
    ApprovalRequestCreate,
    ApprovalRequestCurrentPending,
    ApprovalRequestDetail,
    ApprovalRequestSummary,
    ApprovalRequestUpdate,
    ApprovalStepOut,
)
from app.services.approval_engine import evaluate_rules, find_matching_rule
from app.services.approval_notify import (
    notify_cancelled,
    notify_delegated,
    notify_step_approved,
    notify_step_rejected,
    notify_submitted,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/approvals", tags=["approvals"])


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------


async def _resolve_my_developer(db: AsyncSession, user: User) -> Developer:
    """로그인 유저의 Developer row. 미연결이면 400."""
    if not user.mapped_developer_id:
        raise HTTPException(
            status_code=400,
            detail="현재 계정이 임직원 정보에 연결되어 있지 않습니다 (관리자 문의).",
        )
    dev = (
        await db.execute(
            select(Developer).where(Developer.id == user.mapped_developer_id)
        )
    ).scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=400, detail="연결된 임직원 정보를 찾을 수 없습니다.")
    return dev


async def _name_map(
    db: AsyncSession, developer_ids: Iterable[UUID]
) -> dict[UUID, tuple[str, str | None]]:
    """developer_id → (이름, 직책명) 매핑. 누락된 id 는 키 없음.

    UI 가 결재선/이력에 사람 이름과 직책을 함께 표시하기 위함.
    """
    ids = [i for i in set(developer_ids) if i]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(
                Developer.id, Developer.name, JobPosition.name
            )
            .join(JobPosition, JobPosition.id == Developer.position_id, isouter=True)
            .where(Developer.id.in_(ids))
        )
    ).all()
    return {r[0]: (r[1], r[2]) for r in rows}


def _step_to_out(step: ApprovalStep, name_pos: dict[UUID, tuple[str, str | None]]) -> ApprovalStepOut:
    n, p = (None, None)
    if step.approver_id and step.approver_id in name_pos:
        n, p = name_pos[step.approver_id]
    return ApprovalStepOut(
        id=step.id,
        step_no=step.step_no,
        step_name=step.step_name,
        rule_index=step.rule_index,
        approver_index=step.approver_index,
        approver_id=step.approver_id,
        approver_name=n,
        approver_title=p,
        status=step.status,  # type: ignore[arg-type]
        decision_comment=step.decision_comment,
        decided_at=step.decided_at,
        delegated_from_step_id=step.delegated_from_step_id,
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _next_pending_step(steps: list[ApprovalStep]) -> ApprovalStep | None:
    """step_no 오름차순 첫 PENDING."""
    for s in sorted(steps, key=lambda x: x.step_no):
        if s.status == "PENDING":
            return s
    return None


async def _developer_grades(
    db: AsyncSession, developer_id: UUID | None
) -> dict[str, float | None]:
    """결재자의 effective grades — {rank_level, position_level}. 한 사람이 둘 다 갖거나
    한쪽만 갖는 경우 모두 보존해 spec 타입별로 비교 가능.

    None ID 또는 부재 시 둘 다 None.
    """
    if not developer_id:
        return {"rank_level": None, "position_level": None}
    dev = (
        await db.execute(select(Developer).where(Developer.id == developer_id))
    ).scalar_one_or_none()
    if not dev:
        return {"rank_level": None, "position_level": None}
    rl: float | None = None
    pl: float | None = None
    if dev.rank_id:
        r = (
            await db.execute(select(JobRank).where(JobRank.id == dev.rank_id))
        ).scalar_one_or_none()
        if r is not None:
            rl = float(r.level)
    if dev.position_id:
        p = (
            await db.execute(select(JobPosition).where(JobPosition.id == dev.position_id))
        ).scalar_one_or_none()
        if p is not None:
            pl = float(p.level)
    return {"rank_level": rl, "position_level": pl}


def _spec_grade_satisfied(
    spec: dict | None, current_grades: dict[str, float | None]
) -> bool:
    """현 결재자의 등급이 다음 step 의 grade 요건을 이미 충족하는가.

    True 면 다음 step 을 자동 SKIP. grade 기반 spec 만 대상:
      - rank_min_level   → current.rank_level >= spec.level
      - title_min_level  → current.position_level >= spec.level

    그 외 (manager / specific_user / rank_in / title_in) 는 등급으로 자동 충족
    판정이 불가능하므로 False (사용자가 수동 처리).
    """
    if not spec:
        return False
    t = spec.get("type")
    level = spec.get("level")
    if level is None:
        return False
    try:
        ref = float(level)
    except (TypeError, ValueError):
        return False
    if t == "rank_min_level":
        v = current_grades.get("rank_level")
        return v is not None and v >= ref
    if t == "title_min_level":
        v = current_grades.get("position_level")
        return v is not None and v >= ref
    return False


def _approver_spec(
    rules_snapshot: dict | None, step: ApprovalStep
) -> dict | None:
    """snapshot 에서 step 의 원본 approver spec 을 꺼낸다. 없으면 None."""
    if not rules_snapshot or step.rule_index is None or step.approver_index is None:
        return None
    try:
        rule = (rules_snapshot.get("rules") or [])[step.rule_index]
        return (rule.get("approvers") or [])[step.approver_index]
    except (IndexError, KeyError, TypeError):
        return None


async def _auto_skip_downstream(
    db: AsyncSession,
    *,
    req: ApprovalRequest,
    just_approved: ApprovalStep,
    actor_id: UUID,
) -> int:
    """방금 승인된 step 의 결재자 등급으로 downstream PENDING step 들을 검사하고
    자동 충족되는 단계를 SKIPPED 처리. 반환은 skip 한 step 수.

    규칙:
      - 결재자 미해결 (approver_id is None) → 항상 SKIP.
      - spec 이 grade 기반이고 현 결재자가 이미 충족 → SKIP.
      - 그 외 → 유지 (다음 step 으로 계속 진행).

    rules_snapshot 부재 시는 grade 판정 불가 — '미해결' 만 SKIP.
    """
    grades = await _developer_grades(db, just_approved.approver_id)
    rules_snapshot = req.approval_rules_snapshot
    skipped = 0
    for s in sorted(req.steps, key=lambda x: x.step_no):
        if s.step_no <= just_approved.step_no or s.status != "PENDING":
            continue
        reason: str | None = None
        if s.approver_id is None:
            reason = "결재자 미해결로 자동 건너뜀"
        else:
            spec = _approver_spec(rules_snapshot, s)
            if _spec_grade_satisfied(spec, grades):
                reason = "상위 등급 결재자 승인으로 자동 건너뜀"
        if reason is None:
            continue
        s.status = "SKIPPED"
        s.decided_at = _now()
        s.decision_comment = reason
        await _add_history(
            db,
            request_id=req.id,
            event="SKIPPED",
            actor_id=actor_id,
            step_id=s.id,
            payload={
                "reason": reason,
                "actor_grades": grades,
            },
        )
        skipped += 1
    return skipped


async def _add_history(
    db: AsyncSession,
    *,
    request_id: UUID,
    event: str,
    actor_id: UUID | None,
    step_id: UUID | None = None,
    payload: dict | None = None,
) -> None:
    db.add(
        ApprovalHistory(
            request_id=request_id,
            step_id=step_id,
            event=event,
            actor_id=actor_id,
            payload=payload,
            occurred_at=_now(),
        )
    )


async def _load_template(db: AsyncSession, template_id: UUID) -> ApprovalTemplate:
    tpl = (
        await db.execute(
            select(ApprovalTemplate).where(ApprovalTemplate.id == template_id)
        )
    ).scalar_one_or_none()
    if not tpl:
        raise HTTPException(status_code=404, detail="결재 양식을 찾을 수 없습니다.")
    if not tpl.is_active:
        raise HTTPException(status_code=400, detail="비활성 양식입니다 — 신청할 수 없습니다.")
    return tpl


async def _materialize_steps(
    db: AsyncSession, *, request: ApprovalRequest, requester_id: UUID, rules: dict, form_data: dict
) -> list[ApprovalStep]:
    resolved = await evaluate_rules(
        requester_id=requester_id,
        approval_rules=rules,
        form_data=form_data,
        db=db,
    )
    if not resolved:
        raise HTTPException(
            status_code=400,
            detail="입력한 내용에 매치되는 결재 룰이 없습니다 — 관리자에게 양식 점검을 요청하세요.",
        )
    out: list[ApprovalStep] = []
    for spec in resolved:
        s = ApprovalStep(
            request_id=request.id,
            step_no=spec["step_no"],
            step_name=spec["step_name"],
            rule_index=spec["rule_index"],
            approver_index=spec["approver_index"],
            approver_id=spec["approver_id"],
            status="PENDING",
        )
        db.add(s)
        out.append(s)
    return out


# ---------------------------------------------------------------------------
# 미리보기
# ---------------------------------------------------------------------------


@router.post("/preview", response_model=ApprovalChainPreviewOut)
async def preview_chain(
    payload: ApprovalChainPreviewIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    tpl = await _load_template(db, payload.template_id)
    matched = find_matching_rule(tpl.approval_rules or {}, payload.form_data)
    rule_name = matched[1].get("name") if matched else None
    resolved = await evaluate_rules(
        requester_id=me.id,
        approval_rules=tpl.approval_rules or {},
        form_data=payload.form_data,
        db=db,
    )
    name_pos = await _name_map(db, [s["approver_id"] for s in resolved if s["approver_id"]])
    steps_out = []
    warnings: list[str] = []
    for s in resolved:
        approver_id = s["approver_id"]
        n, p = name_pos.get(approver_id, (None, None)) if approver_id else (None, None)
        if not approver_id:
            warnings.append(f"{s['step_name']} — 결재자를 찾지 못했습니다.")
        steps_out.append(
            ApprovalStepOut(
                id=UUID(int=0),  # 미리보기 placeholder — UI 는 사용 안함.
                step_no=s["step_no"],
                step_name=s["step_name"],
                rule_index=s["rule_index"],
                approver_index=s["approver_index"],
                approver_id=approver_id,
                approver_name=n,
                approver_title=p,
                status="PENDING",
            )
        )
    if not resolved:
        warnings.append("매치되는 결재 룰이 없습니다.")
    return ApprovalChainPreviewOut(
        matched_rule_name=rule_name, steps=steps_out, warnings=warnings
    )


# ---------------------------------------------------------------------------
# 신청
# ---------------------------------------------------------------------------


@router.post("", response_model=ApprovalRequestDetail, status_code=201)
async def create_request(
    payload: ApprovalRequestCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    tpl = await _load_template(db, payload.template_id)

    req = ApprovalRequest(
        template_id=tpl.id,
        kind=tpl.kind,
        title=payload.title,
        requester_id=me.id,
        status="DRAFT",
        form_data=payload.form_data,
        template_version=tpl.version,
        form_schema_snapshot=tpl.form_schema,
        approval_rules_snapshot=tpl.approval_rules,
        attachment_slots_snapshot=tpl.attachment_slots,
    )
    db.add(req)
    await db.flush()  # req.id 확보.
    await _add_history(db, request_id=req.id, event="CREATED", actor_id=me.id)
    logger.info(
        "결재 신청 생성: request=%s kind=%s requester=%s submit=%s",
        req.id, tpl.kind, me.id, payload.submit,
    )

    submitted_now = False
    if payload.submit:
        # create 시점에 attachments 가 없을 수 있음 (DRAFT 만들고 첨부 후 submit 가
        # 정상 흐름). 그래도 required 슬롯이 정의되어 있으면 차단.
        await db.flush()
        await db.refresh(req, ["attachments"])
        _validate_required_attachments(req)
        await _materialize_steps(
            db, request=req, requester_id=me.id,
            rules=tpl.approval_rules or {}, form_data=payload.form_data,
        )
        req.status = "IN_PROGRESS"
        req.submitted_at = _now()
        await _add_history(db, request_id=req.id, event="SUBMITTED", actor_id=me.id)
        submitted_now = True

    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    if submitted_now:
        logger.info(
            "결재 즉시 제출: request=%s steps=%d",
            req.id, len(req.steps),
        )
        try:
            await notify_submitted(db, req.id)
        except Exception as exc:
            logger.warning("approval notify_submitted 실패 (request=%s): %s", req.id, exc)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


# ---------------------------------------------------------------------------
# 편집 / 취소 / 제출
# ---------------------------------------------------------------------------


async def _load_request(db: AsyncSession, request_id: UUID) -> ApprovalRequest:
    req = (
        await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.id == request_id)
            .options(
                selectinload(ApprovalRequest.steps),
                selectinload(ApprovalRequest.history),
                selectinload(ApprovalRequest.attachments),
            )
        )
    ).scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="결재 요청을 찾을 수 없습니다.")
    return req


@router.patch("/{request_id}", response_model=ApprovalRequestDetail)
async def update_request(
    request_id: UUID,
    payload: ApprovalRequestUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if req.requester_id != me.id:
        raise HTTPException(status_code=403, detail="본인이 신청한 결재만 편집할 수 있습니다.")
    if req.status != "DRAFT":
        raise HTTPException(status_code=400, detail="DRAFT 상태에서만 편집할 수 있습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(req, k, v)
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.info(
        "결재 DRAFT 편집: request=%s 변경필드=%s requester=%s",
        req.id, list(data.keys()), me.id,
    )
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


@router.post("/{request_id}/submit", response_model=ApprovalRequestDetail)
async def submit_request(
    request_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if req.requester_id != me.id:
        raise HTTPException(status_code=403, detail="본인 결재만 제출 가능합니다.")
    if req.status != "DRAFT":
        raise HTTPException(status_code=400, detail="DRAFT 상태에서만 제출할 수 있습니다.")
    # snapshot 갱신 — DRAFT 동안 template 변경됐을 수 있음.
    if req.template and req.template.attachment_slots is not None:
        req.attachment_slots_snapshot = req.template.attachment_slots
    _validate_required_attachments(req)
    rules = req.approval_rules_snapshot or {}
    await _materialize_steps(
        db, request=req, requester_id=me.id, rules=rules, form_data=req.form_data
    )
    req.status = "IN_PROGRESS"
    req.submitted_at = _now()
    await _add_history(db, request_id=req.id, event="SUBMITTED", actor_id=me.id)
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.info(
        "결재 제출: request=%s kind=%s steps=%d requester=%s",
        req.id, req.kind, len(req.steps), me.id,
    )
    try:
        await notify_submitted(db, req.id)
    except Exception as exc:
        logger.warning("approval notify_submitted 실패 (request=%s): %s", req.id, exc)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


@router.post("/{request_id}/cancel", response_model=ApprovalRequestDetail)
async def cancel_request(
    request_id: UUID,
    payload: ApprovalDecisionInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if req.requester_id != me.id:
        raise HTTPException(status_code=403, detail="본인 결재만 취소 가능합니다.")
    if req.status not in ("DRAFT", "IN_PROGRESS", "SUBMITTED"):
        raise HTTPException(status_code=400, detail="이미 종결된 결재입니다.")
    req.status = "CANCELLED"
    req.completed_at = _now()
    req.cancelled_reason = payload.comment
    # 모든 PENDING step 은 SKIPPED 처리.
    for s in req.steps:
        if s.status == "PENDING":
            s.status = "SKIPPED"
    await _add_history(
        db, request_id=req.id, event="CANCELLED", actor_id=me.id,
        payload={"reason": payload.comment} if payload.comment else None,
    )
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.warning(
        "결재 취소: request=%s kind=%s requester=%s reason=%s",
        req.id, req.kind, me.id, payload.comment or "-",
    )
    try:
        await notify_cancelled(db, req.id, comment=payload.comment)
    except Exception as exc:
        logger.warning("approval notify_cancelled 실패 (request=%s): %s", req.id, exc)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


# ---------------------------------------------------------------------------
# 결재함 / 내 신청 / 상세
# ---------------------------------------------------------------------------


async def _summarize(
    db: AsyncSession,
    rows: list[ApprovalRequest],
    *,
    viewer_developer_id: UUID,
) -> list[ApprovalRequestSummary]:
    if not rows:
        return []
    tpl_ids = list({r.template_id for r in rows})
    tpls = {
        t.id: t
        for t in (
            await db.execute(
                select(ApprovalTemplate).where(ApprovalTemplate.id.in_(tpl_ids))
            )
        ).scalars()
    }
    requester_ids = list({r.requester_id for r in rows})
    name_pos = await _name_map(db, requester_ids)

    # step 집계 — 1번 쿼리에 처리.
    req_ids = [r.id for r in rows]
    counts = {
        rid: (0, 0)  # total, approved
        for rid in req_ids
    }
    pendings_by_request: dict[UUID, ApprovalStep] = {}
    # 요청 전체 관점의 '현재 대기 step' — step_no 가장 작은 PENDING (viewer 무관).
    current_pendings: dict[UUID, ApprovalStep] = {}
    if req_ids:
        steps = (
            await db.execute(
                select(ApprovalStep).where(ApprovalStep.request_id.in_(req_ids))
            )
        ).scalars().all()
        approver_pos: dict[UUID, tuple[str, str | None]] = await _name_map(
            db, [s.approver_id for s in steps if s.approver_id]
        )
        for s in steps:
            t, a = counts[s.request_id]
            t += 1
            if s.status == "APPROVED":
                a += 1
            counts[s.request_id] = (t, a)
            if s.status == "PENDING":
                # 요청 전체 관점 — viewer 무관.
                cur_any = current_pendings.get(s.request_id)
                if cur_any is None or s.step_no < cur_any.step_no:
                    current_pendings[s.request_id] = s
                if s.approver_id == viewer_developer_id:
                    # 가장 작은 step_no 가 viewer 에게 할당된 step 일 때만 기록.
                    cur = pendings_by_request.get(s.request_id)
                    if cur is None or s.step_no < cur.step_no:
                        pendings_by_request[s.request_id] = s
        # name_pos for pending step approvers (so my_pending_step.approver_name available)
        name_pos.update(approver_pos)

    # 현재 대기 step approver 들의 연락처 (phone/email) batch 조회. IN_PROGRESS
    # 요청 1건당 0~1명의 결재자라 N+1 쿼리 회피 위해 한 번에.
    current_approver_ids = {
        s.approver_id for s in current_pendings.values() if s.approver_id
    }
    contact_map: dict[UUID, tuple[str | None, str | None]] = {}
    if current_approver_ids:
        contact_rows = (
            await db.execute(
                select(Developer.id, Developer.phone, Developer.company_email)
                .where(Developer.id.in_(current_approver_ids))
            )
        ).all()
        contact_map = {r[0]: (r[1], r[2]) for r in contact_rows}

    out: list[ApprovalRequestSummary] = []
    for r in rows:
        tpl = tpls.get(r.template_id)
        n, _ = name_pos.get(r.requester_id, (None, None))
        total, approved = counts[r.id]
        my = pendings_by_request.get(r.id)
        cur_any = current_pendings.get(r.id)
        cur_pending_out: ApprovalRequestCurrentPending | None = None
        if cur_any is not None:
            cn, ct = (None, None)
            if cur_any.approver_id and cur_any.approver_id in name_pos:
                cn, ct = name_pos[cur_any.approver_id]
            phone, email = (None, None)
            if cur_any.approver_id and cur_any.approver_id in contact_map:
                phone, email = contact_map[cur_any.approver_id]
            cur_pending_out = ApprovalRequestCurrentPending(
                step_no=cur_any.step_no,
                step_name=cur_any.step_name,
                approver_id=cur_any.approver_id,
                approver_name=cn,
                approver_title=ct,
                approver_phone=phone,
                approver_email=email,
            )
        out.append(
            ApprovalRequestSummary(
                id=r.id,
                kind=r.kind,
                template_id=r.template_id,
                template_name=tpl.name if tpl else None,
                template_icon=tpl.icon if tpl else None,
                title=r.title,
                requester_id=r.requester_id,
                requester_name=n,
                status=r.status,  # type: ignore[arg-type]
                submitted_at=r.submitted_at,
                completed_at=r.completed_at,
                created_at=r.created_at,
                my_pending_step=_step_to_out(my, name_pos) if my else None,
                current_pending_step=cur_pending_out,
                total_steps=total,
                approved_steps=approved,
            )
        )
    return out


@router.get("/inbox", response_model=list[ApprovalRequestSummary])
async def inbox(
    status_filter: str = Query("PENDING", pattern="^(PENDING|ALL|DECIDED)$"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """현재 사용자가 결재해야 할 (또는 했던) 요청 목록.

    - status_filter=PENDING (기본) → 내 turn 인 PENDING step 보유 + IN_PROGRESS
    - status_filter=DECIDED         → 내가 이미 처리한 step 의 request
    - status_filter=ALL             → 둘 다
    """
    me = await _resolve_my_developer(db, user)
    pending_subq = (
        select(ApprovalStep.request_id)
        .where(ApprovalStep.approver_id == me.id, ApprovalStep.status == "PENDING")
        .scalar_subquery()
    )
    decided_subq = (
        select(ApprovalStep.request_id)
        .where(
            ApprovalStep.approver_id == me.id,
            ApprovalStep.status.in_(("APPROVED", "REJECTED", "DELEGATED")),
        )
        .scalar_subquery()
    )
    stmt = select(ApprovalRequest)
    if status_filter == "PENDING":
        stmt = stmt.where(
            ApprovalRequest.id.in_(pending_subq),
            ApprovalRequest.status == "IN_PROGRESS",
        )
    elif status_filter == "DECIDED":
        stmt = stmt.where(ApprovalRequest.id.in_(decided_subq))
    else:  # ALL
        stmt = stmt.where(
            or_(ApprovalRequest.id.in_(pending_subq), ApprovalRequest.id.in_(decided_subq))
        )
    stmt = stmt.order_by(ApprovalRequest.created_at.desc()).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return await _summarize(db, list(rows), viewer_developer_id=me.id)


@router.get("/mine", response_model=list[ApprovalRequestSummary])
async def my_requests(
    status_filter: str = Query("ALL", pattern="^(ALL|DRAFT|IN_PROGRESS|DONE|CANCELLED)$"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    stmt = select(ApprovalRequest).where(ApprovalRequest.requester_id == me.id)
    if status_filter == "DRAFT":
        stmt = stmt.where(ApprovalRequest.status == "DRAFT")
    elif status_filter == "IN_PROGRESS":
        stmt = stmt.where(ApprovalRequest.status.in_(("SUBMITTED", "IN_PROGRESS")))
    elif status_filter == "DONE":
        stmt = stmt.where(ApprovalRequest.status.in_(("APPROVED", "REJECTED")))
    elif status_filter == "CANCELLED":
        stmt = stmt.where(ApprovalRequest.status == "CANCELLED")
    stmt = stmt.order_by(ApprovalRequest.created_at.desc()).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return await _summarize(db, list(rows), viewer_developer_id=me.id)


@router.get("/{request_id}", response_model=ApprovalRequestDetail)
async def get_request(
    request_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


async def _build_detail(
    db: AsyncSession,
    req: ApprovalRequest,
    *,
    viewer_developer_id: UUID,
    viewer_user: User,
) -> ApprovalRequestDetail:
    tpl = (
        await db.execute(select(ApprovalTemplate).where(ApprovalTemplate.id == req.template_id))
    ).scalar_one_or_none()

    # 권한: 신청자, 결재자(과거·현재), HR/ADMIN.
    is_requester = req.requester_id == viewer_developer_id
    is_approver = any(
        s.approver_id == viewer_developer_id for s in req.steps
    )
    is_admin = viewer_user.role in ("ADMIN", "HR")
    if not (is_requester or is_approver or is_admin):
        raise HTTPException(status_code=403, detail="이 결재 요청을 볼 권한이 없습니다.")

    # 이름 lookup
    dev_ids: set[UUID] = {req.requester_id}
    for s in req.steps:
        if s.approver_id:
            dev_ids.add(s.approver_id)
    for h in req.history:
        if h.actor_id:
            dev_ids.add(h.actor_id)
    for a in req.attachments:
        if a.uploaded_by_id:
            dev_ids.add(a.uploaded_by_id)
    name_pos = await _name_map(db, dev_ids)

    requester_name = name_pos.get(req.requester_id, (None, None))[0]

    history_out = [
        ApprovalHistoryOut(
            id=h.id,
            request_id=h.request_id,
            step_id=h.step_id,
            event=h.event,
            actor_id=h.actor_id,
            actor_name=name_pos.get(h.actor_id, (None, None))[0] if h.actor_id else None,
            payload=h.payload,
            occurred_at=h.occurred_at,
        )
        for h in sorted(req.history, key=lambda x: x.occurred_at)
    ]
    steps_out = [_step_to_out(s, name_pos) for s in sorted(req.steps, key=lambda x: x.step_no)]

    attachments_out = []
    from app.schemas.approval import ApprovalAttachmentOut
    for a in req.attachments:
        attachments_out.append(
            ApprovalAttachmentOut(
                id=a.id,
                request_id=a.request_id,
                slot=a.slot,
                file_name=a.file_name,
                mime_type=a.mime_type,
                size=a.size,
                uploaded_by_id=a.uploaded_by_id,
                uploaded_by_name=name_pos.get(a.uploaded_by_id, (None, None))[0]
                    if a.uploaded_by_id else None,
                created_at=a.created_at,
            )
        )

    # can_act_step_id: 내가 처리해야 할 PENDING step 의 가장 빠른 step.
    can_act_step_id = None
    current_pending_out: ApprovalRequestCurrentPending | None = None
    if req.status == "IN_PROGRESS":
        pending = _next_pending_step(req.steps)
        if pending and pending.approver_id == viewer_developer_id:
            can_act_step_id = pending.id
        if pending is not None:
            # 신청자 측에서 '누구를 기다리는지' + 연락처 확인용. ADMIN/HR 시점도 동일.
            cn, ct = name_pos.get(pending.approver_id, (None, None)) if pending.approver_id else (None, None)
            phone, email = (None, None)
            if pending.approver_id:
                contact_row = (
                    await db.execute(
                        select(Developer.phone, Developer.company_email)
                        .where(Developer.id == pending.approver_id)
                    )
                ).first()
                if contact_row:
                    phone, email = contact_row[0], contact_row[1]
            current_pending_out = ApprovalRequestCurrentPending(
                step_no=pending.step_no,
                step_name=pending.step_name,
                approver_id=pending.approver_id,
                approver_name=cn,
                approver_title=ct,
                approver_phone=phone,
                approver_email=email,
            )

    return ApprovalRequestDetail(
        id=req.id,
        kind=req.kind,
        template_id=req.template_id,
        template_name=tpl.name if tpl else None,
        template_icon=tpl.icon if tpl else None,
        template_version=req.template_version,
        form_schema_snapshot=req.form_schema_snapshot,
        ui_schema_snapshot=(tpl.ui_schema if tpl else None),
        attachment_slots_snapshot=(
            req.attachment_slots_snapshot
            if req.attachment_slots_snapshot is not None
            else (tpl.attachment_slots if tpl else None)
        ),
        title=req.title,
        requester_id=req.requester_id,
        requester_name=requester_name,
        status=req.status,  # type: ignore[arg-type]
        form_data=req.form_data,
        submitted_at=req.submitted_at,
        completed_at=req.completed_at,
        cancelled_reason=req.cancelled_reason,
        created_at=req.created_at,
        steps=steps_out,
        current_pending_step=current_pending_out,
        history=history_out,
        attachments=attachments_out,
        can_edit=is_requester and req.status == "DRAFT",
        can_cancel=is_requester and req.status in ("DRAFT", "SUBMITTED", "IN_PROGRESS"),
        can_act_step_id=can_act_step_id,
    )


# ---------------------------------------------------------------------------
# Step actions: approve / reject / delegate / comment
# ---------------------------------------------------------------------------


async def _act_load_step(
    db: AsyncSession, request_id: UUID, step_id: UUID
) -> tuple[ApprovalRequest, ApprovalStep]:
    req = await _load_request(db, request_id)
    step = next((s for s in req.steps if s.id == step_id), None)
    if not step:
        raise HTTPException(status_code=404, detail="결재 단계가 존재하지 않습니다.")
    return req, step


def _ensure_my_pending(req: ApprovalRequest, step: ApprovalStep, me_id: UUID) -> None:
    if req.status not in ("IN_PROGRESS", "SUBMITTED"):
        raise HTTPException(status_code=400, detail="진행중인 결재가 아닙니다.")
    if step.status != "PENDING":
        raise HTTPException(status_code=400, detail="이미 처리된 단계입니다.")
    if step.approver_id != me_id:
        raise HTTPException(status_code=403, detail="이 단계를 처리할 권한이 없습니다.")
    # 순서 보장 — 앞쪽 PENDING 이 있으면 거부.
    earlier = [s for s in req.steps if s.step_no < step.step_no and s.status == "PENDING"]
    if earlier:
        raise HTTPException(status_code=400, detail="앞 단계가 아직 처리되지 않았습니다.")


@router.post("/{request_id}/steps/{step_id}/approve", response_model=ApprovalRequestDetail)
async def approve_step(
    request_id: UUID,
    step_id: UUID,
    payload: ApprovalDecisionInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req, step = await _act_load_step(db, request_id, step_id)
    _ensure_my_pending(req, step, me.id)
    # 매 단계 — 필수 첨부 미달 시 차단. 신청자에게 보충 요청 후 재시도하는 흐름.
    _validate_required_attachments(req)
    step.status = "APPROVED"
    step.decision_comment = payload.comment
    step.decided_at = _now()
    await _add_history(
        db, request_id=req.id, event="APPROVED", actor_id=me.id, step_id=step.id,
        payload={"comment": payload.comment} if payload.comment else None,
    )
    # 등급 기반 자동 SKIP — 현 결재자의 rank/position level 로 downstream PENDING
    # step 들을 검사. 충족 또는 결재자 미해결인 step 은 SKIPPED 로 마킹.
    # 1차 결재자가 2차 결재자보다 높은 등급일 때 2차가 무의미하므로 자동 건너뛰기.
    skipped_count = await _auto_skip_downstream(
        db, req=req, just_approved=step, actor_id=me.id,
    )
    if skipped_count:
        logger.info(
            "결재 자동 SKIP: request=%s 승인자=%s 건너뛴 step 수=%d",
            req.id, me.id, skipped_count,
        )
    # 다음 단계 있으면 대기, 없으면 종결.
    finalized = not _next_pending_step(req.steps)
    if finalized:
        req.status = "APPROVED"
        req.completed_at = _now()
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    if finalized:
        logger.info(
            "결재 최종 승인: request=%s kind=%s 마지막승인자=%s 자동SKIP=%d",
            req.id, req.kind, me.id, skipped_count,
        )
    else:
        logger.info(
            "결재 단계 승인: request=%s step=%d/%d 결재자=%s 자동SKIP=%d",
            req.id, step.step_no, len(req.steps), me.id, skipped_count,
        )
    try:
        await notify_step_approved(db, req.id, finalized=finalized)
    except Exception as exc:
        logger.warning("approval notify_step_approved 실패 (request=%s): %s", req.id, exc)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


@router.post("/{request_id}/steps/{step_id}/reject", response_model=ApprovalRequestDetail)
async def reject_step(
    request_id: UUID,
    step_id: UUID,
    payload: ApprovalDecisionInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req, step = await _act_load_step(db, request_id, step_id)
    _ensure_my_pending(req, step, me.id)
    if not (payload.comment and payload.comment.strip()):
        raise HTTPException(status_code=400, detail="반려 사유를 입력해주세요.")
    step.status = "REJECTED"
    step.decision_comment = payload.comment
    step.decided_at = _now()
    # 이후 모든 PENDING SKIPPED.
    for s in req.steps:
        if s.status == "PENDING" and s.step_no > step.step_no:
            s.status = "SKIPPED"
    req.status = "REJECTED"
    req.completed_at = _now()
    await _add_history(
        db, request_id=req.id, event="REJECTED", actor_id=me.id, step_id=step.id,
        payload={"comment": payload.comment},
    )
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.warning(
        "결재 반려: request=%s kind=%s step=%d 결재자=%s 사유=%s",
        req.id, req.kind, step.step_no, me.id, payload.comment,
    )
    try:
        await notify_step_rejected(db, req.id, comment=payload.comment)
    except Exception as exc:
        logger.warning("approval notify_step_rejected 실패 (request=%s): %s", req.id, exc)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


@router.post("/{request_id}/steps/{step_id}/delegate", response_model=ApprovalRequestDetail)
async def delegate_step(
    request_id: UUID,
    step_id: UUID,
    payload: ApprovalDelegateInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req, step = await _act_load_step(db, request_id, step_id)
    _ensure_my_pending(req, step, me.id)
    target = (
        await db.execute(
            select(Developer).where(
                Developer.id == payload.delegate_to_developer_id,
                Developer.status == "ACTIVE",
            )
        )
    ).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=400, detail="위임 대상자를 찾을 수 없습니다.")
    if target.id == me.id:
        raise HTTPException(status_code=400, detail="자기 자신에게 위임할 수 없습니다.")
    if target.id == req.requester_id:
        raise HTTPException(status_code=400, detail="신청자에게 위임할 수 없습니다.")
    # 기존 step 은 DELEGATED, 동일 step_no 위치에 새 step (소수점 형식 X — 끼워넣기 위해
    # 모든 이후 step_no 를 +1 하지 않고, 기존 자리는 남겨두고 별도 row 추가).
    # 단순화: 기존 step 의 status 를 DELEGATED 로 닫고, step_no 를 같게 유지하되
    # 새 step row 를 추가 (step_no = original + 0.5? — 정수 컬럼이니 다른 접근.)
    # → 가장 단순: 기존 step 다음에 step_no = max+1 로 추가하고 모든 이후 step_no 를 +1 shift.
    step.status = "DELEGATED"
    step.decision_comment = payload.comment
    step.decided_at = _now()
    new_no = step.step_no + 1
    for s in req.steps:
        if s.step_no >= new_no and s.id != step.id:
            s.step_no += 1
    new_step = ApprovalStep(
        request_id=req.id,
        step_no=new_no,
        step_name=f"{step.step_name} (위임)",
        rule_index=step.rule_index,
        approver_index=step.approver_index,
        approver_id=target.id,
        status="PENDING",
        delegated_from_step_id=step.id,
    )
    db.add(new_step)
    await db.flush()
    await _add_history(
        db, request_id=req.id, event="DELEGATED", actor_id=me.id, step_id=step.id,
        payload={
            "to_developer_id": str(target.id),
            "to_name": target.name,
            "comment": payload.comment,
        },
    )
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.info(
        "결재 위임: request=%s step=%d 위임자=%s → 수임자=%s (%s)",
        req.id, step.step_no, me.id, target.id, target.name,
    )
    try:
        await notify_delegated(
            db, req.id, to_developer_id=target.id, comment=payload.comment,
        )
    except Exception as exc:
        logger.warning("approval notify_delegated 실패 (request=%s): %s", req.id, exc)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


@router.post("/{request_id}/comment", response_model=ApprovalRequestDetail)
async def add_comment(
    request_id: UUID,
    payload: ApprovalDecisionInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if not (payload.comment and payload.comment.strip()):
        raise HTTPException(status_code=400, detail="코멘트를 입력해주세요.")
    # 신청자 또는 결재자만 코멘트 가능.
    is_requester = req.requester_id == me.id
    is_approver = any(s.approver_id == me.id for s in req.steps)
    if not (is_requester or is_approver):
        raise HTTPException(status_code=403, detail="이 결재에 코멘트를 추가할 수 없습니다.")
    await _add_history(
        db, request_id=req.id, event="COMMENTED", actor_id=me.id,
        payload={"comment": payload.comment},
    )
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.info("결재 코멘트 추가: request=%s actor=%s", req.id, me.id)
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


# ---------------------------------------------------------------------------
# Attachments — 결재 요청에 영수증/계약서/사진 등 파일 첨부.
# 파일은 data/approvals/{request_id}/<uuid>.<ext> 로 저장 (tenant prefix 자동).
# 신청자 또는 HR/ADMIN 만 업로드/삭제 가능. 다운로드는 결재자/신청자/HR/ADMIN.
# 종결된 (APPROVED/REJECTED/CANCELLED) 요청에는 새 첨부 불가.
# ---------------------------------------------------------------------------


def _slots_def(req: ApprovalRequest) -> list[dict]:
    """진행중 결재면 snapshot, 아직 DRAFT 면 template 의 현재 정의."""
    snap = req.attachment_slots_snapshot
    if snap and isinstance(snap, dict):
        return list(snap.get("slots") or [])
    if req.template and req.template.attachment_slots:
        return list((req.template.attachment_slots or {}).get("slots") or [])
    return []


def _find_slot(req: ApprovalRequest, slug: str) -> dict | None:
    for s in _slots_def(req):
        if s.get("slug") == slug:
            return s
    return None


def _validate_required_attachments(req: ApprovalRequest) -> None:
    """필수 슬롯 충족 검사. 미달 시 400.

    - submit / approve_step 직전에 호출.
    - DRAFT 상태에서 호출되는 _materialize_steps 흐름은 제출 시점이라 같이 적용.
    """
    slots = _slots_def(req)
    if not slots:
        return
    counts: dict[str, int] = {}
    for a in req.attachments:
        if a.slot:
            counts[a.slot] = counts.get(a.slot, 0) + 1
    missing: list[str] = []
    for s in slots:
        if not s.get("required") and not s.get("min_count"):
            continue
        slug = s.get("slug")
        need = max(1, int(s.get("min_count") or 1))
        if counts.get(slug, 0) < need:
            missing.append(s.get("label") or slug or "?")
    if missing:
        logger.warning(
            "결재 첨부 검증 실패: request=%s 누락=%s",
            req.id, missing,
        )
        raise HTTPException(
            status_code=400,
            detail="필수 첨부가 누락되었습니다: " + ", ".join(missing),
        )


def _can_modify_attachments(req: ApprovalRequest, me_id: UUID, user: User) -> bool:
    if user.role in ("ADMIN", "HR"):
        return True
    if req.requester_id != me_id:
        return False
    if req.status in ("APPROVED", "REJECTED", "CANCELLED"):
        return False
    return True


def _can_view_attachments(req: ApprovalRequest, me_id: UUID, user: User) -> bool:
    if user.role in ("ADMIN", "HR"):
        return True
    if req.requester_id == me_id:
        return True
    if any(s.approver_id == me_id for s in req.steps):
        return True
    return False


@router.post("/{request_id}/attachments", response_model=ApprovalRequestDetail, status_code=201)
async def upload_attachment(
    request_id: UUID,
    file: UploadFile = File(...),
    slot: str | None = Query(default=None, max_length=40, pattern=r"^[a-z0-9_]+$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if not _can_modify_attachments(req, me.id, user):
        raise HTTPException(status_code=403, detail="첨부 권한이 없습니다.")
    # slot 이 지정됐으면 template/snapshot 의 정의된 slug 인지 확인.
    if slot:
        slot_def = _find_slot(req, slot)
        if slot_def is None:
            raise HTTPException(
                status_code=400, detail=f"정의되지 않은 첨부 슬롯입니다: {slot}",
            )
        # max_count 검사 — 슈퍼유저(HR/ADMIN) 도 통일 적용.
        max_count = slot_def.get("max_count")
        if max_count is not None:
            current = sum(1 for a in req.attachments if a.slot == slot)
            if current >= int(max_count):
                raise HTTPException(
                    status_code=400,
                    detail=f"'{slot_def.get('label', slot)}' 슬롯은 최대 {max_count}개까지 첨부 가능합니다.",
                )
    stored, size = await save_upload(file, f"approvals/{request_id}")
    db.add(
        ApprovalAttachment(
            request_id=request_id,
            slot=slot,
            file_name=file.filename or "file",
            mime_type=file.content_type,
            size=size,
            file_path=stored,
            uploaded_by_id=me.id,
        )
    )
    await db.commit()
    await db.refresh(req, ["steps", "history", "attachments"])
    logger.info(
        "결재 첨부 업로드: request=%s slot=%s file=%s size=%d 사용자=%s",
        request_id, slot or "(기타)", file.filename, size, user.id,
    )
    return await _build_detail(db, req, viewer_developer_id=me.id, viewer_user=user)


@router.get("/{request_id}/attachments/{attachment_id}/download")
async def download_attachment(
    request_id: UUID,
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if not _can_view_attachments(req, me.id, user):
        raise HTTPException(status_code=403, detail="조회 권한이 없습니다.")
    att = next((a for a in req.attachments if a.id == attachment_id), None)
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )


@router.delete(
    "/{request_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_attachment(
    request_id: UUID,
    attachment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    me = await _resolve_my_developer(db, user)
    req = await _load_request(db, request_id)
    if not _can_modify_attachments(req, me.id, user):
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다.")
    att = next((a for a in req.attachments if a.id == attachment_id), None)
    if not att:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    logger.warning(
        "결재 첨부 삭제: request=%s slot=%s file=%s 사용자=%s",
        request_id, att.slot or "(기타)", att.file_name, user.id,
    )


_ = func
