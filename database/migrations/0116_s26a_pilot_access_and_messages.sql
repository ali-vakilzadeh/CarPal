-- Backend S26a (contract 1.5.0; owner decisions of 2026-11-16 after the closure): pilot access and messages.
--   authentication_methods   password_change_required: the password is an initial or one-time staff password that must
--                            be changed at the first console sign-in (auth.password_set_initial);
--                            initial_password_expires_at: after it the initial password is refused (DQ-25: 7 days).
--   notifications            event type exchange_rate_reminder (the morning reminder to administrators).
--   notification_deliveries  partial index for the SMS delivery status sweep (provider status of sent messages).
-- Docs/43.db_setup.sql has the same columns, constraints and index. Idempotent, because a fresh install already has
-- them and still runs this file once.

ALTER TABLE identity.authentication_methods
  ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS initial_password_expires_at timestamptz;

DO $s26a$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authentication_methods_pwd_change_type_check') THEN
    ALTER TABLE identity.authentication_methods ADD CONSTRAINT authentication_methods_pwd_change_type_check
      CHECK (NOT password_change_required OR method_type = 'email_password');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authentication_methods_initial_expiry_check') THEN
    ALTER TABLE identity.authentication_methods ADD CONSTRAINT authentication_methods_initial_expiry_check
      CHECK (initial_password_expires_at IS NULL OR password_change_required);
  END IF;
END
$s26a$;

ALTER TABLE notification.notifications DROP CONSTRAINT IF EXISTS notifications_event_type_check;
ALTER TABLE notification.notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN ('appointment_requested',
  'appointment_confirmed','appointment_alternative_proposed','appointment_status_updated','appointment_reminder','appointment_cancelled',
  'review_invitation','review_status_updated','review_response_published','inquiry_answered','service_reminder',
  'ai_triage_ready','ai_suggestion_ready','favorite_provider_update','appointment_request_received','review_received',
  'review_approval_needed','review_response_draft_ready','ai_skill_insight_ready','customer_message','moderation_alert',
  'profile_suggestion','inquiry_received','inventory_import_finished','ai_fitment_suggestion','low_data_quality_alert',
  'driver_issue_reported','fleet_approval_needed','repair_completed','vehicle_due_for_service','monthly_report_ready',
  'moderation_update','system_announcement','marketing','review_awaiting_approval','support_update',
  'four_eyes_outcome','staff_security_alert','ai_kill_switch_changed',
  'exchange_rate_reminder'));

CREATE INDEX IF NOT EXISTS notification_deliveries_sms_status_idx ON notification.notification_deliveries (sent_at)
  WHERE channel = 'sms' AND status = 'sent' AND provider_message_id IS NOT NULL;
