-- Backend S24 (contract 1.4.0, admin console BR-13; owner decisions DQ-07 in-app only, DQ-20 row 4): support tickets.
-- Users and businesses file tickets in the apps (support.ticket_create) and answer in the ticket's thread; staff work
-- them in the admin console's inbox (Docs/23 A-SUP-01): templated replies, assignment, conversion into a moderation
-- case, privacy request, dispute or plan request (linked_items), and closing with an outcome. One new notification
-- event type (support_update) tells the requester about staff replies and a solved ticket.
-- Docs/43.db_setup.sql has the same tables, constraints, policies and grants. Idempotent, because a fresh install
-- already has the baseline's objects and still runs this file once.

-- ------------------------------------------------------------------ tickets
CREATE TABLE IF NOT EXISTS admin.support_tickets (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  requester_user_id uuid NOT NULL,
  organization_id   uuid,
  topic             text NOT NULL CHECK (topic IN ('account_access','appointment_problem','data','bug','plan_billing','other')),
  subject           text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  app_area          text CHECK (char_length(app_area) BETWEEN 1 AND 60),
  diagnostics       jsonb CHECK (diagnostics IS NULL OR jsonb_typeof(diagnostics) = 'object'),
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new','waiting_on_user','waiting_on_team','solved')),
  outcome           text CHECK (outcome IN ('answered','converted','duplicate','no_response','out_of_scope')),
  assigned_to       uuid,
  clock_started_at  timestamptz DEFAULT now(),
  first_response_at timestamptz,
  last_message_at   timestamptz NOT NULL DEFAULT now(),
  solved_at         timestamptz,
  solved_by         uuid,
  resolution_note   text CHECK (char_length(resolution_note) <= 1000),
  linked_items      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(linked_items) = 'array' AND jsonb_array_length(linked_items) <= 10),
  CHECK ((status = 'solved') = (solved_at IS NOT NULL AND outcome IS NOT NULL)),
  CHECK ((status IN ('new','waiting_on_team')) = (clock_started_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS support_tickets_requester_idx ON admin.support_tickets (requester_user_id, id);
CREATE INDEX IF NOT EXISTS support_tickets_queue_idx ON admin.support_tickets (status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS support_tickets_org_idx ON admin.support_tickets (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON TABLE admin.support_tickets IS '52 SupportTicket — filed in the apps only (DQ-07); the staff inbox is an intake queue (backend S24)';

CREATE TABLE IF NOT EXISTS admin.support_ticket_messages (
  id             uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  ticket_id      uuid NOT NULL REFERENCES admin.support_tickets (id) ON DELETE CASCADE,
  author_kind    text NOT NULL CHECK (author_kind IN ('requester','staff')),
  author_user_id uuid NOT NULL,
  template_key   text CHECK (template_key IN ('acknowledgement','request_information','how_to','status_update',
                   'converted_notice','resolution','other')),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  CHECK ((author_kind = 'staff') = (template_key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS support_ticket_messages_thread_idx ON admin.support_ticket_messages (ticket_id, created_at);
COMMENT ON TABLE admin.support_ticket_messages IS '52 SupportTicketMessage — insert-only for the app roles; erased with the ticket on a deletion request (backend S24)';

-- ------------------------------------------------------------------ audit
-- Staff reads and changes under a ticket purpose name it (SEC-ADM-5, 40 §1.3 ticket:<Id>).
ALTER TABLE analytics.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_access_purpose_check;
ALTER TABLE analytics.audit_logs ADD CONSTRAINT audit_logs_access_purpose_check
  CHECK (access_purpose ~ '^(case|dispute|dsr|verification|approval|ticket):[0-9a-f-]{36}$');

-- ------------------------------------------------------------- notifications
ALTER TABLE notification.notifications DROP CONSTRAINT IF EXISTS notifications_event_type_check;
ALTER TABLE notification.notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN ('appointment_requested',
  'appointment_confirmed','appointment_alternative_proposed','appointment_status_updated','appointment_reminder','appointment_cancelled',
  'review_invitation','review_status_updated','review_response_published','inquiry_answered','service_reminder',
  'ai_triage_ready','ai_suggestion_ready','favorite_provider_update','appointment_request_received','review_received',
  'review_approval_needed','review_response_draft_ready','ai_skill_insight_ready','customer_message','moderation_alert',
  'profile_suggestion','inquiry_received','inventory_import_finished','ai_fitment_suggestion','low_data_quality_alert',
  'driver_issue_reported','fleet_approval_needed','repair_completed','vehicle_due_for_service','monthly_report_ready',
  'moderation_update','system_announcement','marketing','review_awaiting_approval','support_update',
  'four_eyes_outcome','staff_security_alert','ai_kill_switch_changed'));

-- ------------------------------------- triggers, row-level security, grants
-- As the baseline's generator gives every table (43 §21.1, §21.2), plus the requester policies.
DO $s24$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = 'admin.support_tickets'::regclass) THEN
    CREATE TRIGGER zz_touch BEFORE UPDATE ON admin.support_tickets FOR EACH ROW EXECUTE FUNCTION core.tg_touch();
  END IF;
  ALTER TABLE admin.support_tickets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE admin.support_ticket_messages ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'admin.support_tickets'::regclass) THEN
    CREATE POLICY system_all ON admin.support_tickets FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
    CREATE POLICY staff_all ON admin.support_tickets FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
    CREATE POLICY requester_read ON admin.support_tickets FOR SELECT USING (requester_user_id = core.me());
    CREATE POLICY requester_insert ON admin.support_tickets FOR INSERT
      WITH CHECK (requester_user_id = core.me() AND status = 'new' AND outcome IS NULL AND assigned_to IS NULL
                  AND first_response_at IS NULL AND resolution_note IS NULL AND linked_items = '[]'::jsonb
                  AND (organization_id IS NULL OR organization_id = core.my_org()));
    -- A requester's reply only hands the ticket back to the team (or reopens a solved one).
    CREATE POLICY requester_update ON admin.support_tickets FOR UPDATE
      USING (requester_user_id = core.me())
      WITH CHECK (requester_user_id = core.me() AND status IN ('new','waiting_on_team') AND outcome IS NULL AND solved_at IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'admin.support_ticket_messages'::regclass) THEN
    CREATE POLICY system_all ON admin.support_ticket_messages FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
    CREATE POLICY staff_all ON admin.support_ticket_messages FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
    CREATE POLICY requester_read ON admin.support_ticket_messages FOR SELECT
      USING (EXISTS (SELECT 1 FROM admin.support_tickets t WHERE t.id = ticket_id AND t.requester_user_id = core.me()));
    CREATE POLICY requester_insert ON admin.support_ticket_messages FOR INSERT
      WITH CHECK (author_kind = 'requester' AND author_user_id = core.me() AND template_key IS NULL
                  AND EXISTS (SELECT 1 FROM admin.support_tickets t WHERE t.id = ticket_id AND t.requester_user_id = core.me()));
  END IF;
END
$s24$;

REVOKE ALL ON admin.support_tickets, admin.support_ticket_messages FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON admin.support_tickets TO carpal_api, carpal_admin_api;
GRANT SELECT, INSERT ON admin.support_ticket_messages TO carpal_api, carpal_admin_api;
-- Default privileges (43 §21.3) give new tables UPDATE too: messages are insert-only for the apps.
REVOKE UPDATE, DELETE ON admin.support_ticket_messages FROM carpal_api, carpal_admin_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin.support_tickets, admin.support_ticket_messages TO carpal_worker;
