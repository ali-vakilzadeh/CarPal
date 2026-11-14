-- Backend S17 (contract 1.4.0, admin console BR-11, BR-21, BR-26; owner decision DQ-05): notification templates and
-- rules, staff notices. Staff override the code templates (modules/notification/domain/templates.ts stay the fallback)
-- per template, channel and language; the platform's notification rules (review invitation delay and reminders,
-- default quiet hours, digest schedule) are one row the dispatcher and the invitation sweep read. Three new event
-- types carry the staff notices (four-eyes outcome, staff security, AI kill switch).
-- Docs/43.db_setup.sql has the same tables, policies, grants and seed. Idempotent, because a fresh install already has
-- the baseline's tables and still runs this file once.

ALTER TABLE notification.notifications DROP CONSTRAINT IF EXISTS notifications_event_type_check;
ALTER TABLE notification.notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN ('appointment_requested',
  'appointment_confirmed','appointment_alternative_proposed','appointment_status_updated','appointment_reminder','appointment_cancelled',
  'review_invitation','review_status_updated','review_response_published','inquiry_answered','service_reminder',
  'ai_triage_ready','ai_suggestion_ready','favorite_provider_update','appointment_request_received','review_received',
  'review_approval_needed','review_response_draft_ready','ai_skill_insight_ready','customer_message','moderation_alert',
  'profile_suggestion','inquiry_received','inventory_import_finished','ai_fitment_suggestion','low_data_quality_alert',
  'driver_issue_reported','fleet_approval_needed','repair_completed','vehicle_due_for_service','monthly_report_ready',
  'moderation_update','system_announcement','marketing','review_awaiting_approval',
  'four_eyes_outcome','staff_security_alert','ai_kill_switch_changed'));

CREATE TABLE IF NOT EXISTS notification.notification_template_overrides (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z0-9_.]{1,120}$'),
  channel      core.notification_channel NOT NULL CHECK (channel IN ('email','push','sms')),
  locale       core.locale NOT NULL,
  subject      text CHECK (char_length(subject) BETWEEN 1 AND 200),
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  reason       text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  CHECK ((channel = 'sms') = (subject IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_template_overrides_uq
  ON notification.notification_template_overrides (template_key, channel, locale) WHERE deleted_at IS NULL;
COMMENT ON TABLE notification.notification_template_overrides IS
  '52 NotificationTemplateOverride — staff text of a code template per channel and language (backend S17)';

CREATE TABLE IF NOT EXISTS notification.notification_rules (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  rule_set                        text NOT NULL DEFAULT 'default' UNIQUE CHECK (rule_set = 'default'),
  review_invitation_delay_minutes integer NOT NULL DEFAULT 0 CHECK (review_invitation_delay_minutes BETWEEN 0 AND 2880),
  review_invitation_reminder_days integer[] NOT NULL DEFAULT '{2,5}' CHECK (
    cardinality(review_invitation_reminder_days) <= 3 AND array_position(review_invitation_reminder_days, NULL) IS NULL
    AND 1 <= ALL (review_invitation_reminder_days) AND 6 >= ALL (review_invitation_reminder_days)),
  default_quiet_hours_start       text CHECK (default_quiet_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  default_quiet_hours_end         text CHECK (default_quiet_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  digest_hour                     integer NOT NULL DEFAULT 9 CHECK (digest_hour BETWEEN 0 AND 23),
  weekly_digest_day               integer NOT NULL DEFAULT 6 CHECK (weekly_digest_day BETWEEN 1 AND 7),
  reason                          text CHECK (char_length(reason) BETWEEN 3 AND 500),
  CHECK ((default_quiet_hours_start IS NULL) = (default_quiet_hours_end IS NULL)),
  CHECK (default_quiet_hours_start IS DISTINCT FROM default_quiet_hours_end OR default_quiet_hours_start IS NULL)
);
COMMENT ON TABLE notification.notification_rules IS
  '52 NotificationRules — invitation timing, reminders, default quiet hours and digest schedule (backend S17)';

-- Triggers and row-level security as the baseline's generator gives every table (43 §21.1). Only the admin plane
-- (staff context) and the workers (system context) touch the tables; the public API has no grant.
DO $s17$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification.notification_template_overrides','notification.notification_rules']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = t::regclass) THEN
      EXECUTE format('CREATE TRIGGER zz_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.tg_touch()', t);
    END IF;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = t::regclass) THEN
      EXECUTE format('CREATE POLICY system_all ON %s FOR ALL USING (core.is_system()) WITH CHECK (core.is_system())', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_all' AND polrelid = t::regclass) THEN
      EXECUTE format('CREATE POLICY staff_all ON %s FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff())', t);
    END IF;
  END LOOP;
END
$s17$;

REVOKE ALL ON notification.notification_template_overrides, notification.notification_rules FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON notification.notification_template_overrides, notification.notification_rules TO carpal_admin_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification.notification_template_overrides, notification.notification_rules TO carpal_worker;
REVOKE ALL ON notification.notification_template_overrides, notification.notification_rules FROM carpal_api;

-- The values the code used before S17 (no invitation delay, reminders 2 and 5 days after sending, no platform quiet
-- hours); digests at 09:00 on the recipient's clock, weekly ones on Saturday.
INSERT INTO notification.notification_rules (created_by, rule_set)
VALUES (core.system_actor_id(), 'default')
ON CONFLICT (rule_set) DO NOTHING;
