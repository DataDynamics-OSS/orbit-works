"""회의록 (MeetingNote) — CRUD + 공유 + 첨부 + 알림.

권한:
- 읽기: 작성자(author_id == mapped_developer_id) 또는 공유받은 직원.
- 메타 변경 (제목/고객/프로젝트/공유) + 삭제: 작성자만.
- 본문/첨부 변경: 작성자 + 공유받은 직원 (모두).

알림:
- 신규 작성/공유 추가 시 해당 직원에게 Slack/Mattermost DM 발송. 직원의
  `personal_email or company_email` 을 user_emails 로 전달 (notify provider 가
  이메일 → Slack user_id 매핑).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.models import (
    Customer,
    Developer,
    MeetingNote,
    MeetingNoteActionItem,
    MeetingNoteAttachment,
    MeetingNoteShare,
    Project,
    User,
)
from app.schemas.meeting_note import (
    ActionItemCreate,
    ActionItemDoneCursor,
    ActionItemDonePage,
    ActionItemOut,
    ActionItemUpdate,
    StandaloneActionItemCreate,
    AttachmentOut,
    AttachmentRename,
    MeetingNoteBodyUpdate,
    MeetingNoteCreate,
    MeetingNoteEmailRequest,
    MeetingNoteEmailResult,
    MeetingNoteEmailSkipped,
    MeetingNoteDrawioUpdate,
    MeetingNoteMindmapUpdate,
    MeetingNoteOut,
    MeetingNoteRowOut,
    MeetingNoteUpdate,
    ShareOut,
)
from app.services.notify import notify_service
from app.services.meeting_note_email import (
    build_notify_text,
    send_meeting_note_email,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meeting-notes", tags=["meeting-notes"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_author(note: MeetingNote, user: User) -> bool:
    return note.author_user_id == user.id


def _is_shared(note: MeetingNote, user: User) -> bool:
    if user.mapped_developer_id is None:
        return False
    return any(s.developer_id == user.mapped_developer_id for s in note.shares)


def _can_read(note: MeetingNote, user: User) -> bool:
    """읽기 — 작성자, 공유받은 사람, ADMIN, SUPER_ADMIN.
    ADMIN 은 '전체 (회사)' 탭에서 본 회의록을 상세까지 열람 가능 (감독 목적).
    편집은 별도 가드(`_can_edit_body`) 가 더 좁게 막는다.
    """
    if user.role in ("SUPER_ADMIN", "ADMIN"):
        return True
    return _is_author(note, user) or _is_shared(note, user)


def _can_edit_body(note: MeetingNote, user: User) -> bool:
    """본문/첨부 편집 — 작성자 + 공유받은 사람 + SUPER_ADMIN.
    ADMIN 은 읽기 전용 (감독 목적, 본문 변경 권한은 부여하지 않는다).
    """
    if user.role == "SUPER_ADMIN":
        return True
    return _is_author(note, user) or _is_shared(note, user)


async def _load_note(db: AsyncSession, note_id: UUID) -> MeetingNote:
    note = (
        await db.execute(
            select(MeetingNote)
            .options(
                selectinload(MeetingNote.shares).selectinload(
                    MeetingNoteShare.developer
                ),
                selectinload(MeetingNote.attachments),
                selectinload(MeetingNote.action_items),
                selectinload(MeetingNote.author),
            )
            .where(MeetingNote.id == note_id)
        )
    ).scalar_one_or_none()
    if note is None:
        raise HTTPException(status_code=404, detail="회의록을 찾을 수 없습니다.")
    return note


async def _name_lookups(
    db: AsyncSession,
    notes: Iterable[MeetingNote],
) -> tuple[dict[UUID, str], dict[UUID, str], dict[UUID, str], dict[UUID, str]]:
    """customer / project / developer 이름 + 작성자 user 이름 한 번에 모아 반환.

    - devs: developer.id → developer.name (author_id 또는 share/uploader 용)
    - users: user.id → user.name(빈 값이면 email) (developer 매핑 없는 admin 작성자
      표시에 fallback 으로 사용)
    """
    cust_ids = {n.customer_id for n in notes if n.customer_id}
    proj_ids = {n.project_id for n in notes if n.project_id}
    dev_ids = {n.author_id for n in notes if n.author_id}
    user_ids = {n.author_user_id for n in notes if n.author_user_id}
    customers: dict[UUID, str] = {}
    projects: dict[UUID, str] = {}
    devs: dict[UUID, str] = {}
    users: dict[UUID, str] = {}
    if cust_ids:
        rows = (
            await db.execute(
                select(Customer.id, Customer.name).where(Customer.id.in_(cust_ids))
            )
        ).all()
        customers = {r[0]: r[1] for r in rows}
    if proj_ids:
        rows = (
            await db.execute(
                select(Project.id, Project.name).where(Project.id.in_(proj_ids))
            )
        ).all()
        projects = {r[0]: r[1] for r in rows}
    if dev_ids:
        rows = (
            await db.execute(
                select(Developer.id, Developer.name).where(Developer.id.in_(dev_ids))
            )
        ).all()
        devs = {r[0]: r[1] for r in rows}
    if user_ids:
        rows = (
            await db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(user_ids))
            )
        ).all()
        users = {r[0]: (r[1] or r[2]) for r in rows}
    return customers, projects, devs, users


def _row_out(
    note: MeetingNote,
    *,
    can_edit: bool,
    customers: dict[UUID, str],
    projects: dict[UUID, str],
    devs: dict[UUID, str],
    users: dict[UUID, str],
    counts: tuple[int, int, bool, int] | None = None,
) -> MeetingNoteRowOut:
    if counts is not None:
        share_n, att_n, has_mm, action_n = counts
    else:
        share_n = len(note.shares) if note.shares is not None else 0
        att_n = len(note.attachments) if note.attachments is not None else 0
        action_n = (
            len(note.action_items) if note.action_items is not None else 0
        )
        # 마인드맵 존재 여부 — nodes 가 1개 이상이거나 P3-Full Yjs state 가 있으면 True.
        mm = note.mindmap_data
        has_mm = bool(
            (isinstance(mm, dict) and mm.get("nodes"))
            or note.mindmap_yjs is not None
        )
    # drawio 다이어그램 존재 여부 — XML 본문이 비어있지 않으면 true.
    has_dx = bool(note.drawio_xml and note.drawio_xml.strip())
    # 작성자명 — developer 매핑이 있으면 dev.name, 없으면 user.name/email.
    author_name: str | None = None
    if note.author_id:
        author_name = devs.get(note.author_id)
    if not author_name and note.author_user_id:
        author_name = users.get(note.author_user_id)
    return MeetingNoteRowOut(
        id=note.id,
        title=note.title,
        customer_id=note.customer_id,
        customer_name=customers.get(note.customer_id) if note.customer_id else None,
        project_id=note.project_id,
        project_name=projects.get(note.project_id) if note.project_id else None,
        author_id=note.author_id,
        author_name=author_name,
        share_count=share_n,
        attachment_count=att_n,
        action_count=action_n,
        has_mindmap=has_mm,
        has_drawio=has_dx,
        can_edit=can_edit,
        created_at=note.created_at,
        updated_at=note.updated_at,
    )


def _detail_out(
    note: MeetingNote,
    *,
    can_edit: bool,
    customers: dict[UUID, str],
    projects: dict[UUID, str],
    devs: dict[UUID, str],
    users: dict[UUID, str],
    share_dev_names: dict[UUID, str],
    att_uploader_names: dict[UUID, str],
) -> MeetingNoteOut:
    base = _row_out(
        note,
        can_edit=can_edit,
        customers=customers,
        projects=projects,
        devs=devs,
        users=users,
    )
    return MeetingNoteOut(
        **base.model_dump(),
        body=note.body,
        mindmap_data=note.mindmap_data,
        drawio_xml=note.drawio_xml,
        shares=[
            ShareOut(
                developer_id=s.developer_id,
                developer_name=share_dev_names.get(s.developer_id),
                notified_at=s.notified_at,
                last_seen_at=s.last_seen_at,
            )
            for s in note.shares
        ],
        attachments=[
            AttachmentOut(
                id=a.id,
                file_name=a.file_name,
                mime_type=a.mime_type,
                size=a.size,
                uploaded_by=a.uploaded_by,
                uploaded_by_name=(
                    att_uploader_names.get(a.uploaded_by) if a.uploaded_by else None
                ),
                created_at=a.created_at,
            )
            for a in note.attachments
        ],
        action_items=[_action_item_out(it) for it in (note.action_items or [])],
    )


def _action_item_out(
    it: MeetingNoteActionItem,
    *,
    note_title: str | None = None,
    customer_name: str | None = None,
    project_name: str | None = None,
) -> ActionItemOut:
    """라우터 응답용 변환. assignee_name 은 항상 DB 에 저장되어 있어야 함
    (생성/수정 시 Developer.name 을 미리 채움 — async 컨텍스트에서 lazy-load
    하면 MissingGreenlet).

    customer_name / project_name 은 호출 사이트가 별도 SELECT 로 한 번에
    lookup 한 뒤 인자로 주입 (lazy-load 회피 + N+1 방지).
    """
    return ActionItemOut(
        id=it.id,
        meeting_note_id=it.meeting_note_id,
        title=it.title,
        assignee_id=it.assignee_id,
        assignee_name=it.assignee_name,
        due_date=it.due_date,
        status=it.status,  # type: ignore[arg-type]
        note_text=it.note_text,
        completion_comment=it.completion_comment,
        sort_order=it.sort_order,
        completed_at=it.completed_at,
        note_title=note_title,
        customer_id=it.customer_id,
        project_id=it.project_id,
        customer_name=customer_name,
        project_name=project_name,
        created_at=it.created_at,
        updated_at=it.updated_at,
    )


async def _send_share_notifications(
    db: AsyncSession,
    note: MeetingNote,
    developer_ids: list[UUID],
) -> None:
    """공유받은 직원에게 회의록 링크 DM. 발송 성공 시 notified_at 갱신."""
    if not developer_ids:
        return
    devs = (
        await db.execute(
            select(Developer.id, Developer.name, Developer.personal_email,
                   Developer.company_email)
            .where(Developer.id.in_(developer_ids))
        )
    ).all()
    if not devs:
        return
    base_url = get_settings().server.public_url.rstrip("/")
    link = f"{base_url}/meeting-notes/{note.id}"
    author_name = note.author.name if note.author else "관리자"
    text = (
        f"📝 [회의록] {note.title}\n"
        f"작성자: {author_name}\n"
        f"{link}"
    )
    now = datetime.now(timezone.utc)
    sent_to: set[UUID] = set()
    for dev_id, dev_name, p_email, c_email in devs:
        email = p_email or c_email
        if not email:
            continue
        try:
            ok = await notify_service.send_for_tenant(
                note.tenant_id, text, user_emails=[email],
                feature="meeting_note",
            )
            if ok:
                sent_to.add(dev_id)
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "회의록 알림 실패 note=%s dev=%s: %s",
                note.id, dev_id, exc, exc_info=True,
            )
    if sent_to:
        for s in note.shares:
            if s.developer_id in sent_to:
                s.notified_at = now


# ---------------------------------------------------------------------------
# 목록
# ---------------------------------------------------------------------------


@router.get("", response_model=list[MeetingNoteRowOut])
async def list_notes(
    scope: str = "all",  # all | company | mine | shared
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """내가 작성했거나 공유받은 회의록.

    scope:
    - mine    : 내가 작성한 것만
    - shared  : 내가 공유받은 것만
    - all (기본): 둘 다 (= 내 목록)
    - company : 회사 전체 (관리자/SUPER_ADMIN 전용 — 그 외엔 [] 반환)
    """
    # company 탭 — ADMIN/SUPER_ADMIN 의 감독 뷰 (전 회의록 읽기 전용 노출).
    # RLS 가 tenant 격리는 보장하므로 별도 tenant 필터 불필요. 권한 없으면
    # 빈 배열 (시도 자체는 silent — 조용히 빈 목록 반환).
    if scope == "company":
        if user.role not in ("ADMIN", "SUPER_ADMIN"):
            logger.warning(
                "회의록 회사 전체 조회 거부: role=%s user_id=%s — ADMIN/SUPER_ADMIN 만 허용",
                user.role, user.id,
            )
            return []
        stmt = (
            select(MeetingNote)
            .options(
                selectinload(MeetingNote.shares),
                selectinload(MeetingNote.attachments),
                selectinload(MeetingNote.action_items),
            )
            .order_by(MeetingNote.updated_at.desc())
        )
        notes = (await db.execute(stmt)).scalars().unique().all()
        customers, projects, devs, users = await _name_lookups(db, notes)
        rows = []
        for n in notes:
            # ADMIN 도 본인 작성건만 편집 가능 — 다른 사람 행은 read-only.
            # _is_author 가 author_user_id == user.id 검증.
            can_edit = _is_author(n, user)
            rows.append(_row_out(
                n, can_edit=can_edit,
                customers=customers, projects=projects, devs=devs, users=users,
            ))
        logger.info(
            "회의록 회사 전체 조회: count=%d (조회자=%s, role=%s)",
            len(rows), user.id, user.role,
        )
        return rows

    clauses = []
    if scope in ("mine", "all"):
        # 작성자 식별은 user.id 기반 — developer 매핑 없는 admin 도 본인 작성건 표시.
        clauses.append(MeetingNote.author_user_id == user.id)
    if scope in ("shared", "all") and user.mapped_developer_id is not None:
        # 공유는 developer 단위라 매핑 없는 사용자에겐 의미 없음.
        clauses.append(
            MeetingNote.id.in_(
                select(MeetingNoteShare.meeting_note_id).where(
                    MeetingNoteShare.developer_id == user.mapped_developer_id
                )
            )
        )
    if not clauses:
        # SUPER_ADMIN 은 전체 노출. 그 외 mapped_developer_id 도 없고 scope 매치도 없으면 빈 결과.
        if user.role == "SUPER_ADMIN":
            stmt = (
                select(MeetingNote)
                .options(
                    selectinload(MeetingNote.shares),
                    selectinload(MeetingNote.attachments),
                    selectinload(MeetingNote.action_items),
                )
                .order_by(MeetingNote.updated_at.desc())
            )
        else:
            return []
    else:
        stmt = (
            select(MeetingNote)
            .options(
                selectinload(MeetingNote.shares),
                selectinload(MeetingNote.attachments),
                selectinload(MeetingNote.action_items),
            )
            .where(or_(*clauses))
            .order_by(MeetingNote.updated_at.desc())
        )
    notes = (await db.execute(stmt)).scalars().unique().all()
    customers, projects, devs, users = await _name_lookups(db, notes)
    rows = []
    for n in notes:
        can_edit = _is_author(n, user)
        rows.append(_row_out(
            n, can_edit=can_edit,
            customers=customers, projects=projects, devs=devs, users=users,
        ))
    return rows


# ---------------------------------------------------------------------------
# 작성 / 상세 / 수정 / 삭제
# ---------------------------------------------------------------------------


@router.post("", response_model=MeetingNoteOut, status_code=201)
async def create_note(
    payload: MeetingNoteCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = MeetingNote(
        title=payload.title.strip(),
        customer_id=payload.customer_id,
        project_id=payload.project_id,
        # 매핑된 developer 없으면 NULL — 표시 시 user 이름으로 fallback.
        author_id=user.mapped_developer_id,
        author_user_id=user.id,
    )
    db.add(note)
    await db.flush()  # note.id 확보

    # 공유 — 작성자 자신(매핑된 dev) 은 자동 제외 (있다면).
    new_share_ids = [
        d for d in payload.share_developer_ids
        if user.mapped_developer_id is None or d != user.mapped_developer_id
    ]
    for dev_id in new_share_ids:
        db.add(MeetingNoteShare(meeting_note_id=note.id, developer_id=dev_id))
    await db.flush()
    await db.refresh(note)
    await db.refresh(note, attribute_names=["shares", "attachments", "author", "action_items"])

    # 알림 — 발송 성공 시 notified_at 갱신, 실패해도 회의록 자체는 생성.
    await _send_share_notifications(db, note, new_share_ids)
    await db.commit()
    await db.refresh(note, attribute_names=["shares", "attachments", "author", "action_items"])

    return await _detail(db, note, user)


# ---------------------------------------------------------------------------
# 액션 아이템 list — `/{note_id}` 보다 먼저 선언해야 한다.
# `/action-items` 는 1 segment 라 `/{note_id}` 와 충돌 (note_id 가 'action-items'
# 로 해석되어 UUID 검증 실패 → 422). literal path 를 위로.
# ---------------------------------------------------------------------------


async def _manager_chain_devs(db: AsyncSession, manager_dev_id: UUID) -> set[UUID]:
    """본인 + 후손(부하 chain depth 10 이내) developer.id 집합.

    weekly_reports.py 의 동명 헬퍼와 동일 패턴.
    """
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


def _is_admin_hr(user: User) -> bool:
    return user.role in ("SUPER_ADMIN", "ADMIN", "HR")


@router.get("/action-items", response_model=list[ActionItemOut])
async def list_action_items(
    scope: str = "me",
    include_done: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """액션 아이템 목록 — scope 분기.

    scope:
      - me   (default): 본인 mapped_developer_id 가 assignee.
      - team           : 직속 부하 chain (본인 제외) — 매니저용.
      - all            : 전체 — HR / ADMIN / SUPER_ADMIN 만.

    `/action-items/mine` 은 별칭으로 보존 (calendar / dashboard 위젯 호환).
    """
    if scope not in ("me", "team", "all"):
        raise HTTPException(status_code=400, detail="scope 는 me|team|all.")

    if scope == "all" and not _is_admin_hr(user):
        logger.warning(
            "액션 전체 조회 거부: role=%s user_id=%s", user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="HR/ADMIN 권한 필요.")

    from sqlalchemy.orm import aliased
    from sqlalchemy import func

    AC = aliased(Customer)
    NC = aliased(Customer)
    AP = aliased(Project)
    NP = aliased(Project)

    stmt = (
        select(
            MeetingNoteActionItem,
            MeetingNote.title.label("note_title"),
            func.coalesce(AC.name, NC.name).label("customer_name"),
            func.coalesce(AP.name, NP.name).label("project_name"),
        )
        .outerjoin(MeetingNote, MeetingNote.id == MeetingNoteActionItem.meeting_note_id)
        .outerjoin(AC, AC.id == MeetingNoteActionItem.customer_id)
        .outerjoin(NC, NC.id == MeetingNote.customer_id)
        .outerjoin(AP, AP.id == MeetingNoteActionItem.project_id)
        .outerjoin(NP, NP.id == MeetingNote.project_id)
    )

    if scope == "me":
        if not user.mapped_developer_id:
            return []
        stmt = stmt.where(MeetingNoteActionItem.assignee_id == user.mapped_developer_id)
    elif scope == "team":
        if not user.mapped_developer_id:
            return []
        chain = await _manager_chain_devs(db, user.mapped_developer_id)
        chain.discard(user.mapped_developer_id)
        if not chain:
            return []
        stmt = stmt.where(MeetingNoteActionItem.assignee_id.in_(chain))
    # scope == "all" — 별도 절 없음 (RLS 가 tenant 격리).

    if not include_done:
        stmt = stmt.where(
            MeetingNoteActionItem.status.in_(["TODO", "IN_PROGRESS"])
        )
    stmt = stmt.order_by(
        MeetingNoteActionItem.due_date.asc().nulls_last(),
        MeetingNoteActionItem.created_at.desc(),
    )
    rows = (await db.execute(stmt)).all()
    return [
        _action_item_out(
            it,
            note_title=note_title,
            customer_name=customer_name,
            project_name=project_name,
        )
        for (it, note_title, customer_name, project_name) in rows
    ]


@router.get("/action-items/mine", response_model=list[ActionItemOut])
async def list_my_action_items(
    include_done: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """별칭 — `/action-items?scope=me` 동치 (calendar / dashboard 호환)."""
    return await list_action_items(
        scope="me", include_done=include_done, db=db, user=user,
    )


@router.get("/action-items/done", response_model=ActionItemDonePage)
async def list_done_action_items(
    scope: str = "me",
    cursor_completed_at: datetime | None = None,
    cursor_id: UUID | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """완료(DONE) 액션 아이템 — cursor 페이지네이션.

    `(completed_at desc, id desc)` 정렬 기준 다음 페이지를 반환. `cursor_*` 양쪽
    모두 제공돼야 페이지 진행. 첫 페이지는 cursor 없이 호출.

    내 액션 화면의 "완료" 탭 전용 — 진행중 항목은 `/action-items?include_done=false`.
    """
    if scope not in ("me", "team", "all"):
        raise HTTPException(status_code=400, detail="scope 는 me|team|all.")
    if scope == "all" and not _is_admin_hr(user):
        logger.warning(
            "완료 액션 전체 조회 거부: role=%s user_id=%s", user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="HR/ADMIN 권한 필요.")
    # 1~200 clamp — 비정상 페이로드 차단 + 한 페이지 너무 크지 않게.
    limit = max(1, min(int(limit), 200))

    from sqlalchemy.orm import aliased
    from sqlalchemy import and_, func, or_

    AC = aliased(Customer)
    NC = aliased(Customer)
    AP = aliased(Project)
    NP = aliased(Project)

    stmt = (
        select(
            MeetingNoteActionItem,
            MeetingNote.title.label("note_title"),
            func.coalesce(AC.name, NC.name).label("customer_name"),
            func.coalesce(AP.name, NP.name).label("project_name"),
        )
        .outerjoin(MeetingNote, MeetingNote.id == MeetingNoteActionItem.meeting_note_id)
        .outerjoin(AC, AC.id == MeetingNoteActionItem.customer_id)
        .outerjoin(NC, NC.id == MeetingNote.customer_id)
        .outerjoin(AP, AP.id == MeetingNoteActionItem.project_id)
        .outerjoin(NP, NP.id == MeetingNote.project_id)
        .where(MeetingNoteActionItem.status == "DONE")
        # completed_at NULL 인 DONE row 는 정렬·cursor 가 불안정해 제외.
        # (정상 흐름에서 status=DONE 전이 시 completed_at 이 채워진다.)
        .where(MeetingNoteActionItem.completed_at.is_not(None))
    )

    if scope == "me":
        if not user.mapped_developer_id:
            return ActionItemDonePage(items=[], next_cursor=None)
        stmt = stmt.where(MeetingNoteActionItem.assignee_id == user.mapped_developer_id)
    elif scope == "team":
        if not user.mapped_developer_id:
            return ActionItemDonePage(items=[], next_cursor=None)
        chain = await _manager_chain_devs(db, user.mapped_developer_id)
        chain.discard(user.mapped_developer_id)
        if not chain:
            return ActionItemDonePage(items=[], next_cursor=None)
        stmt = stmt.where(MeetingNoteActionItem.assignee_id.in_(chain))
    # scope == "all" 은 RLS 가 tenant 격리.

    # cursor 양쪽 모두 제공돼야 page step. tuple comparison 의미:
    # (cAt, id) DESC 정렬에서 "이전 cursor 이하" → (cAt < c) OR (cAt = c AND id < c.id).
    if cursor_completed_at is not None and cursor_id is not None:
        stmt = stmt.where(
            or_(
                MeetingNoteActionItem.completed_at < cursor_completed_at,
                and_(
                    MeetingNoteActionItem.completed_at == cursor_completed_at,
                    MeetingNoteActionItem.id < cursor_id,
                ),
            )
        )

    stmt = stmt.order_by(
        MeetingNoteActionItem.completed_at.desc(),
        MeetingNoteActionItem.id.desc(),
    # has_more 판단 위해 limit+1 페치.
    ).limit(limit + 1)

    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    page_rows = rows[:limit]
    items_out = [
        _action_item_out(
            it,
            note_title=note_title,
            customer_name=customer_name,
            project_name=project_name,
        )
        for (it, note_title, customer_name, project_name) in page_rows
    ]

    next_cursor: ActionItemDoneCursor | None = None
    if has_more and page_rows:
        last_it = page_rows[-1][0]
        next_cursor = ActionItemDoneCursor(
            completed_at=last_it.completed_at, id=last_it.id,
        )
    return ActionItemDonePage(items=items_out, next_cursor=next_cursor)


# ---------------------------------------------------------------------------
# 회의록 단건 조회 (UUID note_id 매칭).
# ---------------------------------------------------------------------------


@router.get("/{note_id}", response_model=MeetingNoteOut)
async def get_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_read(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    # last_seen_at 갱신 (공유 받은 사람의 경우)
    if user.mapped_developer_id is not None:
        for s in note.shares:
            if s.developer_id == user.mapped_developer_id:
                s.last_seen_at = datetime.now(timezone.utc)
                break
        await db.commit()
    return await _detail(db, note, user)


@router.patch("/{note_id}", response_model=MeetingNoteOut)
async def update_note(
    note_id: UUID,
    payload: MeetingNoteUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _is_author(note, user):
        raise HTTPException(
            status_code=403, detail="작성자만 메타 정보를 수정할 수 있습니다."
        )

    if payload.title is not None:
        note.title = payload.title.strip()
    if payload.customer_id is not None or "customer_id" in payload.model_fields_set:
        note.customer_id = payload.customer_id
    if payload.project_id is not None or "project_id" in payload.model_fields_set:
        note.project_id = payload.project_id

    added_dev_ids: list[UUID] = []
    if payload.share_developer_ids is not None:
        new_ids = {
            d for d in payload.share_developer_ids if d != note.author_id
        }
        existing = {s.developer_id: s for s in note.shares}
        # 제거할 것
        for dev_id, share_row in list(existing.items()):
            if dev_id not in new_ids:
                await db.delete(share_row)
        # 새로 추가할 것
        for dev_id in new_ids:
            if dev_id not in existing:
                db.add(
                    MeetingNoteShare(
                        meeting_note_id=note.id, developer_id=dev_id
                    )
                )
                added_dev_ids.append(dev_id)
        await db.flush()
        await db.refresh(note, attribute_names=["shares"])

    if added_dev_ids:
        await _send_share_notifications(db, note, added_dev_ids)

    await db.commit()
    await db.refresh(
        note,
        attribute_names=["shares", "attachments", "author", "action_items"],
    )
    return await _detail(db, note, user)


@router.patch("/{note_id}/body", response_model=MeetingNoteOut)
async def update_body(
    note_id: UUID,
    payload: MeetingNoteBodyUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본문 autosave. 작성자 + 공유받은 사람 모두 가능."""
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    if "body" in payload.model_fields_set:
        note.body = payload.body
    if "plain_text" in payload.model_fields_set:
        note.plain_text = payload.plain_text
    note.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(
        note,
        attribute_names=["shares", "attachments", "author"],
    )
    return await _detail(db, note, user)


@router.patch("/{note_id}/mindmap", response_model=MeetingNoteOut)
async def update_mindmap(
    note_id: UUID,
    payload: MeetingNoteMindmapUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """마인드맵 autosave — 작성자 + 공유받은 사람 모두 편집 가능 (P3-Lite)."""
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    note.mindmap_data = payload.data
    note.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(
        note,
        attribute_names=["shares", "attachments", "author"],
    )
    return await _detail(db, note, user)


@router.patch("/{note_id}/drawio", response_model=MeetingNoteOut)
async def update_drawio(
    note_id: UUID,
    payload: MeetingNoteDrawioUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """drawio 다이어그램 autosave — 자체 호스팅 drawio iframe 의 native XML.

    권한·동시편집 정책은 마인드맵과 동일 (작성자 + 공유받은 사람 모두 편집).
    XML 검증은 안 함 — drawio 가 보낸 그대로 저장하고 다시 iframe 으로 주입.
    """
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        logger.warning(
            "회의록 drawio 편집 거부: note=%s role=%s user=%s",
            note_id, user.role, user.id,
        )
        raise HTTPException(status_code=403, detail="권한 없음")
    note.drawio_xml = payload.xml
    note.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(
        note,
        attribute_names=["shares", "attachments", "author"],
    )
    # XML 크기는 다이어그램 복잡도 지표 — 큰 값 (>1MB) 추적용 INFO.
    xml_len = len(payload.xml or "")
    logger.info(
        "회의록 drawio 저장: note=%s xml=%dB (요청자=%s)",
        note_id, xml_len, user.id,
    )
    return await _detail(db, note, user)


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _is_author(note, user):
        raise HTTPException(status_code=403, detail="작성자만 삭제할 수 있습니다.")
    # 첨부 디스크 정리
    for att in note.attachments:
        try:
            delete_file(att.file_path)
        except Exception:  # pragma: no cover
            pass
    await db.delete(note)
    await db.commit()


@router.post("/{note_id}/email", response_model=MeetingNoteEmailResult)
async def email_meeting_note(
    note_id: UUID,
    payload: MeetingNoteEmailRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """회의록을 정규직 직원에게 이메일 + Slack/Mattermost DM 으로 동시 발송.

    권한:
    - 작성자(_is_author) 또는 공유받은 사람(_is_shared) 모두 발송 가능.

    수신자:
    - payload.developer_ids 의 ACTIVE FULL_TIME 직원만 (다른 employment_type
      은 silent skip — UI 가 정규직만 노출하므로 사실상 미발생).
    - 이메일 없는 직원은 skipped 에 'no-email' 사유로 기록.

    동작:
    - 이메일: bleach 로 sanitize 한 body_html 을 메일 템플릿 HTML 에 삽입.
              제목 [회의록] {title}, sender = MailService 의 tenant 설정.
    - DM: 회의록 링크 + 본문 발췌 + custom_message 를 plain text 로 발송.
          회의록 신규 작성 알림과 동일한 notify_service.send_for_tenant 사용.
    - 이력은 기록하지 않음 (rate-limit 도 없음).
    """
    note = await _load_note(db, note_id)
    if not _can_read(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")

    if not payload.developer_ids:
        return MeetingNoteEmailResult(sent_count=0, notify_sent_count=0, skipped=[])

    # 정규직 + ACTIVE 직원만 — UI 가 이렇게만 노출하지만 서버에서도 한번 더 가드.
    rows = (
        await db.execute(
            select(
                Developer.id, Developer.name,
                Developer.personal_email, Developer.company_email,
                Developer.employment_type, Developer.status,
            ).where(Developer.id.in_(payload.developer_ids))
        )
    ).all()

    base_url = get_settings().server.public_url.rstrip("/")
    note_url = f"{base_url}/meeting-notes/{note.id}"

    # 메타 — 고객사 / 프로젝트 이름 lookup.
    customer_name: str | None = None
    project_name: str | None = None
    if note.customer_id:
        customer_name = (
            await db.execute(
                select(Customer.name).where(Customer.id == note.customer_id)
            )
        ).scalar_one_or_none()
    if note.project_id:
        project_name = (
            await db.execute(
                select(Project.name).where(Project.id == note.project_id)
            )
        ).scalar_one_or_none()

    author_name = note.author.name if note.author else "관리자"
    sender_name = (user.name or user.email) if hasattr(user, "name") else user.email
    created_at_iso = (
        note.created_at.strftime("%Y-%m-%d %H:%M") if note.created_at else ""
    )

    skipped: list[MeetingNoteEmailSkipped] = []
    valid_emails: list[str] = []
    valid_for_notify: list[tuple[UUID, str]] = []  # (id, email)
    for d_id, _name, p_email, c_email, etype, status_v in rows:
        if etype != "FULL_TIME" or status_v != "ACTIVE":
            skipped.append(MeetingNoteEmailSkipped(
                developer_id=d_id, reason="no-email"
            ))
            continue
        email = p_email or c_email
        if not email:
            skipped.append(MeetingNoteEmailSkipped(
                developer_id=d_id, reason="no-email"
            ))
            continue
        valid_emails.append(email)
        valid_for_notify.append((d_id, email))

    # 1) Email — 한 번에 다중 To 로 발송.
    sent_count = 0
    if valid_emails:
        try:
            ok = await send_meeting_note_email(
                tenant_id=note.tenant_id,
                title=note.title,
                sender_name=sender_name,
                author_name=author_name,
                customer_name=customer_name,
                project_name=project_name,
                created_at_iso=created_at_iso,
                note_url=note_url,
                custom_message=payload.custom_message,
                body_html_raw=payload.body_html,
                recipient_emails=valid_emails,
            )
            sent_count = len(valid_emails) if ok else 0
            if not ok:
                # mail_service 가 미설정/실패 시 False — 스킵 사유 기록.
                for d_id, _e in valid_for_notify:
                    skipped.append(MeetingNoteEmailSkipped(
                        developer_id=d_id, reason="send-failed"
                    ))
                logger.warning(
                    "회의록 이메일 발송 실패: note=%s recipients=%d",
                    note.id, len(valid_emails),
                )
        except Exception as exc:  # pragma: no cover
            sent_count = 0
            for d_id, _e in valid_for_notify:
                skipped.append(MeetingNoteEmailSkipped(
                    developer_id=d_id, reason="send-failed"
                ))
            logger.warning(
                "회의록 이메일 발송 예외: note=%s err=%s",
                note.id, exc, exc_info=True,
            )

    # 2) DM (Slack/Mattermost) — notify_service 가 user_emails 를 user_id 로
    #    매핑. 이메일 발송 결과와 무관하게 시도 (DM 만 받는 케이스 허용).
    notify_text = build_notify_text(
        title=note.title,
        sender_name=sender_name,
        author_name=author_name,
        customer_name=customer_name,
        project_name=project_name,
        created_at_iso=created_at_iso,
        note_url=note_url,
        body_plain=note.plain_text or "",
        custom_message=payload.custom_message,
    )
    notify_sent_count = 0
    for d_id, email in valid_for_notify:
        try:
            ok = await notify_service.send_for_tenant(
                note.tenant_id, notify_text, user_emails=[email],
                feature="meeting_note",
            )
            if ok:
                notify_sent_count += 1
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "회의록 DM 발송 실패 note=%s dev=%s: %s",
                note.id, d_id, exc, exc_info=True,
            )

    logger.info(
        "회의록 이메일 발송 완료: note=%s sent=%d notify_sent=%d skipped=%d",
        note.id, sent_count, notify_sent_count, len(skipped),
    )
    return MeetingNoteEmailResult(
        sent_count=sent_count,
        notify_sent_count=notify_sent_count,
        skipped=skipped,
    )


@router.post("/{note_id}/notify", response_model=MeetingNoteOut)
async def renotify(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """공유 직원 전체에 알림 재발송 (idempotent)."""
    note = await _load_note(db, note_id)
    if not _is_author(note, user):
        raise HTTPException(status_code=403, detail="작성자만 재발송 가능")
    dev_ids = [s.developer_id for s in note.shares]
    await _send_share_notifications(db, note, dev_ids)
    await db.commit()
    await db.refresh(note, attribute_names=["shares", "attachments", "author", "action_items"])
    return await _detail(db, note, user)


# ---------------------------------------------------------------------------
# 첨부 (multi-upload, rename, delete, download)
# ---------------------------------------------------------------------------


@router.post(
    "/{note_id}/attachments",
    response_model=list[AttachmentOut],
    status_code=201,
)
async def upload_attachments(
    note_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    out: list[MeetingNoteAttachment] = []
    for f in files:
        stored, size = await save_upload(f, f"meeting-notes/{note_id}")
        att = MeetingNoteAttachment(
            meeting_note_id=note_id,
            file_name=f.filename or "upload.bin",
            file_path=stored,
            mime_type=f.content_type,
            size=size,
            uploaded_by=user.mapped_developer_id,
        )
        db.add(att)
        out.append(att)
    await db.commit()
    for a in out:
        await db.refresh(a)
    # uploader 이름 lookup
    names: dict[UUID, str] = {}
    if any(a.uploaded_by for a in out):
        rows = (
            await db.execute(
                select(Developer.id, Developer.name).where(
                    Developer.id.in_([a.uploaded_by for a in out if a.uploaded_by])
                )
            )
        ).all()
        names = {r[0]: r[1] for r in rows}
    return [
        AttachmentOut(
            id=a.id,
            file_name=a.file_name,
            mime_type=a.mime_type,
            size=a.size,
            uploaded_by=a.uploaded_by,
            uploaded_by_name=names.get(a.uploaded_by) if a.uploaded_by else None,
            created_at=a.created_at,
        )
        for a in out
    ]


@router.patch(
    "/{note_id}/attachments/{att_id}",
    response_model=AttachmentOut,
)
async def rename_attachment(
    note_id: UUID,
    att_id: UUID,
    payload: AttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    att = next((a for a in note.attachments if a.id == att_id), None)
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    att.file_name = payload.file_name.strip()
    await db.commit()
    await db.refresh(att)
    name = None
    if att.uploaded_by:
        row = (
            await db.execute(
                select(Developer.name).where(Developer.id == att.uploaded_by)
            )
        ).scalar_one_or_none()
        name = row
    return AttachmentOut(
        id=att.id,
        file_name=att.file_name,
        mime_type=att.mime_type,
        size=att.size,
        uploaded_by=att.uploaded_by,
        uploaded_by_name=name,
        created_at=att.created_at,
    )


@router.delete(
    "/{note_id}/attachments/{att_id}",
    status_code=204,
)
async def delete_attachment(
    note_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    att = next((a for a in note.attachments if a.id == att_id), None)
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    try:
        delete_file(att.file_path)
    except Exception:  # pragma: no cover
        pass
    await db.delete(att)
    await db.commit()


@router.get("/{note_id}/attachments/{att_id}/download")
async def download_attachment(
    note_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_read(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    att = next((a for a in note.attachments if a.id == att_id), None)
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 존재하지 않습니다.")
    return FileResponse(
        path=str(abs_path),
        filename=att.file_name,
        media_type=att.mime_type or "application/octet-stream",
    )


# ---------------------------------------------------------------------------
# 액션 아이템 (TODO)
# ---------------------------------------------------------------------------


# 액션 list endpoints 는 위쪽으로 이동 — `/action-items` 가 `/{note_id}` 보다
# 먼저 선언되어야 FastAPI 가 literal path 를 우선 매칭 (그렇지 않으면
# 'action-items' 가 note_id UUID 로 해석되어 422).


@router.post(
    "/{note_id}/action-items",
    response_model=ActionItemOut,
    status_code=201,
)
async def create_action_item(
    note_id: UUID,
    payload: ActionItemCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    # assignee_name 미입력 + assignee_id 있으면 Developer.name 으로 채움
    # (async lazy-load 회피 — DB 에 항상 표시 가능한 이름이 들어가도록)
    name = (payload.assignee_name or "").strip() or None
    if payload.assignee_id and not name:
        dev = await db.get(Developer, payload.assignee_id)
        if dev:
            name = dev.name
    item = MeetingNoteActionItem(
        meeting_note_id=note_id,
        title=payload.title.strip(),
        assignee_id=payload.assignee_id,
        assignee_name=name,
        due_date=payload.due_date,
        status=payload.status,
        note_text=payload.note_text,
        completion_comment=payload.completion_comment,
        sort_order=payload.sort_order,
        completed_at=datetime.now(timezone.utc) if payload.status == "DONE" else None,
        customer_id=payload.customer_id,
        project_id=payload.project_id,
    )
    db.add(item)
    await db.commit()
    logger.info(
        "회의록 액션 아이템 추가: id=%s note=%s title=%s assignee=%s (등록자=%s)",
        item.id, note_id, item.title, item.assignee_id, user.id,
    )
    return _action_item_out(item)


async def _load_action_item_or_404(
    db: AsyncSession, item_id: UUID
) -> MeetingNoteActionItem:
    it = (
        await db.execute(
            select(MeetingNoteActionItem).where(
                MeetingNoteActionItem.id == item_id
            )
        )
    ).scalar_one_or_none()
    if not it:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    return it


async def _can_edit_action_item(
    db: AsyncSession, it: MeetingNoteActionItem, user: User
) -> bool:
    """액션 권한.

    - 회의록 attached: 회의록 _can_edit_body (작성자 + 공유자) 또는 본인 담당.
    - standalone: 본인 (assignee_id == mapped_developer_id) 만.
    """
    if it.meeting_note_id is None:
        return (
            user.mapped_developer_id is not None
            and it.assignee_id == user.mapped_developer_id
        )
    note = await _load_note(db, it.meeting_note_id)
    if _can_edit_body(note, user):
        return True
    if (
        user.mapped_developer_id
        and it.assignee_id == user.mapped_developer_id
    ):
        return True
    return False


@router.patch("/action-items/{item_id}", response_model=ActionItemOut)
async def update_action_item_unified(
    item_id: UUID,
    payload: ActionItemUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """note_id 무관 액션 수정 — standalone 액션 + 회의록 attached 액션 모두."""
    item = await _load_action_item_or_404(db, item_id)
    if not await _can_edit_action_item(db, item, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        if k == "title" and v:
            v = v.strip()
        if k == "assignee_name":
            v = (v or "").strip() or None
        setattr(item, k, v)
    if "assignee_id" in data and item.assignee_id and not item.assignee_name:
        dev = await db.get(Developer, item.assignee_id)
        if dev:
            item.assignee_name = dev.name
    if "status" in data:
        if data["status"] == "DONE" and item.completed_at is None:
            item.completed_at = datetime.now(timezone.utc)
        elif data["status"] != "DONE":
            item.completed_at = None
    await db.commit()
    logger.info(
        "액션 수정: id=%s fields=%s (요청자=%s)",
        item.id, list(data.keys()), user.id,
    )
    # customer/project 이름 lookup.
    cname = pname = None
    if item.customer_id:
        cname = (await db.execute(
            select(Customer.name).where(Customer.id == item.customer_id)
        )).scalar_one_or_none()
    if item.project_id:
        pname = (await db.execute(
            select(Project.name).where(Project.id == item.project_id)
        )).scalar_one_or_none()
    return _action_item_out(item, customer_name=cname, project_name=pname)


@router.delete("/action-items/{item_id}", status_code=204)
async def delete_action_item_unified(
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """note_id 무관 액션 삭제 — standalone 액션 + 회의록 attached 액션 모두."""
    item = await _load_action_item_or_404(db, item_id)
    if not await _can_edit_action_item(db, item, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    await db.delete(item)
    await db.commit()
    logger.info("액션 삭제: id=%s (요청자=%s)", item_id, user.id)


@router.post(
    "/action-items",
    response_model=ActionItemOut,
    status_code=201,
)
async def create_standalone_action_item(
    payload: StandaloneActionItemCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """sidebar > 내 액션 의 '+ 액션 추가' — 회의록 없이 본인 명의 액션 추가.

    - 담당자 = 호출자 본인 (mapped_developer_id 있어야 함).
    - 회의록과 무관 (meeting_note_id = NULL).
    - 고객사 / 프로젝트는 옵션 (다이얼로그 picker).
    - 본인이 본인 owner 로만 생성 — HR/ADMIN 도 다른 사람 명의 X.
    """
    if not user.mapped_developer_id:
        raise HTTPException(
            status_code=400,
            detail="본인 직원 매핑이 없어 액션 추가가 불가합니다.",
        )
    dev = await db.get(Developer, user.mapped_developer_id)
    if not dev:
        raise HTTPException(status_code=400, detail="직원 정보를 찾을 수 없습니다.")

    # 회의록 첨부 옵션 — 접근 권한이 있는 회의록인지 확인.
    if payload.meeting_note_id:
        try:
            note = await _load_note(db, payload.meeting_note_id)
        except HTTPException:
            raise HTTPException(status_code=404, detail="회의록을 찾을 수 없습니다.")
        if not _can_read(note, user):
            raise HTTPException(
                status_code=403,
                detail="해당 회의록에 접근 권한이 없습니다.",
            )

    item = MeetingNoteActionItem(
        meeting_note_id=payload.meeting_note_id,
        title=payload.title.strip(),
        assignee_id=user.mapped_developer_id,
        assignee_name=dev.name,
        due_date=payload.due_date,
        status="TODO",
        note_text=payload.note_text,
        sort_order=0,
        customer_id=payload.customer_id,
        project_id=payload.project_id,
    )
    db.add(item)
    await db.commit()
    logger.info(
        "내 액션 standalone 추가: id=%s title=%s owner=%s customer=%s project=%s",
        item.id, item.title, dev.name, payload.customer_id, payload.project_id,
    )
    # customer/project 이름 lookup — 응답 한 번에.
    cname = pname = None
    if item.customer_id:
        cname = (await db.execute(
            select(Customer.name).where(Customer.id == item.customer_id)
        )).scalar_one_or_none()
    if item.project_id:
        pname = (await db.execute(
            select(Project.name).where(Project.id == item.project_id)
        )).scalar_one_or_none()
    return _action_item_out(item, customer_name=cname, project_name=pname)


@router.patch(
    "/{note_id}/action-items/{item_id}",
    response_model=ActionItemOut,
)
async def update_action_item(
    note_id: UUID,
    item_id: UUID,
    payload: ActionItemUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        # 본인이 담당자면 자기 항목 status·진행도 갱신은 허용
        item_check = next(
            (it for it in note.action_items if it.id == item_id), None
        )
        if not (
            item_check
            and user.mapped_developer_id
            and item_check.assignee_id == user.mapped_developer_id
        ):
            raise HTTPException(status_code=403, detail="권한 없음")
    item = (
        await db.execute(
            select(MeetingNoteActionItem).where(
                MeetingNoteActionItem.id == item_id,
                MeetingNoteActionItem.meeting_note_id == note_id,
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        if k == "title" and v:
            v = v.strip()
        if k == "assignee_name":
            v = (v or "").strip() or None
        setattr(item, k, v)
    # assignee 가 바뀌었는데 assignee_name 미지정 → Developer.name 으로 채움
    if (
        "assignee_id" in data
        and item.assignee_id
        and not item.assignee_name
    ):
        dev = await db.get(Developer, item.assignee_id)
        if dev:
            item.assignee_name = dev.name
    # status DONE 전이 시 completed_at 자동 채움 (이미 있으면 유지)
    if "status" in data:
        if data["status"] == "DONE" and item.completed_at is None:
            item.completed_at = datetime.now(timezone.utc)
        elif data["status"] != "DONE":
            item.completed_at = None
    await db.commit()
    logger.info(
        "회의록 액션 아이템 수정: id=%s fields=%s (요청자=%s)",
        item.id, list(data.keys()), user.id,
    )
    return _action_item_out(item)


@router.delete(
    "/{note_id}/action-items/{item_id}", status_code=204
)
async def delete_action_item(
    note_id: UUID,
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await _load_note(db, note_id)
    if not _can_edit_body(note, user):
        raise HTTPException(status_code=403, detail="권한 없음")
    item = (
        await db.execute(
            select(MeetingNoteActionItem).where(
                MeetingNoteActionItem.id == item_id,
                MeetingNoteActionItem.meeting_note_id == note_id,
            )
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    await db.delete(item)
    await db.commit()
    logger.warning(
        "회의록 액션 아이템 삭제: id=%s note=%s (요청자=%s)",
        item_id, note_id, user.id,
    )


# ---------------------------------------------------------------------------
# 상세 응답 빌더 (이름 lookup 포함)
# ---------------------------------------------------------------------------


async def _detail(
    db: AsyncSession, note: MeetingNote, user: User
) -> MeetingNoteOut:
    customers, projects, devs, users = await _name_lookups(db, [note])
    share_dev_ids = [s.developer_id for s in note.shares]
    att_dev_ids = [a.uploaded_by for a in note.attachments if a.uploaded_by]
    extra_ids = list({*share_dev_ids, *att_dev_ids} - set(devs.keys()))
    if extra_ids:
        rows = (
            await db.execute(
                select(Developer.id, Developer.name).where(Developer.id.in_(extra_ids))
            )
        ).all()
        for r in rows:
            devs[r[0]] = r[1]
    can_edit = _is_author(note, user)
    return _detail_out(
        note,
        can_edit=can_edit,
        customers=customers,
        projects=projects,
        devs=devs,
        users=users,
        share_dev_names={
            s.developer_id: devs.get(s.developer_id, "") for s in note.shares
        },
        att_uploader_names={
            a.uploaded_by: devs.get(a.uploaded_by, "")
            for a in note.attachments
            if a.uploaded_by
        },
    )
