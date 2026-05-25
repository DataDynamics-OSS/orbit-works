import logging
from datetime import date
from typing import Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import (
    get_current_user,
    has_feature,
    require_admin,
    require_feature,
    require_permission,
)
from app.core.database import get_db
from app.core.secrets_crypto import decrypt_secret
from app.models import (
    Assignment,
    Developer,
    DeveloperApprover,
    DeveloperCertification,
    DeveloperEmergencyContact,
    DeveloperExperience,
    DeveloperPassport,
    DeveloperProfile,
    DeveloperResume,
    DeveloperSalary,
    Project,
    User,
)
from app.schemas.auth import InitialPasswordRequest
from app.schemas.developer import (
    DeveloperApproverInput,
    DeveloperApproverOut,
    DeveloperAssignmentHistory,
    DeveloperChangePassword,
    DeveloperCreate,
    DeveloperDirectoryOut,
    DeveloperOut,
    DeveloperPasswordUpdate,
    DeveloperRosterRow,
    PasswordResetResult,
    DeveloperResumeOut,
    RosterEmergencyContact,
    RosterPassport,
    DeveloperResumeUpdate,
    DeveloperUpdate,
    MyProfileOut,
    MyProfileUpdate,
    ResumeBundleOut,
    ResumeCertificationInput,
    ResumeCertificationOut,
    ResumeExperienceInput,
    ResumeExperienceOut,
    ResumeProfileOut,
    ResumeProfileUpdate,
)
from app.services.storage import delete_file, resolve_upload_path, save_upload

RESUME_ACCESS_ROLES = {"ADMIN", "HR", "SALES"}

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/developers", tags=["developers"])


def _dev_stmt():
    return select(Developer).options(selectinload(Developer.resumes))


async def _retag_same_name(db: AsyncSession, name: str) -> None:
    """동명이인 태깅.

    주어진 `name` 을 가진 ACTIVE 임직원을 `created_at ASC` 로 정렬해:
    - 1명뿐이면 `tag = NULL`
    - 2명 이상이면 'A', 'B', 'C', ... 순으로 재부여 (기존 tag 덮어씀).

    create / update(name 변경) 시 양쪽 이름 그룹에 대해 호출.
    """
    rows = list(
        (
            await db.execute(
                select(Developer)
                .where(Developer.status == "ACTIVE", Developer.name == name)
                .order_by(Developer.created_at.asc(), Developer.id.asc())
            )
        ).scalars()
    )
    if len(rows) <= 1:
        for r in rows:
            r.tag = None
    else:
        for i, r in enumerate(rows):
            r.tag = chr(ord("A") + i) if i < 26 else f"A{i - 25}"


async def _next_employee_no(
    db: AsyncSession, tenant_id, *, special: bool = False
) -> str:
    """tenant 별 다음 사번 = max + 1, 5자리 zero-padded.

    - special=False (일반 정규직): 1 ~ 89999 범위. 시작 00001.
    - special=True  (정규직 특수): 90000 ~ 99999 범위. 시작 90000.

    advisory_xact_lock 으로 같은 tenant 의 동시 등록을 직렬화 — 트랜잭션
    종료(commit/rollback) 시 자동 해제. 5자리 zero-padded 끼리는 사전순=정수순
    이라 max() 가 올바르게 동작한다.
    """
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:t))"),
        {"t": str(tenant_id)},
    )
    stmt = (
        select(func.max(Developer.employee_no))
        .where(Developer.tenant_id == tenant_id)
        .where(Developer.employee_no.isnot(None))
    )
    if special:
        stmt = stmt.where(Developer.employee_no >= "90000")
    else:
        stmt = stmt.where(Developer.employee_no < "90000")
    row = (await db.execute(stmt)).scalar()
    base = 89999 if special else 0
    next_n = (int(row) if row else base) + 1
    return f"{next_n:05d}"


async def _attach_latest_salary(
    db: AsyncSession, developers: Iterable[Developer]
) -> list[Developer]:
    devs = list(developers)
    ids = [d.id for d in devs]
    if not ids:
        return devs
    today = date.today()
    rows = (
        await db.execute(
            select(
                DeveloperSalary.developer_id,
                DeveloperSalary.annual_salary,
                DeveloperSalary.effective_from,
            ).where(
                DeveloperSalary.developer_id.in_(ids),
                DeveloperSalary.effective_from <= today,
                or_(
                    DeveloperSalary.effective_to.is_(None),
                    DeveloperSalary.effective_to >= today,
                ),
            )
        )
    ).all()
    latest: dict[UUID, tuple] = {}
    for dev_id, salary, eff in rows:
        prev = latest.get(dev_id)
        if prev is None or eff > prev[1]:
            latest[dev_id] = (salary, eff)
    for d in devs:
        pair = latest.get(d.id)
        # Fall back to legacy salary column when no history exists
        d.latest_salary = pair[0] if pair else d.salary  # type: ignore[attr-defined]
    return devs


# ---------------------------------------------------------------------------
# 글로벌 상위 관리자 후보 — `/{dev_id}` GET 라우트보다 먼저 등록되어야
# `/manager-candidates` literal 이 UUID 파싱(422)에 잡히지 않는다.
# ---------------------------------------------------------------------------


class ManagerCandidateOut(BaseModel):
    id: UUID
    name: str
    title: str | None = None
    employee_no: str | None = None

    class Config:
        from_attributes = True


class OrgChartNode(BaseModel):
    id: UUID
    name: str
    title: str | None = None
    employee_no: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    emergency_contact_name: str | None = None
    emergency_contact_phone: str | None = None
    hire_date: date | None = None
    # 입사 시점의 누적 경력 (개월). UI 가 hire_date 부터의 근무기간과 합산해
    # "총 경력" 을 표시.
    career_months_at_hire: int | None = None
    security_role: str
    employment_type: str
    manager_id: UUID | None = None
    report_count: int = 0
    rank_name: str | None = None
    position_name: str | None = None


@router.get("/org-chart", response_model=list[OrgChartNode])
async def get_org_chart(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """결재선 시각화 — ACTIVE FULL_TIME 임직원 + manager_id 관계.

    인증된 사용자 모두 조회 가능 — 회사 내부 조직도.
    표시 대상: status='ACTIVE' AND employment_type='FULL_TIME'.
    UI 클릭 시 노드별로 phone/email/title 을 popover 로 노출.
    report_count: 직속 부하 수 (FULL_TIME 기준).
    """
    from app.models import JobPosition as _JobPos, JobRank as _JobRank

    rows = (
        await db.execute(
            select(
                Developer,
                _JobRank.name.label("rank_name"),
                _JobPos.name.label("position_name"),
            )
            .outerjoin(_JobRank, _JobRank.id == Developer.rank_id)
            .outerjoin(_JobPos, _JobPos.id == Developer.position_id)
            .where(
                Developer.status == "ACTIVE",
                Developer.employment_type == "FULL_TIME",
            )
        )
    ).all()

    # 부하 수 집계 — 한 번 순회.
    report_count: dict[UUID, int] = {}
    for d, _r, _p in rows:
        if d.manager_id:
            report_count[d.manager_id] = report_count.get(d.manager_id, 0) + 1

    return [
        OrgChartNode(
            id=d.id,
            name=d.name,
            title=d.title,
            employee_no=d.employee_no,
            phone=d.phone,
            email=d.company_email or d.personal_email,
            address=d.address,
            emergency_contact_name=d.emergency_contact_name,
            emergency_contact_phone=d.emergency_contact_phone,
            hire_date=d.hire_date,
            career_months_at_hire=d.career_months_at_hire,
            security_role=d.security_role,
            employment_type=d.employment_type,
            manager_id=d.manager_id,
            report_count=report_count.get(d.id, 0),
            rank_name=rank_name,
            position_name=position_name,
        )
        for d, rank_name, position_name in rows
    ]


@router.get(
    "/manager-candidates",
    response_model=list[ManagerCandidateOut],
)
async def list_global_manager_candidates(
    exclude_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """상위 관리자 콤보박스 — ACTIVE 정규직 전체.

    - 후보: employment_type IN ('FULL_TIME','FULL_TIME_SPECIAL') AND status='ACTIVE'
    - exclude_id: 수정 모드에서 자기 자신만 빼고 싶을 때 사용. 사이클 방지는
      PATCH 단의 SQL CTE 가드가 막으므로 UI 단계에선 자기 자신만 제외해도 충분.
    - 정렬: 이름순.
    - 권한: HR/ADMIN.
    """
    if user.role not in ("ADMIN", "HR"):
        raise HTTPException(status_code=403, detail="HR/ADMIN 만 가능합니다.")

    stmt = (
        select(Developer)
        .where(
            Developer.status == "ACTIVE",
            Developer.employment_type.in_(["FULL_TIME", "FULL_TIME_SPECIAL"]),
        )
        .order_by(Developer.name)
    )
    if exclude_id:
        stmt = stmt.where(Developer.id != exclude_id)
    rows = (await db.execute(stmt)).scalars().all()
    return rows


@router.get("", response_model=list[DeveloperOut])
async def list_developers(
    q: str | None = None,
    status_filter: str | None = None,
    employment_type: str | None = None,
    # `directory.excluded_developer_ids` 자동 제외 여부.
    # - 기본 False — 주소록·할당·자산 등 일반 picker 는 숨김 리스트 반영.
    # - True — Employees 페이지처럼 전체 임직원이 보여야 하는 경우.
    # Payroll 은 별도 엔드포인트(/payroll/runs/{id}/available-developers)를 사용하므로
    # 이 파라미터 영향을 받지 않는다.
    include_hidden: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = _dev_stmt().order_by(Developer.created_at.desc())
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            or_(
                Developer.name.ilike(pattern),
                Developer.phone.ilike(pattern),
                Developer.company_email.ilike(pattern),
            )
        )
    if status_filter:
        stmt = stmt.where(Developer.status == status_filter)
    if employment_type:
        stmt = stmt.where(Developer.employment_type == employment_type)
    if not include_hidden:
        # 순환 import 회피 — 런타임 시 현재 설정에서 숨김 리스트 로드.
        from app.core.config import get_settings

        hidden = get_settings().directory.excluded_developer_ids or []
        if hidden:
            stmt = stmt.where(Developer.id.notin_(hidden))
    result = await db.execute(stmt)
    devs = await _attach_latest_salary(db, result.scalars().all())
    # user_id 부착 — 단건 조회와 동일하게 list 응답에도 매핑된 사용자 ID를
    # 채워준다 (User.mapped_developer_id 역방향). picker UI 가 user 단위로
    # tech_support_user_id 같은 FK 를 세팅할 때 필요.
    dev_ids = [d.id for d in devs]
    if dev_ids:
        mapped_rows = (
            await db.execute(
                select(User.mapped_developer_id, User.id).where(
                    User.mapped_developer_id.in_(dev_ids), User.is_active.is_(True),
                )
            )
        ).all()
        user_by_dev = {dev_id: uid for (dev_id, uid) in mapped_rows}
        for d in devs:
            d.user_id = user_by_dev.get(d.id)  # type: ignore[attr-defined]
    # 보안: 급여 정보 조회 권한 없는 사용자에게는 응답에서 금액 제거.
    # Settings > 메뉴 권한 > 기능 권한 의 `employees.salary.view` 로 통제.
    if not await has_feature(db, user, "employees.salary.view"):
        for d in devs:
            d.salary = None
            d.hourly_rate = None
            d.latest_salary = None  # type: ignore[attr-defined]
    return devs


async def _resolve_my_developer(
    db: AsyncSession, user: User
) -> Developer:
    stmt = select(Developer).where(
        Developer.status == "ACTIVE",
        (Developer.company_email == user.email) | (Developer.personal_email == user.email),
    )
    dev = (await db.execute(stmt)).scalars().first()
    if dev is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="현재 로그인 계정과 연결된 활성 임직원 레코드가 없습니다.",
        )
    return dev


@router.get("/me/profile", response_model=MyProfileOut)
async def get_my_profile(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dev = await _resolve_my_developer(db, user)
    return MyProfileOut(
        developer_id=dev.id,
        name=dev.name,
        company_email=dev.company_email,
        phone=dev.phone,
        hire_date=dev.hire_date,
        address=dev.address,
        emergency_contact_name=dev.emergency_contact_name,
        emergency_contact_phone=dev.emergency_contact_phone,
    )


@router.patch("/me/profile", response_model=MyProfileOut)
async def update_my_profile(
    payload: MyProfileUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dev = await _resolve_my_developer(db, user)
    data = payload.model_dump(exclude_unset=True)
    # 빈 문자열은 NULL 로 저장 (선택 항목)
    for k, v in list(data.items()):
        if isinstance(v, str) and v.strip() == "":
            data[k] = None
    for k, v in data.items():
        setattr(dev, k, v)
    await db.commit()
    await db.refresh(dev)
    logger.info(
        "내 프로필 수정: dev=%s 변경필드=%s", dev.id, list(data.keys())
    )
    return MyProfileOut(
        developer_id=dev.id,
        name=dev.name,
        company_email=dev.company_email,
        phone=dev.phone,
        hire_date=dev.hire_date,
        address=dev.address,
        emergency_contact_name=dev.emergency_contact_name,
        emergency_contact_phone=dev.emergency_contact_phone,
    )


@router.get("/directory", response_model=list[DeveloperDirectoryOut])
async def list_developer_directory(
    employment_type: str | None = None,
    include_hidden: bool = False,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """ACTIVE 임직원의 경량 디렉토리. 회의 참석자 선택 등에 사용.

    이름 가나다순 정렬. employment_type(예: FULL_TIME) 로 필터 가능.
    directory.excluded_developer_ids 에 포함된 직원은 자동 제외
    (include_hidden=true 일 때만 표시).
    """
    stmt = select(Developer).where(Developer.status == "ACTIVE")
    if employment_type:
        stmt = stmt.where(Developer.employment_type == employment_type)
    if not include_hidden:
        from app.core.config import get_settings

        hidden = get_settings().directory.excluded_developer_ids or []
        if hidden:
            stmt = stmt.where(Developer.id.notin_(hidden))
    stmt = stmt.order_by(Developer.name.asc())
    rows = list((await db.execute(stmt)).scalars())
    return [
        DeveloperDirectoryOut(
            id=d.id,
            name=d.name,
            tag=d.tag,
            email=d.company_email or d.personal_email,
            phone=d.phone,
            employment_type=d.employment_type,
            title=d.title,
            gender=_gender_from_resident(d.resident_number),
        )
        for d in rows
    ]


class BirthdayRow(BaseModel):
    """생일자 카드 응답 — 사이드바·대시보드 표시 전용."""

    id: UUID
    name: str
    month: int   # 1~12
    day: int     # 1~31
    tag: str | None = None


@router.get("/birthdays", response_model=list[BirthdayRow])
async def list_birthdays_this_month(
    month: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """이번 달 생일자 — 모든 인증 사용자 공개. resident_number 의 앞 4자
    (MMDD) 만 사용해 연도(=나이) 노출 X. ACTIVE FULL_TIME 임직원만.

    month 미지정이면 현재 달 (KST 기준 - 서버 timezone 가정 무시하고
    호출자 클라이언트 측에서 지정 가능).
    """
    from datetime import date as _date
    target_month = month if month and 1 <= month <= 12 else _date.today().month

    rows = (
        await db.execute(
            select(Developer.id, Developer.name, Developer.tag, Developer.resident_number)
            .where(
                Developer.status == "ACTIVE",
                Developer.employment_type == "FULL_TIME",
            )
        )
    ).all()

    out: list[BirthdayRow] = []
    for d_id, name, tag, rn in rows:
        if not rn:
            continue
        s = rn.replace("-", "").strip()
        if len(s) < 6 or not s[:6].isdigit():
            continue
        mm = int(s[2:4])
        dd = int(s[4:6])
        if mm != target_month:
            continue
        if not (1 <= mm <= 12 and 1 <= dd <= 31):
            continue
        out.append(BirthdayRow(id=d_id, name=name, month=mm, day=dd, tag=tag))
    out.sort(key=lambda r: (r.day, r.name))
    return out


def _gender_from_resident(rn: str | None) -> str | None:
    """주민번호 7번째 자리(성별/세기 코드) 로 'M'/'F' 도출. 미입력/오류 시 None.

    1·3·5·7·9 → 남자, 2·4·6·8·0 → 여자. (외국인 5~8, 1800년대 9·0 포함.)
    """
    if not rn:
        return None
    s = rn.replace("-", "").strip()
    if len(s) < 7:
        return None
    c = s[6]
    if c in ("1", "3", "5", "7", "9"):
        return "M"
    if c in ("2", "4", "6", "8", "0"):
        return "F"
    return None


def _birth_date_from_resident(rn: str | None) -> date | None:
    """주민번호 앞 6 (YYMMDD) + 7번째(성별/세기 코드) 로 YYYY-MM-DD 도출.

    7번째 코드:
      1·2 → 19xx (한국 국적)
      3·4 → 20xx
      5·6 → 19xx (외국인)
      7·8 → 20xx (외국인)
      9·0 → 18xx (드묾)
    """
    if not rn:
        return None
    s = rn.replace("-", "").strip()
    if len(s) < 7 or not s[:6].isdigit():
        return None
    yy = int(s[0:2])
    mm = int(s[2:4])
    dd = int(s[4:6])
    code = s[6]
    if code in ("1", "2", "5", "6"):
        year = 1900 + yy
    elif code in ("3", "4", "7", "8"):
        year = 2000 + yy
    elif code in ("9", "0"):
        year = 1800 + yy
    else:
        return None
    try:
        return date(year, mm, dd)
    except ValueError:
        return None


@router.get("/roster", response_model=list[DeveloperRosterRow])
async def developer_roster(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("developers.manage")),
):
    """정규직(FULL_TIME) + 재직자(ACTIVE) 명부 — PDF 출력용.

    여권 / 비상연락처는 1:1 / 1:N 별도 테이블 join 으로 채움.
    여권번호는 Fernet 복호화 후 평문으로 반환 (HR/ADMIN 만 호출 가능).
    """
    rows = list(
        (
            await db.execute(
                select(Developer)
                .options(
                    selectinload(Developer.passport_record),
                    selectinload(Developer.emergency_contacts),
                )
                .where(
                    Developer.status == "ACTIVE",
                    Developer.employment_type == "FULL_TIME",
                )
                .order_by(Developer.name.asc())
            )
        ).scalars()
    )

    out: list[DeveloperRosterRow] = []
    for d in rows:
        passport = None
        if d.passport_record:
            p = d.passport_record
            # passport_number_enc 는 Fernet 암호화 토큰 ('enc:' prefix). 응답엔 평문.
            # 권한은 엔드포인트 단의 require_permission('developers.manage') 로 차단됨.
            passport = RosterPassport(
                passport_number=(
                    decrypt_secret(p.passport_number_enc) if p.passport_number_enc else None
                ),
                surname_en=p.surname_en,
                given_name_en=p.given_name_en,
                issue_date=p.issue_date,
                expiry_date=p.expiry_date,
            )
        contacts = sorted(
            (d.emergency_contacts or []), key=lambda c: c.position
        )
        out.append(
            DeveloperRosterRow(
                id=d.id,
                name=d.name,
                employee_no=d.employee_no,
                phone=d.phone,
                email=d.company_email or d.personal_email,
                address=d.address,
                hire_date=d.hire_date,
                birth_date=_birth_date_from_resident(d.resident_number),
                gender=_gender_from_resident(d.resident_number),  # type: ignore[arg-type]
                passport=passport,
                emergency_contacts=[
                    RosterEmergencyContact(name=c.name, relation=c.relation, phone=c.phone)
                    for c in contacts
                ],
            )
        )
    # 여권번호 평문 노출 — 누가 언제 명부를 뽑았는지 audit log 보강용 INFO.
    logger.info(
        "임직원 명부(roster) 조회: 인원=%d 조회자=%s",
        len(out), user.id,
    )
    return out


@router.post("", response_model=DeveloperOut, status_code=status.HTTP_201_CREATED)
async def create_developer(
    payload: DeveloperCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_feature("employees.create")),
):
    from app.core.security import hash_password
    from app.services.developer_auth import notify_new_developer_password

    # company_email 중복 체크 (로그인 ID 라 unique 이어야 함).
    # 프리랜서는 company_email 이 비어 있을 수 있으므로 값이 있을 때만 검사.
    if payload.company_email:
        dup = (
            await db.execute(
                select(Developer).where(
                    Developer.company_email == payload.company_email
                )
            )
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(
                status_code=400,
                detail=f"이미 등록된 회사 이메일입니다: {payload.company_email}",
            )

    # 초기 비밀번호 = 주민등록번호 앞 6자리(생년월일). 직원은 최초 로그인 시
    # 반드시 변경해야 한다.
    plain_pw = payload.resident_number.split("-")[0]

    data = payload.model_dump()
    # security_role 부여 — `employees.role.edit` 기능 권한이 있어야 명시 가능.
    # 권한이 없으면 ETC 로 강제. HR→ADMIN 부여는 코드 invariant 로 별도 차단.
    can_edit_role = await has_feature(db, user, "employees.role.edit")
    requested_role = data.get("security_role") or "ETC"
    if not can_edit_role:
        data["security_role"] = "ETC"
    elif requested_role not in ("ADMIN", "SALES", "HR", "SUPPORT", "ETC"):
        raise HTTPException(status_code=400, detail=f"허용되지 않은 보안등급: {requested_role}")
    elif user.role == "HR" and requested_role == "ADMIN":
        raise HTTPException(status_code=403, detail="HR 은 ADMIN 등급을 부여할 수 없습니다.")
    else:
        data["security_role"] = requested_role
    # manager_id (상위 관리자) — role.edit 권한 보유자만 등록 시점에 지정 가능.
    if data.get("manager_id") and not can_edit_role:
        data["manager_id"] = None
    # 정규직은 사번 자동 부여. 특수 정규직은 90000+ 별도 시퀀스.
    et = data.get("employment_type")
    if et in ("FULL_TIME", "FULL_TIME_SPECIAL"):
        data["employee_no"] = await _next_employee_no(
            db, user.tenant_id, special=(et == "FULL_TIME_SPECIAL")
        )
    dev = Developer(**data, hashed_password=hash_password(plain_pw))
    db.add(dev)
    await db.commit()
    # 같은 이름 그룹에 태그 재부여 (신규 포함).
    await _retag_same_name(db, dev.name)
    # L1 자동 매핑 — 같은 이메일을 가진 user 가 이미 있으면 그 user 의
    # mapped_developer_id 를 신규 developer 로 채움 (미로그인 사용자 포함).
    from app.services.user_developer_sync import propagate_developer_mapping
    await propagate_developer_mapping(db, dev)
    await db.commit()
    await db.refresh(dev, attribute_names=["resumes"])
    await _attach_latest_salary(db, [dev])
    logger.info(
        "임직원 등록: id=%s name=%s tag=%s employment_type=%s email=%s (등록자=%s)",
        dev.id,
        dev.name,
        dev.tag,
        dev.employment_type,
        dev.company_email,
        user.id,
    )
    # HR + ADMIN 에게 Slack 으로 초기 비번 전달
    try:
        await notify_new_developer_password(db, dev, plain_pw)
    except Exception as exc:  # pragma: no cover
        logger.warning("신규 임직원 비번 Slack 알림 실패: %s", exc, exc_info=True)
    return dev


def _reject_birthday_password(resident_number: str | None, new_pw: str) -> None:
    """새 비밀번호가 주민번호 앞 6자리(생년월일)와 같으면 400."""
    if not resident_number:
        return
    first6 = resident_number.split("-")[0].strip()
    if first6 and new_pw == first6:
        raise HTTPException(
            status_code=400,
            detail="생년월일(주민등록번호 앞 6자리)은 비밀번호로 사용할 수 없습니다.",
        )


@router.patch("/{dev_id}/password", status_code=status.HTTP_204_NO_CONTENT)
async def reset_developer_password(
    dev_id: UUID,
    payload: DeveloperPasswordUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """관리자가 임직원 비밀번호를 재설정."""
    from app.core.security import hash_password

    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="Developer not found")
    _reject_birthday_password(dev.resident_number, payload.new_password)
    dev.hashed_password = hash_password(payload.new_password)
    await db.commit()
    logger.warning(
        "임직원 비밀번호 재설정: dev=%s email=%s (admin=%s)",
        dev.id, dev.company_email, admin.id,
    )


@router.post("/me/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_my_password(
    payload: DeveloperChangePassword,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인(로그인한 임직원) 비밀번호 변경. 모바일 프로필에서 사용."""
    from app.core.security import hash_password, verify_password

    dev = await _resolve_my_developer(db, user)
    if (
        not dev.hashed_password
        or not verify_password(payload.current_password, dev.hashed_password)
    ):
        raise HTTPException(status_code=400, detail="현재 비밀번호가 일치하지 않습니다.")
    _reject_birthday_password(dev.resident_number, payload.new_password)
    dev.hashed_password = hash_password(payload.new_password)
    # 관리자가 재설정한 플래그를 본인이 변경함으로써 해제.
    dev.password_reset_required = False
    await db.commit()
    logger.info("임직원 비밀번호 변경 (본인): dev=%s", dev.id)


@router.post("/me/initial-password", status_code=status.HTTP_204_NO_CONTENT)
async def set_initial_password(
    payload: InitialPasswordRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """첫 로그인(생년월일) 또는 관리자 재설정 직후 강제 변경.

    `current_password` 를 받지 않는다 — 사용자는 자기 비번을 모르는 상태(생년월일은
    UI 에서 입력 안 함, 자동 대체) 일 수 있으므로. 대신 서버가 다음 조건 중 하나
    를 만족할 때만 허용 (그 외 403):

    1) `password_reset_required = true` (관리자가 방금 초기화)
    2) 현재 hashed_password 가 생년월일과 매치 (= 첫 로그인 직후)
    3) hashed_password 가 비어 있음 (= 비번 미설정 상태)

    설정 후 password_reset_required 플래그를 즉시 해제 + 새 해시 저장.
    """
    from app.core.security import hash_password, verify_password

    dev = await _resolve_my_developer(db, user)

    eligible = False
    if dev.password_reset_required:
        eligible = True
    elif not dev.hashed_password:
        eligible = True
    elif dev.resident_number:
        first6 = (dev.resident_number.split("-")[0] or "").strip()
        if first6 and verify_password(first6, dev.hashed_password):
            eligible = True
    if not eligible:
        raise HTTPException(
            status_code=403,
            detail="강제 변경 대상이 아닙니다. 일반 비밀번호 변경 메뉴를 이용해 주세요.",
        )

    _reject_birthday_password(dev.resident_number, payload.new_password)
    dev.hashed_password = hash_password(payload.new_password)
    dev.password_reset_required = False
    await db.commit()
    logger.info("임직원 초기 비밀번호 설정 (본인): dev=%s", dev.id)


@router.post("/{dev_id}/password/reset", response_model=PasswordResetResult)
async def reset_developer_password_by_admin(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_feature("employees.password.reset")),
) -> PasswordResetResult:
    """관리자(HR·ADMIN) 가 임직원 비밀번호를 강제 초기화.

    기본 동작: 주민등록번호 앞 6자리(생년월일) 로 초기화.
    주민등록번호가 비어 있어 초기화 불가한 경우: 랜덤 12자 임시 비번 생성 후
    응답에 평문으로 1회 반환 (UI 팝업용, 저장/로그 안 됨).

    어느 경우든 `password_reset_required=True` 로 세팅 → 본인이 첫 로그인 시
    /me/change-password 호출로 강제 변경.

    권한: `employees.password.reset` 기능 권한. HR→ADMIN 대상 차단은 코드 invariant.
    """
    from app.core.security import hash_password
    from app.services.developer_auth import generate_temp_password

    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="Developer not found")
    # HR→ADMIN 권한 상승 차단 — feature_permission 으로 못 풀게 하는 invariant.
    if user.role == "HR" and dev.security_role == "ADMIN":
        raise HTTPException(
            status_code=403,
            detail="HR 은 ADMIN 등급 임직원의 비밀번호를 재설정할 수 없습니다.",
        )

    rn = (dev.resident_number or "").strip()
    first6 = rn.split("-")[0] if rn else ""
    if first6 and len(first6) == 6 and first6.isdigit():
        dev.hashed_password = hash_password(first6)
        dev.password_reset_required = True
        await db.commit()
        logger.warning(
            "임직원 비밀번호 재설정 (생년월일): dev=%s email=%s 관리자=%s",
            dev.id, dev.company_email, user.id,
        )
        return PasswordResetResult(mode="birthday", temp_password=None)

    # 주민번호 없음 → 랜덤 임시 비번 생성.
    temp_pw = generate_temp_password(12)
    dev.hashed_password = hash_password(temp_pw)
    dev.password_reset_required = True
    await db.commit()
    logger.warning(
        "임직원 비밀번호 재설정 (랜덤): dev=%s email=%s 관리자=%s "
        "(주민번호 없음 — 생년월일 초기화 불가)",
        dev.id, dev.company_email, user.id,
    )
    return PasswordResetResult(mode="random", temp_password=temp_pw)





@router.get("/{dev_id}", response_model=DeveloperOut)
async def get_developer(
    dev_id: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)
):
    result = await db.execute(_dev_stmt().where(Developer.id == dev_id))
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="Developer not found")
    await _attach_latest_salary(db, [dev])
    # 매핑된 user_id 동적 부착 — DeveloperOut 의 user_id 필드로 직렬화됨.
    # 매핑된 user 가 없거나 비활성이면 None 으로 남는다.
    mapped = await db.execute(
        select(User.id).where(
            User.mapped_developer_id == dev.id, User.is_active.is_(True),
        )
    )
    dev.user_id = mapped.scalar_one_or_none()
    return dev


@router.patch("/{dev_id}", response_model=DeveloperOut)
async def update_developer(
    dev_id: UUID,
    payload: DeveloperUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(_dev_stmt().where(Developer.id == dev_id))
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="Developer not found")
    data = payload.model_dump(exclude_unset=True)
    prev_resigned = dev.resigned_date
    prev_name = dev.name
    prev_status = dev.status
    # 이메일 변경 추적 — 변경됐으면 트랜잭션 마지막에 user 매핑 재전파(L1).
    prev_company_email = dev.company_email
    prev_personal_email = dev.personal_email

    # manager_id (상위 관리자 / 1차 결재자) 변경 — HR/ADMIN 만.
    # 자기 자신 / 사이클 / 깊이 10 검증.
    # 직위·직책 sync — title (varchar) 도 직책명(있으면) 또는 직위명으로 갱신.
    # 우선순위: 명시적 title > 직책명 > 직위명.
    if ("rank_id" in data and data["rank_id"] is not None) or (
        "position_id" in data and data["position_id"] is not None
    ):
        from app.models import JobPosition as _JobPosition, JobRank as _JobRank

        rank_name: str | None = None
        position_name: str | None = None
        if data.get("rank_id"):
            r = (
                await db.execute(select(_JobRank).where(_JobRank.id == data["rank_id"]))
            ).scalar_one_or_none()
            if not r:
                raise HTTPException(status_code=400, detail="존재하지 않는 직위입니다.")
            rank_name = r.name
        if data.get("position_id"):
            p = (
                await db.execute(
                    select(_JobPosition).where(_JobPosition.id == data["position_id"])
                )
            ).scalar_one_or_none()
            if not p:
                raise HTTPException(status_code=400, detail="존재하지 않는 직책입니다.")
            position_name = p.name
        if "title" not in data:
            data["title"] = position_name or rank_name

    if "manager_id" in data:
        if not await has_feature(db, user, "employees.role.edit"):
            raise HTTPException(
                status_code=403,
                detail="상위 관리자 변경 권한이 없습니다.",
            )
        new_mgr_id = data["manager_id"]
        if new_mgr_id is not None:
            if new_mgr_id == dev.id:
                raise HTTPException(
                    status_code=400, detail="자기 자신을 상위 관리자로 지정할 수 없습니다."
                )
            # 후보의 manager 체인을 거슬러 올라가며 자기 자신 등장 여부·깊이 검사.
            cycle_check_sql = text("""
                WITH RECURSIVE chain AS (
                    SELECT id, manager_id, 1 AS depth
                      FROM public.developers
                     WHERE id = :start_id
                    UNION ALL
                    SELECT d.id, d.manager_id, c.depth + 1
                      FROM public.developers d
                      JOIN chain c ON d.id = c.manager_id
                     WHERE c.depth < 10
                )
                SELECT MAX(depth) AS max_depth,
                       BOOL_OR(id = :self_id) AS contains_self
                  FROM chain
            """)
            row = (
                await db.execute(
                    cycle_check_sql,
                    {"start_id": new_mgr_id, "self_id": dev.id},
                )
            ).one_or_none()
            if row and row.contains_self:
                raise HTTPException(
                    status_code=400,
                    detail="순환 결재선이 발생합니다 (해당 후보의 상위 체인에 본인이 포함됨).",
                )
            if row and row.max_depth and row.max_depth >= 10:
                raise HTTPException(
                    status_code=400,
                    detail="결재선 깊이가 10단계를 초과합니다.",
                )

    # security_role 변경 권한: `employees.role.edit` 기능 권한.
    # HR→ADMIN 차단 및 마지막 ADMIN 보호는 코드 invariant.
    if "security_role" in data:
        if not await has_feature(db, user, "employees.role.edit"):
            raise HTTPException(
                status_code=403,
                detail="security_role 변경 권한이 없습니다.",
            )
        new_role = data["security_role"]
        if new_role not in ("ADMIN", "SALES", "HR", "SUPPORT", "ETC"):
            raise HTTPException(status_code=400, detail=f"허용되지 않은 역할: {new_role}")
        if user.role == "HR":
            if dev.security_role == "ADMIN":
                raise HTTPException(
                    status_code=403,
                    detail="HR 은 ADMIN 임직원의 역할을 변경할 수 없습니다.",
                )
            if new_role == "ADMIN":
                raise HTTPException(
                    status_code=403,
                    detail="HR 은 ADMIN 역할을 부여할 수 없습니다.",
                )
        if dev.security_role == "ADMIN" and new_role != "ADMIN":
            other_admins = (
                await db.execute(
                    select(func.count(Developer.id)).where(
                        Developer.security_role == "ADMIN",
                        Developer.status == "ACTIVE",
                        Developer.id != dev.id,
                    )
                )
            ).scalar_one()
            if other_admins == 0:
                raise HTTPException(
                    status_code=400,
                    detail="마지막 ADMIN 임직원은 역할을 변경할 수 없습니다.",
                )

    # 급여 필드 변경은 `employees.salary.edit` 권한 보유자만.
    if ("salary" in data or "hourly_rate" in data) and not await has_feature(
        db, user, "employees.salary.edit"
    ):
        raise HTTPException(
            status_code=403, detail="급여 변경 권한이 없습니다."
        )

    for k, v in data.items():
        setattr(dev, k, v)

    # 고용형태 변경 시 사번 재조정 (현재 형태와 사번 범위가 일치하도록).
    #   FULL_TIME         → 00001~89999 범위 사번이 아니면 신규 부여
    #   FULL_TIME_SPECIAL → 90000~99999 범위 사번이 아니면 신규 부여
    #   FREELANCER/INSOURCED → 사번 회수 (NULL)
    # 이전 사번은 회수 후 재사용하지 않음 (max+1 정책으로 자연 burn).
    if "employment_type" in data:
        new_et = data["employment_type"]
        cur_no = dev.employee_no
        if new_et == "FULL_TIME":
            if not (cur_no and cur_no < "90000"):
                dev.employee_no = await _next_employee_no(
                    db, user.tenant_id, special=False
                )
        elif new_et == "FULL_TIME_SPECIAL":
            if not (cur_no and cur_no >= "90000"):
                dev.employee_no = await _next_employee_no(
                    db, user.tenant_id, special=True
                )
        else:
            # 비정규직 (FREELANCER / INSOURCED) — 사번 회수.
            if cur_no:
                dev.employee_no = None
        if cur_no != dev.employee_no:
            logger.warning(
                "사번 재조정: dev=%s prev=%s next=%s (employment_type=%s)",
                dev.id, cur_no, dev.employee_no, new_et,
            )

    await db.commit()

    # 이름 또는 status 변경 시 관련된 이름 그룹 재태깅.
    groups_to_retag: set[str] = set()
    if "name" in data and data["name"] != prev_name:
        groups_to_retag.add(prev_name)
        groups_to_retag.add(dev.name)
    if "status" in data and data["status"] != prev_status:
        groups_to_retag.add(dev.name)
    for n in groups_to_retag:
        await _retag_same_name(db, n)
    if groups_to_retag:
        await db.commit()

    # L1 자동 매핑 — 이메일이 바뀌었으면 새 이메일로 user 매핑 재전파.
    # (회사 이메일이 늦게 부여되거나 personal 이메일을 채운 케이스 cover.)
    if (
        dev.company_email != prev_company_email
        or dev.personal_email != prev_personal_email
    ):
        from app.services.user_developer_sync import propagate_developer_mapping
        await propagate_developer_mapping(db, dev)
        await db.commit()

    await db.refresh(dev, attribute_names=["resumes"])
    await _attach_latest_salary(db, [dev])
    # Resignation is business-critical — log separately.
    if "resigned_date" in data and data["resigned_date"] != prev_resigned:
        logger.warning(
            "임직원 퇴사 처리: id=%s name=%s resigned_date=%s (처리자=%s)",
            dev.id,
            dev.name,
            dev.resigned_date,
            user.id,
        )
    logger.info(
        "임직원 수정: id=%s 변경필드=%s (수정자=%s)",
        dev.id,
        list(data.keys()),
        user.id,
    )
    return dev


@router.delete("/{dev_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_developer(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Soft delete — flips status to INACTIVE. Files and rows are kept."""
    result = await db.execute(select(Developer).where(Developer.id == dev_id))
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="Developer not found")
    dev.status = "INACTIVE"
    dev.tag = None  # 본인은 비활성화 → 태그 회수
    await db.commit()
    # 남은 동명이인 그룹 재태깅
    await _retag_same_name(db, dev.name)
    await db.commit()
    logger.info(
        "임직원 비활성화(soft delete): id=%s name=%s (처리자=%s)",
        dev.id,
        dev.name,
        user.id,
    )


@router.post("/{dev_id}/restore", response_model=DeveloperOut)
async def restore_developer(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(_dev_stmt().where(Developer.id == dev_id))
    dev = result.scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="Developer not found")
    dev.status = "ACTIVE"
    await db.commit()
    await db.refresh(dev, attribute_names=["resumes"])
    return dev


@router.get("/{dev_id}/assignments", response_model=list[DeveloperAssignmentHistory])
async def developer_assignments(
    dev_id: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)
):
    stmt = (
        select(Assignment, Project.name)
        .join(Project, Project.id == Assignment.project_id)
        .where(Assignment.developer_id == dev_id)
        .order_by(Project.start_date.desc(), Assignment.start_date.desc())
    )
    result = await db.execute(stmt)
    out: list[DeveloperAssignmentHistory] = []
    for assignment, project_name in result.all():
        out.append(
            DeveloperAssignmentHistory(
                assignment_id=assignment.id,
                project_id=assignment.project_id,
                project_name=project_name,
                start_date=assignment.start_date.isoformat(),
                end_date=assignment.end_date.isoformat(),
                monthly_rate=assignment.monthly_rate,
                is_insourced=assignment.is_insourced,
            )
        )
    return out


# ---------------------------------------------------------------------------
# 이력서 / 첨부파일 공통 권한 가드
# ---------------------------------------------------------------------------


async def _ensure_resume_access(
    db: AsyncSession, dev_id: UUID, user: User
) -> Developer:
    """이력서/첨부파일 접근 권한 — ADMIN / HR / SALES 또는 본인.

    읽기·쓰기가 동일 규칙. 본인 판정은 developers.company_email 또는
    personal_email 이 로그인 user.email 과 일치하는지로 판단한다.
    """
    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="Developer not found")
    if user.role in RESUME_ACCESS_ROLES:
        return dev
    if user.email and user.email in (dev.company_email, dev.personal_email):
        return dev
    raise HTTPException(
        status_code=403,
        detail="이력서 접근 권한이 없습니다 (ADMIN/HR/SALES 또는 본인만 가능).",
    )


async def _ensure_resume_access_by_resume(
    db: AsyncSession, resume_id: UUID, user: User
) -> DeveloperResume:
    resume = (
        await db.execute(select(DeveloperResume).where(DeveloperResume.id == resume_id))
    ).scalar_one_or_none()
    if resume is None:
        raise HTTPException(status_code=404, detail="Resume not found")
    await _ensure_resume_access(db, resume.developer_id, user)
    return resume


async def _ensure_resume_access_by_experience(
    db: AsyncSession, exp_id: UUID, user: User
) -> DeveloperExperience:
    exp = (
        await db.execute(
            select(DeveloperExperience).where(DeveloperExperience.id == exp_id)
        )
    ).scalar_one_or_none()
    if exp is None:
        raise HTTPException(status_code=404, detail="Experience not found")
    await _ensure_resume_access(db, exp.developer_id, user)
    return exp


# ---------------------------------------------------------------------------
# 첨부파일 (developer_resumes — 테이블명은 역사적 이유로 유지)
# ---------------------------------------------------------------------------


@router.get("/{dev_id}/resumes", response_model=list[DeveloperResumeOut])
async def list_resumes(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_resume_access(db, dev_id, user)
    result = await db.execute(
        select(DeveloperResume)
        .where(DeveloperResume.developer_id == dev_id)
        .order_by(DeveloperResume.created_at.desc())
    )
    return list(result.scalars().all())


@router.post(
    "/{dev_id}/resumes",
    response_model=list[DeveloperResumeOut],
    status_code=status.HTTP_201_CREATED,
)
async def upload_resumes(
    dev_id: UUID,
    files: list[UploadFile] = File(...),
    description: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_resume_access(db, dev_id, user)

    created: list[DeveloperResume] = []
    for f in files:
        stored, size = await save_upload(f, f"developers/{dev_id}")
        resume = DeveloperResume(
            developer_id=dev_id,
            file_name=f.filename or "upload.bin",
            file_path=stored,
            mime_type=f.content_type,
            size=size,
            description=description,
        )
        db.add(resume)
        created.append(resume)
    await db.commit()
    for r in created:
        await db.refresh(r)
    return created


@router.patch("/resumes/{resume_id}", response_model=DeveloperResumeOut)
async def update_resume(
    resume_id: UUID,
    payload: DeveloperResumeUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    resume = await _ensure_resume_access_by_resume(db, resume_id, user)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(resume, k, v)
    await db.commit()
    await db.refresh(resume)
    return resume


@router.delete("/resumes/{resume_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_resume(
    resume_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    resume = await _ensure_resume_access_by_resume(db, resume_id, user)
    delete_file(resume.file_path)
    await db.delete(resume)
    await db.commit()


@router.get("/resumes/{resume_id}/download")
async def download_resume(
    resume_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    resume = await _ensure_resume_access_by_resume(db, resume_id, user)
    abs_path = resolve_upload_path(resume.file_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail="파일이 디스크에 존재하지 않습니다.",
        )
    return FileResponse(
        str(abs_path),
        filename=resume.file_name,
        media_type=resume.mime_type or "application/octet-stream",
    )


# ---------------------------------------------------------------------------
# 구조화 이력서 (profile + certifications + experiences)
# ---------------------------------------------------------------------------


@router.get("/{dev_id}/resume", response_model=ResumeBundleOut)
async def get_resume_bundle(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dev = await _ensure_resume_access(db, dev_id, user)
    profile = (
        await db.execute(
            select(DeveloperProfile).where(DeveloperProfile.developer_id == dev_id)
        )
    ).scalar_one_or_none()
    certs = list(
        (
            await db.execute(
                select(DeveloperCertification)
                .where(DeveloperCertification.developer_id == dev_id)
                .order_by(
                    DeveloperCertification.position.asc(),
                    DeveloperCertification.created_at.asc(),
                )
            )
        ).scalars()
    )
    exps = list(
        (
            await db.execute(
                select(DeveloperExperience)
                .where(DeveloperExperience.developer_id == dev_id)
                .order_by(DeveloperExperience.start_date.desc())
            )
        ).scalars()
    )
    return ResumeBundleOut(
        developer_id=dev.id,
        name=dev.name,
        profile=ResumeProfileOut.model_validate(profile) if profile else None,
        certifications=[ResumeCertificationOut.model_validate(c) for c in certs],
        experiences=[ResumeExperienceOut.model_validate(e) for e in exps],
    )


@router.put("/{dev_id}/resume/profile", response_model=ResumeProfileOut)
async def upsert_resume_profile(
    dev_id: UUID,
    payload: ResumeProfileUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_resume_access(db, dev_id, user)
    profile = (
        await db.execute(
            select(DeveloperProfile).where(DeveloperProfile.developer_id == dev_id)
        )
    ).scalar_one_or_none()
    data = payload.model_dump(exclude_unset=True)
    if profile is None:
        profile = DeveloperProfile(developer_id=dev_id, **data)
        db.add(profile)
    else:
        for k, v in data.items():
            setattr(profile, k, v)
    await db.commit()
    await db.refresh(profile)
    logger.info("이력서 프로필 저장: dev=%s by=%s", dev_id, user.id)
    return ResumeProfileOut.model_validate(profile)


@router.put(
    "/{dev_id}/resume/certifications", response_model=list[ResumeCertificationOut]
)
async def replace_certifications(
    dev_id: UUID,
    payload: list[ResumeCertificationInput],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """자격증 전체 교체. payload 배열 순서가 position 이 된다."""
    await _ensure_resume_access(db, dev_id, user)
    await db.execute(
        DeveloperCertification.__table__.delete().where(
            DeveloperCertification.developer_id == dev_id
        )
    )
    created: list[DeveloperCertification] = []
    for idx, row in enumerate(payload):
        cert = DeveloperCertification(
            developer_id=dev_id,
            name=row.name,
            issuer=row.issuer,
            acquired_on=row.acquired_on,
            position=idx,
        )
        db.add(cert)
        created.append(cert)
    await db.commit()
    for c in created:
        await db.refresh(c)
    logger.info(
        "이력서 자격증 갱신: dev=%s count=%d by=%s", dev_id, len(created), user.id
    )
    return [ResumeCertificationOut.model_validate(c) for c in created]


@router.post(
    "/{dev_id}/resume/experiences",
    response_model=ResumeExperienceOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_experience(
    dev_id: UUID,
    payload: ResumeExperienceInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await _ensure_resume_access(db, dev_id, user)
    # position: 기존 max + 1
    max_pos = (
        await db.execute(
            select(func.coalesce(func.max(DeveloperExperience.position), -1)).where(
                DeveloperExperience.developer_id == dev_id
            )
        )
    ).scalar_one()
    exp = DeveloperExperience(
        developer_id=dev_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        company=payload.company,
        role=payload.role,
        description=payload.description,
        position=int(max_pos) + 1,
    )
    db.add(exp)
    await db.commit()
    await db.refresh(exp)
    return ResumeExperienceOut.model_validate(exp)


@router.patch(
    "/resume/experiences/{exp_id}", response_model=ResumeExperienceOut
)
async def update_experience(
    exp_id: UUID,
    payload: ResumeExperienceInput,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    exp = await _ensure_resume_access_by_experience(db, exp_id, user)
    for k, v in payload.model_dump().items():
        setattr(exp, k, v)
    await db.commit()
    await db.refresh(exp)
    return ResumeExperienceOut.model_validate(exp)


@router.delete(
    "/resume/experiences/{exp_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_experience(
    exp_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    exp = await _ensure_resume_access_by_experience(db, exp_id, user)
    await db.delete(exp)
    await db.commit()


# ---------------------------------------------------------------------------
# 승인자 (developer_approvers)
# ---------------------------------------------------------------------------


async def _load_approvers_with_user(
    db: AsyncSession, developer_id: UUID
) -> list[DeveloperApproverOut]:
    rows = list(
        (
            await db.execute(
                select(DeveloperApprover, User)
                .join(User, User.id == DeveloperApprover.approver_user_id)
                .where(DeveloperApprover.developer_id == developer_id)
                .order_by(
                    DeveloperApprover.is_primary.desc(),
                    DeveloperApprover.position.asc(),
                )
            )
        ).all()
    )
    return [
        DeveloperApproverOut(
            id=a.id,
            developer_id=a.developer_id,
            approver_user_id=a.approver_user_id,
            approver_name=u.name or None,
            approver_email=u.email,
            is_primary=a.is_primary,
            position=a.position,
        )
        for a, u in rows
    ]


@router.get("/{dev_id}/approvers", response_model=list[DeveloperApproverOut])
async def list_developer_approvers(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    dev = (
        await db.execute(select(Developer.id).where(Developer.id == dev_id))
    ).first()
    if dev is None:
        raise HTTPException(status_code=404, detail="Developer not found")
    return await _load_approvers_with_user(db, dev_id)


@router.put("/{dev_id}/approvers", response_model=list[DeveloperApproverOut])
async def set_developer_approvers(
    dev_id: UUID,
    payload: list[DeveloperApproverInput],
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_feature("employees.approvers.edit")),
):
    """직원의 승인자 목록을 **전체 교체**.

    - 최대 1명 `is_primary=true`. 여러 명이면 400.
    - 중복 user_id 차단.
    - 모든 기존 row 삭제 후 재삽입 (position 은 배열 인덱스).
    """
    dev = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if dev is None:
        raise HTTPException(status_code=404, detail="Developer not found")

    # 유효성 검증
    primary_count = sum(1 for x in payload if x.is_primary)
    if primary_count > 1:
        raise HTTPException(
            status_code=400, detail="Primary 승인자는 최대 1명만 가능합니다."
        )
    uids = [x.user_id for x in payload]
    if len(uids) != len(set(uids)):
        raise HTTPException(status_code=400, detail="중복된 승인자가 있습니다.")
    if uids:
        found = {
            u.id
            for u in (
                await db.execute(
                    select(User).where(User.id.in_(uids), User.is_active.is_(True))
                )
            ).scalars()
        }
        missing = [str(u) for u in uids if u not in found]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"존재하지 않거나 비활성인 사용자: {', '.join(missing)}",
            )

    # 기존 모두 삭제 + 신규 삽입 (단일 트랜잭션)
    await db.execute(
        DeveloperApprover.__table__.delete().where(
            DeveloperApprover.developer_id == dev_id
        )
    )
    for idx, row in enumerate(payload):
        db.add(
            DeveloperApprover(
                developer_id=dev_id,
                approver_user_id=row.user_id,
                is_primary=row.is_primary,
                position=idx,
            )
        )
    await db.commit()
    logger.info(
        "승인자 갱신: dev=%s count=%d primary=%s admin=%s",
        dev_id,
        len(payload),
        next((str(x.user_id) for x in payload if x.is_primary), None),
        admin.id,
    )
    return await _load_approvers_with_user(db, dev_id)


# ---------------------------------------------------------------------------
# 결재선 (manager_id) — 후보 조회 / 결재 chain / 직속 부하
# ---------------------------------------------------------------------------


class ApprovalChainNode(BaseModel):
    level: int
    id: UUID
    name: str
    title: str | None = None
    employee_no: str | None = None


class DirectReportOut(BaseModel):
    id: UUID
    name: str
    title: str | None = None
    employee_no: str | None = None

    class Config:
        from_attributes = True


@router.get(
    "/{dev_id}/approval-chain",
    response_model=list[ApprovalChainNode],
)
async def get_approval_chain(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 → 상위 관리자 → 그 위 ... 결재선 체인.

    HR/ADMIN 은 모든 사람 조회 가능. 그 외는 본인 + 자기 하위 트리만.
    """
    target = (
        await db.execute(select(Developer).where(Developer.id == dev_id))
    ).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Developer not found")

    if user.role not in ("ADMIN", "HR"):
        my_dev_id = user.mapped_developer_id
        if not my_dev_id or my_dev_id != dev_id:
            asc_sql = text("""
                WITH RECURSIVE chain AS (
                    SELECT id, manager_id FROM public.developers WHERE id = :start_id
                    UNION ALL
                    SELECT d.id, d.manager_id FROM public.developers d
                      JOIN chain c ON d.id = c.manager_id
                )
                SELECT 1 FROM chain WHERE id = :viewer_id LIMIT 1
            """)
            allowed = None
            if my_dev_id:
                allowed = (await db.execute(asc_sql, {"start_id": dev_id, "viewer_id": my_dev_id})).first()
            if not allowed:
                raise HTTPException(status_code=403, detail="조회 권한이 없습니다.")

    chain_sql = text("""
        WITH RECURSIVE chain AS (
            SELECT id, manager_id, name, title, employee_no, 0 AS level
              FROM public.developers
             WHERE id = :start_id
            UNION ALL
            SELECT d.id, d.manager_id, d.name, d.title, d.employee_no, c.level + 1
              FROM public.developers d
              JOIN chain c ON d.id = c.manager_id
             WHERE c.level < 10
        )
        SELECT level, id, name, title, employee_no FROM chain ORDER BY level
    """)
    rows = (await db.execute(chain_sql, {"start_id": dev_id})).all()
    return [
        ApprovalChainNode(
            level=r.level, id=r.id, name=r.name, title=r.title, employee_no=r.employee_no,
        )
        for r in rows
    ]


@router.get(
    "/{dev_id}/reports",
    response_model=list[DirectReportOut],
)
async def list_direct_reports(
    dev_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """직속 부하 직원 — manager_id == dev_id. 결재 트래픽 예측·조직도용."""
    rows = (
        await db.execute(
            select(Developer)
            .where(Developer.manager_id == dev_id, Developer.status == "ACTIVE")
            .order_by(Developer.name)
        )
    ).scalars().all()
    return rows
