"""도서 API — 회사 도서 대장 + 임대 추적.

Endpoints:
  GET    /books?q=&category=&borrowed=        목록 (검색)
  POST   /books                                등록 (HR/ADMIN)
  PATCH  /books/{id}                           수정 (HR/ADMIN)
  DELETE /books/{id}                           삭제 (HR/ADMIN)

권한:
  - 조회 : 모든 인증 사용자 (회사 자원이라 누구나 열람).
  - 등록·편집·삭제·임대인 변경 : books.manage (HR/ADMIN).

검색: q 가 주어지면 title / publisher / category / 임대인 이름에 대해
ilike. borrowed 필터로 대여중 / 미대여 toggle.

Logging:
  INFO    — 등록 / 수정 / 삭제 성공 시 (감사 로그).
  INFO    — 임대 시작 / 반납 / 임대인 교체 시 (현황 추적용).
  WARNING — 임대 중인 도서를 삭제 / 마감일이 과거인 채로 임대 시작 등
            예외적인 운영 케이스. 백엔드는 막지 않고 흔적만 남긴다.
"""

import logging
from datetime import date as date_cls
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_permission
from app.core.database import get_db
from app.models import Book, Developer, User
from app.schemas.book import BookCreate, BookOut, BookUpdate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/books", tags=["books"])


def _to_out(book: Book, borrower_name: str | None) -> BookOut:
    """ORM Book + 미리 lookup 한 임대인 이름을 BookOut DTO 로 직렬화.

    borrower_name 은 Developer.name JOIN 결과 — 별도 쿼리로 조회한 뒤 주입한다
    (relationship lazy load 시 async session 안에서 추가 round-trip 방지).
    """
    return BookOut(
        id=book.id,
        title=book.title,
        location=book.location,
        publisher=book.publisher,
        category=book.category,
        price=book.price,
        borrower_id=book.borrower_id,
        borrower_name=borrower_name,
        borrowed_at=book.borrowed_at,
        due_date=book.due_date,
        registered_at=book.registered_at,
        note=book.note,
        created_at=book.created_at,
        updated_at=book.updated_at,
    )


@router.get("", response_model=list[BookOut])
async def list_books(
    q: str | None = None,
    category: str | None = None,
    borrowed: bool | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """도서 목록.

    검색은 q 한 단어로 title / publisher / category / 임대인 이름 ilike.
    borrowed=true 면 대여중만, false 면 미대여만, 미지정이면 전체.
    """
    # 임대인 이름은 한 번의 OUTER JOIN 으로 같이 가져온다 — N+1 회피.
    BorrowerDev = Developer
    stmt = (
        select(Book, BorrowerDev.name)
        .outerjoin(BorrowerDev, BorrowerDev.id == Book.borrower_id)
        .order_by(Book.title.asc())
    )
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Book.title.ilike(like),
                Book.publisher.ilike(like),
                Book.category.ilike(like),
                BorrowerDev.name.ilike(like),
            )
        )
    if category and category.strip():
        stmt = stmt.where(Book.category == category.strip())
    if borrowed is True:
        stmt = stmt.where(Book.borrower_id.is_not(None))
    elif borrowed is False:
        stmt = stmt.where(Book.borrower_id.is_(None))

    rows = (await db.execute(stmt)).all()
    return [_to_out(b, name) for b, name in rows]


async def _resolve_borrower_name(
    db: AsyncSession, borrower_id: UUID | None
) -> str | None:
    """임대인 ID 한 명의 이름만 lookup — 등록/수정 직후 응답 직렬화용."""
    if not borrower_id:
        return None
    return (
        await db.execute(
            select(Developer.name).where(Developer.id == borrower_id)
        )
    ).scalar_one_or_none()


@router.post("", response_model=BookOut, status_code=status.HTTP_201_CREATED)
async def create_book(
    payload: BookCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("books.manage")),
):
    """신규 도서 등록.

    borrower_id 가 함께 들어오면 등록과 동시에 임대 상태로 생성된다.
    그 경우 frontend 가 borrowed_at = now() 를 채워 넘긴다 (서버는 그대로 저장).
    """
    book = Book(
        title=payload.title.strip(),
        publisher=payload.publisher,
        category=payload.category,
        price=payload.price,
        borrower_id=payload.borrower_id,
        borrowed_at=payload.borrowed_at,
        due_date=payload.due_date,
        registered_at=payload.registered_at,
        note=payload.note,
    )
    db.add(book)
    await db.commit()
    await db.refresh(book)
    name = await _resolve_borrower_name(db, book.borrower_id)
    logger.info(
        "도서 등록: id=%s title=%s borrower=%s (요청자=%s)",
        book.id, book.title, book.borrower_id, user.id,
    )
    # 등록 시점에 이미 임대 상태인 케이스 — 흔치 않으므로 흔적만 남긴다.
    if book.borrower_id:
        logger.info(
            "도서 등록 + 임대 시작: id=%s borrower=%s (%s) due=%s",
            book.id, book.borrower_id, name, book.due_date,
        )
        # 등록 시점에 이미 due_date 가 과거라면 운영 실수 가능성 → WARNING.
        if book.due_date and book.due_date < date_cls.today():
            logger.warning(
                "신규 도서의 반납 예정일이 과거: id=%s due=%s today=%s",
                book.id, book.due_date, date_cls.today(),
            )
    return _to_out(book, name)


@router.patch("/{book_id}", response_model=BookOut)
async def update_book(
    book_id: UUID,
    payload: BookUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("books.manage")),
):
    """도서 수정.

    임대 워크플로 (UI 가 묶어서 한 PATCH 로 보낸다):
      * 임대 시작  : borrower_id 새로 지정 + borrowed_at = now() (FE 가 세팅).
      * 반납       : borrower_id = None + borrowed_at = None.
      * 임대인 교체: borrower_id 변경 (이력 보존 X — 기존 임대인 정보 덮어씀).
    백엔드는 클라이언트 의도를 가공하지 않고 그대로 반영한다 — 다만 위 3가지
    상태 전환은 INFO 로 별도 logging 해 운영팀이 추적할 수 있게 한다.
    """
    book = (
        await db.execute(select(Book).where(Book.id == book_id))
    ).scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=404, detail="도서를 찾을 수 없습니다.")
    data = payload.model_dump(exclude_unset=True)
    # 임대 상태 변화 감지 — apply 전 snapshot.
    prev_borrower = book.borrower_id
    for k, v in data.items():
        if k == "title" and v:
            v = v.strip()
        setattr(book, k, v)
    await db.commit()
    await db.refresh(book)
    name = await _resolve_borrower_name(db, book.borrower_id)
    logger.info(
        "도서 수정: id=%s 변경=%s (요청자=%s)",
        book.id, list(data.keys()), user.id,
    )
    # 임대 상태 전환별 logging — 사후 추적성.
    if "borrower_id" in data and prev_borrower != book.borrower_id:
        if prev_borrower is None and book.borrower_id is not None:
            logger.info(
                "임대 시작: id=%s title=%s borrower=%s (%s) due=%s 처리자=%s",
                book.id, book.title, book.borrower_id, name,
                book.due_date, user.id,
            )
            if book.due_date and book.due_date < date_cls.today():
                logger.warning(
                    "임대 시작 시 반납 예정일이 이미 과거: id=%s due=%s today=%s",
                    book.id, book.due_date, date_cls.today(),
                )
        elif prev_borrower is not None and book.borrower_id is None:
            logger.info(
                "반납 처리: id=%s title=%s 이전 임대인=%s 처리자=%s",
                book.id, book.title, prev_borrower, user.id,
            )
        else:
            # 한 단계로 임대인 교체 — 이력 보존하지 않는 모델 특성상 명시 logging.
            logger.warning(
                "임대인 교체 (이전 기록 덮어씀): id=%s title=%s "
                "이전=%s → 신규=%s (%s) 처리자=%s",
                book.id, book.title, prev_borrower, book.borrower_id,
                name, user.id,
            )
    return _to_out(book, name)


@router.delete("/{book_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_book(
    book_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("books.manage")),
):
    """도서 삭제 (hard delete).

    임대 중인 도서도 삭제 가능하지만 WARNING 로깅으로 흔적을 남긴다.
    프런트는 사용자에게 confirm 다이얼로그를 한 번 더 노출한다.
    """
    book = (
        await db.execute(select(Book).where(Book.id == book_id))
    ).scalar_one_or_none()
    if not book:
        raise HTTPException(status_code=404, detail="도서를 찾을 수 없습니다.")
    if book.borrower_id:
        # 임대 중인 도서를 삭제하는 경우 — 백엔드는 막지 않고 WARNING 로깅만.
        # 프런트는 confirm 으로 사용자에게 한 번 더 안내.
        logger.warning(
            "임대 중인 도서 삭제: id=%s title=%s borrower=%s 삭제자=%s",
            book.id, book.title, book.borrower_id, user.id,
        )
    await db.delete(book)
    await db.commit()
    logger.info("도서 삭제: id=%s title=%s 삭제자=%s", book_id, book.title, user.id)
