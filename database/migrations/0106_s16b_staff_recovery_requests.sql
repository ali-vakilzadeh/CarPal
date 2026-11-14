-- Backend S16b (contract 1.4.0, admin console BR-19, owner decisions DQ-04 and DQ-15): staff account recovery with two
-- administrator approvals. A staff member who lost their security key opens a request on the auth host (email,
-- password unless forgotten, one recovery code, an emailed code); two other administrators approve it on the admin
-- plane after an out-of-band check; the member then registers a new key. One open request per account; a request
-- expires 24 hours after it was opened; a completed one restricts the account for 72 hours (restricted_until).
-- Docs/43.db_setup.sql has the same tables, policies and grants. Idempotent, because a fresh install already has the
-- baseline's tables and still runs this file once.

CREATE TABLE IF NOT EXISTS identity.staff_recovery_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id            uuid NOT NULL REFERENCES identity.user_accounts (id),
  status             text NOT NULL DEFAULT 'awaiting_email_code' CHECK (status IN
                       ('awaiting_email_code','awaiting_approvals','approved','rejected','expired','completed')),
  password_forgotten boolean NOT NULL,
  handle_hash        text NOT NULL UNIQUE CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  ip_country         text CHECK (ip_country ~ '^[A-Z]{2}$'),
  expires_at         timestamptz NOT NULL,
  email_verified_at  timestamptz,
  approved_at        timestamptz,
  rejected_at        timestamptz,
  expired_at         timestamptz,
  completed_at       timestamptz,
  restricted_until   timestamptz,
  CHECK (expires_at > created_at),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND restricted_until IS NOT NULL))
);
-- One open request per account.
CREATE UNIQUE INDEX IF NOT EXISTS staff_recovery_requests_open_uq ON identity.staff_recovery_requests (user_id)
  WHERE status IN ('awaiting_email_code','awaiting_approvals','approved') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_recovery_requests_status_idx ON identity.staff_recovery_requests (status, id);
CREATE INDEX IF NOT EXISTS staff_recovery_requests_restricted_idx ON identity.staff_recovery_requests (user_id, restricted_until)
  WHERE restricted_until IS NOT NULL;
COMMENT ON TABLE identity.staff_recovery_requests IS
  '52 StaffRecoveryRequest — a staff account recovery after a lost security key (backend S16b, DQ-04)';

CREATE TABLE IF NOT EXISTS identity.staff_recovery_approvals (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  request_id          uuid NOT NULL REFERENCES identity.staff_recovery_requests (id),
  approver_id         uuid NOT NULL REFERENCES identity.user_accounts (id),
  decision            text NOT NULL CHECK (decision IN ('approve','reject')),
  reason              text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  verification_method text CHECK (verification_method IN ('phone_known_number','in_person','video_call','other')),
  note                text CHECK (char_length(note) BETWEEN 1 AND 500),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'approve') = (verification_method IS NOT NULL)),
  CHECK (verification_method IS DISTINCT FROM 'other' OR note IS NOT NULL)
);
-- An administrator approves a request once.
CREATE UNIQUE INDEX IF NOT EXISTS staff_recovery_approvals_once_uq ON identity.staff_recovery_approvals (request_id, approver_id)
  WHERE decision = 'approve' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_recovery_approvals_request_idx ON identity.staff_recovery_approvals (request_id);
COMMENT ON TABLE identity.staff_recovery_approvals IS
  '52 StaffRecoveryApproval — an administrator''s approval or rejection of a staff recovery request (backend S16b)';

-- Triggers and row-level security as the baseline's generator gives every table (43 §21.1). Only the auth host
-- (system context), the admin plane (staff context) and the worker touch the tables; the public API has no grant.
DO $s16b$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity.staff_recovery_requests','identity.staff_recovery_approvals']
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
$s16b$;

REVOKE ALL ON identity.staff_recovery_requests, identity.staff_recovery_approvals FROM PUBLIC;
REVOKE ALL ON identity.staff_recovery_requests, identity.staff_recovery_approvals FROM carpal_api;
GRANT SELECT, INSERT, UPDATE ON identity.staff_recovery_requests, identity.staff_recovery_approvals TO carpal_admin_api, carpal_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.staff_recovery_requests, identity.staff_recovery_approvals TO carpal_worker;
