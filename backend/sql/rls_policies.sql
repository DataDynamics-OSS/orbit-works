-- =============================================================================
-- Orbit Works — Row-Level Security (RLS) 정책 일괄 적용
-- =============================================================================
-- backend startup 시 SUPERUSER 권한으로 자동 적용 (Base.metadata.create_all 직후).
-- 멱등 — 반복 실행해도 안전 (DROP IF EXISTS + CREATE 패턴, 테이블 누락 시 SKIP).
--
-- 동작:
--   app.bypass_rls       = 'true'   → 시스템 우회 (login·bootstrap·시드)
--   app.is_super_admin   = 'true'   → tenants/users 만 우회 (SUPER_ADMIN 운영)
--   app.tenant_id        = '<uuid>' → 도메인 테이블 격리
--
-- 신규 tenant_id 테이블 추가 시 아래 tables array 에 이름만 추가하면 다음
-- backend 재시작 시 정책 자동 적용. 일반 정책 (tenant_iso) 외 특수 정책이
-- 필요하면 파일 끝부분에 individual block 으로 추가.
--
-- 참고: backup.db_username/db_password 가 빈 값이면 backend 가 적용 시도 시
-- WARN 후 skip — 적용은 ALTER TABLE 권한이 있는 SUPERUSER 만 가능.


-- ---------------------------------------------------------------------------
-- 0) tenant_id 자동 backfill 트리거 함수
-- ---------------------------------------------------------------------------
-- BEFORE INSERT 시 NEW.tenant_id 가 NULL 이면 app.tenant_id GUC 값으로 채움.
-- defense layer 2 — 애플리케이션이 깜빡해도 RLS WITH CHECK 위반 전에 보정.

CREATE OR REPLACE FUNCTION public.fn_auto_tenant_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  guc text;
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  guc := current_setting('app.tenant_id', true);
  IF guc IS NULL OR guc = '' THEN
    RETURN NEW;  -- 못 채움 → 다음 단계 (NOT NULL 또는 RLS) 가 RAISE
  END IF;
  NEW.tenant_id := guc::uuid;
  RETURN NEW;
END $$;


-- ---------------------------------------------------------------------------
-- 1) 도메인 테이블 — 일괄 RLS + tenant_iso + auto_tenant_id 트리거
-- ---------------------------------------------------------------------------
-- 모든 tenant_id 컬럼 가진 테이블 (users / tenants 는 아래서 특수 처리).

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    -- 알람·결재·목표·평가
    'alarms', 'alarm_sends',
    'announcement_bookmarks',
    'approval_templates', 'approval_requests', 'approval_steps',
    'approval_history', 'approval_attachments',
    'goals', 'goal_due_alerts', 'goal_comments', 'goal_attachments', 'goal_score_baselines',
    'evaluation_cycles', 'competency_dimensions', 'evaluations', 'evaluation_competency_scores',
    -- 프로젝트·인력·고객
    'assignments',
    'attendances',
    'customers', 'license_contacts',
    'customer_contacts',
    'customer_interactions', 'customer_interaction_attachments',
    'developers', 'developer_approvers', 'developer_resumes',
    'developer_profiles', 'developer_certifications', 'developer_experiences',
    'developer_passports', 'developer_emergency_contacts', 'developer_interviews',
    'project_estimate_items',
    'developer_salaries',
    -- 영업기회
    'opportunities', 'opportunity_activities',
    'opportunity_stage_history', 'opportunity_attachments',
    -- 라이센스·견적·청구
    'licenses', 'license_quotes', 'license_quote_items',
    'quotes', 'quote_items', 'quote_versions',
    'invoices', 'invoice_items', 'invoice_versions',
    -- 회의·게시판·이벤트
    'meeting_rooms', 'meeting_reservations', 'meeting_reservation_participants',
    'meeting_notes', 'meeting_note_shares', 'meeting_note_attachments',
    'meeting_note_action_items',
    'board_posts', 'board_attachments', 'board_comments',
    'events', 'event_flights', 'event_lodgings', 'event_participants', 'event_attachments',
    -- 휴가·급여
    'leave_balances', 'leave_accruals', 'leave_reward_grants',
    'leave_requests', 'leave_request_allocations', 'leave_reset_history',
    'leave_types',
    'payroll_runs', 'payroll_items', 'payroll_distributions',
    'developer_tax_profile',
    -- 자산·도서·차량·보험·특허·도메인
    'company_assets',
    'company_cars', 'company_car_attachments',
    'company_insurances', 'company_insurance_attachments',
    'books', 'patents', 'patent_attachments',
    'domains',
    'server_hostings',
    'employee_utilization_cells',
    'loans', 'loan_attachments',
    -- 출장·일정·근무지
    'trips', 'trip_events',
    'worksites', 'worksite_assignments',
    'holidays', 'holiday_alarm_recipients',
    -- 회계·세금·은행
    'bank_accounts', 'bank_transactions',
    'tax_invoices', 'tax_invoice_items', 'tax_invoice_fetches',
    'vendor_bills', 'vendor_bill_attachments',
    'account_codes',
    -- 클라우드 비용·R&D 예산·일반 예산
    'cloud_costs', 'cloud_cost_fetches',
    'cloud_cost_alert_rules', 'cloud_cost_alert_events',
    'rnd_budget_plans', 'rnd_budget_lines', 'rnd_budget_personnel',
    'budget_calc_plans', 'budget_calc_lines',
    -- 마케팅
    'customer_segments',
    'marketing_email_templates', 'marketing_email_template_assets',
    'marketing_campaigns', 'marketing_email_sends', 'marketing_email_unsubscribes',
    'marketing_google_ads_metrics', 'marketing_campaign_touches',
    -- 기술지원·KB
    'support_cases', 'support_case_attachments', 'support_case_comments', 'support_case_counters',
    'support_case_products',
    'support_logs', 'support_log_attachments', 'support_log_comments', 'support_log_products',
    'kb_entries', 'kb_entry_attachments',
    'customer_status_entries', 'customer_status_attachments',
    -- 권한·북마크·기타
    'menu_permissions', 'feature_permissions',
    'user_menu_grants', 'user_feature_grants',
    'bookmarks', 'push_subscriptions',
    -- 어시스턴트·앱 설정·도움말·작업이력
    'app_settings',
    'assistant_conversations', 'assistant_messages',
    'help_articles', 'help_article_revisions',
    'job_runs',
    -- 발주·연구과제·주간보고·제품 카탈로그
    'project_procurements',
    'projects', 'project_quotes', 'project_attachments', 'project_comments',
    'developer_research_grants',
    'weekly_report_assignments', 'weekly_reports', 'weekly_report_attachments',
    'weekly_report_templates', 'weekly_report_comments',
    'vendors', 'products', 'product_versions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- 테이블이 아직 없으면 (Base.metadata.create_all 누락 등) SKIP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=tbl
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_iso ON public.%I', tbl);
    EXECUTE format($p$
      CREATE POLICY tenant_iso ON public.%I
        AS PERMISSIVE FOR ALL
        USING (
          current_setting('app.bypass_rls', true) = 'true'
          OR (current_setting('app.tenant_id', true) <> ''
              AND tenant_id::text = current_setting('app.tenant_id', true))
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'true'
          OR (current_setting('app.tenant_id', true) <> ''
              AND tenant_id::text = current_setting('app.tenant_id', true))
        )
    $p$, tbl);
    -- BEFORE INSERT 트리거 — tenant_id NULL 이면 GUC 로 자동 backfill.
    EXECUTE format('DROP TRIGGER IF EXISTS trg_auto_tenant_id ON public.%I', tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_auto_tenant_id BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_auto_tenant_id()',
      tbl
    );
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 2) users — 특수 정책 (SUPER_ADMIN 우회 + 자기 tenant)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='users') THEN
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.users FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS users_tenant_iso ON public.users;
    CREATE POLICY users_tenant_iso ON public.users
      AS PERMISSIVE FOR ALL
      USING (
        current_setting('app.bypass_rls', true) = 'true'
        OR current_setting('app.is_super_admin', true) = 'true'
        OR (tenant_id IS NOT NULL
            AND current_setting('app.tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.tenant_id', true))
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'true'
        OR current_setting('app.is_super_admin', true) = 'true'
        OR (tenant_id IS NOT NULL
            AND current_setting('app.tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.tenant_id', true))
      );
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 3) tenants — SUPER_ADMIN 만 cross-tenant, 일반 사용자는 자기 tenant 만
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='tenants') THEN
    ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.tenants FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenants_super_admin ON public.tenants;
    DROP POLICY IF EXISTS tenants_self        ON public.tenants;
    DROP POLICY IF EXISTS tenants_self_update ON public.tenants;
    CREATE POLICY tenants_super_admin ON public.tenants
      AS PERMISSIVE FOR ALL
      USING (current_setting('app.bypass_rls', true) = 'true'
             OR current_setting('app.is_super_admin', true) = 'true')
      WITH CHECK (current_setting('app.bypass_rls', true) = 'true'
                  OR current_setting('app.is_super_admin', true) = 'true');
    CREATE POLICY tenants_self ON public.tenants
      AS PERMISSIVE FOR SELECT
      USING (current_setting('app.tenant_id', true) <> ''
             AND id::text = current_setting('app.tenant_id', true));
    CREATE POLICY tenants_self_update ON public.tenants
      AS PERMISSIVE FOR UPDATE
      USING (current_setting('app.tenant_id', true) <> ''
             AND id::text = current_setting('app.tenant_id', true))
      WITH CHECK (current_setting('app.tenant_id', true) <> ''
                  AND id::text = current_setting('app.tenant_id', true));
  END IF;
END $$;
