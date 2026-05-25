"""주간보고 API.

Endpoints:
  GET    /weekly-reports?owner=me|team|all&from_year&from_week&to_year&to_week
  GET    /weekly-reports/{id}
  POST   /weekly-reports                       lazy create (없으면 새로, 있으면 기존)
  PATCH  /weekly-reports/{id}/body             5초 autosave
  PATCH  /weekly-reports/{id}/submit           DRAFT → SUBMITTED
  PATCH  /weekly-reports/{id}/reopen           SUBMITTED → DRAFT (본인만)
  POST   /weekly-reports/{id}/attachments      multipart 업로드 (작성자 본인)
  GET    /weekly-reports/attachments/{aid}     다운로드 (read 권한자 모두)
  PATCH  /weekly-reports/attachments/{aid}     파일명 변경 (ADMIN/HR + 본인)
  DELETE /weekly-reports/attachments/{aid}     삭제 (ADMIN/HR + 본인)

  Assignments (지정자 관리, ADMIN/HR):
  GET    /weekly-reports/assignments
  POST   /weekly-reports/assignments
  PATCH  /weekly-reports/assignments/{id}
  DELETE /weekly-reports/assignments/{id}

  Templates (양식, ADMIN):
  GET    /weekly-reports/templates             두 종 동시 반환 (없으면 코드 fallback)
  PATCH  /weekly-reports/templates/{kind}      kind=MANAGER|GENERAL — body upsert

권한:
  - 본인 보고서 R/W: 본인.
  - 부하 보고서 R: 직속 매니저 chain (depth ≥ 1) + HR/ADMIN/SUPER_ADMIN.
  - 본문 편집: 본인 + ADMIN (감독 — 단, 편집보다는 조회 권장).
  - 지정자·양식 관리: ADMIN/HR.

Logging:
  INFO  — 보고서 생성·제출·재오픈, 지정자 변경, 양식 변경.
  WARNING — 권한 없는 시도 (silent skip 인 경우 추적 용도).
"""

from __future__ import annotations

import logging
import re
from datetime import date as date_cls, datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    Developer,
    User,
    WeeklyReport,
    WeeklyReportAssignment,
    WeeklyReportAttachment,
    WeeklyReportComment,
    WeeklyReportTemplate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload
from app.services.weekly_report_notify import notify_weekly_report_comment
from app.schemas.weekly_report import (
    AssignmentCreate,
    AssignmentOut,
    AssignmentUpdate,
    AttachmentOut,
    AttachmentRename,
    CommentCreate,
    CommentOut,
    CommentUpdate,
    TemplateOut,
    TemplateUpdate,
    TemplatesAllOut,
    WeeklyReportBodyUpdate,
    WeeklyReportLazyCreate,
    WeeklyReportOut,
    WeeklyReportRowOut,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/weekly-reports", tags=["weekly-reports"])


# ---------------------------------------------------------------------------
# 기본 양식 (DB 미설정 시 fallback). Settings 에서 ADMIN 이 덮어쓰기 가능.
# ---------------------------------------------------------------------------

DEFAULT_TEMPLATE_GENERAL_HTML = (
    "<h2>이번 주 한 일</h2><ul><li><p></p></li></ul>"
    "<h2>다음 주 계획</h2><ul><li><p></p></li></ul>"
    "<h2>이슈 / 도움 필요</h2><ul><li><p></p></li></ul>"
    "<h2>비고</h2><p></p>"
)
DEFAULT_TEMPLATE_MANAGER_HTML = (
    "<h2>이번 주 한 일 (본인)</h2><ul><li><p></p></li></ul>"
    "<h2>팀 동향 / 주요 이슈</h2><ul><li><p></p></li></ul>"
    "<h2>다음 주 계획 (본인)</h2><ul><li><p></p></li></ul>"
    "<h2>다음 주 팀 우선순위</h2><ul><li><p></p></li></ul>"
    "<h2>보고 / 결정 필요 사항</h2><ul><li><p></p></li></ul>"
)


# ---------------------------------------------------------------------------
# ISO week helpers
# ---------------------------------------------------------------------------


def iso_week_bounds(year: int, week: int) -> tuple[date_cls, date_cls]:
    """ISO 주의 월요일 / 일요일 반환."""
    # ISO 8601: 1월 4일을 포함하는 주가 그 해의 1주차.
    jan4 = date_cls(year, 1, 4)
    week1_monday = jan4 - timedelta(days=jan4.isoweekday() - 1)
    monday = week1_monday + timedelta(weeks=week - 1)
    sunday = monday + timedelta(days=6)
    return monday, sunday


def _strip_html(html: str | None) -> str:
    if not html:
        return ""
    return re.sub(r"<[^>]+>", " ", html).strip()


# ---------------------------------------------------------------------------
# 권한 / 매니저 판정
# ---------------------------------------------------------------------------


async def _is_manager(db: AsyncSession, developer_id: UUID) -> bool:
    """직속 부하(ACTIVE) 가 1명이라도 있으면 매니저로 판정."""
    n = await db.scalar(
        select(func.count(Developer.id)).where(
            Developer.manager_id == developer_id,
            Developer.status == "ACTIVE",
        )
    )
    return bool(n and n > 0)


async def _manager_chain_devs(db: AsyncSession, manager_dev_id: UUID) -> set[UUID]:
    """본인 + 후손(부하 chain depth 10 이내) developer.id 집합."""
    sql = """
        WITH RECURSIVE chain AS (
            SELECT id, manager_id, 1 AS depth FROM developers WHERE id = :start
          UNION ALL
            SELECT d.id, d.manager_id, c.depth + 1
              FROM developers d JOIN chain c ON d.manager_id = c.id
             WHERE c.depth < 10
        )
        SELECT id FROM chain
    """
    from sqlalchemy import text
    rows = (await db.execute(text(sql), {"start": str(manager_dev_id)})).all()
    return {r[0] for r in rows}


def _can_read_report(report: WeeklyReport, user: User, visible_devs: set[UUID]) -> bool:
    if user.role in ("SUPER_ADMIN", "ADMIN", "HR"):
        return True
    # ADMIN/HR role 없이도 user_feature_grants 로 위임된 케이스 — ContextVar 는
    # get_current_user 가 요청 진입 시 한 번 set. 다른 사람의 보고서 read 는
    # 일반 사용자 행동이 아니므로 grant 사용 시 audit trail 을 남긴다.
    from app.core.tenant_context import current_user_grants
    if "weekly_reports.view_all" in current_user_grants.get():
        if (
            user.mapped_developer_id is None
            or report.developer_id != user.mapped_developer_id
        ):
            logger.info(
                "주간보고 grant read: user=%s role=%s report=%s owner=%s",
                user.id, user.role, report.id, report.developer_id,
            )
        return True
    if user.mapped_developer_id and report.developer_id == user.mapped_developer_id:
        return True
    return report.developer_id in visible_devs


def _can_edit_report(report: WeeklyReport, user: User) -> bool:
    """본문 편집 — 작성자 본인 + ADMIN / SUPER_ADMIN.

    ADMIN 은 다른 사람이 작성한 주간보고도 수정·제출·재오픈·양식 재적용
    가능 (운영 보정 / 자리 비움 대행 등). HR 는 포함하지 않음 — 본문은
    개인 산출물이라 일반 관리 권한과 분리.
    """
    if user.role in ("SUPER_ADMIN", "ADMIN"):
        return True
    return (
        user.mapped_developer_id is not None
        and report.developer_id == user.mapped_developer_id
    )


def _can_modify_attachment(report: WeeklyReport, user: User) -> bool:
    """첨부 이름변경 / 삭제 권한 — ADMIN / HR / SUPER_ADMIN + 작성자 본인.

    본문 편집(_can_edit_report) 보다 한 단계 넓은 권한 — 인사·관리자가 잘못
    올린 첨부를 정정하거나 떼어낼 수 있게. 다운로드는 별도 — 보고서 read
    권한자(매니저 chain 등) 모두 가능.
    """
    if user.role in ("SUPER_ADMIN", "ADMIN", "HR"):
        return True
    return (
        user.mapped_developer_id is not None
        and report.developer_id == user.mapped_developer_id
    )


def _require_admin_hr(user: User) -> None:
    if user.role not in ("SUPER_ADMIN", "ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="HR/ADMIN 권한이 필요합니다.")


# ---------------------------------------------------------------------------
# row -> DTO
# ---------------------------------------------------------------------------


def _row_out(report: WeeklyReport, *, dev_name: str | None, can_edit: bool) -> WeeklyReportRowOut:
    return WeeklyReportRowOut(
        id=report.id,
        developer_id=report.developer_id,
        developer_name=dev_name,
        iso_year=report.iso_year,
        iso_week=report.iso_week,
        week_start=report.week_start,
        week_end=report.week_end,
        status=report.status,  # type: ignore[arg-type]
        submitted_at=report.submitted_at,
        attachment_count=len(report.attachments or []),
        can_edit=can_edit,
        updated_at=report.updated_at,
    )


def _detail_out(report: WeeklyReport, *, dev_name: str | None, can_edit: bool) -> WeeklyReportOut:
    return WeeklyReportOut(
        **_row_out(report, dev_name=dev_name, can_edit=can_edit).model_dump(),
        body=report.body,
        plain_text=report.plain_text,
        attachments=[
            AttachmentOut.model_validate(a, from_attributes=True)
            for a in (report.attachments or [])
        ],
    )


async def _dev_name_map(db: AsyncSession, ids: set[UUID]) -> dict[UUID, str]:
    if not ids:
        return {}
    rows = (
        await db.execute(select(Developer.id, Developer.name).where(Developer.id.in_(ids)))
    ).all()
    return {r[0]: r[1] for r in rows}


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


@router.get("/templates", response_model=TemplatesAllOut)
async def get_templates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """tenant 의 두 양식 동시 반환. 미설정 항목은 코드 fallback."""
    rows = (await db.execute(select(WeeklyReportTemplate))).scalars().all()
    by_kind = {r.kind: r.body for r in rows}
    return TemplatesAllOut(
        manager=TemplateOut(kind="MANAGER", body=by_kind.get("MANAGER") or DEFAULT_TEMPLATE_MANAGER_HTML),
        general=TemplateOut(kind="GENERAL", body=by_kind.get("GENERAL") or DEFAULT_TEMPLATE_GENERAL_HTML),
    )


@router.patch("/templates/{kind}", response_model=TemplateOut)
async def update_template(
    kind: str,
    payload: TemplateUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if kind not in ("MANAGER", "GENERAL"):
        raise HTTPException(status_code=400, detail="kind 는 MANAGER 또는 GENERAL.")
    if user.role not in ("SUPER_ADMIN", "ADMIN"):
        raise HTTPException(status_code=403, detail="ADMIN 권한이 필요합니다.")

    existing = (
        await db.execute(select(WeeklyReportTemplate).where(WeeklyReportTemplate.kind == kind))
    ).scalar_one_or_none()
    if existing:
        existing.body = payload.body
    else:
        db.add(WeeklyReportTemplate(kind=kind, body=payload.body))
    await db.commit()
    logger.info(
        "주간보고 양식 갱신: kind=%s 길이=%d (요청자=%s)",
        kind, len(payload.body), user.id,
    )
    return TemplateOut(kind=kind, body=payload.body)


async def _template_body_for(db: AsyncSession, *, manager: bool) -> str:
    kind = "MANAGER" if manager else "GENERAL"
    row = (
        await db.execute(select(WeeklyReportTemplate).where(WeeklyReportTemplate.kind == kind))
    ).scalar_one_or_none()
    if row and row.body:
        return row.body
    return DEFAULT_TEMPLATE_MANAGER_HTML if manager else DEFAULT_TEMPLATE_GENERAL_HTML


# ---------------------------------------------------------------------------
# Assignments
# ---------------------------------------------------------------------------


@router.get("/assignments", response_model=list[AssignmentOut])
async def list_assignments(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    stmt = select(WeeklyReportAssignment).order_by(WeeklyReportAssignment.created_at.asc())
    if not include_inactive:
        stmt = stmt.where(WeeklyReportAssignment.active.is_(True))
    rows = (await db.execute(stmt)).scalars().all()
    name_map = await _dev_name_map(db, {r.developer_id for r in rows})
    return [
        AssignmentOut(
            **{k: getattr(r, k) for k in (
                "id", "developer_id", "active", "start_year", "start_week",
                "end_year", "end_week", "note", "created_at", "updated_at",
            )},
            developer_name=name_map.get(r.developer_id),
        )
        for r in rows
    ]


@router.post("/assignments", response_model=AssignmentOut, status_code=201)
async def create_assignment(
    payload: AssignmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    # 같은 developer 의 중복 row 방지 — UNIQUE 가 막지만 사전 메시지 친절하게.
    dup = (
        await db.execute(
            select(WeeklyReportAssignment).where(
                WeeklyReportAssignment.developer_id == payload.developer_id
            )
        )
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=400, detail="이미 등록된 임직원입니다.")
    a = WeeklyReportAssignment(**payload.model_dump())
    db.add(a)
    await db.commit()
    await db.refresh(a)
    name_map = await _dev_name_map(db, {a.developer_id})
    logger.info(
        "주간보고 지정자 등록: developer_id=%s (요청자=%s)",
        a.developer_id, user.id,
    )
    return AssignmentOut(
        **{k: getattr(a, k) for k in (
            "id", "developer_id", "active", "start_year", "start_week",
            "end_year", "end_week", "note", "created_at", "updated_at",
        )},
        developer_name=name_map.get(a.developer_id),
    )


@router.patch("/assignments/{aid}", response_model=AssignmentOut)
async def update_assignment(
    aid: UUID,
    payload: AssignmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    a = (await db.execute(select(WeeklyReportAssignment).where(WeeklyReportAssignment.id == aid))).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(a, k, v)
    await db.commit()
    await db.refresh(a)
    name_map = await _dev_name_map(db, {a.developer_id})
    logger.info(
        "주간보고 지정자 수정: id=%s 변경=%s (요청자=%s)",
        aid, list(data.keys()), user.id,
    )
    return AssignmentOut(
        **{k: getattr(a, k) for k in (
            "id", "developer_id", "active", "start_year", "start_week",
            "end_year", "end_week", "note", "created_at", "updated_at",
        )},
        developer_name=name_map.get(a.developer_id),
    )


@router.delete("/assignments/{aid}", status_code=204)
async def delete_assignment(
    aid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_hr(user)
    a = (await db.execute(select(WeeklyReportAssignment).where(WeeklyReportAssignment.id == aid))).scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    await db.delete(a)
    await db.commit()
    logger.warning(
        "주간보고 지정자 삭제: id=%s developer_id=%s (요청자=%s)",
        aid, a.developer_id, user.id,
    )


# ---------------------------------------------------------------------------
# Reports — list / detail / lazy-create / body / submit / reopen
# ---------------------------------------------------------------------------


@router.get("", response_model=list[WeeklyReportOut])
async def list_reports(
    owner: str = "me",   # me | team | all
    from_year: int | None = None,
    from_week: int | None = None,
    to_year: int | None = None,
    to_week: int | None = None,
    include_body: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """주간보고 row 목록.

    owner:
      - me   : 본인 row 만 (assigned 여부 무관 — 작성한 적 있는 모든 row)
      - team : 직속 후손 (manager chain depth 10) 의 row
      - all  : 전체 (HR/ADMIN/SUPER_ADMIN 만)

    include_body:
      - False (기본): 그리드/매트릭스 용 row-level 응답 (body/첨부 비포함, payload 작음).
      - True        : 매니저 '모아보기' 용 detail 응답 (body + attachments 포함).
    """
    stmt = select(WeeklyReport).options(selectinload(WeeklyReport.attachments))

    if owner == "me":
        if not user.mapped_developer_id:
            return []
        stmt = stmt.where(WeeklyReport.developer_id == user.mapped_developer_id)
    elif owner == "team":
        if not user.mapped_developer_id:
            return []
        chain = await _manager_chain_devs(db, user.mapped_developer_id)
        # 본인 제외 — 본인 row 는 'me' 로.
        chain.discard(user.mapped_developer_id)
        if not chain:
            return []
        stmt = stmt.where(WeeklyReport.developer_id.in_(chain))
    elif owner == "all":
        # ADMIN/HR role 또는 user_feature_grants 로 위임 받은 user 만.
        from app.core.tenant_context import current_user_grants
        has_grant = "weekly_reports.view_all" in current_user_grants.get()
        if user.role not in ("SUPER_ADMIN", "ADMIN", "HR") and not has_grant:
            logger.warning(
                "주간보고 전체 조회 거부: role=%s user_id=%s", user.role, user.id
            )
            return []
        # 별도 절 없음 — RLS 가 tenant 격리
    else:
        raise HTTPException(status_code=400, detail="owner 는 me|team|all.")

    # 주 범위 필터 — (year, week) 비교를 (year*100 + week) 단조키로 처리.
    if from_year is not None and from_week is not None:
        from_key = from_year * 100 + from_week
        stmt = stmt.where((WeeklyReport.iso_year * 100 + WeeklyReport.iso_week) >= from_key)
    if to_year is not None and to_week is not None:
        to_key = to_year * 100 + to_week
        stmt = stmt.where((WeeklyReport.iso_year * 100 + WeeklyReport.iso_week) <= to_key)

    stmt = stmt.order_by(
        WeeklyReport.iso_year.desc(),
        WeeklyReport.iso_week.desc(),
        WeeklyReport.developer_id.asc(),
    )
    rows = (await db.execute(stmt)).scalars().unique().all()
    name_map = await _dev_name_map(db, {r.developer_id for r in rows})
    out: list[WeeklyReportOut] = []
    for r in rows:
        if include_body:
            out.append(_detail_out(
                r,
                dev_name=name_map.get(r.developer_id),
                can_edit=_can_edit_report(r, user),
            ))
        else:
            # body/첨부 미포함 — payload 절감. 응답 schema 는 superset 이라
            # body=None, attachments=[] 로 반환.
            row = _row_out(
                r,
                dev_name=name_map.get(r.developer_id),
                can_edit=_can_edit_report(r, user),
            )
            out.append(WeeklyReportOut(
                **row.model_dump(),
                body=None,
                plain_text=None,
                attachments=[],
            ))
    return out


@router.get("/{report_id}", response_model=WeeklyReportOut)
async def get_report(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    report = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(WeeklyReport.id == report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")

    # 가시 범위 — 본인 + 매니저 chain 후손. 매니저 외 본인이면 chain 불필요.
    visible: set[UUID] = set()
    if user.mapped_developer_id:
        visible = await _manager_chain_devs(db, user.mapped_developer_id)
    if not _can_read_report(report, user, visible):
        raise HTTPException(status_code=403, detail="권한 없음")

    name_map = await _dev_name_map(db, {report.developer_id})
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


@router.post("", response_model=WeeklyReportOut, status_code=200)
async def lazy_create_report(
    payload: WeeklyReportLazyCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """매트릭스 셀 클릭용 — 없으면 새 DRAFT 생성, 있으면 그대로 반환.

    본인 행만 생성 가능. ADMIN 도 본인 행이 아니면 만들 수 없음 — 기존 행이
    있으면 GET 으로 열람.
    """
    if (
        user.mapped_developer_id is None
        or payload.developer_id != user.mapped_developer_id
    ) and user.role != "SUPER_ADMIN":
        raise HTTPException(
            status_code=403,
            detail="본인 보고서만 생성할 수 있습니다.",
        )
    # 1~53 범위만 허용
    if not (1 <= payload.iso_week <= 53):
        raise HTTPException(status_code=400, detail="iso_week 는 1~53.")

    existing = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(
                WeeklyReport.developer_id == payload.developer_id,
                WeeklyReport.iso_year == payload.iso_year,
                WeeklyReport.iso_week == payload.iso_week,
              )
        )
    ).scalar_one_or_none()
    if existing:
        name_map = await _dev_name_map(db, {existing.developer_id})
        return _detail_out(
            existing,
            dev_name=name_map.get(existing.developer_id),
            can_edit=_can_edit_report(existing, user),
        )

    monday, sunday = iso_week_bounds(payload.iso_year, payload.iso_week)
    is_mgr = await _is_manager(db, payload.developer_id)
    body = await _template_body_for(db, manager=is_mgr)
    plain = _strip_html(body)

    report = WeeklyReport(
        developer_id=payload.developer_id,
        iso_year=payload.iso_year,
        iso_week=payload.iso_week,
        week_start=monday,
        week_end=sunday,
        body=body,
        plain_text=plain,
        status="DRAFT",
    )
    db.add(report)
    await db.commit()
    await db.refresh(report, attribute_names=["attachments"])
    name_map = await _dev_name_map(db, {report.developer_id})
    logger.info(
        "주간보고 신규 생성: developer_id=%s year=%d week=%d (template=%s, 요청자=%s)",
        report.developer_id, report.iso_year, report.iso_week,
        "MANAGER" if is_mgr else "GENERAL", user.id,
    )
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


@router.patch("/{report_id}/body", response_model=WeeklyReportOut)
async def update_body(
    report_id: UUID,
    payload: WeeklyReportBodyUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    report = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(WeeklyReport.id == report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    if not _can_edit_report(report, user):
        raise HTTPException(status_code=403, detail="본인만 편집할 수 있습니다.")
    if payload.body is not None:
        report.body = payload.body
        report.plain_text = (
            payload.plain_text if payload.plain_text is not None else _strip_html(payload.body)
        )
    elif payload.plain_text is not None:
        report.plain_text = payload.plain_text
    await db.commit()
    await db.refresh(report)
    name_map = await _dev_name_map(db, {report.developer_id})
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


@router.patch("/{report_id}/submit", response_model=WeeklyReportOut)
async def submit_report(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    report = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(WeeklyReport.id == report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    if not _can_edit_report(report, user):
        raise HTTPException(status_code=403, detail="본인만 제출할 수 있습니다.")
    report.status = "SUBMITTED"
    report.submitted_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "주간보고 제출: id=%s developer_id=%s year=%d week=%d (요청자=%s)",
        report.id, report.developer_id, report.iso_year, report.iso_week, user.id,
    )
    name_map = await _dev_name_map(db, {report.developer_id})
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


@router.patch("/{report_id}/reopen", response_model=WeeklyReportOut)
async def reopen_report(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    report = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(WeeklyReport.id == report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    if not _can_edit_report(report, user):
        raise HTTPException(status_code=403, detail="본인만 재오픈할 수 있습니다.")
    report.status = "DRAFT"
    report.submitted_at = None
    await db.commit()
    await db.refresh(report)
    logger.info(
        "주간보고 재오픈: id=%s developer_id=%s year=%d week=%d (요청자=%s)",
        report.id, report.developer_id, report.iso_year, report.iso_week, user.id,
    )
    name_map = await _dev_name_map(db, {report.developer_id})
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


@router.patch("/{report_id}/reapply-template", response_model=WeeklyReportOut)
async def reapply_template(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """양식 재적용 — DRAFT row 의 body 를 최신 양식 (작성자의 매니저 여부에
    맞는 kind) 으로 덮어쓴다.

    제약:
      - 본인만 (편집 권한자) 호출 가능. ADMIN 도 본인 행이 아니면 불가.
      - status == 'DRAFT' 일 때만 — SUBMITTED 행의 본문을 임의로 갈아엎지
        않도록 가드. (재오픈 후 다시 적용하는 흐름은 가능.)
    """
    report = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(WeeklyReport.id == report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    if not _can_edit_report(report, user):
        raise HTTPException(status_code=403, detail="본인만 재적용할 수 있습니다.")
    if report.status != "DRAFT":
        raise HTTPException(
            status_code=400,
            detail="제출된 보고서에는 양식을 재적용할 수 없습니다 — 먼저 [재오픈] 후 시도하세요.",
        )

    is_mgr = await _is_manager(db, report.developer_id)
    body = await _template_body_for(db, manager=is_mgr)
    report.body = body
    report.plain_text = _strip_html(body)
    await db.commit()
    await db.refresh(report)
    logger.info(
        "주간보고 양식 재적용: id=%s developer_id=%s year=%d week=%d "
        "template=%s (요청자=%s)",
        report.id, report.developer_id, report.iso_year, report.iso_week,
        "MANAGER" if is_mgr else "GENERAL", user.id,
    )
    name_map = await _dev_name_map(db, {report.developer_id})
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post("/{report_id}/attachments", response_model=WeeklyReportOut)
async def upload_attachments(
    report_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    report = (
        await db.execute(
            select(WeeklyReport)
              .options(selectinload(WeeklyReport.attachments))
              .where(WeeklyReport.id == report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    if not _can_edit_report(report, user):
        raise HTTPException(status_code=403, detail="본인만 첨부할 수 있습니다.")

    # 디스크 저장은 공용 helper — `<upload.dir>/<tenant_id>/weekly-reports/<id>/<uuid>.<ext>`,
    # DB 에는 tenant prefix 없는 상대 경로만 (resolve 시점에 합성).
    subdir = f"weekly-reports/{report.id}"
    for f in files:
        stored_rel, size = await save_upload(f, subdir)
        att = WeeklyReportAttachment(
            weekly_report_id=report.id,
            file_name=f.filename or stored_rel.split("/")[-1],
            file_path=stored_rel,
            mime_type=f.content_type,
            size=size,
        )
        db.add(att)
    await db.commit()
    await db.refresh(report, attribute_names=["attachments"])
    name_map = await _dev_name_map(db, {report.developer_id})
    logger.info(
        "주간보고 첨부 업로드: report_id=%s files=%d (요청자=%s)",
        report.id, len(files), user.id,
    )
    return _detail_out(
        report,
        dev_name=name_map.get(report.developer_id),
        can_edit=_can_edit_report(report, user),
    )


async def _load_attachment_or_404(
    db: AsyncSession, aid: UUID,
) -> tuple[WeeklyReportAttachment, WeeklyReport]:
    att = (
        await db.execute(
            select(WeeklyReportAttachment).where(WeeklyReportAttachment.id == aid)
        )
    ).scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=404, detail="찾을 수 없습니다.")
    report = (
        await db.execute(
            select(WeeklyReport).where(WeeklyReport.id == att.weekly_report_id)
        )
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="보고서가 사라졌습니다.")
    return att, report


@router.get("/attachments/{aid}")
async def download_attachment(
    aid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """첨부 다운로드 — 보고서 read 권한자 모두 (매니저 chain · ADMIN/HR 포함).

    이름변경/삭제와 달리 ADMIN/HR + 본인 보다 한 단계 더 넓은 권한.
    """
    att, report = await _load_attachment_or_404(db, aid)
    visible: set[UUID] = set()
    if user.mapped_developer_id:
        visible = await _manager_chain_devs(db, user.mapped_developer_id)
    if not _can_read_report(report, user, visible):
        raise HTTPException(status_code=403, detail="권한 없음")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        media_type=att.mime_type or "application/octet-stream",
        filename=att.file_name,
    )


@router.patch("/attachments/{aid}", response_model=AttachmentOut)
async def rename_attachment(
    aid: UUID,
    payload: AttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """첨부 파일명 변경 — DB 의 file_name 만 수정 (디스크 파일은 그대로).

    권한 = ADMIN / HR / SUPER_ADMIN + 작성자 본인.
    """
    att, report = await _load_attachment_or_404(db, aid)
    if not _can_modify_attachment(report, user):
        logger.warning(
            "주간보고 첨부 이름변경 거부: aid=%s role=%s user=%s",
            aid, user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="권한 없음")
    new_name = (payload.file_name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="파일명이 비어 있습니다.")
    att.file_name = new_name
    await db.commit()
    await db.refresh(att)
    logger.info(
        "주간보고 첨부 이름변경: aid=%s report_id=%s name=%s (요청자=%s)",
        aid, report.id, new_name, user.id,
    )
    return AttachmentOut.model_validate(att, from_attributes=True)


@router.delete("/attachments/{aid}", status_code=204)
async def delete_attachment(
    aid: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """첨부 삭제 — ADMIN / HR / SUPER_ADMIN + 작성자 본인."""
    att, report = await _load_attachment_or_404(db, aid)
    if not _can_modify_attachment(report, user):
        logger.warning(
            "주간보고 첨부 삭제 거부: aid=%s role=%s user=%s",
            aid, user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="권한 없음")
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    logger.info(
        "주간보고 첨부 삭제: aid=%s report_id=%s (요청자=%s)",
        aid, report.id, user.id,
    )


# ---------------------------------------------------------------------------
# Comments — SUBMITTED 보고서에만 작성. 작성 시 owner 에게 DM 알림.
# ---------------------------------------------------------------------------


async def _load_report_for_comment(
    db: AsyncSession, report_id: UUID, user: User,
) -> WeeklyReport:
    """report 조회 + read 권한 체크. 조회 가능자 = 코멘트 열람·작성 가능자."""
    report = (
        await db.execute(select(WeeklyReport).where(WeeklyReport.id == report_id))
    ).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="보고서를 찾을 수 없습니다.")
    visible: set[UUID] = set()
    if user.mapped_developer_id:
        visible = await _manager_chain_devs(db, user.mapped_developer_id)
    if not _can_read_report(report, user, visible):
        raise HTTPException(status_code=403, detail="권한 없음")
    return report


def _can_edit_comment(c: WeeklyReportComment, user: User) -> bool:
    """수정·삭제 권한 — 작성자 본인 + ADMIN/SUPER_ADMIN."""
    if user.role in ("SUPER_ADMIN", "ADMIN"):
        return True
    # author_user_id 우선 — developer 미매핑 작성자도 본인 식별 가능.
    if c.author_user_id and c.author_user_id == user.id:
        return True
    if (
        c.author_id
        and user.mapped_developer_id
        and c.author_id == user.mapped_developer_id
    ):
        return True
    return False


async def _serialize_comment(
    db: AsyncSession,
    c: WeeklyReportComment,
    user: User,
    *,
    name_cache: dict[UUID, str] | None = None,
    user_name_cache: dict[UUID, str] | None = None,
) -> CommentOut:
    name: str | None = None
    if c.author_id:
        if name_cache is None:
            name_cache = await _dev_name_map(db, {c.author_id})
        name = name_cache.get(c.author_id)
    if not name and c.author_user_id:
        if user_name_cache is None:
            row = (
                await db.execute(select(User.name).where(User.id == c.author_user_id))
            ).first()
            name = row[0] if row else None
        else:
            name = user_name_cache.get(c.author_user_id)
    return CommentOut(
        id=c.id,
        weekly_report_id=c.weekly_report_id,
        author_id=c.author_id,
        author_name=name,
        body=c.body,
        created_at=c.created_at,
        updated_at=c.updated_at,
        can_edit=_can_edit_comment(c, user),
    )


@router.get("/{report_id}/comments", response_model=list[CommentOut])
async def list_comments(
    report_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _load_report_for_comment(db, report_id, user)
    rows = list(
        (
            await db.execute(
                select(WeeklyReportComment)
                .where(WeeklyReportComment.weekly_report_id == report_id)
                .order_by(WeeklyReportComment.created_at.asc())
            )
        ).scalars()
    )
    name_cache = await _dev_name_map(
        db, {c.author_id for c in rows if c.author_id}
    )
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
            db, c, user,
            name_cache=name_cache, user_name_cache=user_name_cache,
        )
        for c in rows
    ]


@router.post(
    "/{report_id}/comments", response_model=CommentOut, status_code=201,
)
async def create_comment(
    report_id: UUID,
    payload: CommentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    report = await _load_report_for_comment(db, report_id, user)
    # SUBMITTED 보고서에만 — DRAFT 는 owner 가 편집중이라 코멘트 의미 없음.
    if report.status != "SUBMITTED":
        raise HTTPException(
            status_code=400,
            detail="제출(SUBMITTED) 된 보고서에만 코멘트를 작성할 수 있습니다.",
        )
    c = WeeklyReportComment(
        weekly_report_id=report_id,
        author_id=user.mapped_developer_id,
        author_user_id=user.id,  # developer 미매핑이어도 작성자 추적.
        body=payload.body,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    logger.info(
        "주간보고 코멘트 작성: report=%s comment=%s actor=%s",
        report_id, c.id, user.id,
    )
    # owner 알림 — 발송 실패가 코멘트 작성을 막지 않도록 try/except.
    try:
        await notify_weekly_report_comment(db, comment_id=c.id)
    except Exception as exc:  # pragma: no cover — best effort 알림.
        logger.warning(
            "weekly_report_notify 실패 (comment=%s): %s", c.id, exc,
        )
    return await _serialize_comment(db, c, user)


@router.patch(
    "/{report_id}/comments/{comment_id}", response_model=CommentOut,
)
async def update_comment(
    report_id: UUID,
    comment_id: UUID,
    payload: CommentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _load_report_for_comment(db, report_id, user)
    c = (
        await db.execute(
            select(WeeklyReportComment).where(
                WeeklyReportComment.id == comment_id,
                WeeklyReportComment.weekly_report_id == report_id,
            )
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    if not _can_edit_comment(c, user):
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다.")
    c.body = payload.body
    await db.commit()
    await db.refresh(c)
    logger.info(
        "주간보고 코멘트 수정: report=%s comment=%s actor=%s",
        report_id, comment_id, user.id,
    )
    return await _serialize_comment(db, c, user)


@router.delete(
    "/{report_id}/comments/{comment_id}", status_code=204,
)
async def delete_comment(
    report_id: UUID,
    comment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _load_report_for_comment(db, report_id, user)
    c = (
        await db.execute(
            select(WeeklyReportComment).where(
                WeeklyReportComment.id == comment_id,
                WeeklyReportComment.weekly_report_id == report_id,
            )
        )
    ).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    if not _can_edit_comment(c, user):
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다.")
    await db.delete(c)
    await db.commit()
    logger.warning(
        "주간보고 코멘트 삭제: report=%s comment=%s actor=%s",
        report_id, comment_id, user.id,
    )
