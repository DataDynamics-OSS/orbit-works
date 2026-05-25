"""결재 양식(ApprovalTemplate) CRUD — Settings 의 admin UI 용.

조회는 인증된 사용자 모두 (신청 화면에서 종류 선택), 변경은 HR/ADMIN.
form_schema / approval_rules JSON 변경 시 version 자동 +1.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import ApprovalTemplate, User
from app.schemas.approval import (
    ApprovalTemplateCreate,
    ApprovalTemplateOut,
    ApprovalTemplateUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/approval-templates", tags=["approval-templates"])

_SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "approval_templates_seed.json"


def _require_admin_or_hr(user: User) -> None:
    if user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="HR/ADMIN 만 가능합니다.")


@router.get("", response_model=list[ApprovalTemplateOut])
async def list_templates(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(ApprovalTemplate).order_by(ApprovalTemplate.kind)
    if not include_inactive:
        stmt = stmt.where(ApprovalTemplate.is_active.is_(True))
    return (await db.execute(stmt)).scalars().all()


@router.get("/{template_id}", response_model=ApprovalTemplateOut)
async def get_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = (
        await db.execute(select(ApprovalTemplate).where(ApprovalTemplate.id == template_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="결재 양식을 찾을 수 없습니다.")
    return row


@router.post("", response_model=ApprovalTemplateOut, status_code=201)
async def create_template(
    payload: ApprovalTemplateCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = ApprovalTemplate(**payload.model_dump(), version=1)
    db.add(row)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    logger.info("결재 양식 생성: %s (%s)", row.kind, row.id)
    return row


@router.patch("/{template_id}", response_model=ApprovalTemplateOut)
async def update_template(
    template_id: UUID,
    payload: ApprovalTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (
        await db.execute(select(ApprovalTemplate).where(ApprovalTemplate.id == template_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="결재 양식을 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    # form_schema 또는 approval_rules 변경 시 version 자동 +1.
    schema_changed = "form_schema" in data or "approval_rules" in data
    for k, v in data.items():
        setattr(row, k, v)
    if schema_changed:
        row.version = (row.version or 1) + 1
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=f"저장 실패: {exc}")
    await db.refresh(row)
    logger.info(
        "결재 양식 수정: %s version=%s (필드=%s)",
        row.kind, row.version, list(data.keys()),
    )
    return row


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin_or_hr(user)
    row = (
        await db.execute(select(ApprovalTemplate).where(ApprovalTemplate.id == template_id))
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="결재 양식을 찾을 수 없습니다.")
    # 사용 중인지 확인 — request 가 참조하면 삭제 금지.
    from app.models import ApprovalRequest

    in_use = (
        await db.execute(
            select(ApprovalRequest).where(ApprovalRequest.template_id == template_id).limit(1)
        )
    ).scalar_one_or_none()
    if in_use:
        raise HTTPException(
            status_code=400,
            detail="이미 결재 요청에 사용 중인 양식은 삭제할 수 없습니다 (비활성 권장).",
        )
    await db.delete(row)
    await db.commit()
    logger.warning("결재 양식 삭제: %s (%s)", row.kind, template_id)


@router.post("/seed", response_model=dict)
async def reseed_templates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """시드 JSON 파일 기준으로 누락 양식만 INSERT (멱등). 기존 양식은 변경 X.

    HR/ADMIN. 운영자가 신규 결재 종류 추가 후 한 번만 누름.
    """
    _require_admin_or_hr(user)
    if not _SEED_PATH.exists():
        raise HTTPException(status_code=500, detail="시드 파일이 없습니다.")
    try:
        templates = json.loads(_SEED_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"시드 파일 파싱 실패: {exc}")
    if not isinstance(templates, list):
        raise HTTPException(status_code=500, detail="시드 파일 형식 오류.")

    existing_kinds = {
        r[0]
        for r in (
            await db.execute(select(ApprovalTemplate.kind))
        ).all()
    }
    inserted = 0
    for t in templates:
        if t.get("kind") in existing_kinds:
            continue
        db.add(
            ApprovalTemplate(
                kind=t["kind"],
                name=t["name"],
                icon=t.get("icon"),
                form_schema=t.get("form_schema") or {},
                ui_schema=t.get("ui_schema"),
                approval_rules=t.get("approval_rules") or {},
                version=1,
                is_active=t.get("default_active", True),
                description=t.get("description"),
            )
        )
        inserted += 1
    await db.commit()
    logger.info("결재 양식 시드: 신규 %d건 추가됨", inserted)
    return {"inserted": inserted, "total_in_seed": len(templates)}
