-- Backend S26b (contract 1.5.0; owner decision DQ-24 of 2026-11-16): the monthly odometer prompt.
--   notification_rules       odometer_prompt_days: days without a reading before the owner is asked (default 30, 0 = off, 14-90).
--   odometer_prompt_state    one row per vehicle: when the owner was last prompted and when they last skipped.
--   notifications            event type odometer_prompt.
-- Docs/43.db_setup.sql has the same columns, table, policy and constraint. Idempotent.

ALTER TABLE notification.notification_rules
  ADD COLUMN IF NOT EXISTS odometer_prompt_days integer NOT NULL DEFAULT 30;
ALTER TABLE notification.notification_rules DROP CONSTRAINT IF EXISTS notification_rules_odometer_prompt_days_check;
ALTER TABLE notification.notification_rules ADD CONSTRAINT notification_rules_odometer_prompt_days_check
  CHECK (odometer_prompt_days = 0 OR odometer_prompt_days BETWEEN 14 AND 90);

CREATE TABLE IF NOT EXISTS vehicle.odometer_prompt_state (
  vehicle_id  uuid PRIMARY KEY REFERENCES vehicle.vehicles (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  prompted_at timestamptz,
  skipped_at  timestamptz
);
COMMENT ON TABLE vehicle.odometer_prompt_state IS 'S26b monthly odometer prompt: last prompt and last skip per vehicle';
ALTER TABLE vehicle.odometer_prompt_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON vehicle.odometer_prompt_state TO carpal_api, carpal_admin_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicle.odometer_prompt_state TO carpal_worker;
DROP POLICY IF EXISTS system_all ON vehicle.odometer_prompt_state;
CREATE POLICY system_all ON vehicle.odometer_prompt_state FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
DROP POLICY IF EXISTS staff_all ON vehicle.odometer_prompt_state;
CREATE POLICY staff_all ON vehicle.odometer_prompt_state FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
DROP POLICY IF EXISTS via_vehicle ON vehicle.odometer_prompt_state;
CREATE POLICY via_vehicle ON vehicle.odometer_prompt_state FOR ALL
  USING (EXISTS (SELECT 1 FROM vehicle.vehicles v WHERE v.id = vehicle_id))
  WITH CHECK (EXISTS (SELECT 1 FROM vehicle.vehicles v WHERE v.id = vehicle_id));

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
  'exchange_rate_reminder','odometer_prompt'));

-- A reading that is the newest by recorded_at answers an open prompt (clears prompted_at).
CREATE OR REPLACE FUNCTION vehicle.tg_mileage_after() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE vehicle.vehicles v SET mileage_km = NEW.mileage_km
   WHERE v.id = NEW.vehicle_id
     AND NOT EXISTS (SELECT 1 FROM vehicle.vehicle_mileage_logs m
                      WHERE m.vehicle_id = NEW.vehicle_id AND m.recorded_at > NEW.recorded_at AND m.deleted_at IS NULL);
  UPDATE vehicle.odometer_prompt_state s SET prompted_at = NULL, updated_at = now()
   WHERE s.vehicle_id = NEW.vehicle_id AND s.prompted_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vehicle.vehicle_mileage_logs m
                      WHERE m.vehicle_id = NEW.vehicle_id AND m.recorded_at > NEW.recorded_at AND m.deleted_at IS NULL);
  RETURN NULL;
END
$$;
