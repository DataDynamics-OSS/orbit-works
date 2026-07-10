"""ServerHosting — Pydantic schemas (list / create / update / out)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# 호스팅 유형 화이트리스트 — models.SERVER_HOSTING_TYPES 와 동기화.
HostingType = Literal["DEDICATED", "VPS", "CLOUD", "COLOCATION"]


class ServerHostingBase(BaseModel):
    ip: str = Field(..., min_length=1, max_length=45)
    cpu_cores: int | None = Field(default=None, ge=0)
    ram_gb: int | None = Field(default=None, ge=0)
    disk_gb: int | None = Field(default=None, ge=0)
    os: str | None = Field(default=None, max_length=120)
    purpose: str | None = None
    vendor: str | None = Field(default=None, max_length=200)
    start_date: date | None = None
    end_date: date | None = None
    monthly_cost: Decimal | None = None
    hosting_type: HostingType | None = None
    expiry_alarm: bool = True
    memo: str | None = None


class ServerHostingCreate(ServerHostingBase):
    pass


class ServerHostingUpdate(BaseModel):
    """모든 필드 nullable — 미지정 키는 변경 없음."""

    ip: str | None = Field(default=None, min_length=1, max_length=45)
    cpu_cores: int | None = Field(default=None, ge=0)
    ram_gb: int | None = Field(default=None, ge=0)
    disk_gb: int | None = Field(default=None, ge=0)
    os: str | None = Field(default=None, max_length=120)
    purpose: str | None = None
    vendor: str | None = Field(default=None, max_length=200)
    start_date: date | None = None
    end_date: date | None = None
    monthly_cost: Decimal | None = None
    hosting_type: HostingType | None = None
    expiry_alarm: bool | None = None
    memo: str | None = None


class ServerHostingOut(ServerHostingBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
