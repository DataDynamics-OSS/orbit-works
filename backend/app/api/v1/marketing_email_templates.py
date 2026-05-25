"""마케팅 이메일 템플릿 — 캠페인이 참조.

세 가지 입력 방식 (body_kind):
- HTML   : textarea 에 HTML 직접 입력.
- EDITOR : BlockNote 에디터(회의록 패턴). 프론트가 blocks → HTML 변환 후
           body_html 저장 + 원본 blocks 를 body_json 에 보존. 본문 내 이미지는
           별도 자산(`MarketingEmailTemplateAsset`) 으로 업로드되고 본문에는
           `<img src="cid:{content_id}">` 로 들어감 — 발송 시 multipart/related
           로 인라인 임베드.
- IMPORT : 외부 URL 의 HTML 을 fetch → sanitize → 절대 URL 화 → premailer
           인라인. 결과 HTML 만 body_html 에 저장.

Endpoints:
  GET/POST/PATCH/DELETE  /marketing/email-templates[/{id}]   템플릿 CRUD
  POST                   /marketing/email-templates/{id}/test-send       테스트 메일 발송 (수신자 1~N)
  GET                    /marketing/email-templates/{id}/assets         자산 목록
  POST                   /marketing/email-templates/{id}/assets         이미지 업로드 (cid 반환)
  DELETE                 /marketing/email-templates/{id}/assets/{aid}   자산 삭제
  GET                    /marketing/email-templates/{id}/assets/{aid}/preview
                                                                        cid 인라인 미리보기
  POST                   /marketing/email-templates/import-url          URL → 정리된 HTML

Logging:
- INFO    : CRUD 변경, asset 추가/삭제, URL import 성공, 테스트 발송.
- WARNING : 템플릿 삭제, URL import 실패/sanitize 후 빈 본문, 디스크 정리 실패, 테스트 발송 실패.
"""

from __future__ import annotations

import logging
import re
import uuid as uuid_pkg
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import MarketingEmailTemplate, MarketingEmailTemplateAsset, User
from app.schemas.marketing import (
    EmailImportUrlIn,
    EmailImportUrlOut,
    EmailTemplateAssetOut,
    EmailTemplateCreate,
    EmailTemplateOut,
    EmailTemplateUpdate,
)
from app.services.email_html_import import import_url_html, inline_for_email
from app.services.mail import mail_service
from app.services.marketing import _collect_inline_images
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/marketing/email-templates", tags=["marketing-email-templates"]
)


async def _get_or_404(db: AsyncSession, template_id: UUID) -> MarketingEmailTemplate:
    tpl = (
        await db.execute(
            select(MarketingEmailTemplate)
            .options(selectinload(MarketingEmailTemplate.assets))
            .where(MarketingEmailTemplate.id == template_id)
        )
    ).scalar_one_or_none()
    if not tpl:
        raise HTTPException(404, "템플릿을 찾을 수 없습니다.")
    return tpl


@router.get("", response_model=list[EmailTemplateOut])
async def list_templates(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = list(
        (
            await db.execute(
                select(MarketingEmailTemplate)
                .options(selectinload(MarketingEmailTemplate.assets))
                .order_by(MarketingEmailTemplate.updated_at.desc())
            )
        ).scalars()
    )
    return rows


@router.post("", response_model=EmailTemplateOut, status_code=status.HTTP_201_CREATED)
async def create_template(
    payload: EmailTemplateCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # EDITOR 모드는 BlockNote 가 class 기반 minimal HTML 을 내보내 메일 클라이언트에서
    # 그대로 보면 typography 가 깨진다. 저장 시점에 기본 CSS 를 inline 처리.
    body_html = payload.body_html or ""
    if payload.body_kind == "EDITOR" and body_html.strip():
        body_html = inline_for_email(body_html)
    tpl = MarketingEmailTemplate(
        name=payload.name,
        subject=payload.subject,
        body_kind=payload.body_kind,
        body_html=body_html,
        body_json=payload.body_json,
        body_text=payload.body_text or "",
        description=payload.description,
        created_by=user.id,
    )
    db.add(tpl)
    await db.commit()
    tpl = await _get_or_404(db, tpl.id)
    logger.info(
        "이메일 템플릿 등록: id=%s name=%s kind=%s (등록자=%s)",
        tpl.id, tpl.name, tpl.body_kind, user.id,
    )
    return tpl


@router.get("/{template_id}", response_model=EmailTemplateOut)
async def get_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return await _get_or_404(db, template_id)


@router.patch("/{template_id}", response_model=EmailTemplateOut)
async def update_template(
    template_id: UUID,
    payload: EmailTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tpl = await _get_or_404(db, template_id)
    data = payload.model_dump(exclude_unset=True)
    # EDITOR 모드 저장이면 body_html 에 기본 CSS 를 inline 시켜 메일에서 보이게.
    # body_kind 는 이번 patch 의 값 또는 기존 값을 사용.
    effective_kind = data.get("body_kind", tpl.body_kind)
    if (
        effective_kind == "EDITOR"
        and "body_html" in data
        and isinstance(data["body_html"], str)
        and data["body_html"].strip()
    ):
        data["body_html"] = inline_for_email(data["body_html"])
    for k, v in data.items():
        setattr(tpl, k, v)
    await db.commit()
    tpl = await _get_or_404(db, template_id)
    logger.info(
        "이메일 템플릿 수정: id=%s 변경=%s (수정자=%s)",
        tpl.id, list(data.keys()), user.id,
    )
    return tpl


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tpl = await _get_or_404(db, template_id)
    # CASCADE 가 asset row 정리. 디스크 파일은 best-effort 청소.
    for a in (tpl.assets or []):
        try:
            delete_file(a.file_path)
        except Exception as exc:  # pragma: no cover
            logger.warning("이메일 자산 디스크 삭제 실패: path=%s err=%s", a.file_path, exc)
    logger.warning(
        "이메일 템플릿 삭제: id=%s name=%s assets=%d (삭제자=%s)",
        tpl.id, tpl.name, len(tpl.assets or []), user.id,
    )
    await db.delete(tpl)
    await db.commit()


# ---------------------------------------------------------------------------
# 자산 (cid 인라인 이미지)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 테스트 발송 — 캠페인·세그먼트·트래킹 없이 템플릿을 임의 주소로 즉시 발송.
# ---------------------------------------------------------------------------


class _TestSendIn(BaseModel):
    to: list[str] = Field(..., min_length=1, max_length=10)


class _TestSendOut(BaseModel):
    delivered: bool
    to: list[str]


_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


@router.post("/{template_id}/test-send", response_model=_TestSendOut)
async def test_send(
    template_id: UUID,
    payload: _TestSendIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """템플릿을 지정한 1~10명에게 즉시 발송 — 캠페인 흐름 우회.

    수신거부 푸터·트래킹 픽셀·머지 토큰 치환은 부착하지 않는다 (테스트 목적).
    본문 안의 cid: 이미지는 자산을 multipart/related 로 임베드.
    """
    tpl = await _get_or_404(db, template_id)
    # 이메일 형식 사전 검증 — SMTP 단에서 실패하기 전에 명확한 400 으로.
    cleaned: list[str] = []
    for raw in payload.to:
        addr = (raw or "").strip()
        if not addr or not _EMAIL_RE.match(addr):
            raise HTTPException(400, detail=f"잘못된 이메일 주소: {raw!r}")
        cleaned.append(addr)

    inline_images = _collect_inline_images(tpl)
    body = tpl.body_html or tpl.body_text or ""
    if not body.strip():
        raise HTTPException(400, detail="본문이 비어 있어 발송할 수 없습니다.")

    ok = await mail_service.send_for_tenant(
        tenant_id=tpl.tenant_id,
        subject=tpl.subject or tpl.name,
        body=body,
        to=cleaned,
        html=True,
        inline_images=inline_images,
    )
    if ok:
        logger.info(
            "이메일 템플릿 테스트 발송: template=%s 수신자=%s 발신자=%s",
            tpl.id, cleaned, user.id,
        )
    else:
        logger.warning(
            "이메일 템플릿 테스트 발송 실패: template=%s 수신자=%s 발신자=%s",
            tpl.id, cleaned, user.id,
        )
    return _TestSendOut(delivered=ok, to=cleaned)


# 안전한 cid 만 허용 — 본문에 들어가는 식별자라 영숫자 + 하이픈.
_CID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@router.get(
    "/{template_id}/assets", response_model=list[EmailTemplateAssetOut],
)
async def list_assets(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    tpl = await _get_or_404(db, template_id)
    return list(tpl.assets or [])


@router.post(
    "/{template_id}/assets",
    response_model=EmailTemplateAssetOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_asset(
    template_id: UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본문에 인라인 임베드할 이미지 업로드 → content_id 발급.

    프론트는 응답의 `content_id` 로 `<img src="cid:{content_id}">` 를 본문에 삽입.
    저장 경로: data/marketing-email-assets/<template_id>/<uuid>.<ext>
    """
    tpl = await _get_or_404(db, template_id)
    # cid 는 충돌 회피용 short id — uuid hex 16자.
    cid = f"asset-{uuid_pkg.uuid4().hex[:16]}"
    path, size = await save_upload(file, f"marketing-email-assets/{tpl.id}")
    asset = MarketingEmailTemplateAsset(
        tenant_id=tpl.tenant_id,
        template_id=tpl.id,
        content_id=cid,
        file_name=file.filename or uuid4().hex,
        file_path=path,
        mime_type=file.content_type,
        size=size,
        uploaded_by=user.id,
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    logger.info(
        "이메일 자산 업로드: template=%s cid=%s name=%s mime=%s size=%s (등록자=%s)",
        tpl.id, cid, asset.file_name, asset.mime_type, size, user.id,
    )
    return asset


@router.delete(
    "/{template_id}/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_asset(
    template_id: UUID,
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _get_or_404(db, template_id)
    asset = (
        await db.execute(
            select(MarketingEmailTemplateAsset).where(
                MarketingEmailTemplateAsset.id == asset_id,
                MarketingEmailTemplateAsset.template_id == template_id,
            )
        )
    ).scalar_one_or_none()
    if asset is None:
        return
    try:
        delete_file(asset.file_path)
    except Exception as exc:  # pragma: no cover
        logger.warning("이메일 자산 디스크 삭제 실패: path=%s err=%s", asset.file_path, exc)
    await db.delete(asset)
    await db.commit()
    logger.info(
        "이메일 자산 삭제: template=%s cid=%s name=%s (삭제자=%s)",
        template_id, asset.content_id, asset.file_name, user.id,
    )


@router.get("/{template_id}/assets/{asset_id}/preview")
async def preview_asset(
    template_id: UUID,
    asset_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """편집기 안에서 cid 이미지를 inline 미리보기 — Bearer 인증 통과한 사용자만."""
    await _get_or_404(db, template_id)
    asset = (
        await db.execute(
            select(MarketingEmailTemplateAsset).where(
                MarketingEmailTemplateAsset.id == asset_id,
                MarketingEmailTemplateAsset.template_id == template_id,
            )
        )
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(404, "자산을 찾을 수 없습니다.")
    p: Path = resolve_upload_path(asset.file_path)
    if not p.exists():
        raise HTTPException(404, "파일이 디스크에 없습니다.")
    return FileResponse(
        path=str(p),
        media_type=asset.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{asset.file_name}"'},
    )


# ---------------------------------------------------------------------------
# URL import
# ---------------------------------------------------------------------------


@router.post("/import-url", response_model=EmailImportUrlOut)
async def import_url(
    payload: EmailImportUrlIn,
    _: User = Depends(get_current_user),
):
    """외부 URL 의 HTML 을 fetch → sanitize → 절대 URL → premailer 인라인.

    이메일 호환성을 위해 script/style/iframe 제거, 상대 URL 절대화, CSS 인라인까지
    수행하지만 결과 HTML 의 최종 손질은 사용자가 EditMode 에서 마무리.
    """
    try:
        result = await import_url_html(payload.url)
    except Exception as exc:
        logger.warning("URL import 실패: url=%s err=%s", payload.url, exc)
        raise HTTPException(422, f"URL 가져오기 실패: {exc}") from exc
    if not result["body_html"].strip():
        logger.warning("URL import 결과 본문이 비어 있음: url=%s", payload.url)
    else:
        logger.info("URL import 성공: url=%s title=%r", payload.url, result.get("title"))
    return EmailImportUrlOut(**result)
