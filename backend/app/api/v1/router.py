from fastapi import APIRouter, Depends

from app.api.deps import require_menu
from app.api.v1 import (
    account_codes,
    alarms,
    announcements,
    approval_templates,
    approvals,
    assets,
    assignments,
    assistant,
    attendance,
    attendance_admin,
    auth,
    backups,
    bank_accounts,
    bank_transactions,
    billing,
    board,
    bookmarks,
    books,
    cloud_costs,
    company_cars,
    company_insurances,
    vendor_bills,
    customer_contacts,
    customer_interactions,
    customers,
    dashboard,
    evaluations,
    goals,
    developer_emergency_contacts,
    developer_interviews,
    developer_passports,
    developers,
    events,
    exchange,
    feature_permissions,
    holidays,
    hr,
    integrations,
    job_grades,
    job_runs,
    kb_entries,
    customer_status,
    help_articles,
    leave_types,
    loans,
    leaves,
    licenses,
    marketing_campaigns,
    marketing_dashboard,
    marketing_email_templates,
    marketing_google_ads,
    marketing_segments,
    marketing_tracking,
    meeting_notes,
    meetings,
    menu_permissions,
    notifications,
    settings as settings_api,
    opportunities,
    patents,
    payroll,
    pickers,
    product_catalog,
    projects,
    push,
    rnd_budgets,
    budget_calc,
    support_cases,
    support_logs,
    system as system_api,
    tax_invoices,
    tenants,
    trips,
    user_feature_grants,
    user_menu_grants,
    weekly_reports,
    worksites,
)


def _menu(key: str):
    """include_router 의 dependencies 에 끼울 메뉴 권한 가드."""
    return [Depends(require_menu(key))]


api_router = APIRouter()
# --- 인증·공통·시스템 — 메뉴 가드 없음 ---
api_router.include_router(auth.router)
api_router.include_router(exchange.router)
api_router.include_router(notifications.router)
api_router.include_router(dashboard.router)
api_router.include_router(holidays.router)
api_router.include_router(menu_permissions.router)
api_router.include_router(feature_permissions.router)
api_router.include_router(user_feature_grants.router)
api_router.include_router(user_menu_grants.router)
api_router.include_router(help_articles.router)
api_router.include_router(push.router)
api_router.include_router(tenants.router)
api_router.include_router(assistant.router)
api_router.include_router(system_api.router)
api_router.include_router(backups.router)
api_router.include_router(job_runs.router)
api_router.include_router(integrations.router)
api_router.include_router(billing.profile_router)
api_router.include_router(hr.router)
# 본인 데이터/공용 — 메뉴 가드 없음 (본인 row 만 다루거나 모든 임직원에게 노출).
api_router.include_router(bookmarks.router)
api_router.include_router(attendance.router)
# 공용 picker — 회의록/내 액션 등 다이얼로그 cascading combo 용. 모든 role 호출 가능
# (메뉴 권한과 별개. 이름·매핑만 반환하고 민감 정보 비노출).
api_router.include_router(pickers.router)
# Settings 내 sub-page 들 — '설정' 메뉴 자체가 ADMIN 전용. 라우터 가드 불필요.
api_router.include_router(settings_api.router)
api_router.include_router(approval_templates.router)
api_router.include_router(job_grades.ranks_router)
api_router.include_router(job_grades.positions_router)
api_router.include_router(account_codes.router, dependencies=_menu("settings.accounts"))

# --- 도메인 메뉴별 라우터 — Settings > 메뉴 권한 매트릭스로 차단 ---
api_router.include_router(customers.router, dependencies=_menu("customers"))
api_router.include_router(customer_contacts.router, dependencies=_menu("customers"))
api_router.include_router(customer_interactions.router, dependencies=_menu("customers"))
api_router.include_router(licenses.router, dependencies=_menu("licenses"))
# developers 계열은 router-wide 게이트 X.
# 이유: /org-chart (org_chart 메뉴 — 모든 role), /me/* (본인 endpoint),
# /directory, /birthdays 등이 같은 라우터에 있어 매트릭스로 일괄 차단하면
# ETC 신규 로그인 시 /me/initial-password 도 못 부른다.
# 페이지 접근은 프론트 route guard 가, 변경 동작은 endpoint 별 require_feature 가 차단.
api_router.include_router(developers.router)
api_router.include_router(developer_passports.router)
api_router.include_router(developer_emergency_contacts.router)
api_router.include_router(developer_interviews.router)
api_router.include_router(projects.router, dependencies=_menu("projects"))
api_router.include_router(assignments.router, dependencies=_menu("assignments"))
api_router.include_router(opportunities.router, dependencies=_menu("opportunities"))
api_router.include_router(billing.quotes_router, dependencies=_menu("quotes"))
api_router.include_router(billing.invoices_router, dependencies=_menu("invoices"))
api_router.include_router(payroll.router, dependencies=_menu("payroll"))
api_router.include_router(board.router, dependencies=_menu("board"))
api_router.include_router(books.router, dependencies=_menu("books"))
api_router.include_router(trips.router, dependencies=_menu("trips"))
api_router.include_router(meetings.rooms_router, dependencies=_menu("meetings"))
api_router.include_router(meetings.reservations_router, dependencies=_menu("meetings"))
api_router.include_router(meeting_notes.router, dependencies=_menu("meeting_notes"))
api_router.include_router(weekly_reports.router, dependencies=_menu("weekly_reports"))
api_router.include_router(rnd_budgets.router, dependencies=_menu("budget.rnd"))
api_router.include_router(budget_calc.router, dependencies=_menu("budget.calc"))
# leaves.router 는 본인 휴가 신청도 처리 — 메뉴 가드 없이 endpoint 내부 권한 체크에 의존.
api_router.include_router(leaves.router)
api_router.include_router(assets.router, dependencies=_menu("assets"))
api_router.include_router(company_cars.router, dependencies=_menu("cars"))
api_router.include_router(company_insurances.router, dependencies=_menu("insurances"))
api_router.include_router(tax_invoices.router, dependencies=_menu("tax_invoices"))
api_router.include_router(announcements.router, dependencies=_menu("announcements"))
api_router.include_router(cloud_costs.router, dependencies=_menu("cloud_costs"))
api_router.include_router(vendor_bills.router, dependencies=_menu("vendor_bills"))
api_router.include_router(events.router, dependencies=_menu("events"))
api_router.include_router(evaluations.router, dependencies=_menu("evaluations"))
api_router.include_router(product_catalog.router, dependencies=_menu("catalog.products"))
api_router.include_router(support_cases.router, dependencies=_menu("support_cases"))
api_router.include_router(support_logs.router, dependencies=_menu("support_logs"))
api_router.include_router(customer_status.router, dependencies=_menu("customer-status"))
api_router.include_router(kb_entries.router, dependencies=_menu("kb"))
api_router.include_router(alarms.router, dependencies=_menu("alarms"))
api_router.include_router(worksites.router, dependencies=_menu("worksites"))
api_router.include_router(bank_accounts.router, dependencies=_menu("bank_accounts"))
api_router.include_router(bank_transactions.router, dependencies=_menu("bank_accounts"))
api_router.include_router(loans.router, dependencies=_menu("loans"))
api_router.include_router(patents.router, dependencies=_menu("patents"))
api_router.include_router(leave_types.router, dependencies=_menu("leave_types"))
api_router.include_router(attendance_admin.router, dependencies=_menu("attendance.admin"))
api_router.include_router(approvals.router, dependencies=_menu("approvals"))
api_router.include_router(goals.router, dependencies=_menu("goals"))

# --- 마케팅 도메인 ---
# 대시보드·캠페인·이메일 템플릿·세그먼트·Google Ads 모두 한 메뉴키(marketing) 로 묶음.
# 단, 트래킹(픽셀/리다이렉트/수신거부 링크) 은 외부 메일 클라이언트 호출이라
# 인증 없이 노출 — `marketing_tracking.router` 만 _menu 가드 없음.
api_router.include_router(
    marketing_dashboard.router, dependencies=_menu("marketing.dashboard")
)
api_router.include_router(
    marketing_campaigns.router, dependencies=_menu("marketing.campaigns")
)
api_router.include_router(
    marketing_email_templates.router, dependencies=_menu("marketing.emails")
)
api_router.include_router(
    marketing_segments.router, dependencies=_menu("marketing.segments")
)
api_router.include_router(
    marketing_google_ads.router, dependencies=_menu("marketing.google_ads")
)
# 트래킹 — 메뉴 가드 없음 (외부 mail client 가 호출).
api_router.include_router(marketing_tracking.router)
