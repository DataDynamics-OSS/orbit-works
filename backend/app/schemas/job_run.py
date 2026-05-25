"""JobRun Pydantic 스키마."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


JobStatus = Literal["RUNNING", "SUCCESS", "FAILED", "SKIPPED"]
TriggeredBy = Literal["SCHEDULER", "MANUAL", "API"]


class JobRunOut(BaseModel):
    id: UUID
    job_name: str
    job_kind: str
    status: JobStatus
    started_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None
    triggered_by: TriggeredBy
    triggered_by_user_id: UUID | None = None
    triggered_by_user_name: str | None = None  # JOIN derived
    result_summary: str | None = None
    error_message: str | None = None
    extra: dict[str, Any] | None = None

    model_config = ConfigDict(from_attributes=True)
