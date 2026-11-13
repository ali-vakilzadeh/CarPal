-- Backend S14 (contract 1.4.0, admin console BR-07, backend DI-66): the end of a timed suspension on the user account.
-- admin.user_status and the case action suspend_account write it (any staff status change clears it, and so does a
-- DSR deletion); the scheduler rule identity.suspension_expiry lifts a suspension whose end has passed. It only means
-- something while status = 'suspended' (no CHECK, so no other status writer can fail on it). Docs/43.db_setup.sql has
-- the same column and index. Idempotent, because a fresh install already has the baseline's version and still runs
-- this file once.

ALTER TABLE identity.user_accounts ADD COLUMN IF NOT EXISTS suspended_until timestamptz;

CREATE INDEX IF NOT EXISTS user_accounts_suspended_until_idx ON identity.user_accounts (suspended_until)
  WHERE suspended_until IS NOT NULL;
