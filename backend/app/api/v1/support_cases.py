"""기술지원 케이스 API.

Endpoints:
- `GET    /support-cases`                                  목록 (status / vendor / customer_id 필터)
- `GET    /support-cases/{id}`                             단건 (sub 포함)
- `POST   /support-cases`                                  생성
- `PATCH  /support-cases/{id}`                             수정 (sub 제외 — 별도 엔드포인트)
- `DELETE /support-cases/{id}`                             삭제 (cascade + 첨부 디스크 정리)

상태 전환 부수효과 (PATCH):
- status 가 변경되면 자동으로:
  - `→ CLOSED` 진입: `closed_at = now()`, `closed_by = 현재 사용자`
  - `CLOSED → 다른값` 재오픈: closed_* 둘 다 NULL 로 reset
  - 시스템 코멘트 자동 append (`author_user_id=NULL`, "[시스템] X님이 ...")

Sub:
- `POST   /support-cases/{id}/attachments`                 다중 파일 업로드
- `PATCH  /support-cases/{id}/attachments/{aid}`           파일명 변경
- `GET    /support-cases/{id}/attachments/{aid}`           다운로드
- `DELETE /support-cases/{id}/attachments/{aid}`           삭제
- `POST   /support-cases/{id}/comments`                    코멘트 추가
- `PATCH  /support-cases/{id}/comments/{cid}`              코멘트 수정 (작성자 + ADMIN)
- `DELETE /support-cases/{id}/comments/{cid}`              코멘트 삭제 (작성자 + ADMIN)

권한: 모두 `support.manage` (SALES + HR + SUPPORT + ADMIN). 코멘트 수정·삭제는
추가로 본인(작성자) 또는 ADMIN 만 통과.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, has_feature, require_permission
from app.api.v1.product_catalog import ensure_product, ensure_vendor, ensure_version
from app.core.database import get_db
from app.models import (
    Customer,
    Developer,
    Product,
    ProductVersion,
    Project,
    SupportCase,
    SupportCaseAttachment,
    SupportCaseComment,
    SupportCaseCounter,
    SupportCaseProduct,
    User,
    Vendor,
)
from app.schemas.support_case import (
    AttachmentRename,
    CommentIn,
    StatsBucket,
    SupportCaseAttachmentOut,
    SupportCaseCommentOut,
    SupportCaseCreate,
    SupportCaseOut,
    SupportCaseProductIn,
    SupportCaseProductOut,
    SupportCaseStats,
    SupportCaseStatus,
    SupportCaseUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/support-cases", tags=["support-cases"])


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


# 케이스 번호 정규식 — URL/검색 양쪽에서 동일 패턴 검증.
_CASE_NO_RE = re.compile(r"^CASE-\d{4}-\d{3,}$")


def _is_admin(user: User) -> bool:
    return user.role in ("ADMIN", "SUPER_ADMIN")


async def _require_case_write(db: AsyncSession, user: User) -> None:
    """케이스 생성·편집·첨부·코멘트 — support_cases.write feature."""
    if _is_admin(user):
        return
    if await has_feature(db, user, "support_cases.write"):
        return
    raise HTTPException(status_code=403, detail="케이스 작성 권한 없음")


async def _require_case_delete(db: AsyncSession, user: User) -> None:
    """케이스 삭제 — write 와 분리. 작성자 본인 예외 없음 (오삭제 방지)."""
    if _is_admin(user):
        return
    if await has_feature(db, user, "support_cases.delete"):
        return
    raise HTTPException(status_code=403, detail="케이스 삭제 권한 없음")


async def _require_case_close(db: AsyncSession, user: User) -> None:
    """케이스 종료(→ CLOSED) — support_cases.close. 1차 처리 누구나, 종료만 분리."""
    if _is_admin(user):
        return
    if await has_feature(db, user, "support_cases.close"):
        return
    raise HTTPException(status_code=403, detail="케이스 종료 권한 없음")


async def _next_case_no(db: AsyncSession, tenant_id: UUID, year: int) -> str:
    """원자적으로 (tenant, year) 시퀀스 +1 후 "CASE-YYYY-NNN" 반환.

    SELECT ... FOR UPDATE 로 row lock. counter row 없으면 새로 INSERT.
    호출 측은 별도 commit 불필요 — 같은 트랜잭션 안에서 case INSERT 와 함께 commit.
    """
    counter = (
        await db.execute(
            select(SupportCaseCounter)
            .where(
                SupportCaseCounter.tenant_id == tenant_id,
                SupportCaseCounter.year == year,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if counter is None:
        counter = SupportCaseCounter(tenant_id=tenant_id, year=year, last_seq=0)
        db.add(counter)
        await db.flush()
    counter.last_seq += 1
    seq = counter.last_seq
    # 자릿수는 최소 3자리, 1000건 넘으면 자릿수 자연 증가.
    return f"CASE-{year}-{seq:03d}"


async def _get_or_404(db: AsyncSession, case_id: UUID) -> SupportCase:
    row = (
        await db.execute(
            select(SupportCase)
            .options(
                selectinload(SupportCase.attachments),
                selectinload(SupportCase.comments),
                selectinload(SupportCase.products),
            )
            .where(SupportCase.id == case_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="케이스를 찾을 수 없습니다.")
    return row


async def _to_out(db: AsyncSession, c: SupportCase) -> SupportCaseOut:
    """ORM → API. customer/project/사람 이름은 join 으로 채워 클라이언트가 한 번에 표시."""
    # 이름 lookup — 케이스가 많을 때 N+1 회피를 위해 list 엔드포인트는 별도 batch 로 처리.
    customer_name = None
    project_name = None
    sales_rep_name = None
    support_eng_name = None
    if c.customer_id:
        customer_name = (
            await db.execute(select(Customer.name).where(Customer.id == c.customer_id))
        ).scalar_one_or_none()
    if c.project_id:
        project_name = (
            await db.execute(select(Project.name).where(Project.id == c.project_id))
        ).scalar_one_or_none()
    if c.sales_rep_developer_id:
        sales_rep_name = (
            await db.execute(
                select(Developer.name).where(Developer.id == c.sales_rep_developer_id)
            )
        ).scalar_one_or_none()
    if c.support_engineer_developer_id:
        support_eng_name = (
            await db.execute(
                select(Developer.name).where(Developer.id == c.support_engineer_developer_id)
            )
        ).scalar_one_or_none()

    # vendor 이름 lookup (단일 컬럼).
    vendor_name = None
    if c.vendor_id:
        vendor_name = (
            await db.execute(select(Vendor.name).where(Vendor.id == c.vendor_id))
        ).scalar_one_or_none()

    # products — 다중. bulk lookup.
    product_ids = {sp.product_id for sp in (c.products or [])}
    version_ids = {sp.version_id for sp in (c.products or []) if sp.version_id}
    prods_name: dict[UUID, str] = {}
    vers_name: dict[UUID, str] = {}
    if product_ids:
        rows_ = (
            await db.execute(
                select(Product.id, Product.name).where(Product.id.in_(product_ids))
            )
        ).all()
        prods_name = {pid: pname for (pid, pname) in rows_}
    if version_ids:
        rows_ = (
            await db.execute(
                select(ProductVersion.id, ProductVersion.name).where(
                    ProductVersion.id.in_(version_ids)
                )
            )
        ).all()
        vers_name = {vid: vname for (vid, vname) in rows_}
    products_out = [
        SupportCaseProductOut(
            product_id=sp.product_id,
            product=prods_name.get(sp.product_id),
            version_id=sp.version_id,
            version=vers_name.get(sp.version_id) if sp.version_id else None,
            sort_order=sp.sort_order,
        )
        for sp in sorted(c.products or [], key=lambda x: x.sort_order)
    ]

    # 코멘트 작성자 이름 — User.name fallback to email. closed_by 도 같은 lookup 으로 한 번에.
    author_ids = [
        cm.author_user_id for cm in (c.comments or []) if cm.author_user_id is not None
    ]
    user_lookup_ids = set(author_ids)
    if c.closed_by is not None:
        user_lookup_ids.add(c.closed_by)
    name_by_user: dict[UUID, str] = {}
    if user_lookup_ids:
        rows = (
            await db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(user_lookup_ids))
            )
        ).all()
        for r in rows:
            name_by_user[r.id] = r.name or r.email or ""

    comments = [
        SupportCaseCommentOut(
            id=cm.id,
            author_user_id=cm.author_user_id,
            author_name=name_by_user.get(cm.author_user_id) if cm.author_user_id else None,
            body=cm.body,
            created_at=cm.created_at,
            updated_at=cm.updated_at,
        )
        for cm in (c.comments or [])
    ]

    return SupportCaseOut(
        id=c.id,
        case_no=c.case_no,
        customer_id=c.customer_id,
        project_id=c.project_id,
        sales_rep_developer_id=c.sales_rep_developer_id,
        support_engineer_developer_id=c.support_engineer_developer_id,
        vendor_id=c.vendor_id,
        vendor=vendor_name,
        products=products_out,
        vendor_case_no=c.vendor_case_no,
        title=c.title,
        status=c.status,  # type: ignore[arg-type]
        category=c.category,  # type: ignore[arg-type]
        severity=c.severity,  # type: ignore[arg-type]
        body=c.body,
        customer_name=customer_name,
        project_name=project_name,
        sales_rep_name=sales_rep_name,
        support_engineer_name=support_eng_name,
        attachments=[
            SupportCaseAttachmentOut.model_validate(a) for a in (c.attachments or [])
        ],
        comments=comments,
        created_at=c.created_at,
        updated_at=c.updated_at,
        created_by=c.created_by,
        closed_at=c.closed_at,
        closed_by=c.closed_by,
        closed_by_name=name_by_user.get(c.closed_by) if c.closed_by else None,
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[SupportCaseOut])
async def list_cases(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
    customer_id: UUID | None = None,
    vendor_id: UUID | None = None,
    status_filter: SupportCaseStatus | None = Query(default=None, alias="status"),
    q: str | None = None,
):
    stmt = (
        select(SupportCase)
        .options(
            selectinload(SupportCase.attachments),
            selectinload(SupportCase.comments),
            selectinload(SupportCase.products),
        )
        .order_by(SupportCase.created_at.desc())
    )
    if customer_id:
        stmt = stmt.where(SupportCase.customer_id == customer_id)
    if vendor_id:
        stmt = stmt.where(SupportCase.vendor_id == vendor_id)
    if status_filter:
        stmt = stmt.where(SupportCase.status == status_filter)
    if q:
        like = f"%{q}%"
        # 케이스 번호(case_no) / 벤더 번호(vendor_case_no) / 제목 매칭.
        from sqlalchemy import or_

        stmt = stmt.where(
            or_(
                SupportCase.case_no.ilike(like),
                SupportCase.vendor_case_no.ilike(like),
                SupportCase.title.ilike(like),
            )
        )
    rows = list((await db.execute(stmt)).scalars())
    return [await _to_out(db, c) for c in rows]


@router.get("/stats", response_model=SupportCaseStats)
async def get_stats(
    year: int = Query(...),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    """기술지원 케이스 KPI — created_at 의 연도 기준.

    파이 차트 4종 (severity / status / product / engineer) 데이터를 한 번에 반환.
    엔지니어·제품 미지정 케이스는 "(미지정)" 버킷.
    """
    year_start = datetime(year, 1, 1, tzinfo=timezone.utc)
    year_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    base_where = (
        SupportCase.created_at >= year_start,
        SupportCase.created_at < year_end,
    )

    total = (
        await db.execute(
            select(func.count(SupportCase.id)).where(*base_where)
        )
    ).scalar_one()

    async def bucket_by_column(group_col, label_col=None) -> list[StatsBucket]:
        stmt = select(label_col if label_col is not None else group_col,
                      func.count(SupportCase.id)).where(*base_where)
        if label_col is not None and label_col is not group_col:
            stmt = stmt.group_by(group_col, label_col)
        else:
            stmt = stmt.group_by(group_col)
        rows = (await db.execute(stmt)).all()
        return [
            StatsBucket(label=str(label) if label is not None else "(미지정)", count=int(cnt))
            for label, cnt in rows
        ]

    # severity / status / category 는 컬럼 값 그대로.
    by_severity = await bucket_by_column(SupportCase.severity)
    by_status = await bucket_by_column(SupportCase.status)
    by_category = await bucket_by_column(SupportCase.category)

    # product 는 join 테이블 → product.name LEFT JOIN. 한 case 에 여러 product
    # 가 부착돼 있으면 product 단위로 각각 1건씩 카운트 (product 별 시각화 의도).
    prod_rows = (
        await db.execute(
            select(Product.name, func.count(SupportCaseProduct.support_case_id))
            .select_from(SupportCase)
            .outerjoin(
                SupportCaseProduct,
                SupportCaseProduct.support_case_id == SupportCase.id,
            )
            .outerjoin(Product, Product.id == SupportCaseProduct.product_id)
            .where(*base_where)
            .group_by(Product.name)
        )
    ).all()
    by_product = [
        StatsBucket(label=name or "(미지정)", count=int(cnt)) for name, cnt in prod_rows
    ]

    # engineer 는 developers.name LEFT JOIN.
    eng_rows = (
        await db.execute(
            select(Developer.name, func.count(SupportCase.id))
            .select_from(SupportCase)
            .outerjoin(Developer, Developer.id == SupportCase.support_engineer_developer_id)
            .where(*base_where)
            .group_by(Developer.name)
        )
    ).all()
    by_engineer = [
        StatsBucket(label=name or "(미지정)", count=int(cnt)) for name, cnt in eng_rows
    ]

    # 모두 count 내림차순 + "(미지정)" 마지막.
    def sort_key(b: StatsBucket) -> tuple[int, int]:
        return (1 if b.label == "(미지정)" else 0, -b.count)

    by_severity.sort(key=sort_key)
    by_status.sort(key=sort_key)
    by_category.sort(key=sort_key)
    by_product.sort(key=sort_key)
    by_engineer.sort(key=sort_key)

    return SupportCaseStats(
        year=year,
        year_count=int(total),
        by_severity=by_severity,
        by_status=by_status,
        by_category=by_category,
        by_product=by_product,
        by_engineer=by_engineer,
    )


@router.get("/by-no/{case_no}", response_model=SupportCaseOut)
async def get_case_by_no(
    case_no: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    """케이스 번호로 단건 조회 — URL 가 case_no 일 때 진입점.

    형식 검증 (CASE-YYYY-NNN). 잘못된 패턴은 400. 매칭 없으면 404.
    """
    if not _CASE_NO_RE.match(case_no):
        raise HTTPException(
            status_code=400,
            detail="케이스 번호 형식이 올바르지 않습니다 (예: CASE-2026-001).",
        )
    row = (
        await db.execute(
            select(SupportCase)
            .options(
                selectinload(SupportCase.attachments),
                selectinload(SupportCase.comments),
                # products 누락 시 _to_out 의 c.products 접근에서 async lazy load
                # → MissingGreenlet. 다른 query 경로와 동기화.
                selectinload(SupportCase.products),
            )
            .where(SupportCase.case_no == case_no)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="케이스를 찾을 수 없습니다.")
    return await _to_out(db, row)


@router.get("/{case_id}", response_model=SupportCaseOut)
async def get_case(
    case_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    c = await _get_or_404(db, case_id)
    return await _to_out(db, c)


async def _resolve_vendor_id(
    db: AsyncSession, tenant_id: UUID | None, vendor_name: str | None,
) -> UUID | None:
    if tenant_id is None or not vendor_name or not vendor_name.strip():
        return None
    return (await ensure_vendor(db, tenant_id, vendor_name)).id


async def _resolve_case_product_row(
    db: AsyncSession,
    tenant_id: UUID,
    vendor_id: UUID | None,
    item: SupportCaseProductIn,
) -> tuple[UUID, UUID | None]:
    """다이얼로그가 보낸 product 1건 → (product_id, version_id). 이름만 있으면
    lookup-or-create. 신규 등록엔 vendor_id 가 필요 (FK 조건)."""
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


async def _sync_case_products(
    db: AsyncSession,
    c: SupportCase,
    vendor_id: UUID | None,
    items: list[SupportCaseProductIn],
) -> None:
    """SupportCase.products 와 입력 list 의 set 차분 — 회의록 share 패턴."""
    resolved: list[tuple[UUID, UUID | None, int]] = []
    seen: set[UUID] = set()
    for idx, it in enumerate(items):
        pid, veid = await _resolve_case_product_row(db, c.tenant_id, vendor_id, it)
        if pid in seen:
            continue
        seen.add(pid)
        resolved.append((pid, veid, it.sort_order if it.sort_order else idx))

    existing = {sp.product_id: sp for sp in (c.products or [])}
    new_ids = {pid for (pid, _, _) in resolved}
    removed = [pid for pid in existing if pid not in new_ids]
    added = [pid for (pid, _, _) in resolved if pid not in existing]
    for pid, sp in list(existing.items()):
        if pid not in new_ids:
            await db.delete(sp)
    for pid, veid, sort in resolved:
        if pid in existing:
            existing[pid].version_id = veid
            existing[pid].sort_order = sort
        else:
            db.add(
                SupportCaseProduct(
                    tenant_id=c.tenant_id,
                    support_case_id=c.id,
                    product_id=pid,
                    version_id=veid,
                    sort_order=sort,
                )
            )
    await db.flush()
    if added or removed:
        # audit trail — 어떤 케이스에 어떤 제품이 추가·제거됐는지. 변경 없으면 noise 줄임.
        logger.info(
            "support_case products sync: case=%s added=%d removed=%d total=%d",
            c.id, len(added), len(removed), len(resolved),
        )


@router.post("", response_model=SupportCaseOut, status_code=status.HTTP_201_CREATED)
async def create_case(
    payload: SupportCaseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_write(db, user)
    # 케이스 번호 발급 — tenant + 현재 년도 기반.
    case_no: str | None = None
    if user.tenant_id is not None:
        year = datetime.now(timezone.utc).year
        case_no = await _next_case_no(db, user.tenant_id, year)

    vendor_id = await _resolve_vendor_id(db, user.tenant_id, payload.vendor)
    data = payload.model_dump()
    data.pop("vendor", None)
    products_in = [SupportCaseProductIn(**p) for p in (data.pop("products", []) or [])]

    c = SupportCase(
        **data,
        vendor_id=vendor_id,
        case_no=case_no,
        created_by=user.id,
    )
    db.add(c)
    await db.flush()
    await db.refresh(c, attribute_names=["products"])
    await _sync_case_products(db, c, vendor_id, products_in)
    await db.commit()
    c = await _get_or_404(db, c.id)
    logger.info(
        "기술지원 케이스 생성: id=%s case_no=%s customer=%s vendor_id=%s status=%s 제품수=%d (생성자=%s)",
        c.id, c.case_no, c.customer_id, c.vendor_id, c.status, len(products_in), user.id,
    )
    # SUPPORT 역할 임직원에게 DM — 실패는 case 생성에 영향 X.
    try:
        from app.services.support_case_notify import notify_new_support_case

        await notify_new_support_case(db, case_id=c.id)
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("support_case_notify: 발송 실패 case=%s err=%s", c.id, exc)
    return await _to_out(db, c)


_STATUS_LABEL_KO = {"OPEN": "등록", "IN_PROGRESS": "처리중", "CLOSED": "종료"}


@router.patch("/{case_id}", response_model=SupportCaseOut)
async def update_case(
    case_id: UUID,
    payload: SupportCaseUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_write(db, user)
    c = await _get_or_404(db, case_id)
    data = payload.model_dump(exclude_unset=True)
    # CLOSED 로 전환 시점만 별도 권한 — 1차 처리 흐름은 그대로.
    new_status = data.get("status", c.status)
    if "status" in data and new_status == "CLOSED" and c.status != "CLOSED":
        await _require_case_close(db, user)
    # vendor — 단일.
    if "vendor" in payload.model_fields_set:
        data["vendor_id"] = await _resolve_vendor_id(
            db, c.tenant_id, data.pop("vendor", None),
        )
    # products — 명시 지정 시에만 동기화. None 은 미변경.
    products_payload = data.pop("products", None) if "products" in payload.model_fields_set else None

    # 상태 전환 감지. setattr 전에 old/new 확정.
    old_status = c.status
    new_status = data.get("status", old_status)
    status_changed = "status" in data and new_status != old_status

    for k, v in data.items():
        setattr(c, k, v)

    if products_payload is not None:
        items_in = [SupportCaseProductIn(**p) for p in products_payload]
        await _sync_case_products(db, c, c.vendor_id, items_in)

    if status_changed:
        now = datetime.now(timezone.utc)
        if new_status == "CLOSED":
            c.closed_at = now
            c.closed_by = user.id
        elif old_status == "CLOSED":
            # 재오픈 — 메타 reset.
            c.closed_at = None
            c.closed_by = None
        # 시스템 코멘트 자동 작성. author_user_id = NULL → 프론트에서 "시스템" 으로 렌더.
        actor_name = (user.name or user.email or "사용자").strip()
        old_label = _STATUS_LABEL_KO.get(old_status, old_status)
        new_label = _STATUS_LABEL_KO.get(new_status, new_status)
        db.add(
            SupportCaseComment(
                case_id=c.id,
                author_user_id=None,
                body=f"[시스템] {actor_name}님이 상태를 {old_label} → {new_label} 로 변경했습니다.",
            )
        )
        logger.info(
            "케이스 상태 전환: id=%s %s → %s (actor=%s, case_no=%s)",
            case_id, old_status, new_status, user.id, c.case_no,
        )

    await db.commit()
    c = await _get_or_404(db, case_id)
    logger.info(
        "기술지원 케이스 수정: id=%s 변경필드=%s status=%s→%s (수정자=%s)",
        case_id, list(data.keys()), old_status, new_status, user.id,
    )
    return await _to_out(db, c)


@router.delete("/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_case(
    case_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_delete(db, user)
    c = await _get_or_404(db, case_id)
    att_count = len(c.attachments or [])
    for a in c.attachments or []:
        delete_file(a.file_path)
    await db.delete(c)
    await db.commit()
    # 케이스 삭제 = 코멘트·첨부까지 CASCADE 로 사라지므로 warning 으로 기록.
    logger.warning(
        "기술지원 케이스 삭제: id=%s 첨부=%d (삭제자=%s)",
        case_id, att_count, user.id,
    )


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------


@router.post("/{case_id}/attachments", response_model=SupportCaseOut)
async def upload_attachments(
    case_id: UUID,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_write(db, user)
    c = await _get_or_404(db, case_id)
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
        path, size = await save_upload(f, f"support-cases/{c.id}")
        total_size += size
        db.add(
            SupportCaseAttachment(
                case_id=c.id,
                file_name=f.filename or "attachment",
                file_path=path,
                mime_type=mime,
                size=size,
            )
        )
    await db.commit()
    c = await _get_or_404(db, case_id)
    logger.info(
        "케이스 첨부 업로드: id=%s files=%d total=%dKB (업로더=%s)",
        case_id, len(files), total_size // 1024, user.id,
    )
    return await _to_out(db, c)


@router.get("/{case_id}/attachments/{att_id}")
async def download_attachment(
    case_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_permission("support.manage")),
):
    att = (
        await db.execute(
            select(SupportCaseAttachment).where(
                SupportCaseAttachment.id == att_id,
                SupportCaseAttachment.case_id == case_id,
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


@router.patch("/{case_id}/attachments/{att_id}", response_model=SupportCaseAttachmentOut)
async def rename_attachment(
    case_id: UUID,
    att_id: UUID,
    payload: AttachmentRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_write(db, user)
    att = (
        await db.execute(
            select(SupportCaseAttachment).where(
                SupportCaseAttachment.id == att_id,
                SupportCaseAttachment.case_id == case_id,
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
        "케이스 첨부 이름 변경: case=%s att=%s name=%s (수정자=%s)",
        case_id, att_id, new_name, user.id,
    )
    return SupportCaseAttachmentOut.model_validate(att)


@router.delete("/{case_id}/attachments/{att_id}", response_model=SupportCaseOut)
async def delete_attachment(
    case_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_write(db, user)
    att = (
        await db.execute(
            select(SupportCaseAttachment).where(
                SupportCaseAttachment.id == att_id,
                SupportCaseAttachment.case_id == case_id,
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
        "케이스 첨부 삭제: case=%s att=%s name=%s (삭제자=%s)",
        case_id, att_id, file_name, user.id,
    )
    c = await _get_or_404(db, case_id)
    return await _to_out(db, c)


# ---------------------------------------------------------------------------
# Comments — 본인(작성자) 또는 ADMIN 만 수정·삭제.
# ---------------------------------------------------------------------------


def _ensure_can_edit_comment(user: User, cm: SupportCaseComment) -> None:
    if user.role == "ADMIN" or user.role == "SUPER_ADMIN":
        return
    if cm.author_user_id is not None and cm.author_user_id == user.id:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="코멘트 권한 없음")


@router.post("/{case_id}/comments", response_model=SupportCaseOut)
async def add_comment(
    case_id: UUID,
    payload: CommentIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    await _require_case_write(db, user)
    c = await _get_or_404(db, case_id)
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="코멘트 내용이 비어 있습니다.")
    cm = SupportCaseComment(case_id=c.id, author_user_id=user.id, body=body)
    db.add(cm)
    await db.commit()
    await db.refresh(cm)
    c = await _get_or_404(db, case_id)
    logger.info("케이스 코멘트 추가: case=%s 작성자=%s", case_id, user.id)
    # SUPPORT 역할 임직원(작성자 제외)에게 DM — 실패는 응답에 영향 X.
    try:
        from app.services.support_case_notify import notify_new_support_comment

        await notify_new_support_comment(
            db, case_id=c.id, comment_id=cm.id, author_user_id=user.id
        )
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning(
            "support_comment_notify: 발송 실패 case=%s comment=%s err=%s",
            c.id, cm.id, exc,
        )
    return await _to_out(db, c)


@router.patch("/{case_id}/comments/{comment_id}", response_model=SupportCaseOut)
async def edit_comment(
    case_id: UUID,
    comment_id: UUID,
    payload: CommentIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    cm = (
        await db.execute(
            select(SupportCaseComment).where(
                SupportCaseComment.id == comment_id,
                SupportCaseComment.case_id == case_id,
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
    await db.commit()
    c = await _get_or_404(db, case_id)
    logger.info("케이스 코멘트 수정: case=%s comment=%s by=%s", case_id, comment_id, user.id)
    return await _to_out(db, c)


@router.delete("/{case_id}/comments/{comment_id}", response_model=SupportCaseOut)
async def delete_comment(
    case_id: UUID,
    comment_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("support.manage")),
):
    cm = (
        await db.execute(
            select(SupportCaseComment).where(
                SupportCaseComment.id == comment_id,
                SupportCaseComment.case_id == case_id,
            )
        )
    ).scalar_one_or_none()
    if cm is None:
        raise HTTPException(status_code=404, detail="코멘트를 찾을 수 없습니다.")
    _ensure_can_edit_comment(user, cm)
    await db.delete(cm)
    await db.commit()
    c = await _get_or_404(db, case_id)
    logger.warning("케이스 코멘트 삭제: case=%s comment=%s by=%s", case_id, comment_id, user.id)
    return await _to_out(db, c)
