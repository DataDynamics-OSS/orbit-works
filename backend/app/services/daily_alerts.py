"""매일 새벽 1시에 실행되는 Slack/Mattermost 알림 job.

대상 (모두 end_date 기준 D-day 정확 매칭)
  1) 프로젝트 종료 D-30 - projects.end_date - today ∈ project_alert_days
  2) 투입 종료   D-30 - assignments.end_date - today ∈ assignment_alert_days
  3) 라이센스 만료 D-30 - licenses.end_date - today ∈ license_alert_days
  4) 도메인 만료 D-30 - domains.expiry_date - today == 30 (고정).
     expiry_alarm=true 인 항목만. auto_renew 는 표시 전용이라 무관.
     일반 알림과 분리해 ADMIN/HR/SUPER_ADMIN 에게 mattermost DM 발송.
  5) 서버 호스팅 종료 D-30 - server_hostings.end_date - today == 30 (고정).
     expiry_alarm=true 인 항목만. 도메인과 동일 채널 (ADMIN/HR/SUPER_ADMIN DM).

같은 날 중복 실행은 `data/.daily_alert_last_run` 가드 파일로 차단.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import system_session
from app.models import (
    Assignment,
    Customer,
    Developer,
    Domain,
    License,
    Project,
    ServerHosting,
    User,
)
from app.services.notify import notify_service

logger = logging.getLogger(__name__)

GUARD_FILENAME = ".daily_alert_last_run"


@dataclass
class ProjectAlert:
    id: str
    name: str
    customer_name: str | None
    end_date: str
    days_left: int
    active_headcount: int


@dataclass
class AssignmentAlert:
    assignment_id: str
    developer_id: str
    developer_name: str
    project_id: str
    project_name: str
    end_date: str
    days_left: int


@dataclass
class LicenseAlert:
    id: str
    product_name: str
    customer_name: str | None
    end_date: str
    days_left: int


@dataclass
class DomainAlert:
    id: str
    name: str
    vendor: str | None
    purpose: str | None
    auto_renew: bool
    expiry_date: str
    days_left: int


@dataclass
class ServerHostingAlert:
    id: str
    ip: str
    vendor: str | None
    hosting_type: str | None
    end_date: str
    days_left: int


def _guard_path() -> Path:
    return Path(get_settings().upload.dir) / GUARD_FILENAME


def _already_ran_today() -> bool:
    p = _guard_path()
    if not p.exists():
        return False
    try:
        return p.read_text().strip() == date.today().isoformat()
    except OSError:
        return False


def _mark_ran_today() -> None:
    p = _guard_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(date.today().isoformat())
    except OSError as exc:
        logger.warning("알림 가드 파일 기록 실패: %s", exc)


async def _collect_project_alerts(
    db: AsyncSession, today: date, d_days: list[int]
) -> list[ProjectAlert]:
    if not d_days:
        return []
    rows = list(
        (
            await db.execute(
                select(Project).where(Project.end_date >= today)
            )
        ).scalars()
    )
    cust_ids = {p.customer_id for p in rows if p.customer_id}
    cust_names: dict = {}
    if cust_ids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cust_ids)))
        ).scalars():
            cust_names[c.id] = c.name

    alerts: list[ProjectAlert] = []
    for p in rows:
        days_left = (p.end_date - today).days
        if days_left not in d_days:
            continue
        head = (
            await db.execute(
                select(func.count(Assignment.id)).where(
                    Assignment.project_id == p.id,
                    Assignment.start_date <= today,
                    Assignment.end_date >= today,
                )
            )
        ).scalar_one()
        alerts.append(
            ProjectAlert(
                id=str(p.id),
                name=p.name,
                customer_name=cust_names.get(p.customer_id),
                end_date=p.end_date.isoformat(),
                days_left=days_left,
                active_headcount=int(head),
            )
        )
    alerts.sort(key=lambda a: (a.days_left, a.end_date))
    return alerts


async def _collect_assignment_alerts(
    db: AsyncSession, today: date, d_days: list[int]
) -> list[AssignmentAlert]:
    if not d_days:
        return []
    rows = list(
        (
            await db.execute(
                select(Assignment).where(Assignment.end_date >= today)
            )
        ).scalars()
    )
    dev_ids = {a.developer_id for a in rows}
    proj_ids = {a.project_id for a in rows}
    devs = {}
    projs = {}
    if dev_ids:
        for d in (
            await db.execute(select(Developer).where(Developer.id.in_(dev_ids)))
        ).scalars():
            devs[d.id] = d
    if proj_ids:
        for p in (
            await db.execute(select(Project).where(Project.id.in_(proj_ids)))
        ).scalars():
            projs[p.id] = p

    alerts: list[AssignmentAlert] = []
    for a in rows:
        days_left = (a.end_date - today).days
        if days_left not in d_days:
            continue
        dev = devs.get(a.developer_id)
        if dev is None:
            continue
        # 퇴사·비활성 인력은 제외.
        if dev.status != "ACTIVE":
            continue
        if dev.resigned_date and dev.resigned_date <= today:
            continue
        proj = projs.get(a.project_id)
        alerts.append(
            AssignmentAlert(
                assignment_id=str(a.id),
                developer_id=str(a.developer_id),
                developer_name=dev.name,
                project_id=str(a.project_id),
                project_name=proj.name if proj else "(알 수 없음)",
                end_date=a.end_date.isoformat(),
                days_left=days_left,
            )
        )
    alerts.sort(key=lambda a: (a.days_left, a.developer_name))
    return alerts


async def _collect_license_alerts(
    db: AsyncSession, today: date, d_days: list[int]
) -> list[LicenseAlert]:
    if not d_days:
        return []
    rows = list(
        (
            await db.execute(
                select(License).where(License.end_date >= today)
            )
        ).scalars()
    )
    cust_ids = {l.customer_id for l in rows if l.customer_id}
    cust_names: dict = {}
    if cust_ids:
        for c in (
            await db.execute(select(Customer).where(Customer.id.in_(cust_ids)))
        ).scalars():
            cust_names[c.id] = c.name

    alerts: list[LicenseAlert] = []
    for lic in rows:
        days_left = (lic.end_date - today).days
        if days_left not in d_days:
            continue
        alerts.append(
            LicenseAlert(
                id=str(lic.id),
                product_name=lic.product_name,
                customer_name=cust_names.get(lic.customer_id),
                end_date=lic.end_date.isoformat(),
                days_left=days_left,
            )
        )
    alerts.sort(key=lambda a: (a.days_left, a.product_name))
    return alerts


async def _collect_domain_alerts(
    db: AsyncSession, today: date, d_days: list[int]
) -> list[DomainAlert]:
    """expiry_alarm=true 인 도메인 중 (expiry_date - today) 가 d_days 에 정확
    매칭되는 항목.
    """
    if not d_days:
        return []
    rows = list(
        (
            await db.execute(
                select(Domain).where(
                    Domain.expiry_alarm.is_(True),
                    Domain.expiry_date.is_not(None),
                    Domain.expiry_date >= today,
                )
            )
        ).scalars()
    )
    alerts: list[DomainAlert] = []
    for d in rows:
        days_left = (d.expiry_date - today).days
        if days_left not in d_days:
            continue
        alerts.append(
            DomainAlert(
                id=str(d.id),
                name=d.name,
                vendor=d.vendor,
                purpose=d.purpose,
                auto_renew=d.auto_renew,
                expiry_date=d.expiry_date.isoformat(),
                days_left=days_left,
            )
        )
    alerts.sort(key=lambda a: (a.days_left, a.name))
    return alerts


async def _collect_server_hosting_alerts(
    db: AsyncSession, today: date, d_days: list[int]
) -> list[ServerHostingAlert]:
    """expiry_alarm=true 인 서버 호스팅 중 (end_date - today) 가 d_days 에 정확
    매칭되는 항목.

    도메인의 `_collect_domain_alerts` 와 동일 패턴 — `end_date IS NULL` 인
    "관리되지 않는 호스팅" 은 조회 단에서 제외 (의도적; 등록만 해두고 종료일
    공란이면 D-30 알림 대상 아님).
    """
    if not d_days:
        return []
    rows = list(
        (
            await db.execute(
                select(ServerHosting).where(
                    ServerHosting.expiry_alarm.is_(True),
                    ServerHosting.end_date.is_not(None),
                    ServerHosting.end_date >= today,
                )
            )
        ).scalars()
    )
    alerts: list[ServerHostingAlert] = []
    for s in rows:
        days_left = (s.end_date - today).days
        if days_left not in d_days:
            continue
        alerts.append(
            ServerHostingAlert(
                id=str(s.id),
                ip=s.ip,
                vendor=s.vendor,
                hosting_type=s.hosting_type,
                end_date=s.end_date.isoformat(),
                days_left=days_left,
            )
        )
    alerts.sort(key=lambda a: (a.days_left, a.ip))
    return alerts


async def _admin_hr_emails(db: AsyncSession) -> list[str]:
    """현재 tenant 의 ADMIN / HR / SUPER_ADMIN user 의 email 목록 (mattermost DM 대상)."""
    rows = (
        await db.execute(
            select(User.email).where(
                User.is_active.is_(True),
                User.role.in_(("ADMIN", "HR", "SUPER_ADMIN")),
            )
        )
    ).scalars().all()
    return [e for e in rows if e and "@" in e]


def _format_domain_message(today: date, domains: list[DomainAlert]) -> str:
    """도메인 만료 알림 전용 메시지 — ADMIN/HR DM 발송용."""
    lines: list[str] = [
        f":globe_with_meridians: *도메인 만료 임박 알림* ({today.isoformat()})",
        f"  총 {len(domains)} 건",
    ]
    for d in domains:
        vendor = f" · 구매처: {d.vendor}" if d.vendor else ""
        renew = " · 자동갱신 ON" if d.auto_renew else " · 자동갱신 OFF"
        purpose = f"\n    └ 용도: {d.purpose}" if d.purpose else ""
        lines.append(
            f"• `{d.name}` — 만료일 {d.expiry_date} "
            f"(D-{d.days_left}){vendor}{renew}{purpose}"
        )
    return "\n".join(lines)


_HOSTING_TYPE_LABEL = {
    "DEDICATED": "전용서버",
    "VPS": "VPS",
    "CLOUD": "클라우드",
    "COLOCATION": "코로케이션",
}


def _format_server_hosting_message(
    today: date, hostings: list[ServerHostingAlert]
) -> str:
    """서버 호스팅 종료 임박 알림 전용 메시지 — ADMIN/HR DM 발송용."""
    lines: list[str] = [
        f":desktop_computer: *서버 호스팅 종료 임박 알림* ({today.isoformat()})",
        f"  총 {len(hostings)} 건",
    ]
    for h in hostings:
        vendor = f" · 업체: {h.vendor}" if h.vendor else ""
        ht = (
            f" · 유형: {_HOSTING_TYPE_LABEL.get(h.hosting_type, h.hosting_type)}"
            if h.hosting_type
            else ""
        )
        lines.append(
            f"• `{h.ip}` — 종료일 {h.end_date} (D-{h.days_left}){vendor}{ht}"
        )
    return "\n".join(lines)


def _format_message(
    today: date,
    projects: list[ProjectAlert],
    assignments: list[AssignmentAlert],
    licenses: list[LicenseAlert],
) -> str:
    lines: list[str] = [f":bell: *오늘의 알림* ({today.isoformat()})"]
    if projects:
        lines.append(f"\n:calendar: *프로젝트 종료 임박* ({len(projects)}건)")
        for p in projects:
            cust = f" · 고객사: {p.customer_name}" if p.customer_name else ""
            lines.append(
                f"• {p.name}{cust} — 종료일 {p.end_date} (D-{p.days_left}, 현재 투입 {p.active_headcount}명)"
            )
    if assignments:
        lines.append(f"\n:bust_in_silhouette: *투입 종료 임박* ({len(assignments)}건)")
        for a in assignments:
            lines.append(
                f"• {a.developer_name} → {a.project_name}, {a.end_date} (D-{a.days_left})"
            )
    if licenses:
        lines.append(f"\n:key: *라이센스 만료 임박* ({len(licenses)}건)")
        for lc in licenses:
            cust = f" · 고객사: {lc.customer_name}" if lc.customer_name else ""
            lines.append(
                f"• {lc.product_name}{cust} — 종료일 {lc.end_date} (D-{lc.days_left})"
            )
    return "\n".join(lines)


async def run_daily_alerts(*, force: bool = False) -> dict:
    """Job entrypoint — **활성 tenant 별로 분기 집계·발송**.

    각 tenant 의 프로젝트/투입/라이센스 D-30 항목을 그 tenant 의 notify 설정
    (Slack 또는 Mattermost) 로 발송. tenant 별로 결과 카운트를 모은다.
    """
    from sqlalchemy import select as sa_select
    from app.core.tenant_context import set_current_tenant_id
    from app.models import Tenant

    cfg = get_settings().scheduler
    today = date.today()
    if not force and _already_ran_today():
        logger.info("일일 알림 가드: 오늘(%s)은 이미 실행됨 — 건너뜀", today)
        return {"skipped": True, "reason": "already_ran_today"}

    # 활성 tenant 목록.
    async with system_session() as db:
        tenants = list(
            (await db.execute(
                sa_select(Tenant.id, Tenant.slug).where(Tenant.is_active.is_(True))
            )).all()
        )

    per_tenant: list[dict] = []
    sent_any = False
    for tid, slug in tenants:
        set_current_tenant_id(tid)
        try:
            async with system_session(tenant_id=str(tid)) as db:
                projects = await _collect_project_alerts(
                    db, today, list(cfg.project_alert_days)
                )
                assignments = await _collect_assignment_alerts(
                    db, today, list(cfg.assignment_alert_days)
                )
                licenses = await _collect_license_alerts(
                    db, today, list(cfg.license_alert_days)
                )
                # 도메인 만료 D-30 — expiry_alarm=true 인 항목만.
                # ADMIN/HR/SUPER_ADMIN 에게 mattermost DM 으로 별도 발송.
                domains = await _collect_domain_alerts(db, today, [30])
                domain_sent = False
                domain_recipients = 0
                logger.info(
                    "도메인 만료 D-30 검사 tenant=%s: %d건", slug, len(domains)
                )
                if domains:
                    admin_hr = await _admin_hr_emails(db)
                    domain_recipients = len(admin_hr)
                    if admin_hr:
                        domain_text = _format_domain_message(today, domains)
                        try:
                            domain_sent = await notify_service.send_for_tenant(
                                tid,
                                domain_text,
                                user_emails=admin_hr,
                                feature="domain_expiry_alert",
                            )
                            logger.info(
                                "도메인 만료 알림 발송 tenant=%s: %d건 → %d명 (sent=%s)",
                                slug, len(domains), len(admin_hr), domain_sent,
                            )
                        except Exception as exc:  # pragma: no cover
                            logger.warning(
                                "도메인 만료 알림 발송 실패 tenant=%s: %s",
                                slug, exc, exc_info=True,
                            )
                    else:
                        logger.info(
                            "도메인 만료 %d건 있으나 ADMIN/HR user 없음 — skip (tenant=%s)",
                            len(domains), slug,
                        )
                # 서버 호스팅 종료 D-30 — 도메인과 동일 패턴.
                hostings = await _collect_server_hosting_alerts(db, today, [30])
                hosting_sent = False
                hosting_recipients = 0
                logger.info(
                    "서버 호스팅 종료 D-30 검사 tenant=%s: %d건", slug, len(hostings)
                )
                if hostings:
                    admin_hr = await _admin_hr_emails(db)
                    hosting_recipients = len(admin_hr)
                    if admin_hr:
                        hosting_text = _format_server_hosting_message(today, hostings)
                        try:
                            hosting_sent = await notify_service.send_for_tenant(
                                tid,
                                hosting_text,
                                user_emails=admin_hr,
                                feature="server_hosting_expiry_alert",
                            )
                            logger.info(
                                "서버 호스팅 종료 알림 발송 tenant=%s: %d건 → %d명 (sent=%s)",
                                slug, len(hostings), len(admin_hr), hosting_sent,
                            )
                        except Exception as exc:  # pragma: no cover
                            logger.warning(
                                "서버 호스팅 종료 알림 발송 실패 tenant=%s: %s",
                                slug, exc, exc_info=True,
                            )
                    else:
                        logger.info(
                            "서버 호스팅 종료 %d건 있으나 ADMIN/HR user 없음 — skip (tenant=%s)",
                            len(hostings), slug,
                        )
                # 평가 마감 D-3 reminder — 같은 cron 에 묶어 한 번만 발송.
                # 본문은 evaluation_notify 가 직접 DM 발송하므로 여기 메시지에는
                # 안 합치고, 별도 호출로 처리.
                from app.services.evaluation_notify import (
                    run_evaluation_due_reminders,
                )
                try:
                    eval_summary = await run_evaluation_due_reminders(db, today)
                except Exception as exc:  # pragma: no cover
                    logger.warning(
                        "evaluation due reminder 실패 tenant=%s: %s",
                        slug, exc, exc_info=True,
                    )
                    eval_summary = {"self": 0, "manager": 0, "calibrate": 0}
        finally:
            set_current_tenant_id(None)

        eval_total = (
            eval_summary.get("self", 0)
            + eval_summary.get("manager", 0)
            + eval_summary.get("calibrate", 0)
        )
        total = len(projects) + len(assignments) + len(licenses)
        sent_any = sent_any or domain_sent or hosting_sent
        if total == 0 and eval_total == 0:
            if domain_sent or hosting_sent:
                per_tenant.append({
                    "tenant": slug,
                    "sent": True,
                    "counts": {
                        "project": 0, "assignment": 0, "license": 0,
                        "domain": len(domains),
                        "domain_recipients": domain_recipients,
                        "server_hosting": len(hostings),
                        "server_hosting_recipients": hosting_recipients,
                        "evaluations": eval_summary,
                    },
                })
            else:
                per_tenant.append({"tenant": slug, "sent": False, "reason": "no_alerts"})
            continue
        if total == 0:
            # evaluation reminder 만 있고 다른 일일 알림 없음 — sent_any 만 갱신.
            sent_any = True
            per_tenant.append({
                "tenant": slug,
                "sent": True,
                "counts": {
                    "project": 0, "assignment": 0, "license": 0,
                    "domain": len(domains),
                    "domain_recipients": domain_recipients,
                    "server_hosting": len(hostings),
                    "server_hosting_recipients": hosting_recipients,
                    "evaluations": eval_summary,
                },
            })
            continue

        text = _format_message(today, projects, assignments, licenses)
        sent = False
        try:
            sent = await notify_service.send_for_tenant(tid, text, feature="expiry_alert")
        except Exception as exc:  # pragma: no cover
            logger.warning("일일 알림 발송 예외 tenant=%s: %s", slug, exc, exc_info=True)
        sent_any = sent_any or sent
        per_tenant.append({
            "tenant": slug,
            "sent": sent or domain_sent or hosting_sent,
            "counts": {
                "project": len(projects),
                "assignment": len(assignments),
                "license": len(licenses),
                "domain": len(domains),
                "domain_recipients": domain_recipients,
                "server_hosting": len(hostings),
                "server_hosting_recipients": hosting_recipients,
                "evaluations": eval_summary,
            },
        })
        logger.info(
            "일일 알림 tenant=%s: 프로젝트=%d 투입=%d 라이센스=%d 도메인=%d 호스팅=%d 평가=%s → sent=%s",
            slug, len(projects), len(assignments), len(licenses),
            len(domains), len(hostings), eval_summary, sent,
        )

    if sent_any:
        _mark_ran_today()

    return {
        "sent": sent_any,
        "tenants": per_tenant,
    }


# ---------------------------------------------------------------------------
# 비공개 일정 알람 — 매일 09:00 cron.
# 오늘 날짜의 EVENT_PRIVATE 일정에 등록된 알람 수신자(developer) 에게 Slack DM.
# ---------------------------------------------------------------------------


async def run_calendar_event_alarms(*, force: bool = False) -> dict:
    """오늘이 시작일인 비공개 일정의 알람 수신자에게 일괄 발송.

    `force` 무시되더라도 `notified_at IS NOT NULL` 인 row 는 자동 skip 되므로
    별도 일자별 가드 파일 불필요. 실패한 row 는 다음 실행 때 재시도.
    """
    from datetime import datetime, timezone as tz_utc

    from sqlalchemy import select as sa_select
    from app.core.tenant_context import set_current_tenant_id
    from app.models import Holiday, HolidayAlarmRecipient, Developer, Tenant

    today = date.today()
    sent_total = 0
    failed_total = 0
    skipped_total = 0
    per_tenant: list[dict] = []

    async with system_session() as db:
        tenants = list(
            (
                await db.execute(
                    sa_select(Tenant.id, Tenant.slug).where(
                        Tenant.is_active.is_(True)
                    )
                )
            ).all()
        )

    for tid, slug in tenants:
        set_current_tenant_id(tid)
        sent = 0
        failed = 0
        skipped = 0
        try:
            async with system_session(tenant_id=str(tid)) as db:
                # 오늘이 일정일 + 비공개 + 미발송 row 만.
                rows = list(
                    (
                        await db.execute(
                            sa_select(
                                HolidayAlarmRecipient,
                                Holiday.name,
                                Holiday.description,
                                Holiday.date,
                                Developer.company_email,
                                Developer.personal_email,
                            )
                            .join(
                                Holiday,
                                Holiday.id == HolidayAlarmRecipient.holiday_id,
                            )
                            .join(
                                Developer,
                                Developer.id == HolidayAlarmRecipient.developer_id,
                            )
                            .where(Holiday.date == today)
                            .where(Holiday.type == "EVENT_PRIVATE")
                            .where(HolidayAlarmRecipient.notified_at.is_(None))
                        )
                    ).all()
                )
                for rec, h_name, h_desc, h_date, comp_email, pers_email in rows:
                    email = comp_email or pers_email
                    if not email:
                        skipped += 1
                        logger.warning(
                            "calendar alarm skip: tenant=%s rec=%s 이메일 없음",
                            slug, rec.id,
                        )
                        continue
                    body = h_desc or ""
                    text = (
                        f"🔔 [비공개 일정] {h_name} — {h_date}"
                        + (f"\n{body}" if body else "")
                    )
                    try:
                        ok = await notify_service.send_for_tenant(
                            tid, text, user_emails=[email],
                            feature="calendar_event",
                        )
                        if ok:
                            rec.notified_at = datetime.now(tz_utc.utc)
                            sent += 1
                        else:
                            failed += 1
                    except Exception as exc:  # pragma: no cover
                        logger.warning(
                            "calendar alarm send 예외 tenant=%s rec=%s: %s",
                            slug, rec.id, exc, exc_info=True,
                        )
                        failed += 1
                await db.commit()
        except Exception as exc:  # pragma: no cover
            logger.warning(
                "calendar alarm tenant=%s 처리 예외: %s", slug, exc, exc_info=True
            )
            failed_total += 1
            continue
        sent_total += sent
        failed_total += failed
        skipped_total += skipped
        if sent or failed or skipped:
            per_tenant.append(
                {"tenant": slug, "sent": sent, "failed": failed, "skipped": skipped}
            )
        logger.info(
            "비공개 일정 알람 tenant=%s: sent=%d failed=%d skipped=%d",
            slug, sent, failed, skipped,
        )

    return {
        "sent": sent_total,
        "failed": failed_total,
        "skipped": skipped_total,
        "tenants": per_tenant,
    }
