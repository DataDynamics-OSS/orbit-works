"""기술지원 활동 로그 API.

Endpoints (`/support-logs`): support_cases 와 동일한 패턴 — CRUD + 첨부 + 코멘트.
권한: 모두 `support.manage` (SALES + HR + SUPPORT + ADMIN).
코멘트 수정·삭제는 추가로 본인(작성자) 또는 ADMIN 만 통과.
"""

from __future__ import annotations

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import has_feature, require_permission
from app.core.database import get_db
from app.models import (
    Customer,
    Developer,
    Product,
    ProductVersion,
    Project,
    SupportLog,
    SupportLogAttachment,
    SupportLogComment,
    SupportLogProduct,
    User,
    Vendor,
)
from app.api.v1.product_catalog import ensure_product, ensure_vendor, ensure_version
from app.schemas.support_log import (
    AttachmentRename,
    CommentIn,
    MonthlyEngineerSeries,
    SupportLogAttachmentOut,
    SupportLogCharts,
    SupportLogCommentOut,
    SupportLogCreate,
    SupportLogOut,
    SupportLogProductIn,
    SupportLogProductOut,
    SupportLogStats,
    SupportLogUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/support-logs", tags=["support-logs"])


_ATTACH_ALLOWED_MIME = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic",
    "text/plain", "text/csv", "application/zip", "application/x-zip-compressed",
}


async def _get_or_404(db: AsyncSession, log_id: UUID) -> SupportLog:
    row = (
        await db.execute(
            select(SupportLog)
            .options(
                selectinload(SupportLog.attachments),
                selectinload(SupportLog.comments),
                selectinload(SupportLog.products),
            )
            .where(SupportLog.id == log_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="기술지원 로그를 찾을 수 없습니다.")
    return row


async def _to_out(db: AsyncSession, l: SupportLog) -> SupportLogOut:
    customer_name = None
    project_name = None
    sales_rep_name = None
    support_eng_name = None
    if l.customer_id:
        customer_name = (
            await db.execute(select(Customer.name).where(Customer.id == l.customer_id))
        ).scalar_one_or_none()
    if l.project_id:
        project_name = (
            await db.execute(select(Project.name).where(Project.id == l.project_id))
        ).scalar_one_or_none()
    if l.sales_rep_developer_id:
        sales_rep_name = (
            await db.execute(
                select(Developer.name).where(Developer.id == l.sales_rep_developer_id)
            )
        ).scalar_one_or_none()
    if l.support_engineer_developer_id:
        support_eng_name = (
            await db.execute(
                select(Developer.name).where(Developer.id == l.support_engineer_developer_id)
            )
        ).scalar_one_or_none()

    author_ids = [
        cm.author_user_id for cm in (l.comments or []) if cm.author_user_id is not None
    ]
    name_by_user: dict[UUID, str] = {}
    if author_ids:
        rows = (
            await db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(author_ids))
            )
        ).all()
        for r in rows:
            name_by_user[r.id] = r.name or r.email or ""

    comments = [
        SupportLogCommentOut(
            id=cm.id,
            author_user_id=cm.author_user_id,
            author_name=name_by_user.get(cm.author_user_id) if cm.author_user_id else None,
            body=cm.body,
            duration_minutes=cm.duration_minutes,
            start_date=cm.start_date,
            end_date=cm.end_date,
            created_at=cm.created_at,
            updated_at=cm.updated_at,
        )
        for cm in (l.comments or [])
    ]

    # vendor 이름 lookup (단일).
    vendor_name = None
    if l.vendor_id:
        vendor_name = (
            await db.execute(select(Vendor.name).where(Vendor.id == l.vendor_id))
        ).scalar_one_or_none()

    # products — 다중. bulk lookup 으로 name 부착.
    product_ids = {sp.product_id for sp in (l.products or [])}
    version_ids = {sp.version_id for sp in (l.products or []) if sp.version_id}
    prods_name: dict[UUID, str] = {}
    vers_name: dict[UUID, str] = {}
    if product_ids:
        rows = (
            await db.execute(
                select(Product.id, Product.name).where(Product.id.in_(product_ids))
            )
        ).all()
        prods_name = {pid: pname for (pid, pname) in rows}
    if version_ids:
        rows = (
            await db.execute(
                select(ProductVersion.id, ProductVersion.name).where(
                    ProductVersion.id.in_(version_ids)
                )
            )
        ).all()
        vers_name = {vid: vname for (vid, vname) in rows}
    products_out = [
        SupportLogProductOut(
            product_id=sp.product_id,
            product=prods_name.get(sp.product_id),
            version_id=sp.version_id,
            version=vers_name.get(sp.version_id) if sp.version_id else None,
            sort_order=sp.sort_order,
        )
        for sp in sorted(l.products or [], key=lambda x: x.sort_order)
    ]

    return SupportLogOut(
        id=l.id,
        customer_id=l.customer_id,
        project_id=l.project_id,
        sales_rep_developer_id=l.sales_rep_developer_id,
        support_engineer_developer_id=l.support_engineer_developer_id,
        start_date=l.start_date,
        end_date=l.end_date,
        duration_minutes=l.duration_minutes,
        vendor_id=l.vendor_id,
        vendor=vendor_name,
        products=products_out,
        body=l.body,
        customer_name=customer_name,
        project_name=project_name,
        sales_rep_name=sales_rep_name,
        support_engineer_name=support_eng_name,
        attachments=[
            SupportLogAttachmentOut.model_validate(a) for a in (l.attachments or [])
        ],
        comments=comments,
        created_at=l.created_at,
        updated_at=l.updated_at,
        created_by=l.created_by,
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[SupportLogOut])
async def list_logs(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
    customer_id: UUID | None = None,
    vendor_id: UUID | None = None,
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
):
    stmt = (
        select(SupportLog)
        .options(
            selectinload(SupportLog.attachments),
            selectinload(SupportLog.comments),
            selectinload(SupportLog.products),
        )
        .order_by(SupportLog.start_date.desc(), SupportLog.created_at.desc())
    )
    if customer_id:
        stmt = stmt.where(SupportLog.customer_id == customer_id)
    if vendor_id:
        stmt = stmt.where(SupportLog.vendor_id == vendor_id)
    if from_:
        stmt = stmt.where(SupportLog.end_date >= from_)
    if to:
        stmt = stmt.where(SupportLog.start_date <= to)
    rows = list((await db.execute(stmt)).scalars())
    return [await _to_out(db, l) for l in rows]


@router.get("/stats", response_model=SupportLogStats)
async def get_stats(
    year: int = Query(...),
    month: int = Query(...),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    """코멘트 단위 KPI — comment.start_date 가 해당 연/월에 속하는 코멘트로 집계.

    "건" = 코멘트 1개 (지원 세션). 동일 로그라도 다른 날짜의 코멘트면 각각 1건.
    "고객사 수" = comment → log → customer 로 조인 후 distinct.
    """
    from calendar import monthrange

    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    month_start = date(year, month, 1)
    month_end = date(year, month, monthrange(year, month)[1])

    async def aggregate(start_d: date, end_d: date) -> tuple[int, int, int]:
        cnt_min = (
            await db.execute(
                select(
                    func.count(SupportLogComment.id),
                    func.coalesce(func.sum(SupportLogComment.duration_minutes), 0),
                ).where(
                    SupportLogComment.start_date >= start_d,
                    SupportLogComment.start_date <= end_d,
                )
            )
        ).one()
        customers = (
            await db.execute(
                select(func.count(func.distinct(SupportLog.customer_id)))
                .select_from(SupportLog)
                .join(SupportLogComment, SupportLogComment.log_id == SupportLog.id)
                .where(
                    SupportLogComment.start_date >= start_d,
                    SupportLogComment.start_date <= end_d,
                )
            )
        ).scalar_one()
        return int(cnt_min[0]), int(cnt_min[1]), int(customers)

    yc, ym, ycust = await aggregate(year_start, year_end)
    mc, mm, mcust = await aggregate(month_start, month_end)

    return SupportLogStats(
        year=year,
        month=month,
        year_count=yc,
        year_minutes=ym,
        year_customers=ycust,
        month_count=mc,
        month_minutes=mm,
        month_customers=mcust,
    )


@router.get("/charts", response_model=SupportLogCharts)
async def get_charts(
    year: int = Query(...),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    """월별 차트 데이터 — comment.start_date 의 월을 키로 집계.

    - monthly_count / monthly_minutes: 전체 합계 12 칸 (1월~12월).
    - by_engineer: 엔지니어별 같은 12 칸 시리즈. 엔지니어 미지정 코멘트는
      engineer_id=None / engineer_name="(미지정)" 시리즈로 묶음.
    """
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    month_col = func.extract("month", SupportLogComment.start_date)

    # 전체 합계.
    total_rows = (
        await db.execute(
            select(
                month_col.label("m"),
                func.count(SupportLogComment.id),
                func.coalesce(func.sum(SupportLogComment.duration_minutes), 0),
            )
            .where(
                SupportLogComment.start_date >= year_start,
                SupportLogComment.start_date <= year_end,
            )
            .group_by(month_col)
        )
    ).all()
    monthly_count = [0] * 12
    monthly_minutes = [0] * 12
    for m, cnt, mins in total_rows:
        monthly_count[int(m) - 1] = int(cnt)
        monthly_minutes[int(m) - 1] = int(mins)

    # 엔지니어별 합계.
    eng_rows = (
        await db.execute(
            select(
                month_col.label("m"),
                SupportLog.support_engineer_developer_id.label("eng_id"),
                Developer.name.label("eng_name"),
                func.count(SupportLogComment.id),
                func.coalesce(func.sum(SupportLogComment.duration_minutes), 0),
            )
            .select_from(SupportLogComment)
            .join(SupportLog, SupportLog.id == SupportLogComment.log_id)
            .outerjoin(Developer, Developer.id == SupportLog.support_engineer_developer_id)
            .where(
                SupportLogComment.start_date >= year_start,
                SupportLogComment.start_date <= year_end,
            )
            .group_by(month_col, SupportLog.support_engineer_developer_id, Developer.name)
        )
    ).all()
    series_by_eng: dict[str, MonthlyEngineerSeries] = {}
    for m, eng_id, eng_name, cnt, mins in eng_rows:
        key = str(eng_id) if eng_id else "_unassigned"
        if key not in series_by_eng:
            series_by_eng[key] = MonthlyEngineerSeries(
                engineer_id=eng_id,
                engineer_name=eng_name or "(미지정)",
                monthly_count=[0] * 12,
                monthly_minutes=[0] * 12,
            )
        series_by_eng[key].monthly_count[int(m) - 1] = int(cnt)
        series_by_eng[key].monthly_minutes[int(m) - 1] = int(mins)

    # 엔지니어 시리즈 정렬: 미지정을 마지막에, 나머지는 연간 건수 합 내림차순.
    def sort_key(s: MonthlyEngineerSeries) -> tuple[int, int]:
        return (1 if s.engineer_id is None else 0, -sum(s.monthly_count))

    return SupportLogCharts(
        year=year,
        monthly_count=monthly_count,
        monthly_minutes=monthly_minutes,
        by_engineer=sorted(series_by_eng.values(), key=sort_key),
    )


@router.get("/{log_id}", response_model=SupportLogOut)
async def get_log(
    log_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    l = await _get_or_404(db, log_id)
    return await _to_out(db, l)


async def _resolve_vendor(
    db: AsyncSession, tenant_id: UUID | None, vendor_name: str | None,
) -> UUID | None:
    if tenant_id is None or not vendor_name or not vendor_name.strip():
        return None
    return (await ensure_vendor(db, tenant_id, vendor_name)).id


async def _resolve_product_row(
    db: AsyncSession,
    tenant_id: UUID,
    vendor_id: UUID | None,
    item: SupportLogProductIn,
) -> tuple[UUID, UUID | None]:
    """다이얼로그가 보낸 product 1건을 (product_id, version_id) 로 변환.

    id 가 이미 채워져 있으면 그대로. 이름만 있으면 카탈로그 lookup-or-create.
    vendor_id 가 없으면 lookup-or-create 불가 (FK 위반) — 호출자가 vendor 먼저
    확보해야 함.
    """
    pid: UUID | None = item.product_id
    veid: UUID | None = item.version_id
    if pid is None and item.product and item.product.strip():
        if vendor_id is None:
            raise HTTPException(
                status_code=400,
                detail="제품 이름으로 신규 등록하려면 제조사(vendor)가 필요합니다.",
            )
        pid = (await ensure_product(db, tenant_id, vendor_id, item.product)).id
    if pid is None:
        raise HTTPException(status_code=400, detail="product_id 또는 product 이름이 필요합니다.")
    if veid is None and item.version and item.version.strip():
        veid = (await ensure_version(db, tenant_id, pid, item.version)).id
    return pid, veid


async def _sync_products(
    db: AsyncSession,
    l: SupportLog,
    vendor_id: UUID | None,
    items: list[SupportLogProductIn],
) -> None:
    """SupportLog.products 를 입력 list 와 동기화 (set 차분).

    같은 product_id 가 이미 있으면 version_id/sort_order 만 갱신, 신규는 INSERT,
    더 이상 없는 row 는 DELETE.
    """
    # 입력 정규화: (product_id, version_id, sort_order) 튜플 리스트.
    resolved: list[tuple[UUID, UUID | None, int]] = []
    seen: set[UUID] = set()
    for idx, it in enumerate(items):
        pid, veid = await _resolve_product_row(db, l.tenant_id, vendor_id, it)
        if pid in seen:
            # 같은 product 중복 — 첫 항목만 유지 (PK 충돌 방지).
            continue
        seen.add(pid)
        resolved.append((pid, veid, it.sort_order if it.sort_order else idx))

    existing = {sp.product_id: sp for sp in (l.products or [])}
    new_ids = {pid for (pid, _, _) in resolved}
    removed = [pid for pid in existing if pid not in new_ids]
    added = [pid for (pid, _, _) in resolved if pid not in existing]
    # 제거
    for pid, sp in list(existing.items()):
        if pid not in new_ids:
            await db.delete(sp)
    # 추가/갱신
    for pid, veid, sort in resolved:
        if pid in existing:
            existing[pid].version_id = veid
            existing[pid].sort_order = sort
        else:
            db.add(
                SupportLogProduct(
                    tenant_id=l.tenant_id,
                    support_log_id=l.id,
                    product_id=pid,
                    version_id=veid,
                    sort_order=sort,
                )
            )
    await db.flush()
    if added or removed:
        # audit trail — 어떤 로그에 어떤 제품이 추가·제거됐는지. 변경 없으면 noise 줄임.
        logger.info(
            "support_log products sync: log=%s added=%d removed=%d total=%d",
            l.id, len(added), len(removed), len(resolved),
        )


def _is_admin(user: User) -> bool:
    return user.role in ("ADMIN", "SUPER_ADMIN")


async def _require_log_write(db: AsyncSession, user: User) -> None:
    """로그 생성·편집·첨부·코멘트 — support_logs.write feature."""
    if _is_admin(user):
        return
    if await has_feature(db, user, "support_logs.write"):
        return
    raise HTTPException(status_code=403, detail="활동 로그 작성 권한 없음")


async def _require_log_delete(db: AsyncSession, user: User) -> None:
    """로그 삭제 — write 와 분리. 오삭제 방지."""
    if _is_admin(user):
        return
    if await has_feature(db, user, "support_logs.delete"):
        return
    raise HTTPException(status_code=403, detail="활동 로그 삭제 권한 없음")


@router.post("", response_model=SupportLogOut, status_code=status.HTTP_201_CREATED)
async def create_log(
    payload: SupportLogCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_write(db, user)
    if payload.start_date > payload.end_date:
        raise HTTPException(status_code=400, detail="시작일이 종료일보다 늦습니다.")
    vendor_id = await _resolve_vendor(db, user.tenant_id, payload.vendor)
    data = payload.model_dump()
    data.pop("vendor", None)
    products_in = data.pop("products", []) or []
    # SupportLogProductIn 으로 re-parse — model_dump 후 raw dict.
    products_in = [SupportLogProductIn(**p) for p in products_in]
    l = SupportLog(
        **data,
        vendor_id=vendor_id,
        created_by=user.id,
    )
    db.add(l)
    await db.flush()  # l.id 확보 + products 동기화에 필요
    await db.refresh(l, attribute_names=["products"])
    await _sync_products(db, l, vendor_id, products_in)
    await db.commit()
    l = await _get_or_404(db, l.id)
    logger.info(
        "기술지원 로그 생성: id=%s customer=%s vendor_id=%s 기간=%s~%s 시간=%dm 제품수=%d (생성자=%s)",
        l.id, l.customer_id, l.vendor_id, l.start_date, l.end_date,
        l.duration_minutes, len(products_in), user.id,
    )
    return await _to_out(db, l)


@router.patch("/{log_id}", response_model=SupportLogOut)
async def update_log(
    log_id: UUID,
    payload: SupportLogUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_write(db, user)
    l = await _get_or_404(db, log_id)
    data = payload.model_dump(exclude_unset=True)
    if "start_date" in data and "end_date" in data:
        if data["start_date"] > data["end_date"]:
            raise HTTPException(status_code=400, detail="시작일이 종료일보다 늦습니다.")
    # vendor 단일 — 이름 → id.
    if "vendor" in payload.model_fields_set:
        data["vendor_id"] = await _resolve_vendor(
            db, l.tenant_id, data.pop("vendor", None),
        )
    # products — 명시 지정 시에만 동기화. None 은 미변경.
    products_payload = data.pop("products", None) if "products" in payload.model_fields_set else None

    for k, v in data.items():
        setattr(l, k, v)

    if products_payload is not None:
        items_in = [SupportLogProductIn(**p) for p in products_payload]
        # vendor_id 가 같은 트랜잭션 안에서 방금 갱신됐을 수 있으니 새 값 사용.
        await _sync_products(db, l, l.vendor_id, items_in)

    await db.commit()
    l = await _get_or_404(db, log_id)
    logger.info(
        "기술지원 로그 수정: id=%s 변경필드=%s (수정자=%s)",
        log_id, list(data.keys()), user.id,
    )
    return await _to_out(db, l)


@router.delete("/{log_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_log(
    log_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_delete(db, user)
    l = await _get_or_404(db, log_id)
    att_count = len(l.attachments or [])
    for a in l.attachments or []:
        delete_file(a.file_path)
    await db.delete(l)
    await db.commit()
    # 로그 삭제 = 코멘트·첨부까지 CASCADE 로 사라지므로 warning 으로 기록.
    logger.warning(
        "기술지원 로그 삭제: id=%s 첨부=%d (삭제자=%s)",
        log_id, att_count, user.id,
    )


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post("/{log_id}/attachments", response_model=SupportLogOut)
async def upload_attachments(
    log_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_write(db, user)
    l = await _get_or_404(db, log_id)
    if not files:
        raise HTTPException(status_code=400, detail="업로드할 파일이 없습니다.")
    total_size = 0
    for f in files:
        mime = (f.content_type or "").lower()
        if mime not in _ATTACH_ALLOWED_MIME:
            raise HTTPException(
                status_code=400,
                detail=f"지원하지 않는 형식: {f.filename} ({mime})",
            )
        path, size = await save_upload(f, f"support-logs/{l.id}")
        total_size += size
        db.add(
            SupportLogAttachment(
                log_id=l.id,
                file_name=f.filename or "attachment",
                file_path=path,
                mime_type=mime,
                size=size,
            )
        )
    await db.commit()
    l = await _get_or_404(db, log_id)
    logger.info(
        "지원로그 첨부 업로드: id=%s files=%d total=%dKB (업로더=%s)",
        log_id, len(files), total_size // 1024, user.id,
    )
    return await _to_out(db, l)


@router.get("/{log_id}/attachments/{att_id}")
async def download_attachment(
    log_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    att = (
        await db.execute(
            select(SupportLogAttachment).where(
                SupportLogAttachment.id == att_id,
                SupportLogAttachment.log_id == log_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    abs_path = resolve_upload_path(att.file_path)
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="파일이 디스크에 존재하지 않습니다.")
    return FileResponse(
        str(abs_path),
        media_type=att.mime_type or "application/octet-stream",
        filename=att.file_name,
    )


@router.patch("/{log_id}/attachments/{att_id}", response_model=SupportLogAttachmentOut)
async def rename_attachment(
    log_id: UUID,
    att_id: UUID,
    payload: AttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_write(db, user)
    att = (
        await db.execute(
            select(SupportLogAttachment).where(
                SupportLogAttachment.id == att_id,
                SupportLogAttachment.log_id == log_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    new_name = (payload.file_name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="파일명이 비어 있습니다.")
    att.file_name = new_name
    await db.commit()
    await db.refresh(att)
    logger.info(
        "지원로그 첨부 이름 변경: log=%s att=%s name=%s (수정자=%s)",
        log_id, att_id, new_name, user.id,
    )
    return SupportLogAttachmentOut.model_validate(att)


@router.delete("/{log_id}/attachments/{att_id}", response_model=SupportLogOut)
async def delete_attachment(
    log_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_write(db, user)
    att = (
        await db.execute(
            select(SupportLogAttachment).where(
                SupportLogAttachment.id == att_id,
                SupportLogAttachment.log_id == log_id,
            )
        )
    ).scalar_one_or_none()
    if att is None:
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다.")
    file_name = att.file_name
    delete_file(att.file_path)
    await db.delete(att)
    await db.commit()
    logger.warning(
        "지원로그 첨부 삭제: log=%s att=%s name=%s (삭제자=%s)",
        log_id, att_id, file_name, user.id,
    )
    l = await _get_or_404(db, log_id)
    return await _to_out(db, l)


# ---------------------------------------------------------------------------
# Comments — 본인(작성자) 또는 ADMIN 만 수정·삭제.
# ---------------------------------------------------------------------------


def _ensure_can_edit_comment(user: User, cm: SupportLogComment) -> None:
    if user.role == "ADMIN" or user.role == "SUPER_ADMIN":
        return
    if cm.author_user_id is not None and cm.author_user_id == user.id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="코멘트 권한 없음")


async def _recalc_log_aggregates(db: AsyncSession, log_id: UUID) -> None:
    """`support_logs` 의 duration_minutes / start_date / end_date 를 코멘트 집계로 재계산.

    코멘트가 1개 이상 있으면 SUM(분), MIN(start_date), MAX(end_date) 로 덮어쓴다.
    코멘트가 모두 삭제된 경우 duration_minutes 만 0 으로 초기화하고
    날짜 컬럼은 NOT NULL 이므로 기존 값을 유지한다.
    """
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(SupportLogComment.duration_minutes), 0),
                func.min(SupportLogComment.start_date),
                func.max(SupportLogComment.end_date),
                func.count(SupportLogComment.id),
            ).where(SupportLogComment.log_id == log_id)
        )
    ).one()
    total_minutes, min_start, max_end, cnt = row
    values: dict = {"duration_minutes": int(total_minutes)}
    if cnt > 0:
        if min_start is not None:
            values["start_date"] = min_start
        if max_end is not None:
            values["end_date"] = max_end
    await db.execute(update(SupportLog).where(SupportLog.id == log_id).values(**values))
    logger.info(
        "지원로그 집계 재계산: log=%s 코멘트=%s 합계=%s분 start=%s end=%s",
        log_id, int(cnt), int(total_minutes),
        min_start if cnt > 0 else "(유지)",
        max_end if cnt > 0 else "(유지)",
    )


@router.post("/{log_id}/comments", response_model=SupportLogOut)
async def add_comment(
    log_id: UUID,
    payload: CommentIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_log_write(db, user)
    l = await _get_or_404(db, log_id)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="코멘트 내용이 비어 있습니다.")
    today = date.today()
    sd = payload.start_date or today
    ed = payload.end_date or today
    if sd > ed:
        raise HTTPException(status_code=400, detail="시작일이 종료일보다 늦습니다.")
    db.add(
        SupportLogComment(
            log_id=l.id,
            author_user_id=user.id,
            body=body,
            duration_minutes=max(0, payload.duration_minutes),
            start_date=sd,
            end_date=ed,
        )
    )
    await db.flush()
    await _recalc_log_aggregates(db, l.id)
    await db.commit()
    l = await _get_or_404(db, log_id)
    logger.info(
        "지원로그 코멘트 추가: log=%s 작성자=%s 분=%s 일자=%s~%s",
        log_id, user.id, payload.duration_minutes, sd, ed,
    )
    return await _to_out(db, l)


@router.patch("/{log_id}/comments/{comment_id}", response_model=SupportLogOut)
async def edit_comment(
    log_id: UUID,
    comment_id: UUID,
    payload: CommentIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    cm = (
        await db.execute(
            select(SupportLogComment).where(
                SupportLogComment.id == comment_id,
                SupportLogComment.log_id == log_id,
            )
        )
    ).scalar_one_or_none()
    if cm is None:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    _ensure_can_edit_comment(user, cm)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="코멘트 내용이 비어 있습니다.")
    cm.body = body
    cm.duration_minutes = max(0, payload.duration_minutes)
    if payload.start_date is not None:
        cm.start_date = payload.start_date
    if payload.end_date is not None:
        cm.end_date = payload.end_date
    if cm.start_date > cm.end_date:
        raise HTTPException(status_code=400, detail="시작일이 종료일보다 늦습니다.")
    await db.flush()
    await _recalc_log_aggregates(db, log_id)
    await db.commit()
    l = await _get_or_404(db, log_id)
    logger.info("지원로그 코멘트 수정: log=%s comment=%s by=%s", log_id, comment_id, user.id)
    return await _to_out(db, l)


@router.delete("/{log_id}/comments/{comment_id}", response_model=SupportLogOut)
async def delete_comment(
    log_id: UUID,
    comment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    cm = (
        await db.execute(
            select(SupportLogComment).where(
                SupportLogComment.id == comment_id,
                SupportLogComment.log_id == log_id,
            )
        )
    ).scalar_one_or_none()
    if cm is None:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    _ensure_can_edit_comment(user, cm)
    await db.delete(cm)
    await db.flush()
    await _recalc_log_aggregates(db, log_id)
    await db.commit()
    l = await _get_or_404(db, log_id)
    logger.warning("지원로그 코멘트 삭제: log=%s comment=%s by=%s", log_id, comment_id, user.id)
    return await _to_out(db, l)
