from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class DeveloperInterviewIn(BaseModel):
    """면담 추가 / 수정 입력. body 는 마크다운."""

    body: str


class DeveloperInterviewOut(BaseModel):
    id: UUID
    developer_id: UUID
    author_user_id: UUID | None
    author_name: str | None = None  # API 가 user.name join 으로 채움
    body: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
