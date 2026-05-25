"""직위(JobRank) + 직책(JobPosition) 스키마."""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field


class _GradeBase(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    level: Decimal = Field(ge=0, le=Decimal("9999.99"))
    description: str | None = None
    is_active: bool = True
    sort_order: int = 0
    # 진급 기준 연차 — 「직위별 총 경력 분포」 차트의 가이드 라인 (rank 한정).
    # NULL = 차트에 라인 표시 안 함. JobPosition 엔 컬럼만 보유 (현재 차트
    # 미사용).
    years: int | None = Field(default=None, gt=0, le=99)


class _GradeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=50)
    level: Decimal | None = Field(default=None, ge=0, le=Decimal("9999.99"))
    description: str | None = None
    is_active: bool | None = None
    sort_order: int | None = None
    years: int | None = Field(default=None, gt=0, le=99)  # NULL 로 보내야 clear


class _GradeOut(_GradeBase):
    id: UUID
    created_at: datetime

    class Config:
        from_attributes = True


# 두 모델 같은 shape — 별칭으로 export.
class JobRankCreate(_GradeBase):
    pass


class JobRankUpdate(_GradeUpdate):
    pass


class JobRankOut(_GradeOut):
    pass


class JobPositionCreate(_GradeBase):
    pass


class JobPositionUpdate(_GradeUpdate):
    pass


class JobPositionOut(_GradeOut):
    pass
