"""Pydantic 스키마 — 회의록 (MeetingNote)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ActionItemStatus = Literal["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]


# ---------------------------------------------------------------------------
# share / attachment
# ---------------------------------------------------------------------------


class ShareOut(BaseModel):
    developer_id: UUID
    developer_name: str | None = None
    notified_at: datetime | None = None
    last_seen_at: datetime | None = None

    class Config:
        from_attributes = True


class AttachmentOut(BaseModel):
    id: UUID
    file_name: str
    mime_type: str | None = None
    size: int | None = None
    uploaded_by: UUID | None = None
    uploaded_by_name: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# 본체
# ---------------------------------------------------------------------------


class MeetingNoteBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    customer_id: UUID | None = None
    project_id: UUID | None = None


class MeetingNoteCreate(MeetingNoteBase):
    # 신규 작성 시 공유받을 직원(=정규직) developer.id 목록.
    share_developer_ids: list[UUID] = Field(default_factory=list)


class MeetingNoteUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    customer_id: UUID | None = None
    project_id: UUID | None = None
    # 명시적으로 None 으로 설정하면 share 변경 없음.
    # 빈 리스트(`[]`) 는 share 전체 제거. 비-None 리스트는 그 값으로 치환.
    share_developer_ids: list[UUID] | None = None


class MeetingNoteBodyUpdate(BaseModel):
    """본문 autosave 전용 — 5초 디바운스로 별도 호출."""

    body: str | None = None         # BlockNote JSON 직렬화
    plain_text: str | None = None   # 검색용 평문


class MeetingNoteMindmapUpdate(BaseModel):
    """마인드맵 autosave — reactflow nodes/edges 전체."""

    data: dict | None = None        # {"nodes": [...], "edges": [...]} 또는 None(=clear)


class MeetingNoteDrawioUpdate(BaseModel):
    """drawio autosave — 자체 호스팅 iframe 이 postMessage 로 보낸 native XML.

    payload size cap = 10MB (TOAST 자동 압축, 1MB 넘는 다이어그램은 첨부로
    분리 권장 안내).
    """

    xml: str | None = Field(default=None, max_length=10_000_000)


class MeetingNoteEmailRequest(BaseModel):
    """이메일 발송 요청.

    - developer_ids: 정규직 직원 ID 목록 — 이메일 + DM 동시 발송.
    - body_html: 클라이언트 측 BlockNote 가 export 한 본문 HTML.
                 서버에서 bleach 로 sanitize 후 메일 본문에 삽입.
    - custom_message: 발신자가 보내는 추가 메시지 (선택).
    """

    developer_ids: list[UUID]
    body_html: str = ""
    custom_message: str | None = None


class MeetingNoteEmailSkipped(BaseModel):
    developer_id: UUID
    reason: str  # "no-email" | "send-failed"


class MeetingNoteEmailResult(BaseModel):
    sent_count: int
    notify_sent_count: int
    skipped: list[MeetingNoteEmailSkipped]


class MeetingNoteRowOut(BaseModel):
    """그리드 행 — 본문은 보내지 않고 메타만."""

    id: UUID
    title: str
    customer_id: UUID | None = None
    customer_name: str | None = None
    project_id: UUID | None = None
    project_name: str | None = None
    author_id: UUID | None = None
    author_name: str | None = None
    share_count: int = 0
    attachment_count: int = 0
    action_count: int = 0   # 액션 아이템 (TODO) 총 개수
    has_mindmap: bool = False
    has_drawio: bool = False     # drawio_xml 이 비어있지 않을 때 true (탭 ● 인디케이터)
    can_edit: bool = False
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ActionItemBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    assignee_id: UUID | None = None
    assignee_name: str | None = Field(None, max_length=120)
    due_date: date | None = None
    status: ActionItemStatus = "TODO"
    note_text: str | None = None
    completion_comment: str | None = None
    sort_order: int = 0
    # 옵션 — 액션을 특정 고객사·프로젝트와 직접 연결. standalone 액션 입력 시
    # 다이얼로그의 picker 두 개. 회의록 attached 액션도 override 가능.
    customer_id: UUID | None = None
    project_id: UUID | None = None


class ActionItemCreate(ActionItemBase):
    pass


class StandaloneActionItemCreate(BaseModel):
    """내 액션 페이지의 '+ 액션 추가' — 본인 명의 액션 직접 생성.

    담당자 = 호출자 본인으로 서버가 강제. meeting_note_id 가 있으면 그
    회의록에 attach (서버가 접근 권한 검사). 없으면 standalone.
    """

    title: str = Field(..., min_length=1, max_length=500)
    note_text: str | None = None
    due_date: date | None = None
    customer_id: UUID | None = None
    project_id: UUID | None = None
    # 옵션 — 본인이 접근 가능한 회의록(작성/공유)에 attach.
    meeting_note_id: UUID | None = None


class ActionItemUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=500)
    assignee_id: UUID | None = None
    assignee_name: str | None = Field(None, max_length=120)
    due_date: date | None = None
    status: ActionItemStatus | None = None
    note_text: str | None = None
    completion_comment: str | None = None
    sort_order: int | None = None
    customer_id: UUID | None = None
    project_id: UUID | None = None


class ActionItemOut(ActionItemBase):
    id: UUID
    # standalone 액션은 None — 회의록 없이 본인이 직접 추가한 항목.
    meeting_note_id: UUID | None = None
    completed_at: datetime | None = None
    note_title: str | None = None  # 출처 회의록 제목 (standalone 이면 None)
    customer_name: str | None = None    # 출력 derived
    project_name: str | None = None     # 출력 derived
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# 완료(DONE) 액션 목록의 cursor 페이지네이션 응답.
# (completed_at desc, id desc) 정렬 기준 마지막 row 이후가 next page.
class ActionItemDoneCursor(BaseModel):
    completed_at: datetime
    id: UUID


class ActionItemDonePage(BaseModel):
    items: list[ActionItemOut]
    next_cursor: ActionItemDoneCursor | None = None


class MeetingNoteOut(MeetingNoteRowOut):
    """상세 — 본문 + 마인드맵 + 액션 아이템 포함."""

    body: str | None = None
    mindmap_data: dict | None = None
    drawio_xml: str | None = None    # drawio iframe 의 native XML (mxfile)
    shares: list[ShareOut] = Field(default_factory=list)
    attachments: list[AttachmentOut] = Field(default_factory=list)
    action_items: list[ActionItemOut] = Field(default_factory=list)


class AttachmentRename(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=300)
