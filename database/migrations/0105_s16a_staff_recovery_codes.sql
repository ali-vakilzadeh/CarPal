-- Backend S16a (contract 1.4.0, admin console BR-19, owner decision DQ-04): staff recovery codes. Every staff account
-- holds its own set of 10 single-use codes, shown once and stored only as keyed hashes (HMAC-SHA-256). They are used
-- only to ask for an account recovery (S16b), never as a sign-in factor, so they live apart from the consumer MFA
-- recovery codes (identity.authentication_methods, method_type recovery_code). A new set voids the old one.
-- Docs/43.db_setup.sql has the same table, policies and grants. Idempotent, because a fresh install already has the
-- baseline's table and still runs this file once.

CREATE TABLE IF NOT EXISTS identity.staff_recovery_codes (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id    uuid NOT NULL REFERENCES identity.user_accounts (id),
  set_id     uuid NOT NULL,
  code_hash  text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at    timestamptz,
  revoked_at timestamptz,
  CHECK (used_at IS NULL OR revoked_at IS NULL OR used_at <= revoked_at)
);
CREATE INDEX IF NOT EXISTS staff_recovery_codes_open_idx ON identity.staff_recovery_codes (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL;
COMMENT ON TABLE identity.staff_recovery_codes IS
  '52 StaffRecoveryCode — keyed hashes of a staff account''s single-use recovery codes (backend S16a, DQ-04)';

-- Triggers and row-level security as the baseline's generator gives every table (43 §21.1). Only the auth host
-- (system context) and the admin plane (staff context) touch the table; the public API has no grant at all.
DO $s16a$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = 'identity.staff_recovery_codes'::regclass) THEN
    CREATE TRIGGER zz_touch BEFORE UPDATE ON identity.staff_recovery_codes FOR EACH ROW EXECUTE FUNCTION core.tg_touch();
  END IF;
  ALTER TABLE identity.staff_recovery_codes ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'identity.staff_recovery_codes'::regclass) THEN
    CREATE POLICY system_all ON identity.staff_recovery_codes FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_all' AND polrelid = 'identity.staff_recovery_codes'::regclass) THEN
    CREATE POLICY staff_all ON identity.staff_recovery_codes FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
  END IF;
END
$s16a$;

REVOKE ALL ON identity.staff_recovery_codes FROM PUBLIC;
REVOKE ALL ON identity.staff_recovery_codes FROM carpal_api;
GRANT SELECT, INSERT, UPDATE ON identity.staff_recovery_codes TO carpal_admin_api, carpal_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.staff_recovery_codes TO carpal_worker;
