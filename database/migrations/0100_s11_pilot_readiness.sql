-- Backend S11 (contract 1.2.0): profile and settings fields, quiet hours, exchange rates.
-- Same change as Docs/43.db_setup.sql. Every statement is idempotent, because a fresh install already has the
-- baseline's version of it and still runs this file once.

ALTER TABLE identity.user_accounts
  ADD COLUMN IF NOT EXISTS country core.country,
  ADD COLUMN IF NOT EXISTS avatar_media_id uuid,
  ADD COLUMN IF NOT EXISTS self_deactivated_at timestamptz;

ALTER TABLE identity.user_preferences
  ADD COLUMN IF NOT EXISTS ai_help_me_personalised boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_personalised_matching boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_writing_help boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_show_reasons boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS review_invitation_channel text NOT NULL DEFAULT 'in_app'
    CHECK (review_invitation_channel IN ('in_app','email')),
  ADD COLUMN IF NOT EXISTS quiet_hours_start text CHECK (quiet_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN IF NOT EXISTS quiet_hours_end text CHECK (quiet_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

DO $s11$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_quiet_hours') THEN
    ALTER TABLE identity.user_preferences ADD CONSTRAINT user_preferences_quiet_hours CHECK (
      (quiet_hours_start IS NULL AND quiet_hours_end IS NULL)
      OR (quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL AND quiet_hours_start <> quiet_hours_end));
  END IF;
END
$s11$;

ALTER TABLE notification.notification_deliveries ADD COLUMN IF NOT EXISTS not_before timestamptz;

CREATE TABLE IF NOT EXISTS admin.exchange_rates (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  currency core.currency NOT NULL UNIQUE,
  per_usd  numeric(14,4) NOT NULL CHECK (per_usd > 0),
  reason   text CHECK (char_length(reason) <= 500)
);
COMMENT ON TABLE admin.exchange_rates IS '52 ExchangeRate — amount of a display currency per US dollar, set by a platform admin; display only';

DO $s11$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = 'admin.exchange_rates'::regclass) THEN
    CREATE TRIGGER zz_touch BEFORE UPDATE ON admin.exchange_rates FOR EACH ROW EXECUTE FUNCTION core.tg_touch();
  END IF;
  ALTER TABLE admin.exchange_rates ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'admin.exchange_rates'::regclass) THEN
    CREATE POLICY system_all ON admin.exchange_rates FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_all' AND polrelid = 'admin.exchange_rates'::regclass) THEN
    CREATE POLICY staff_all ON admin.exchange_rates FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'read_all' AND polrelid = 'admin.exchange_rates'::regclass) THEN
    CREATE POLICY read_all ON admin.exchange_rates FOR SELECT USING (true);
  END IF;
END
$s11$;

REVOKE ALL ON admin.exchange_rates FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON admin.exchange_rates TO carpal_api, carpal_admin_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin.exchange_rates TO carpal_worker;

-- PLACEHOLDER rate: a platform admin must set the real USD → IRR rate before go-live (admin.exchange_rate_update).
INSERT INTO admin.exchange_rates (currency, per_usd, reason)
VALUES ('IRR', 1000000.0000, 'Placeholder seed: set the real rate before go-live')
ON CONFLICT (currency) DO NOTHING;
